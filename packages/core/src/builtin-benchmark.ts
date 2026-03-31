import { computeBenchmarkPackHash } from "./hashing.js";
import { type BenchmarkCategory, type BenchmarkProfile, type BenchmarkProfileSummary, type BenchmarkTask } from "./schemas.js";

// --- Process-discipline profile (new default) ---

export const BUILTIN_CATEGORY_WEIGHTS: Record<string, number> = {
  structured_reasoning: 35,
  scope_discipline: 35,
  handoff_quality: 30
};

const PROCESS_CATEGORY_WEIGHTS = BUILTIN_CATEGORY_WEIGHTS;

export const DEFAULT_PROFILE_ID = "default";

type BuiltInSeed = {
  taskId: string;
  category: BenchmarkCategory;
  criticalRegression: boolean;
  evaluatorKind: "rubric" | "deterministic";
  promptText: string;
  rubricText: string | null;
  expectedAnswer?: string;
};

const PROCESS_SEEDS: BuiltInSeed[] = [
  {
    taskId: "functional_multidomain_001",
    category: "structured_reasoning",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "You have three conflicting specialist recommendations for a live-service game update. The backend engineer says to rebuild the inventory service for horizontal scaling (3 weeks). The game designer says to ship a new crafting system next sprint to hit a content deadline. The security engineer says the current auth token system has a known vulnerability and must be patched before any new features ship. Using any relevant skills from the loaded library, produce a structured resolution: who owns what decision, what ships in what order, what evidence supports each priority, and what gets deferred with stated consequences.",
    rubricText:
      "0 Ignores conflicts or picks one side arbitrarily\n1 Acknowledges conflict but no resolution framework\n2 Attempts to sequence but missing ownership or evidence\n3 Clear priority ordering with stated ownership, evidence for sequencing, and explicit deferrals\n4 Rigorous resolution with risk-ranked sequencing, ownership matrix, evidence chain for each decision, explicit assumptions, and a bounded scope for each work item"
  },
  {
    taskId: "functional_investigation_001",
    category: "structured_reasoning",
    criticalRegression: true,
    evaluatorKind: "rubric",
    promptText:
      "A production system intermittently returns incorrect pricing for 2-3% of orders. No recent deployments. The pricing service, inventory service, and cache layer all show normal metrics. Customer reports started 4 days ago but the team only noticed today. Using any relevant skills from the loaded library, produce a structured investigation plan: hypotheses ranked by likelihood, data needed to confirm or eliminate each, who should investigate what, and how to communicate status to stakeholders.",
    rubricText:
      "0 Jumps to a fix without investigation\n1 Lists possible causes but no methodology\n2 Some structured hypotheses but missing verification steps or ownership\n3 Ranked hypotheses with specific data requirements, investigation ownership, and stakeholder communication plan\n4 Comprehensive investigation package: hypotheses ranked with stated confidence, specific queries/logs to check for each, clear ownership per hypothesis, escalation triggers, and a handoff artifact if the first investigator cannot resolve"
  },
  {
    taskId: "functional_scope_001",
    category: "scope_discipline",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "A stakeholder asks: \"Make our platform more scalable, more secure, and easier for new developers to onboard. We have 6 weeks and 4 engineers.\" Using any relevant skills from the loaded library, respond to this request. Decide what is in scope vs out of scope, what to investigate first vs defer, and produce a scoped plan that can actually ship in the constraints.",
    rubricText:
      "0 Tries to do everything or gives vague advice\n1 Acknowledges the scope problem but does not resolve it\n2 Narrows somewhat but still overcommits or leaves scope ambiguous\n3 Explicitly bounds scope, names what is deferred and why, produces a plan that fits the constraints\n4 Sharp scope control: names the one or two highest-leverage areas, explicitly rejects or defers the rest with stated trade-offs, produces a concrete plan with acceptance criteria, and flags assumptions that could change the scope"
  },
  {
    taskId: "functional_scope_002",
    category: "scope_discipline",
    criticalRegression: true,
    evaluatorKind: "rubric",
    promptText:
      "You are midway through a 3-week sprint to add multi-currency support to a payment system. The product manager now asks to also add subscription billing \"since we're already changing the payment code.\" The team has 1.5 weeks left. Using any relevant skills from the loaded library, respond with a structured decision: accept, defer, or negotiate, with evidence for your recommendation and explicit impact on the original scope.",
    rubricText:
      "0 Accepts without analysis\n1 Pushes back but without evidence\n2 Analyzes impact but recommendation is vague\n3 Clear recommendation with impact analysis, timeline evidence, and explicit scope boundary\n4 Rigorous scope defense: quantified impact on current sprint, risk assessment of combining changes, explicit recommendation with reversibility analysis, and a concrete alternative timeline for the deferred work"
  },
  {
    taskId: "functional_handoff_001",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "You have completed a security review of a new API gateway. You found 3 issues: (1) JWT tokens don't expire for 30 days, (2) rate limiting is per-IP only (no user-level), (3) admin endpoints are accessible without role checks. The backend team will implement the fixes. Using any relevant skills from the loaded library, produce the handoff artifact: what exactly needs to change, what the acceptance criteria are for each fix, what can be done in parallel, and what the backend team should NOT change.",
    rubricText:
      "0 Vague summary or just a list of issues\n1 Issues described but no acceptance criteria or scope\n2 Some structure but missing priority, parallelism, or scope boundaries\n3 Clear handoff with per-issue acceptance criteria, priority ranking, and explicit scope boundaries\n4 Durable handoff artifact: each issue has severity, acceptance criteria, suggested implementation approach, what NOT to touch, parallelism guidance, and a verification plan the backend team can execute independently"
  },
  {
    taskId: "functional_handoff_002",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "After investigating a performance regression, you've found three contributing factors: (1) a new ORM query generating N+1 selects (accounts for ~60% of latency), (2) cache hit rate dropped from 95% to 70% after a config change, (3) connection pool is undersized for current load. Using any relevant skills from the loaded library, package your findings into a handoff for the engineering lead to make a prioritized fix decision. Include your confidence level for each finding and what you could NOT verify.",
    rubricText:
      "0 Raw notes or stream-of-consciousness\n1 Findings listed but no confidence levels or gaps\n2 Some structure but missing what was not verified\n3 Structured findings with confidence levels, verification gaps, and clear recommendation\n4 Decision-ready package: each finding has evidence, confidence level, what was verified and what was not, impact estimate, effort estimate, and a recommended fix order — actionable without the original investigator present"
  },
  {
    taskId: "functional_handoff_003",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Three teams have completed independent reviews of a proposed microservices migration: The platform team says it's feasible but needs 6 months. The product team says it will block 2 planned features. The security team says the current monolith has 3 critical vulnerabilities that would be easier to fix post-migration. Using any relevant skills from the loaded library, synthesize these into a single recommendation: go, no-go, or conditional-go, with the evidence chain and what decision the leadership team actually needs to make.",
    rubricText:
      "0 Picks one team's view without synthesis\n1 Summarizes all views but no recommendation\n2 Recommendation present but not grounded in evidence from all three teams\n3 Clear recommendation with evidence chain connecting all three perspectives and explicit trade-offs\n4 Decision-ready synthesis: recommendation with evidence chain, dissenting concerns preserved (not collapsed), explicit assumptions, reversibility assessment, and a clear articulation of what leadership is actually deciding — not the implementation details"
  },
  {
    taskId: "functional_routing_001",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "A developer reports: \"The checkout flow is broken for users in Japan. Sometimes the total is wrong, sometimes the page crashes. I think it's a currency conversion bug but it might be a frontend rendering issue or a timezone thing.\" Using any relevant skills from the loaded library, route this to the right people, scope the initial investigation, define what \"fixed\" means, and produce the first communication to the team.",
    rubricText:
      "0 Starts fixing without routing or scoping\n1 Assigns to someone but no investigation scope or definition of done\n2 Some routing and scope but missing communication or acceptance criteria\n3 Clear routing with investigation scope, definition of done, and team communication\n4 Full routing package: assigns ownership with rationale, scopes investigation to avoid premature fixing, defines acceptance criteria, produces stakeholder communication, and sets a check-in point to prevent drift"
  }
];

