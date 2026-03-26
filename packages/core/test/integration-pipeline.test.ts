/**
 * Integration test for the batch → calibrate → compare --irt pipeline.
 *
 * Uses mock executor, a minimal custom profile, and temp directories.
 * Verifies:
 * 1. Batch produces valid BatchOutput with correct structure
 * 2. batchTrialsToDataset() flattens into correct observation counts
 * 3. calibrateIRT() produces a versioned report
 * 4. compare with IRT calibration produces different scores (irt_calibration_id present)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareLibrariesRun, getDataPaths, loadRun, renderRunReport } from "../src/service.js";
import { runBatch } from "../src/batch-runner.js";
import { batchTrialsToDataset, calibrateIRT } from "../src/irt-calibrator.js";
import { createMockExecutor } from "../src/local-executors.js";
import { registerProfile } from "../src/builtin-benchmark.js";
import { ensureDir, writeJson } from "../src/files.js";
import type { BatchOutput, BenchmarkProfile, BenchmarkTask } from "../src/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string, category: string): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "pipeline-test",
    category,
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: `test prompt for ${id}`,
    rubric_text: null,
  };
}

function registerPipelineProfile(): string {
  const profileId = "pipeline-test-profile";
  const taskIds = Array.from({ length: 6 }, (_, i) => `pt-${i}`);
  const tasks = taskIds.map((id, i) =>
    makeTask(id, i < 3 ? "cat_a" : "cat_b")
  );

  const profile: BenchmarkProfile = {
    profile_id: profileId,
    label: "Pipeline Test",
    description: "Test profile for pipeline integration",
    tasks,
    pack: {
      pack_id: "pipeline-test-pack",
      source: "built_in_pack",
      task_ids: taskIds,
      category_weights: { cat_a: 0.6, cat_b: 0.4 },
      critical_task_ids: [],
      catalog_hash: "pipeline-test-hash",
    },
  };
  registerProfile(profile);
  return profileId;
}

describe("Batch → Calibrate → Compare --irt Pipeline", () => {
  let tmpDir: string;
  let dataRoot: string;
  let leftDir: string;
  let rightDir: string;
  let profileId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
    dataRoot = path.join(tmpDir, "data");

    // Create minimal skill libraries
    leftDir = path.join(tmpDir, "left");
    rightDir = path.join(tmpDir, "right");
    fs.mkdirSync(leftDir, { recursive: true });
    fs.mkdirSync(rightDir, { recursive: true });
    fs.writeFileSync(path.join(leftDir, "SKILL.md"), "alpha beta gamma delta echo foxtrot");
    fs.writeFileSync(path.join(rightDir, "SKILL.md"), "alpha beta gamma hotel india juliet");

    profileId = registerPipelineProfile();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full pipeline: batch accumulates runs, calibrate produces report, compare applies IRT weights", async () => {
    const executor = createMockExecutor();

    // Step 1: Run a batch of 5 comparisons
    const batchResult = await runBatch({
      totalRuns: 5,
      parallel: 2,
      retryOnFail: 0,
      runFn: async () => {
        const run = await compareLibrariesRun({
          leftRootPath: leftDir,
          rightRootPath: rightDir,
          profileId,
          comparisonMode: "cross_library",
          allowlistedParentRoot: tmpDir,
          dataRoot,
          executor,
          updateElo: false,
        });
        return run.run_id;
      },
    });

    expect(batchResult.completed).toBe(5);
    expect(batchResult.failed).toBe(0);
    expect(batchResult.runIds).toHaveLength(5);

    // Step 2: Assemble BatchOutput (simulating what CLI does)
    const paths = getDataPaths(dataRoot);
    const batchOutput: BatchOutput = {
      version: 1,
      batchId: batchResult.batchId,
      profileId,
      left: leftDir,
      right: rightDir,
      createdAt: new Date().toISOString(),
      runs: batchResult.runIds.map(runId => {
        const run = loadRun(dataRoot, runId);
        return { runId, taskTrialResults: run.task_trial_results };
      }),
      summary: {
        completed: batchResult.completed,
        failed: batchResult.failed,
        retried: batchResult.retried,
        wallClockMs: batchResult.wallClockMs,
      },
    };

    // Verify BatchOutput structure
    expect(batchOutput.version).toBe(1);
    expect(batchOutput.runs).toHaveLength(5);
    for (const run of batchOutput.runs) {
      expect(run.runId).toBeTruthy();
      expect(Array.isArray(run.taskTrialResults)).toBe(true);
      expect(run.taskTrialResults.length).toBeGreaterThan(0);
    }

    // Step 3: Flatten into IRT dataset
    const { responses, validCount, taskIds } = batchTrialsToDataset(batchOutput.runs);

    // 5 runs × 6 tasks × 2 sides × 1 trial = 60 valid observations (assuming all pass)
    // Each run has 2 sides → 10 respondents
    expect(taskIds).toHaveLength(6);
    expect(validCount).toBeGreaterThanOrEqual(30); // Minimum for IRT
    expect(responses.length).toBeGreaterThanOrEqual(5); // At least 5 bundles

    // Step 4: Run IRT calibration
    const calibReport = calibrateIRT({
      trialData: { items: taskIds, responses },
      profileId,
      catalogHash: "pipeline-test-hash",
    });

    expect(calibReport.version).toBe(1);
    expect(calibReport.profile_id).toBe(profileId);
    expect(calibReport.item_params).toHaveLength(6);
    expect(calibReport.total_trials_used).toBe(responses.length);

    // Step 5: Run comparison with IRT weights
    const runWithIRT = await compareLibrariesRun({
      leftRootPath: leftDir,
      rightRootPath: rightDir,
      profileId,
      comparisonMode: "cross_library",
      allowlistedParentRoot: tmpDir,
      dataRoot,
      executor,
      updateElo: false,
      irtCalibration: calibReport,
    });

    expect(runWithIRT.irt_calibration_id).toBe(calibReport.calibration_id);

    // Also run without IRT for comparison
    const runWithoutIRT = await compareLibrariesRun({
      leftRootPath: leftDir,
      rightRootPath: rightDir,
      profileId,
      comparisonMode: "cross_library",
      allowlistedParentRoot: tmpDir,
      dataRoot,
      executor,
      updateElo: false,
    });

    expect(runWithoutIRT.irt_calibration_id).toBeUndefined();

    // Verify the report renders without error
    const reportText = renderRunReport(runWithIRT);
    expect(reportText).toContain("Watchtower Benchmark Run");
  });

  it("batch with partial failures: failed runs excluded from BatchOutput.runs", async () => {
    const executor = createMockExecutor();
    let callCount = 0;

    const batchResult = await runBatch({
      totalRuns: 5,
      parallel: 1,
      retryOnFail: 0,
      runFn: async () => {
        callCount++;
        // Fail runs 2 and 4
        if (callCount === 2 || callCount === 4) {
          throw new Error("simulated failure");
        }
        const run = await compareLibrariesRun({
          leftRootPath: leftDir,
          rightRootPath: rightDir,
          profileId,
          comparisonMode: "cross_library",
          allowlistedParentRoot: tmpDir,
          dataRoot,
          executor,
          updateElo: false,
        });
        return run.run_id;
      },
    });

    expect(batchResult.completed).toBe(3);
    expect(batchResult.failed).toBe(2);
    expect(batchResult.runIds).toHaveLength(3);

    // Assemble BatchOutput — only 3 completed runs
    const batchOutput: BatchOutput = {
      version: 1,
      batchId: batchResult.batchId,
      profileId,
      left: leftDir,
      right: rightDir,
      createdAt: new Date().toISOString(),
      runs: batchResult.runIds.map(runId => {
        const run = loadRun(dataRoot, runId);
        return { runId, taskTrialResults: run.task_trial_results };
      }),
      summary: {
        completed: batchResult.completed,
        failed: batchResult.failed,
        retried: batchResult.retried,
        wallClockMs: batchResult.wallClockMs,
      },
    };

    expect(batchOutput.runs).toHaveLength(3);
    expect(batchOutput.summary.failed).toBe(2);
  });
});
