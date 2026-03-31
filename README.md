# Watchtower

A local benchmark for markdown skill libraries. Compare two skill-library roots — local folders, GitHub repos, or one of each — and get a decision: winner, score delta, confidence, regressions, and a recommended next action.

## Quick Start

```bash
npm install
npm run watchtower -- compare "./test-fixtures/bad-skill" "./test-fixtures/good-skill" --scenario head_to_head --executor mock
```

No API keys, no accounts, no configuration. The mock executor runs entirely local.

Four common starting points:

```bash
# 1. Baseline: see what scores your library gets
npm run watchtower -- compare ./my-library ./my-library --executor mock

# 2. Head-to-head: pick a winner between two libraries
npm run watchtower -- compare ./lib-a ./lib-b --scenario head_to_head --executor mock

# 3. Refactor check: verify a rewrite didn't regress
npm run watchtower -- compare ./lib-before ./lib-after --scenario version_upgrade --executor mock

# 4. Compete against a public reference library
npm run watchtower -- compare ./my-library "github://saemihemma/lead-producer" --executor mock
```

[saemihemma/lead-producer](https://github.com/saemihemma/lead-producer) is a publicly available skill library you can use as a comparison target. It is not special-cased by the code — any skill library works.

## Install

### From source (development)

Requires Node.js 18+ and npm. Git on `PATH` for GitHub source support.

```bash
git clone https://github.com/saemihemma/watchtower.git
cd watchtower
npm install
```

### From npm

Once published (not yet available — clone from source for now):

```bash
npm install -g @watchtower-bench/runner
watchtower compare ./lib-a ./lib-b --executor mock
```

Optional: configure a real executor for LLM-backed evaluations (see [Executors](#executors)).

## What Watchtower Does

Watchtower runs a benchmark profile against two skill-library snapshots, scores each side on a rubric, and produces a structured verdict. Each comparison includes a winner or `too_close_to_call` verdict, per-task scores with deltas and trial counts, category-level aggregates with configurable weights, bootstrap confidence intervals and Bayesian posterior summaries, regression detection with critical-regression blocking, a Devil's Advocate review challenging the verdict, and a recommended next action.

Reports are persisted as structured JSON (`watchtower-data/runs/`) and readable markdown (`watchtower-data/reports/`).

### Why Psychometric Benchmarking

Raw score averaging treats every benchmark task as equally informative. In practice, some tasks sharply differentiate good libraries from bad while others produce noise. A library might contain all the right keywords but in the wrong structure. Individual skills might work in isolation but fail when combined.

Watchtower addresses these with three evaluation extensions: IRT calibration identifies informative tasks and down-weights noise. Construction-Verification catches keyword-stuffed bundles that look right but aren't structurally sound. Compositional Abstraction detects libraries where skills work alone but fail together. All three are optional — standard comparisons work without them — but they're available when the stakes justify rigor.

## What Watchtower Does Not Do

Watchtower benchmarks markdown skill libraries. It does not score arbitrary codebases, provide per-skill merge automation, serve as a web application, or replace judgment when two libraries serve different audiences or have incompatible architecture.

## Platform Support

v1.0 supports macOS, Linux, and Windows. The CLI resolves paths cross-platform and the Claude executor uses `shell: true` for Windows compatibility.

## Commands

| Command | Purpose |
|---------|---------|
| `compare <left> <right>` | Run a benchmark comparison |
| `composite <left> <right>` | Run all profiles and compute weighted composite score |
| `tournament <lib1> <lib2> [...]` | Single-elimination bracket for 2–16 libraries |
| `batch <left> <right>` | Accumulate trial data for IRT calibration |
| `calibrate --batch <id>` | Fit IRT model to batch data |
| `show <run-id>` | Re-display a stored run |
| `replace <run-id> --confirm` | Replace the loser with the winner (local only) |
| `leaderboard` | Show Elo ratings |
| `history` | Show recent match history |
| `profiles` | List available profiles and scenarios |

### Key flags

| Flag | Commands | Description |
|------|----------|-------------|
| `--executor <mock\|codex\|claude>` | compare, tournament, batch | Executor mode |
| `--scenario <name>` | compare | Comparison scenario |
| `--profile-file <path>` | compare, tournament, batch | Custom profile JSON |
| `--categories <a,b,...>` | compare | Subset categories from profile |
| `--irt <path>` | compare | Apply IRT calibration weights |
| `--runs <n>` | batch | Number of batch runs (1–500) |
| `--parallel <n>` | batch | Concurrent runs (1–8, clamped) |
| `--seed <n>` | compare, tournament | PRNG seed for reproducibility |
| `--same-library` | compare | Enables same-library comparison mode |
| `--winner-to <left\|right>` | replace | Which side to replace with the winner |
| `--confirm` | replace, batch | Required for destructive or costly operations |
| `--json` | compare, tournament | JSON output to stdout |

## Sources

Watchtower accepts local paths (`./skills`, `/path/to/skills`), GitHub shorthand (`github://owner/repo`, `github://owner/repo@branch`), and GitHub URLs (`https://github.com/owner/repo`). Remote sources are cloned to a temp directory, benchmarked, and cleaned up. Remote replacement is not supported.

See [docs/source-inputs.md](./docs/source-inputs.md) for the full source-resolution spec.

## Benchmark Profiles

The default profile tests process discipline — whether skills improve LLM engineering output. It evaluates 8 tasks across 3 weighted categories:

| Category | Weight | Tasks |
|----------|--------|-------|
| Structured Reasoning | 35 | Cross-domain conflict resolution, ambiguous production investigation |
| Scope Discipline | 35 | Overbroad request scoping, scope creep defense |
| Handoff Quality | 30 | Specialist handoff, investigation handoff, cross-team synthesis, routing |

Each task uses a 0–4 rubric scale. Scores are normalized to [0, 1] for aggregation. A token tax penalizes excessively verbose output.

### Built-in Profiles

Four profiles ship with Watchtower:

| Profile | Tasks | Focus |
|---------|-------|-------|
| `default` | 8 process tasks, 3 categories | Process discipline: routing, scope, evidence, handoff |
| `library-quality` | 8 doc-review tasks, 4 categories | Documentation quality: routing clarity, boundaries, evidence bars |
| `friction` | 3 simplicity tasks, 1 category | Simplicity check: skills don't over-complicate simple work |
| `grounded` | 4 deterministic tasks, 2 categories | Objective accuracy: logic, causality, code debugging |

```bash
# Run a specific profile
npm run watchtower -- compare ./lib-a ./lib-b --profile friction --executor mock

# Run all profiles and get a weighted composite score
npm run watchtower -- composite ./lib-a ./lib-b --executor mock
```

Additional focused profiles are available as JSON files in `profiles/` (planning, code-hygiene, architecture, complex-coding, end-to-end).

### Two-Phase Blind Harness

When an executor supports it, Watchtower uses a two-phase evaluation: the performer generates output without seeing the rubric, then a separate judge call scores both outputs pairwise with presentation order randomized. This prevents the performer from gaming the rubric and eliminates position bias.

### Custom Profiles

Profiles are JSON files loaded with `--profile-file`. Authoring patterns include standalone profiles, extending the default with `"extends_default": true`, subsetting categories with `--categories`, and adjusting trial counts.

See [examples/game-design-profile.json](./examples/game-design-profile.json) for a complete standalone example and [docs/profile-authoring.md](./docs/profile-authoring.md) for the full authoring guide.

<details>
<summary>Profile field reference</summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `profile_id` | yes | — | Unique identifier |
| `label` | yes | — | Human-readable name |
| `description` | yes | — | What this profile measures |
| `category_weights` | yes | — | Map of category → numeric weight |
| `tasks` | yes | — | Array of task definitions |
| `extends_default` | no | `false` | Inherit default tasks before customizing |
| `exclude_tasks` | no | `[]` | Task IDs to remove from inherited set |
| `exclude_categories` | no | `[]` | Categories to remove entirely |
| `default_trials_per_side` | no | `5` | Trials per task per side (1–20) |
| `collapse_config` | no | `{primitive_floor: 0.6, composed_ceiling: 0.3}` | Compositional collapse detection thresholds |

</details>

<details>
<summary>Task field reference</summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `task_id` | yes | — | Unique within profile |
| `category` | yes | — | Must match a key in `category_weights` |
| `prompt_text` | yes | — | Evaluation instruction sent to executor |
| `rubric_text` | no | generic | 0–4 scale rubric |
| `critical_regression` | no | `false` | Blocks `replace` even if overall score improves |
| `trials_per_side` | no | profile default | Per-task trial count override (1–20) |
| `mock_cues` | no | extracted from prompt | Keywords for mock scoring (4–8 recommended) |

</details>

## Scenarios

Each scenario sets comparison mode and interpretation context. The executor and profile are the same — the difference is how the verdict reasons about the result.

| Scenario | Mode | Use when |
|----------|------|----------|
| `head_to_head` | cross-library | Picking a winner between two different libraries |
| `version_upgrade` | same-library | Comparing old vs. new after a major rewrite |
| `marginal_update` | same-library | Before/after a small targeted edit |
| `add_new_skill` | same-library | Testing whether adding a skill improved quality |
| `regression_check` | same-library | Verifying nothing broke after automated changes |
| `projection_compare` | cross-library | One side is a future-state projection |

### Trial count guidance

Trial count controls statistical confidence. Higher values produce tighter confidence intervals but take proportionally longer.

| Trials | Confidence | Use for |
|--------|------------|---------|
| 2–3 | Low | Smoke tests, iteration loops |
| 5 (default) | Moderate | Standard comparisons |
| 7–10 | High | Release decisions, irreversible replacements |

## Tournament

Single-elimination knockout bracket for 2–16 skill libraries. Seeding uses existing Elo ratings; unranked competitors are shuffled deterministically. Draws are resolved by seed advantage (lower seed advances), and Elo updates are skipped for seed-decided matches to prevent rating distortion.

```bash
npm run watchtower -- tournament ./lib-a ./lib-b ./lib-c ./lib-d --executor mock --seed 42
```

Results persist to `watchtower-data/tournaments/`.

## Executors

Three executor modes:

| Executor | Flag | Use for |
|----------|------|---------|
| Mock | `--executor mock` | Local development, iteration, CI |
| Codex | `--executor codex` | Real LLM-backed evaluation via Codex |
| Claude | `--executor claude` | Real LLM-backed evaluation via Claude |

Real executors require environment variables: `WATCHTOWER_CODEX_LAUNCH` or `WATCHTOWER_CLAUDE_LAUNCH`. Optional: `WATCHTOWER_LAUNCH_SHELL` to override the default shell (`/bin/sh` on Unix).

### How Mock Scoring Works

The mock executor scores by keyword presence — no LLM calls. For each task, it collects text from the skill library bundle (up to 80 files, 5000 chars each), resolves cue keywords from the mock cue registry or task prompt, computes `matched_cues / total_cues` as the base score, and applies a small deterministic jitter (±0.04) seeded from the bundle digest. Custom profiles can control mock scoring by providing `mock_cues` per task.

Mock results are directional checks, not final evidence for irreversible decisions.

## Evaluation Extensions

Three research-backed evaluation extensions ship with Watchtower. All are optional — standard comparisons work identically without them.

### IRT Task Calibration

**Why it matters.** Not all benchmark tasks are equally informative. Some tasks differentiate good libraries from bad; others produce noise. Item Response Theory identifies which is which and weights the verdict accordingly.

**How to use it.** Accumulate trial data, fit the model, then apply calibrated weights:

```bash
# Step 1: Accumulate trials (mock: ~60s for 20 runs)
npm run watchtower -- batch ./lib-a ./lib-b --runs 20 --executor mock

# Step 2: Fit IRT model
npm run watchtower -- calibrate --batch <batch-id>

# Step 3: Compare with calibrated weights
npm run watchtower -- compare ./lib-a ./lib-b --irt calibrations/<file>.json
```

**What the numbers mean.** Discrimination (`a`) measures how sharply a task separates good from bad bundles — high (>1.5) is a good discriminator, low (<0.5) is noise. Fisher Information measures total information contributed; it becomes the IRT weight. Tasks with `irt_weight < 0.1` are flagged as low-information in the calibration report.

**The math.** Watchtower fits a Graded Response Model (Samejima 1969) with 2PL fallback. The EM algorithm uses Gauss-Hermite quadrature for the E-step and Newton-Raphson with Armijo line search and Hessian regularization for the M-step. Fisher Information at the posterior mean ability estimate produces per-task weights. Category contributions in the enhanced scorecard are adjusted multiplicatively: `adjusted_weight = base_weight × mean_irt_weight`.

Minimum data requirements: ≥30 valid observations across ≥5 distinct tasks. If your profile changes after calibration, Watchtower warns about profile hash mismatch — re-run `batch` then `calibrate`.

See [docs/workflows.md](./docs/workflows.md) for a worked example with weight calculations.

### Construction-Verification (C-V)

**Why it matters.** Keyword-based scoring has a 25–35% false-positive rate for keyword-heavy bundles. A library can have all the right words in all the wrong places. C-V splits evaluation into construction (does the bundle have the right structure?) and verification (do formal property checks pass?), with an optional firewall between phases.

**How to use it.** Add `cv` extensions to profile tasks:

```json
{
  "task_id": "arch_layering_001",
  "extensions": {
    "cv": {
      "construction_cues": ["layers", "dependencies"],
      "verification_checks": [
        {
          "check_id": "no_circular_deps",
          "rule": "requires:layer AND absent:circular AND before:interface,implementation",
          "weight": 40,
          "critical": true
        }
      ],
      "construction_weight": 0.3,
      "verification_weight": 0.7,
      "firewall": true
    }
  }
}
```

**The DSL.** Verification rules use a recursive-descent DSL with 6 atoms (`requires`, `absent`, `before`, `after`, `count`, `section`) and 3 combinators (`AND`, `OR`, `NOT`). Example: `requires:layer AND absent:circular AND before:interface,implementation` checks that the bundle mentions "layer", does not mention "circular", and mentions "interface" before "implementation".

**Shortcut detection.** When construction score > 0.7 but verification score < 0.3, C-V flags a shortcut: the bundle looks right but isn't structurally sound. This is the key C-V insight.

### Compositional Abstraction

**Why it matters.** A skill library might teach planning and architecture individually but fail when an agent needs to combine them. Compositional Abstraction tests whether primitives compose into working combinations.

**How it works.** Tasks are structured in three layers: primitives (individual skills), compositions (pairwise combinations), and meta (generalization tests). Collapse detection flags libraries where primitives score well but compositions fail.

**Collapse severity.** When the mean primitive score exceeds the primitive floor (default 0.6) and the mean composed score falls below the composed ceiling (default 0.3), collapse is detected. Severity is computed as:

```
severity = (meanPrimitive − meanComposed) / (meanPrimitive + 0.01)
```

The severity guard (`meanPrimitive ≥ 0.1`) prevents meaningless values when primitives are weak. Collapse detection requires ≥2 scored tasks per layer; with fewer, the result includes `insufficient_data: true`.

**Configuration.** Default thresholds (floor=0.6, ceiling=0.3) are configurable per-profile via `collapse_config`. Task dependencies must form a DAG, validated at profile load using Kahn's algorithm with deterministic topological sort.

**Known limitation.** Mock executor scores composition tasks via keyword presence (case-insensitive substring matching). This is a directional signal, not semantic evaluation. Use a real executor for high-stakes composition judgments.

## Elo Tracking

Standard Elo (K=32, starting 1500) with a flat-file JSON ledger. Both pairwise comparisons and tournament matches update ratings. Draws in pairwise mode update Elo toward the expected draw; seed-decided tournament draws skip Elo updates.

```bash
npm run watchtower -- leaderboard
npm run watchtower -- history --limit 10
```

## Replacement

For a decisive same-library comparison, Watchtower can replace the losing side with the winner:

```bash
npm run watchtower -- replace <run-id> --winner-to left --confirm
```

Replacement archives the losing root first (preserving `.git`), then copies the winner snapshot. Blocked for remote sources and when critical regressions are present.

## Output and Local State

All artifacts are stored under `watchtower-data/`:

| Directory | Contents |
|-----------|----------|
| `runs/` | Structured comparison JSON |
| `reports/` | Readable markdown reports |
| `snapshots/` | Immutable per-run copies |
| `archives/` | Archive-before-replace safety copies |
| `tournaments/` | Tournament brackets and results |
| `batches/` | Batch trial data for IRT calibration |
| `calibrations/` | IRT calibration reports |
| `elo.json` | Leaderboard and history state |

## Scripts

Portable wrapper scripts for CI or shell integration: [`scripts/watchtower.ps1`](./scripts/watchtower.ps1) and [`scripts/watchtower.sh`](./scripts/watchtower.sh).

## Architecture

The monorepo has two packages: `apps/runner` (CLI entrypoint) and `packages/core` (source resolution, snapshots, execution, scoring, statistics, Elo, tournaments, and replacement).

See [docs/architecture.md](./docs/architecture.md) for the system diagram and module dependency graph, [docs/verdict-logic.md](./docs/verdict-logic.md) for verdict production, and [docs/workflows.md](./docs/workflows.md) for step-by-step operational guides.

## Troubleshooting

**"Workspace path is outside the allowlisted parent root"** — pass `--allowlist-root` pointing to a parent directory that contains both skill libraries, or set `WATCHTOWER_ALLOWLIST_ROOT`.

**"Real executor 'codex' is not ready"** — configure `WATCHTOWER_CODEX_LAUNCH`, or use `--executor mock` for development.

**No SKILL.md found** — Watchtower expects each skill-library root to contain at least one markdown file.

**elo.json parse warning** — delete `watchtower-data/elo.json` and rebuild from fresh runs.

**GitHub clone failures** — ensure `git` is on PATH with read access to the repository.

**"Need ≥30 valid observations across ≥5 tasks"** — accumulate more trial data: `npm run watchtower -- batch <left> <right> --runs 20 --executor mock`.

**"Profile hash differs from calibration hash"** — profile changed since calibration. Re-run `batch` then `calibrate`.

**"IRT calibration did not converge"** — accumulate more data (`--runs 30`) or check for insufficient score variation.

**Batch runs with real executors** — batches over 10 runs with `codex` or `claude` executors require the `--confirm` flag and display a cost estimate before proceeding.

## Limitations

- Benchmarks markdown skill libraries only — not arbitrary codebases.
- Replacement is local-only and whole-root only.
- Elo is a convenience signal, not a scientific leaderboard.
- The bundled profile is a generic benchmark, not universal truth.
- Cue-matching (mock and C-V construction phase) has a 25–35% false-positive rate for keyword-heavy bundles. Semantic evaluation is planned.

## License

MIT. See `LICENSE`.
