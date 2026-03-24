export const SCHEMA_VERSION = 2;

export type BenchmarkCategory =
  | "routing_accuracy"
  | "boundary_clarity"
  | "review_quality"
  | "handoff_quality";

export type EvaluatorKind = "deterministic" | "rubric";

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

export type BenchmarkTask = {
  task_id: string;
  task_version: number;
  family: string;
  category: BenchmarkCategory;
  critical_regression: boolean;
  evaluator_kind: EvaluatorKind;
  priority: number;
  min_valid_trials: number;
  prompt_text: string;
  rubric_text: string | null;
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
    suggested_profiles: ["default", "lead-producer", "team-product-team", "team-dev-team", "workflow-issue-triage"],
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
