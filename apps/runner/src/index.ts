import path from "node:path";
import {
  collectDiagnostics,
  compareLibrariesRun,
  createCodexExecutor,
  createMockExecutor,
  listProfiles,
  loadEloLedger,
  renderLeaderboard,
  renderMatchHistory,
  replaceFromRun,
  showRun,
  type ComparisonScenario,
  SCENARIO_REGISTRY
} from "@watchtower/core";

type CommandContext = {
  allowlistedParentRoot: string;
  dataRoot: string;
  executorKind: "mock" | "codex";
};

function parseFlags(argv: string[]): { command: string; positionals: string[]; flags: Map<string, string> } {
  const [command = "profiles", ...rest] = argv;
  const flags = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value.startsWith("--")) {
      const [key, inlineValue] = value.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
      } else {
        const next = rest[index + 1];
        if (!next || next.startsWith("--")) {
          flags.set(key, "true");
        } else {
          flags.set(key, next);
          index += 1;
        }
      }
    } else {
      positionals.push(value);
    }
  }

  return { command, positionals, flags };
}

function getContext(flags: Map<string, string>): CommandContext {
  const dataRoot =
    flags.get("data-root") ??
    process.env.WATCHTOWER_DATA_ROOT ??
    path.join(process.cwd(), "watchtower-data");

  return {
    allowlistedParentRoot:
      flags.get("allowlist-root") ??
      process.env.WATCHTOWER_ALLOWLIST_ROOT ??
      process.cwd(),
    dataRoot,
    executorKind:
      (flags.get("executor") as "mock" | "codex" | undefined) ??
      ((process.env.WATCHTOWER_EXECUTOR as "mock" | "codex" | undefined) ?? "codex")
  };
}

