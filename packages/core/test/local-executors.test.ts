import { describe, expect, it } from "vitest";
import {
  collectDiagnostics,
  createClaudeExecutor,
  createCodexExecutor,
  createMockExecutor,
  resolveLaunchShell
} from "../src/local-executors.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("resolveLaunchShell", () => {
  it("defaults to PowerShell on Windows", () => {
    expect(resolveLaunchShell("win32")).toBe("powershell");
  });

  it("defaults to sh on non-Windows hosts", () => {
    expect(resolveLaunchShell("darwin")).toBe("sh");
    expect(resolveLaunchShell("linux")).toBe("sh");
  });

  it("respects explicit shell overrides", () => {
    expect(resolveLaunchShell("win32", "cmd")).toBe("cmd");
    expect(resolveLaunchShell("darwin", "powershell")).toBe("powershell");
  });
});

describe("collectDiagnostics", () => {
  it("reports provider readiness independently", () => {
    const diagnostics = collectDiagnostics({
      platform: "darwin",
      env: {
        WATCHTOWER_CODEX_LAUNCH: "codex exec --instruction-file {instructionFile}",
        WATCHTOWER_CLAUDE_LAUNCH: "claude --print --input-file {instructionFile}",
        WATCHTOWER_LAUNCH_SHELL: "sh"
      },
      probeExecutable(command) {
        if (command === "codex") {
          return "/usr/local/bin/codex";
        }
        if (command === "claude") {
          return "/usr/local/bin/claude";
        }
        return null;
      }
    });

    expect(diagnostics.host_platform).toBe("darwin");
    expect(diagnostics.default_launch_shell).toBe("sh");
    expect(diagnostics.providers.codex.ready).toBe(true);
    expect(diagnostics.providers.codex.launcher_path).toBe("/usr/local/bin/codex");
    expect(diagnostics.providers.claude.ready).toBe(true);
    expect(diagnostics.providers.claude.launcher_path).toBe("/usr/local/bin/claude");
  });

  it("marks unconfigured providers as not ready", () => {
    const diagnostics = collectDiagnostics({
      platform: "win32",
      env: {},
      probeExecutable() {
        return null;
      }
    });

    expect(diagnostics.providers.codex.launch_configured).toBe(false);
    expect(diagnostics.providers.codex.ready).toBe(false);
    expect(diagnostics.providers.claude.launch_configured).toBe(false);
    expect(diagnostics.providers.claude.ready).toBe(false);
  });
});

