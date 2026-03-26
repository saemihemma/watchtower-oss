import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCVScorer, clearBundleTextCache } from "../src/cv-scorer.js";
import { clearExtensionScorers, registerExtensionScorer } from "../src/extension-scorer.js";
import type {
  BenchmarkTask,
  CVTaskExtension,
  CVCheck,
  ExecutorInput,
  ExecutorOutput,
} from "../src/schemas.js";

describe("CV Scorer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-scorer-test-"));
    clearExtensionScorers();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    clearBundleTextCache();
    clearExtensionScorers();
  });

  function createTask(cvExt: CVTaskExtension): BenchmarkTask {
    return {
      task_id: "test-task",
      task_version: 1,
      family: "test",
      category: "code_hygiene",
      critical_regression: false,
      evaluator_kind: "deterministic",
      priority: 1,
      min_valid_trials: 1,
      trials_per_side: 1,
      prompt_text: "Test prompt",
      rubric_text: null,
      extensions: { cv: cvExt },
    };
  }

  function createInput(task: BenchmarkTask): ExecutorInput {
    return {
      sideId: "left",
      task,
      trialIndex: 0,
      bundleDir: tempDir,
      promptText: "Test prompt",
      rubricText: null,
    };
  }

  function createBaseResult(normalizedScore: number = 0.5): ExecutorOutput {
    return {
      normalizedScore,
      status: "valid",
    };
  }

  it("Test 1: All cues present, all checks pass", async () => {
    // Create bundle with all cues present
    fs.writeFileSync(path.join(tempDir, "content.md"), "This is the test cue and another cue present");

    const cvExt: CVTaskExtension = {
      construction_cues: ["test cue", "another cue"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:test',
          weight: 1.0,
          critical: false,
        },
        {
          check_id: "check2",
          kind: "requires",
          description: "Check 2",
          rule: 'requires:cue',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(1.0);
    expect(cvResult.verification_score).toBe(1.0);
    expect(cvResult.combined_score).toBeCloseTo(0.3 * 1.0 + 0.7 * 1.0, 5);
  });

  it("Test 2: Critical check fails, firewall=true", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "Some content present but not the critical keyword");

    const cvExt: CVTaskExtension = {
      construction_cues: ["present"],
      verification_checks: [
        {
          check_id: "critical_check",
          kind: "requires",
          description: "Critical check",
          rule: 'requires:missing_text',
          weight: 1.0,
          critical: true,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.critical_failure).toBe(true);
    expect(cvResult.combined_score).toBeCloseTo(0.3 * 1.0, 5);
    expect(cvResult.verification_score).toBe(0);
  });

  it("Test 3: No cues present, all checks pass", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "Some content for verification check");

    const cvExt: CVTaskExtension = {
      construction_cues: ["missing cue 1", "missing cue 2"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:content',
          weight: 1.0,
          critical: false,
        },
        {
          check_id: "check2",
          kind: "requires",
          description: "Check 2",
          rule: 'requires:verification',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(0);
    expect(cvResult.verification_score).toBe(1.0);
    expect(cvResult.combined_score).toBeCloseTo(0.3 * 0 + 0.7 * 1.0, 5);
  });

  it("Test 4: Shortcut detection", async () => {
    fs.writeFileSync(
      path.join(tempDir, "content.md"),
      "High construction marker present and also present"
    );

    const cvExt: CVTaskExtension = {
      construction_cues: ["High construction marker", "also"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Failing check 1",
          rule: 'requires:missing1',
          weight: 0.5,
          critical: false,
        },
        {
          check_id: "check2",
          kind: "requires",
          description: "Failing check 2",
          rule: 'requires:missing2',
          weight: 0.5,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBeGreaterThan(0.8);
    expect(cvResult.verification_score).toBeLessThan(0.3);
    expect(cvResult.shortcut_detected).toBe(true);
  });

  it("Test 5: Custom weights (0.5/0.5)", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "test marker present");

    const cvExt: CVTaskExtension = {
      construction_cues: ["test marker"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:present',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.5,
      verification_weight: 0.5,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(1.0);
    expect(cvResult.verification_score).toBe(1.0);
    expect(cvResult.combined_score).toBeCloseTo(0.5 * 1.0 + 0.5 * 1.0, 5);
  });

  it("Test 6: Empty construction_cues uses base score", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "Some content");

    const cvExt: CVTaskExtension = {
      construction_cues: [],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:content',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseScore = 0.6;
    const baseResult = createBaseResult(baseScore);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(baseScore);
    expect(cvResult.verification_score).toBe(1.0);
  });

  it("Test 7: Empty verification_checks uses base score", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "test marker");

    const cvExt: CVTaskExtension = {
      construction_cues: ["test marker"],
      verification_checks: [],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseScore = 0.6;
    const baseResult = createBaseResult(baseScore);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(1.0);
    expect(cvResult.verification_score).toBe(baseScore);
  });

  it("Test 8: Empty bundle (no .md files)", async () => {
    // tempDir is empty, no .md files
    const cvExt: CVTaskExtension = {
      construction_cues: ["expected cue"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:expected',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(0);
    expect(cvResult.verification_score).toBe(0);
  });

  it("Test 9: All check weights = 0 (degenerate)", async () => {
    fs.writeFileSync(path.join(tempDir, "content.md"), "test content present");

    const cvExt: CVTaskExtension = {
      construction_cues: ["test"],
      verification_checks: [
        {
          check_id: "check1",
          kind: "requires",
          description: "Check 1",
          rule: 'requires:present',
          weight: 0,
          critical: false,
        },
        {
          check_id: "check2",
          kind: "requires",
          description: "Check 2",
          rule: 'requires:content',
          weight: 0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.verification_score).toBe(0);
  });

  it("Test 10: Section with regex metacharacters", async () => {
    fs.writeFileSync(
      path.join(tempDir, "content.md"),
      "## Error (best)\nContent for the error section"
    );

    const cvExt: CVTaskExtension = {
      construction_cues: ["Error (best)"],
      verification_checks: [
        {
          check_id: "section_check",
          kind: "section",
          description: "Error section check",
          rule: 'section:"Error (best)"',
          weight: 1.0,
          critical: false,
        },
      ],
      construction_weight: 0.3,
      verification_weight: 0.7,
      firewall: true,
    };

    const task = createTask(cvExt);
    const input = createInput(task);
    const baseResult = createBaseResult(0.5);

    const scorer = createCVScorer();
    registerExtensionScorer(scorer);

    const result = await scorer.score(input, baseResult);
    const cvResult = (result.metadata as any).cv_result;

    expect(cvResult.construction_score).toBe(1.0);
    expect(cvResult.verification_score).toBe(1.0);
  });
});
