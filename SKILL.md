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

## What It Does

- Compares exactly two sources
- Runs the generic default benchmark profile against both sides
- Returns winner, scores, confidence, reasons, regressions, Devil's Advocate review, and recommended action
- Supports local paths and GitHub sources
- Can replace the losing side with the winner only for decisive same-library runs with a local replacement target

## What It Does Not Do

- It is not a web workflow
- It does not merge individual skills
- It does not benchmark arbitrary code repositories
- It does not treat cross-library wins as drop-in replacement-safe

## Source Formats

Either side may be:

- a local path
- `github://owner/repo`
- `github://owner/repo@branch`
- `github://owner/repo#commit`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/branch`

Every source must contain at least one `SKILL.md` somewhere in the tree.

## Scenario Selection

Use the user's intent to choose a scenario:

- `head_to_head`: two different libraries
- `version_upgrade`: old vs new version of the same library
- `marginal_update`: smaller edits inside the same library
- `add_new_skill`: adding one or more skills to an existing library
- `regression_check`: cleanup or simplification validation
- `projection_compare`: different projections of similar content

If the scenario implies the comparison is the same library, use that instead of manually adding `--same-library`.

## Profile Selection

Use `default`.

## Commands

Install first:

```bash
npm install
```

List profiles and diagnostics:

```bash
npm run watchtower -- profiles
```

Compare two sources:

```bash
npm run watchtower -- compare "<left>" "<right>" --scenario <scenario> --profile default --executor mock
```

Use `--executor codex` or `--executor claude` for real evaluations once the matching launch command is configured.

Show a stored run:

```bash
npm run watchtower -- show <run-id>
```

Show leaderboard or history:

```bash
npm run watchtower -- leaderboard
npm run watchtower -- history --limit 10
```

Replace the losing side with the winner:

```bash
npm run watchtower -- replace <run-id> --winner-to <left|right> --confirm
```

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

## Replacement Rules

- Only offer replacement for same-library runs
- Do not recommend replacement when confidence is low
- Do not recommend replacement when regressions remain
- GitHub-backed sources can be benchmarked but not overwritten
- Cross-library comparisons should end in `keep separate` or `port ideas deliberately`

## Boundaries

- Mock runs are useful for development, not final irreversible decisions
- Real runs require `WATCHTOWER_CODEX_LAUNCH` or `WATCHTOWER_CLAUDE_LAUNCH`
- Replacement is archive-first and whole-root only
