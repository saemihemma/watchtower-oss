import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, sha256Bytes, walkFiles } from "./files.js";
import { type Executor, type ExecutorInput, type ExecutorOutput } from "./schemas.js";

type CodexExecutorOptions = {
  launchCommand?: string;
};

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function collectBundleText(bundleDir: string): string {
  const entries = walkFiles(bundleDir).filter(
    (entry) => /\.(md|yaml|yml|toml|json|txt)$/i.test(entry.relativePath)
  );
  const chunks: string[] = [];
  for (const entry of entries.slice(0, 80)) {
    const text = fs.readFileSync(entry.absolutePath, "utf8").slice(0, 5000);
    chunks.push(`FILE:${entry.relativePath}\n${text}`);
  }
  return chunks.join("\n\n---\n\n");
}

function taskCueSet(input: ExecutorInput): string[] {
  const family = input.task.family.toLowerCase();
  const taskId = input.task.task_id.toLowerCase();
  const prompt = input.promptText.toLowerCase();

  if (family === "default" || taskId.startsWith("default_")) {
    if (taskId.includes("usage") || taskId.includes("discovery")) {
      return ["use when", "do not use", "best for", "not for", "when to use"];
    }
    if (taskId.includes("boundary")) {
      return ["what it is", "what it is not", "scope", "boundaries", "overlap"];
    }
    if (taskId.includes("review")) {
      return ["evidence", "verify", "acceptance", "example", "steps"];
    }
    if (taskId.includes("handoff")) {
      return ["next action", "output", "handoff", "deliverable", "context"];
    }
  }

  if (family.includes("lead-producer") || taskId.startsWith("lp_") || prompt.includes("devil's advocate")) {
    return [
      "Lead Producer",
      "Devil's Advocate",
      "Stress Test",
      "Acceptance",
      "What It Is",
      "What It Is NOT",
      "smallest sufficient",
      "open questions"
    ];
  }
  if (family.includes("product") || taskId.startsWith("product_")) {
    return ["Product", "scope", "feasibility", "go/no-go", "trade-off"];
  }
  if (family.includes("dev") || taskId.startsWith("dev_")) {
    return ["architecture", "code quality", "tests", "verification", "review"];
  }
  if (family.includes("issue-triage") || family.includes("workflow") || taskId.startsWith("triage_")) {
    return ["handoff", "next steps", "investigation", "owner", "context"];
  }
  return ["skill", "benchmark", "review"];
}

function computeMockOutcome(input: ExecutorInput): ExecutorOutput {
  const bundleText = collectBundleText(input.bundleDir);
  const cues = taskCueSet(input);
  const matched = cues.filter((cue) => bundleText.toLowerCase().includes(cue.toLowerCase())).length;
  const bundleDigest = sha256Bytes(
    `${bundleText}\n${input.promptText}\n${input.rubricText ?? ""}\n${input.task.task_id}\n${input.sideId}`
  );
  const jitterSeed = Number.parseInt(bundleDigest.slice(0, 8), 16);
  const jitter = ((jitterSeed % 9) - 4) / 100;
  const base = matched / Math.max(cues.length, 1);
  const score = bounded(base + jitter, 0, 1);

  if (input.task.evaluator_kind === "deterministic") {
    const pass = score >= 0.55 ? 1 : 0;
    return {
      normalizedScore: pass,
      falsePositive: pass as 0 | 1,
      status: "valid"
    };
  }

  const rubricScore = Math.round(score * 4);
  const normalizedScore = rubricScore / 4;
  return {
    normalizedScore,
    falsePositive: 0,
    status: "valid"
  };
}

export function createMockExecutor(): Executor {
  return {
    version: "mock-v3",
    async run(input: ExecutorInput): Promise<ExecutorOutput> {
      return computeMockOutcome(input);
    }
  };
}

