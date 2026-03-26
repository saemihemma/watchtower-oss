import { describe, expect, it } from "vitest";
import {
  summarizeSide,
  computeScorecard,
  computeActionOffers,
  computeReplaceEligible,
  computeRecommendedAction,
  computeDevilsAdvocate,
  type BenchmarkTask,
  type BenchmarkPack,
  type TaskSideSummary,
  type TaskTrialResult,
  type Scorecard
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    task_id: overrides.task_id ?? "test_task_001",
    task_version: 1,
    family: "default",
    category: overrides.category ?? "test_category",
    critical_regression: overrides.critical_regression ?? false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: overrides.min_valid_trials ?? 1,
    trials_per_side: 5,
    prompt_text: "Test prompt",
    rubric_text: "0 bad\n4 good"
  };
}

function makeTrial(
  taskId: string,
  sideId: "left" | "right",
  score: number | null,
  status: "valid" | "failed" = "valid"
): TaskTrialResult {
  return {
    task_id: taskId,
    task_version: 1,
    side_id: sideId,
    trial_index: 0,
    normalized_score: score,
    false_positive: 0,
    status
  };
}

function makeSummary(
  taskId: string,
  sideId: "left" | "right",
  score: number | null,
  trialScores: number[] = score !== null ? [score] : []
): TaskSideSummary {
  return {
    task_id: taskId,
    task_version: 1,
    side_id: sideId,
    valid_trial_count: trialScores.length,
    failed_trial_count: 0,
    task_score: score,
    trial_scores: trialScores,
    false_positive_count: 0
  };
}

function makePack(tasks: BenchmarkTask[], weights: Record<string, number>): BenchmarkPack {
  return {
    pack_id: "test-pack",
    source: "built_in_pack",
    task_ids: tasks.map((t) => t.task_id),
    category_weights: weights,
    critical_task_ids: tasks.filter((t) => t.critical_regression).map((t) => t.task_id),
    catalog_hash: "test-hash"
  };
}

// ---------------------------------------------------------------------------
// summarizeSide
// ---------------------------------------------------------------------------

