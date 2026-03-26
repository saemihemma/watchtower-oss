import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectCollapse, createCompositionScorer, enrichCompositionMetadata } from "../src/composition-scorer.js";
import { clearBundleTextCache } from "../src/cv-scorer.js";
import { registerExtensionScorer, clearExtensionScorers } from "../src/extension-scorer.js";
import type { BenchmarkTask, ExecutorInput, ExecutorOutput } from "../src/schemas.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Collapse detection tests (8)
// ---------------------------------------------------------------------------

describe("detectCollapse", () => {
  // Test 1: Clear collapse
  it("detects clear collapse (high prim, low comp)", () => {
    const result = detectCollapse([0.8, 0.7], [0.2, 0.1]);
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.789, 2);
    expect(result.mean_primitive).toBeCloseTo(0.75, 2);
    expect(result.mean_composed).toBeCloseTo(0.15, 2);
  });

  // Test 2: No collapse (both high)
  it("returns no collapse when both layers high", () => {
    const result = detectCollapse([0.8, 0.7], [0.7, 0.6]);
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
  });

  // Test 3: No collapse (both low)
  it("returns no collapse when both layers low", () => {
    const result = detectCollapse([0.3, 0.2], [0.1, 0.1]);
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
  });

  // Test 4: Boundary (prim=0.6 exactly → NOT > 0.6)
  it("does not detect collapse at exact floor boundary", () => {
    const result = detectCollapse([0.6], [0.2]);
    expect(result.detected).toBe(false);
  });

  // Test 5: Boundary (comp=0.3 exactly → NOT < 0.3)
  it("does not detect collapse at exact ceiling boundary", () => {
    const result = detectCollapse([0.8], [0.3]);
    expect(result.detected).toBe(false);
  });

  // Test 6: Custom thresholds
  it("uses custom thresholds", () => {
    const result = detectCollapse([0.55], [0.35], {
      primitive_floor: 0.5,
      composed_ceiling: 0.4,
    });
    expect(result.detected).toBe(true);
  });

  // Test 7: Near-threshold
  it("detects collapse at near-threshold values", () => {
    const result = detectCollapse([0.61], [0.29]);
    expect(result.detected).toBe(true);
    // severity = (0.61 - 0.29) / (0.61 + 0.01) = 0.32 / 0.62 ≈ 0.516
    expect(result.severity).toBeCloseTo(0.516, 2);
  });

  // Test 8: Severity at zero prim (guard)
  it("returns severity 0 when primitives very low", () => {
    // Even if detected would be true with very low thresholds, severity guarded
    const result = detectCollapse([0.05], [0.01], {
      primitive_floor: 0.04,
      composed_ceiling: 0.02,
    });
    // 0.05 > 0.04 AND 0.01 < 0.02 → detected=true, but meanPrim < 0.1 → severity=0
    expect(result.detected).toBe(true);
    expect(result.severity).toBe(0);
  });
});

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
