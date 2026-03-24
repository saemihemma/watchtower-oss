# Watchtower

Watchtower is a local benchmark for markdown skill libraries. Point it at two skill-library roots, run the same benchmark pack against both sides, and get a decision-shaped result: winner, score delta, confidence, regressions, Devil's Advocate review, and a recommended next action.

## What It Is

- A terminal-first A/B comparator for markdown skill libraries
- A tool for comparing local folders, GitHub repos, or one of each
- A benchmark runner that supports scenarios, bundled profiles, Elo tracking, and archive-first replacement for decisive same-library wins
- A local-only tool that stores reports and run artifacts on disk

## What It Is Not

- Not a web app
- Not a generic repo evaluator
- Not per-skill merge automation
- Not a substitute for judgment when two libraries serve different consumers or have incompatible architecture

## Install

Prerequisites:

- Node.js and npm
- `git` on `PATH` for GitHub source support
- Optional: Codex plus WSL for real executor runs

Setup:

```bash
npm install
npm run build
```

## Quickstart

List profiles and scenarios:

```bash
node apps/runner/dist/index.js profiles
```

Run a local comparison in mock mode:

```bash
node apps/runner/dist/index.js compare "./test-fixtures/bad-skill" "./test-fixtures/good-skill" --scenario head_to_head --executor mock
```

Compare a local library against a GitHub repo:

```bash
node apps/runner/dist/index.js compare "./test-fixtures/good-skill" "https://github.com/saemihemma/watchtower" --scenario head_to_head --executor mock
```

Re-open a stored run:

```bash
node apps/runner/dist/index.js show <run-id>
```

Show the Elo leaderboard and recent history:

```bash
node apps/runner/dist/index.js leaderboard
node apps/runner/dist/index.js history --limit 10
```

Replace the losing side with the winner for a decisive same-library run:

```bash
node apps/runner/dist/index.js replace <run-id> --winner-to left --confirm
```

## Supported Sources

Watchtower accepts:

- Local paths such as `./skills` or `/path/to/skills`
- GitHub shorthand such as `github://owner/repo`, `github://owner/repo@branch`, or `github://owner/repo#commit`
- GitHub URLs such as `https://github.com/owner/repo` or `https://github.com/owner/repo/tree/branch`

GitHub sources are cloned to a temporary directory, benchmarked, and cleaned up after the run. Remote comparisons are allowed; remote replacement is not.

See [docs/source-inputs.md](./docs/source-inputs.md) for the full source-resolution behavior.

## Scenarios and Profiles

Built-in scenarios:

- `head_to_head` for two distinct libraries
- `version_upgrade` for old vs new versions of the same library
- `marginal_update` for smaller edits within one library
- `add_new_skill` for expanding an existing library
- `regression_check` for cleanup and simplification passes
- `projection_compare` for comparing different projections of similar content

Built-in profiles:

- `default`
- `lead-producer`
- `team-product-team`
- `team-dev-team`
- `workflow-issue-triage`

Use `profiles` to see the current profile and scenario descriptions from the CLI.

## Executors

Watchtower supports two executor modes:

- `--executor mock` for fast local development and testing
- `--executor codex` for real Codex-backed evaluations

Real executor runs require:

- WSL available
- `WATCHTOWER_CODEX_LAUNCH` configured

If those requirements are not met, use mock mode for development only. Mock results are useful directional checks, not final evidence for irreversible decisions.

## Output and Local State

Watchtower stores local artifacts under `watchtower-data/`:

- `runs/<run-id>.json` for structured run output
- `reports/<run-id>.md` for readable reports
- `snapshots/` for immutable per-run copies
- `archives/` for archive-before-replace safety copies
- `elo.json` for leaderboard and history state

Each run includes:

- winner or `too_close_to_call`
- left score, right score, and delta
- category breakdown
- confidence
- top reasons
- regressions
- Devil's Advocate verdict
- recommended action
- statistical reporting in the scorecard when available

## Architecture

The main subsystems are:

- `apps/runner` for the CLI entrypoint
- `packages/core` for source resolution, snapshots, execution, scoring, stats, and replacement

See [docs/architecture.md](./docs/architecture.md) for the system diagram and behavior breakdown.

## Limitations

- Watchtower benchmarks markdown skill libraries only. It does not score arbitrary codebases.
- Replacement is local-only and whole-root only.
- Elo is a convenience signal, not a scientific leaderboard. Repeated comparisons can bias ratings.
- Built-in profiles are opinionated benchmark packs, not universal truth.

## License

MIT. See `LICENSE`.
