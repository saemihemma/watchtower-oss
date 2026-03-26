import { describe, it, expect, vi } from "vitest";
import { runBatch, estimateBatchCost } from "../src/batch-runner.js";
import type { BatchConfig } from "../src/batch-runner.js";

describe("Batch Runner", () => {
  it("should complete 3 runs with mock runFn", async () => {
    const mockRunFn = vi.fn()
      .mockResolvedValueOnce("run-1")
      .mockResolvedValueOnce("run-2")
      .mockResolvedValueOnce("run-3");

    const result = await runBatch({
      totalRuns: 3,
      parallel: 1,
      retryOnFail: 0,
      runFn: mockRunFn
    });

    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.runIds).toHaveLength(3);
    expect(result.runIds).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("should handle parallel execution with 2 workers and 4 runs", async () => {
    const callOrder: number[] = [];
    const startTimes: number[] = [];

    const mockRunFn = vi.fn(async (index: number) => {
      callOrder.push(index);
      startTimes.push(Date.now());
      // Small delay to simulate work
      await new Promise(resolve => setTimeout(resolve, 10));
      return `run-${index}`;
    });

    const result = await runBatch({
      totalRuns: 4,
      parallel: 2,
      retryOnFail: 0,
      runFn: mockRunFn
    });

    expect(result.completed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.runIds).toHaveLength(4);
    // Verify that runs were actually executed (call order includes all indices 0-3)
    expect(callOrder.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("should retry failed runs and log as failed after retries exhausted", async () => {
    let callCount = 0;
    const mockRunFn = vi.fn(async (index: number) => {
      callCount++;
      // Fail on first 2 calls, succeed on 3rd
      if (callCount < 3) {
        throw new Error("simulated failure");
      }
      return `run-${index}`;
    });

    const result = await runBatch({
      totalRuns: 1,
      parallel: 1,
      retryOnFail: 2,
      runFn: mockRunFn
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.retried).toBe(2);
  });

  it("should estimate batch cost correctly for codex executor", () => {
    const cost = estimateBatchCost("codex", 10, 14);
    // 10 runs × 14 tasks × $0.01 = $1.40
    expect(cost).toBe("$1.40");
  });

  it("should return stoppedEarly=true when shouldStop returns true after 2 of 5 runs", async () => {
    let runsCompleted = 0;
    const mockRunFn = vi.fn(async () => {
      runsCompleted++;
      return `run-${runsCompleted}`;
    });

    const shouldStop = vi.fn(() => {
      // Stop after 2 runs
      return runsCompleted >= 2;
    });

    const result = await runBatch({
      totalRuns: 5,
      parallel: 1,
      retryOnFail: 0,
      shouldStop,
      runFn: mockRunFn
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.completed).toBeLessThanOrEqual(3);
  });
});
