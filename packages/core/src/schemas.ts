export const SCHEMA_VERSION = 5;

/**
 * Benchmark category identifier. Built-in categories are provided as constants;
 * custom profiles may define arbitrary category strings.
 */
export type BenchmarkCategory = string;

/** Built-in category constants for the default profile. */
export const BUILTIN_CATEGORIES = [
  "routing_accuracy",
  "boundary_clarity",
  "review_quality",
  "handoff_quality",
  "system_architecture",
  "code_hygiene",
  "constraint_handling"
] as const;

export type BuiltinBenchmarkCategory = (typeof BUILTIN_CATEGORIES)[number];

export type EvaluatorKind = "deterministic" | "rubric";

export type ExecutorKind = "mock" | "codex" | "claude";

export type SourceKind = "local" | "github";

export type LaunchShell = "powershell" | "cmd" | "sh";

export type ComparisonMode = "same_library" | "cross_library";

export type ComparisonScenario =
  | "head_to_head"
  | "version_upgrade"
  | "marginal_update"
  | "add_new_skill"
  | "regression_check"
  | "projection_compare";

export type ComparisonWinner = "left" | "right" | "too_close_to_call";

export type ConfidenceLevel = "high" | "medium" | "low";

export type BenchmarkSource = "built_in_pack";

export type ActionOffer =
  | "replace_left_with_right"
  | "replace_right_with_left"
  | "keep_separate"
  | "cleanup_plan";

export type RecommendedAction =
  | "replace_left_with_right"
  | "replace_right_with_left"
  | "keep_separate"
  | "port_ideas_deliberately"
  | "rerun_with_narrower_change";

// Construction-Verification extension types (concrete since 9b)

export type CVCheckKind = "requires" | "absent" | "before" | "after" | "count" | "section";

export type CVCheck = {
  check_id: string;
  kind: CVCheckKind;
  description: string;
  /** DSL expression — parsed at profile load time. */
  rule: string;
  weight: number;
  critical: boolean;
};

export type CVTaskExtension = {
  construction_cues: string[];
  verification_checks: CVCheck[];
  /** Weight for construction phase score. Default 0.3. Must sum to ~1.0 with verification_weight. */
  construction_weight: number;
  /** Weight for verification phase score. Default 0.7. Must sum to ~1.0 with construction_weight. */
  verification_weight: number;
  /** If true, critical check failure zeroes verification contribution. Default true. */
  firewall: boolean;
};

export type CVResult = {
  construction_score: number;
  verification_score: number;
  combined_score: number;
  construction_details: string[];
  verification_details: string[];
  checks_passed: number;
  checks_failed: number;
  checks_total: number;
  shortcut_detected: boolean;
  critical_failure: boolean;
};

// Composition extension types (concrete since 9c)

export type CompositionLayer = "primitive" | "composed" | "meta";

export type CompositionTaskExtension = {
  layer: CompositionLayer;
  /** Task IDs this task depends on. Empty for primitives. */
  dependencies: string[];
  /** Additional mock cues beyond those in the task prompt. */
  composition_cues: string[];
};

export type CollapseConfig = {
  /** Primitive score floor above which collapse can be detected. Must be in [0, 1]. Default 0.6. */
  primitive_floor: number;
  /** Composed score ceiling below which collapse is detected. Must be in [0, 1]. Default 0.3. */
  composed_ceiling: number;
};

export type CollapseResult = {
  detected: boolean;
  /** Normalized severity ∈ [0, 1]. 0 when not detected or mean_primitive < 0.1. */
  severity: number;
  mean_primitive: number;
  mean_composed: number;
  /** Set when either layer has < 2 scored tasks. */
  insufficient_data?: boolean;
};

export type TaskExtensions = {
  cv?: CVTaskExtension;
  composition?: CompositionTaskExtension;
};

export type BenchmarkTask = {
  task_id: string;
  task_version: number;
  family: string;
  category: BenchmarkCategory;
  critical_regression: boolean;
  evaluator_kind: EvaluatorKind;
  priority: number;
  min_valid_trials: number;
  /** Number of trials to run per side. Default: 5. */
  trials_per_side: number;
  prompt_text: string;
  rubric_text: string | null;
  extensions?: TaskExtensions;
};

export type BenchmarkPack = {
  pack_id: string;
  source: BenchmarkSource;
  task_ids: string[];
  category_weights: Record<BenchmarkCategory, number>;
  critical_task_ids: string[];
  catalog_hash: string;
};

export type BenchmarkProfile = {
  profile_id: string;
  label: string;
  description: string;
  pack: BenchmarkPack;
  tasks: BenchmarkTask[];
  /** Optional collapse detection config. Defaults apply if omitted. */
  collapse_config?: CollapseConfig;
};

