/**
 * Enhanced verdict computation that layers v2 stats on top of existing scoring.
 */

import {
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  DEFAULT_LIKELIHOOD_SIGMA,
  DEFAULT_PRIOR_MEAN,
  DEFAULT_PRIOR_SIGMA,
  DEFAULT_ROPE_EPSILON
} from "./constants.js";
import { buildSummaryMap, meanOrDefault } from "./math-helpers.js";
import {
  BenchmarkTask,
  TaskSideSummary,
  CategoryScore,
  BenchmarkPack,
  TaskTrialResult,
  ComparisonWinner,
  ConfidenceLevel,
  EnhancedCategoryScore,
  Scorecard,
  IRTWeightOverride
} from "./schemas.js";
import {
  bayesianUpdate,
  bootstrapDeltaCI,
  coefficientOfVariation,
  ropeDecision
} from "./stats.js";
import { computeScorecard } from "./verdict.js";

export type EnhancedScorecard = {
  left_score: number;
  right_score: number;
  delta: number;
  confidence: ConfidenceLevel;
  category_scores: CategoryScore[];
  top_reasons: string[];
  regressions: string[];
  v2: {
    left_posterior: { mean: number; sigma: number; ci95: [number, number] };
    right_posterior: { mean: number; sigma: number; ci95: [number, number] };
    overall_delta_ci95: [number, number];
    overall_prob_right_superior: number;
    overall_rope_verdict: "left_wins" | "right_wins" | "equivalent" | "undecided";
    rope_epsilon: number;
    bootstrap_resamples: number;
    enhanced_categories: EnhancedCategoryScore[];
  };
};

/**
 * Apply IRT weights to category weights.
 * For each category, the base weight is multiplied by the mean IRT weight of its tasks.
 * Tasks not found in the calibration default to 1.0 (with warning).
 */
export function applyIRTWeights(
  pack: BenchmarkPack,
  tasks: BenchmarkTask[],
  weights: IRTWeightOverride[]
): BenchmarkPack {
  const weightMap = new Map(weights.map(w => [w.task_id, w.irt_weight]));
  const adjustedCategoryWeights: Record<string, number> = {};

  for (const [category, baseWeight] of Object.entries(pack.category_weights)) {
    const categoryTasks = tasks.filter(t => t.category === category);
    const taskIrtWeights = categoryTasks.map(t => {
      const w = weightMap.get(t.task_id);
      if (w === undefined) {
        console.warn(
          `[watchtower/irt] Task ${t.task_id} not in calibration. Using default weight 1.0.`
        );
      }
      return w ?? 1.0;
    });
    const meanIrtWeight =
      taskIrtWeights.length > 0
        ? taskIrtWeights.reduce((a, b) => a + b, 0) / taskIrtWeights.length
        : 1.0;
    adjustedCategoryWeights[category] = baseWeight * meanIrtWeight;
  }

  return { ...pack, category_weights: adjustedCategoryWeights };
}

