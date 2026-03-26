/**
 * Tests for IRT calibration report loading and validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCalibrationReport, writeCalibrationReport } from "../src/irt-calibrator.js";
import type { IRTCalibrationReport } from "../src/schemas.js";

function makeValidReport(): IRTCalibrationReport {
  return {
    version: 1,
    calibration_id: "test-cal-001",
    profile_id: "default",
    catalog_hash: "abc123",
    schema_version: 5,
    model_selected: "grm",
    model_selection_aic: { grm: 100, twopl: 110 },
    item_params: [
      {
        task_id: "t1",
        model: "grm",
        discrimination: 1.0,
        boundaries: [0, 1],
        fisher_info_at_mean: 0.5,
        fisher_info_integrated: 0.5,
        calibration_n: 30,
        fit_residual: 0.01,
        response_distribution: [0.2, 0.3, 0.3, 0.2],
      }
    ],
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

describe("IRT Calibration Report Loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "irt-load-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should load a valid calibration report", () => {
    const report = makeValidReport();
    const filePath = path.join(tmpDir, "calibration.json");
    fs.writeFileSync(filePath, JSON.stringify(report), "utf8");

    const loaded = loadCalibrationReport(filePath);
    expect(loaded.calibration_id).toBe("test-cal-001");
    expect(loaded.version).toBe(1);
    expect(loaded.item_params).toHaveLength(1);
  });

  it("should throw on file not found", () => {
    expect(() => loadCalibrationReport("/nonexistent/path.json")).toThrow(
      /Cannot read IRT calibration file/
    );
  });

  it("should throw on malformed JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json }", "utf8");

    expect(() => loadCalibrationReport(filePath)).toThrow(
      /not valid JSON/
    );
  });

  it("should throw on missing required fields", () => {
    const filePath = path.join(tmpDir, "incomplete.json");
    fs.writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf8");

    expect(() => loadCalibrationReport(filePath)).toThrow(
      /invalid structure/
    );
  });

  it("should write and round-trip a calibration report", () => {
    const report = makeValidReport();
    const outputPath = writeCalibrationReport(report, tmpDir);

    expect(fs.existsSync(outputPath)).toBe(true);

    const loaded = loadCalibrationReport(outputPath);
    expect(loaded.calibration_id).toBe(report.calibration_id);
    expect(loaded.item_params).toHaveLength(1);
  });
});