export type BenchmarkProfileSummary = Pick<BenchmarkProfile, "profile_id" | "label" | "description"> & {
  is_default: boolean;
};

export type ComparisonSide = {
  side_id: "left" | "right";
  label: string;
  root_path: string;
  snapshot_id: string;
  snapshot_dir: string;
  source_kind: SourceKind;
  replaceable: boolean;
};

export type TaskTrialResult = {
  task_id: string;
  task_version: number;
  side_id: "left" | "right";
  trial_index: number;
  evaluator_kind: EvaluatorKind;
  normalized_score: number | null;
  false_positive: 0 | 1;
  status: "valid" | "failed";
  reason?: string;
  extension_metadata?: Record<string, unknown>;
};

export type TaskSideSummary = {
  task_id: string;
  task_version: number;
  side_id: "left" | "right";
  valid_trial_count: number;
  failed_trial_count: number;
  task_score: number | null;
  trial_scores: number[];
  false_positive_count: number;
};

export type CategoryScore = {
  category: BenchmarkCategory;
  weight: number;
  left_score: number | null;
  right_score: number | null;
  delta: number | null;
  unstable: boolean;
  task_ids: string[];
};

export type EnhancedCategoryScore = CategoryScore & {
  left_posterior: { mean: number; sigma: number; ci95: [number, number] };
  right_posterior: { mean: number; sigma: number; ci95: [number, number] };
  delta_ci95: [number, number];
  prob_right_superior: number;
  rope_verdict: "left_wins" | "right_wins" | "equivalent" | "undecided";
  left_cv: { cv: number; stability: string };
  right_cv: { cv: number; stability: string };
};

export type ScorecardV2 = {
  left_posterior: { mean: number; sigma: number; ci95: [number, number] };
  right_posterior: { mean: number; sigma: number; ci95: [number, number] };
  overall_delta_ci95: [number, number];
  overall_prob_right_superior: number;
  overall_rope_verdict: "left_wins" | "right_wins" | "equivalent" | "undecided";
  rope_epsilon: number;
  bootstrap_resamples: number;
  enhanced_categories: EnhancedCategoryScore[];
};

export type Scorecard = {
  left_score: number;
  right_score: number;
  delta: number;
  confidence: ConfidenceLevel;
  category_scores: CategoryScore[];
  top_reasons: string[];
  regressions: string[];
  v2?: ScorecardV2;
};

export type DevilsAdvocate = {
  verdict: "block_replace" | "caution" | "clear";
  arguments: string[];
};

export type ComparisonRun = {
  run_id: string;
  schema_version: number;
  profile_id: string;
  comparison_mode: ComparisonMode;
  comparison_scenario?: ComparisonScenario;
  benchmark_pack: BenchmarkPack;
  winner: ComparisonWinner;
  left_side: ComparisonSide;
  right_side: ComparisonSide;
  selected_task_ids: string[];
  selected_task_versions: number[];
  evaluator_versions: Record<string, string>;
  task_trial_results: TaskTrialResult[];
  task_side_summaries: TaskSideSummary[];
  scorecard: Scorecard;
  devils_advocate: DevilsAdvocate;
  recommended_action: RecommendedAction;
  replace_eligible: boolean;
  action_offers: ActionOffer[];
  artifact_refs: string[];
  run_path: string | null;
  report_path: string | null;
  created_at: string;
  irt_calibration_id?: string;
  composition_analysis?: CollapseResult;
  /** Collapse config used for this run (defaults or profile-specified). For provenance. */
  collapse_config_used?: CollapseConfig;
};

export type ReplaceResult = {
  run_id: string;
  source_side: "left" | "right";
  target_side: "left" | "right";
  target_root: string;
  archive_dir: string;
  report_path: string;
  summary: string;
};

export type ExecutorInput = {
  sideId: "left" | "right";
  task: BenchmarkTask;
  trialIndex: number;
  bundleDir: string;
  promptText: string;
  rubricText: string | null;
};

export type ExecutorOutput = {
  normalizedScore: number | null;
  falsePositive?: 0 | 1;
  status: "valid" | "failed";
  reason?: string;
};

export type Executor = {
  version: string;
  run(input: ExecutorInput): Promise<ExecutorOutput>;
};

export type ProviderDiagnostics = {
  provider: Exclude<ExecutorKind, "mock">;
  launch_configured: boolean;
  launch_command: string | null;
  launch_shell: LaunchShell;
  launcher: string | null;
  launcher_path: string | null;
  ready: boolean;
};

export type WatchtowerDiagnostics = {
  host_platform: NodeJS.Platform;
  default_launch_shell: LaunchShell;
  providers: Record<Exclude<ExecutorKind, "mock">, ProviderDiagnostics>;
};

