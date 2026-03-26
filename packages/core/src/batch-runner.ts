/**
 * Batch runner for executing multiple comparison runs in parallel with retry logic and SIGINT handling.
 *
 * Each run is executed via a callback function (runFn) that performs a comparison and returns the run_id.
 * The batch runner handles concurrency control via semaphore, retry logic, and graceful stopping.
 *
 * Design pattern for SIGINT:
 * - CLI sets up process.on('SIGINT', ...) and flips a flag
 * - Flag is passed to shouldStop callback
 * - Batch runner polls shouldStop() between runs (not within a run)
 * - Each completed run is already persisted by the engine
 */

import { v7 as uuidv7 } from "uuid";
import {
  BATCH_MAX_PARALLEL,
  BATCH_DEFAULT_PARALLEL,
} from "./constants.js";
import type { ExecutorKind } from "./schemas.js";

/**
 * Configuration for batch runner.
 * The batch runner is decoupled from engine internals by accepting a runFn callback.
 */
export type BatchConfig = {
  /** Total number of runs to execute. */
  totalRuns: number;

  /** Number of parallel runs. Clamped to [1, BATCH_MAX_PARALLEL]. */
  parallel: number;

  /** Number of times to retry a failed run before giving up. */
  retryOnFail: number;

  /** Optional callback to check if batch should stop early. Called between runs. */
  shouldStop?: () => boolean;

  /** Optional callback invoked after each run completes (regardless of retry attempts). */
  onRunComplete?: (runId: string, index: number, total: number) => void;

  /**
   * Async function that executes a single comparison run.
   * Returns the run_id on success.
   * Throws on failure (will be caught and retried).
   */
  runFn: (index: number) => Promise<string>;
};

/**
 * Result of a batch run.
 */
export type BatchResult = {
  /** Unique identifier for this batch. */
  batchId: string;

  /** Number of runs that completed successfully. */
  completed: number;

  /** Number of runs that failed after all retries. */
  failed: number;

  /** Total number of retry attempts across all runs. */
  retried: number;

  /** List of run_ids that completed (successful runs only). */
  runIds: string[];

  /** Wall clock time for the entire batch, in milliseconds. */
  wallClockMs: number;

  /** Estimated cost as a formatted string (e.g., "$1.40"). */
  estimatedCost: string;

  /** Whether the batch was stopped early via shouldStop(). */
  stoppedEarly: boolean;
};

/**
 * Execute a batch of comparison runs with concurrency control and retry logic.
 *
 * Uses a semaphore pattern with Promise.allSettled to limit parallelism.
 * Polls shouldStop() between runs for testable SIGINT pattern.
 * Each failed run is retried up to retryOnFail times.
 */
export async function runBatch(config: BatchConfig): Promise<BatchResult> {
  const startTime = Date.now();
  const batchId = uuidv7();

  // Clamp parallel to valid range
  const parallel = Math.max(1, Math.min(config.parallel, BATCH_MAX_PARALLEL));

  let completed = 0;
  let failed = 0;
  let retried = 0;
  const runIds: string[] = [];

  // Track run results with their indices for onRunComplete callback
  const runQueue: Array<{
    index: number;
    attemptsLeft: number;
    runId?: string;
  }> = Array.from({ length: config.totalRuns }, (_, i) => ({
    index: i,
    attemptsLeft: config.retryOnFail + 1, // Initial attempt + retries
  }));

  /**
   * Worker function: execute the next run from queue.
   * Continues pulling items until queue is empty or shouldStop returns true.
   */
  const worker = async (): Promise<void> => {
    while (true) {
      // Check if we should stop early
      if (config.shouldStop?.()) {
        return;
      }

      // Dequeue next item (thread-safe in JS due to single-threaded execution model)
      if (runQueue.length === 0) {
        return;
      }

      const item = runQueue.shift()!;

      try {
        item.runId = await config.runFn(item.index);
        runIds.push(item.runId);
        completed++;
        config.onRunComplete?.(item.runId, completed + failed, config.totalRuns);
      } catch (error) {
        // Retry logic
        if (item.attemptsLeft > 1) {
          item.attemptsLeft--;
          retried++;
          runQueue.push(item); // Re-queue for retry
        } else {
          failed++;
          config.onRunComplete?.(
            `failed-${item.index}`,
            completed + failed,
            config.totalRuns
          );
        }
      }
    }
  };

  // Launch `parallel` worker coroutines to process the queue concurrently
  const workers = Array.from({ length: parallel }, () => worker());

  // Wait for all workers to complete
  await Promise.all(workers);

  const wallClockMs = Date.now() - startTime;
  const stoppedEarly = config.shouldStop?.() ?? false;

  // Note: estimatedCost is computed by the caller based on actual executor kind
  // Here we use a placeholder; in practice, caller provides executor context
  const estimatedCost = estimateBatchCost("mock", completed, 14);

  return {
    batchId,
    completed,
    failed,
    retried,
    runIds,
    wallClockMs,
    estimatedCost,
    stoppedEarly,
  };
}

/**
 * Estimate the cost of a batch based on executor type and run count.
 *
 * Codex: ~$0.01 per comparison (14 tasks per run default)
 * Mock: $0.00 (for testing)
 * Claude: Estimated based on token counts (future)
 *
 * Returns formatted string like "$1.40".
 */
export function estimateBatchCost(
  executor: ExecutorKind,
  runs: number,
  tasksPerRun: number
): string {
  let costPerRun = 0;

  switch (executor) {
    case "codex":
      // ~$0.01 per call, 2 sides = ~$0.02 per task
      // tasksPerRun tasks × 2 sides × $0.01 ≈ $0.02 × tasksPerRun
      costPerRun = tasksPerRun * 0.01;
      break;
    case "claude":
      // Claude pricing is per-token; estimate ~$0.015 per comparison for safety
      costPerRun = 0.015;
      break;
    case "mock":
      costPerRun = 0;
      break;
  }

  const totalCost = costPerRun * runs;
  return `$${totalCost.toFixed(2)}`;
}
