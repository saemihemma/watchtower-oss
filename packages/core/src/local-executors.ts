import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, sha256Bytes, walkFiles } from "./files.js";
import { lookupMockCues } from "./profile-loader.js";
import {
  type Executor,
  type ExecutorInput,
  type ExecutorKind,
  type ExecutorOutput,
  type LaunchShell,
  type ProviderDiagnostics,
  type WatchtowerDiagnostics
} from "./schemas.js";

type RealExecutorKind = Exclude<ExecutorKind, "mock">;

type ProviderExecutorOptions = {
  launchCommand?: string;
  launchShell?: LaunchShell;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

type DiagnosticsOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probeExecutable?: (command: string, platform: NodeJS.Platform) => string | null;
};

const PROVIDER_ENV: Record<RealExecutorKind, string> = {
  codex: "WATCHTOWER_CODEX_LAUNCH",
  claude: "WATCHTOWER_CLAUDE_LAUNCH"
};

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Collect text from a skill library bundle for mock executor scoring.
 *
 * Reads up to 80 text-format files (md, yaml, yml, toml, json, txt),
 * truncating each to 5000 chars. These limits keep mock scoring fast
 * and memory-bounded while capturing enough signal for keyword matching.
 * The concatenated output is what the mock executor scores against.
 */
function collectBundleText(bundleDir: string): string {
  const entries = walkFiles(bundleDir).filter((entry) => /\.(md|yaml|yml|toml|json|txt)$/i.test(entry.relativePath));
  const chunks: string[] = [];
  for (const entry of entries.slice(0, 80)) {
    const text = fs.readFileSync(entry.absolutePath, "utf8").slice(0, 5000);
    chunks.push(`FILE:${entry.relativePath}\n${text}`);
  }
  return chunks.join("\n\n---\n\n");
}

const GENERIC_STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "with",
  "this",
  "from",
  "into",
  "they",
  "them",
  "their",
  "there",
  "should",
  "would",
  "could",
  "instead",
  "review",
  "library",
  "skill",
  "skills",
  "determine",
  "whether",
  "provide",
  "provides",
  "about",
  "clear",
  "clearly",
  "across",
  "among",
  "while",
  "where",
  "which",
  "when",
  "what",
  "your",
  "user",
  "users",
  "than",
  "have",
  "has",
  "only"
]);

function extractTextCues(text: string, minimumLength = 4, limit = 8): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= minimumLength && !GENERIC_STOPWORDS.has(token));

  return [...new Set(tokens)].slice(0, limit);
}

/** Built-in cue mappings for default profile task ID prefixes. */
const BUILTIN_CUE_TABLE: Array<{ match: (id: string) => boolean; cues: string[] }> = [
  { match: (id) => id.includes("usage") || id.includes("discovery"), cues: ["use", "best", "discover", "overlap"] },
  { match: (id) => id.includes("boundary"), cues: ["boundary", "scope", "overlap", "responsibilities"] },
  { match: (id) => id.includes("review"), cues: ["evidence", "verify", "acceptance", "examples", "steps"] },
  { match: (id) => id.includes("handoff"), cues: ["handoff", "output", "context", "next", "action"] },
  { match: (id) => id.includes("arch_"), cues: ["structure", "layer", "compose", "dependency", "delegate", "ownership"] },
  { match: (id) => id.includes("hygiene_"), cues: ["lean", "bloat", "replace", "accumulate", "minimal", "sharp"] },
  { match: (id) => id.includes("constraint_"), cues: ["ambiguous", "partial", "degrade", "fallback", "missing", "graceful"] }
];

