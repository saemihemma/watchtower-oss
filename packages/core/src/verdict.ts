import {
  CAUTION_MARGIN,
  CRITICAL_REGRESSION_THRESHOLD,
  HIGH_CONFIDENCE_MAX_FAIL_RATE,
  MAX_CATEGORY_REASONS,
  MAX_REASONS,
  MEDIUM_CONFIDENCE_MAX_FAIL_RATE,
  UNSTABLE_SCORE_RANGE,
  WINNER_DELTA_THRESHOLD
} from "./constants.js";
import { buildSummaryMap, mean, median, scoreRange } from "./math-helpers.js";
import {
  ActionOffer,
  BenchmarkPack,
  BenchmarkTask,
  CategoryScore,
  ComparisonMode,
  ComparisonWinner,
  ConfidenceLevel,
  DevilsAdvocate,
  RecommendedAction,
  Scorecard,
  TaskSideSummary,
  TaskTrialResult
} from "./schemas.js";

export function summarizeSide(
  task: BenchmarkTask,
  sideId: "left" | "right",
  trialResults: TaskTrialResult[]
): TaskSideSummary {
  const sideResults = trialResults.filter(
    (result) => result.side_id === sideId && result.task_id === task.task_id
  );
  const validScores = sideResults
    .filter((result) => result.status === "valid" && result.normalized_score !== null)
    .map((result) => result.normalized_score as number);

  return {
    task_id: task.task_id,
    task_version: task.task_version,
    side_id: sideId,
    valid_trial_count: validScores.length,
    failed_trial_count: sideResults.length - validScores.length,
    task_score: validScores.length >= task.min_valid_trials ? median(validScores) : null,
    trial_scores: validScores,
    false_positive_count: sideResults.reduce((sum, result) => sum + result.false_positive, 0)
  };
}

type ScorecardInputs = {
  tasks: BenchmarkTask[];
  benchmarkPack: BenchmarkPack;
  summaries: TaskSideSummary[];
  trialResults: TaskTrialResult[];
};

function buildCategoryScores(inputs: ScorecardInputs): CategoryScore[] {
  const summaryMap = buildSummaryMap(inputs.summaries);

  return (Object.entries(inputs.benchmarkPack.category_weights) as Array<[CategoryScore["category"], number]>).map(
    ([category, weight]) => {
      const tasks = inputs.tasks.filter((task) => task.category === category);
      const leftScores = tasks
        .map((task) => summaryMap.get(`${task.task_id}:left`)?.task_score ?? null)
        .filter((score): score is number => score !== null);
      const rightScores = tasks
        .map((task) => summaryMap.get(`${task.task_id}:right`)?.task_score ?? null)
        .filter((score): score is number => score !== null);
      const unstable = tasks.some((task) => {
        const leftRange = scoreRange(summaryMap.get(`${task.task_id}:left`)?.trial_scores ?? []);
        const rightRange = scoreRange(summaryMap.get(`${task.task_id}:right`)?.trial_scores ?? []);
        return Math.max(leftRange, rightRange) > UNSTABLE_SCORE_RANGE;
      });

      const leftMean = mean(leftScores);
      const rightMean = mean(rightScores);

      return {
        category,
        weight,
        left_score: leftMean === null ? null : Number((leftMean * 100).toFixed(2)),
        right_score: rightMean === null ? null : Number((rightMean * 100).toFixed(2)),
        delta:
          leftMean === null || rightMean === null ? null : Number(((rightMean - leftMean) * 100).toFixed(2)),
        unstable,
        task_ids: tasks.map((task) => task.task_id)
      };
    }
  );
}

function computeConfidence(
  tasks: BenchmarkTask[],
  categoryScores: CategoryScore[],
  summaries: TaskSideSummary[],
  trialResults: TaskTrialResult[]
): ConfidenceLevel {
  const summaryMap = buildSummaryMap(summaries);
  const allSummariesValid = tasks.every(
    (task) =>
      summaryMap.get(`${task.task_id}:left`)?.task_score !== null &&
      summaryMap.get(`${task.task_id}:right`)?.task_score !== null
  );
  const failedTrials = trialResults.filter((result) => result.status === "failed").length;
  const failedRate = failedTrials / Math.max(trialResults.length, 1);

  if (allSummariesValid && failedRate <= HIGH_CONFIDENCE_MAX_FAIL_RATE && categoryScores.every((category) => !category.unstable)) {
    return "high";
  }
  if (
    categoryScores.every((category) => category.left_score !== null && category.right_score !== null) &&
    failedRate <= MEDIUM_CONFIDENCE_MAX_FAIL_RATE
  ) {
    return "medium";
  }
  return "low";
}