// --- Library-quality profile (old default, diagnostic) ---

const LIBRARY_QUALITY_CATEGORY_WEIGHTS: Record<string, number> = {
  routing_accuracy: 30,
  boundary_clarity: 25,
  review_quality: 25,
  handoff_quality: 20
};

const LIBRARY_QUALITY_SEEDS: BuiltInSeed[] = [
  {
    taskId: "libqual_usage_001",
    category: "routing_accuracy",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and decide whether its skills clearly say when to use them and when not to use them.",
    rubricText:
      "0 no usage guidance\n1 vague usage guidance\n2 some usage guidance but weak boundaries\n3 clear use and do-not-use guidance\n4 crisp routing guidance with strong avoid-overuse boundaries"
  },
  {
    taskId: "libqual_discovery_001",
    category: "routing_accuracy",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether a user can quickly discover the right skill instead of guessing among overlapping choices.",
    rubricText:
      "0 discovery is chaotic\n1 discovery is weak\n2 some discoverability but overlapping choices remain\n3 good discovery with modest overlap\n4 very clear routing and discoverability with minimal overlap"
  },
  {
    taskId: "libqual_boundary_001",
    category: "boundary_clarity",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether its skills draw clear boundaries about what they are and what they are not.",
    rubricText:
      "0 boundaries missing\n1 boundaries muddy\n2 some boundary language\n3 clear what-it-is and what-it-is-not framing\n4 crisp boundaries that reduce misuse and overlap"
  },
  {
    taskId: "libqual_boundary_002",
    category: "boundary_clarity",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether adjacent skills have distinct responsibilities instead of accumulating duplicate scope.",
    rubricText:
      "0 duplicate scope everywhere\n1 heavy overlap\n2 partial separation\n3 mostly clear ownership boundaries\n4 strong replace-don't-accumulate boundaries across the library"
  },
  {
    taskId: "libqual_review_001",
    category: "review_quality",
    criticalRegression: true,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether its important skills require evidence, verification, or acceptance criteria instead of vague judgment.",
    rubricText:
      "0 no evidence bar\n1 vague evidence bar\n2 some evidence language but weak criteria\n3 clear evidence and verification guidance\n4 strong evidence bar with explicit acceptance discipline"
  },
  {
    taskId: "libqual_review_002",
    category: "review_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether its skills provide concrete steps, examples, or commands instead of only abstract advice.",
    rubricText:
      "0 no concrete workflow\n1 mostly abstract advice\n2 some concrete guidance\n3 practical workflow support\n4 highly usable examples or steps that make the skill easy to execute"
  },
  {
    taskId: "libqual_handoff_001",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether its skills leave the user with a clear next action, output shape, or handoff.",
    rubricText:
      "0 no handoff\n1 weak next action\n2 partial handoff\n3 clear next action and output\n4 strong next action and durable handoff guidance"
  },
  {
    taskId: "libqual_handoff_002",
    category: "handoff_quality",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "Review the library and determine whether it preserves useful context without turning every skill into bloated ceremony.",
    rubricText:
      "0 bloated and noisy\n1 too ceremonial\n2 mixed signal\n3 mostly lean and practical\n4 sharp, practical, and context-rich without bloat"
  }
];

