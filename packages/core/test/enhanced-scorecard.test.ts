import { describe, it, expect } from "vitest";
import {
  type BenchmarkTask,
  type BenchmarkPack,
  type TaskSideSummary,
  type TaskTrialResult
} from "../src/schemas.js";
import { computeEnhancedScorecard } from "../src/stats-verdict.js";

describe("Enhanced Scorecard Integration", () => {
  const createMockTask = (id: string, category: "routing_accuracy" | "boundary_clarity" = "routing_accuracy"): BenchmarkTask => {
    return {
      task_id: id,
      task_version: 1,
      family: "test",
      category,
      critical_regression: false,
      evaluator_kind: "deterministic",
      priority: 1,
      min_valid_trials: 3,
      prompt_text: `Test task ${id}`,
      rubric_text: null
    };
  };

  const createMockPack = (): BenchmarkPack => {
    return {
      pack_id: "test-pack",
      source: "built_in_pack",
      task_ids: ["task-1", "task-2"],
      category_weights: {
        routing_accuracy: 0.5,
        boundary_clarity: 0.5,
        review_quality: 0,
        handoff_quality: 0
      },
      critical_task_ids: [],
      catalog_hash: "mock"
    };
  };

  it("should correctly identify clear winner with stable scores", () => {
    const tasks = [
      createMockTask("task-1", "routing_accuracy"),
      createMockTask("task-2", "boundary_clarity")
    ];
    const pack = createMockPack();

    // Summaries: left is strong, right is weak
    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.8,
        trial_scores: [0.8, 0.79, 0.81, 0.78, 0.82],
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.3,
        trial_scores: [0.3, 0.31, 0.29, 0.32, 0.28],
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.75,
        trial_scores: [0.75, 0.76, 0.74, 0.77, 0.73],
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.25,
        trial_scores: [0.25, 0.26, 0.24, 0.27, 0.23],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id,
          task_version: 1,
          side_id: summary.side_id,
          trial_index: i,
          evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i],
          false_positive: 0,
          status: "valid"
        });
      }
    }

    const { winner, scorecard } = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults,
      config: {
        priorMean: 0.5,
        priorSigma: 0.15,
        likelihoodSigma: 0.1,
        ropeEpsilon: 5,
        bootstrapResamples: 5000,
        bootstrapSeed: 42
      }
    });

    // Should identify left as winner
    expect(winner).toBe("left");
    expect(scorecard.left_score).toBeGreaterThan(scorecard.right_score);

    // v2 fields should exist
    expect(scorecard.v2).toBeDefined();
    expect(scorecard.v2.left_posterior).toBeDefined();
    expect(scorecard.v2.right_posterior).toBeDefined();
    expect(scorecard.v2.overall_delta_ci95).toBeDefined();

    // CI should not contain zero for clear winner
    const [lower, upper] = scorecard.v2.overall_delta_ci95;
    expect(lower).toBeLessThan(0);
    expect(upper).toBeLessThan(0);

    // Left should have lower delta (negative is left wins)
    expect(scorecard.v2.overall_prob_right_superior).toBeLessThan(0.05);

    // CV should be stable for consistent scores
    const leftCv = scorecard.v2.enhanced_categories[0].left_cv;
    expect(leftCv.stability).toBe("stable");
  });

  it("should show undecided/equivalent verdict for near-identical scores", () => {
    const tasks = [
      createMockTask("task-1", "routing_accuracy"),
      createMockTask("task-2", "boundary_clarity")
    ];
    const pack = createMockPack();

    // Summaries: left and right are perfectly matched (high variance tests)
    // Use identical means but different variance to test stability
    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5], // Perfectly consistent
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5], // Also perfectly consistent
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id,
          task_version: 1,
          side_id: summary.side_id,
          trial_index: i,
          evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i],
          false_positive: 0,
          status: "valid"
        });
      }
    }

    const { scorecard } = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults,
      config: {
        ropeEpsilon: 5
      }
    });

    // With identical scores, CI should be extremely narrow around zero
    const [lower, upper] = scorecard.v2.overall_delta_ci95;
    const ciWidth = upper - lower;
    expect(ciWidth).toBeLessThan(0.0001); // Very narrow CI

    // ROPE verdict should indicate equivalence when scores are identical
    expect(["equivalent", "undecided"]).toContain(scorecard.v2.overall_rope_verdict);
  });

  it("should compute stable and unstable CV correctly", () => {
    const tasks = [
      createMockTask("task-1", "routing_accuracy"),
      createMockTask("task-2", "boundary_clarity")
    ];
    const pack = createMockPack();

    // Left has stable scores, right has unstable scores
    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.50, 0.50, 0.50, 0.50], // Perfect stability
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.1, 0.3, 0.7, 0.9, 0.5], // High variability
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.50, 0.50, 0.50, 0.50],
        false_positive_count: 0
      },
      {
        task_id: "task-2",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.1, 0.3, 0.7, 0.9, 0.5],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id,
          task_version: 1,
          side_id: summary.side_id,
          trial_index: i,
          evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i],
          false_positive: 0,
          status: "valid"
        });
      }
    }

    const { scorecard } = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults
    });

    const firstCategory = scorecard.v2.enhanced_categories[0];
    expect(firstCategory.left_cv.stability).toBe("stable");
    expect(firstCategory.right_cv.stability).toBe("unstable");
  });

  it("should produce right_wins ROPE verdict when right clearly leads", () => {
    const tasks = [createMockTask("task-1", "routing_accuracy")];
    const pack = createMockPack();

    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1", task_version: 1, side_id: "left",
        valid_trial_count: 5, failed_trial_count: 0,
        task_score: 0.2, trial_scores: [0.2, 0.21, 0.19, 0.2, 0.2],
        false_positive_count: 0
      },
      {
        task_id: "task-1", task_version: 1, side_id: "right",
        valid_trial_count: 5, failed_trial_count: 0,
        task_score: 0.9, trial_scores: [0.9, 0.91, 0.89, 0.9, 0.9],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id, task_version: 1, side_id: summary.side_id,
          trial_index: i, evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i], false_positive: 0, status: "valid"
        });
      }
    }

    const { scorecard } = computeEnhancedScorecard({
      tasks, benchmarkPack: pack, summaries, trialResults,
      config: { ropeEpsilon: 5, bootstrapResamples: 5000, bootstrapSeed: 42 }
    });

    expect(scorecard.v2.overall_rope_verdict).toBe("right_wins");
    expect(scorecard.v2.overall_prob_right_superior).toBeGreaterThan(0.95);
  });

  it("should produce left_wins ROPE verdict when left clearly leads", () => {
    const tasks = [createMockTask("task-1", "routing_accuracy")];
    const pack = createMockPack();

    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1", task_version: 1, side_id: "left",
        valid_trial_count: 5, failed_trial_count: 0,
        task_score: 0.95, trial_scores: [0.95, 0.94, 0.96, 0.95, 0.95],
        false_positive_count: 0
      },
      {
        task_id: "task-1", task_version: 1, side_id: "right",
        valid_trial_count: 5, failed_trial_count: 0,
        task_score: 0.15, trial_scores: [0.15, 0.14, 0.16, 0.15, 0.15],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id, task_version: 1, side_id: summary.side_id,
          trial_index: i, evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i], false_positive: 0, status: "valid"
        });
      }
    }

    const { scorecard } = computeEnhancedScorecard({
      tasks, benchmarkPack: pack, summaries, trialResults,
      config: { ropeEpsilon: 5, bootstrapResamples: 5000, bootstrapSeed: 42 }
    });

    expect(scorecard.v2.overall_rope_verdict).toBe("left_wins");
    expect(scorecard.v2.overall_prob_right_superior).toBeLessThan(0.05);
  });

  it("should handle single-trial edge case without crashing", () => {
    const tasks = [createMockTask("task-1", "routing_accuracy")];
    tasks[0].min_valid_trials = 1;
    const pack = createMockPack();

    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1", task_version: 1, side_id: "left",
        valid_trial_count: 1, failed_trial_count: 0,
        task_score: 0.8, trial_scores: [0.8],
        false_positive_count: 0
      },
      {
        task_id: "task-1", task_version: 1, side_id: "right",
        valid_trial_count: 1, failed_trial_count: 0,
        task_score: 0.3, trial_scores: [0.3],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [
      { task_id: "task-1", task_version: 1, side_id: "left", trial_index: 0, evaluator_kind: "deterministic", normalized_score: 0.8, false_positive: 0, status: "valid" },
      { task_id: "task-1", task_version: 1, side_id: "right", trial_index: 0, evaluator_kind: "deterministic", normalized_score: 0.3, false_positive: 0, status: "valid" }
    ];

    const { winner, scorecard } = computeEnhancedScorecard({
      tasks, benchmarkPack: pack, summaries, trialResults
    });

    expect(winner).toBeDefined();
    expect(scorecard.v2).toBeDefined();
    expect(scorecard.v2.overall_delta_ci95).toBeDefined();
  });

  it("should preserve v1 backward compatibility", () => {
    const tasks = [createMockTask("task-1", "routing_accuracy")];
    const pack = createMockPack();

    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.7,
        trial_scores: [0.7, 0.71, 0.69],
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.3,
        trial_scores: [0.3, 0.31, 0.29],
        false_positive_count: 0
      }
    ];

    const trialResults: TaskTrialResult[] = [];
    for (const summary of summaries) {
      for (let i = 0; i < summary.trial_scores.length; i++) {
        trialResults.push({
          task_id: summary.task_id,
          task_version: 1,
          side_id: summary.side_id,
          trial_index: i,
          evaluator_kind: "deterministic",
          normalized_score: summary.trial_scores[i],
          false_positive: 0,
          status: "valid"
        });
      }
    }

    const { scorecard } = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults
    });

    // v1 fields should exist and match structure
    expect(scorecard.left_score).toBeDefined();
    expect(scorecard.right_score).toBeDefined();
    expect(scorecard.delta).toBeDefined();
    expect(scorecard.confidence).toBeDefined();
    expect(scorecard.category_scores).toBeDefined();
    expect(scorecard.top_reasons).toBeDefined();
    expect(scorecard.regressions).toBeDefined();

    // v2 fields should be additional
    expect(scorecard.v2).toBeDefined();
  });
});