function computeOverallScore(categoryScores: CategoryScore[], side: "left" | "right"): number {
  let weightedTotal = 0;
  let weightTotal = 0;

  for (const category of categoryScores) {
    const score = side === "left" ? category.left_score : category.right_score;
    if (score === null) {
      continue;
    }
    weightedTotal += score * category.weight;
    weightTotal += category.weight;
  }

  return weightTotal === 0 ? 0 : Number((weightedTotal / weightTotal).toFixed(2));
}

function buildTopReasons(
  winner: ComparisonWinner,
  categoryScores: CategoryScore[],
  tasks: BenchmarkTask[],
  summaries: TaskSideSummary[],
  confidence: ConfidenceLevel,
  leftScore: number,
  rightScore: number
): { reasons: string[]; regressions: string[] } {
  const reasons: string[] = [];
  const regressions: string[] = [];

  if (winner === "too_close_to_call") {
    reasons.push(
      `Score delta was ${Math.abs(rightScore - leftScore).toFixed(2)}, below the 5-point winner threshold.`
    );
    if (confidence === "low") {
      reasons.push("Confidence is low because trial coverage or variance did not clear the benchmark bar.");
    }
    return { reasons, regressions };
  }

  const sortedCategories = [...categoryScores]
    .filter((category) => category.delta !== null)
    .sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number));

  for (const category of sortedCategories) {
    const delta = category.delta as number;
    if (winner === "right" && delta > 0) {
      reasons.push(`Right led ${category.category.replaceAll("_", " ")} by ${delta.toFixed(2)} points.`);
    }
    if (winner === "left" && delta < 0) {
      reasons.push(`Left led ${category.category.replaceAll("_", " ")} by ${Math.abs(delta).toFixed(2)} points.`);
    }
    if (reasons.length >= MAX_CATEGORY_REASONS) {
      break;
    }
  }

  const summaryMap = buildSummaryMap(summaries);
  for (const task of tasks.filter((candidate) => candidate.critical_regression)) {
    const leftTask = summaryMap.get(`${task.task_id}:left`)?.task_score ?? null;
    const rightTask = summaryMap.get(`${task.task_id}:right`)?.task_score ?? null;
    if (leftTask === null || rightTask === null) {
      continue;
    }
    const delta = rightTask - leftTask;
    if (winner === "right" && delta < 0) {
      regressions.push(`Right regressed on critical task ${task.task_id} by ${(delta * 100).toFixed(2)} points.`);
    }
    if (winner === "left" && delta > 0) {
      regressions.push(`Left regressed on critical task ${task.task_id} by ${(delta * 100).toFixed(2)} points.`);
    }
  }

  if (confidence !== "high") {
    reasons.push(`Confidence is ${confidence}, so treat this as directional rather than absolute.`);
  }

  return { reasons: reasons.slice(0, MAX_REASONS), regressions };
}

function determineWinner(
  leftScore: number,
  rightScore: number,
  confidence: ConfidenceLevel,
  tasks: BenchmarkTask[],
  summaries: TaskSideSummary[]
): ComparisonWinner {
  const delta = rightScore - leftScore;
  const summaryMap = buildSummaryMap(summaries);

  if (confidence === "low") {
    return "too_close_to_call";
  }

  const rightHasCriticalRegression = tasks.some((task) => {
    if (!task.critical_regression) {
      return false;
    }
    const leftTask = summaryMap.get(`${task.task_id}:left`)?.task_score ?? null;
    const rightTask = summaryMap.get(`${task.task_id}:right`)?.task_score ?? null;
    return leftTask !== null && rightTask !== null && rightTask - leftTask <= CRITICAL_REGRESSION_THRESHOLD;
  });
  const leftHasCriticalRegression = tasks.some((task) => {
    if (!task.critical_regression) {
      return false;
    }
    const leftTask = summaryMap.get(`${task.task_id}:left`)?.task_score ?? null;
    const rightTask = summaryMap.get(`${task.task_id}:right`)?.task_score ?? null;
    return leftTask !== null && rightTask !== null && leftTask - rightTask <= CRITICAL_REGRESSION_THRESHOLD;
  });

  if (delta >= WINNER_DELTA_THRESHOLD && !rightHasCriticalRegression) {
    return "right";
  }
  if (delta <= -WINNER_DELTA_THRESHOLD && !leftHasCriticalRegression) {
    return "left";
  }
  return "too_close_to_call";
}