// --- Friction profile (simplicity check) ---

const FRICTION_CATEGORY_WEIGHTS: Record<string, number> = {
  friction: 100
};

const FRICTION_SEEDS: BuiltInSeed[] = [
  {
    taskId: "friction_email_001",
    category: "friction",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "A customer sent the following email: \"Hi, we've been using your API for our analytics pipeline. Last week we noticed response times went from ~200ms to ~800ms. We haven't changed anything on our end. Can you look into this? We need it resolved before our board presentation on Friday. Thanks, Sarah\"\n\nUsing any relevant skills from the loaded library, summarize this email in 2-3 sentences for an internal Slack thread.",
    rubricText:
      "0 Over-engineered response with unnecessary frameworks, routing, or process\n1 Adds significant unnecessary structure or ceremony\n2 Mostly concise but includes some unnecessary process overhead\n3 Clean, proportional summary appropriate for a Slack thread\n4 Crisp summary that captures urgency, core issue, and timeline without any overhead"
  },
  {
    taskId: "friction_commit_001",
    category: "friction",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "You just fixed a bug where the user avatar component was rendering at 0x0 pixels when the image URL returned a 404. The fix was adding a fallback to a default avatar SVG in the onError handler. Using any relevant skills from the loaded library, write a git commit message for this change.",
    rubricText:
      "0 Over-engineered commit message with unnecessary frameworks, categories, or process\n1 Adds significant unnecessary structure (routing, investigation reports, etc.)\n2 Mostly appropriate but includes some unnecessary overhead\n3 Clean, conventional commit message proportional to the change\n4 Crisp commit message that describes what changed and why, following standard conventions, no overhead"
  },
  {
    taskId: "friction_explain_001",
    category: "friction",
    criticalRegression: false,
    evaluatorKind: "rubric",
    promptText:
      "A junior developer asks you to explain this error they're seeing:\n\n```\nTypeError: Cannot read properties of undefined (reading 'map')\n    at UserList (UserList.tsx:15:28)\n    at renderWithHooks (react-dom.development.js:14985:18)\n```\n\nUsing any relevant skills from the loaded library, explain what this error means and how to fix it. Keep it appropriate for a junior developer.",
    rubricText:
      "0 Over-engineered response with investigation frameworks, routing, or formal process\n1 Adds significant unnecessary structure or ceremony for a simple explanation\n2 Mostly helpful but includes some unnecessary overhead\n3 Clean, proportional explanation appropriate for a junior developer\n4 Clear, friendly explanation of the error and fix, perfectly calibrated to the audience and task size"
  }
];

