# Watchtower Operational Workflows

Step-by-step guides for Watchtower's evaluation extensions: IRT calibration, Construction-Verification, and Composition analysis.

For the system architecture and module dependency graph, see [architecture.md](architecture.md).

## IRT Calibration Workflow

### Step 1: Accumulate trial data

```
# Fast: mock executor, ~60s for 20 runs
watchtower batch ./lib-v1 ./lib-v2 --runs 20 --parallel 4 --executor mock

# Higher quality: real executor, ~2hrs for 20 runs
watchtower batch ./lib-v1 ./lib-v2 --runs 20 --parallel 4 --executor codex --confirm
```

### Step 2: Calibrate

```
watchtower calibrate --batch <batch-id>
```

Output:
```
IRT Calibration Complete
  Model selected:  GRM (AIC: 142.3 vs 2PL AIC: 158.7)
  Items calibrated: 14
  Convergence:     37 iterations
  Mean ability:    0.52 (SD: 0.31)
  Saved:           calibrations/2026-03-24-default.json

  High-info tasks (most discriminating):
    boundary_overlap_001    a=2.1  Fisher=0.89
    arch_layering_001       a=1.8  Fisher=0.76

  Low-info tasks (noise candidates):
    handoff_context_001     a=0.3  Fisher=0.08
    constraint_partial_001  a=0.4  Fisher=0.12
```

### Step 3: Use in comparisons

```
watchtower compare ./lib-current ./lib-candidate --irt calibrations/2026-03-24-default.json --same-library
```

The IRT calibration adjusts category weights: tasks with high Fisher Information count more, tasks with low information count less. The overall verdict is based on the informative signal, not noise.

### Step 4: Interpreting results

**discrimination (a):** How sharply the task separates good from bad bundles. High (>1.5) = good discriminator. Low (<0.5) = noisy task, consider removing from profile.

**boundaries (b_1, b_2, b_3, b_4):** The ability levels at which the task transitions between score categories (4 boundaries for 5 score levels). Evenly spaced boundaries mean the task uses its full scoring range. Bunched boundaries mean most bundles cluster at one score level.

**Fisher Information:** How much information this task provides about a bundle's true ability. High (>0.5) = informative. Low (<0.1) = noise. Sum of Fisher Information across tasks = total profile informativeness.

**IRT weight:** Normalized Fisher Information [0, 1]. Tasks with weight < 0.1 are flagged as "low_info" in the calibration report.

### Validating IRT Weights on Your Profile

Before using IRT weights on a decision, run a reference comparison both ways:

```
# Without IRT
watchtower compare ./lib-current ./lib-candidate --same-library

# With IRT
watchtower compare ./lib-current ./lib-candidate --irt calibrations/latest.json --same-library
```

Compare the two scorecards. If the winner changes, inspect which tasks drove the difference. Tasks with `irt_weight < 0.1` are noise candidates — verify you agree they're noisy. If a task you consider important has low weight (low discrimination), that task may not be differentiating bundles effectively. Consider rewriting its prompt or rubric rather than overriding the weight.

**Worked example:**

Suppose your default profile has 3 categories: `planning` (weight 0.4), `code_hygiene` (weight 0.3), `architecture` (weight 0.3). After calibrating on 50 trials:

```
IRT Calibration Summary:
  task_decomposition_001   a=1.8  Fisher=0.72  irt_weight=1.00  (planning)
  priority_ordering_001    a=1.2  Fisher=0.45  irt_weight=0.63  (planning)
  handoff_context_001      a=0.3  Fisher=0.08  irt_weight=0.11  (planning)
  bloat_detection_001      a=1.5  Fisher=0.61  irt_weight=0.85  (code_hygiene)
  naming_consistency_001   a=0.4  Fisher=0.10  irt_weight=0.14  (code_hygiene)
  layering_001             a=1.7  Fisher=0.68  irt_weight=0.94  (architecture)
  ownership_001            a=0.9  Fisher=0.31  irt_weight=0.43  (architecture)
```