export function computeEnhancedScorecard(inputs: {
  tasks: BenchmarkTask[];
  benchmarkPack: BenchmarkPack;
  summaries: TaskSideSummary[];
  trialResults: TaskTrialResult[];
  irtWeights?: IRTWeightOverride[];
  config?: {
    priorMean?: number;
    priorSigma?: number;
    likelihoodSigma?: number;
    ropeEpsilon?: number;
    bootstrapResamples?: number;
    bootstrapSeed?: number;
  };
}): { winner: ComparisonWinner; scorecard: EnhancedScorecard } {
  const {
    tasks,
    benchmarkPack,
    summaries,
    trialResults,
    irtWeights,
    config = {}
  } = inputs;

  const effectivePack = irtWeights
    ? applyIRTWeights(benchmarkPack, tasks, irtWeights)
    : benchmarkPack;

  const {
    priorMean = DEFAULT_PRIOR_MEAN,
    priorSigma = DEFAULT_PRIOR_SIGMA,
    likelihoodSigma = DEFAULT_LIKELIHOOD_SIGMA,
    ropeEpsilon = DEFAULT_ROPE_EPSILON,
    bootstrapResamples = DEFAULT_BOOTSTRAP_RESAMPLES,
    bootstrapSeed = DEFAULT_BOOTSTRAP_SEED
  } = config;

  const { winner, scorecard } = computeScorecard({
    tasks,
    benchmarkPack: effectivePack,
    summaries,
    trialResults
  });

  const summaryMap = buildSummaryMap(summaries);

  const allLeftScores: number[] = [];
  const allRightScores: number[] = [];

  for (const summary of summaries) {
    if (summary.side_id === "left") {
      allLeftScores.push(...summary.trial_scores);
    } else {
      allRightScores.push(...summary.trial_scores);
    }
  }

  const leftMean = meanOrDefault(allLeftScores, priorMean);
  const rightMean = meanOrDefault(allRightScores, priorMean);

  const leftPosterior = bayesianUpdate({
    priorMean,
    priorSigma,
    observedMean: leftMean,
    likelihoodSigma,
    n: allLeftScores.length
  });

  const rightPosterior = bayesianUpdate({
    priorMean,
    priorSigma,
    observedMean: rightMean,
    likelihoodSigma,
    n: allRightScores.length
  });

  const deltaBootstrap = bootstrapDeltaCI({
    leftScores: allLeftScores,
    rightScores: allRightScores,
    nResamples: bootstrapResamples,
    seed: bootstrapSeed
  });

  const overallRopeVerdict = ropeDecision({
    ci95: deltaBootstrap.ci95,
    epsilon: ropeEpsilon / 100
  });

  const enhancedCategories: EnhancedCategoryScore[] = scorecard.category_scores.map((category) => {
    const categoryTasks = tasks.filter((task) => task.category === category.category);

    const leftCategoryScores: number[] = [];
    const rightCategoryScores: number[] = [];

    for (const task of categoryTasks) {
      const leftSummary = summaryMap.get(`${task.task_id}:left`);
      const rightSummary = summaryMap.get(`${task.task_id}:right`);

      if (leftSummary) {
        leftCategoryScores.push(...leftSummary.trial_scores);
      }
      if (rightSummary) {
        rightCategoryScores.push(...rightSummary.trial_scores);
      }
    }

    const leftCategoryMean = meanOrDefault(leftCategoryScores, priorMean);

    const leftCategoryPosterior = bayesianUpdate({
      priorMean,
      priorSigma,
      observedMean: leftCategoryMean,
      likelihoodSigma,
      n: leftCategoryScores.length
    });

    const rightCategoryMean = meanOrDefault(rightCategoryScores, priorMean);

    const rightCategoryPosterior = bayesianUpdate({
      priorMean,
      priorSigma,
      observedMean: rightCategoryMean,
      likelihoodSigma,
      n: rightCategoryScores.length
    });

    const categoryDeltaBootstrap = bootstrapDeltaCI({
      leftScores: leftCategoryScores,
      rightScores: rightCategoryScores,
      nResamples: bootstrapResamples,
      seed: bootstrapSeed + category.category.length
    });

    const categoryRopeVerdict = ropeDecision({
      ci95: categoryDeltaBootstrap.ci95,
      epsilon: ropeEpsilon / 100
    });

    const leftCv = coefficientOfVariation(leftCategoryScores);
    const rightCv = coefficientOfVariation(rightCategoryScores);

    return {
      ...category,
      left_posterior: {
        mean: leftCategoryPosterior.posteriorMean,
        sigma: leftCategoryPosterior.posteriorSigma,
        ci95: leftCategoryPosterior.ci95
      },
      right_posterior: {
        mean: rightCategoryPosterior.posteriorMean,
        sigma: rightCategoryPosterior.posteriorSigma,
        ci95: rightCategoryPosterior.ci95
      },
      delta_ci95: categoryDeltaBootstrap.ci95,
      prob_right_superior: categoryDeltaBootstrap.probRightSuperior,
      rope_verdict: categoryRopeVerdict,
      left_cv: { cv: leftCv.cv, stability: leftCv.stabilityLabel },
      right_cv: { cv: rightCv.cv, stability: rightCv.stabilityLabel }
    };
  });

  return {
    winner,
    scorecard: {
      left_score: scorecard.left_score,
      right_score: scorecard.right_score,
      delta: scorecard.delta,
      confidence: scorecard.confidence,
      category_scores: scorecard.category_scores,
      top_reasons: scorecard.top_reasons,
      regressions: scorecard.regressions,

      v2: {
        left_posterior: {
          mean: leftPosterior.posteriorMean,
          sigma: leftPosterior.posteriorSigma,
          ci95: leftPosterior.ci95
        },
        right_posterior: {
          mean: rightPosterior.posteriorMean,
          sigma: rightPosterior.posteriorSigma,
          ci95: rightPosterior.ci95
        },
        overall_delta_ci95: deltaBootstrap.ci95,
        overall_prob_right_superior: deltaBootstrap.probRightSuperior,
        overall_rope_verdict: overallRopeVerdict,
        rope_epsilon: ropeEpsilon,
        bootstrap_resamples: bootstrapResamples,
        enhanced_categories: enhancedCategories
      }
    }
  };
}