export function computeScorecard(inputs: ScorecardInputs): {
  winner: ComparisonWinner;
  scorecard: Scorecard;
} {
  const categoryScores = buildCategoryScores(inputs);
  const confidence = computeConfidence(inputs.tasks, categoryScores, inputs.summaries, inputs.trialResults);
  const leftScore = computeOverallScore(categoryScores, "left");
  const rightScore = computeOverallScore(categoryScores, "right");
  const winner = determineWinner(leftScore, rightScore, confidence, inputs.tasks, inputs.summaries);
  const { reasons, regressions } = buildTopReasons(
    winner,
    categoryScores,
    inputs.tasks,
    inputs.summaries,
    confidence,
    leftScore,
    rightScore
  );

  return {
    winner,
    scorecard: {
      left_score: leftScore,
      right_score: rightScore,
      delta: Number((rightScore - leftScore).toFixed(2)),
      confidence,
      category_scores: categoryScores,
      top_reasons: reasons.length > 0 ? reasons : ["No decisive benchmark reason was found."],
      regressions
    }
  };
}

export function computeActionOffers(comparisonMode: ComparisonMode): ActionOffer[] {
  return comparisonMode === "same_library"
    ? ["replace_left_with_right", "replace_right_with_left", "keep_separate", "cleanup_plan"]
    : ["keep_separate", "cleanup_plan"];
}

export function computeReplaceEligible(
  winner: ComparisonWinner,
  comparisonMode: ComparisonMode,
  scorecard: Scorecard
): boolean {
  return (
    comparisonMode === "same_library" &&
    winner !== "too_close_to_call" &&
    scorecard.confidence !== "low" &&
    scorecard.regressions.length === 0
  );
}

export function computeRecommendedAction(
  winner: ComparisonWinner,
  comparisonMode: ComparisonMode,
  replaceEligible: boolean
): RecommendedAction {
  if (winner === "too_close_to_call") {
    return "rerun_with_narrower_change";
  }
  if (comparisonMode === "cross_library") {
    return "port_ideas_deliberately";
  }
  if (replaceEligible) {
    return winner === "right" ? "replace_left_with_right" : "replace_right_with_left";
  }
  return "keep_separate";
}

export function computeDevilsAdvocate(
  winner: ComparisonWinner,
  comparisonMode: ComparisonMode,
  scorecard: Scorecard
): DevilsAdvocate {
  const argumentsList: string[] = [];

  if (winner === "too_close_to_call") {
    argumentsList.push(
      `Score delta was ${Math.abs(scorecard.delta).toFixed(2)}, which is not decisive enough to justify replacement.`
    );
  }
  if (scorecard.confidence === "medium") {
    argumentsList.push("Confidence is medium, so the result is useful but not airtight.");
  }
  if (scorecard.confidence === "low") {
    argumentsList.push("Confidence is low, so replacement should stay blocked until the run is cleaner.");
  }
  if (scorecard.regressions.length > 0) {
    argumentsList.push(...scorecard.regressions);
  }
  if (comparisonMode === "cross_library" && winner !== "too_close_to_call") {
    argumentsList.push("This was a cross-library comparison, so benchmark winner does not mean drop-in replacement-safe.");
  }
  if (winner !== "too_close_to_call" && Math.abs(scorecard.delta) < CAUTION_MARGIN) {
    argumentsList.push("The winner cleared the threshold, but the margin is still modest enough to deserve caution.");
  }

  if (argumentsList.length === 0) {
    return {
      verdict: "clear",
      arguments: ["No blocking Devil's Advocate concern remained after scoring and regression checks."]
    };
  }

  return {
    verdict:
      winner === "too_close_to_call" ||
      scorecard.confidence === "low" ||
      scorecard.regressions.length > 0 ||
      comparisonMode === "cross_library"
        ? "block_replace"
        : "caution",
    arguments: argumentsList.slice(0, MAX_REASONS)
  };
}
