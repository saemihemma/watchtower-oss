import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateExternalProfile,
  type ExternalProfileDefinition,
} from "../src/profile-loader.js";
import {
  clearExtensionScorers,
  registerExtensionScorer,
  scoreWithExtensions,
  type ExtensionScorer,
} from "../src/extension-scorer.js";
import {
  createCVScorer,
  clearBundleTextCache,
} from "../src/cv-scorer.js";
import type {
  BenchmarkTask,
  ExecutorInput,
  ExecutorOutput,
} from "../src/schemas.js";

describe("CV Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-test-"));
  });

  afterEach(() => {
    clearExtensionScorers();
    clearBundleTextCache();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  function createMockTask(withExtension: boolean): BenchmarkTask {
    const baseTask: BenchmarkTask = {
      task_id: "test-task",
      task_version: 1,
      family: "test",
      category: "reasoning",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 5,
      prompt_text: "Test prompt",
      rubric_text: null,
    };

    if (withExtension) {
      return {
        ...baseTask,
        extensions: {
          cv: {
            construction_cues: ["design", "pattern"],
            verification_checks: [
              {
                check_id: "interface-check",
                kind: "requires",
                description: "Has interface keyword",
                rule: "requires:interface",
                weight: 0.5,
                critical: false,
              },
              {
                check_id: "critical-check",
                kind: "requires",
                description: "Critical check",
                rule: "requires:critical-feature",
                weight: 0.5,
                critical: true,
              },
            ],
            construction_weight: 0.3,
            verification_weight: 0.7,
            firewall: true,
          },
        },
      };
    }

    return baseTask;
  }

  function createMockInput(
    task: BenchmarkTask,
    bundleDir: string
  ): ExecutorInput {
    return {
      sideId: "left",
      task,
      trialIndex: 0,
      bundleDir,
      promptText: "Test prompt",
      rubricText: null,
    };
  }

  function createMockBaseResult(score: number = 0.75): ExecutorOutput {
    return {
      normalizedScore: score,
      status: "valid",
    };
  }

  it("CV scorer fires on CV task", async () => {
    registerExtensionScorer(createCVScorer());

    const task = createMockTask(true);
    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult();

    // Create minimal bundle
    fs.writeFileSync(path.join(tempDir, "test.md"), "design pattern interface");

    const { metadata } = await scoreWithExtensions(input, baseResult);

    expect(metadata).toBeDefined();
    expect(metadata?.scorer_kind).toBe("cv");
  });

  it("CV scorer does NOT fire on non-CV task", async () => {
    registerExtensionScorer(createCVScorer());

    const task = createMockTask(false);
    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult();

    const { metadata } = await scoreWithExtensions(input, baseResult);

    expect(metadata).toBeUndefined();
  });

  it("Firewall zeroes verification on critical failure", async () => {
    registerExtensionScorer(createCVScorer());

    const task = createMockTask(true);
    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult();

    // Bundle has construction cues but NOT the critical feature
    fs.writeFileSync(path.join(tempDir, "test.md"), "design pattern interface");

    const { result, metadata } = await scoreWithExtensions(input, baseResult);

    expect(metadata).toBeDefined();
    expect(metadata?.cv_result).toBeDefined();
    expect(metadata?.cv_result?.critical_failure).toBe(true);
  });

  it("Shortcut detection", async () => {
    registerExtensionScorer(createCVScorer());

    const task: BenchmarkTask = {
      task_id: "shortcut-task",
      task_version: 1,
      family: "test",
      category: "reasoning",
      critical_regression: false,
      evaluator_kind: "rubric",
      priority: 50,
      min_valid_trials: 1,
      trials_per_side: 5,
      prompt_text: "Test prompt",
      rubric_text: null,
      extensions: {
        cv: {
          construction_cues: ["feature1", "feature2", "feature3"],
          verification_checks: [
            {
              check_id: "weak-check",
              kind: "requires",
              description: "Weak check",
              rule: "requires:nonexistent",
              weight: 1,
              critical: false,
            },
          ],
          construction_weight: 0.3,
          verification_weight: 0.7,
          firewall: false,
        },
      },
    };

    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult();

    // Bundle has many construction cues but fails verification
    fs.writeFileSync(
      path.join(tempDir, "test.md"),
      "feature1 feature2 feature3 lots of content"
    );

    const { metadata } = await scoreWithExtensions(input, baseResult);

    expect(metadata).toBeDefined();
    expect(metadata?.cv_result?.shortcut_detected).toBe(true);
  });

  it("v4 profile (no extensions)", async () => {
    registerExtensionScorer(createCVScorer());

    const task = createMockTask(false);
    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult();

    const { metadata } = await scoreWithExtensions(input, baseResult);

    expect(metadata).toBeUndefined();
  });

  it("Invalid profile rejected at load", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "bad-profile",
      label: "Bad Profile",
      description: "Invalid profile",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "bad-task",
          category: "reasoning",
          prompt_text: "Test",
          extensions: {
            cv: {
              construction_cues: [],
              verification_checks: [
                {
                  check_id: "bad",
                  kind: "requires",
                  description: "Bad rule",
                  rule: "invalid:syntax:",
                  weight: 1,
                },
              ],
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("Extension error → graceful fallback", async () => {
    const throwingScorer: ExtensionScorer = {
      kind: "throwing",
      applicable(task) {
        return true;
      },
      async score() {
        throw new Error("Test scorer error");
      },
    };

    registerExtensionScorer(throwingScorer);

    const task = createMockTask(true);
    const input = createMockInput(task, tempDir);
    const baseResult = createMockBaseResult(0.75);

    fs.writeFileSync(path.join(tempDir, "test.md"), "test content");

    const { result, metadata } = await scoreWithExtensions(input, baseResult);

    // Base score should be preserved
    expect(result.normalizedScore).toBe(0.75);

    // Metadata should include error info
    expect(metadata).toBeDefined();
    expect(metadata?.extension_error).toBeDefined();
  });

  it("Profile with CV validates rule syntax at load", () => {
    const profile: ExternalProfileDefinition = {
      profile_id: "valid-cv-profile",
      label: "Valid CV Profile",
      description: "Profile with valid CV rules",
      category_weights: { reasoning: 1 },
      tasks: [
        {
          task_id: "cv-task",
          category: "reasoning",
          prompt_text: "Test prompt",
          extensions: {
            cv: {
              construction_cues: ["pattern"],
              verification_checks: [
                {
                  check_id: "valid-check",
                  kind: "requires",
                  description: "Valid check",
                  rule: "requires:feature",
                  weight: 1,
                },
              ],
            },
          },
        },
      ],
    };

    const errors = validateExternalProfile(profile);
    expect(errors.length).toBe(0);
  });
});
