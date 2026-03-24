import { computeBenchmarkPackHash } from "./hashing.js";
import { BenchmarkCategory, BenchmarkProfile, BenchmarkProfileSummary, BenchmarkTask } from "./schemas.js";

export const BUILTIN_CATEGORY_WEIGHTS: Record<BenchmarkCategory, number> = {
  routing_accuracy: 30,
  boundary_clarity: 25,
  review_quality: 25,
  handoff_quality: 20
};

export const DEFAULT_PROFILE_ID = "default";

type BuiltInSeed = {
  taskId: string;
  family: string;
  category: BenchmarkCategory;
  criticalRegression: boolean;
  promptText: string;
  rubricText: string | null;
};

type ProfileSeed = {
  profileId: string;
  label: string;
  description: string;
  tasks: BuiltInSeed[];
};

const DEFAULT_SEEDS: BuiltInSeed[] = [
  {
    taskId: "default_usage_001",
    family: "default",
    category: "routing_accuracy",
    criticalRegression: false,
    promptText:
      "Review the library and decide whether its skills clearly say when to use them and when not to use them.",
    rubricText:
      "0 no usage guidance\n1 vague usage guidance\n2 some usage guidance but weak boundaries\n3 clear use and do-not-use guidance\n4 crisp routing guidance with strong avoid-overuse boundaries"
  },
  {
    taskId: "default_discovery_001",
    family: "default",
    category: "routing_accuracy",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether a user can quickly discover the right skill instead of guessing among overlapping choices.",
    rubricText:
      "0 discovery is chaotic\n1 discovery is weak\n2 some discoverability but overlapping choices remain\n3 good discovery with modest overlap\n4 very clear routing and discoverability with minimal overlap"
  },
  {
    taskId: "default_boundary_001",
    family: "default",
    category: "boundary_clarity",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills draw clear boundaries about what they are and what they are not.",
    rubricText:
      "0 boundaries missing\n1 boundaries muddy\n2 some boundary language\n3 clear what-it-is and what-it-is-not framing\n4 crisp boundaries that reduce misuse and overlap"
  },
  {
    taskId: "default_boundary_002",
    family: "default",
    category: "boundary_clarity",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether adjacent skills have distinct responsibilities instead of accumulating duplicate scope.",
    rubricText:
      "0 duplicate scope everywhere\n1 heavy overlap\n2 partial separation\n3 mostly clear ownership boundaries\n4 strong replace-don't-accumulate boundaries across the library"
  },
  {
    taskId: "default_review_001",
    family: "default",
    category: "review_quality",
    criticalRegression: true,
    promptText:
      "Review the library and determine whether its important skills require evidence, verification, or acceptance criteria instead of vague judgment.",
    rubricText:
      "0 no evidence bar\n1 vague evidence bar\n2 some evidence language but weak criteria\n3 clear evidence and verification guidance\n4 strong evidence bar with explicit acceptance discipline"
  },
  {
    taskId: "default_review_002",
    family: "default",
    category: "review_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills provide concrete steps, examples, or commands instead of only abstract advice.",
    rubricText:
      "0 no concrete workflow\n1 mostly abstract advice\n2 some concrete guidance\n3 practical workflow support\n4 highly usable examples or steps that make the skill easy to execute"
  },
  {
    taskId: "default_handoff_001",
    family: "default",
    category: "handoff_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether its skills leave the user with a clear next action, output shape, or handoff.",
    rubricText:
      "0 no handoff\n1 weak next action\n2 partial handoff\n3 clear next action and output\n4 strong next action and durable handoff guidance"
  },
  {
    taskId: "default_handoff_002",
    family: "default",
    category: "handoff_quality",
    criticalRegression: false,
    promptText:
      "Review the library and determine whether it preserves useful context without turning every skill into bloated ceremony.",
    rubricText:
      "0 bloated and noisy\n1 too ceremonial\n2 mixed signal\n3 mostly lean and practical\n4 sharp, practical, and context-rich without bloat"
  }
];

