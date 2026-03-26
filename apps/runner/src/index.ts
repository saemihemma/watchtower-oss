#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  batchTrialsToDataset,
  calibrateIRT,
  collectDiagnostics,
  createClaudeExecutor,
  compareLibrariesRun,
  createCodexExecutor,
  createCompositionScorer,
  createCVScorer,
  createMockExecutor,
  estimateBatchCost,
  getBenchmarkProfile,
  getDataPaths,
  listProfiles,
  loadCalibrationReport,
  loadEloLedger,
  loadProfileFromFile,
  loadRun,
  registerExtensionScorer,
  registerMockCuesFromProfile,
  registerProfile,
  renderLeaderboard,
  renderMatchHistory,
  renderTournamentResult,
  replaceFromRun,
  runBatch,
  runTournament,
  showRun,
  subsetProfileByCategories,
  writeCalibrationReport,
  writeJson,
  ensureDir,
  type ExecutorKind,
  type ComparisonScenario,
  type ComparisonRun,
  type BatchOutput,
  type ExternalProfileDefinition,
  BATCH_CONFIRM_THRESHOLD,
  BATCH_MAX_PARALLEL,
  BATCH_MAX_RUNS,
  IRT_MIN_TRIALS,
  IRT_MIN_BUNDLES,
  SCENARIO_REGISTRY
} from "@watchtower-bench/core";

// Register extension scorers at module top-level.
// Scorers only fire when a task has matching extensions (graceful degradation).
registerExtensionScorer(createCVScorer());
registerExtensionScorer(createCompositionScorer());

type CommandContext = {
  allowlistedParentRoot: string;
  dataRoot: string;
  executorKind: ExecutorKind;
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
  const callerCwd = process.env.WATCHTOWER_CALLER_CWD ?? process.env.INIT_CWD ?? process.cwd();
  const dataRoot =
    flags.get("data-root") ??
    process.env.WATCHTOWER_DATA_ROOT ??
    path.join(callerCwd, "watchtower-data");

  return {
    allowlistedParentRoot:
      flags.get("allowlist-root") ??
      process.env.WATCHTOWER_ALLOWLIST_ROOT ??
      callerCwd,
    dataRoot,
    executorKind:
      (flags.get("executor") as ExecutorKind | undefined) ??
      ((process.env.WATCHTOWER_EXECUTOR as ExecutorKind | undefined) ?? "mock")
  };
}

function getExecutor(kind: ExecutorKind) {
  if (kind === "codex") {
    return createCodexExecutor();
  }
  if (kind === "claude") {
    return createClaudeExecutor();
  }
  return createMockExecutor();
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
  const providerLines = Object.values(diagnostics.providers).flatMap((provider) => [
    `- ${provider.provider}: ready=${provider.ready ? "yes" : "no"}, configured=${provider.launch_configured ? "yes" : "no"}, shell=${provider.launch_shell}, launcher=${provider.launcher ?? "unknown"}, resolved=${provider.launcher_path ?? "not found"}`
  ]);

  return [
    "# Watchtower Profiles",
    "",
    ...profileLines,
    "",
    "# Diagnostics",
    `- Host platform: ${diagnostics.host_platform}`,
    `- Default launch shell: ${diagnostics.default_launch_shell}`,
    ...providerLines
  ].join("\n");
}

/**
 * Resolve the effective profile ID from flags.
 * Handles --profile-file (load from JSON), --categories (subset), and --profile (built-in).
 * Returns the profile ID to pass to the engine.
 */
function resolveProfileFromFlags(flags: Map<string, string>): string | undefined {
  const profileFile = flags.get("profile-file");
  const categoriesFlag = flags.get("categories");
  let profileId = flags.get("profile") ?? undefined;

  // Load custom profile from file
  if (profileFile) {
    const customProfile = loadProfileFromFile(profileFile);
    // Register mock cues if the file included them
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.resolve(profileFile), "utf8")
      ) as ExternalProfileDefinition;
      registerMockCuesFromProfile(raw);
    } catch {
      // Cue registration is best-effort; profile still works with generic cues
    }
    registerProfile(customProfile);
    profileId = customProfile.profile_id;
  }

  // Apply category subset
  if (categoriesFlag) {
    const categories = categoriesFlag.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
    if (categories.length === 0) {
      throw new Error("--categories flag requires at least one category name (comma-separated).");
    }
    const baseProfile = getBenchmarkProfile(profileId);
    const subsetted = subsetProfileByCategories(baseProfile, categories);
    registerProfile(subsetted);
    profileId = subsetted.profile_id;
  }

  return profileId;
}

