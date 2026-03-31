import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCompositionScorer, enrichCompositionMetadata } from "../src/composition-scorer.js";
import { clearBundleTextCache } from "../src/cv-scorer.js";
import { registerExtensionScorer, clearExtensionScorers } from "../src/extension-scorer.js";
import type { BenchmarkTask, ExecutorInput, ExecutorOutput } from "../src/schemas.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// detectCollapse tests are in collapse-boundary.test.ts (16 oracle + edge cases)

// ---------------------------------------------------------------------------
// Composition scorer tests (5)
// ---------------------------------------------------------------------------

describe("createCompositionScorer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-scorer-"));
    clearBundleTextCache();
    clearExtensionScorers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearBundleTextCache();
    clearExtensionScorers();
  });

  function makeTask(cues: string[], layer: "primitive" | "composed" | "meta" = "primitive"): BenchmarkTask {
    return {
      task_id: "comp-test",
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
        composition: {
          layer,
          dependencies: [],
          composition_cues: cues,
        },
      },
    };
  }

  function makeInput(task: BenchmarkTask): ExecutorInput {
    return {
      sideId: "left",
      task,
      trialIndex: 1,
      bundleDir: tmpDir,
      promptText: task.prompt_text,
      rubricText: null,
    };
  }

  // Test 1: All cues present (primitive)
  it("scores 1.0 when all cues present", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.md"), "alpha beta gamma");
    const scorer = createCompositionScorer();
    const task = makeTask(["alpha", "beta", "gamma"]);
    const result = await scorer.score(makeInput(task), { normalizedScore: 0.5, status: "valid" });
    expect(result.normalizedScore).toBe(1.0);
    expect(result.metadata.layer).toBe("primitive");
    expect(result.metadata.scorer_kind).toBe("composition");
  });

  // Test 2: No cues present
  it("scores 0.0 when no cues present", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.md"), "unrelated content here");
    const scorer = createCompositionScorer();
    const task = makeTask(["alpha", "beta", "gamma"]);
    const result = await scorer.score(makeInput(task), { normalizedScore: 0.5, status: "valid" });
    expect(result.normalizedScore).toBe(0);
  });

  // Test 3: Empty composition_cues → base score
  it("uses base score when composition_cues is empty", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.md"), "anything");
    const scorer = createCompositionScorer();
    const task = makeTask([]);
    const result = await scorer.score(makeInput(task), { normalizedScore: 0.6, status: "valid" });
    expect(result.normalizedScore).toBe(0.6);
  });

  // Test 4: Partial cues
  it("scores proportionally for partial cues", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.md"), "alpha gamma echo");
    const scorer = createCompositionScorer();
    const task = makeTask(["alpha", "beta", "gamma", "delta", "echo"]);
    const result = await scorer.score(makeInput(task), { normalizedScore: 0.5, status: "valid" });
    expect(result.normalizedScore).toBeCloseTo(0.6, 2); // 3/5
  });

  // Test 5: Composed scores > primitive scores (no crash)
  it("scores composed tasks independently (no crash when scores differ)", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.md"), "alpha beta gamma");
    const scorer = createCompositionScorer();
    const composedTask = makeTask(["alpha", "beta", "gamma"], "composed");
    composedTask.extensions!.composition!.dependencies = ["some-prim"];
    const result = await scorer.score(makeInput(composedTask), { normalizedScore: 0.3, status: "valid" });
    expect(result.normalizedScore).toBe(1.0);
    expect(result.metadata.layer).toBe("composed");
  });
});

// ---------------------------------------------------------------------------
// enrichCompositionMetadata tests (3)
// ---------------------------------------------------------------------------

describe("enrichCompositionMetadata", () => {
  function makeCompTask(id: string, layer: "primitive" | "composed" | "meta"): BenchmarkTask {
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
        composition: { layer, dependencies: [], composition_cues: [] },
      },
    };
  }

  it("returns undefined for non-composition profile", () => {
    const result = enrichCompositionMetadata(
      { tasks: [{ ...makeCompTask("x", "primitive"), extensions: undefined }] },
      []
    );
    expect(result).toBeUndefined();
  });

  it("returns insufficient_data when fewer than 2 per layer", () => {
    const result = enrichCompositionMetadata(
      {
        tasks: [
          makeCompTask("p1", "primitive"),
          makeCompTask("c1", "composed"),
        ],
      },
      [
        { task_id: "p1", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.8, false_positive: 0, status: "valid" },
        { task_id: "c1", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.2, false_positive: 0, status: "valid" },
      ]
    );
    expect(result).toBeDefined();
    expect(result!.insufficient_data).toBe(true);
    expect(result!.detected).toBe(false);
  });

  it("detects collapse with sufficient data", () => {
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
        { task_id: "p1", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.8, false_positive: 0, status: "valid" },
        { task_id: "p2", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.9, false_positive: 0, status: "valid" },
        { task_id: "c1", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.1, false_positive: 0, status: "valid" },
        { task_id: "c2", task_version: 1, side_id: "left", trial_index: 1, evaluator_kind: "rubric", normalized_score: 0.2, false_positive: 0, status: "valid" },
      ]
    );
    expect(result).toBeDefined();
    expect(result!.detected).toBe(true);
    expect(result!.severity).toBeGreaterThan(0.5);
    expect(result!.insufficient_data).toBeUndefined();
  });
});
