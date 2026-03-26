/**
 * Tests for batchTrialsToDataset() — converting BatchOutput.runs into IRT TrialDataset.
 */
import { describe, it, expect } from "vitest";
import { batchTrialsToDataset } from "../src/irt-calibrator.js";

describe("batchTrialsToDataset", () => {
  it("should group valid trials into respondents by (runId, sideId)", () => {
    const runs = [
      {
        runId: "run-1",
        taskTrialResults: [
          { task_id: "t1", side_id: "left", normalized_score: 0.75, status: "valid" },
          { task_id: "t1", side_id: "right", normalized_score: 0.50, status: "valid" },
          { task_id: "t2", side_id: "left", normalized_score: 1.0, status: "valid" },
          { task_id: "t2", side_id: "right", normalized_score: 0.25, status: "valid" },
        ]
      },
      {
        runId: "run-2",
        taskTrialResults: [
          { task_id: "t1", side_id: "left", normalized_score: 0.50, status: "valid" },
          { task_id: "t1", side_id: "right", normalized_score: 0.75, status: "valid" },
          { task_id: "t2", side_id: "left", normalized_score: 0.25, status: "valid" },
          { task_id: "t2", side_id: "right", normalized_score: 1.0, status: "valid" },
        ]
      }
    ];

    const { responses, validCount, taskIds } = batchTrialsToDataset(runs);

    // 2 runs × 2 sides = 4 respondents
    expect(responses).toHaveLength(4);
    expect(validCount).toBe(8);
    expect(taskIds.sort()).toEqual(["t1", "t2"]);

    // Check specific respondent
    const r1Left = responses.find(r => r.bundleId === "run-1:left");
    expect(r1Left).toBeDefined();
    expect(r1Left!.scores.get("t1")).toBe(0.75);
    expect(r1Left!.scores.get("t2")).toBe(1.0);
  });

  it("should exclude failed trials and null scores", () => {
    const runs = [
      {
        runId: "run-1",
        taskTrialResults: [
          { task_id: "t1", side_id: "left", normalized_score: 0.75, status: "valid" },
          { task_id: "t1", side_id: "right", normalized_score: null, status: "valid" },
          { task_id: "t2", side_id: "left", normalized_score: 0.50, status: "failed" },
          { task_id: "t2", side_id: "right", normalized_score: 0.25, status: "valid" },
        ]
      }
    ];

    const { responses, validCount, taskIds } = batchTrialsToDataset(runs);

    // Only 2 valid trials with non-null scores
    expect(validCount).toBe(2);
    expect(taskIds.sort()).toEqual(["t1", "t2"]);

    // Left side only has t1 (t2 was failed)
    const left = responses.find(r => r.bundleId === "run-1:left");
    expect(left).toBeDefined();
    expect(left!.scores.size).toBe(1);
    expect(left!.scores.get("t1")).toBe(0.75);
  });

  it("should handle empty runs array", () => {
    const { responses, validCount, taskIds } = batchTrialsToDataset([]);

    expect(responses).toHaveLength(0);
    expect(validCount).toBe(0);
    expect(taskIds).toHaveLength(0);
  });

  it("should handle runs with all-failed trials", () => {
    const runs = [
      {
        runId: "run-1",
        taskTrialResults: [
          { task_id: "t1", side_id: "left", normalized_score: null, status: "failed" },
          { task_id: "t1", side_id: "right", normalized_score: null, status: "failed" },
        ]
      }
    ];

    const { responses, validCount, taskIds } = batchTrialsToDataset(runs);

    expect(validCount).toBe(0);
    expect(taskIds).toHaveLength(0);
    // No respondents created (no valid trials)
    expect(responses).toHaveLength(0);
  });

  it("should produce correct respondent count for large batch", () => {
    // 10 runs × 5 tasks × 2 sides = 100 trials, 20 respondents
    const runs = Array.from({ length: 10 }, (_, i) => ({
      runId: `run-${i}`,
      taskTrialResults: Array.from({ length: 5 }, (_, j) => [
        { task_id: `t${j}`, side_id: "left", normalized_score: 0.5 + j * 0.1, status: "valid" as const },
        { task_id: `t${j}`, side_id: "right", normalized_score: 0.5 - j * 0.1, status: "valid" as const },
      ]).flat()
    }));

    const { responses, validCount, taskIds } = batchTrialsToDataset(runs);

    expect(responses).toHaveLength(20); // 10 runs × 2 sides
    expect(validCount).toBe(100); // 10 × 5 × 2
    expect(taskIds).toHaveLength(5);
  });
});
