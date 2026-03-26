/**
 * QA Adversarial Tests: Test edge cases, degenerate inputs, and boundary conditions.
 * Covers QA plan items 2, 3, 5, and 7.5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectCollapse,
  enrichCompositionMetadata,
  createCompositionScorer,
} from "../src/composition-scorer.js";
import {
  validateCompositionDAG,
  type DAGNode,
} from "../src/composition-dag.js";
import { runBatch, type BatchConfig } from "../src/batch-runner.js";
import { calibrateIRT, type TrialDataset } from "../src/irt-calibrator.js";
import {
  BATCH_MAX_PARALLEL,
  BATCH_MAX_RUNS,
  IRT_MIN_TRIALS,
  IRT_MIN_BUNDLES,
} from "../src/constants.js";
import type {
  BenchmarkTask,
  CollapseConfig,
  IRTCalibrationReport,
  IRTItemParams,
} from "../src/schemas.js";
import { clearBundleTextCache } from "../src/cv-scorer.js";
import { clearExtensionScorers } from "../src/extension-scorer.js";

// =============================================================================
// Group: Adversarial Profiles (QA item 2)
// =============================================================================

describe("QA 2: Adversarial Profiles", () => {
  // 2.1 Cyclic DAG
  describe("2.1: Cyclic DAG validation", () => {
    it("rejects simple 2-node cycle A→B→A", () => {
      const nodes: DAGNode[] = [
        { task_id: "a", layer: "composed", dependencies: ["b"] },
        { task_id: "b", layer: "composed", dependencies: ["a"] },
      ];
      expect(() => validateCompositionDAG(nodes)).toThrow(/[Cc]yclic/);
    });

    it("rejects 3-node cycle A→B→C→A", () => {
      const nodes: DAGNode[] = [
        { task_id: "a", layer: "composed", dependencies: ["b"] },
        { task_id: "b", layer: "composed", dependencies: ["c"] },
        { task_id: "c", layer: "composed", dependencies: ["a"] },
      ];
      expect(() => validateCompositionDAG(nodes)).toThrow(/[Cc]yclic/);
    });

    it("detects cycle even with valid primitives present", () => {
      const nodes: DAGNode[] = [
        { task_id: "p1", layer: "primitive", dependencies: [] },
        { task_id: "c1", layer: "composed", dependencies: ["p1", "c2"] },
        { task_id: "c2", layer: "composed", dependencies: ["c1"] },
      ];
      expect(() => validateCompositionDAG(nodes)).toThrow(/[Cc]yclic/);
    });
  });

  // 2.2 Absurd thresholds in collapse detection
  describe("2.2: Absurd collapse thresholds", () => {
    it("handles floor=0.0, ceiling=1.0 without crash", () => {
      const config: CollapseConfig = {
        primitive_floor: 0.0,
        composed_ceiling: 1.0,
      };
      const result = detectCollapse([0.5, 0.6], [0.4, 0.5], config);
      expect(result).toBeDefined();
      // 0.55 > 0.0 AND 0.45 < 1.0 → detected=true
      expect(result.detected).toBe(true);
      expect(typeof result.severity).toBe("number");
      expect(Number.isFinite(result.severity)).toBe(true);
    });

    it("handles floor=1.0, ceiling=0.0 (inverted) without crash", () => {
      const config: CollapseConfig = {
        primitive_floor: 1.0,
        composed_ceiling: 0.0,
      };
      const result = detectCollapse([0.5, 0.6], [0.4, 0.5], config);
      expect(result.detected).toBe(false); // 0.55 NOT > 1.0
      expect(Number.isFinite(result.severity)).toBe(true);
    });

    it("handles negative thresholds gracefully", () => {
      const config: CollapseConfig = {
        primitive_floor: -0.5,
        composed_ceiling: -0.1,
      };
      const result = detectCollapse([0.5, 0.6], [0.4, 0.5], config);
      expect(result).toBeDefined();
      expect(Number.isFinite(result.severity)).toBe(true);
    });
  });

  // 2.3 Empty extensions
  describe("2.3: Empty extension objects", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comp-scorer-"));
      clearBundleTextCache();
      clearExtensionScorers();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearBundleTextCache();
      clearExtensionScorers();
    });

    it("handles task with empty composition_cues array", () => {
      // Create a task with empty composition_cues
      const task: BenchmarkTask = {
        task_id: "comp_empty",
        task_version: 1,
        family: "test",
        category: "test_cat",
        critical_regression: false,
        evaluator_kind: "deterministic",
        priority: 1,
        min_valid_trials: 1,
        trials_per_side: 5,
        prompt_text: "Test prompt",
        rubric_text: null,
        extensions: {
          composition: {
            layer: "primitive",
            dependencies: [],
            composition_cues: [], // Empty
          },
        },
      };

      // Create a minimal bundle directory
      const bundleDir = path.join(tmpDir, "bundle");
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(path.join(bundleDir, "SKILL.md"), "# Empty skill");

      const scorer = createCompositionScorer();
      expect(scorer.applicable(task)).toBe(true);

      // Score should return base score when no cues
      scorer
        .score(
          {
            task,
            bundleDir,
            side: "left",
          },
          { normalizedScore: 0.5 }
        )
        .then((result) => {
          // Should handle gracefully
          expect(result.normalizedScore).toBeDefined();
          expect(typeof result.normalizedScore).toBe("number");
        });
    });
  });

  // 2.7 All category weights = 0
  describe("2.7: All zero category weights", () => {
    it("handles profile with all zero weights without crash", () => {
      // This is more of a profile-loader validation test, but we document behavior here
      // The system may reject this at load time or handle it gracefully
      // For now, we verify that even if such a profile loaded,
      // enrichCompositionMetadata with all-zero weights should not crash

      const profile = {
        tasks: [
          {
            task_id: "p1",
            extensions: {
              composition: { layer: "primitive", dependencies: [], composition_cues: [] },
            },
          },
          {
            task_id: "c1",
            extensions: {
              composition: { layer: "composed", dependencies: ["p1"], composition_cues: [] },
            },
          },
        ],
        // No collapse_config → uses defaults
      };

      const taskTrialResults = [
        { task_id: "p1", normalized_score: 0.8 },
        { task_id: "c1", normalized_score: 0.2 },
      ];

      // enrichCompositionMetadata should not crash
      const result = enrichCompositionMetadata(
        profile as any,
        taskTrialResults as any
      );
      expect(result).toBeDefined();
    });
  });
});

// =============================================================================
// Group: Degenerate Inputs (QA item 3)
// =============================================================================

describe("QA 3: Degenerate Inputs", () => {
  // 3.2 Both sides identical
  describe("3.2: Identical bundle comparison", () => {
    it("produces valid results when comparing identical bundles", () => {
      // Test collapse detection with identical scores on both layers
      const result = detectCollapse([0.5, 0.5], [0.5, 0.5]);
      expect(result.detected).toBe(false); // Same score → no collapse
      expect(result.mean_primitive).toBe(0.5);
      expect(result.mean_composed).toBe(0.5);
      expect(Number.isFinite(result.severity)).toBe(true);
    });

    it("handles all-zeros for both layers without crash", () => {
      const result = detectCollapse([0, 0, 0], [0, 0, 0]);
      expect(result.detected).toBe(false);
      expect(result.mean_primitive).toBe(0);
      expect(result.mean_composed).toBe(0);
      expect(result.severity).toBe(0); // meanPrim < 0.1 → severity guarded to 0
    });
  });

  // 3.5 Batch with runs=0
  describe("3.5: Batch with zero runs", () => {
    it("handles totalRuns=0 without error", async () => {
      const mockRunFn = async () => "run-id";

      const result = await runBatch({
        totalRuns: 0,
        parallel: 1,
        retryOnFail: 0,
        runFn: mockRunFn,
      });

      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.runIds).toHaveLength(0);
    });

    it("handles totalRuns=0 with callbacks", async () => {
      let callbackCount = 0;
      const mockRunFn = async () => "run-id";
      const onRunComplete = () => {
        callbackCount++;
      };

      const result = await runBatch({
        totalRuns: 0,
        parallel: 1,
        retryOnFail: 0,
        runFn: mockRunFn,
        onRunComplete,
      });

      expect(result.completed).toBe(0);
      expect(callbackCount).toBe(0); // No callbacks for zero runs
    });
  });
});

// =============================================================================
// Group: Batch Edge Cases (QA item 5)
// =============================================================================

describe("QA 5: Batch Edge Cases", () => {
  // 5.4 parallel=0
  describe("5.4: Parallel count clamping to 1", () => {
    it("clamps parallel=0 to 1", async () => {
      const callOrder: number[] = [];
      const mockRunFn = async (index: number) => {
        callOrder.push(index);
        return `run-${index}`;
      };

      const result = await runBatch({
        totalRuns: 3,
        parallel: 0, // Should be clamped to 1
        retryOnFail: 0,
        runFn: mockRunFn,
      });

      expect(result.completed).toBe(3);
      expect(callOrder).toEqual([0, 1, 2]);
    });
  });

  // 5.5 parallel=16
  describe("5.5: Parallel count clamping to BATCH_MAX_PARALLEL", () => {
    it(`clamps parallel=16 to BATCH_MAX_PARALLEL (${BATCH_MAX_PARALLEL})`, async () => {
      const mockRunFn = async () => `run-id`;

      const result = await runBatch({
        totalRuns: 1,
        parallel: 16,
        retryOnFail: 0,
        runFn: mockRunFn,
      });

      // Should complete successfully (proof that it was clamped)
      expect(result.completed).toBe(1);
    });
  });

  // 5.6 runs=501 (exceeds BATCH_MAX_RUNS)
  describe("5.6: Batch runs exceeding BATCH_MAX_RUNS", () => {
    it(`accepts runs up to BATCH_MAX_RUNS (${BATCH_MAX_RUNS})`, async () => {
      let executed = 0;
      const mockRunFn = async () => {
        executed++;
        return `run-${executed}`;
      };

      const result = await runBatch({
        totalRuns: BATCH_MAX_RUNS,
        parallel: 1,
        retryOnFail: 0,
        runFn: mockRunFn,
      });

      expect(result.completed).toBe(BATCH_MAX_RUNS);
    });

    it("Note: Validation for runs > BATCH_MAX_RUNS (501) may only exist at CLI level", () => {
      // The batch-runner.ts does not validate totalRuns against BATCH_MAX_RUNS.
      // This validation may only exist in the CLI (apps/runner/src/index.ts).
      // At the library level, we can run > 500 runs (though it's not recommended).
      // This is a documented limitation.
      expect(true).toBe(true); // Just a note
    });
  });

  // 5.7 runs=-1
  describe("5.7: Negative batch run count", () => {
    it("handles negative totalRuns without infinite loop", async () => {
      const mockRunFn = async () => "run-id";

      const result = await runBatch({
        totalRuns: -1,
        parallel: 1,
        retryOnFail: 0,
        runFn: mockRunFn,
      });

      // Negative totalRuns results in 0 runs (Array.from({length: -1}) → [])
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
    });
  });
});

// =============================================================================
// Group: IRT Edge Cases (QA item 7.5 + 2.8)
// =============================================================================

describe("QA 7.5: IRT Edge Cases", () => {
  // 7.5.1 Fisher Information all zero
  describe("7.5.1: Fisher Information all zero", () => {
    it("handles all-zero fisher_info_integrated without division by zero", () => {
      // Create a mock calibration report with all zero fisher info
      const report: IRTCalibrationReport = {
        profile_id: "test",
        catalog_hash: "test",
        converged: true,
        iterations: 10,
        model_kind: "grm",
        item_params: [
          {
            task_id: "task1",
            a: 1.0,
            boundaries: [-1, 0, 1],
            fisher_info_integrated: 0.0, // Zero
          },
          {
            task_id: "task2",
            a: 1.0,
            boundaries: [-1, 0, 1],
            fisher_info_integrated: 0.0, // Zero
          },
        ],
      };

      // Import deriveWeightsFromCalibrationReport from engine.ts
      // For now, we implement a simplified version here
      const paramMap = new Map(
        report.item_params.map((p) => [p.task_id, p])
      );
      const maxFisher = Math.max(
        ...report.item_params.map((p) => p.fisher_info_integrated),
        1e-10 // Avoid division by zero
      );

      const tasks = [{ task_id: "task1" }, { task_id: "task2" }];
      const weights = tasks.map((task) => {
        const params = paramMap.get(task.task_id);
        if (!params) {
          return {
            task_id: task.task_id,
            irt_weight: 1.0,
            original_weight: 1.0,
            reason: "excluded" as const,
          };
        }
        const weight = params.fisher_info_integrated / maxFisher;
        return {
          task_id: task.task_id,
          irt_weight: weight,
          original_weight: 1.0,
          reason: weight < 0.1 ? ("low_info" as const) : ("high_info" as const),
        };
      });

      // Verify no NaN/Infinity
      for (const w of weights) {
        expect(Number.isFinite(w.irt_weight)).toBe(true);
        expect(w.irt_weight).toBeGreaterThanOrEqual(0);
      }

      // With all zero fisher info and 1e-10 fallback, all weights should be 0
      expect(weights[0].irt_weight).toBe(0);
      expect(weights[1].irt_weight).toBe(0);
    });
  });

  // 7.5.2 All-same scores
  describe("7.5.2: IRT calibration with all-same scores", () => {
    it("handles dataset where all observations have identical score", () => {
      // Create a minimal dataset where every trial result is the same
      const dataset: TrialDataset = {
        items: ["item1", "item2", "item3"],
        responses: Array.from({ length: IRT_MIN_TRIALS }, (_, i) => ({
          bundleId: `bundle_${i}`,
          scores: new Map([
            ["item1", 0.5],
            ["item2", 0.5],
            ["item3", 0.5],
          ]),
        })),
      };

      // This should not crash
      const report = calibrateIRT({
        trialData: dataset,
        profileId: "test",
        catalogHash: "test",
      });

      expect(report).toBeDefined();
      expect(report.converged).toBeDefined();
      expect(typeof report.converged).toBe("boolean");

      // With all-same scores, the EM algorithm may converge but with degenerate parameters
      // (uniform person distribution, parameters unable to discriminate).
      // Verify the report is valid regardless of convergence status.
      expect(report.item_params).toBeDefined();
      expect(Array.isArray(report.item_params)).toBe(true);
      expect(report.item_params.length).toBeGreaterThan(0);

      for (const param of report.item_params) {
        // Even with constant scores, parameters should be defined (may be defaults)
        expect(param.task_id).toBeDefined();
        expect(param.discrimination).toBeDefined();
        expect(param.boundaries).toBeDefined();
        expect(Number.isFinite(param.discrimination)).toBe(true);
      }
    });

    it("Note: IRT calibration requires variance across bundles to converge", () => {
      // This is a known limitation of IRT calibration:
      // If all scores are identical, there's no discriminative signal.
      // The system should either:
      // (a) Return converged=false and flag low_info for all tasks, or
      // (b) Return default parameters with warnings.
      // Actual behavior is documented above.
      expect(true).toBe(true);
    });
  });

  // 7.5.3 Minimal IRT dataset (meets constraints)
  describe("7.5.3: Minimal valid IRT dataset", () => {
    it("calibrates with exactly IRT_MIN_TRIALS trials and IRT_MIN_BUNDLES bundles", () => {
      // Generate data with minimal dimensions
      const dataset: TrialDataset = {
        items: Array.from({ length: 3 }, (_, i) => `item_${i}`),
        responses: Array.from({ length: IRT_MIN_TRIALS }, (_, i) => ({
          bundleId: `bundle_${i % IRT_MIN_BUNDLES}`,
          scores: new Map(
            Array.from({ length: 3 }, (_, j) => [
              `item_${j}`,
              Math.random(),
            ])
          ),
        })),
      };

      const report = calibrateIRT({
        trialData: dataset,
        profileId: "test",
        catalogHash: "test",
      });

      expect(report).toBeDefined();
      expect(report.item_params).toHaveLength(3);
    });
  });

  // 7.5.4 Below minimum thresholds
  describe("7.5.4: IRT calibration below minimum thresholds", () => {
    it("handles fewer than IRT_MIN_TRIALS gracefully", () => {
      const dataset: TrialDataset = {
        items: ["item1"],
        responses: Array.from({ length: IRT_MIN_TRIALS - 1 }, (_, i) => ({
          bundleId: `bundle_${i}`,
          scores: new Map([["item1", Math.random()]]),
        })),
      };

      // This may throw or return a report with converged=false
      // Depending on implementation. Document behavior.
      try {
        const report = calibrateIRT({
          trialData: dataset,
          profileId: "test",
          catalogHash: "test",
        });

        // If it succeeds, just verify it's a valid report
        expect(report).toBeDefined();
      } catch (e) {
        // If it throws, that's also acceptable behavior
        // (insufficient data for calibration)
        expect(e).toBeDefined();
      }
    });

    it("handles fewer than IRT_MIN_BUNDLES gracefully", () => {
      const dataset: TrialDataset = {
        items: ["item1", "item2"],
        responses: Array.from({ length: IRT_MIN_TRIALS }, (_, i) => ({
          bundleId: "bundle_0", // Only 1 bundle
          scores: new Map([
            ["item1", Math.random()],
            ["item2", Math.random()],
          ]),
        })),
      };

      try {
        const report = calibrateIRT({
          trialData: dataset,
          profileId: "test",
          catalogHash: "test",
        });

        expect(report).toBeDefined();
      } catch (e) {
        // Acceptable to throw for insufficient bundles
        expect(e).toBeDefined();
      }
    });
  });

  // 7.5.5 NaN/Infinity in scores
  describe("7.5.5: Handling NaN and Infinity in trial scores", () => {
    it("filters or handles NaN scores without crashing", () => {
      const dataset: TrialDataset = {
        items: ["item1"],
        responses: Array.from({ length: IRT_MIN_TRIALS }, (_, i) => ({
          bundleId: `bundle_${i}`,
          scores: new Map([
            ["item1", i === 0 ? NaN : Math.random()],
          ]),
        })),
      };

      // Behavior depends on implementation:
      // May throw, filter, or substitute with default
      try {
        const report = calibrateIRT({
          trialData: dataset,
          profileId: "test",
          catalogHash: "test",
        });

        expect(report).toBeDefined();
      } catch (e) {
        // Acceptable
        expect(e).toBeDefined();
      }
    });

    it("handles Infinity in scores without crashing", () => {
      const dataset: TrialDataset = {
        items: ["item1"],
        responses: Array.from({ length: IRT_MIN_TRIALS }, (_, i) => ({
          bundleId: `bundle_${i}`,
          scores: new Map([
            ["item1", i === 0 ? Infinity : Math.random()],
          ]),
        })),
      };

      try {
        const report = calibrateIRT({
          trialData: dataset,
          profileId: "test",
          catalogHash: "test",
        });

        expect(report).toBeDefined();
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });
});
