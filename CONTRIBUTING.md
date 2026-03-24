# Contributing

## Local Setup

Prerequisites:

- Node.js and npm
- `git` on `PATH`
- Optional: Codex plus WSL for real executor runs

Install and build:

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

## CLI Smoke Checks

Use these before opening a PR:

```bash
node apps/runner/dist/index.js profiles
node apps/runner/dist/index.js compare "./test-fixtures/bad-skill" "./test-fixtures/good-skill" --scenario head_to_head --executor mock
node apps/runner/dist/index.js leaderboard
node apps/runner/dist/index.js history --limit 5
```

## Documentation Rules

- Keep public docs generic and GitHub-renderable
- Do not include machine-specific absolute paths in committed markdown
- Update `README.md`, `SKILL.md`, and `docs/architecture.md` when the public CLI surface or architecture changes
- Update `docs/source-inputs.md` when source-resolution behavior changes

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
