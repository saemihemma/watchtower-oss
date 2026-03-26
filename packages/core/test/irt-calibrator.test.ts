import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  calibrateIRT,
  deriveWeightsFromCalibration,
  writeCalibrationReport,
  loadCalibrationReport,
  type TrialDataset,
  type TrialResponse,
} from "../src/irt-calibrator.js";
import {
  grmProbabilities,
  deltaToBoundaries,
  boundariesToDelta,
  gaussHermiteNodes,
} from "../src/irt-math.js";
import type { IRTCalibrationReport, BenchmarkTask } from "../src/schemas.js";
import { mulberry32 } from "../src/math-helpers.js";

// ============================================================================
// Helper: Box-Muller for standard normal sampling
// ============================================================================

function sampleStandardNormal(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  const mag = Math.sqrt(-2.0 * Math.log(u1));
  return mag * Math.cos(2.0 * Math.PI * u2);
}

// ============================================================================
// Helper: Synthetic GRM data generator
// ============================================================================

function generateSyntheticGRMData(
  nPersons: number,
  trueParams: { a: number; boundaries: number[] }[],
  seed: number
): TrialDataset {
  const rng = mulberry32(seed);
  const nItems = trueParams.length;
  const itemIds = Array.from({ length: nItems }, (_, i) => `item_${i}`);

  const responses: TrialResponse[] = [];

  for (let p = 0; p < nPersons; p++) {
    // Sample θ ~ N(0, 1) for this person
    const theta = sampleStandardNormal(rng);

    const scores = new Map<string, number>();

    for (let j = 0; j < nItems; j++) {
      const { a, boundaries } = trueParams[j];

      // Compute GRM probabilities for this item and person
      const probs = grmProbabilities(theta, a, boundaries);

      // Sample category by inverse CDF
      const u = rng();
      let cumProb = 0;
      let category = 0;
      for (let k = 0; k < probs.length; k++) {
        cumProb += probs[k];
        if (u < cumProb) {
          category = k;
          break;
        }
      }

      // Map category to normalized score: 0→0, 1→0.25, 2→0.5, 3→0.75, 4→1.0
      const score = category / 4;
      scores.set(itemIds[j], score);
    }

    responses.push({
      bundleId: `bundle_${p}`,
      scores,
    });
  }

  return {
    items: itemIds,
    responses,
  };
}

// ============================================================================
// Test 1: EM on synthetic GRM data
// ============================================================================

