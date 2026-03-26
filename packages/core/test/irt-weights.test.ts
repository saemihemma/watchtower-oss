import { describe, it, expect } from "vitest";
import {
  applyIRTWeights,
  computeEnhancedScorecard
} from "../src/stats-verdict.js";
import type {
  BenchmarkTask,
  BenchmarkPack,
  TaskSideSummary,
  TaskTrialResult,
  IRTWeightOverride
} from "../src/schemas.js";

describe("IRT Weights", () => {
  const createMockTask = (
    id: string,
    category: string = "routing_accuracy"
  ): BenchmarkTask => {
    return {
      task_id: id,
      task_version: 1,
      family: "test",
      category,
      critical_regression: false,
      evaluator_kind: "deterministic",
      priority: 1,
      min_valid_trials: 3,
      trials_per_side: 5,
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

  it("should produce identical scorecard when all IRT weights are 1.0", async () => {
    const tasks = [
      createMockTask("task-1", "routing_accuracy"),
      createMockTask("task-2", "boundary_clarity")
    ];
    const pack = createMockPack();

    // Create summaries: simple identical scores for both sides
    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
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

    // Compute without IRT weights
    const resultNoWeights = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults
    });

    // Compute with all weights = 1.0 (should be identical)
    const irtWeights: IRTWeightOverride[] = [
      {
        task_id: "task-1",
        irt_weight: 1.0,
        original_weight: 1.0,
        reason: "high_info"
      },
      {
        task_id: "task-2",
        irt_weight: 1.0,
        original_weight: 1.0,
        reason: "high_info"
      }
    ];

    const resultWithWeights = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults,
      irtWeights
    });

    // Scores should be identical
    expect(resultWithWeights.scorecard.left_score).toBe(
      resultNoWeights.scorecard.left_score
    );
    expect(resultWithWeights.scorecard.right_score).toBe(
      resultNoWeights.scorecard.right_score
    );
  });

  it("should reduce category A weight when its tasks have IRT weight 0.5 vs 1.0", async () => {
    const tasks = [
      createMockTask("catA-1", "routing_accuracy"),
      createMockTask("catB-1", "boundary_clarity")
    ];
    const pack: BenchmarkPack = {
      pack_id: "test-pack",
      source: "built_in_pack",
      task_ids: ["catA-1", "catB-1"],
      category_weights: {
        routing_accuracy: 1.0,
        boundary_clarity: 1.0,
        review_quality: 0,
        handoff_quality: 0
      },
      critical_task_ids: [],
      catalog_hash: "mock"
    };

    // Create identical summaries for both tasks
    const summaries: TaskSideSummary[] = [
      {
        task_id: "catA-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.7,
        trial_scores: [0.7, 0.7, 0.7, 0.7, 0.7],
        false_positive_count: 0
      },
      {
        task_id: "catA-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.3,
        trial_scores: [0.3, 0.3, 0.3, 0.3, 0.3],
        false_positive_count: 0
      },
      {
        task_id: "catB-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.7,
        trial_scores: [0.7, 0.7, 0.7, 0.7, 0.7],
        false_positive_count: 0
      },
      {
        task_id: "catB-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.3,
        trial_scores: [0.3, 0.3, 0.3, 0.3, 0.3],
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

    // Apply IRT weights: catA tasks at 0.5, catB at 1.0
    const irtWeights: IRTWeightOverride[] = [
      {
        task_id: "catA-1",
        irt_weight: 0.5,
        original_weight: 1.0,
        reason: "low_info"
      },
      {
        task_id: "catB-1",
        irt_weight: 1.0,
        original_weight: 1.0,
        reason: "high_info"
      }
    ];

    const result = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults,
      irtWeights
    });

    // Category weights should reflect IRT adjustments
    const catA = result.scorecard.category_scores.find(
      c => c.category === "routing_accuracy"
    );
    const catB = result.scorecard.category_scores.find(
      c => c.category === "boundary_clarity"
    );

    expect(catA).toBeDefined();
    expect(catB).toBeDefined();
    // catA weight should be 1.0 * 0.5 = 0.5
    expect(catA!.weight).toBeCloseTo(0.5, 5);
    // catB weight should be 1.0 * 1.0 = 1.0
    expect(catB!.weight).toBeCloseTo(1.0, 5);
  });

  it("should default missing tasks to IRT weight 1.0 without error", async () => {
    const tasks = [
      createMockTask("task-1", "routing_accuracy"),
      createMockTask("task-2", "boundary_clarity")
    ];
    const pack = createMockPack();

    const summaries: TaskSideSummary[] = [
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
        false_positive_count: 0
      },
      {
        task_id: "task-1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.5,
        trial_scores: [0.5, 0.5, 0.5, 0.5, 0.5],
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

    // Provide weights for only task-1, omit task-2
    const irtWeights: IRTWeightOverride[] = [
      {
        task_id: "task-1",
        irt_weight: 0.8,
        original_weight: 1.0,
        reason: "high_info"
      }
      // task-2 is intentionally omitted
    ];

    // Should not throw and should use 1.0 for task-2
    const result = computeEnhancedScorecard({
      tasks,
      benchmarkPack: pack,
      summaries,
      trialResults,
      irtWeights
    });

    expect(result.scorecard).toBeDefined();
    expect(result.scorecard.category_scores).toBeDefined();
  });
});
