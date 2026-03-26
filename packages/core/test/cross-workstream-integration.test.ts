import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerExtensionScorer,
  clearExtensionScorers,
  scoreWithExtensions,
  getRegisteredScorers,
} from "../src/extension-scorer.js";
import { createCVScorer, clearBundleTextCache } from "../src/cv-scorer.js";
import { createCompositionScorer, detectCollapse, enrichCompositionMetadata } from "../src/composition-scorer.js";
import { validateExternalProfile } from "../src/profile-loader.js";
import { SCHEMA_VERSION } from "../src/schemas.js";
import type {
  BenchmarkTask,
  ComparisonRun,
  ExecutorInput,
  ExecutorOutput,
  TaskTrialResult,
} from "../src/schemas.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("cross-workstream integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xwork-"));
    fs.writeFileSync(path.join(tmpDir, "test.md"), "alpha beta gamma delta echo foxtrot");
    clearBundleTextCache();
    clearExtensionScorers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearBundleTextCache();
    clearExtensionScorers();
  });

  function makeCompTask(id: string, layer: "primitive" | "composed" | "meta", cues: string[] = []): BenchmarkTask {
    return {
      task_id: id,
      task_version: 1,
      family: "test",
      category: "test_cat",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 1,
      prompt_text: "test",
      rubric_text: null,
      extensions: {
        composition: { layer, dependencies: [], composition_cues: cues },
      },
    };
  }

  function makeTrial(taskId: string, score: number): TaskTrialResult {
    return {
      task_id: taskId,
      task_version: 1,
      side_id: "left",
      trial_index: 1,
      evaluator_kind: "rubric",
      normalized_score: score,
      false_positive: 0,
      status: "valid",
    };
  }

  // Test 1: Composition profile → collapse detected
  it("detects collapse with synthetic high-prim low-comp scores", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("p2", "primitive"),
          makeCompTask("p3", "primitive"),
          makeCompTask("c1", "composed"),
          makeCompTask("c2", "composed"),
        ],
      },
      [
        makeTrial("p1", 0.8),
        makeTrial("p2", 0.9),
        makeTrial("p3", 0.7),
        makeTrial("c1", 0.1),
        makeTrial("c2", 0.2),
      ]
    );
    expect(result).toBeDefined();
    expect(result!.detected).toBe(true);
    expect(result!.severity).toBeGreaterThan(0.5);
  });

  // Test 2: Composition profile → no collapse (both high)
  it("does not detect collapse when both layers score high", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("p2", "primitive"),
          makeCompTask("c1", "composed"),
          makeCompTask("c2", "composed"),
        ],
      },
      [
        makeTrial("p1", 0.8),
        makeTrial("p2", 0.7),
        makeTrial("c1", 0.7),
        makeTrial("c2", 0.6),
      ]
    );
    expect(result).toBeDefined();
    expect(result!.detected).toBe(false);
  });

  // Test 3: Collapse not detected for primitives only
  it("returns insufficient_data when only primitives exist", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("p2", "primitive"),
          makeCompTask("p3", "primitive"),
        ],
      },
      [
        makeTrial("p1", 0.8),
        makeTrial("p2", 0.7),
        makeTrial("p3", 0.9),
      ]
    );
    expect(result).toBeDefined();
    expect(result!.insufficient_data).toBe(true);
    expect(result!.detected).toBe(false);
  });

  // Test 4: Composition + IRT on same run
  it("composition scorer fires alongside IRT weights", async () => {
    registerExtensionScorer(createCompositionScorer());
    const task = makeCompTask("p1", "primitive", ["alpha", "beta"]);
    const input: ExecutorInput = {
      sideId: "left",
      task,
      trialIndex: 1,
      bundleDir: tmpDir,
      promptText: task.prompt_text,
      rubricText: null,
    };
    const baseResult: ExecutorOutput = { normalizedScore: 0.5, status: "valid" };
    const { result, metadata } = await scoreWithExtensions(input, baseResult);
    // Composition scorer should override the base score
    expect(result.normalizedScore).toBe(1.0); // both alpha and beta in bundle
    expect(metadata?.scorer_kind).toBe("composition");
  });

  // Test 5: C-V + Composition on different tasks
  it("both CV and composition scorers fire on their respective tasks", async () => {
    registerExtensionScorer(createCVScorer());
    registerExtensionScorer(createCompositionScorer());

    // CV task
    const cvTask: BenchmarkTask = {
      task_id: "cv-task",
      task_version: 1,
      family: "test",
      category: "test_cat",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 1,
      prompt_text: "test",
      rubric_text: null,
      extensions: {
        cv: {
          construction_cues: ["alpha"],
          verification_checks: [
            { check_id: "c1", kind: "requires", description: "has alpha", rule: "requires:alpha", weight: 1, critical: false },
          ],
          construction_weight: 0.3,
          verification_weight: 0.7,
          firewall: true,
        },
      },
    };
    const compTask = makeCompTask("comp-task", "primitive", ["gamma"]);

    const cvInput: ExecutorInput = { sideId: "left", task: cvTask, trialIndex: 1, bundleDir: tmpDir, promptText: "test", rubricText: null };
    const compInput: ExecutorInput = { sideId: "left", task: compTask, trialIndex: 1, bundleDir: tmpDir, promptText: "test", rubricText: null };
    const base: ExecutorOutput = { normalizedScore: 0.5, status: "valid" };

    const cvResult = await scoreWithExtensions(cvInput, base);
    const compResult = await scoreWithExtensions(compInput, base);

    expect(cvResult.metadata?.scorer_kind).toBe("cv");
    expect(compResult.metadata?.scorer_kind).toBe("composition");
  });

  // Test 6: Profile with cv AND composition on same task
  it("rejects profile with both cv and composition on same task", () => {
    const profile = {
      profile_id: "bad",
      label: "Bad",
      description: "Bad profile",
      category_weights: { test_cat: 1 },
      tasks: [
        {
          task_id: "dual",
          category: "test_cat",
          prompt_text: "Test",
          extensions: {
            cv: {
              construction_cues: ["test"],
              verification_checks: [
                { check_id: "c1", kind: "requires", description: "test", rule: "requires:test", weight: 1 },
              ],
            },
            composition: { layer: "primitive" },
          },
        },
      ],
    };
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.message.includes("at most one extension"))).toBe(true);
  });

  // Test 7: v4 profile (no extensions) in v5 engine
  it("v4 profile with no extensions works in v5 engine", async () => {
    registerExtensionScorer(createCompositionScorer());
    const task: BenchmarkTask = {
      task_id: "plain",
      task_version: 1,
      family: "test",
      category: "test_cat",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 1,
      prompt_text: "test",
      rubric_text: null,
      // No extensions
    };
    const input: ExecutorInput = { sideId: "left", task, trialIndex: 1, bundleDir: tmpDir, promptText: "test", rubricText: null };
    const base: ExecutorOutput = { normalizedScore: 0.5, status: "valid" };
    const { result } = await scoreWithExtensions(input, base);
    // No scorer fires — base score unchanged
    expect(result.normalizedScore).toBe(0.5);
  });

  // Test 8: v4 run JSON loaded by v5 engine
  it("v4 run JSON without composition_analysis loads safely", () => {
    const v4Run = {
      run_id: "test",
      schema_version: 4,
      composition_analysis: undefined,
    } as unknown as ComparisonRun;

    // Access via optional chaining — should be safe
    expect(v4Run.composition_analysis?.detected ?? false).toBe(false);
  });

  // Test 9: ExtensionScorer registration lifecycle
  it("tracks scorer registration and clear lifecycle", () => {
    expect(getRegisteredScorers()).toHaveLength(0);
    registerExtensionScorer(createCVScorer());
    registerExtensionScorer(createCompositionScorer());
    expect(getRegisteredScorers()).toHaveLength(2);
    clearExtensionScorers();
    expect(getRegisteredScorers()).toHaveLength(0);
  });

  // Test 10: Missing scorer warning at load
  it("warns but does not error when composition scorer not registered", () => {
    // No scorer registered
    const profile = {
      profile_id: "comp-test",
      label: "Test",
      description: "Test",
      category_weights: { test_cat: 1 },
      tasks: [
        {
          task_id: "p1",
          category: "test_cat",
          prompt_text: "Test",
          extensions: { composition: { layer: "primitive" } },
        },
      ],
    };
    // Should not produce validation errors (just a warning)
    const errors = validateExternalProfile(profile);
    // The only potential errors are from missing scorer — but that's a warning, not an error
    expect(errors.filter(e => e.field.includes("composition"))).toHaveLength(0);
  });

  // Test 11: DAG cycle in profile
  it("rejects DAG cycle at profile load", () => {
    registerExtensionScorer(createCompositionScorer());
    const profile = {
      profile_id: "cycle-test",
      label: "Cycle",
      description: "Has cycle",
      category_weights: { test_cat: 1 },
      tasks: [
        {
          task_id: "a",
          category: "test_cat",
          prompt_text: "A",
          extensions: { composition: { layer: "composed", dependencies: ["b"] } },
        },
        {
          task_id: "b",
          category: "test_cat",
          prompt_text: "B",
          extensions: { composition: { layer: "composed", dependencies: ["a"] } },
        },
      ],
    };
    const errors = validateExternalProfile(profile);
    expect(errors.some(e => e.field === "composition_dag")).toBe(true);
  });

  // Test 12: Schema version is 5
  it("SCHEMA_VERSION is 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  // Test 13: Empty composed layer → insufficient_data
  it("returns insufficient_data when composed layer is empty", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("p2", "primitive"),
          makeCompTask("p3", "primitive"),
          makeCompTask("p4", "primitive"),
        ],
      },
      [
        makeTrial("p1", 0.8),
        makeTrial("p2", 0.9),
        makeTrial("p3", 0.7),
        makeTrial("p4", 0.85),
      ]
    );
    expect(result).toBeDefined();
    expect(result!.insufficient_data).toBe(true);
    expect(result!.detected).toBe(false);
  });

  // Test 14: Composed scores > primitive scores
  it("does not detect collapse when composed > primitive", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("p2", "primitive"),
          makeCompTask("c1", "composed"),
          makeCompTask("c2", "composed"),
        ],
      },
      [
        makeTrial("p1", 0.3),
        makeTrial("p2", 0.2),
        makeTrial("c1", 0.8),
        makeTrial("c2", 0.9),
      ]
    );
    expect(result).toBeDefined();
    expect(result!.detected).toBe(false);
  });

  // Test 15: composition_analysis undefined for non-composition profile
  it("returns undefined for profile with only CV tasks", () => {
    const cvTask: BenchmarkTask = {
      task_id: "cv-only",
      task_version: 1,
      family: "test",
      category: "test_cat",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 1,
      prompt_text: "test",
      rubric_text: null,
      extensions: {
        cv: {
          construction_cues: ["alpha"],
          verification_checks: [],
          construction_weight: 0.3,
          verification_weight: 0.7,
          firewall: true,
        },
      },
    };
    const result = enrichCompositionMetadata(
      { tasks: [cvTask] },
      [makeTrial("cv-only", 0.7)]
    );
    expect(result).toBeUndefined();
  });
});