const PROFILE_SEEDS: ProfileSeed[] = [
  {
    profileId: DEFAULT_PROFILE_ID,
    label: "Default",
    description: "Generic benchmark for markdown skill libraries with no agent-skills-specific assumptions.",
    tasks: DEFAULT_SEEDS
  },
  {
    profileId: "lead-producer",
    label: "Lead Producer",
    description: "Scores smallest-sufficient orchestration, stress testing, acceptance discipline, and boundary clarity.",
    tasks: [
      {
        taskId: "lp_route_001",
        family: "lead-producer",
        category: "routing_accuracy",
        criticalRegression: false,
        promptText:
          "Review the lead-producer skill and decide whether it routes work to the smallest sufficient team with explicit routing discipline.",
        rubricText:
          "0 missing routing discipline\n1 weak routing guidance\n2 some routing guidance but inconsistent\n3 clear routing plus lean-team preference\n4 precise smallest-sufficient routing with explicit constraints"
      },
      {
        taskId: "lp_boundary_001",
        family: "lead-producer",
        category: "boundary_clarity",
        criticalRegression: false,
        promptText:
          "Review the lead-producer skill and determine whether it clearly says what it is and what it is not.",
        rubricText:
          "0 missing boundaries\n1 muddy boundaries\n2 some scope language\n3 clear boundaries\n4 crisp boundaries that prevent misuse"
      },
      {
        taskId: "lp_accept_001",
        family: "lead-producer",
        category: "review_quality",
        criticalRegression: true,
        promptText:
          "Review the lead-producer skill and determine whether acceptance requires evidence, Devil's Advocate review, and a clear accept-or-iterate gate.",
        rubricText:
          "0 no acceptance gate\n1 vague acceptance language\n2 some gate language but unclear evidence bar\n3 evidence-based acceptance with stress test\n4 operationally clear evidence gate with Devil's Advocate sign-off"
      },
      {
        taskId: "lp_handoff_001",
        family: "lead-producer",
        category: "handoff_quality",
        criticalRegression: false,
        promptText:
          "Review the lead-producer skill and determine whether its final reporting shape gives a durable handoff instead of vague synthesis.",
        rubricText:
          "0 no usable report shape\n1 weak report shape\n2 partial handoff\n3 clear report and open questions\n4 durable decision report with clear next action"
      }
    ]
  },
  {
    profileId: "team-product-team",
    label: "Team Product Team",
    description: "Scores product framing, scope boundaries, evidence-backed recommendation quality, and handoff clarity.",
    tasks: [
      {
        taskId: "product_route_001",
        family: "team-product-team",
        category: "routing_accuracy",
        criticalRegression: false,
        promptText:
          "Review the team-product-team skill and determine whether it is clearly targeted at product framing rather than general brainstorming.",
        rubricText:
          "0 target use unclear\n1 weak target use\n2 somewhat targeted\n3 clearly targeted product framing\n4 precise product routing with strong misuse prevention"
      },
      {
        taskId: "product_boundary_001",
        family: "team-product-team",
        category: "boundary_clarity",
        criticalRegression: false,
        promptText:
          "Review the team-product-team skill and determine whether it keeps product scope, value, and feasibility boundaries clear.",
        rubricText:
          "0 boundaries absent\n1 boundaries muddy\n2 some scope guidance\n3 clear scope and feasibility split\n4 crisp product-vs-technical boundaries and go/no-go framing"
      },
      {
        taskId: "product_review_001",
        family: "team-product-team",
        category: "review_quality",
        criticalRegression: true,
        promptText:
          "Review the team-product-team skill and decide whether it produces concrete, evidence-backed recommendations instead of vague idea lists.",
        rubricText:
          "0 no recommendation structure\n1 weak recommendation structure\n2 some structured output\n3 clear recommendation and evidence\n4 decisive recommendation with evidence and trade-offs"
      },
      {
        taskId: "product_handoff_001",
        family: "team-product-team",
        category: "handoff_quality",
        criticalRegression: false,
        promptText:
          "Review the team-product-team skill and determine whether it leaves a usable next step for the user or adjacent team.",
        rubricText:
          "0 no next step\n1 weak next step\n2 partial handoff\n3 clear next action\n4 strong actionable handoff with priorities"
      }
    ]
  },
  {
    profileId: "team-dev-team",
    label: "Team Dev Team",
    description: "Scores technical review routing, architecture boundaries, unified technical verdicts, and handoff clarity.",
    tasks: [
      {
        taskId: "dev_route_001",
        family: "team-dev-team",
        category: "routing_accuracy",
        criticalRegression: false,
        promptText:
          "Review the team-dev-team skill and determine whether it is clearly aimed at technical review rather than general advice.",
        rubricText:
          "0 target use unclear\n1 weak target use\n2 somewhat targeted\n3 clearly targeted technical review\n4 precise technical routing with strong misuse prevention"
      },
      {
        taskId: "dev_boundary_001",
        family: "team-dev-team",
        category: "boundary_clarity",
        criticalRegression: false,
        promptText:
          "Review the team-dev-team skill and determine whether architecture, code quality, and verification are connected rather than siloed.",
        rubricText:
          "0 concerns are siloed\n1 weak linkage\n2 partial linkage\n3 clearly linked architecture code and tests\n4 tightly integrated technical review with blocked-vs-advisory clarity"
      },
      {
        taskId: "dev_review_001",
        family: "team-dev-team",
        category: "review_quality",
        criticalRegression: true,
        promptText:
          "Review the team-dev-team skill and determine whether it yields a unified technical verdict with maintainability and verification rigor.",
        rubricText:
          "0 no unified verdict\n1 vague verdict\n2 some unified framing\n3 clear technical verdict\n4 strong maintainability and verification verdict with highest-priority fixes"
      },
      {
        taskId: "dev_handoff_001",
        family: "team-dev-team",
        category: "handoff_quality",
        criticalRegression: false,
        promptText:
          "Review the team-dev-team skill and determine whether its output creates a useful engineering handoff instead of a bag of unrelated notes.",
        rubricText:
          "0 no handoff\n1 weak handoff\n2 partial handoff\n3 clear engineering handoff\n4 durable prioritized handoff with clear risks"
      }
    ]
  },
  {
    profileId: "workflow-issue-triage",
    label: "Workflow Issue Triage",
    description: "Scores investigation packaging, scope boundaries, practical evidence handling, and next-step handoffs.",
    tasks: [
      {
        taskId: "triage_route_001",
        family: "workflow-issue-triage",
        category: "routing_accuracy",
        criticalRegression: false,
        promptText:
          "Review the workflow-issue-triage skill and determine whether it is clearly meant for investigation packaging and handoff.",
        rubricText:
          "0 target use unclear\n1 weak target use\n2 somewhat targeted\n3 clearly targeted issue triage\n4 precise investigation routing with strong misuse prevention"
      },
      {
        taskId: "triage_boundary_001",
        family: "workflow-issue-triage",
        category: "boundary_clarity",
        criticalRegression: false,
        promptText:
          "Review the workflow-issue-triage skill and determine whether it keeps investigation scope clear instead of expanding into generic project management.",
        rubricText:
          "0 boundaries absent\n1 boundaries muddy\n2 some scope control\n3 clear investigation boundary\n4 sharp scope control that prevents drift into ceremony"
      },
      {
        taskId: "triage_review_001",
        family: "workflow-issue-triage",
        category: "review_quality",
        criticalRegression: true,
        promptText:
          "Review the workflow-issue-triage skill and determine whether it captures findings with evidence rather than loose speculation.",
        rubricText:
          "0 no evidence discipline\n1 weak evidence discipline\n2 some evidence language\n3 clear evidence-backed findings\n4 strong evidence packaging with blocked-vs-open clarity"
      },
      {
        taskId: "triage_handoff_001",
        family: "workflow-issue-triage",
        category: "handoff_quality",
        criticalRegression: false,
        promptText:
          "Review the workflow-issue-triage skill and determine whether it packages investigations into a clean handoff with next steps.",
        rubricText:
          "0 no usable handoff\n1 weak handoff\n2 partial handoff\n3 clear handoff with next steps\n4 durable investigation package with clear owners and next slices"
      }
    ]
  }
];

