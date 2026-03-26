import { computeBenchmarkPackHash } from "./hashing.js";
import { BuiltinBenchmarkCategory, BenchmarkProfile, BenchmarkProfileSummary, BenchmarkTask } from "./schemas.js";

export const BUILTIN_CATEGORY_WEIGHTS: Record<BuiltinBenchmarkCategory, number> = {
  routing_accuracy: 17,
  boundary_clarity: 15,
  review_quality: 20,
  handoff_quality: 15,
  system_architecture: 15,
  code_hygiene: 10,
  constraint_handling: 8
};

export const DEFAULT_PROFILE_ID = "default";

type BuiltInSeed = {
  taskId: string;
  category: BuiltinBenchmarkCategory;
  criticalRegression: boolean;
  promptText: string;
  rubricText: string | null;
};

const DEFAULT_SEEDS: BuiltInSeed[] = [
  {
    taskId: "default_usage_001",
    category: "routing_accuracy",
    criticalRegression: false,
    promptText:
      "Review the library and decide whether its skills clearly say when to use them and when not to use them.",
    rubricText:
      "0 no usage guidance\n1 vague usage guidance\n2 some usage guidance but weak boundaries\n3 clear use and do-not-use guidance\n4 crisp routing guidance with strong avoid-overuse boundaries"
  },
  {
    taskId: "default_discovery_001",
    category: "routing_accuracy",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether a user can quickly discover the right skill instead of guessing among overlapping choices.",
    rubricText:
      "0 discovery is chaotic\n1 discovery is weak\n2 some discoverability but overlapping choices remain\n3 good discovery with modest overlap\n4 very clear routing and discoverability with minimal overlap"
  },
  {
    taskId: "default_boundary_001",
    category: "boundary_clarity",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills draw clear boundaries about what they are and what they are not.",
    rubricText:
      "0 boundaries missing\n1 boundaries muddy\n2 some boundary language\n3 clear what-it-is and what-it-is-not framing\n4 crisp boundaries that reduce misuse and overlap"
  },
  {
    taskId: "default_boundary_002",
    category: "boundary_clarity",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether adjacent skills have distinct responsibilities instead of accumulating duplicate scope.",
    rubricText:
      "0 duplicate scope everywhere\n1 heavy overlap\n2 partial separation\n3 mostly clear ownership boundaries\n4 strong replace-don't-accumulate boundaries across the library"
  },
  {
    taskId: "default_review_001",
    category: "review_quality",
    criticalRegression: true,
    promptText:
      "Review the library and determine whether its important skills require evidence, verification, or acceptance criteria instead of vague judgment.",
    rubricText:
      "0 no evidence bar\n1 vague evidence bar\n2 some evidence language but weak criteria\n3 clear evidence and verification guidance\n4 strong evidence bar with explicit acceptance discipline"
  },
  {
    taskId: "default_review_002",
    category: "review_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills provide concrete steps, examples, or commands instead of only abstract advice.",
    rubricText:
      "0 no concrete workflow\n1 mostly abstract advice\n2 some concrete guidance\n3 practical workflow support\n4 highly usable examples or steps that make the skill easy to execute"
  },
  {
    taskId: "default_handoff_001",
    category: "handoff_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills leave the user with a clear next action, output shape, or handoff.",
    rubricText:
      "0 no handoff\n1 weak next action\n2 partial handoff\n3 clear next action and output\n4 strong next action and durable handoff guidance"
  },
  {
    taskId: "default_handoff_002",
    category: "handoff_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether it preserves useful context without turning every skill into bloated ceremony.",
    rubricText:
      "0 bloated and noisy\n1 too ceremonial\n2 mixed signal\n3 mostly lean and practical\n4 sharp, practical, and context-rich without bloat"
  },
  // --- system_architecture ---
  {
    taskId: "arch_structure_001",
    category: "system_architecture",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills form a coherent system with clear layering, dependency flow, and separation of concerns — rather than a flat bag of independent files.",
    rubricText:
      "0 no structure\n1 minimal grouping\n2 some structure but unclear hierarchy\n3 clear layering with explicit dependency direction\n4 strong architectural coherence with clean dependency graph and explicit ownership"
  },
  {
    taskId: "arch_composition_001",
    category: "system_architecture",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills compose cleanly — can they chain, delegate, or invoke each other without creating circular dependencies or duplicating logic?",
    rubricText:
      "0 no composition model\n1 ad hoc references\n2 some delegation but unclear contracts\n3 clear composition patterns with defined interfaces\n4 explicit composition model with no circular deps and reusable building blocks"
  },
  // --- code_hygiene ---
  {
    taskId: "hygiene_bloat_001",
    category: "code_hygiene",
    criticalRegression: true,
    promptText:
      "Review the library and determine whether its skills stay lean and purposeful, or whether they accumulate additive content — disclaimers, redundant sections, duplicated instructions — that dilutes signal.",
    rubricText:
      "0 heavily bloated\n1 significant padding\n2 some unnecessary bulk\n3 mostly lean with minor padding\n4 sharp and minimal with no additive waste"
  },
  {
    taskId: "hygiene_replace_001",
    category: "code_hygiene",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether changes follow replace-don't-accumulate discipline — when a skill is updated, does it replace cleanly or layer new content on top of old?",
    rubricText:
      "0 pure accumulation\n1 mostly additive\n2 mixed\n3 mostly replacement discipline\n4 strong replace-don't-accumulate throughout"
  },
  // --- constraint_handling ---
  {
    taskId: "constraint_ambiguity_001",
    category: "constraint_handling",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills handle ambiguous or underspecified inputs — do they define what to do when the user request is vague, maps to multiple skills, or lacks critical context?",
    rubricText:
      "0 no ambiguity handling\n1 vague fallback\n2 some disambiguation\n3 clear disambiguation with fallback routing\n4 explicit ambiguity protocol with decision criteria and graceful degradation"
  },
  {
    taskId: "constraint_partial_001",
    category: "constraint_handling",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills degrade gracefully under constraints — partial information, missing context, or tight scope — rather than failing silently or producing garbage.",
    rubricText:
      "0 silent failure\n1 crashes or produces garbage\n2 acknowledges limits but no recovery\n3 degrades gracefully with explicit scope reduction\n4 robust constraint handling with explicit partial-result signaling"
  }
];

