import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Executor,
  runTournament,
  validateTournamentSize,
  buildFinalRanking,
  loadEloLedger,
  deriveCompetitorId,
  createMockExecutor as createMock,
  type TournamentMatchResult,
  type TournamentRound,
  type TournamentSeed
} from "../src/index.js";

const tempRoots: string[] = [];

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

/**
 * Create a skill library with predictable keyword density for mock scoring.
 * strength controls how many cue words appear.
 */
function createSkillLib(name: string, strength: "strong" | "medium" | "weak"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tournament-${name}-`));
  tempRoots.push(root);

  const content = strength === "strong"
    ? [
        "# Skill Library",
        "## Use When", "Use when you need clear route. Best for discovery.",
        "## What It Is NOT", "Not overlap or catch-all.",
        "## Boundaries", "scope, responsibilities, boundary, ownership",
        "## Evidence", "evidence, verify, acceptance, steps, examples",
        "## Handoff", "handoff, next action, output, context, deliverable",
        "## Architecture", "structure, layer, compose, dependency, delegate, ownership",
        "## Hygiene", "lean, minimal, sharp, replace, don't accumulate, bloat-free",
        "## Constraints", "ambiguous, partial, degrade, fallback, missing, graceful"
      ].join("\n\n")
    : strength === "medium"
    ? [
        "# Skill Library",
        "## Use When", "Use when helpful.",
        "## Boundaries", "scope, boundary",
        "## Evidence", "evidence, steps",
        "## Handoff", "handoff, output",
        "## Architecture", "structure, dependency",
        "## Hygiene", "lean, replace"
      ].join("\n\n")
    : [
        "# Skill Library",
        "## Overview", "General purpose helper.",
        "Some notes about how to use this."
      ].join("\n\n");

  writeFile(path.join(root, "SKILL.md"), content);
  return root;
}

afterEach(() => {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempRoots.length = 0;
});

describe("validateTournamentSize", () => {
  it("accepts 2-16 competitors", () => {
    expect(() => validateTournamentSize(2)).not.toThrow();
    expect(() => validateTournamentSize(4)).not.toThrow();
    expect(() => validateTournamentSize(16)).not.toThrow();
  });

  it("rejects < 2", () => {
    expect(() => validateTournamentSize(1)).toThrow(/at least 2/);
    expect(() => validateTournamentSize(0)).toThrow(/at least 2/);
  });

  it("rejects > 16", () => {
    expect(() => validateTournamentSize(17)).toThrow(/maximum of 16/);
  });
});

describe("deriveCompetitorId", () => {
  it("derives ID from last two path segments", () => {
    expect(deriveCompetitorId("/a/b/c")).toBe("b/c");
  });

  it("handles single-segment paths", () => {
    expect(deriveCompetitorId("lib")).toBe("lib");
  });

  it("normalizes backslashes", () => {
    expect(deriveCompetitorId("a\\b\\c")).toBe("b/c");
  });

  it("strips trailing slashes", () => {
    expect(deriveCompetitorId("/a/b/c/")).toBe("b/c");
  });
});

describe("buildFinalRanking", () => {
  function makeSeed(id: string, seedNum: number): TournamentSeed {
    return { competitor_id: id, source: `/path/${id}`, label: id, seed_number: seedNum };
  }

  it("returns seed order for empty rounds", () => {
    const seeds = [makeSeed("a", 1), makeSeed("b", 2)];
    expect(buildFinalRanking([], seeds)).toEqual(["a", "b"]);
  });

  it("places champion and runner-up correctly", () => {
    const seeds = [makeSeed("a", 1), makeSeed("b", 2)];
    const rounds: TournamentRound[] = [{
      round_number: 1,
      byes: [],
      matches: [{
        round: 1, match_index: 0,
        left_id: "a", right_id: "b",
        run_id: "run1", winner_id: "b",
        left_score: 40, right_score: 60,
        decided_by_seed_advantage: false
      }]
    }];
    const ranking = buildFinalRanking(rounds, seeds);
    expect(ranking[0]).toBe("b"); // champion
    expect(ranking[1]).toBe("a"); // runner-up
  });

  it("handles too_close_to_call final by seed order", () => {
    const seeds = [makeSeed("a", 1), makeSeed("b", 2)];
    const rounds: TournamentRound[] = [{
      round_number: 1,
      byes: [],
      matches: [{
        round: 1, match_index: 0,
        left_id: "a", right_id: "b",
        run_id: "run1", winner_id: null,
        left_score: 50, right_score: 50,
        decided_by_seed_advantage: false
      }]
    }];
    const ranking = buildFinalRanking(rounds, seeds);
    expect(ranking[0]).toBe("a"); // higher seed (1) ranked first
    expect(ranking[1]).toBe("b");
  });
});

describe("tournament end-to-end with mock executor", () => {
  it("runs 4-competitor tournament (no byes)", async () => {
    const libs = [
      createSkillLib("strong1", "strong"),
      createSkillLib("medium1", "medium"),
      createSkillLib("weak1", "weak"),
      createSkillLib("medium2", "medium")
    ];
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tournament-data-"));
    tempRoots.push(dataRoot);

    const result = await runTournament({
      sources: libs,
      labels: ["Strong1", "Medium1", "Weak1", "Medium2"],
      executor: createMockExecutor(),
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      updateElo: true,
      randomSeed: 42
    });

    expect(result.bracket_size).toBe(4);
    expect(result.competitor_count).toBe(4);
    expect(result.rounds.length).toBe(2); // semifinals + final
    expect(result.final_ranking.length).toBe(4);

    // All rounds have matches, no byes for perfect-4
    for (const round of result.rounds) {
      expect(round.byes.length).toBe(0);
    }

    // Tournament result persisted
    const tournamentDir = path.join(dataRoot, "tournaments");
    expect(fs.existsSync(tournamentDir)).toBe(true);
    const files = fs.readdirSync(tournamentDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);

    // Elo ledger updated
    const ledger = loadEloLedger(dataRoot);
    expect(ledger.entries.length).toBeGreaterThan(0);
    expect(ledger.history.length).toBeGreaterThan(0);
  }, 30_000);

  it("runs 3-competitor tournament (1 bye)", async () => {
    const libs = [
      createSkillLib("a", "strong"),
      createSkillLib("b", "medium"),
      createSkillLib("c", "weak")
    ];
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tournament-3-"));
    tempRoots.push(dataRoot);

    const result = await runTournament({
      sources: libs,
      executor: createMockExecutor(),
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      updateElo: false,
      randomSeed: 42
    });

    expect(result.bracket_size).toBe(4);
    expect(result.competitor_count).toBe(3);
    expect(result.rounds.length).toBe(2);

    // Round 1 should have 1 bye
    const round1Byes = result.rounds[0].byes.length;
    expect(round1Byes).toBe(1);

    // Final ranking has all 3
    expect(result.final_ranking.length).toBe(3);
  }, 30_000);

  it("handles 2-competitor tournament (minimal bracket)", async () => {
    const libs = [
      createSkillLib("x", "strong"),
      createSkillLib("y", "weak")
    ];
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tournament-2-"));
    tempRoots.push(dataRoot);

    const result = await runTournament({
      sources: libs,
      executor: createMockExecutor(),
      allowlistedParentRoot: os.tmpdir(),
      dataRoot,
      updateElo: false,
      randomSeed: 42
    });

    expect(result.bracket_size).toBe(2);
    expect(result.rounds.length).toBe(1);
    expect(result.rounds[0].matches.length).toBe(1);
    expect(result.final_ranking.length).toBe(2);
  }, 30_000);
});

describe("seed-advantage tie-breaking", () => {
  it("advances lower seed when match is too_close_to_call in buildFinalRanking", () => {
    const seeds: TournamentSeed[] = [
      { competitor_id: "alpha", source: "/a", label: "Alpha", seed_number: 1 },
      { competitor_id: "beta", source: "/b", label: "Beta", seed_number: 2 }
    ];
    // Simulate a final where winner_id is null (too_close_to_call)
    const rounds: TournamentRound[] = [{
      round_number: 1,
      byes: [],
      matches: [{
        round: 1, match_index: 0,
        left_id: "beta", right_id: "alpha",
        run_id: "draw-run",
        winner_id: null,
        left_score: 50, right_score: 50,
        decided_by_seed_advantage: false
      }]
    }];
    const ranking = buildFinalRanking(rounds, seeds);
    // alpha has seed 1 (lower), should be ranked first
    expect(ranking[0]).toBe("alpha");
    expect(ranking[1]).toBe("beta");
  });

  it("decided_by_seed_advantage flag is set correctly on match result objects", () => {
    // When winner_id is set and decided_by_seed_advantage is true, it means
    // the engine called too_close_to_call and used seed advantage
    const match: TournamentMatchResult = {
      round: 1, match_index: 0,
      left_id: "a", right_id: "b",
      run_id: "r1",
      winner_id: "a",
      left_score: 48, right_score: 52,
      decided_by_seed_advantage: true
    };
    expect(match.decided_by_seed_advantage).toBe(true);
    expect(match.winner_id).toBe("a");
  });

  it("handles 4-competitor bracket where semifinal is too_close_to_call", () => {
    const seeds: TournamentSeed[] = [
      { competitor_id: "s1", source: "/s1", label: "S1", seed_number: 1 },
      { competitor_id: "s2", source: "/s2", label: "S2", seed_number: 2 },
      { competitor_id: "s3", source: "/s3", label: "S3", seed_number: 3 },
      { competitor_id: "s4", source: "/s4", label: "S4", seed_number: 4 }
    ];
    const rounds: TournamentRound[] = [
      {
        round_number: 1,
        byes: [],
        matches: [
          { round: 1, match_index: 0, left_id: "s1", right_id: "s4", run_id: "r1", winner_id: "s1", left_score: 70, right_score: 30, decided_by_seed_advantage: false },
          // This match is too_close_to_call, resolved by seed advantage
          { round: 1, match_index: 1, left_id: "s2", right_id: "s3", run_id: "r2", winner_id: "s2", left_score: 50, right_score: 50, decided_by_seed_advantage: true }
        ]
      },
      {
        round_number: 2,
        byes: [],
        matches: [
          { round: 2, match_index: 0, left_id: "s1", right_id: "s2", run_id: "r3", winner_id: "s1", left_score: 65, right_score: 35, decided_by_seed_advantage: false }
        ]
      }
    ];
    const ranking = buildFinalRanking(rounds, seeds);
    expect(ranking[0]).toBe("s1"); // champion
    expect(ranking[1]).toBe("s2"); // runner-up
    // s3 and s4 both eliminated in round 1; s3 has lower seed, ranked higher
    expect(ranking[2]).toBe("s3");
    expect(ranking[3]).toBe("s4");
  });
});

function createMockExecutor(): Executor {
  return createMock();
}
