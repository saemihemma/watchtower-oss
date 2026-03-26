import fs from "node:fs";
import path from "node:path";
import { listBenchmarkProfiles } from "./builtin-benchmark.js";
import { loadEloLedger, recordEloMatch, saveEloLedger } from "./elo.js";
import { compareLibraries, getSnapshotFilesRoot } from "./engine.js";
import { copyEntriesToDir, ensureDir, loadText, walkFiles, writeJson } from "./files.js";
import {
  type BenchmarkProfileSummary,
  type ComparisonMode,
  type ComparisonRun,
  type ComparisonScenario,
  type Executor,
  type IRTCalibrationReport,
  type ReplaceResult,
  SCHEMA_VERSION
} from "./schemas.js";

export type CompareLibrariesRunInput = {
  leftRootPath: string;
  rightRootPath: string;
  profileId?: string;
  comparisonMode: ComparisonMode;
  comparisonScenario?: ComparisonScenario;
  leftLabel?: string;
  rightLabel?: string;
  allowlistedParentRoot: string;
  dataRoot: string;
  executor: Executor;
  updateElo?: boolean;
  /** Optional IRT calibration report. When provided, IRT weights are applied to the scorecard. */
  irtCalibration?: IRTCalibrationReport;
};

export type ShowRunResult = {
  run: ComparisonRun;
  reportText: string;
};

type DataPaths = {
  dataRoot: string;
  snapshotsRoot: string;
  runsRoot: string;
  reportsRoot: string;
  archivesRoot: string;
  batchesRoot: string;
  calibrationsRoot: string;
};

export function getDataPaths(dataRoot: string): DataPaths {
  return {
    dataRoot,
    snapshotsRoot: path.join(dataRoot, "snapshots"),
    runsRoot: path.join(dataRoot, "runs"),
    reportsRoot: path.join(dataRoot, "reports"),
    archivesRoot: path.join(dataRoot, "archives"),
    batchesRoot: path.join(dataRoot, "batches"),
    calibrationsRoot: path.join(dataRoot, "calibrations")
  };
}

export function listProfiles(): BenchmarkProfileSummary[] {
  return listBenchmarkProfiles();
}

function renderReasons(title: string, lines: string[]): string {
  if (lines.length === 0) {
    return `## ${title}\n- None\n`;
  }
  return [`## ${title}`, ...lines.map((line) => `- ${line}`), ""].join("\n");
}