// Elo ranking types

export type EloEntry = {
  library_id: string;
  label: string;
  root_path: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  last_run_id: string;
  last_updated: string;
};

export type EloLedger = {
  schema_version: number;
  k_factor: number;
  entries: EloEntry[];
  history: EloMatchRecord[];
};

export type EloMatchRecord = {
  run_id: string;
  left_id: string;
  right_id: string;
  winner: ComparisonWinner;
  left_elo_before: number;
  right_elo_before: number;
  left_elo_after: number;
  right_elo_after: number;
  timestamp: string;
};

// Tournament types

export type TournamentSeed = {
  competitor_id: string;
  source: string;
  label: string;
  seed_number: number;
  elo_seed?: number;
};

export type TournamentMatchResult = {
  round: number;
  match_index: number;
  left_id: string;
  right_id: string;
  run_id: string;
  winner_id: string | null;
  left_score: number;
  right_score: number;
  decided_by_seed_advantage: boolean;
};

export type TournamentBye = {
  round: number;
  match_index: number;
  competitor_id: string;
};

export type TournamentRound = {
  round_number: number;
  matches: TournamentMatchResult[];
  byes: TournamentBye[];
};

export type TournamentResult = {
  tournament_id: string;
  profile_id: string;
  bracket_size: number;
  competitor_count: number;
  seeds: TournamentSeed[];
  rounds: TournamentRound[];
  final_ranking: string[];
  created_at: string;
};

// IRT calibration types

export type IRTModelKind = "grm" | "2pl";

export type IRTItemParams = {
  task_id: string;
  model: IRTModelKind;
  discrimination: number;
  boundaries: number[];
  fisher_info_at_mean: number;
  fisher_info_integrated: number;
  calibration_n: number;
  fit_residual: number;
  response_distribution: number[];
};

export type IRTCalibrationReport = {
  /** Artifact format version. Currently 1. */
  version: 1;
  calibration_id: string;
  profile_id: string;
  catalog_hash: string;
  schema_version: number;
  model_selected: IRTModelKind;
  model_selection_aic: { grm: number; twopl: number };
  item_params: IRTItemParams[];
  mean_ability: number;
  ability_std: number;
  total_trials_used: number;
  total_bundles: number;
  convergence_iterations: number;
  converged: boolean;
  n_restarts: number;
  best_restart_index: number;
  marginal_log_likelihood: number;
  timestamp: string;
};

export type IRTWeightOverride = {
  task_id: string;
  irt_weight: number;
  original_weight: number;
  reason: "high_info" | "low_info" | "excluded";
};

// Scenario metadata

export type ScenarioMeta = {
  scenario: ComparisonScenario;
  implied_mode: ComparisonMode;
  replace_eligible_by_default: boolean;
  suggested_profiles: string[];
  description: string;
};

export const SCENARIO_REGISTRY: ScenarioMeta[] = [
  {
    scenario: "head_to_head",
    implied_mode: "cross_library",
    replace_eligible_by_default: false,
    suggested_profiles: ["default"],
    description: "Two completely different skill sets from different authors or approaches."
  },
  {
    scenario: "version_upgrade",
    implied_mode: "same_library",
    replace_eligible_by_default: true,
    suggested_profiles: ["default"],
    description: "Old version vs new version of the same library. Full rewrite or major restructure."
  },
  {
    scenario: "marginal_update",
    implied_mode: "same_library",
    replace_eligible_by_default: true,
    suggested_profiles: ["default"],
    description: "Small tweaks to individual skills - wording, added sections, removed bloat."
  },
  {
    scenario: "add_new_skill",
    implied_mode: "same_library",
    replace_eligible_by_default: true,
    suggested_profiles: ["default"],
    description: "Added a brand-new skill to an existing library. Checks that the new addition does not regress existing quality."
  },
  {
    scenario: "regression_check",
    implied_mode: "same_library",
    replace_eligible_by_default: true,
    suggested_profiles: ["default"],
    description: "Confirm that cleanup or simplification did not make the library worse."
  },
  {
    scenario: "projection_compare",
    implied_mode: "cross_library",
    replace_eligible_by_default: false,
    suggested_profiles: ["default"],
    description: "Compare different projections of the same content (for example, repo root vs .claude/skills)."
  }
];

// Batch output types (for IRT calibration data accumulation)

export type BatchOutput = {
  /** Artifact format version. Currently 1. */
  version: 1;
  batchId: string;
  profileId: string;
  left: string;
  right: string;
  createdAt: string;
  runs: Array<{
    runId: string;
    taskTrialResults: TaskTrialResult[];
  }>;
  summary: {
    completed: number;
    failed: number;
    retried: number;
    wallClockMs: number;
  };
};
