import os from "node:os";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { getBenchmarkProfile } from "./builtin-benchmark.js";
import { walkFiles } from "./files.js";
import {
  type CollapseConfig,
  type ComparisonMode,
  type ComparisonRun,
  type ComparisonScenario,
  type ComparisonSide,
  type Executor,
  type IRTCalibrationReport,
  type IRTWeightOverride,
  SCHEMA_VERSION
} from "./schemas.js";
import {
  COLLAPSE_PRIMITIVE_FLOOR,
  COLLAPSE_COMPOSED_CEILING
} from "./constants.js";
import { enrichCompositionMetadata } from "./composition-scorer.js";
import { scoreWithExtensions } from "./extension-scorer.js";
import { createSnapshot, type SnapshotResult } from "./snapshots.js";
import {
  cleanupSource,
  isRemoteSource,
  resolveSource,
  type ResolvedSource
} from "./source-resolver.js";
import {
  computeActionOffers,
  computeDevilsAdvocate,
  computeRecommendedAction,
  computeReplaceEligible,
  summarizeSide
} from "./verdict.js";
import { computeEnhancedScorecard } from "./stats-verdict.js";

export const DEFAULT_IGNORE_GLOBS = [
  ".git/**",
  "node_modules/**",
  "**/.env*",
  "**/.aws/**",
  "**/.ssh/**",
  "**/__pycache__/**",
  "**/.cache/**",
  "**/.venv/**",
  "**/venv/**",
  "watchtower-data/**"
];

export type CompareLibrariesOptions = {
  allowlistedParentRoot: string;
  snapshotsRoot: string;
  executor: Executor;
  leftRootPath: string;
  rightRootPath: string;
  comparisonMode: ComparisonMode;
  comparisonScenario?: ComparisonScenario;
  profileId?: string;
  leftLabel?: string;
  rightLabel?: string;
  irtCalibration?: IRTCalibrationReport;
};

type ResolvedSide = {
  side: ComparisonSide;
  filesRoot: string;
};

/**
 * Derive IRT weight overrides from a calibration report.
 * Maps Fisher Information (integrated) to normalized weights [0, 1].
 * Tasks in the profile but missing from calibration default to weight 1.0.
 */
function deriveWeightsFromCalibrationReport(
  report: IRTCalibrationReport,
  tasks: { task_id: string }[]
): IRTWeightOverride[] {
  const paramMap = new Map(report.item_params.map(p => [p.task_id, p]));
  const maxFisher = Math.max(
    ...report.item_params.map(p => p.fisher_info_integrated),
    1e-10 // avoid division by zero
  );

  return tasks.map(task => {
    const params = paramMap.get(task.task_id);
    if (!params) {
      return {
        task_id: task.task_id,
        irt_weight: 1.0,
        original_weight: 1.0,
        reason: "excluded" as const
      };
    }
    const weight = params.fisher_info_integrated / maxFisher;
    return {
      task_id: task.task_id,
      irt_weight: weight,
      original_weight: 1.0,
      reason: weight < 0.1 ? "low_info" as const : "high_info" as const
    };
  });
}

function defaultSideLabel(sideId: "left" | "right", rootPath: string): string {
  const base = path.basename(rootPath);
  return base.length > 0 ? base : sideId === "left" ? "Left" : "Right";
}

function assertMarkdownSkillLibrary(filesRoot: string): void {
  const hasSkillFile = walkFiles(filesRoot).some(
    (entry) => path.basename(entry.relativePath).toLowerCase() === "skill.md"
  );
  if (!hasSkillFile) {
    throw new Error(`Watchtower only supports markdown skill libraries. No SKILL.md files were found in ${filesRoot}.`);
  }
}

function resolveSideFromRoot(
  sideId: "left" | "right",
  rootPath: string,
  allowlistedParentRoot: string,
  snapshotsRoot: string,
  label?: string,
  sourceKind: ComparisonSide["source_kind"] = "local",
  replaceable = true,
  sourceId?: string
): ResolvedSide {
  const snapshot: SnapshotResult = createSnapshot({
    rootPath,
    allowlistedParentRoot,
    ignoreGlobs: [...DEFAULT_IGNORE_GLOBS],
    destRoot: snapshotsRoot
  });
  const filesRoot = getSnapshotFilesRoot(snapshot.snapshotDir);
  assertMarkdownSkillLibrary(filesRoot);

  return {
    side: {
      side_id: sideId,
      label: label ?? defaultSideLabel(sideId, snapshot.rootPath),
      root_path: sourceId ?? snapshot.rootPath,
      snapshot_id: snapshot.treeHash,
      snapshot_dir: snapshot.snapshotDir,
      source_kind: sourceKind,
      replaceable
    },
    filesRoot
  };
}

export function getSnapshotFilesRoot(snapshotDir: string): string {
  return path.join(snapshotDir, "files");
}

export function getSnapshotArtifactRef(sideId: "left" | "right", snapshotDir: string): string {
  return `snapshot:${sideId}=${snapshotDir}`;
}

export function getSnapshotDirFromArtifactRefs(
  artifactRefs: string[],
  sideId: "left" | "right"
): string | null {
  const prefix = `snapshot:${sideId}=`;
  const artifact = artifactRefs.find((ref) => ref.startsWith(prefix));
  return artifact ? artifact.slice(prefix.length) : null;
}

