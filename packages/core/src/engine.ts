import os from "node:os";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { getBenchmarkProfile } from "./builtin-benchmark.js";
import { walkFiles } from "./files.js";
import {
  type ComparisonMode,
  type ComparisonRun,
  type ComparisonScenario,
  type ComparisonSide,
  type Executor,
  SCHEMA_VERSION
} from "./schemas.js";
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
};

type ResolvedSide = {
  side: ComparisonSide;
  filesRoot: string;
};

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
  label?: string
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
      root_path: snapshot.rootPath,
      snapshot_id: snapshot.treeHash,
      snapshot_dir: snapshot.snapshotDir
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

  // Resolve remote sources (GitHub URLs) to local temp dirs
  const tempRoot = path.join(os.tmpdir(), "watchtower-clones");
  const resolvedSources: ResolvedSource[] = [];

  let leftPath = options.leftRootPath;
  let rightPath = options.rightRootPath;
  let leftLabel = options.leftLabel;
  let rightLabel = options.rightLabel;

  // Build allowlist that includes both the user's root AND any temp clone dirs
  const allowlistRoots = [options.allowlistedParentRoot];

  if (isRemoteSource(options.leftRootPath)) {
    const resolved = resolveSource(options.leftRootPath, tempRoot);
    resolvedSources.push(resolved);
    leftPath = resolved.localPath;
    leftLabel = leftLabel ?? resolved.label;
    allowlistRoots.push(resolved.localPath);
  }

  if (isRemoteSource(options.rightRootPath)) {
    const resolved = resolveSource(options.rightRootPath, tempRoot);
    resolvedSources.push(resolved);
    rightPath = resolved.localPath;
    rightLabel = rightLabel ?? resolved.label;
    allowlistRoots.push(resolved.localPath);
  }

  // Use the broadest allowlist that covers all sources
  const effectiveAllowlist = allowlistRoots.length > 1
    ? findCommonParent(allowlistRoots)
    : options.allowlistedParentRoot;

  try {
    return await compareLibrariesInner(
      options, profile, leftPath, rightPath, leftLabel, rightLabel, effectiveAllowlist
    );
  } finally {
    // Cleanup any temp clones
    for (const source of resolvedSources) {
      cleanupSource(source);
    }
  }
}

/**
 * Find the deepest common parent of a set of paths, falling back to filesystem root.
 */
function findCommonParent(paths: string[]): string {
  if (paths.length === 0) return "/";
  const segments = paths.map((p) => path.resolve(p).split(path.sep));
  const common: string[] = [];
  for (let i = 0; i < segments[0].length; i++) {
    const seg = segments[0][i];
    if (segments.every((s) => s[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  const result = common.join(path.sep) || path.sep;
  return result;
}

async function compareLibrariesInner(
  options: CompareLibrariesOptions,
  profile: ReturnType<typeof getBenchmarkProfile>,
  leftPath: string,
  rightPath: string,
  leftLabel: string | undefined,
  rightLabel: string | undefined,
  allowlistedParentRoot: string
): Promise<ComparisonRun> {
  const left = resolveSideFromRoot(
    "left",
    leftPath,
    allowlistedParentRoot,
    options.snapshotsRoot,
    leftLabel
  );
  const right = resolveSideFromRoot(
    "right",
    rightPath,
    allowlistedParentRoot,
    options.snapshotsRoot,
    rightLabel
  );

  const taskTrialResults: ComparisonRun["task_trial_results"] = [];
  for (const task of profile.tasks) {
    for (const side of [left, right] as const) {
      for (let trialIndex = 1; trialIndex <= 5; trialIndex += 1) {
        const output = await options.executor.run({
          sideId: side.side.side_id,
          task,
          trialIndex,
          bundleDir: side.filesRoot,
          promptText: task.prompt_text,
          rubricText: task.rubric_text
        });
        taskTrialResults.push({
          task_id: task.task_id,
          task_version: task.task_version,
          side_id: side.side.side_id,
          trial_index: trialIndex,
          evaluator_kind: task.evaluator_kind,
          normalized_score: output.normalizedScore,
          false_positive: output.falsePositive ?? 0,
          status: output.status,
          reason: output.reason
        });
      }
    }
  }

  const taskSideSummaries = profile.tasks.flatMap((task) => {
    const taskResults = taskTrialResults.filter((result) => result.task_id === task.task_id);
    return [summarizeSide(task, "left", taskResults), summarizeSide(task, "right", taskResults)];
  });

  const { winner, scorecard } = computeEnhancedScorecard({
    tasks: profile.tasks,
    benchmarkPack: profile.pack,
    summaries: taskSideSummaries,
    trialResults: taskTrialResults
  });
  const replaceEligible = computeReplaceEligible(winner, options.comparisonMode, scorecard);
  const recommendedAction = computeRecommendedAction(winner, options.comparisonMode, replaceEligible);
  const devilsAdvocate = computeDevilsAdvocate(winner, options.comparisonMode, scorecard);

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
    created_at: new Date().toISOString()
  };
}