function createBuiltInTask(seed: BuiltInSeed): BenchmarkTask {
  return {
    task_id: seed.taskId,
    task_version: 1,
    family: seed.family,
    category: seed.category,
    critical_regression: seed.criticalRegression,
    evaluator_kind: "rubric",
    priority: 50,
    min_valid_trials: 4,
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

function createBenchmarkProfile(seed: ProfileSeed): BenchmarkProfile {
  const tasks = seed.tasks.map(createBuiltInTask);
  validateTaskIdUniqueness(tasks);
  return {
    profile_id: seed.profileId,
    label: seed.label,
    description: seed.description,
    tasks,
    pack: {
      pack_id: `${seed.profileId}-benchmark-pack-v1`,
      source: "built_in_pack",
      task_ids: tasks.map((task) => task.task_id),
      category_weights: BUILTIN_CATEGORY_WEIGHTS,
      critical_task_ids: tasks.filter((task) => task.critical_regression).map((task) => task.task_id),
      catalog_hash: computeBenchmarkPackHash(tasks)
    }
  };
}

const BUILTIN_PROFILES = PROFILE_SEEDS.map(createBenchmarkProfile);

export function listBenchmarkProfiles(): BenchmarkProfileSummary[] {
  return BUILTIN_PROFILES.map((profile) => ({
    profile_id: profile.profile_id,
    label: profile.label,
    description: profile.description,
    is_default: profile.profile_id === DEFAULT_PROFILE_ID
  }));
}

export function getBenchmarkProfile(profileId = DEFAULT_PROFILE_ID): BenchmarkProfile {
  const profile = BUILTIN_PROFILES.find((candidate) => candidate.profile_id === profileId);
  if (!profile) {
    const available = BUILTIN_PROFILES.map((candidate) => candidate.profile_id).join(", ");
    throw new Error(`Unknown Watchtower profile '${profileId}'. Available profiles: ${available}`);
  }
  return profile;
}