function getExecutor(kind: "mock" | "codex") {
  return kind === "codex" ? createCodexExecutor() : createMockExecutor();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printText(value: string): void {
  process.stdout.write(`${value.trimEnd()}\n`);
}

function renderProfiles(): string {
  const diagnostics = collectDiagnostics();
  const profileLines = listProfiles().map((profile) =>
    `- ${profile.profile_id}${profile.is_default ? " (default)" : ""}: ${profile.description}`
  );

  return [
    "# Watchtower Profiles",
    "",
    ...profileLines,
    "",
    "# Diagnostics",
    `- Codex path: ${diagnostics.codexPath ?? "not found"}`,
    `- WSL: ${diagnostics.wslStatus}`,
    `- Launch configured: ${diagnostics.launchConfigured ? "yes" : "no"}`,
    `- Real executor ready: ${diagnostics.realExecutorReady ? "yes" : "no"}`
  ].join("\n");
}

function requireRealExecutorReady(executorKind: "mock" | "codex"): void {
  if (executorKind !== "codex") {
    return;
  }
  const diagnostics = collectDiagnostics();
  if (!diagnostics.realExecutorReady) {
    throw new Error(
      "Real executor is not ready. Configure WATCHTOWER_CODEX_LAUNCH and verify WSL is available, or use --executor mock only for development/tests."
    );
  }
}

function resolveScenario(flags: Map<string, string>): {
  comparisonMode: "same_library" | "cross_library";
  comparisonScenario?: ComparisonScenario;
} {
  const scenarioFlag = flags.get("scenario") as ComparisonScenario | undefined;

  if (scenarioFlag) {
    const meta = SCENARIO_REGISTRY.find((s) => s.scenario === scenarioFlag);
    if (!meta) {
      const valid = SCENARIO_REGISTRY.map((s) => s.scenario).join(", ");
      throw new Error(`Unknown scenario '${scenarioFlag}'. Valid: ${valid}`);
    }
    // Scenario implies mode, but explicit --same-library overrides
    const modeOverride = flags.get("same-library") === "true" ? "same_library" : undefined;
    return {
      comparisonMode: modeOverride ?? meta.implied_mode,
      comparisonScenario: scenarioFlag
    };
  }

  // No scenario — fall back to legacy mode flag
  return {
    comparisonMode: flags.get("same-library") === "true" ? "same_library" : "cross_library"
  };
}

async function run(): Promise<void> {
  const parsed = parseFlags(process.argv.slice(2));
  const context = getContext(parsed.flags);
  const jsonMode = parsed.flags.get("json") === "true";

  switch (parsed.command) {
    case "profiles": {
      if (jsonMode) {
        printJson({
          profiles: listProfiles(),
          scenarios: SCENARIO_REGISTRY,
          diagnostics: collectDiagnostics()
        });
      } else {
        const scenarioLines = SCENARIO_REGISTRY.map(
          (s) => `- ${s.scenario} (${s.implied_mode}): ${s.description}`
        );
        printText([
          renderProfiles(),
          "",
          "# Comparison Scenarios",
          "",
          ...scenarioLines
        ].join("\n"));
      }
      return;
    }

    case "compare": {
      const leftPath = parsed.flags.get("left") ?? parsed.positionals[0];
      const rightPath = parsed.flags.get("right") ?? parsed.positionals[1];
      if (!leftPath || !rightPath) {
        throw new Error(
          "Missing compare paths. Use: compare <leftPath> <rightPath> [--profile <id>] [--scenario <type>] [--same-library]"
        );
      }

      requireRealExecutorReady(context.executorKind);
      const { comparisonMode, comparisonScenario } = resolveScenario(parsed.flags);

      const runBundle = await compareLibrariesRun({
        leftRootPath: leftPath,
        rightRootPath: rightPath,
        profileId: parsed.flags.get("profile") ?? undefined,
        comparisonMode,
        comparisonScenario,
        leftLabel: parsed.flags.get("left-label") ?? undefined,
        rightLabel: parsed.flags.get("right-label") ?? undefined,
        allowlistedParentRoot: context.allowlistedParentRoot,
        dataRoot: context.dataRoot,
        executor: getExecutor(context.executorKind),
        updateElo: parsed.flags.get("no-elo") !== "true"
      });

      if (jsonMode) {
        printJson(runBundle);
      } else {
        printText(showRun(context.dataRoot, runBundle.run_id).reportText);
      }
      return;
    }

    case "show": {
      const runId = parsed.flags.get("run-id") ?? parsed.positionals[0];
      if (!runId) {
        throw new Error("Missing run id. Use: show <run-id>");
      }
      const result = showRun(context.dataRoot, runId);
      if (jsonMode) {
        printJson(result.run);
      } else {
        printText(result.reportText);
      }
      return;
    }

    case "replace": {
      const runId = parsed.flags.get("run-id") ?? parsed.positionals[0];
      const winnerTo = parsed.flags.get("winner-to") as "left" | "right" | undefined;
      if (!runId || !winnerTo) {
        throw new Error("Missing replace arguments. Use: replace <run-id> --winner-to <left|right> --confirm");
      }
      const result = replaceFromRun(context.dataRoot, runId, winnerTo, parsed.flags.get("confirm") === "true");
      if (jsonMode) {
        printJson(result);
      } else {
        printText(
          [
            "# Watchtower Replace",
            "",
            `- Run: ${result.run_id}`,
            `- Source side: ${result.source_side}`,
            `- Target side: ${result.target_side}`,
            `- Target root: ${result.target_root}`,
            `- Archive: ${result.archive_dir}`,
            `- Report: ${result.report_path}`,
            "",
            result.summary
          ].join("\n")
        );
      }
      return;
    }

    case "leaderboard": {
      const ledger = loadEloLedger(context.dataRoot);
      if (jsonMode) {
        printJson(ledger.entries.sort((a, b) => b.elo - a.elo));
      } else {
        printText(renderLeaderboard(ledger));
      }
      return;
    }

    case "history": {
      const ledger = loadEloLedger(context.dataRoot);
      const limit = parseInt(parsed.flags.get("limit") ?? "20", 10);
      if (jsonMode) {
        printJson(ledger.history.slice(-limit).reverse());
      } else {
        printText(renderMatchHistory(ledger, limit));
      }
      return;
    }

    case "help": {
      printText([
        "# Watchtower CLI",
        "",
        "Commands:",
        "  profiles                     List benchmark profiles and scenarios",
        "  compare <left> <right>       Compare two skill libraries (local path or GitHub URL)",
        "    --profile <id>             Benchmark profile (default, lead-producer, etc.)",
        "    --scenario <type>          Comparison scenario (head_to_head, version_upgrade, etc.)",
        "    --same-library             Treat as same library (enables replace)",
        "    --left-label <name>        Label for left side",
        "    --right-label <name>       Label for right side",
        "    --executor <mock|codex>    Executor type (default: codex)",
        "    --no-elo                   Skip Elo rating update",
        "    --json                     Output as JSON",
        "  show <run-id>               Re-read a stored run",
        "  replace <run-id>            Replace loser with winner",
        "    --winner-to <left|right>   Which side gets replaced",
        "    --confirm                  Required safety flag",
        "  leaderboard                  Show Elo rankings",
        "  history                      Show match history",
        "    --limit <n>                Number of recent matches (default: 20)",
        "",
        "Global flags:",
        "  --data-root <path>           Data storage directory",
        "  --allowlist-root <path>      Allowed parent root for workspace paths",
        "  --json                       JSON output mode",
        "",
        "Source formats for compare:",
        "  /local/path                  Local filesystem path",
        "  github://owner/repo          GitHub repo (default branch)",
        "  github://owner/repo@branch   GitHub repo at specific branch/tag",
        "  github://owner/repo#sha      GitHub repo at specific commit",
        "  https://github.com/owner/repo  GitHub URL (auto-detected)"
      ].join("\n"));
      return;
    }

    default:
      throw new Error(
        `Unknown command: ${parsed.command}. Run 'help' for usage. Available: profiles, compare, show, replace, leaderboard, history, help`
      );
  }
}

run().catch((error) => {
  printJson({
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