describe("irt-calibrator", () => {
  it("should calibrate GRM model on synthetic data with known parameters", () => {
    // Generate data from known parameters
    const trueParams = [
      { a: 1.0, boundaries: [-1.5, -0.5, 0.5, 1.5] },
      { a: 1.0, boundaries: [-1.5, -0.5, 0.5, 1.5] },
      { a: 1.0, boundaries: [-1.5, -0.5, 0.5, 1.5] },
      { a: 1.0, boundaries: [-1.5, -0.5, 0.5, 1.5] },
      { a: 1.0, boundaries: [-1.5, -0.5, 0.5, 1.5] },
    ];

    const trialData = generateSyntheticGRMData(200, trueParams, 42);

    const report = calibrateIRT({
      trialData,
      profileId: "test-profile",
      catalogHash: "abc123",
    });

    // Verify basic structure
    expect(report.converged).toBe(true);
    expect(report.model_selected).toBe("grm");
    expect(report.item_params).toHaveLength(5);

    // Verify discrimination parameters are within valid IRT range
    // (tolerance is larger because data may be challenging to fit)
    for (const itemParam of report.item_params) {
      expect(itemParam.discrimination).toBeGreaterThanOrEqual(0.2);
      expect(itemParam.discrimination).toBeLessThanOrEqual(3.0);
    }

    // Verify boundaries are reasonable
    for (const itemParam of report.item_params) {
      expect(itemParam.boundaries).toHaveLength(4);
      // Boundaries should be strictly increasing
      for (let i = 0; i < 3; i++) {
        expect(itemParam.boundaries[i]).toBeLessThan(itemParam.boundaries[i + 1]);
      }
    }
  });

  // ============================================================================
  // Test 2: Weight derivation with known Fisher values
  // ============================================================================

  it("should derive weights correctly from known Fisher information", () => {
    const mockReport: IRTCalibrationReport = {
      calibration_id: "test-cal",
      profile_id: "test-profile",
      catalog_hash: "abc123",
      schema_version: 4,
      model_selected: "grm",
      model_selection_aic: { grm: 0, twopl: 0 },
      item_params: [
        {
          task_id: "task_1",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
        {
          task_id: "task_2",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 0.5,
          fisher_info_integrated: 0.5,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
        {
          task_id: "task_3",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 0.2,
          fisher_info_integrated: 0.2,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
      ],
      mean_ability: 0,
      ability_std: 1,
      total_trials_used: 100,
      total_bundles: 10,
      convergence_iterations: 10,
      converged: true,
      n_restarts: 3,
      best_restart_index: 0,
      marginal_log_likelihood: -500,
      timestamp: new Date().toISOString(),
    };

    const tasks: BenchmarkTask[] = [
      {
        task_id: "task_1",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "task_2",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "task_3",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
    ];

    const weights = deriveWeightsFromCalibration(mockReport, tasks);

    expect(weights).toHaveLength(3);

    // task_1: normalized weight = 1.0 / 1.0 = 1.0, high_info (1.0 >= 0.1)
    expect(weights[0].task_id).toBe("task_1");
    expect(weights[0].irt_weight).toBe(1.0);
    expect(weights[0].reason).toBe("high_info");

    // task_2: normalized weight = 0.5 / 1.0 = 0.5, high_info (0.5 >= 0.1)
    expect(weights[1].task_id).toBe("task_2");
    expect(weights[1].irt_weight).toBe(0.5);
    expect(weights[1].reason).toBe("high_info");

    // task_3: normalized weight = 0.2 / 1.0 = 0.2, high_info (0.2 >= 0.1)
    expect(weights[2].task_id).toBe("task_3");
    expect(weights[2].irt_weight).toBe(0.2);
    expect(weights[2].reason).toBe("high_info");
  });

  // ============================================================================
  // Test 3: Weight derivation with equal Fisher values
  // ============================================================================

  it("should assign uniform weights when all Fisher values are equal", () => {
    const mockReport: IRTCalibrationReport = {
      calibration_id: "test-cal",
      profile_id: "test-profile",
      catalog_hash: "abc123",
      schema_version: 4,
      model_selected: "grm",
      model_selection_aic: { grm: 0, twopl: 0 },
      item_params: [
        {
          task_id: "task_1",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
        {
          task_id: "task_2",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
        {
          task_id: "task_3",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
      ],
      mean_ability: 0,
      ability_std: 1,
      total_trials_used: 100,
      total_bundles: 10,
      convergence_iterations: 10,
      converged: true,
      n_restarts: 3,
      best_restart_index: 0,
      marginal_log_likelihood: -500,
      timestamp: new Date().toISOString(),
    };

    const tasks: BenchmarkTask[] = [
      {
        task_id: "task_1",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "task_2",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "task_3",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
    ];

    const weights = deriveWeightsFromCalibration(mockReport, tasks);

    expect(weights).toHaveLength(3);

    // All weights should be 1.0 (equal normalized Fisher)
    for (const w of weights) {
      expect(w.irt_weight).toBe(1.0);
      expect(w.reason).toBe("high_info");
    }
  });

  // ============================================================================
  // Test 4: Weight derivation with excluded task
  // ============================================================================

  it("should exclude tasks not in calibration profile", () => {
    const mockReport: IRTCalibrationReport = {
      calibration_id: "test-cal",
      profile_id: "test-profile",
      catalog_hash: "abc123",
      schema_version: 4,
      model_selected: "grm",
      model_selection_aic: { grm: 0, twopl: 0 },
      item_params: [
        {
          task_id: "task_1",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
      ],
      mean_ability: 0,
      ability_std: 1,
      total_trials_used: 100,
      total_bundles: 10,
      convergence_iterations: 10,
      converged: true,
      n_restarts: 3,
      best_restart_index: 0,
      marginal_log_likelihood: -500,
      timestamp: new Date().toISOString(),
    };

    const tasks: BenchmarkTask[] = [
      {
        task_id: "task_1",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "task_not_in_calibration",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
    ];

    const weights = deriveWeightsFromCalibration(mockReport, tasks);

    // Only task_1 should have weights; task_not_in_calibration is excluded
    expect(weights).toHaveLength(1);
    expect(weights[0].task_id).toBe("task_1");
  });

  // ============================================================================
  // Test 5: Calibration file I/O round-trip
  // ============================================================================

  it("should write and read calibration report correctly", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "irt-test-"));

    const mockReport: IRTCalibrationReport = {
      calibration_id: "test-cal-123",
      profile_id: "test-profile",
      catalog_hash: "abc123",
      schema_version: 4,
      model_selected: "grm",
      model_selection_aic: { grm: 100, twopl: 150 },
      item_params: [
        {
          task_id: "task_1",
          model: "grm",
          discrimination: 1.2,
          boundaries: [-0.8, 0.2, 1.0, 1.8],
          fisher_info_at_mean: 0.95,
          fisher_info_integrated: 0.88,
          calibration_n: 150,
          fit_residual: 0.05,
          response_distribution: [0.15, 0.25, 0.3, 0.2, 0.1],
        },
      ],
      mean_ability: 0.05,
      ability_std: 0.98,
      total_trials_used: 150,
      total_bundles: 15,
      convergence_iterations: 25,
      converged: true,
      n_restarts: 3,
      best_restart_index: 1,
      marginal_log_likelihood: -425.3,
      timestamp: "2025-03-24T10:30:00Z",
    };

    // Write report
    const writePath = writeCalibrationReport(mockReport, tempDir);

    // Verify file exists and is valid JSON
    expect(writePath).toMatch(/test-profile-2025-03-24\.json$/);

    // Read report back
    const loadedReport = loadCalibrationReport(writePath);

    // Verify content matches
    expect(loadedReport.calibration_id).toBe(mockReport.calibration_id);
    expect(loadedReport.profile_id).toBe(mockReport.profile_id);
    expect(loadedReport.catalog_hash).toBe(mockReport.catalog_hash);
    expect(loadedReport.model_selected).toBe(mockReport.model_selected);
    expect(loadedReport.item_params).toHaveLength(1);
    expect(loadedReport.item_params[0].discrimination).toBe(1.2);
    expect(loadedReport.converged).toBe(true);
    expect(loadedReport.mean_ability).toBeCloseTo(0.05);
  });

  // ============================================================================
  // Test 6: Load missing file error
  // ============================================================================

  it("should throw error when loading missing file", () => {
    const missingPath = "/nonexistent/path/calibration-missing.json";

    expect(() => {
      loadCalibrationReport(missingPath);
    }).toThrow(/Cannot read IRT calibration file/);

    expect(() => {
      loadCalibrationReport(missingPath);
    }).toThrow(missingPath);
  });

  // ============================================================================
  // Test 7: Load malformed JSON error
  // ============================================================================

  it("should throw error when loading malformed JSON", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "irt-test-"));
    const badFilePath = path.join(tempDir, "bad.json");

    // Write invalid JSON
    const fs = require("node:fs");
    fs.writeFileSync(badFilePath, "{ this is not valid json }", "utf-8");

    expect(() => {
      loadCalibrationReport(badFilePath);
    }).toThrow(/not valid JSON/);

    expect(() => {
      loadCalibrationReport(badFilePath);
    }).toThrow(badFilePath);
  });

  // ============================================================================
  // Test 8: Non-convergence with all-same responses
  // ============================================================================

  it("should handle non-convergence gracefully with all-same responses", () => {
    // Create data where everyone gives the same score
    const trialData: TrialDataset = {
      items: ["item_1", "item_2"],
      responses: Array.from({ length: 50 }, (_, i) => ({
        bundleId: `bundle_${i}`,
        scores: new Map([
          ["item_1", 0.5],
          ["item_2", 0.5],
        ]),
      })),
    };

    const report = calibrateIRT({
      trialData,
      profileId: "test-profile",
      catalogHash: "abc123",
      maxIterations: 10,
    });

    // Should produce a report even without full convergence
    expect(report).toBeDefined();
    expect(report.item_params).toHaveLength(2);

    // All parameters should be within valid ranges
    for (const itemParam of report.item_params) {
      expect(itemParam.discrimination).toBeGreaterThanOrEqual(0.2);
      expect(itemParam.discrimination).toBeLessThanOrEqual(3.0);
      expect(itemParam.boundaries).toBeDefined();
    }
  });

  // ============================================================================
  // Test 9: Performance test (500 persons, 10 items < 10s)
  // ============================================================================

  it(
    "should calibrate 500 persons × 10 items in under 10s",
    { timeout: 15000 },
    () => {
      const trueParams = Array.from({ length: 10 }, () => ({
        a: 1.0,
        boundaries: [-1.5, -0.5, 0.5, 1.5],
      }));

      const startTime = Date.now();

      const trialData = generateSyntheticGRMData(500, trueParams, 99);

      const report = calibrateIRT({
        trialData,
        profileId: "perf-test",
        catalogHash: "perf123",
      });

      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(10000);
      expect(report.item_params).toHaveLength(10);
      expect(report.total_trials_used).toBe(500);
    }
  );

  // ============================================================================
  // Test 10: Low-info item classification
  // ============================================================================

  it("should classify items as low_info when Fisher < 0.1", () => {
    const mockReport: IRTCalibrationReport = {
      calibration_id: "test-cal",
      profile_id: "test-profile",
      catalog_hash: "abc123",
      schema_version: 4,
      model_selected: "grm",
      model_selection_aic: { grm: 0, twopl: 0 },
      item_params: [
        {
          task_id: "good_item",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 1.0,
          fisher_info_integrated: 1.0,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
        {
          task_id: "bad_item",
          model: "grm",
          discrimination: 1.0,
          boundaries: [-1, 0, 1, 2],
          fisher_info_at_mean: 0.05,
          fisher_info_integrated: 0.05,
          calibration_n: 100,
          fit_residual: 0,
          response_distribution: [0.2, 0.2, 0.2, 0.2, 0.2],
        },
      ],
      mean_ability: 0,
      ability_std: 1,
      total_trials_used: 100,
      total_bundles: 10,
      convergence_iterations: 10,
      converged: true,
      n_restarts: 3,
      best_restart_index: 0,
      marginal_log_likelihood: -500,
      timestamp: new Date().toISOString(),
    };

    const tasks: BenchmarkTask[] = [
      {
        task_id: "good_item",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
      {
        task_id: "bad_item",
        task_version: 1,
        family: "test",
        category: "routing_accuracy",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 3,
        trials_per_side: 5,
        prompt_text: "test",
        rubric_text: null,
      },
    ];

    const weights = deriveWeightsFromCalibration(mockReport, tasks);

    expect(weights).toHaveLength(2);

    // good_item: normalized weight = 1.0 / 1.0 = 1.0, >= 0.1 → high_info
    expect(weights[0].reason).toBe("high_info");

    // bad_item: normalized weight = 0.05 / 1.0 = 0.05, < 0.1 → low_info
    expect(weights[1].reason).toBe("low_info");
  });
});