describe("provider executors", () => {
  it("fails cleanly when Codex is unconfigured", async () => {
    const executor = createCodexExecutor({ env: {} });
    const result = await executor.run({
      sideId: "left",
      task: {
        task_id: "functional_multidomain_001",
        task_version: 1,
        family: "default",
        category: "structured_reasoning",
        critical_regression: false,
        evaluator_kind: "rubric",
        priority: 50,
        min_valid_trials: 4,
        prompt_text: "Prompt",
        rubric_text: "Rubric"
      },
      trialIndex: 1,
      bundleDir: process.cwd(),
      promptText: "Prompt",
      rubricText: "Rubric"
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("codex_launch_unconfigured");
  });

  it("fails cleanly when Claude is unconfigured", async () => {
    const executor = createClaudeExecutor({ env: {} });
    const result = await executor.run({
      sideId: "right",
      task: {
        task_id: "functional_multidomain_001",
        task_version: 1,
        family: "default",
        category: "structured_reasoning",
        critical_regression: false,
        evaluator_kind: "rubric",
        priority: 50,
        min_valid_trials: 4,
        prompt_text: "Prompt",
        rubric_text: "Rubric"
      },
      trialIndex: 1,
      bundleDir: process.cwd(),
      promptText: "Prompt",
      rubricText: "Rubric"
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("claude_launch_unconfigured");
  });
});

describe("mock executor", () => {
  function makeBundleDir(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-mock-"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    return dir;
  }

  function makeTask(overrides: Partial<{
    task_id: string;
    category: string;
    evaluator_kind: string;
    prompt_text: string;
    rubric_text: string | null;
  }> = {}) {
    const prompt = overrides.prompt_text ?? "Review the library and determine whether its skills draw clear boundaries about what they are and what they are not.";
    const rubric = overrides.rubric_text ?? "0 boundaries missing\n4 crisp boundaries that reduce misuse and overlap";
    return {
      sideId: "left" as const,
      task: {
        task_id: overrides.task_id ?? "functional_scope_001",
        task_version: 1,
        family: "default",
        category: overrides.category ?? "scope_discipline",
        critical_regression: false,
        evaluator_kind: (overrides.evaluator_kind ?? "rubric") as "rubric" | "deterministic",
        priority: 50,
        min_valid_trials: 4,
        prompt_text: prompt,
        rubric_text: rubric
      },
      trialIndex: 1,
      bundleDir: "", // set per test
      promptText: prompt,
      rubricText: rubric
    };
  }

  it("scores generic benchmark tasks without named-library cues", async () => {
    const bundleDir = makeBundleDir(
      "# Boundary Guide\n\n## What It Is\nHelps define scope and boundaries.\n\n## What It Is NOT\nNot a catch-all.\n\nUse when you need evidence, examples, and a clear next action."
    );
    try {
      const executor = createMockExecutor();
      const input = makeTask();
      input.bundleDir = bundleDir;
      const result = await executor.run(input);
      expect(result.status).toBe("valid");
      expect(result.normalizedScore).not.toBeNull();
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("produces scores between 0 and 1 inclusive", async () => {
    const bundleDir = makeBundleDir("# Skill\nSome content about boundaries and scope.");
    try {
      const executor = createMockExecutor();
      const input = makeTask();
      input.bundleDir = bundleDir;
      const result = await executor.run(input);
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(1);
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("scores higher when bundle text matches more cues", async () => {
    const lowDir = makeBundleDir("# Skill\nNothing relevant here at all.");
    const highDir = makeBundleDir(
      "# Boundary Guide\n\nboundary scope overlap responsibilities clear separation not a catch-all"
    );
    try {
      const executor = createMockExecutor();
      const lowInput = makeTask();
      lowInput.bundleDir = lowDir;
      const highInput = makeTask();
      highInput.bundleDir = highDir;

      const lowResult = await executor.run(lowInput);
      const highResult = await executor.run(highInput);

      expect(highResult.normalizedScore!).toBeGreaterThanOrEqual(lowResult.normalizedScore!);
    } finally {
      fs.rmSync(lowDir, { recursive: true, force: true });
      fs.rmSync(highDir, { recursive: true, force: true });
    }
  });

  it("produces deterministic scores for identical inputs", async () => {
    const bundleDir = makeBundleDir("# Skill\nboundary scope evidence handoff");
    try {
      const executor = createMockExecutor();
      const input = makeTask();
      input.bundleDir = bundleDir;
      const r1 = await executor.run(input);
      const r2 = await executor.run(input);
      expect(r1.normalizedScore).toBe(r2.normalizedScore);
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("handles deterministic evaluator_kind as binary pass/fail", async () => {
    const bundleDir = makeBundleDir(
      "# Skill\nboundary scope overlap responsibilities evidence verification"
    );
    try {
      const executor = createMockExecutor();
      const input = makeTask({ evaluator_kind: "deterministic" });
      input.bundleDir = bundleDir;
      const result = await executor.run(input);
      expect(result.status).toBe("valid");
      expect([0, 1]).toContain(result.normalizedScore);
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("rubric scores are quantized to 0, 0.25, 0.5, 0.75, or 1", async () => {
    const bundleDir = makeBundleDir("# Skill\nboundary scope overlap");
    try {
      const executor = createMockExecutor();
      const input = makeTask();
      input.bundleDir = bundleDir;
      const result = await executor.run(input);
      expect([0, 0.25, 0.5, 0.75, 1]).toContain(result.normalizedScore);
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("scores different task categories using appropriate cues", async () => {
    const bundleDir = makeBundleDir(
      "# Skill\nconflict resolution evidence hypothesis investigation ownership handoff output context routing action"
    );
    try {
      const executor = createMockExecutor();

      const investigationInput = makeTask({
        task_id: "functional_investigation_001",
        category: "structured_reasoning",
        prompt_text: "Investigate a production issue with structured hypotheses.",
        rubric_text: "0 no investigation\n4 comprehensive investigation with evidence"
      });
      investigationInput.bundleDir = bundleDir;
      const investigationResult = await executor.run(investigationInput);
      expect(investigationResult.status).toBe("valid");
      expect(investigationResult.normalizedScore).toBeGreaterThan(0);

      const handoffInput = makeTask({
        task_id: "functional_handoff_001",
        category: "handoff_quality",
        prompt_text: "Produce a handoff artifact with ownership and context.",
        rubric_text: "0 no handoff\n4 durable handoff artifact"
      });
      handoffInput.bundleDir = bundleDir;
      const handoffResult = await executor.run(handoffInput);
      expect(handoffResult.status).toBe("valid");
      expect(handoffResult.normalizedScore).toBeGreaterThan(0);
    } finally {
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it("handles empty bundle directory gracefully", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-mock-empty-"));
    try {
      const executor = createMockExecutor();
      const input = makeTask();
      input.bundleDir = emptyDir;
      const result = await executor.run(input);
      expect(result.status).toBe("valid");
      expect(result.normalizedScore).toBe(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