export function renderRunReport(run: ComparisonRun): string {
  const winnerLine =
    run.winner === "too_close_to_call"
      ? "Too close to call"
      : `${run.winner === "left" ? run.left_side.label : run.right_side.label} wins`;

  const categoryLines = run.scorecard.category_scores.map((category) => {
    const left = category.left_score === null ? "n/a" : category.left_score.toFixed(2);
    const right = category.right_score === null ? "n/a" : category.right_score.toFixed(2);
    const delta = category.delta === null ? "n/a" : category.delta.toFixed(2);
    return `- ${category.category}: Left ${left}, Right ${right}, Delta ${delta}`;
  });

  const allowedActions =
    run.action_offers.length > 0 ? run.action_offers.map((offer) => `- ${offer}`).join("\n") : "- none";

  const scenarioLine = run.comparison_scenario
    ? `- Scenario: ${run.comparison_scenario.replace(/_/g, " ")}`
    : "";

  // v2 stats section (if scorecard has v2 data)
  const v2Section: string[] = [];
  const v2 = run.scorecard.v2;

  if (v2) {
    v2Section.push(
      "",
      "## Statistical Analysis (v2)",
      `- ROPE Verdict: ${v2.overall_rope_verdict ?? "n/a"}`,
      `- Delta 95% CI: [${v2.overall_delta_ci95?.[0]?.toFixed(4) ?? "?"}, ${v2.overall_delta_ci95?.[1]?.toFixed(4) ?? "?"}]`,
      `- P(right superior): ${v2.overall_prob_right_superior !== undefined ? (v2.overall_prob_right_superior * 100).toFixed(1) + "%" : "n/a"}`
    );

    if (v2.enhanced_categories) {
      v2Section.push("", "### Per-Category Statistics");
      for (const cat of v2.enhanced_categories) {
        v2Section.push(
          `- ${cat.category}: ROPE=${cat.rope_verdict}, CI=[${cat.delta_ci95[0].toFixed(4)}, ${cat.delta_ci95[1].toFixed(4)}], P(R>L)=${(cat.prob_right_superior * 100).toFixed(1)}%, Left CV=${cat.left_cv.cv.toFixed(3)} (${cat.left_cv.stability}), Right CV=${cat.right_cv.cv.toFixed(3)} (${cat.right_cv.stability})`
        );
      }
    }
  }

  // Per-task detail table
  const taskDetailLines: string[] = [];
  if (run.task_side_summaries && run.task_side_summaries.length > 0) {
    const taskIds = [...new Set(run.task_side_summaries.map((s) => s.task_id))];
    const summaryMap = new Map(run.task_side_summaries.map((s) => [`${s.task_id}:${s.side_id}`, s]));
    taskDetailLines.push(
      "",
      "## Per-Task Detail",
      "| Task | Category | Left | Right | Delta | Trials (L/R) |",
      "|------|----------|------|-------|-------|--------------|"
    );
    for (const taskId of taskIds) {
      const leftSummary = summaryMap.get(`${taskId}:left`);
      const rightSummary = summaryMap.get(`${taskId}:right`);
      const leftScore = leftSummary?.task_score;
      const rightScore = rightSummary?.task_score;
      const leftStr = leftScore === null || leftScore === undefined ? "n/a" : (leftScore * 100).toFixed(1);
      const rightStr = rightScore === null || rightScore === undefined ? "n/a" : (rightScore * 100).toFixed(1);
      const deltaStr =
        leftScore != null && rightScore != null ? ((rightScore - leftScore) * 100).toFixed(1) : "n/a";
      const category =
        run.scorecard.category_scores.find((c) => c.task_ids.includes(taskId))?.category ?? "unknown";
      const trialsStr = `${leftSummary?.valid_trial_count ?? 0}/${rightSummary?.valid_trial_count ?? 0}`;
      taskDetailLines.push(`| ${taskId} | ${category} | ${leftStr} | ${rightStr} | ${deltaStr} | ${trialsStr} |`);
    }
  }

  return [
    `# Watchtower Benchmark Run ${run.run_id}`,
    "",
    `- Profile: ${run.profile_id}`,
    `- Winner: ${winnerLine}`,
    `- Comparison mode: ${run.comparison_mode}`,
    ...(scenarioLine ? [scenarioLine] : []),
    `- Left: ${run.left_side.label} (${run.left_side.source_kind}: ${run.left_side.root_path})`,
    `- Right: ${run.right_side.label} (${run.right_side.source_kind}: ${run.right_side.root_path})`,
    `- Left score: ${run.scorecard.left_score.toFixed(2)}`,
    `- Right score: ${run.scorecard.right_score.toFixed(2)}`,
    `- Delta: ${run.scorecard.delta.toFixed(2)}`,
    `- Confidence: ${run.scorecard.confidence}`,
    `- Recommended action: ${run.recommended_action}`,
    `- Replace eligible: ${run.replace_eligible ? "yes" : "no"}`,
    "",
    "## Category Breakdown",
    ...categoryLines,
    ...taskDetailLines,
    "",
    renderReasons("Top Reasons", run.scorecard.top_reasons).trimEnd(),
    "",
    renderReasons("Regressions", run.scorecard.regressions).trimEnd(),
    ...v2Section,
    ...renderCompositionAnalysis(run),
    "",
    "## Devil's Advocate",
    `- Verdict: ${run.devils_advocate.verdict}`,
    ...run.devils_advocate.arguments.map((line) => `- ${line}`),
    "",
    "## Allowed Actions",
    allowedActions,
    ""
  ].join("\n");
}

/**
 * Render composition analysis section for the markdown report.
 * Returns an array of lines (empty if no composition analysis present).
 */
function renderCompositionAnalysis(run: ComparisonRun): string[] {
  const ca = run.composition_analysis;
  if (!ca) return [];

  const lines: string[] = ["", "## Composition Analysis"];

  if (ca.insufficient_data) {
    lines.push(
      "Insufficient data (fewer than 2 scored tasks per layer). Run more trials or add composition tasks."
    );
    return lines;
  }

  lines.push(
    `- **Collapse detected:** ${ca.detected ? "Yes" : "No"}`,
    `- **Severity:** ${ca.severity.toFixed(4)} (scale: 0 = none, 1 = total)`,
    "",
    "| Layer | Mean Score |",
    "|-------|------------|",
    `| Primitive | ${ca.mean_primitive.toFixed(4)} |`,
    `| Composed + Meta | ${ca.mean_composed.toFixed(4)} |`
  );

  if (ca.detected) {
    lines.push(
      "",
      "**Interpretation:** Primitives score well individually but composed tasks degrade, suggesting integration fragility."
    );
  } else {
    lines.push(
      "",
      "**Interpretation:** No collapse detected — composed tasks maintain quality at scale."
    );
  }

  return lines;
}

export async function compareLibrariesRun(input: CompareLibrariesRunInput): Promise<ComparisonRun> {
  const paths = getDataPaths(input.dataRoot);
  const run = await compareLibraries({
    allowlistedParentRoot: input.allowlistedParentRoot,
    snapshotsRoot: paths.snapshotsRoot,
    executor: input.executor,
    leftRootPath: input.leftRootPath,
    rightRootPath: input.rightRootPath,
    comparisonMode: input.comparisonMode,
    comparisonScenario: input.comparisonScenario,
    profileId: input.profileId,
    leftLabel: input.leftLabel,
    rightLabel: input.rightLabel,
    irtCalibration: input.irtCalibration
  });

  const persistedRun: ComparisonRun = {
    ...run,
    run_path: path.join(paths.runsRoot, `${run.run_id}.json`),
    report_path: path.join(paths.reportsRoot, `${run.run_id}.md`)
  };
  const reportText = renderRunReport(persistedRun);
  writeJson(persistedRun.run_path as string, persistedRun);
  ensureDir(paths.reportsRoot);
  fs.writeFileSync(persistedRun.report_path as string, reportText, "utf8");

  // Auto-update Elo if enabled (default: true)
  if (input.updateElo !== false) {
    try {
      const ledger = loadEloLedger(input.dataRoot);
      recordEloMatch(ledger, persistedRun);
      saveEloLedger(input.dataRoot, ledger);
    } catch {
      // Elo update is best-effort; don't fail the run
    }
  }

  return persistedRun;
}

