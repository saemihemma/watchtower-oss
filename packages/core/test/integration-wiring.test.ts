/**
 * Integration tests for Phase 10a wiring: extension scorers active in production,
 * IRT threading, composition rendering, collapse config provenance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerExtensionScorer,
  clearExtensionScorers,
  getRegisteredScorers,
} from "../src/extension-scorer.js";
import { createCVScorer, clearBundleTextCache } from "../src/cv-scorer.js";
import { createCompositionScorer } from "../src/composition-scorer.js";
import { compareLibraries } from "../src/engine.js";
import { renderRunReport } from "../src/service.js";
import { createMockExecutor } from "../src/local-executors.js";
import { registerProfile } from "../src/builtin-benchmark.js";
import type {
  BenchmarkTask,
  BenchmarkProfile,
  CollapseConfig,
  IRTCalibrationReport,
} from "../src/schemas.js";
import {
  COLLAPSE_PRIMITIVE_FLOOR,
  COLLAPSE_COMPOSED_CEILING,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCVTask(id: string, cues: string[], checks: { rule: string; weight: number }[] = []): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "cv-test",
    category: "test_cat",
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: "test cv prompt",
    rubric_text: null,
    extensions: {
      cv: {
        construction_cues: cues,
        verification_checks: checks.map((c, i) => ({
          check_id: `chk-${i}`,
          kind: "requires" as const,
          description: `check ${i}`,
          rule: c.rule,
          weight: c.weight,
          critical: false,
        })),
        construction_weight: 0.3,
        verification_weight: 0.7,
        firewall: true,
      },
    },
  };
}

function makeCompTask(
  id: string,
  layer: "primitive" | "composed" | "meta",
  cues: string[] = []
): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "comp-test",
    category: "test_cat",
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: "test comp prompt",
    rubric_text: null,
    extensions: {
      composition: { layer, dependencies: [], composition_cues: cues },
    },
  };
}

function makePlainTask(id: string): BenchmarkTask {
  return {
    task_id: id,
    task_version: 1,
    family: "plain-test",
    category: "test_cat",
    critical_regression: false,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 1,
    trials_per_side: 1,
    prompt_text: "test plain prompt",
    rubric_text: null,
  };
}

function registerTestProfile(tasks: BenchmarkTask[], collapseConfig?: CollapseConfig): string {
  const profileId = "integration-test-profile";
  const profile: BenchmarkProfile = {
    profile_id: profileId,
    label: "Integration Test",
    description: "Test profile for integration wiring",
    tasks,
    pack: {
      pack_id: "integration-test-pack",
      source: "built_in_pack",
      task_ids: tasks.map((t) => t.task_id),
      category_weights: { test_cat: 1.0 },
      critical_task_ids: [],
      catalog_hash: "test-hash",
    },
    collapse_config: collapseConfig,
  };
  registerProfile(profile);
  return profileId;
}

function makeIRTCalibration(taskIds: string[]): IRTCalibrationReport {
  return {
    version: 1,
    calibration_id: "test-cal-001",
    profile_id: "integration-test-profile",
    catalog_hash: "test-hash",
    schema_version: 5,
    model_selected: "grm",
    model_selection_aic: { grm: 100, twopl: 110 },
    item_params: taskIds.map((id, i) => ({
      task_id: id,
      model: "grm" as const,
      discrimination: 1.0 + i * 0.5,
      boundaries: [0, 1],
      fisher_info_at_mean: 0.5 + i * 0.3,
      fisher_info_integrated: 0.5 + i * 0.3,
      calibration_n: 30,
      fit_residual: 0.01,
      response_distribution: [0.2, 0.3, 0.3, 0.2],
    })),
    mean_ability: 0,
    ability_std: 1,
    total_trials_used: 100,
    total_bundles: 5,
    convergence_iterations: 20,
    converged: true,
    n_restarts: 3,
    best_restart_index: 0,
    marginal_log_likelihood: -200,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 10a Integration Wiring", () => {
  let tmpDir: string;
  let snapshotsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-"));
    snapshotsRoot = path.join(tmpDir, "snapshots");
    fs.mkdirSync(snapshotsRoot, { recursive: true });

    // Create two minimal skill libraries
    const leftDir = path.join(tmpDir, "left");
    const rightDir = path.join(tmpDir, "right");
    fs.mkdirSync(leftDir, { recursive: true });
    fs.mkdirSync(rightDir, { recursive: true });
    // Each needs a SKILL.md to pass assertMarkdownSkillLibrary
    fs.writeFileSync(path.join(leftDir, "SKILL.md"), "alpha beta gamma delta echo foxtrot hotel india juliet");
    fs.writeFileSync(path.join(rightDir, "SKILL.md"), "alpha beta gamma delta echo foxtrot hotel india juliet");

    clearExtensionScorers();
    clearBundleTextCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearExtensionScorers();
    clearBundleTextCache();
  });

  // -------------------------------------------------------------------------
  // 10a.6: Minimal integration — 1 CV + 1 composition (insufficient_data)
  // -------------------------------------------------------------------------

  describe("minimal: CV + composition scorers both fire", () => {
    it("produces cv_result and composition metadata when scorers registered", async () => {
      registerExtensionScorer(createCVScorer());
      registerExtensionScorer(createCompositionScorer());

      const tasks = [
        makeCVTask("cv1", ["alpha", "beta"], [{ rule: 'requires "alpha"', weight: 1.0 }]),
        makeCompTask("comp-p1", "primitive", ["alpha"]),
        makeCompTask("comp-p2", "primitive", ["beta"]),
        makeCompTask("comp-c1", "composed", ["zzz_nomatch"]),
        makeCompTask("comp-c2", "composed", ["zzz_nomatch"]),
      ];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      // CV scorer should fire for cv1
      const cvTrials = run.task_trial_results.filter((t) => t.task_id === "cv1");
      expect(cvTrials.length).toBeGreaterThan(0);
      const cvTrial = cvTrials.find((t) => t.extension_metadata);
      expect(cvTrial).toBeDefined();
      expect(cvTrial!.extension_metadata?.scorer_kind).toBe("cv");

      // Composition scorer should fire for comp tasks
      const compTrials = run.task_trial_results.filter(
        (t) => t.task_id.startsWith("comp-")
      );
      const compWithMeta = compTrials.find((t) => t.extension_metadata?.scorer_kind === "composition");
      expect(compWithMeta).toBeDefined();

      // Composition analysis should be present with collapse detected
      expect(run.composition_analysis).toBeDefined();
      expect(run.composition_analysis!.detected).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 10a.7: Full integration — collapse detection + IRT weights
  // -------------------------------------------------------------------------

  describe("full: collapse detection with IRT weights", () => {
    it("detects collapse and applies IRT weights", async () => {
      registerExtensionScorer(createCVScorer());
      registerExtensionScorer(createCompositionScorer());

      // 3 primitive tasks with cues that will match (high scores)
      // 2 composed tasks with cues that won't match (low scores)
      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("p3", "primitive", ["gamma"]),
        makeCompTask("c1", "composed", ["zzz_nomatch_1"]),
        makeCompTask("c2", "composed", ["zzz_nomatch_2"]),
      ];
      const profileId = registerTestProfile(tasks);

      const irtCalibration = makeIRTCalibration(tasks.map((t) => t.task_id));

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
        irtCalibration,
      });

      // Composition analysis should be present (not insufficient_data)
      expect(run.composition_analysis).toBeDefined();
      expect(run.composition_analysis!.insufficient_data).toBeUndefined();

      // Primitives should score higher than composed (cue matching)
      expect(run.composition_analysis!.mean_primitive).toBeGreaterThan(0);
      // Composed tasks have non-matching cues -> score 0
      expect(run.composition_analysis!.mean_composed).toBe(0);

      // Collapse should be detected (high prim > floor, low comp < ceiling)
      expect(run.composition_analysis!.detected).toBe(true);
      expect(run.composition_analysis!.severity).toBeGreaterThan(0);

      // IRT calibration ID should be stored
      expect(run.irt_calibration_id).toBe("test-cal-001");

      // Collapse config used should be stored (defaults since no profile override)
      expect(run.collapse_config_used).toBeDefined();
      expect(run.collapse_config_used!.primitive_floor).toBe(COLLAPSE_PRIMITIVE_FLOOR);
      expect(run.collapse_config_used!.composed_ceiling).toBe(COLLAPSE_COMPOSED_CEILING);
    });

    it("uses profile-level collapse_config when provided", async () => {
      registerExtensionScorer(createCompositionScorer());

      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("c1", "composed", ["zzz_nomatch"]),
        makeCompTask("c2", "composed", ["zzz_nomatch"]),
      ];
      // Custom config: very low floor (0.1) so collapse is easily detected
      const customConfig: CollapseConfig = { primitive_floor: 0.1, composed_ceiling: 0.5 };
      const profileId = registerTestProfile(tasks, customConfig);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      // Custom collapse config should be stored for provenance
      expect(run.collapse_config_used).toEqual(customConfig);
    });
  });

  // -------------------------------------------------------------------------
  // 10a.7 cont: Composition report rendering
  // -------------------------------------------------------------------------

  describe("composition analysis rendering", () => {
    it("renders collapse section in markdown when detected", async () => {
      registerExtensionScorer(createCompositionScorer());

      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("p3", "primitive", ["gamma"]),
        makeCompTask("c1", "composed", ["zzz_nomatch"]),
        makeCompTask("c2", "composed", ["zzz_nomatch"]),
      ];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      const report = renderRunReport(run);
      expect(report).toContain("## Composition Analysis");
      expect(report).toContain("**Collapse detected:** Yes");
      expect(report).toContain("Primitive");
      expect(report).toContain("Composed + Meta");
      expect(report).toContain("integration fragility");
    });

    it("renders no-collapse section when not detected", async () => {
      registerExtensionScorer(createCompositionScorer());

      // All tasks match cues -> no collapse
      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
        makeCompTask("c1", "composed", ["alpha"]),
        makeCompTask("c2", "composed", ["beta"]),
      ];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      const report = renderRunReport(run);
      expect(report).toContain("## Composition Analysis");
      expect(report).toContain("**Collapse detected:** No");
      expect(report).toContain("maintain quality at scale");
    });

    it("renders insufficient_data message when too few tasks per layer", async () => {
      registerExtensionScorer(createCompositionScorer());

      // Only primitive tasks, no composed — composed layer has 0 scores → insufficient_data
      const tasks = [
        makeCompTask("p1", "primitive", ["alpha"]),
        makeCompTask("p2", "primitive", ["beta"]),
      ];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      const report = renderRunReport(run);
      expect(report).toContain("## Composition Analysis");
      expect(report).toContain("Insufficient data");
    });
  });

  // -------------------------------------------------------------------------
  // 10a.8: Edge cases
  // -------------------------------------------------------------------------

  describe("edge: empty extensions and graceful degradation", () => {
    it("produces no extension metadata for plain tasks", async () => {
      registerExtensionScorer(createCVScorer());
      registerExtensionScorer(createCompositionScorer());

      const tasks = [makePlainTask("plain1"), makePlainTask("plain2")];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      // No extension metadata on any trial
      for (const trial of run.task_trial_results) {
        expect(trial.extension_metadata).toBeUndefined();
      }

      // No composition analysis (no composition tasks)
      expect(run.composition_analysis).toBeUndefined();

      // Report should NOT contain composition section
      const report = renderRunReport(run);
      expect(report).not.toContain("## Composition Analysis");
    });

    it("returns undefined composition_analysis when zero composition tasks", async () => {
      registerExtensionScorer(createCompositionScorer());

      const tasks = [makePlainTask("p1")];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      expect(run.composition_analysis).toBeUndefined();
    });

    it("stores default collapse_config_used even without composition tasks", async () => {
      const tasks = [makePlainTask("p1")];
      const profileId = registerTestProfile(tasks);

      const run = await compareLibraries({
        allowlistedParentRoot: tmpDir,
        snapshotsRoot,
        executor: createMockExecutor(),
        leftRootPath: path.join(tmpDir, "left"),
        rightRootPath: path.join(tmpDir, "right"),
        comparisonMode: "cross_library",
        profileId,
      });

      // collapse_config_used should always be stored for provenance
      expect(run.collapse_config_used).toBeDefined();
      expect(run.collapse_config_used!.primitive_floor).toBe(COLLAPSE_PRIMITIVE_FLOOR);
      expect(run.collapse_config_used!.composed_ceiling).toBe(COLLAPSE_COMPOSED_CEILING);
    });
  });
});