function renderCodexInstruction(input: ExecutorInput): string {
  return [
    "You are Watchtower Benchmark, comparing one side of a markdown skill library benchmark.",
    `Task ID: ${input.task.task_id}`,
    `Task Version: ${input.task.task_version}`,
    `Task Family: ${input.task.family}`,
    `Task Category: ${input.task.category}`,
    `Evaluator Kind: ${input.task.evaluator_kind}`,
    `Side: ${input.sideId}`,
    `Bundle Directory: ${input.bundleDir}`,
    "",
    "Read the bundle directory and score the task.",
    "Return JSON only with keys: normalizedScore, falsePositive, status, reason.",
    "normalizedScore must be 0, 0.25, 0.5, 0.75, or 1 for rubric tasks; 0 or 1 for deterministic tasks.",
    "falsePositive must be 0 or 1.",
    "status must be valid or failed.",
    "",
    "TASK PROMPT",
    input.promptText,
    "",
    "RUBRIC",
    input.rubricText ?? "No rubric file. Use pass/fail reasoning only."
  ].join("\n");
}

function createTrialEnv(): {
  env: NodeJS.ProcessEnv;
  instructionPath: string;
} {
  const trialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-trial-"));
  const codexHome = path.join(trialRoot, "codex-home");
  const homeDir = path.join(trialRoot, "home");
  const tempDir = path.join(trialRoot, "tmp");
  ensureDir(codexHome);
  ensureDir(homeDir);
  ensureDir(tempDir);
  const instructionPath = path.join(trialRoot, "instruction.txt");

  return {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      TMP: tempDir,
      TEMP: tempDir,
      TMPDIR: tempDir
    },
    instructionPath
  };
}

function parseCodexResult(stdout: string): ExecutorOutput {
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      normalizedScore?: number;
      falsePositive?: number;
      status?: "valid" | "failed";
      reason?: string;
    };
    if (parsed.status !== "valid" && parsed.status !== "failed") {
      throw new Error("Missing status.");
    }
    return {
      normalizedScore: parsed.normalizedScore ?? null,
      falsePositive: parsed.falsePositive === 1 ? 1 : 0,
      status: parsed.status,
      reason: parsed.reason
    };
  } catch (error) {
    return {
      normalizedScore: null,
      falsePositive: 0,
      status: "failed",
      reason: `codex_output_parse_failed:${error instanceof Error ? error.message : "unknown"}`
    };
  }
}

export function createCodexExecutor(options: CodexExecutorOptions = {}): Executor {
  return {
    version: "codex-configurable-v3",
    async run(input: ExecutorInput): Promise<ExecutorOutput> {
      const launchCommand = options.launchCommand ?? process.env.WATCHTOWER_CODEX_LAUNCH;
      if (!launchCommand) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: "codex_launch_unconfigured"
        };
      }

      const trial = createTrialEnv();
      fs.writeFileSync(trial.instructionPath, renderCodexInstruction(input), "utf8");

      const command = launchCommand
        .replaceAll("{instructionFile}", trial.instructionPath)
        .replaceAll("{bundleDir}", input.bundleDir);

      const result = childProcess.spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
        cwd: input.bundleDir,
        env: trial.env,
        encoding: "utf8",
        timeout: 120000
      });

      if (result.error) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: `codex_spawn_failed:${result.error.message}`
        };
      }
      if (result.status !== 0) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: `codex_exit_${result.status}:${(result.stderr || result.stdout).trim().slice(0, 240)}`
        };
      }

      return parseCodexResult(result.stdout);
    }
  };
}

export function collectDiagnostics(): {
  codexPath: string | null;
  wslStatus: "available" | "missing";
  launchConfigured: boolean;
  realExecutorReady: boolean;
} {
  const whereResult = childProcess.spawnSync("cmd.exe", ["/d", "/s", "/c", "where codex"], {
    encoding: "utf8"
  });
  const codexPath =
    whereResult.status === 0 ? whereResult.stdout.trim().split(/\r?\n/)[0] ?? null : null;

  const wslResult = childProcess.spawnSync("wsl.exe", ["--status"], {
    encoding: "utf8",
    timeout: 10000
  });
  const launchConfigured = Boolean(process.env.WATCHTOWER_CODEX_LAUNCH);
  const wslStatus = wslResult.status === 0 ? "available" : "missing";

  return {
    codexPath,
    wslStatus,
    launchConfigured,
    realExecutorReady: launchConfigured && wslStatus === "available"
  };
}
