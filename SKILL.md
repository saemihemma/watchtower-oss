# Watchtower Skill

> This file makes the Watchtower repo itself benchmarkable as a skill library. It is not part of the benchmark tool.

Use Watchtower when the user wants to compare two markdown skill libraries and answer:

**Which side is better, why, and what should we do next?**

## When To Use It

Trigger on requests like:

- compare these skill libraries
- benchmark my skills
- did this rewrite get better
- did my cleanup make the library worse
- compare this local folder against a GitHub repo
- should I replace the old library with the new one
- how does my library score against bare LLM (baseline-empty)

## Profiles

| Profile | What it tests |
|---------|---------------|
| `default` | Process discipline: routing, scope, evidence, handoff |
| `grounded` | Objective accuracy with known correct answers |
| `friction` | Simplicity — skills don't over-complicate simple work |
| `library-quality` | Documentation quality |

Use `default` unless the user specifies otherwise. Use `composite` to score across all profiles at once.

## Commands

```bash
npm install && npm run build
```

```bash
# Compare two libraries (default profile, mock executor)
npm run watchtower -- compare "./lib-a" "./lib-b" --scenario head_to_head --executor mock

# Compare against bare LLM baseline
npm run watchtower -- compare "./my-library" "./baseline-empty" --executor mock

# Composite score across all profiles
npm run watchtower -- composite "./lib-a" "./lib-b" --executor mock

# Real evaluation (uses Claude subscription)
npm run watchtower -- compare "./lib-a" "./lib-b" --executor claude --scenario head_to_head

# Show a stored run
npm run watchtower -- show <run-id>

# Leaderboard and history
npm run watchtower -- leaderboard
npm run watchtower -- history --limit 10

# Replace losing side with winner
npm run watchtower -- replace <run-id> --winner-to <left|right> --confirm
```

## Scenario Selection

Use the user's intent to choose a scenario:

- `head_to_head`: two different libraries
- `version_upgrade`: old vs new version of the same library
- `marginal_update`: smaller edits inside the same library
- `add_new_skill`: adding one or more skills to an existing library
- `regression_check`: cleanup or simplification validation
- `projection_compare`: different projections of similar content

## Result Presentation

When reporting a run, cover:

1. Winner or `too_close_to_call`
2. Left score, right score, and delta
3. Confidence
4. Category breakdown
5. Top reasons
6. Regressions
7. Devil's Advocate verdict
8. Recommended action

If the run includes the v2 stats payload, summarize the ROPE verdict, confidence interval, and probability of right-side superiority.

## Boundaries

- Mock runs are useful for development, not final irreversible decisions
- Real runs require `WATCHTOWER_CODEX_LAUNCH` or `WATCHTOWER_CLAUDE_LAUNCH`
- Only offer replacement for same-library runs with decisive results
- GitHub-backed sources can be benchmarked but not overwritten
