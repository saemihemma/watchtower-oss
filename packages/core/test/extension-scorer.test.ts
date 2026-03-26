import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExtensionScorer,
  clearExtensionScorers,
  scoreWithExtensions,
  type ExtensionScorer,
  type ExtensionScoredResult
} from "../src/extension-scorer.js";
import type { BenchmarkTask, ExecutorInput, ExecutorOutput } from "../src/schemas.js";

const mockScorer: ExtensionScorer = {
  kind: "test",
  applicable: (task) => task.task_id === "test_task",
  score: async (_input, _base) => ({
    normalizedScore: 0.9,
    metadata: { custom: "value" },
    warnings: []
  })
};

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
  rubric_text: null
});

const createMockInput = (taskId: string = "test_task"): ExecutorInput => ({
  sideId: "left",
  task: createMockTask(taskId),
  trialIndex: 0,
  bundleDir: "/test",
  promptText: "test prompt",
  rubricText: null
});

const createMockOutput = (): ExecutorOutput => ({
  normalizedScore: 0.5,
  status: "valid"
});

describe("Extension Scorer", () => {
  beforeEach(() => {
    clearExtensionScorers();
  });

  it("should register scorer → applicable task → returns extension score with metadata", async () => {
    registerExtensionScorer(mockScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput();

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result.normalizedScore).toBe(0.9);
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.scorer_kind).toBe("test");
    expect(result.metadata?.custom).toBe("value");
  });

  it("should return base result unchanged when no applicable scorer", async () => {
    registerExtensionScorer(mockScorer);

    const input = createMockInput("other_task");
    const baseResult = createMockOutput();

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result).toEqual(baseResult);
    expect(result.metadata).toBeUndefined();
  });

  it("should return base score with error metadata when scorer throws", async () => {
    const errorScorer: ExtensionScorer = {
      kind: "error_test",
      applicable: (task) => task.task_id === "test_task",
      score: async () => {
        throw new Error("scorer failed");
      }
    };

    registerExtensionScorer(errorScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput();

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result).toEqual(baseResult);
    expect(result.metadata?.scorer_kind).toBe("error_test");
    expect(result.metadata?.extension_error).toBe("scorer failed");
  });

  it("should reset registry to empty when clearExtensionScorers is called", async () => {
    registerExtensionScorer(mockScorer);

    clearExtensionScorers();

    const input = createMockInput("test_task");
    const baseResult = createMockOutput();

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result).toEqual(baseResult);
    expect(result.metadata).toBeUndefined();
  });

  it("should still work when duplicate kind is registered", async () => {
    registerExtensionScorer(mockScorer);
    registerExtensionScorer(mockScorer);

    const input = createMockInput("test_task");
    const baseResult = createMockOutput();

    const result = await scoreWithExtensions(input, baseResult);

    expect(result.result.normalizedScore).toBe(0.9);
    expect(result.metadata?.scorer_kind).toBe("test");
    expect(result.metadata?.custom).toBe("value");
  });
});
