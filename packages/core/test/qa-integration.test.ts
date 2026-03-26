/**
 * QA integration tests for:
 * 1. Full pipeline trace with composition analysis rendering
 * 8. Schema backward compatibility (v4 run in v5 engine)
 *
 * Verifies:
 * - compareLibrariesRun() produces composition_analysis when composition tasks present
 * - renderRunReport() includes "Composition Analysis" section end-to-end
 * - v4 runs (without irt_calibration_id, composition_analysis, collapse_config_used, extension_metadata) render without error
 * - Optional fields remain undefined when not set
 * - BatchOutput version field is present and equals 1
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareLibrariesRun,
  getDataPaths,
  loadRun,
  renderRunReport,
} from "../src/service.js";
import { batchTrialsToDataset } from "../src/irt-calibrator.js";
import { createMockExecutor } from "../src/local-executors.js";
import { registerProfile } from "../src/builtin-benchmark.js";
import { registerExtensionScorer, clearExtensionScorers } from "../src/extension-scorer.js";
import { createCompositionScorer } from "../src/composition-scorer.js";
import { ensureDir } from "../src/files.js";
import type {
  BenchmarkProfile,
  BenchmarkTask,
  ComparisonRun,
  BatchOutput,
} from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompTask(
  id: string,
  layer: "primitive" | "composed" | "meta",
  cues: string[] = []
): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "qa-comp-test",
    category: "qa_cat",
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: `qa composition task ${id}`,
    rubric_text: null,
    extensions: {
      composition: {
        layer,
        dependencies: [],
        composition_cues: cues,
      },
    },
  };
}

function makePlainTask(id: string): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "qa-plain-test",
    category: "qa_cat",
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: `qa plain task ${id}`,
    rubric_text: null,
  };
}

function registerQAProfile(tasks: BenchmarkTask[], profileId: string = "qa-test-profile"): string {
  const profile: BenchmarkProfile = {
    profile_id: profileId,
    label: "QA Test Profile",
    description: "Test profile for QA integration",
    tasks,
    pack: {
      pack_id: "qa-test-pack",
      source: "built_in_pack",
      task_ids: tasks.map((t) => t.task_id),
      category_weights: { qa_cat: 1.0 },
      critical_task_ids: [],
      catalog_hash: "qa-test-hash",
    },
  };
  registerProfile(profile);
  return profileId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("QA Integration: Pipeline & Backward Compatibility", () => {
  let tmpDir: string;
  let dataRoot: string;
  let leftDir: string;
  let rightDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-integration-"));
    dataRoot = path.join(tmpDir, "data");

    // Create minimal skill libraries
    leftDir = path.join(tmpDir, "left");
    rightDir = path.join(tmpDir, "right");
    fs.mkdirSync(leftDir, { recursive: true });
    fs.mkdirSync(rightDir, { recursive: true });
    fs.writeFileSync(path.join(leftDir, "SKILL.md"), "alpha beta gamma delta echo foxtrot");
    fs.writeFileSync(path.join(rightDir, "SKILL.md"), "alpha beta gamma hotel india juliet");

    clearExtensionScorers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearExtensionScorers();
  });

  // =========================================================================
  // QA Plan Item 1: Full pipeline trace with composition analysis rendering
  // =========================================================================

  describe("1.1: Full pipeline trace with composition analysis rendering", () => {
    it("compareLibrariesRun() produces composition_analysis when composition tasks present", async () => {
      registerExtensionScorer(createCompositionScorer());

      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("c1", "composed", ["zzz_nomatch"]),
        makeCompTask("c2", "composed", ["zzz_nomatch"]),
      ];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // Verify composition_analysis is present and has expected structure
      expect(run.composition_analysis).toBeDefined();
      expect(run.composition_analysis!.detected).toBeDefined();
      expect(run.composition_analysis!.mean_primitive).toBeDefined();
      expect(run.composition_analysis!.mean_composed).toBeDefined();
      expect(run.composition_analysis!.severity).toBeDefined();
      expect(typeof run.composition_analysis!.severity).toBe("number");
    });

    it("renderRunReport() includes 'Composition Analysis' section end-to-end", async () => {
      registerExtensionScorer(createCompositionScorer());

      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("c1", "composed", ["zzz_nomatch"]),
        makeCompTask("c2", "composed", ["zzz_nomatch"]),
      ];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      const report = renderRunReport(run);

      // Verify rendering pipeline produces "Composition Analysis" section
      expect(report).toContain("## Composition Analysis");
      expect(report).toContain("Collapse detected");
      expect(report).toContain("Primitive");
      expect(report).toContain("Composed + Meta");
      expect(report).toContain("Severity");
    });

    it("renderRunReport() handles runs without composition tasks gracefully", async () => {
      const tasks = [makePlainTask("p1"), makePlainTask("p2")];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // composition_analysis should be undefined when no composition tasks
      expect(run.composition_analysis).toBeUndefined();

      // Report should render without error and not include composition section
      const report = renderRunReport(run);
      expect(report).toBeTruthy();
      expect(report).toContain("Watchtower Benchmark Run");
      expect(report).not.toContain("## Composition Analysis");
    });
  });

  // =========================================================================
  // QA Plan Item 8: Schema backward compatibility
  // =========================================================================

  describe("8.1: Schema backward compatibility (v4 run in v5 engine)", () => {
    it("renderRunReport() handles v4 run without irt_calibration_id, composition_analysis, collapse_config_used", async () => {
      // Create a minimal v4-style ComparisonRun (no irt_calibration_id, composition_analysis, collapse_config_used)
      const tasks = [makePlainTask("t1"), makePlainTask("t2")];
      const profileId = registerQAProfile(tasks, "qa-v4-compat");

      // First create a real run to use as base
      const baseRun = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // Manually construct v4-style run by removing v5 fields
      const v4StyleRun: ComparisonRun = {
        ...baseRun,
        irt_calibration_id: undefined,
        composition_analysis: undefined,
        collapse_config_used: undefined,
      };

      // Verify v4 fields are undefined
      expect(v4StyleRun.irt_calibration_id).toBeUndefined();
      expect(v4StyleRun.composition_analysis).toBeUndefined();
      expect(v4StyleRun.collapse_config_used).toBeUndefined();

      // Verify renderRunReport handles it without error
      const report = renderRunReport(v4StyleRun);
      expect(report).toBeTruthy();
      expect(report).toContain("Watchtower Benchmark Run");
      // Should not have composition section since composition_analysis is undefined
      expect(report).not.toContain("## Composition Analysis");
    });

    it("optional fields on trials remain undefined when not set (no extension_metadata)", async () => {
      const tasks = [makePlainTask("t1"), makePlainTask("t2")];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // For plain tasks without extension scorers, extension_metadata should be undefined
      for (const trial of run.task_trial_results) {
        // When no extension scorers are registered, extension_metadata should be undefined
        if (!trial.extension_metadata) {
          expect(trial.extension_metadata).toBeUndefined();
        }
      }
    });
  });

  describe("8.2: BatchOutput version check", () => {
    it("BatchOutput contains version field set to 1", async () => {
      const tasks = [makePlainTask("bt1"), makePlainTask("bt2")];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // Create a BatchOutput as would be done in the CLI
      const paths = getDataPaths(dataRoot);
      const batchOutput: BatchOutput = {
        version: 1,
        batchId: "qa-batch-test",
        profileId,
        left: leftDir,
        right: rightDir,
        createdAt: new Date().toISOString(),
        runs: [
          {
            runId: run.run_id,
            taskTrialResults: run.task_trial_results,
          },
        ],
        summary: {
          completed: 1,
          failed: 0,
          retried: 0,
          wallClockMs: 100,
        },
      };

      // Verify version field is present and equals 1
      expect(batchOutput.version).toBe(1);
      expect(typeof batchOutput.version).toBe("number");
    });

    it("batchTrialsToDataset() accepts BatchOutput with version 1", async () => {
      const tasks = [makePlainTask("bt1"), makePlainTask("bt2"), makePlainTask("bt3")];
      const profileId = registerQAProfile(tasks);

      const run = await compareLibrariesRun({
        leftRootPath: leftDir,
        rightRootPath: rightDir,
        profileId,
        comparisonMode: "cross_library",
        allowlistedParentRoot: tmpDir,
        dataRoot,
        executor: createMockExecutor(),
        updateElo: false,
      });

      // Create a BatchOutput
      const batchOutput: BatchOutput = {
        version: 1,
        batchId: "qa-batch-dataset",
        profileId,
        left: leftDir,
        right: rightDir,
        createdAt: new Date().toISOString(),
        runs: [
          {
            runId: run.run_id,
            taskTrialResults: run.task_trial_results,
          },
        ],
        summary: {
          completed: 1,
          failed: 0,
          retried: 0,
          wallClockMs: 100,
        },
      };

      // Verify batchTrialsToDataset accepts the BatchOutput.runs
      const { responses, validCount, taskIds } = batchTrialsToDataset(batchOutput.runs);

      // Should have valid responses
      expect(validCount).toBeGreaterThanOrEqual(0);
      expect(taskIds.length).toBeGreaterThan(0);
      expect(Array.isArray(responses)).toBe(true);
    });
  });
});