function taskCueSet(input: ExecutorInput): string[] {
  const taskId = input.task.task_id.toLowerCase();
  const promptCues = extractTextCues(input.promptText);
  const rubricCues = extractTextCues(input.rubricText ?? "", 5, 6);

  // Check the extensible mock cue registry first (custom profiles register cues here)
  const registryCues = lookupMockCues(input.task.task_id);
  if (registryCues) {
    return [...new Set([...registryCues, ...promptCues, ...rubricCues])];
  }

  // Fall back to built-in cue table
  for (const entry of BUILTIN_CUE_TABLE) {
    if (entry.match(taskId)) {
      return [...new Set([...entry.cues, ...promptCues, ...rubricCues])];
    }
  }

  return [...new Set([...promptCues, ...rubricCues, "benchmark", "quality", "guidance"])];
}

/**
 * Compute a mock executor score for a single task trial.
 *
 * Scoring strategy:
 * 1. Collect text from the skill library bundle (up to 80 files, 5000 chars each).
 * 2. Resolve cue keywords for this task: check the mock cue registry first (custom
 *    profiles register cues here), then fall back to the built-in cue table, then
 *    extract keywords from the prompt and rubric text.
 * 3. Count how many cues appear in the bundle text. Base score = matched / total cues.
 * 4. Add deterministic jitter derived from SHA-256 of the bundle+prompt+task+side.
 *    Jitter range: [-0.04, +0.04], ensuring scores vary slightly across sides and
 *    trials without randomness. Formula: ((hash_prefix_int % 9) - 4) / 100.
 * 5. For rubric tasks: quantize to 0–4 scale (0, 0.25, 0.5, 0.75, 1.0).
 *    For deterministic tasks: binary pass/fail at 0.55 threshold.
 *
 * Mock scores are directional signals for development. They are not substitutes
 * for real executor evaluation on irreversible decisions.
 */
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

function renderProviderInstruction(provider: RealExecutorKind, input: ExecutorInput): string {
  return [
    `You are Watchtower Benchmark, running through the ${provider} executor.`,
    "Compare one side of a markdown skill library benchmark.",
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

function createTrialEnv(baseEnv: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  instructionPath: string;
} {
  const trialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchtower-trial-"));
  const toolHome = path.join(trialRoot, "tool-home");
  const homeDir = path.join(trialRoot, "home");
  const tempDir = path.join(trialRoot, "tmp");
  ensureDir(toolHome);
  ensureDir(homeDir);
  ensureDir(tempDir);
  const instructionPath = path.join(trialRoot, "instruction.txt");

  return {
    env: {
      ...baseEnv,
      CODEX_HOME: baseEnv.CODEX_HOME ?? toolHome,
      CLAUDE_HOME: baseEnv.CLAUDE_HOME ?? toolHome,
      HOME: homeDir,
      USERPROFILE: homeDir,
      TMP: tempDir,
      TEMP: tempDir,
      TMPDIR: tempDir
    },
    instructionPath
  };
}

function parseExecutorResult(provider: RealExecutorKind, stdout: string): ExecutorOutput {
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
      reason: `${provider}_output_parse_failed:${error instanceof Error ? error.message : "unknown"}`
    };
  }
}

export function resolveLaunchShell(
  platform: NodeJS.Platform = process.platform,
  preferredShell = process.env.WATCHTOWER_LAUNCH_SHELL
): LaunchShell {
  if (preferredShell === "powershell" || preferredShell === "cmd" || preferredShell === "sh") {
    return preferredShell;
  }
  return platform === "win32" ? "powershell" : "sh";
}

function shellCommand(shell: LaunchShell, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (shell === "cmd") {
    return { command: platform === "win32" ? "cmd.exe" : "cmd", args: ["/d", "/s", "/c"] };
  }
  if (shell === "powershell") {
    return {
      command: platform === "win32" ? "powershell.exe" : "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
    };
  }
  return { command: "/bin/sh", args: ["-lc"] };
}

function parseLaunchExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const quoted = trimmed.match(/^"([^"]+)"/);
  if (quoted) {
    return quoted[1];
  }

  const unquoted = trimmed.match(/^([^\s]+)/);
  return unquoted?.[1] ?? null;
}