Category weight adjustment:
- `planning`: mean_irt = (1.00 + 0.63 + 0.11) / 3 = 0.58 → adjusted weight = 0.4 × 0.58 = 0.232
- `code_hygiene`: mean_irt = (0.85 + 0.14) / 2 = 0.50 → adjusted weight = 0.3 × 0.50 = 0.150
- `architecture`: mean_irt = (0.94 + 0.43) / 2 = 0.69 → adjusted weight = 0.3 × 0.69 = 0.207

Before IRT: Lib-A wins planning (0.4 weight), Lib-B wins code_hygiene and architecture.
After IRT: planning shrinks from 0.4 → 0.232 because `handoff_context_001` is noisy (a=0.3). Architecture grows relatively. If Lib-B's architecture lead is real signal, IRT strengthens the verdict.

**What to investigate if you disagree:** `handoff_context_001` has a=0.3 (low discrimination). Either:
1. The task prompt is too vague — rewrite it.
2. All bundles genuinely score the same on handoff context — remove from profile.
3. The task IS important but bundles don't vary — keep it, accept the low weight (it doesn't penalize, just reduces influence).

### When NOT to use IRT

- You have fewer than 30 trials or 5 bundles. Calibration won't run.
- You're comparing two completely new libraries with no history. IRT needs prior data.
- Your profile has tasks that are intentionally easy (baseline checks). IRT will correctly flag these as low-information, which might not be what you want.

### Staleness

If you change your profile (add/remove tasks, change weights), the calibration becomes stale. Watchtower detects this:

```
WARNING: Profile hash (a3f2...) differs from calibration hash (7c1b...).
IRT weights may not reflect current task set. Re-calibrate recommended.
```

Re-run `watchtower batch` then `watchtower calibrate` after profile changes.

---

## Construction-Verification (C-V) Workflow

### Step 1: Add C-V checks to a profile task

```json
{
  "task_id": "arch_layering_001",
  "extensions": {
    "cv": {
      "construction_cues": ["layers", "dependencies", "interfaces"],
      "verification_checks": [
        {
          "check_id": "no_circular_deps",
          "kind": "dependency",
          "rule": "requires:layer AND absent:circular AND before:interface,implementation",
          "weight": 40,
          "critical": true,
          "description": "Architecture defines layers with interfaces before implementations, no circular references"
        },
        {
          "check_id": "separation_of_concerns",
          "kind": "semantic",
          "rule": "section:\"Architecture\" AND count:boundary>=2",
          "weight": 30,
          "critical": false,
          "description": "Has an Architecture section with at least 2 boundary definitions"
        }
      ],
      "construction_weight": 0.3,
      "verification_weight": 0.7,
      "firewall": true
    }
  }
}
```

### Step 2: Run comparison

```
watchtower compare --profile my-cv-profile ./lib-a ./lib-b --mode same_library
```

### Step 3: Interpreting C-V results

The trial result includes extension metadata:

```json
{
  "extension_metadata": {
    "construction_score": 0.85,
    "verification_score": 0.40,
    "combined_score": 0.535,
    "shortcut_detected": true,
    "critical_failure": false,
    "checks_passed": 1,
    "checks_failed": 1,
    "checks_total": 2
  }
}
```

**construction_score:** How structurally complete the bundle is (has the right files, sections, keywords).

**verification_score:** How many formal property checks pass. This is the meaningful signal.

**shortcut_detected:** Construction > 0.7 but verification < 0.3. The bundle *looks* right but *isn't* right. The library has the right keywords but wrong structure. This is the key C-V insight.

**critical_failure:** A check marked `critical: true` failed. Even if overall scores are OK, this is a hard failure.

### Mock vs Real Executor: Semantic Gap

**Mock executor:** Rules like `requires:interface` do case-insensitive substring matching against bundle text. Fast, deterministic, good for iteration.

