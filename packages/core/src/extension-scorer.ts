/**
 * Extension scorer registry and orchestrator.
 *
 * Scorers register at CLI startup. At most one extension fires per task.
 * If a scorer throws, the base score is used (graceful degradation).
 */

import type { BenchmarkTask, ExecutorInput, ExecutorOutput } from "./schemas.js";

export type ExtensionScoredResult = {
  normalizedScore: number;
  metadata: Record<string, unknown>;
  warnings: string[];
};

export interface ExtensionScorer {
  readonly kind: string;
  applicable(task: BenchmarkTask): boolean;
  score(input: ExecutorInput, baseResult: ExecutorOutput): Promise<ExtensionScoredResult>;
}

const scorers: ExtensionScorer[] = [];

export function registerExtensionScorer(scorer: ExtensionScorer): void {
  const existing = scorers.find(s => s.kind === scorer.kind);
  if (existing) {
    console.warn(
      `[watchtower] ExtensionScorer '${scorer.kind}' already registered. Possible test pollution.`
    );
  }
  scorers.push(scorer);
}

export function clearExtensionScorers(): void {
  scorers.length = 0;
}

export function getRegisteredScorers(): readonly ExtensionScorer[] {
  return scorers;
}

export async function scoreWithExtensions(
  input: ExecutorInput,
  baseResult: ExecutorOutput
): Promise<{ result: ExecutorOutput; metadata?: Record<string, unknown> }> {
  const applicable = scorers.find(s => s.applicable(input.task));
  if (!applicable) return { result: baseResult };

  try {
    const ext = await applicable.score(input, baseResult);
    return {
      result: { ...baseResult, normalizedScore: ext.normalizedScore },
      metadata: { scorer_kind: applicable.kind, ...ext.metadata }
    };
  } catch (err) {
    return {
      result: baseResult,
      metadata: {
        scorer_kind: applicable.kind,
        extension_error: err instanceof Error ? err.message : "unknown"
      }
    };
  }
}
