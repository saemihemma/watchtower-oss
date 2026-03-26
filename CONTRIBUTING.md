# Contributing

## Local Setup

Prerequisites:

- Node.js 18+ and npm
- `git` on `PATH`

Install and build:

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

All commands work out of the box with the mock executor — no external services or API keys required.

### Optional: Real Executor Setup

For real LLM-backed evaluations (not required for development or testing):

- Configure `WATCHTOWER_CODEX_LAUNCH` for Codex-backed runs
- Configure `WATCHTOWER_CLAUDE_LAUNCH` for Claude-backed runs
- See README.md "Executors" section for details

## CLI Smoke Checks

Use these before opening a PR:

```bash
npm run watchtower -- profiles
npm run watchtower -- compare "./test-fixtures/bad-skill" "./test-fixtures/good-skill" --scenario head_to_head --executor mock
npm run watchtower -- leaderboard
npm run watchtower -- history --limit 5
```

## Documentation Rules

- Keep public docs generic and GitHub-renderable
- Do not include machine-specific absolute paths in committed markdown
- Update `README.md` and `docs/architecture.md` when the public CLI surface or architecture changes
- Update `docs/source-inputs.md` when source-resolution behavior changes
- Update `docs/workflows.md` when CLI flags or workflow steps change

## Repository Hygiene

Do not commit:

- `node_modules/`
- `dist/`
- `watchtower-data/`
- `.tsbuildinfo`
- local reports or scratch artifacts

## Scope Discipline

Watchtower is a local benchmark for markdown skill libraries. Avoid quietly expanding docs or code toward:

- web dashboards
- generic repo scoring
- selective per-skill merge automation
