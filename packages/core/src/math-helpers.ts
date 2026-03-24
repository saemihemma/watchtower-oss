/**
 * Shared math and scoring helpers used across verdict, stats-verdict, and stats modules.
 */

import type { TaskSideSummary } from "./schemas.js";

/**
 * Arithmetic mean. Returns null for empty arrays.
 */
export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Arithmetic mean that returns a fallback for empty arrays.
 * Useful in Bayesian contexts where a prior default is needed.
 */
export function meanOrDefault(values: number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Median. Returns null for empty arrays.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Score range (max − min). Returns 0 for empty arrays.
 */
export function scoreRange(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values) - Math.min(...values);
}

/**
 * Build the standard summary lookup map keyed by `"taskId:sideId"`.
 * Used across verdict computation, confidence checks, and reason building.
 */
export function buildSummaryMap(
  summaries: TaskSideSummary[]
): Map<string, TaskSideSummary> {
  return new Map(
    summaries.map((summary) => [`${summary.task_id}:${summary.side_id}`, summary] as const)
  );
}
