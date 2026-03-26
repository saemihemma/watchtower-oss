# Watchtower v1.0 QA/Red-Team Plan

**Status:** Accepted (specialist hardening avg 9.0, Round 2)
**Reviewer mix:** QA Engineer (primary), Software Architect (adversarial), Open Source Engineer (complementary)

## Execution Phases

| Phase | Scope | Items | Dependency |
|-------|-------|-------|------------|
| A | Unit/boundary tests | 4, 7 | None — pure unit tests |
| B | Integration traces | 1, 2, 8 | Requires running pipeline |
| C | Adversarial/CLI | 3, 5, 6 | CLI-level testing |
| D | Publish readiness | 9, 10, 11 | Final verification |

## 1. Integration Trace (Full Pipeline)

### 1.1 End-to-end compare with extensions

Run compare with a profile that exercises CV extensions, composition extensions, and IRT calibration simultaneously. Mock executor.

**Verify:**
- JSON structure valid
- Markdown report renders all sections including Composition Analysis
- IRT weights change scores vs unweighted run
- Extension metadata present on CV/composition tasks
- No extension metadata on tasks without extensions

### 1.2 Batch → calibrate → compare --irt pipeline

Accumulate 20 runs × 14 tasks × 2 sides = 560 observations.

**Verify:**
- BatchOutput matches v1 schema (version field, batchId, profileId, runs array)
- Calibration report produced with version:1
- Compare with --irt applies weights
- Scores differ from unweighted comparison

## 2. Adversarial Profiles

| # | Input | Expected |
|---|-------|----------|
| 2.1 | Cyclic DAG (A→B→C→A) | Reject at profile load with cycle error |
| 2.2 | collapse_config floor=0.0 ceiling=1.0 | No crash, collapse trivially detected |
| 2.3 | Empty extension object `"cv": {}` | Graceful pass-through, base score |
| 2.4 | 500-task profile | Completes without timeout or OOM |
| 2.5 | Duplicate task IDs | Reject at profile load |
| 2.6 | Task references missing category | Reject at profile load |
| 2.7 | All category weights = 0 | Handle or reject with message |
| 2.8 | All-same scores (no variance) | IRT: convergence warning, not crash |

## 3. Empty/Degenerate Inputs

| # | Input | Expected |
|---|-------|----------|
| 3.1 | Empty directory (no markdown) | Clear error message |
| 3.2 | Both sides identical | Valid result, scores close, no crash |
| 3.3 | Single-file library (SKILL.md only) | Valid result |
| 3.4 | --categories nonexistent_cat | Error with category name |
| 3.5 | --runs 0 | Reject with range error |

## 4. Collapse Boundary Tests (Oracle Values from §2.7)

All severity values must match within tolerance ±0.0001.

| # | meanPrim | meanComp | floor | ceiling | detected | severity |
|---|----------|----------|-------|---------|----------|----------|
| 4.1 | 0.75 | 0.25 | 0.6 | 0.3 | true | 0.6579 |
| 4.2 | 0.80 | 0.10 | 0.6 | 0.3 | true | 0.8642 |
| 4.3 | 0.59999 | 0.25 | 0.6 | 0.3 | false | 0 |
| 4.4 | 0.60001 | 0.25 | 0.6 | 0.3 | true | 0.5738 |
| 4.5 | 0.75 | 0.30001 | 0.6 | 0.3 | false | 0 |
| 4.6 | 0.75 | 0.29999 | 0.6 | 0.3 | true | 0.5922 |
| 4.7 | 0.09 | 0.01 | 0.6 | 0.3 | false | 0 |
| 4.8 | 0.50 | 0.25 | 0.6 | 0.3 | false | 0 |

## 5. Batch Runner Edge Cases

| # | Input | Expected |
|---|-------|----------|
| 5.1 | 3 of 10 runs fail | summary.failed=3, remaining complete |
| 5.2 | All 10 runs fail | No crash, summary.completed=0 |
| 5.3 | SIGINT after 5 of 20 | Completed runs persisted |
| 5.4 | --parallel 0 | Clamp to 1 with warning |
| 5.5 | --parallel 16 | Clamp to 8 with warning |
| 5.6 | --runs 501 | Reject with range error |
| 5.7 | --runs -1 | Reject |
| 5.8 | Concurrent batch writes to same dir | Both complete, no corruption |

