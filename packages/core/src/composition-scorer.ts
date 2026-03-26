/**
 * Composition extension scorer and collapse detection.
 *
 * Implements ExtensionScorer for tasks with extensions.composition.
 * Mock executor: evaluates composition_cues by case-insensitive substring matching.
 *
 * Collapse detection is post-hoc (not per-task). It runs after all composition
 * tasks are scored and is exposed via enrichCompositionMetadata().
 *
 * Note: Cue-matching is a directional signal, not semantic evaluation.
 * Estimated FP rate is 25-35% for keyword-heavy bundles.
 * Real executor scoring (LLM semantic evaluation) is Phase 10 scope.
 */

import {
  COLLAPSE_PRIMITIVE_FLOOR,
  COLLAPSE_COMPOSED_CEILING,
} from "./constants.js";
import { getBundleText } from "./cv-scorer.js";
import type {
  ExtensionScorer,
  ExtensionScoredResult,
} from "./extension-scorer.js";
import type {
  BenchmarkTask,
  CollapseConfig,
  CollapseResult,
  CompositionTaskExtension,
  ExecutorInput,
  ExecutorOutput,
  TaskTrialResult,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Collapse detection
// ---------------------------------------------------------------------------

/**
 * Detect compositional collapse: high primitive scores but low composed scores.
 *
 * Uses configurable thresholds (per-profile or system defaults).
 * Severity guarded: when meanPrim < 0.1, severity is meaningless (weak primitives).
 */
export function detectCollapse(
  primitiveScores: number[],
  composedScores: number[],
  config: CollapseConfig = {
    primitive_floor: COLLAPSE_PRIMITIVE_FLOOR,
    composed_ceiling: COLLAPSE_COMPOSED_CEILING,
  }
): CollapseResult {
  const meanPrim =
    primitiveScores.length > 0
      ? primitiveScores.reduce((a, b) => a + b, 0) / primitiveScores.length
      : 0;
  const meanComp =
    composedScores.length > 0
      ? composedScores.reduce((a, b) => a + b, 0) / composedScores.length
      : 0;

  const detected =
    meanPrim > config.primitive_floor && meanComp < config.composed_ceiling;

  // Severity guarded: when meanPrim < 0.1, severity is 0 (weak primitives).
  // Formula: (gap between layers) / (primitive baseline + epsilon).
  // Result ∈ [0, 1] when detected=true and meanPrim ≥ 0.1.
  const severity =
    detected && meanPrim >= 0.1
      ? (meanPrim - meanComp) / (meanPrim + 0.01)
      : 0;

  return {
    detected,
    severity,
    mean_primitive: meanPrim,
    mean_composed: meanComp,
  };
}

// ---------------------------------------------------------------------------
// Composition cue scoring
// ---------------------------------------------------------------------------

type CueScoreResult = {
  score: number;
  details: { matched: string[]; unmatched: string[]; total: number };
  warnings: string[];
};

function scoreCompositionCues(
  ext: CompositionTaskExtension,
  bundleText: string,
  baseScore: number
): CueScoreResult {
  if (ext.composition_cues.length === 0) {
    return {
      score: baseScore,
      details: { matched: [], unmatched: [], total: 0 },
      warnings: ["No composition_cues defined; using base executor score."],
    };
  }

  const lower = bundleText.toLowerCase();
  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const cue of ext.composition_cues) {
    if (lower.includes(cue.toLowerCase())) {
      matched.push(cue);
    } else {
      unmatched.push(cue);
    }
  }

  return {
    score: matched.length / ext.composition_cues.length,
    details: {
      matched,
      unmatched,
      total: ext.composition_cues.length,
    },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Composition scorer factory
// ---------------------------------------------------------------------------

export function createCompositionScorer(): ExtensionScorer {
  return {
    kind: "composition",

    applicable(task: BenchmarkTask): boolean {
      return task.extensions?.composition !== undefined;
    },

    async score(
      input: ExecutorInput,
      baseResult: ExecutorOutput
    ): Promise<ExtensionScoredResult> {
      const ext = input.task.extensions!.composition!;
      const bundleText = getBundleText(input.bundleDir);
      const baseScore = baseResult.normalizedScore ?? 0;

      const cueScore = scoreCompositionCues(ext, bundleText, baseScore);

      return {
        normalizedScore: cueScore.score,
        metadata: {
          scorer_kind: "composition",
          layer: ext.layer,
          dependencies: ext.dependencies,
          cue_details: cueScore.details,
        },
        warnings: cueScore.warnings,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Composition metadata enrichment (post-hoc, called from engine.ts)
// ---------------------------------------------------------------------------

/**
 * Enrich comparison run with composition analysis.
 * Runs collapse detection across all composition tasks after scoring.
 *
 * Meta tasks are grouped with composed for collapse detection.
 * Rationale: meta is a higher-order composition task; collapse measures
 * "can the agent compose at all" vs. "can it handle primitives."
 * Separating meta would require 3-way analysis with insufficient N.
 *
 * Minimum sample guard: requires ≥ 2 scored tasks per layer.
 * With fewer, returns insufficient_data: true.
 */
export function enrichCompositionMetadata(
  profile: { tasks: BenchmarkTask[]; collapse_config?: CollapseConfig },
  taskTrialResults: TaskTrialResult[]
): CollapseResult | undefined {
  const compositionTasks = profile.tasks.filter(
    (t) => t.extensions?.composition
  );
  if (compositionTasks.length === 0) return undefined;

  // Group by layer. Meta grouped with composed.
  const primitiveIds = new Set(
    compositionTasks
      .filter((t) => t.extensions!.composition!.layer === "primitive")
      .map((t) => t.task_id)
  );
  const composedIds = new Set(
    compositionTasks
      .filter((t) => t.extensions!.composition!.layer !== "primitive")
      .map((t) => t.task_id)
  );

  const primitiveScores = taskTrialResults
    .filter((tr) => primitiveIds.has(tr.task_id))
    .map((tr) => tr.normalized_score ?? 0);
  const composedScores = taskTrialResults
    .filter((tr) => composedIds.has(tr.task_id))
    .map((tr) => tr.normalized_score ?? 0);

  // Minimum sample guard: collapse detection requires ≥ 2 scored tasks per layer.
  // With fewer, mean estimates are too noisy for reliable detection (~20% FP at N=1).
  if (primitiveScores.length < 2 || composedScores.length < 2) {
    return {
      detected: false,
      severity: 0,
      mean_primitive:
        primitiveScores.length > 0
          ? primitiveScores.reduce((a, b) => a + b, 0) /
            primitiveScores.length
          : 0,
      mean_composed:
        composedScores.length > 0
          ? composedScores.reduce((a, b) => a + b, 0) /
            composedScores.length
          : 0,
      insufficient_data: true,
    };
  }

  return detectCollapse(
    primitiveScores,
    composedScores,
    profile.collapse_config
  );
}
