import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExtensionScorer,
  clearExtensionScorers,
  scoreWithExtensions,
  type ExtensionScorer,
  type ExtensionScoredResult,
} from "../src/extension-scorer.js";
import type { BenchmarkTask, ExecutorInput, ExecutorOutput } from "../src/schemas.js";

/**
 * Helper functions to create mock objects
 * (matching the pattern from extension-scorer.test.ts)
 */

const createMockTask = (taskId: string = "test_task"): BenchmarkTask => ({
  task_id: taskId,
  task_version: 1,
  family: "test_family",
  category: "general",
  critical_regression: false,
  evaluator_kind: "auto",
  priority: 1,
  min_valid_trials: 1,
  trials_per_side: 5,
  prompt_text: "test prompt",
  rubric_text: null,
});

const createMockInput = (taskId: string = "test_task"): ExecutorInput => ({
  sideId: "left",
  task: createMockTask(taskId),
  trialIndex: 0,
  bundleDir: "/test",
  promptText: "test prompt",
  rubricText: null,
});

const createMockOutput = (
  normalizedScore: number = 0.5
): ExecutorOutput => ({
  normalizedScore,
  status: "valid",
});

describe("Extension Scorer Resilience", () => {
  beforeEach(() => {
    clearExtensionScorers();
  });

  /**
   * Test 1: Scorer throws an error
   *
   * Register a scorer whose score() throws. Call scoreWithExtensions().
   * Verify: returns base score unchanged, metadata contains extension_error.
   */
  it("handles scorer throwing error gracefully", async () => {
    const throwingScorer: ExtensionScorer = {
      kind: "throwing_scorer",
      applicable: (task) => task.task_id === "test_task",
      score: async () => {
        throw new Error("Scorer internal error");
      },
    };

    registerExtensionScorer(throwingScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.7);

    const result = await scoreWithExtensions(input, baseResult);

    // Base score should be unchanged
    expect(result.result.normalizedScore).toBe(0.7);
    expect(result.result.status).toBe("valid");

    // Metadata should contain error info
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.scorer_kind).toBe("throwing_scorer");
    expect(result.metadata?.extension_error).toBe("Scorer internal error");
  });

  /**
   * Test 2: Scorer returns score > 1.0
   *
   * Register a scorer returning normalizedScore 1.5.
   * Check what happens (code doesn't clamp — document this).
   */
  it("does not clamp scores above 1.0", async () => {
    const unclampdScorer: ExtensionScorer = {
      kind: "overscorer",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 1.5,
        metadata: { note: "unclamped high score" },
        warnings: [],
      }),
    };

    registerExtensionScorer(unclampdScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    // Score should be set to the returned value without clamping
    expect(result.result.normalizedScore).toBe(1.5);
    expect(result.metadata?.scorer_kind).toBe("overscorer");
    expect(result.metadata?.note).toBe("unclamped high score");
  });

  /**
   * Test 3: Scorer returns score < 0.0
   *
   * Register a scorer returning normalizedScore -0.5.
   * Check what happens (code doesn't clamp).
   */
  it("does not clamp scores below 0.0", async () => {
    const negativeScorer: ExtensionScorer = {
      kind: "negative_scorer",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: -0.5,
        metadata: { note: "unclamped negative score" },
        warnings: [],
      }),
    };

    registerExtensionScorer(negativeScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    // Score should be set to the returned value without clamping
    expect(result.result.normalizedScore).toBe(-0.5);
    expect(result.metadata?.scorer_kind).toBe("negative_scorer");
    expect(result.metadata?.note).toBe("unclamped negative score");
  });

  /**
   * Test 4: No applicable scorer
   *
   * Call scoreWithExtensions with no registered scorers.
   * Returns base result unchanged, no metadata.
   */
  it("returns base result unchanged when no scorers registered", async () => {
    const input = createMockInput("any_task");
    const baseResult = createMockOutput(0.6);

    const result = await scoreWithExtensions(input, baseResult);

    // No scorer registered, so no applicable scorer
    expect(result.result).toEqual(baseResult);
    expect(result.metadata).toBeUndefined();
  });

  /**
   * Test 5: Task has no extensions, scorer is registered
   *
   * Register a scorer whose applicable() returns false (e.g., checks for extensions).
   * Returns base result unchanged.
   */
  it("returns base result when scorer is not applicable to task", async () => {
    const selectiveScorer: ExtensionScorer = {
      kind: "selective_scorer",
      applicable: (task) => task.task_id === "special_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0.95,
        metadata: { applied: true },
        warnings: [],
      }),
    };

    registerExtensionScorer(selectiveScorer);

    // Using a regular task that doesn't match the scorer's criteria
    const input = createMockInput("regular_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    // Scorer not applicable, so base result returned
    expect(result.result).toEqual(baseResult);
    expect(result.metadata).toBeUndefined();
  });

  /**
   * Additional resilience tests
   */

  /**
   * Test 6: Scorer throws non-Error object
   *
   * In JavaScript, you can throw anything. Verify error handling for non-Error throws.
   */
  it("handles non-Error thrown values gracefully", async () => {
    const weirdThrowScorer: ExtensionScorer = {
      kind: "weird_thrower",
      applicable: (task) => task.task_id === "test_task",
      score: async () => {
        throw "string error"; // eslint-disable-line no-throw-literal
      },
    };

    registerExtensionScorer(weirdThrowScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    // Should catch and report "unknown" for non-Error
    expect(result.result).toEqual(baseResult);
    expect(result.metadata?.scorer_kind).toBe("weird_thrower");
    expect(result.metadata?.extension_error).toBe("unknown");
  });

  /**
   * Test 7: Scorer returns null/undefined score
   *
   * The scorer returns a result but with a falsy normalizedScore.
   */
  it("accepts zero and falsy normalizedScore values", async () => {
    const zeroScorer: ExtensionScorer = {
      kind: "zero_scorer",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0,
        metadata: { note: "zero score is valid" },
        warnings: [],
      }),
    };

    registerExtensionScorer(zeroScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.8);

    const result = await scoreWithExtensions(input, baseResult);

    // Zero score should be applied
    expect(result.result.normalizedScore).toBe(0);
    expect(result.metadata?.note).toBe("zero score is valid");
  });

  /**
   * Test 8: Multiple scorers but only one applicable
   *
   * Register multiple scorers, only one applicable to the given task.
   * Verify that only the applicable scorer runs.
   */
  it("runs only first applicable scorer when multiple registered", async () => {
    const scorer1: ExtensionScorer = {
      kind: "scorer1",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0.9,
        metadata: { from: "scorer1" },
        warnings: [],
      }),
    };

    const scorer2: ExtensionScorer = {
      kind: "scorer2",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0.8,
        metadata: { from: "scorer2" },
        warnings: [],
      }),
    };

    registerExtensionScorer(scorer1);
    registerExtensionScorer(scorer2);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    // First applicable scorer (scorer1) should be used
    expect(result.result.normalizedScore).toBe(0.9);
    expect(result.metadata?.scorer_kind).toBe("scorer1");
    expect(result.metadata?.from).toBe("scorer1");
  });

  /**
   * Test 9: Scorer returns empty metadata
   *
   * Ensure the scorer can return empty metadata without issues.
   */
  it("handles scorer with empty metadata", async () => {
    const emptyMetaScorer: ExtensionScorer = {
      kind: "empty_meta_scorer",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0.75,
        metadata: {},
        warnings: [],
      }),
    };

    registerExtensionScorer(emptyMetaScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result.normalizedScore).toBe(0.75);
    expect(result.metadata?.scorer_kind).toBe("empty_meta_scorer");
  });

  /**
   * Test 10: Scorer returns with warnings
   *
   * Verify that metadata from the scorer is preserved (including warnings if stored there).
   */
  it("preserves custom metadata from scorer", async () => {
    const warningScorer: ExtensionScorer = {
      kind: "warning_scorer",
      applicable: (task) => task.task_id === "test_task",
      score: async (): Promise<ExtensionScoredResult> => ({
        normalizedScore: 0.65,
        metadata: {
          warnings_count: 2,
          custom_field: "preserved",
        },
        warnings: ["warn1", "warn2"],
      }),
    };

    registerExtensionScorer(warningScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput(0.5);

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result.normalizedScore).toBe(0.65);
    expect(result.metadata?.scorer_kind).toBe("warning_scorer");
    expect(result.metadata?.warnings_count).toBe(2);
    expect(result.metadata?.custom_field).toBe("preserved");
  });
});