## 6. CLI Error Message Audit

**Universal criterion:** No stack traces visible to user. All errors produce actionable messages.

| # | Input | Expected message type |
|---|-------|---------------------|
| 6.1 | compare: missing args | Usage hint |
| 6.2 | compare --irt nonexistent.json | File not found |
| 6.3 | compare --irt malformed.json | Parse error |
| 6.4 | compare --irt version:2 file | Version mismatch (expected 1, got 2) |
| 6.5 | calibrate --batch nonexistent | Batch not found with path |
| 6.6 | calibrate insufficient data | Specific counts ("found N obs across M tasks") |
| 6.7 | batch: missing args | Usage hint |
| 6.8 | replace: missing --confirm | Explicit confirm requirement |
| 6.9 | tournament: 0 or 1 library | Minimum count error |
| 6.10 | tournament: 17+ libraries | Maximum count error |
| 6.11 | watchtower --help | Useful output, no stack trace |
| 6.12 | watchtower compare --help | Flag documentation |
| 6.13 | (all paths) | No stack traces in any error path |

## 7. Extension Scorer Resilience

| # | Scenario | Expected |
|---|----------|----------|
| 7.1 | CV scorer throws | Base score returned, error in extension_metadata |
| 7.2 | Composition scorer throws | Base score returned, error in extension_metadata |
| 7.3 | Task has no extensions | No extension_metadata, base score unchanged |
| 7.4 | Scorer returns score > 1.0 or < 0.0 | Clamped or rejected |
| 7.5 | All tasks Fisher Information = 0 | Fallback to uniform weights with warning, no division by zero |

## 8. Schema Backward Compatibility

| # | Scenario | Expected |
|---|----------|----------|
| 8.1 | Load v4 run JSON in v5 engine | Loads, optional fields undefined not corrupted |
| 8.2 | BatchOutput v1 version check | Version field validated on load |

## 9. Publish Readiness

| # | Check | Method |
|---|-------|--------|
| 9.1 | npm publish --dry-run @watchtower-bench/core | Automated — verify file list, no test fixtures |
| 9.2 | npm publish --dry-run @watchtower-bench/runner | Automated — verify shebang, correct bin entry |
| 9.3 | No secrets in source | grep for API_KEY, SECRET, TOKEN, password, @ccpgames |
| 9.4 | All doc links resolve | Manual — README, CONTRIBUTING, architecture, workflows, source-inputs |
| 9.5 | LICENSE copyright correct | Manual — "Sæmundur" |
| 9.6 | Fresh clone test | git clone → npm install → npm test → all pass |
| 9.7 | README Quick Start verification | Run all 4 Quick Start examples, verify test-fixtures/ committed |
| 9.8 | --help includes --seed docs | watchtower compare --help |

## 10. Reproducibility

| # | Check | Method |
|---|-------|--------|
| 10.1 | Same seed → same mock scores | compare ×2 with --seed 42, diff JSON |
| 10.2 | Same batch seed → same output | batch ×2 with same seed, compare |
| 10.3 | Elo determinism | Same match sequence → same ratings |
| 10.4 | Profile hash stability | Same content, different key order → same hash |

## 11. Stress Tests

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 11.1 | IRT calibration with 500 tasks | Completes without timeout |
| 11.2 | Tournament with 16 libraries (max) | Full bracket, correct placement |
| 11.3 | Batch --runs 500 --parallel 8 --executor mock | Completes, output valid |

## Coverage Summary

| Area | Items | Automated | Manual |
|------|-------|-----------|--------|
| Integration traces | 2 | 2 | 0 |
| Adversarial profiles | 8 | 8 | 0 |
| Degenerate inputs | 5 | 5 | 0 |
| Boundary tests | 8 | 8 | 0 |
| Batch edge cases | 8 | 7 | 1 (SIGINT) |
| CLI error audit | 13 | 10 | 3 |
| Scorer resilience | 5 | 5 | 0 |
| Schema compat | 2 | 2 | 0 |
| Publish readiness | 8 | 4 | 4 |
| Reproducibility | 4 | 4 | 0 |
| Stress tests | 3 | 3 | 0 |
| **Total** | **66** | **58** | **8** |

## Estimated Effort

10–12 hours. Phases A and B can run in parallel. Phase D is the final gate.
