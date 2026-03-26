# Watchtower Verdict Logic

This document explains how Watchtower produces a winner, confidence level, regressions, recommended action, and Devil's Advocate review from raw trial scores.

## Pipeline

The verdict pipeline runs in four stages after the executor finishes all trials:

1. **Summarize** — Per-task, per-side: collect valid trial scores, compute median. If a task has fewer valid trials than `min_valid_trials`, its score is null (missing data, not zero).

2. **Score** — Per-category: compute weighted mean of task medians. Per-side: compute overall score as weighted mean of category scores (0–100 scale). Weights are defined in the profile's `category_weights`.

3. **Decide** — Compare overall scores. Apply confidence, delta threshold, and critical regression checks to produce a winner.

4. **Advise** — Generate top reasons, regressions, Devil's Advocate review, and recommended action.

## Winner Determination

The winner is determined by three checks in order:

1. **Confidence gate** — If confidence is `low`, the result is `too_close_to_call` regardless of score delta. Low confidence means too many failed trials, missing task scores, or unstable trial variance.

2. **Critical regression gate** — If the leading side regressed on any task marked `critical_regression: true` by more than 15 points (0.15 on the 0–1 scale), the winner is blocked. The result becomes `too_close_to_call` even if the overall delta is large.

3. **Delta threshold** — If the absolute score delta exceeds 5 points (on the 0–100 scale), the higher-scoring side wins. Below 5 points, the result is `too_close_to_call`.

## Confidence Levels

Confidence is assigned based on trial health:

| Level | Criteria |
|---|---|
| `high` | All tasks have valid scores on both sides, failed trial rate ≤ 10%, no category is unstable |
| `medium` | All categories have scores on both sides, failed trial rate ≤ 20% |
| `low` | Neither high nor medium criteria met |

A category is **unstable** when any task in it has a trial score range (max − min) exceeding 0.5 on the 0–1 scale. Unstable categories block high confidence because the signal is noisy.

## Critical Regression

A critical regression occurs when the winning side scores 15+ points lower than the losing side on a task marked `critical_regression: true`. This blocks replacement even if the overall score is better, because the regression represents a non-negotiable quality floor.

Critical regression tasks are rare by design — only tasks that represent absolute quality minimums should be marked. Example: "does the library avoid bloat?" is a reasonable critical regression; "does the library have good naming?" is not.

## Top Reasons

Reasons are generated from category-level deltas, sorted by magnitude. Up to 4 category reasons are included (e.g., "Right led code hygiene by 12.50 points"). If confidence is not high, a caution reason is appended.

## Devil's Advocate

The Devil's Advocate challenges the result with counter-arguments. It produces a verdict:

| Verdict | Meaning |
|---|---|
| `clear` | No blocking concerns. The result is trustworthy for action. |
| `caution` | The result cleared thresholds but the margin is modest (< 10 points) or confidence is medium. Proceed with awareness. |
| `block_replace` | The result should not drive replacement. Triggered by: `too_close_to_call`, low confidence, critical regressions, or cross-library comparison mode. |

Cross-library comparisons always produce `block_replace` because benchmark winner does not mean drop-in replacement-safe — the libraries may serve different consumers or have incompatible architectures.

## Recommended Action

The recommended action is derived from winner, comparison mode, and replace eligibility:

| Condition | Action |
|---|---|
| `too_close_to_call` | `rerun_with_narrower_change` |
| Cross-library comparison | `port_ideas_deliberately` |
| Same-library, replace-eligible | `replace_left_with_right` or `replace_right_with_left` |
| Same-library, not replace-eligible | `keep_separate` |

Replace eligibility requires: same-library mode, a decisive winner, non-low confidence, and zero regressions.

## Statistical Layer (v2)

When available, the scorecard includes a `v2` statistical supplement computed by `stats-verdict.ts`:

1. **Bayesian posterior** — Conjugate normal-normal update with weak prior (mean=0.5, sigma=0.15). Produces posterior mean, sigma, and 95% credible interval for each side's expected score.

2. **Bootstrap CI** — 10,000 resamples of the left-right score delta. Produces 95% confidence interval on the true delta, mean delta, and probability of right superiority.

3. **ROPE verdict** — Region of Practical Equivalence. If the bootstrap CI falls entirely within ±5 points of zero, the result is `equivalent`. If entirely outside, it's `left_wins` or `right_wins`. Otherwise, `undecided`.

4. **CV stability** — Coefficient of variation for each side's scores. CV < 0.1 is `stable`, 0.1–0.2 is `moderate`, > 0.2 is `unstable`.

The v2 layer does not override the v1 verdict. It provides additional statistical context for users who want confidence intervals and Bayesian reasoning alongside the threshold-based decision.