function createBuiltInTask(seed: BuiltInSeed): BenchmarkTask {
  return {
    task_id: seed.taskId,
    task_version: 1,
    family: DEFAULT_PROFILE_ID,
    category: seed.category,
    critical_regression: seed.criticalRegression,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 4,
    trials_per_side: 5,
    prompt_text: seed.promptText,
    rubric_text: seed.rubricText
  };
}

function validateTaskIdUniqueness(tasks: BenchmarkTask[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.task_id)) {
      throw new Error(`Duplicate task ID '${task.task_id}' in profile. Task IDs must be unique within a profile.`);
    }
    seen.add(task.task_id);
  }
}

function createBenchmarkProfile(): BenchmarkProfile {
  const tasks = DEFAULT_SEEDS.map(createBuiltInTask);
  validateTaskIdUniqueness(tasks);
  return {
    profile_id: DEFAULT_PROFILE_ID,
    label: "Default",
    description: "Generic benchmark for markdown skill libraries with no repo-specific assumptions.",
    tasks,
    pack: {
      pack_id: `${DEFAULT_PROFILE_ID}-benchmark-pack-v1`,
      source: "built_in_pack",
      task_ids: tasks.map((task) => task.task_id),
      category_weights: BUILTIN_CATEGORY_WEIGHTS,
      critical_task_ids: tasks.filter((task) => task.critical_regression).map((task) => task.task_id),
      catalog_hash: computeBenchmarkPackHash(tasks)
    }
  };
}

const PROFILE_REGISTRY: BenchmarkProfile[] = [createBenchmarkProfile()];

/**
 * Register a custom profile into the profile registry.
 * This makes it available via getBenchmarkProfile() and listBenchmarkProfiles().
 * If a profile with the same ID already exists, it is replaced.
 */
export function registerProfile(profile: BenchmarkProfile): void {
  const existingIndex = PROFILE_REGISTRY.findIndex((p) => p.profile_id === profile.profile_id);
  if (existingIndex >= 0) {
    PROFILE_REGISTRY[existingIndex] = profile;
  } else {
    PROFILE_REGISTRY.push(profile);
  }
}

export function listBenchmarkProfiles(): BenchmarkProfileSummary[] {
  return PROFILE_REGISTRY.map((profile) => ({
    profile_id: profile.profile_id,
    label: profile.label,
    description: profile.description,
    is_default: profile.profile_id === DEFAULT_PROFILE_ID
  }));
}

export function getBenchmarkProfile(profileId = DEFAULT_PROFILE_ID): BenchmarkProfile {
  const profile = PROFILE_REGISTRY.find((candidate) => candidate.profile_id === profileId);
  if (!profile) {
    const available = PROFILE_REGISTRY.map((candidate) => candidate.profile_id).join(", ");
    throw new Error(`Unknown Watchtower profile '${profileId}'. Available profiles: ${available}`);
  }
  return profile;
}