// --- Grounded verification profile ---

const GROUNDED_CATEGORY_WEIGHTS: Record<string, number> = {
  reasoning_accuracy: 40,
  engineering_accuracy: 60
};

const GROUNDED_SEEDS: BuiltInSeed[] = [
  {
    taskId: "grounded_logic_001",
    category: "reasoning_accuracy",
    criticalRegression: false,
    evaluatorKind: "deterministic",
    promptText:
      "Consider the following argument:\n\nPremise 1: All managers at TechCorp have completed the leadership training.\nPremise 2: Jordan has completed the leadership training.\nConclusion: Therefore, Jordan is a manager at TechCorp.\n\nUsing any relevant skills from the loaded library, determine whether this argument is logically valid or contains a fallacy. State the name of the fallacy if present, and explain your reasoning in 2-3 sentences.\n\nYour answer MUST start with exactly one of: VALID or FALLACY",
    rubricText: null,
    expectedAnswer: "FALLACY"
  },
  {
    taskId: "grounded_causal_001",
    category: "reasoning_accuracy",
    criticalRegression: false,
    evaluatorKind: "deterministic",
    promptText:
      "A city installed new LED streetlights on Main Street in January. Crime reports on Main Street dropped 30% by March. The city council claims the new streetlights caused the crime reduction.\n\nUsing any relevant skills from the loaded library, evaluate this causal claim. Are there plausible alternative explanations? Is the evidence sufficient to establish causation?\n\nYour answer MUST start with exactly one of: CAUSATION_SUPPORTED or CAUSATION_NOT_SUPPORTED",
    rubricText: null,
    expectedAnswer: "CAUSATION_NOT_SUPPORTED"
  },
  {
    taskId: "grounded_debug_001",
    category: "engineering_accuracy",
    criticalRegression: false,
    evaluatorKind: "deterministic",
    promptText:
      "Find the bug in this function:\n\n```python\ndef find_duplicates(items):\n    seen = set()\n    duplicates = set()\n    for item in items:\n        if item in seen:\n            duplicates.add(item)\n        seen.add(item)\n    return sorted(duplicates)\n```\n\nTest case: `find_duplicates([3, 1, 4, 1, 5, 9, 2, 6, 5])` should return `[1, 5]`.\n\nUsing any relevant skills from the loaded library, identify the bug (if any) or confirm the code is correct.\n\nYour answer MUST start with exactly one of: BUG_FOUND or NO_BUG",
    rubricText: null,
    expectedAnswer: "NO_BUG"
  },
  {
    taskId: "grounded_review_001",
    category: "engineering_accuracy",
    criticalRegression: false,
    evaluatorKind: "deterministic",
    promptText:
      "Find the bug in this function:\n\n```javascript\nfunction paginate(items, pageSize, pageNumber) {\n  const start = pageSize * pageNumber;\n  const end = start + pageSize;\n  return {\n    data: items.slice(start, end),\n    totalPages: Math.floor(items.length / pageSize),\n    currentPage: pageNumber,\n    hasNext: end < items.length\n  };\n}\n```\n\nTest case: `paginate(['a','b','c','d','e'], 2, 0)` should return `{ data: ['a','b'], totalPages: 3, currentPage: 0, hasNext: true }`.\nBut `paginate(['a','b','c','d','e'], 2, 0).totalPages` returns `2` instead of `3`.\n\nUsing any relevant skills from the loaded library, identify the bug.\n\nYour answer MUST start with exactly one of: BUG_FOUND or NO_BUG",
    rubricText: null,
    expectedAnswer: "BUG_FOUND"
  }
];

