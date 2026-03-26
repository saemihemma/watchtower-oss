import { describe, it, expect } from "vitest";
import {
  type BenchmarkTask,
  type BenchmarkPack,
  type TaskSideSummary,
  type TaskTrialResult,
  type Executor
} from "../src/schemas.js";
import { computeEnhancedScorecard } from "../src/stats-verdict.js";

describe("Full Simulation: Good vs Bad Skill", () => {
  /**
   * Mock executor that returns high scores for good-skill, low for bad-skill.
   * Simulates realistic benchmark results.
   */
  const createMockExecutor = (skillPath: string): Executor => {
    return {
      async executeTask(task, skillPath) {
        // Good skill scores: high and stable
        if (skillPath.includes("good-skill")) {
          // routing_accuracy: 0.8-0.85
          if (task.category === "routing_accuracy") {
            return {
              normalized_score: 0.8 + Math.random() * 0.05,
              false_positive: 0
            };
          }
          // boundary_clarity: 0.75-0.80
          if (task.category === "boundary_clarity") {
            return {
              normalized_score: 0.75 + Math.random() * 0.05,
              false_positive: 0
            };
          }
          // review_quality: 0.78-0.83
          if (task.category === "review_quality") {
            return {
              normalized_score: 0.78 + Math.random() * 0.05,
              false_positive: 0
            };
          }
          // handoff_quality: 0.82-0.87
          if (task.category === "handoff_quality") {
            return {
              normalized_score: 0.82 + Math.random() * 0.05,
              false_positive: 0
            };
          }
        }

        // Bad skill scores: low and somewhat variable
        // routing_accuracy: 0.2-0.3
        if (task.category === "routing_accuracy") {
          return {
            normalized_score: 0.2 + Math.random() * 0.1,
            false_positive: Math.random() > 0.8 ? 1 : 0
          };
        }
        // boundary_clarity: 0.15-0.25
        if (task.category === "boundary_clarity") {
          return {
            normalized_score: 0.15 + Math.random() * 0.1,
            false_positive: Math.random() > 0.8 ? 1 : 0
          };
        }
        // review_quality: 0.18-0.28
        if (task.category === "review_quality") {
          return {
            normalized_score: 0.18 + Math.random() * 0.1,
            false_positive: Math.random() > 0.8 ? 1 : 0
          };
        }
        // handoff_quality: 0.1-0.2
        if (task.category === "handoff_quality") {
          return {
            normalized_score: 0.1 + Math.random() * 0.1,
            false_positive: Math.random() > 0.8 ? 1 : 0
          };
        }

        return { normalized_score: 0.5, false_positive: 0 };
      }
    };
  };

  it("should identify good skill as clear winner over bad skill", () => {
    // Create tasks across all categories
    const tasks: BenchmarkTask[] = [
      {
        task_id: "routing-1",
        task_version: 1,
        family: "routing",
        category: "routing_accuracy",
        critical_regression: true,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Route this request appropriately",
        rubric_text: null
      },
      {
        task_id: "routing-2",
        task_version: 1,
        family: "routing",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Route this complex request",
        rubric_text: null
      },
      {
        task_id: "boundary-1",
        task_version: 1,
        family: "boundary",
        category: "boundary_clarity",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Explain your boundaries",
        rubric_text: null
      },
      {
        task_id: "review-1",
        task_version: 1,
        family: "review",
        category: "review_quality",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Review this work",
        rubric_text: null
      },
      {
        task_id: "handoff-1",
        task_version: 1,
        family: "handoff",
        category: "handoff_quality",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Demonstrate a handoff",
        rubric_text: null
      }
    ];

    const pack: BenchmarkPack = {
      pack_id: "test-pack",
      source: "built_in_pack",
      task_ids: ["routing-1", "routing-2", "boundary-1", "review-1", "handoff-1"],
      category_weights: {
        routing_accuracy: 0.25,
        boundary_clarity: 0.25,
        review_quality: 0.25,
        handoff_quality: 0.25
      },
      critical_task_ids: ["routing-1"],
      catalog_hash: "mock"
    };

    // Simulate 5 trials per task per side
    const summaries: TaskSideSummary[] = [];
    const trialResults: TaskTrialResult[] = [];

    for (const task of tasks) {
      // Good skill (left)
      const leftScores: number[] = [];
      for (let trial = 0; trial < 5; trial++) {
        let score = 0;
        if (task.category === "routing_accuracy") {
          score = 0.8 + Math.random() * 0.05;
        } else if (task.category === "boundary_clarity") {
          score = 0.75 + Math.random() * 0.05;
        } else if (task.category === "review_quality") {
          score = 0.78 + Math.random() * 0.05;
        } else if (task.category === "handoff_quality") {
          score = 0.82 + Math.random() * 0.05;
        }
        leftScores.push(score);
        trialResults.push({
          task_id: task.task_id,
          task_version: 1,
          side_id: "left",
          trial_index: trial,
          evaluator_kind: "deterministic",
          normalized_score: score,
          false_positive: 0,
          status: "valid"
        });
      }

      summaries.push({
        task_id: task.task_id,
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: leftScores.reduce((a, b) => a + b) / leftScores.length,
        trial_scores: leftScores,
        false_positive_count: 0
      });

      // Bad skill (right)
      const rightScores: number[] = [];
      for (let trial = 0; trial < 5; trial++) {
        let score = 0;
        if (task.category === "routing_accuracy") {
          score = 0.25 + Math.random() * 0.1;
        } else if (task.category === "boundary_clarity") {
          score = 0.2 + Math.random() * 0.1;
        } else if (task.category === "review_quality") {
          score = 0.23 + Math.random() * 0.1;
        } else if (task.category === "handoff_quality") {
          score = 0.15 + Math.random() * 0.1;
        }
        rightScores.push(score);
        trialResults.push({
          task_id: task.task_id,
          task_version: 1,
          side_id: "right",
          trial_index: trial,
          evaluator_kind: "deterministic",
          normalized_score: score,
          false_positive: Math.random() > 0.8 ? 1 : 0,
          status: "valid"
        });
      }

      summaries.push({
        task_id: task.task_id,
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: rightScores.reduce((a, b) => a + b) / rightScores.length,
        trial_scores: rightScores,
        false_positive_count: rightScores.filter((s) => Math.random() > 0.8).length
      });
    }

    // Compute enhanced scorecard
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

    // Good skill should win
    expect(winner).toBe("left");
    expect(scorecard.left_score).toBeGreaterThan(scorecard.right_score);

    // Confidence should be high (clear difference)
    expect(scorecard.confidence).toBe("high");

    // Delta should be large (well above 5 point threshold, but negative since left wins)
    expect(scorecard.delta).toBeLessThan(-40);

    // v2 CI should not contain zero (clear winner)
    const [lower, upper] = scorecard.v2.overall_delta_ci95;
    expect(lower).toBeLessThan(0); // Left is better, so delta is negative
    expect(upper).toBeLessThan(0);

    // Probability that right is superior should be very low
    expect(scorecard.v2.overall_prob_right_superior).toBeLessThan(0.01);

    // ROPE verdict should indicate clear left win
    expect(scorecard.v2.overall_rope_verdict).toBe("left_wins");

    // Good skill should have stable scores (low CV)
    for (const category of scorecard.v2.enhanced_categories) {
      expect(category.left_cv.stability).toBe("stable");
    }

    // There should be no regressions on critical tasks
    expect(scorecard.regressions).toHaveLength(0);

    // Top reasons should explain the victory
    expect(scorecard.top_reasons.length).toBeGreaterThan(0);
  });

  it("should produce stable and consistent results across categories", () => {
    const tasks: BenchmarkTask[] = [
      {
        task_id: "cat1",
        task_version: 1,
        family: "family",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        prompt_text: "Test",
        rubric_text: null
      }
    ];

    const pack: BenchmarkPack = {
      pack_id: "test-pack",
      source: "built_in_pack",
      task_ids: ["cat1"],
      category_weights: {
        routing_accuracy: 1.0,
        boundary_clarity: 0,
        review_quality: 0,
        handoff_quality: 0
      },
      critical_task_ids: [],
      catalog_hash: "mock"
    };

    const summaries: TaskSideSummary[] = [
      {
        task_id: "cat1",
        task_version: 1,
        side_id: "left",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.8,
        trial_scores: [0.8, 0.81, 0.79, 0.80, 0.81],
        false_positive_count: 0
      },
      {
        task_id: "cat1",
        task_version: 1,
        side_id: "right",
        valid_trial_count: 5,
        failed_trial_count: 0,
        task_score: 0.3,
        trial_scores: [0.3, 0.31, 0.29, 0.30, 0.31],
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

    // Verify enhanced categories exist (all 4 categories are included, even with 0 weight)
    expect(scorecard.v2.enhanced_categories.length).toBeGreaterThan(0);

    const category = scorecard.v2.enhanced_categories.find((c) => c.category === "routing_accuracy")!;

    // Verify Bayesian posteriors
    expect(category.left_posterior.mean).toBeGreaterThan(0.75);
    expect(category.right_posterior.mean).toBeLessThan(0.35);

    // Verify CV is computed
    expect(category.left_cv.cv).toBeDefined();
    expect(category.right_cv.cv).toBeDefined();

    // Verify bootstrap CI
    expect(category.delta_ci95).toHaveLength(2);
    expect(category.delta_ci95[0]).toBeLessThan(category.delta_ci95[1]);

    // Verify ROPE verdict exists
    expect(["left_wins", "right_wins", "equivalent", "undecided"]).toContain(
      category.rope_verdict
    );

    // Verify prob_right_superior
    expect(category.prob_right_superior).toBeGreaterThanOrEqual(0);
    expect(category.prob_right_superior).toBeLessThanOrEqual(1);
  });
});