**Real executor (Codex/Claude):** Two separate LLM invocations per trial. Construction prompt asks "does this bundle have X?" Verification prompt asks "does X satisfy property Y?" Evaluation is semantic, not substring.

**Expected divergence:** Mock scores are typically 10-30% higher than real scores because substring matching is more permissive than semantic evaluation. Use mock for profile development. Use real executor for decisions.

### When NOT to use C-V

- Subjective quality tasks (tone, style, naming) — C-V checks formal properties, not aesthetics
- Tasks where keyword presence is the actual signal (e.g., "does the library mention error handling") — regular scoring is sufficient
- When cost is a constraint — C-V doubles real executor cost per trial

---

## Composition Analysis Workflow

### Step 1: Run the composition profile

```
watchtower compare --profile composition ./lib-a ./lib-b --mode same_library
```

### Step 2: Interpreting results

The composition profile tests 8 tasks across 3 layers:

**Primitives (4 tasks, 20% weight):** Do individual skills exist? (planning, architecture, review, hygiene)

**Compositions (2 tasks, 40% weight):** Do skills compose? (planning+architecture = valid plans; review+hygiene = mutual reinforcement)

**Meta (2 tasks, 40% weight):** Does the composition pattern generalize? (can you apply plan+arch to a new domain? does review+hygiene teach the pattern, not just the instance?)

### Interpreting collapse

```
Composition Analysis:
  Primitive mean:    0.75
  Composition mean:  0.25
  Collapse detected: true
  Collapse severity: 0.67

  Failing compositions:
    comp_plan_arch_001:     0.25  (plan + architecture integration)
    comp_review_hygiene_001: 0.25  (review + hygiene reinforcement)

  Passing primitives:
    comp_plan_001:     0.75
    comp_arch_001:     0.75
    comp_review_001:   0.75
    comp_hygiene_001:  0.75
```

**What this means:** The library teaches each skill in isolation (primitives score well) but doesn't help agents combine them (compositions fail). The library has planning guidance and architecture guidance, but they don't reference each other — plans don't respect architectural constraints, and architecture docs don't inform planning.

**What to do:** Add cross-references and shared vocabulary. When the planning skill mentions "subtask breakdown," it should reference the architecture skill's layer definitions. When the architecture skill defines boundaries, it should note how planning should respect them. The composition profile will detect this improvement.

### Collapse severity scale

| Severity | Meaning | Action |
|----------|---------|--------|
| 0 | No collapse | Library composes well |
| 0.1-0.3 | Mild | Some integration gaps; review specific failing tasks |
| 0.3-0.6 | Moderate | Significant composition weakness; add cross-references and shared vocabulary |
| 0.6-1.0 | Severe | Library teaches skills in isolation; major rework needed |

### When NOT to use Composition

- Your library intentionally contains independent, non-composable skills (e.g., a collection of standalone utilities)
- You only care about individual skill quality, not how they combine
- You're using mock executor for final decisions — composition tasks give directional signal with mock, use real executor for high-stakes judgments
- **Your domain doesn't map to the built-in 8 tasks.** The default composition tasks assume software engineering domains (planning, architecture, code review, hygiene). If your library covers a different domain (music composition, game design, data pipelines), the default tasks will produce meaningless results. In this case: either write custom composition tasks that match your domain (using the same primitive→composed→meta structure), or skip the composition profile entirely.
- **Your library has fewer than 4 composable skills.** The composition profile tests pairwise composition. With 2-3 skills, there aren't enough composition pairs to be statistically meaningful.

### Configuring collapse thresholds

Default thresholds (primitive_floor=0.6, composed_ceiling=0.3) are preliminary. Adjust per-profile:

```json
{
  "collapse_config": {
    "primitive_floor": 0.7,
    "composed_ceiling": 0.4
  }
}
```

Higher primitive_floor = stricter (only flag collapse when primitives are genuinely strong). Higher composed_ceiling = more sensitive (detect composition issues earlier).