export async function compareLibraries(options: CompareLibrariesOptions): Promise<ComparisonRun> {
  const profile = getBenchmarkProfile(options.profileId);

  const tempRoot = path.join(os.tmpdir(), "watchtower-clones");
  const resolvedSources: ResolvedSource[] = [];
  const leftSource = isRemoteSource(options.leftRootPath)
    ? resolveSource(options.leftRootPath, tempRoot)
    : resolveSource(options.leftRootPath);
  const rightSource = isRemoteSource(options.rightRootPath)
    ? resolveSource(options.rightRootPath, tempRoot)
    : resolveSource(options.rightRootPath);

  for (const source of [leftSource, rightSource]) {
    if (source.kind === "github") {
      resolvedSources.push(source);
    }
  }

  try {
    return await compareLibrariesInner(options, profile, leftSource, rightSource);
  } finally {
    for (const source of resolvedSources) {
      cleanupSource(source);
    }
  }
}

async function compareLibrariesInner(
  options: CompareLibrariesOptions,
  profile: ReturnType<typeof getBenchmarkProfile>,
  leftSource: ResolvedSource,
  rightSource: ResolvedSource
): Promise<ComparisonRun> {
  const left = resolveSideFromRoot(
    "left",
    leftSource.localPath,
    leftSource.kind === "local" ? options.allowlistedParentRoot : leftSource.localPath,
    options.snapshotsRoot,
    options.leftLabel ?? leftSource.label,
    leftSource.kind,
    leftSource.replaceable,
    leftSource.sourceId
  );
  const right = resolveSideFromRoot(
    "right",
    rightSource.localPath,
    rightSource.kind === "local" ? options.allowlistedParentRoot : rightSource.localPath,
    options.snapshotsRoot,
    options.rightLabel ?? rightSource.label,
    rightSource.kind,
    rightSource.replaceable,
    rightSource.sourceId
  );

  const taskTrialResults: ComparisonRun["task_trial_results"] = [];
  for (const task of profile.tasks) {
    for (const side of [left, right] as const) {
      const trialCount = task.trials_per_side ?? 5;
      for (let trialIndex = 1; trialIndex <= trialCount; trialIndex += 1) {
        const executorInput = {
          sideId: side.side.side_id as "left" | "right",
          task,
          trialIndex,
          bundleDir: side.filesRoot,
          promptText: task.prompt_text,
          rubricText: task.rubric_text
        };
        const baseOutput = await options.executor.run(executorInput);
        const { result: finalOutput, metadata } = await scoreWithExtensions(
          executorInput,
          baseOutput
        );
        taskTrialResults.push({
          task_id: task.task_id,
          task_version: task.task_version,
          side_id: side.side.side_id,
          trial_index: trialIndex,
          evaluator_kind: task.evaluator_kind,
          normalized_score: finalOutput.normalizedScore,
          false_positive: finalOutput.falsePositive ?? 0,
          status: finalOutput.status,
          reason: finalOutput.reason,
          extension_metadata: metadata
        });
      }
    }
  }

  const taskSideSummaries = profile.tasks.flatMap((task) => {
    const taskResults = taskTrialResults.filter((result) => result.task_id === task.task_id);
    return [summarizeSide(task, "left", taskResults), summarizeSide(task, "right", taskResults)];
  });

  // Derive IRT weights from calibration if provided
  const irtWeights: IRTWeightOverride[] | undefined = options.irtCalibration
    ? deriveWeightsFromCalibrationReport(options.irtCalibration, profile.tasks)
    : undefined;

  const { winner, scorecard } = computeEnhancedScorecard({
    tasks: profile.tasks,
    benchmarkPack: profile.pack,
    summaries: taskSideSummaries,
    trialResults: taskTrialResults,
    irtWeights
  });
  const replaceEligible = computeReplaceEligible(winner, options.comparisonMode, scorecard);
  const recommendedAction = computeRecommendedAction(winner, options.comparisonMode, replaceEligible);
  const devilsAdvocate = computeDevilsAdvocate(winner, options.comparisonMode, scorecard);

  // Composition metadata enrichment (post-hoc collapse detection)
  const compositionAnalysis = enrichCompositionMetadata(
    { tasks: profile.tasks, collapse_config: profile.collapse_config },
    taskTrialResults
  );

  return {
    run_id: uuidv7(),
    schema_version: SCHEMA_VERSION,
    profile_id: profile.profile_id,
    comparison_mode: options.comparisonMode,
    comparison_scenario: options.comparisonScenario,
    benchmark_pack: profile.pack,
    winner,
    left_side: left.side,
    right_side: right.side,
    selected_task_ids: profile.tasks.map((task) => task.task_id),
    selected_task_versions: profile.tasks.map((task) => task.task_version),
    evaluator_versions: {
      executor: options.executor.version
    },
    task_trial_results: taskTrialResults,
    task_side_summaries: taskSideSummaries,
    scorecard,
    devils_advocate: devilsAdvocate,
    recommended_action: recommendedAction,
    replace_eligible: replaceEligible,
    action_offers: computeActionOffers(options.comparisonMode),
    artifact_refs: [
      getSnapshotArtifactRef("left", left.side.snapshot_dir),
      getSnapshotArtifactRef("right", right.side.snapshot_dir)
    ],
    run_path: null,
    report_path: null,
    created_at: new Date().toISOString(),
    irt_calibration_id: options.irtCalibration?.calibration_id,
    composition_analysis: compositionAnalysis,
    collapse_config_used: profile.collapse_config ?? {
      primitive_floor: COLLAPSE_PRIMITIVE_FLOOR,
      composed_ceiling: COLLAPSE_COMPOSED_CEILING
    },
  };
}