function requireRealExecutorReady(executorKind: ExecutorKind): void {
  if (executorKind === "mock") {
    return;
  }
  const diagnostics = collectDiagnostics();
  const provider = diagnostics.providers[executorKind];
  if (!provider.ready) {
    const envVar = executorKind === "codex" ? "WATCHTOWER_CODEX_LAUNCH" : "WATCHTOWER_CLAUDE_LAUNCH";
    throw new Error(
      `Real executor '${executorKind}' is not ready. Configure ${envVar} and verify the launcher is available, or use --executor mock only for development/tests.`
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
      const resolvedProfileId = resolveProfileFromFlags(parsed.flags);

      // Load IRT calibration if --irt flag provided
      const irtPath = parsed.flags.get("irt") ?? undefined;
      let irtCalibration;
      if (irtPath) {
        const resolvedIrtPath = path.resolve(irtPath);
        irtCalibration = loadCalibrationReport(resolvedIrtPath);
        if (irtCalibration.version !== 1) {
          throw new Error(`IRT calibration version mismatch: expected 1, got ${irtCalibration.version}.`);
        }
        // Warn if profile mismatch
        const effectiveProfileId = resolvedProfileId ?? "default";
        if (irtCalibration.profile_id !== effectiveProfileId) {
          process.stderr.write(
            `Warning: IRT calibration was built for profile '${irtCalibration.profile_id}', but comparison uses '${effectiveProfileId}'.\n`
          );
        }
      }

      const runBundle = await compareLibrariesRun({
        leftRootPath: leftPath,
        rightRootPath: rightPath,
        profileId: resolvedProfileId,
        comparisonMode,
        comparisonScenario,
        leftLabel: parsed.flags.get("left-label") ?? undefined,
        rightLabel: parsed.flags.get("right-label") ?? undefined,
        allowlistedParentRoot: context.allowlistedParentRoot,
        dataRoot: context.dataRoot,
        executor: getExecutor(context.executorKind),
        updateElo: parsed.flags.get("no-elo") !== "true",
        irtCalibration
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
      if (parsed.flags.get("confirm") !== "true") {
        throw new Error(
          "Replace is a destructive operation. Add --confirm to proceed.\n" +
          `  This will archive the losing side and overwrite it with the winner from run ${runId}.`
        );
      }
      const result = replaceFromRun(context.dataRoot, runId, winnerTo, true);
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

    case "tournament": {
      if (parsed.positionals.length < 2) {
        throw new Error(
          "Tournament requires at least 2 competitors. Use: tournament <source1> <source2> [source3...sourceN] [--profile <id>] [--executor <mock|codex|claude>] [--seed <number>]"
        );
      }
      if (parsed.positionals.length > 16) {
        throw new Error("Tournament supports a maximum of 16 competitors.");
      }

      requireRealExecutorReady(context.executorKind);

      const seedValue = parseInt(parsed.flags.get("seed") ?? "42", 10);
      if (!Number.isFinite(seedValue)) {
        throw new Error(`Invalid seed value '${parsed.flags.get("seed")}'. Must be a finite number.`);
      }
      const seed = seedValue;
      const resolvedTournamentProfileId = resolveProfileFromFlags(parsed.flags);
      const tournamentResult = await runTournament({
        sources: parsed.positionals,
        profileId: resolvedTournamentProfileId,
        executor: getExecutor(context.executorKind),
        allowlistedParentRoot: context.allowlistedParentRoot,
        dataRoot: context.dataRoot,
        updateElo: parsed.flags.get("no-elo") !== "true",
        randomSeed: seed,
        onProgress: jsonMode ? undefined : (msg) => process.stderr.write(`  ${msg}\n`)
      });

      if (jsonMode) {
        printJson(tournamentResult);
      } else {
        printText(renderTournamentResult(tournamentResult));
      }
      return;
    }

    case "batch": {
      const leftPath = parsed.flags.get("left") ?? parsed.positionals[0];
      const rightPath = parsed.flags.get("right") ?? parsed.positionals[1];
      if (!leftPath || !rightPath) {
        throw new Error(
          "Missing batch paths. Use: batch <left> <right> [--runs N] [--parallel N]"
        );
      }

      // Parse and validate --runs
      const runsStr = parsed.flags.get("runs") ?? "10";
      const totalRuns = parseInt(runsStr, 10);
      if (!Number.isFinite(totalRuns) || totalRuns < 1 || totalRuns > BATCH_MAX_RUNS) {
        throw new Error(`--runs must be between 1 and ${BATCH_MAX_RUNS}. Got: ${runsStr}`);
      }

      // Parse and clamp --parallel
      let parallel = parseInt(parsed.flags.get("parallel") ?? "4", 10);
      if (!Number.isFinite(parallel) || parallel < 1) {
        process.stderr.write(`Warning: --parallel clamped from ${parsed.flags.get("parallel")} to 1.\n`);
        parallel = 1;
      } else if (parallel > BATCH_MAX_PARALLEL) {
        process.stderr.write(`Warning: --parallel clamped from ${parallel} to ${BATCH_MAX_PARALLEL}.\n`);
        parallel = BATCH_MAX_PARALLEL;
      }

      requireRealExecutorReady(context.executorKind);

      // Real executor cost gate
      if (context.executorKind !== "mock" && totalRuns > BATCH_CONFIRM_THRESHOLD) {
        if (parsed.flags.get("confirm") !== "true") {
          const profile = getBenchmarkProfile(resolveProfileFromFlags(parsed.flags));
          const cost = estimateBatchCost(context.executorKind, totalRuns, profile.tasks.length);
          throw new Error(
            `Batch of ${totalRuns} runs with ${context.executorKind} executor estimated at ${cost}. Add --confirm to proceed.`
          );
        }
      }

      const { comparisonMode, comparisonScenario } = resolveScenario(parsed.flags);
      const batchProfileId = resolveProfileFromFlags(parsed.flags);

      // SIGINT handler for graceful stop
      let stopRequested = false;
      const sigintHandler = () => { stopRequested = true; };
      process.on("SIGINT", sigintHandler);

      const batchStartTime = Date.now();

      try {
        const batchResult = await runBatch({
          totalRuns,
          parallel,
          retryOnFail: 1,
          shouldStop: () => stopRequested,
          onRunComplete: (runId, index, total) => {
            if (!jsonMode) {
              const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
              process.stderr.write(`[${index}/${total}] Run ${runId} completed (${elapsed}s)\n`);
            }
          },
          runFn: async () => {
            const run = await compareLibrariesRun({
              leftRootPath: leftPath,
              rightRootPath: rightPath,
              profileId: batchProfileId,
              comparisonMode,
              comparisonScenario,
              leftLabel: parsed.flags.get("left-label") ?? undefined,
              rightLabel: parsed.flags.get("right-label") ?? undefined,
              allowlistedParentRoot: context.allowlistedParentRoot,
              dataRoot: context.dataRoot,
              executor: getExecutor(context.executorKind),
              updateElo: parsed.flags.get("no-elo") !== "true"
            });
            return run.run_id;
          }
        });

        // Assemble BatchOutput from completed runs
        const paths = getDataPaths(context.dataRoot);
        const batchOutput: BatchOutput = {
          version: 1,
          batchId: batchResult.batchId,
          profileId: batchProfileId ?? "default",
          left: leftPath,
          right: rightPath,
          createdAt: new Date().toISOString(),
          runs: batchResult.runIds.map(runId => {
            const run = loadRun(context.dataRoot, runId);
            return { runId, taskTrialResults: run.task_trial_results };
          }),
          summary: {
            completed: batchResult.completed,
            failed: batchResult.failed,
            retried: batchResult.retried,
            wallClockMs: batchResult.wallClockMs
          }
        };

        // Persist batch output
        ensureDir(paths.batchesRoot);
        const batchPath = path.join(paths.batchesRoot, `${batchResult.batchId}.json`);
        writeJson(batchPath, batchOutput);

        if (jsonMode) {
          printJson(batchOutput);
        } else {
          const profile = getBenchmarkProfile(batchProfileId);
          const cost = estimateBatchCost(context.executorKind, batchResult.completed, profile.tasks.length);
          printText([
            "# Watchtower Batch Complete",
            "",
            `- Batch ID: ${batchResult.batchId}`,
            `- Completed: ${batchResult.completed}`,
            `- Failed: ${batchResult.failed}`,
            `- Retried: ${batchResult.retried}`,
            `- Wall clock: ${(batchResult.wallClockMs / 1000).toFixed(1)}s`,
            `- Estimated cost: ${cost}`,
            batchResult.stoppedEarly ? "- Stopped early (SIGINT)" : "",
            "",
            `Batch file: ${batchPath}`
          ].filter(Boolean).join("\n"));
        }
      } finally {
        process.removeListener("SIGINT", sigintHandler);
      }
      return;
    }

    case "calibrate": {
      const batchId = parsed.flags.get("batch") ?? parsed.positionals[0];
      if (!batchId) {
        throw new Error("Missing batch ID. Use: calibrate --batch <batch-id>");
      }

      const paths = getDataPaths(context.dataRoot);
      const batchPath = path.join(paths.batchesRoot, `${batchId}.json`);
      if (!fs.existsSync(batchPath)) {
        throw new Error(`Batch ${batchId} not found in ${paths.batchesRoot}.`);
      }

      const batchData = JSON.parse(fs.readFileSync(batchPath, "utf8")) as BatchOutput;

      if (batchData.version !== 1) {
        throw new Error(
          `Batch format version mismatch: expected 1, got ${batchData.version ?? "undefined"}. This batch file may have been created by a newer version of Watchtower.`
        );
      }

      if (batchData.runs.length === 0) {
        throw new Error(`Batch ${batchId} has 0 completed runs. Cannot calibrate.`);
      }

      // Flatten trials into IRT dataset
      const { responses, validCount, taskIds } = batchTrialsToDataset(batchData.runs);

      // Minimum-data guard
      if (validCount < IRT_MIN_TRIALS) {
        throw new Error(
          `Need ≥${IRT_MIN_TRIALS} valid observations across ≥${IRT_MIN_BUNDLES} tasks; found ${validCount} observations across ${taskIds.length} tasks.`
        );
      }
      if (taskIds.length < IRT_MIN_BUNDLES) {
        throw new Error(
          `Need ≥${IRT_MIN_BUNDLES} distinct tasks; found ${taskIds.length}. Need ≥${IRT_MIN_TRIALS} valid observations; found ${validCount}.`
        );
      }

      // Resolve profile for catalog hash
      const calibProfileId = batchData.profileId;
      const calibProfile = getBenchmarkProfile(calibProfileId === "default" ? undefined : calibProfileId);

      const report = calibrateIRT({
        trialData: { items: taskIds, responses },
        profileId: calibProfile.profile_id,
        catalogHash: calibProfile.pack.catalog_hash
      });

      // Persist calibration report
      ensureDir(paths.calibrationsRoot);
      const reportPath = writeCalibrationReport(report, paths.calibrationsRoot);

      // Non-convergence warning
      if (!report.converged) {
        process.stderr.write(
          `Warning: IRT calibration did not converge after ${report.convergence_iterations} iterations across ${report.n_restarts} restarts. Results may be unreliable.\n`
        );
      }

      if (jsonMode) {
        printJson(report);
      } else {
        printText([
          "# Watchtower IRT Calibration Complete",
          "",
          `- Calibration ID: ${report.calibration_id}`,
          `- Profile: ${report.profile_id}`,
          `- Model selected: ${report.model_selected}`,
          `- Converged: ${report.converged ? "yes" : "no"}`,
          `- Iterations: ${report.convergence_iterations}`,
          `- Total observations: ${report.total_trials_used}`,
          `- Total respondents: ${report.total_bundles}`,
          `- Items calibrated: ${report.item_params.length}`,
          "",
          `Calibration file: ${reportPath}`
        ].join("\n"));
      }
      return;
    }

    case "help": {
      printText([
        "# Watchtower CLI",
        "",
        "Commands:",
        "  profiles                     List benchmark profiles and scenarios",
        "  compare <left> <right>       Compare two skill libraries (local path or GitHub source)",
        "    --profile <id>             Benchmark profile (default)",
        "    --profile-file <path>      Load a custom profile from a JSON file",
        "    --categories <a,b,...>     Run only the listed categories (comma-separated)",
        "    --scenario <type>          Comparison scenario (head_to_head, version_upgrade, etc.)",
        "    --same-library             Treat as same library (enables replace)",
        "    --left-label <name>        Label for left side",
        "    --right-label <name>       Label for right side",
        "    --executor <mock|codex|claude>  Executor type (default: mock)",
        "    --irt <path>               Apply IRT calibration weights from file",
        "    --no-elo                   Skip Elo rating update",
        "    --json                     Output as JSON",
        "  batch <left> <right>         Run multiple comparisons for IRT data accumulation",
        "    --runs <n>                 Number of comparison runs (default: 10, max: 500)",
        "    --parallel <n>             Parallel runs (default: 4, max: 8)",
        "    --profile <id>             Benchmark profile (default)",
        "    --profile-file <path>      Load a custom profile from a JSON file",
        "    --categories <a,b,...>     Run only the listed categories (comma-separated)",
        "    --scenario <type>          Comparison scenario",
        "    --same-library             Treat as same library",
        "    --executor <mock|codex|claude>  Executor type (default: mock)",
        "    --confirm                  Required for real executors with >10 runs",
        "    --no-elo                   Skip Elo rating updates",
        "  calibrate <batch-id>         Run IRT calibration on batch data",
        "    --batch <batch-id>         Batch to calibrate (alternative to positional)",
        "  tournament <s1> <s2> [...]   Single-elimination knockout bracket (2-16 competitors)",
        "    --profile <id>             Benchmark profile (default)",
        "    --profile-file <path>      Load a custom profile from a JSON file",
        "    --categories <a,b,...>     Run only the listed categories (comma-separated)",
        "    --executor <mock|codex|claude>  Executor type (default: mock)",
        "    --seed <number>            Random seed for bracket ordering (default: 42)",
        "    --no-elo                   Skip Elo rating updates",
        "  show <run-id>               Re-read a stored run",
        "  replace <run-id>            Replace loser with winner",
        "    --winner-to <left|right>   Which side gets replaced",
        "    --confirm                  Required safety flag",
        "  leaderboard                  Show Elo rankings",
        "  history                      Show match history",
        "    --limit <n>                Number of recent matches (default: 20)",
        "",
        "Pipeline: batch → calibrate → compare --irt",
        "  1. batch <left> <right> --runs 20    Accumulate trial data",
        "  2. calibrate <batch-id>               Fit IRT model to trials",
        "  3. compare <left> <right> --irt <file> Apply calibrated weights",
        "",
        "Global flags:",
        "  --data-root <path>           Data storage directory",
        "  --allowlist-root <path>      Allowed parent root for workspace paths",
        "  --json                       JSON output mode",
        "",
        "Source formats for compare, batch, and tournament:",
        "  /local/path                  Local filesystem path",
        "  github://owner/repo          GitHub repo (default branch)",
        "  github://owner/repo@branch   GitHub repo at specific branch/tag",
        "  github://owner/repo#sha      GitHub repo at specific commit",
        "  https://github.com/owner/repo  GitHub URL (auto-detected)",
        "",
        "You can benchmark any two markdown skill libraries."
      ].join("\n"));
      return;
    }

    default:
      throw new Error(
        `Unknown command: ${parsed.command}. Run 'help' for usage. Available: profiles, compare, batch, calibrate, show, replace, tournament, leaderboard, history, help`
      );
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const isJsonMode = process.argv.includes("--json");
  if (isJsonMode) {
    printJson({ error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
});
