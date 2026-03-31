# Watchtower Profile Authoring Guide

This guide is for agents and humans creating custom benchmark profiles for Watchtower. A profile defines what Watchtower measures and how it scores skill libraries.

## When to Create a Custom Profile

Use the built-in `default` profile for general-purpose skill library evaluation. Create a custom profile when you need to evaluate a specific domain (game design, security, DevOps), change scoring weights, add domain-specific rubrics, reduce task breadth for faster runs, or increase trial counts for higher-confidence results.

## Profile File Format

Profiles are JSON files. Save with any name (e.g., `my-profile.json`) and load with `--profile-file`:

```bash
npm run watchtower -- compare ./lib-a ./lib-b --profile-file ./my-profile.json
```

### Minimal Example

```json
{
  "profile_id": "my-domain",
  "label": "My Domain",
  "description": "What this profile measures and why.",
  "category_weights": {
    "category_a": 60,
    "category_b": 40
  },
  "tasks": [
    {
      "task_id": "domain_task_001",
      "category": "category_a",
      "prompt_text": "Review the library and determine whether [specific quality].",
      "rubric_text": "0 absent\n1 weak\n2 partial\n3 clear\n4 strong"
    }
  ]
}
```

### Full Schema Reference

```json
{
  "profile_id": "string (required, unique identifier)",
  "label": "string (required, human-readable name)",
  "description": "string (required, what this profile measures)",

  "extends_default": false,
  "exclude_tasks": ["task_id_to_remove"],
  "exclude_categories": ["category_to_remove"],

  "category_weights": {
    "category_name": 50
  },

  "default_trials_per_side": 5,

  "tasks": [
    {
      "task_id": "string (required, unique within profile)",
      "category": "string (required, must match a key in category_weights)",
      "prompt_text": "string (required, the evaluation instruction)",
      "rubric_text": "string (optional, 0-4 scale rubric)",
      "critical_regression": false,
      "evaluator_kind": "rubric",
      "trials_per_side": 5,
      "mock_cues": ["keyword1", "keyword2"]
    }
  ]
}
```

## Field-by-Field Guidance

### profile_id

A unique string identifier. Use lowercase with hyphens: `game-design`, `security-audit`, `code-review-only`. This ID is used in CLI output and Elo tracking — changing it creates a new profile in Watchtower's eyes.

### category_weights

Maps category names to numeric weights. Weights are relative — they don't need to sum to 100, but it's conventional. A category with weight 40 counts twice as much as one with weight 20 in the overall score.

Every category referenced by a task must have a weight. Categories with a weight but no tasks are silently dropped.

### extends_default

When `true`, your profile starts with all 8 default process-discipline tasks and 3 default category weights (structured_reasoning 35, scope_discipline 35, handoff_quality 30), then applies your customizations on top. Use this when you want the default evaluation plus your additions.

When `false` (default), your profile is standalone — only your tasks and weights are used.

### exclude_tasks / exclude_categories

Only meaningful when `extends_default: true`. These remove inherited tasks before your custom tasks are added.

`exclude_tasks` takes exact task IDs: `["functional_multidomain_001", "functional_routing_001"]`.

`exclude_categories` takes category names: `["scope_discipline", "handoff_quality"]`. This removes all tasks in those categories and drops the corresponding weight.

Use `exclude_categories` to remove entire dimensions you don't care about. Use `exclude_tasks` to surgically remove individual tests while keeping the rest of the category.

### default_trials_per_side

How many times each task runs per side per comparison. Default: 5. Range: 1–20.

Lower values (2–3) give faster runs but lower statistical confidence. Higher values (8–10) give more reliable scores but take longer. Per-task `trials_per_side` overrides this.

### tasks

Each task defines one evaluation probe. A profile should have at least 2 tasks per category for meaningful category scores.

#### task_id

Must be unique within the profile. Convention: `{prefix}_{topic}_{number}`, e.g., `gd_balance_001`. If `extends_default: true` and a custom task has the same ID as a default task, the custom task replaces it.

#### prompt_text

The evaluation instruction sent to the executor. Write as a directive: "Review the library and determine whether..." followed by the specific quality being measured. Be concrete and observable. Avoid vague language like "good" or "quality" — say what you mean.

#### rubric_text

A 0–4 scale rubric. Format: `"0 description\n1 description\n2 description\n3 description\n4 description"`. Each level should describe observable criteria, not just intensity words. The rubric is visible to real executors (Codex, Claude) and shapes their scoring.