describe("summarizeSide", () => {
  it("computes median of valid trial scores", () => {
    const task = makeTask({ task_id: "t1", min_valid_trials: 1 });
    const trials: TaskTrialResult[] = [
      makeTrial("t1", "left", 0.25),
      makeTrial("t1", "left", 0.75),
      makeTrial("t1", "left", 0.5)
    ];
    const summary = summarizeSide(task, "left", trials);
    expect(summary.task_score).toBe(0.5);
    expect(summary.valid_trial_count).toBe(3);
  });

  it("returns null when insufficient valid trials", () => {
    const task = makeTask({ task_id: "t1", min_valid_trials: 3 });
    const trials: TaskTrialResult[] = [
      makeTrial("t1", "left", 0.5),
      makeTrial("t1", "left", null, "failed")
    ];
    const summary = summarizeSide(task, "left", trials);
    expect(summary.task_score).toBeNull();
    expect(summary.valid_trial_count).toBe(1);
    expect(summary.failed_trial_count).toBe(1);
  });

  it("filters by side correctly", () => {
    const task = makeTask({ task_id: "t1" });
    const trials: TaskTrialResult[] = [
      makeTrial("t1", "left", 0.75),
      makeTrial("t1", "right", 0.25)
    ];
    const leftSummary = summarizeSide(task, "left", trials);
    const rightSummary = summarizeSide(task, "right", trials);
    expect(leftSummary.task_score).toBe(0.75);
    expect(rightSummary.task_score).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// computeScorecard — winner determination
// ---------------------------------------------------------------------------

describe("computeScorecard", () => {
  it("declares right winner when right leads by > 5 points", () => {
    const task = makeTask({ task_id: "t1", category: "cat_a" });
    const pack = makePack([task], { cat_a: 100 });
    const summaries = [
      makeSummary("t1", "left", 0.3, [0.3]),
      makeSummary("t1", "right", 0.8, [0.8])
    ];
    const trials = [makeTrial("t1", "left", 0.3), makeTrial("t1", "right", 0.8)];

    const { winner, scorecard } = computeScorecard({ tasks: [task], benchmarkPack: pack, summaries, trialResults: trials });
    expect(winner).toBe("right");
    expect(scorecard.right_score).toBeGreaterThan(scorecard.left_score);
    expect(scorecard.delta).toBeGreaterThan(5);
  });

  it("declares left winner when left leads by > 5 points", () => {
    const task = makeTask({ task_id: "t1", category: "cat_a" });
    const pack = makePack([task], { cat_a: 100 });
    const summaries = [
      makeSummary("t1", "left", 0.9, [0.9]),
      makeSummary("t1", "right", 0.2, [0.2])
    ];
    const trials = [makeTrial("t1", "left", 0.9), makeTrial("t1", "right", 0.2)];

    const { winner } = computeScorecard({ tasks: [task], benchmarkPack: pack, summaries, trialResults: trials });
    expect(winner).toBe("left");
  });

  it("returns too_close_to_call when delta < 5 points", () => {
    const task = makeTask({ task_id: "t1", category: "cat_a" });
    const pack = makePack([task], { cat_a: 100 });
    const summaries = [
      makeSummary("t1", "left", 0.50, [0.50]),
      makeSummary("t1", "right", 0.52, [0.52])
    ];
    const trials = [makeTrial("t1", "left", 0.50), makeTrial("t1", "right", 0.52)];

    const { winner } = computeScorecard({ tasks: [task], benchmarkPack: pack, summaries, trialResults: trials });
    expect(winner).toBe("too_close_to_call");
  });

  it("returns too_close_to_call when confidence is low", () => {
    const task = makeTask({ task_id: "t1", category: "cat_a" });
    const pack = makePack([task], { cat_a: 100 });
    // All trials failed → null scores → low confidence
    const summaries = [
      makeSummary("t1", "left", null, []),
      makeSummary("t1", "right", null, [])
    ];
    const trials = [
      makeTrial("t1", "left", null, "failed"),
      makeTrial("t1", "right", null, "failed")
    ];

    const { winner, scorecard } = computeScorecard({ tasks: [task], benchmarkPack: pack, summaries, trialResults: trials });
    expect(winner).toBe("too_close_to_call");
    expect(scorecard.confidence).toBe("low");
  });

  it("blocks winner when critical regression exists", () => {
    const criticalTask = makeTask({ task_id: "critical_001", category: "cat_a", critical_regression: true });
    const normalTask = makeTask({ task_id: "normal_001", category: "cat_a" });
    const pack = makePack([criticalTask, normalTask], { cat_a: 100 });

    // Right wins overall but regresses on critical task
    const summaries = [
      makeSummary("critical_001", "left", 0.75, [0.75]),
      makeSummary("critical_001", "right", 0.25, [0.25]), // regression > 0.15
      makeSummary("normal_001", "left", 0.1, [0.1]),
      makeSummary("normal_001", "right", 1.0, [1.0]) // huge lead
    ];
    const trials = [
      makeTrial("critical_001", "left", 0.75),
      makeTrial("critical_001", "right", 0.25),
      makeTrial("normal_001", "left", 0.1),
      makeTrial("normal_001", "right", 1.0)
    ];

    const { winner } = computeScorecard({ tasks: [criticalTask, normalTask], benchmarkPack: pack, summaries, trialResults: trials });
    expect(winner).toBe("too_close_to_call");
  });

  it("computes weighted category scores correctly", () => {
    const taskA = makeTask({ task_id: "a1", category: "cat_a" });
    const taskB = makeTask({ task_id: "b1", category: "cat_b" });
    const pack = makePack([taskA, taskB], { cat_a: 75, cat_b: 25 });

    const summaries = [
      makeSummary("a1", "left", 1.0, [1.0]),
      makeSummary("a1", "right", 0.0, [0.0]),
      makeSummary("b1", "left", 0.0, [0.0]),
      makeSummary("b1", "right", 1.0, [1.0])
    ];
    const trials = [
      makeTrial("a1", "left", 1.0), makeTrial("a1", "right", 0.0),
      makeTrial("b1", "left", 0.0), makeTrial("b1", "right", 1.0)
    ];

    const { winner, scorecard } = computeScorecard({ tasks: [taskA, taskB], benchmarkPack: pack, summaries, trialResults: trials });
    // Left: (100 * 75 + 0 * 25) / 100 = 75
    // Right: (0 * 75 + 100 * 25) / 100 = 25
    expect(winner).toBe("left");
    expect(scorecard.left_score).toBe(75);
    expect(scorecard.right_score).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// computeActionOffers
// ---------------------------------------------------------------------------

describe("computeActionOffers", () => {
  it("offers replace actions for same_library comparison", () => {
    const actions = computeActionOffers("same_library");
    expect(actions).toContain("replace_left_with_right");
    expect(actions).toContain("replace_right_with_left");
  });

  it("does not offer replace actions for cross_library comparison", () => {
    const actions = computeActionOffers("cross_library");
    expect(actions).not.toContain("replace_left_with_right");
    expect(actions).not.toContain("replace_right_with_left");
    expect(actions).toContain("keep_separate");
  });
});

// ---------------------------------------------------------------------------
// computeReplaceEligible
// ---------------------------------------------------------------------------

describe("computeReplaceEligible", () => {
  const baseScorecard: Scorecard = {
    left_score: 40, right_score: 60, delta: 20,
    confidence: "high", category_scores: [], top_reasons: [], regressions: []
  };

  it("allows replacement for decisive same_library win with no regressions", () => {
    expect(computeReplaceEligible("right", "same_library", baseScorecard)).toBe(true);
  });

  it("blocks replacement for cross_library", () => {
    expect(computeReplaceEligible("right", "cross_library", baseScorecard)).toBe(false);
  });

  it("blocks replacement for too_close_to_call", () => {
    expect(computeReplaceEligible("too_close_to_call", "same_library", baseScorecard)).toBe(false);
  });

  it("blocks replacement when regressions exist", () => {
    const withRegression = { ...baseScorecard, regressions: ["Critical regression on task X"] };
    expect(computeReplaceEligible("right", "same_library", withRegression)).toBe(false);
  });

  it("blocks replacement when confidence is low", () => {
    const lowConfidence = { ...baseScorecard, confidence: "low" as const };
    expect(computeReplaceEligible("right", "same_library", lowConfidence)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeRecommendedAction
// ---------------------------------------------------------------------------

describe("computeRecommendedAction", () => {
  it("recommends replace for eligible same_library right win", () => {
    expect(computeRecommendedAction("right", "same_library", true)).toBe("replace_left_with_right");
  });

  it("recommends replace for eligible same_library left win", () => {
    expect(computeRecommendedAction("left", "same_library", true)).toBe("replace_right_with_left");
  });

  it("recommends rerun for too_close_to_call", () => {
    expect(computeRecommendedAction("too_close_to_call", "same_library", false)).toBe("rerun_with_narrower_change");
  });

  it("recommends port_ideas for cross_library", () => {
    expect(computeRecommendedAction("right", "cross_library", false)).toBe("port_ideas_deliberately");
  });

  it("recommends keep_separate when not replace-eligible", () => {
    expect(computeRecommendedAction("right", "same_library", false)).toBe("keep_separate");
  });
});

// ---------------------------------------------------------------------------
// computeDevilsAdvocate
// ---------------------------------------------------------------------------

describe("computeDevilsAdvocate", () => {
  const clearScorecard: Scorecard = {
    left_score: 30, right_score: 70, delta: 40,
    confidence: "high", category_scores: [], top_reasons: [], regressions: []
  };

  it("returns clear verdict for decisive same_library win", () => {
    const da = computeDevilsAdvocate("right", "same_library", clearScorecard);
    expect(da.verdict).toBe("clear");
  });

  it("returns block_replace for too_close_to_call", () => {
    const tiedScorecard: Scorecard = {
      left_score: 48, right_score: 52, delta: 4,
      confidence: "high", category_scores: [], top_reasons: [], regressions: []
    };
    const da = computeDevilsAdvocate("too_close_to_call", "same_library", tiedScorecard);
    expect(da.verdict).toBe("block_replace");
  });

  it("returns block_replace for cross_library comparison", () => {
    const da = computeDevilsAdvocate("right", "cross_library", clearScorecard);
    expect(da.verdict).toBe("block_replace");
    expect(da.arguments.some((a) => a.includes("cross-library"))).toBe(true);
  });

  it("returns block_replace when regressions exist", () => {
    const withRegression: Scorecard = {
      ...clearScorecard,
      regressions: ["Right regressed on critical task default_review_001 by -20.00 points."]
    };
    const da = computeDevilsAdvocate("right", "same_library", withRegression);
    expect(da.verdict).toBe("block_replace");
  });

  it("returns caution for narrow winning margin", () => {
    const narrowScorecard: Scorecard = {
      left_score: 42, right_score: 50, delta: 8,
      confidence: "high", category_scores: [], top_reasons: [], regressions: []
    };
    const da = computeDevilsAdvocate("right", "same_library", narrowScorecard);
    expect(da.verdict).toBe("caution");
    expect(da.arguments.some((a) => a.includes("modest"))).toBe(true);
  });

  it("returns block_replace for low confidence", () => {
    const lowConfidence: Scorecard = {
      ...clearScorecard,
      confidence: "low"
    };
    const da = computeDevilsAdvocate("right", "same_library", lowConfidence);
    expect(da.verdict).toBe("block_replace");
  });
});