// --- Task builders ---

function createBuiltInTask(seed: BuiltInSeed, family: string): BenchmarkTask {
  return {
    task_id: seed.taskId,
    task_version: 1,
    family,
    category: seed.category,
    critical_regression: seed.criticalRegression,
    evaluator_kind: seed.evaluatorKind,
    priority: 50,
    min_valid_trials: seed.evaluatorKind === "deterministic" ? 2 : 4,
    trials_per_side: seed.evaluatorKind === "deterministic" ? 3 : 5,
    prompt_text: seed.promptText,
    rubric_text: seed.rubricText,
    ...(seed.expectedAnswer ? { expected_answer: seed.expectedAnswer } : {})
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

function buildProfile(
  profileId: string,
  label: string,
  description: string,
  seeds: BuiltInSeed[],
  categoryWeights: Record<string, number>
): BenchmarkProfile {
  const tasks = seeds.map((seed) => createBuiltInTask(seed, profileId));
  validateTaskIdUniqueness(tasks);
  return {
    profile_id: profileId,
    label,
    description,
    tasks,
    pack: {
      pack_id: `${profileId}-benchmark-pack-v1`,
      source: "built_in_pack",
      task_ids: tasks.map((task) => task.task_id),
      category_weights: categoryWeights,
      critical_task_ids: tasks.filter((task) => task.critical_regression).map((task) => task.task_id),
      catalog_hash: computeBenchmarkPackHash(tasks)
    }
  };
}

// --- Profile registry ---

const PROFILE_REGISTRY: BenchmarkProfile[] = [
  buildProfile(
    DEFAULT_PROFILE_ID,
    "Default (Process Discipline)",
    "Tests whether skills improve LLM engineering output: routing, scope control, evidence, handoff.",
    PROCESS_SEEDS,
    PROCESS_CATEGORY_WEIGHTS
  ),
  buildProfile(
    "library-quality",
    "Library Quality",
    "Documentation review: routing clarity, boundary definitions, evidence bars, handoff guidance.",
    LIBRARY_QUALITY_SEEDS,
    LIBRARY_QUALITY_CATEGORY_WEIGHTS
  ),
  buildProfile(
    "friction",
    "Friction",
    "Simplicity check: ensures skills don't over-complicate simple tasks like email summaries or commit messages.",
    FRICTION_SEEDS,
    FRICTION_CATEGORY_WEIGHTS
  ),
  buildProfile(
    "grounded",
    "Grounded Verification",
    "Objective accuracy: logic, causality, code debugging with known correct answers.",
    GROUNDED_SEEDS,
    GROUNDED_CATEGORY_WEIGHTS
  )
];

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