function defaultBinaryForProvider(provider: RealExecutorKind): string {
  return provider;
}

function probeExecutableOnPath(command: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!command) {
    return null;
  }

  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(command);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const probe = platform === "win32"
    ? childProcess.spawnSync("where.exe", [command], { encoding: "utf8", timeout: 10_000 })
    : childProcess.spawnSync("which", [command], { encoding: "utf8", timeout: 10_000 });

  if (probe.status !== 0) {
    return null;
  }

  return probe.stdout.trim().split(/\r?\n/)[0] ?? null;
}

function resolveProviderLaunch(
  provider: RealExecutorKind,
  options: ProviderExecutorOptions = {}
): {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  launchCommand: string | null;
  launchShell: LaunchShell;
} {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    env,
    platform,
    launchCommand: options.launchCommand ?? env[PROVIDER_ENV[provider]] ?? null,
    launchShell: options.launchShell ?? resolveLaunchShell(platform, env.WATCHTOWER_LAUNCH_SHELL)
  };
}

function providerDiagnostics(
  provider: RealExecutorKind,
  options: DiagnosticsOptions = {}
): ProviderDiagnostics {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const launchCommand = env[PROVIDER_ENV[provider]] ?? null;
  const launchShell = resolveLaunchShell(platform, env.WATCHTOWER_LAUNCH_SHELL);
  const launcher = launchCommand ? parseLaunchExecutable(launchCommand) : defaultBinaryForProvider(provider);
  const probe = options.probeExecutable ?? probeExecutableOnPath;
  const launcherPath = launcher ? probe(launcher, platform) : null;

  return {
    provider,
    launch_configured: Boolean(launchCommand),
    launch_command: launchCommand,
    launch_shell: launchShell,
    launcher,
    launcher_path: launcherPath,
    ready: Boolean(launchCommand) && (launcher === null || launcherPath !== null)
  };
}

export function collectDiagnostics(options: DiagnosticsOptions = {}): WatchtowerDiagnostics {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    host_platform: platform,
    default_launch_shell: resolveLaunchShell(platform, env.WATCHTOWER_LAUNCH_SHELL),
    providers: {
      codex: providerDiagnostics("codex", options),
      claude: providerDiagnostics("claude", options)
    }
  };
}

function createProviderExecutor(provider: RealExecutorKind, options: ProviderExecutorOptions = {}): Executor {
  return {
    version: `${provider}-configurable-v4`,
    async run(input: ExecutorInput): Promise<ExecutorOutput> {
      const resolved = resolveProviderLaunch(provider, options);
      if (!resolved.launchCommand) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: `${provider}_launch_unconfigured`
        };
      }

      const trial = createTrialEnv(resolved.env);
      fs.writeFileSync(trial.instructionPath, renderProviderInstruction(provider, input), "utf8");

      const command = resolved.launchCommand
        .replaceAll("{instructionFile}", trial.instructionPath)
        .replaceAll("{bundleDir}", input.bundleDir);

      const shell = shellCommand(resolved.launchShell, resolved.platform);
      const result = childProcess.spawnSync(shell.command, [...shell.args, command], {
        cwd: input.bundleDir,
        env: trial.env,
        encoding: "utf8",
        timeout: 120_000
      });

      if (result.error) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: `${provider}_spawn_failed:${result.error.message}`
        };
      }
      if (result.status !== 0) {
        return {
          normalizedScore: null,
          falsePositive: 0,
          status: "failed",
          reason: `${provider}_exit_${result.status}:${(result.stderr || result.stdout).trim().slice(0, 240)}`
        };
      }

      return parseExecutorResult(provider, result.stdout);
    }
  };
}

export function createCodexExecutor(options: ProviderExecutorOptions = {}): Executor {
  return createProviderExecutor("codex", options);
}

export function createClaudeExecutor(options: ProviderExecutorOptions = {}): Executor {
  return createProviderExecutor("claude", options);
}