export function loadRun(dataRoot: string, runId: string): ComparisonRun {
  const runPath = path.join(getDataPaths(dataRoot).runsRoot, `${runId}.json`);
  if (!fs.existsSync(runPath)) {
    throw new Error(`Run ${runId} was not found in ${getDataPaths(dataRoot).runsRoot}.`);
  }
  const run = JSON.parse(loadText(runPath)) as ComparisonRun;
  if (run.schema_version !== SCHEMA_VERSION) {
    console.warn(
      `Warning: Run ${runId} was created with schema version ${run.schema_version} (current: ${SCHEMA_VERSION}). Some fields may be missing or formatted differently.`
    );
  }
  return run;
}

export function showRun(dataRoot: string, runId: string): ShowRunResult {
  const run = loadRun(dataRoot, runId);
  const reportPath = run.report_path ?? path.join(getDataPaths(dataRoot).reportsRoot, `${runId}.md`);
  const reportText = fs.existsSync(reportPath) ? loadText(reportPath) : renderRunReport(run);
  return { run, reportText };
}

function winnerAndLoser(run: ComparisonRun): {
  winnerSide: ComparisonRun["left_side"] | ComparisonRun["right_side"];
  loserSide: ComparisonRun["left_side"] | ComparisonRun["right_side"];
  winnerId: "left" | "right";
  loserId: "left" | "right";
} {
  if (run.winner === "too_close_to_call") {
    throw new Error("Replace is blocked because this run was too close to call.");
  }

  return run.winner === "left"
    ? { winnerSide: run.left_side, loserSide: run.right_side, winnerId: "left", loserId: "right" }
    : { winnerSide: run.right_side, loserSide: run.left_side, winnerId: "right", loserId: "left" };
}

function clearRootPreservingGit(rootPath: string): void {
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    fs.rmSync(path.join(rootPath, entry.name), { recursive: true, force: true });
  }
}

function archiveRoot(rootPath: string, archiveDir: string): void {
  ensureDir(path.dirname(archiveDir));
  fs.cpSync(rootPath, archiveDir, { recursive: true });
}

function copySnapshotToRoot(snapshotDir: string, targetRoot: string): void {
  const snapshotFilesRoot = getSnapshotFilesRoot(snapshotDir);
  const entries = walkFiles(snapshotFilesRoot);
  copyEntriesToDir(entries, snapshotFilesRoot, targetRoot);
}

export function replaceFromRun(
  dataRoot: string,
  runId: string,
  winnerTo: "left" | "right",
  confirm: boolean
): ReplaceResult {
  if (!confirm) {
    throw new Error("Replace is destructive. Re-run with --confirm after checking the report.");
  }

  const run = loadRun(dataRoot, runId);
  if (run.comparison_mode !== "same_library") {
    throw new Error("Replace is blocked for cross-library comparisons. Keep both separate or port ideas deliberately.");
  }
  if (!run.replace_eligible) {
    throw new Error("Replace is blocked because the run was not replace-eligible.");
  }

  const { winnerSide, loserSide, winnerId, loserId } = winnerAndLoser(run);
  if (winnerTo !== loserId) {
    throw new Error(`Replace target must be the losing side (${loserId}), not ${winnerTo}.`);
  }
  if (!loserSide.replaceable) {
    throw new Error("Replace is blocked because the target side is remote or ephemeral. Copy changes over deliberately instead.");
  }

  const targetRoot = loserSide.root_path;
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`Replacement target root does not exist: ${targetRoot}`);
  }

  const archiveDir = path.join(getDataPaths(dataRoot).archivesRoot, `${run.run_id}-${winnerTo}-before`);
  archiveRoot(targetRoot, archiveDir);
  clearRootPreservingGit(targetRoot);
  copySnapshotToRoot(winnerSide.snapshot_dir, targetRoot);

  const summary = `Archived ${loserSide.label} to ${archiveDir} and copied ${winnerSide.label} into ${targetRoot}.`;
  return {
    run_id: run.run_id,
    source_side: winnerId,
    target_side: loserId,
    target_root: targetRoot,
    archive_dir: archiveDir,
    report_path: run.report_path ?? path.join(getDataPaths(dataRoot).reportsRoot, `${run.run_id}.md`),
    summary
  };
}