If omitted, the task uses a generic pass/fail evaluation. Rubric-based scoring is strongly recommended.

#### critical_regression

When `true`, a regression on this task blocks the `replace` action even if the overall score improves. Use sparingly — only for tasks that represent non-negotiable quality floors (e.g., "does not produce harmful output").

#### mock_cues

Array of keywords the mock executor uses to score this task against the skill library text. Without mock_cues, custom tasks fall back to generic keyword extraction from the prompt and rubric, which produces less differentiated scores.

Include 4–8 keywords that are likely to appear in a high-quality skill library for this dimension and unlikely to appear in a low-quality one.

## Common Patterns

### Narrow the Default Profile

Run only architecture and hygiene checks:

```bash
npm run watchtower -- compare ./a ./b --categories structured_reasoning,scope_discipline
```

Or as a profile file:

```json
{
  "profile_id": "arch-hygiene",
  "label": "Architecture and Hygiene",
  "description": "Focused on system structure and code cleanliness.",
  "extends_default": true,
  "exclude_categories": ["structured_reasoning", "scope_discipline"],
  "category_weights": {},
  "tasks": []
}
```

### Extend Default with Domain Tasks

```json
{
  "profile_id": "gamedev",
  "label": "Game Development",
  "description": "Default evaluation plus game design dimensions.",
  "extends_default": true,
  "category_weights": {
    "gameplay_depth": 25,
    "balance": 20
  },
  "tasks": [
    {
      "task_id": "gd_depth_001",
      "category": "gameplay_depth",
      "prompt_text": "Review the library and determine whether its skills address emergent gameplay.",
      "rubric_text": "0 no depth\n1 surface only\n2 some awareness\n3 clear guidance\n4 strong systems thinking",
      "mock_cues": ["emergent", "system", "interaction", "depth"]
    },
    {
      "task_id": "gd_balance_001",
      "category": "balance",
      "prompt_text": "Review the library and determine whether its skills address fairness and counterplay.",
      "rubric_text": "0 no balance\n1 vague\n2 some guidance\n3 clear framework\n4 strong methodology",
      "mock_cues": ["balance", "fairness", "counterplay", "asymmetric"]
    }
  ]
}
```

### Fast Smoke Test

3 trials, only critical categories:

```json
{
  "profile_id": "smoke",
  "label": "Smoke Test",
  "description": "Quick sanity check with reduced trials.",
  "extends_default": true,
  "exclude_categories": ["constraint_handling", "handoff_quality"],
  "category_weights": {},
  "tasks": [],
  "default_trials_per_side": 3
}
```

### Standalone Domain Profile

No inheritance, fully custom:

```json
{
  "profile_id": "security",
  "label": "Security Audit",
  "description": "Evaluates security-focused skill libraries.",
  "category_weights": {
    "threat_modeling": 40,
    "access_control": 35,
    "incident_response": 25
  },
  "default_trials_per_side": 7,
  "tasks": [
    {
      "task_id": "sec_threat_001",
      "category": "threat_modeling",
      "prompt_text": "Review the library and determine whether its skills help identify and prioritize threats systematically.",
      "rubric_text": "0 no threat modeling\n1 ad hoc\n2 some structure\n3 clear methodology\n4 comprehensive threat modeling with prioritization",
      "critical_regression": true,
      "mock_cues": ["threat", "risk", "prioritize", "attack", "surface", "model"]
    }
  ]
}
```

## Validation

Watchtower validates profiles on load. Common errors:

- `'task_id' must be a non-empty string` — missing or empty task ID
- `Task category 'X' has no weight` — task references a category not in `category_weights`
- `Duplicate task_id 'X'` — two tasks share the same ID
- `'trials_per_side' must be between 1 and 20` — out of range
- `'category_weights' must have at least one category` — empty weights object

All errors include the field path and a human-readable message.

## For Agents

When building a profile programmatically, use the TypeScript API:

```typescript
import { buildProfileFromExternal, registerProfile, registerMockCuesFromProfile } from "@watchtower/core";

const def = { profile_id: "...", label: "...", ... };
const profile = buildProfileFromExternal(def);
registerProfile(profile);
registerMockCuesFromProfile(def);
```

Then run comparisons with `profileId: "your-profile-id"`. The profile is available for the lifetime of the process.
