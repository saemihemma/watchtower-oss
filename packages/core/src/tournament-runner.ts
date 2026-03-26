/**
 * Tournament runner for Watchtower.
 *
 * Executes a single-elimination knockout bracket by running pairwise
 * comparisons through the standard Watchtower engine.
 *
 * Decomposed into composable phases:
 *   1. initializeSeeds — resolve sources, load Elo, seed competitors
 *   2. executeBracket — run all rounds sequentially
 *   3. buildFinalRanking — derive placement from match results
 *   4. persistTournament — write result JSON
 */

import { v7 as uuidv7 } from "uuid";
import { deriveLibraryId, loadEloLedger, recordEloMatch, saveEloLedger } from "./elo.js";
import { compareLibraries } from "./engine.js";
import { writeJson } from "./files.js";
import { getDataPaths, renderRunReport } from "./service.js";
import {
  type ComparisonRun,
  type Executor,
  type TournamentBye,
  type TournamentMatchResult,
  type TournamentResult,
  type TournamentRound,
  type TournamentSeed
} from "./schemas.js";
import {
  buildBracketSlots,
  type BracketSlot,
  buildSlotsFromAdvancers,
  nextPowerOf2,
  seedCompetitors
} from "./tournament.js";

import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TournamentOptions = {
  sources: string[];
  labels?: string[];
  profileId?: string;
  executor: Executor;
  allowlistedParentRoot: string;
  dataRoot: string;
  updateElo?: boolean;
  randomSeed?: number;
  /** Optional callback for progress reporting (e.g., "Round 2/3: 4 matches"). */
  onProgress?: (message: string) => void;
};

export function validateTournamentSize(count: number): void {
  if (count < 2) {
    throw new Error("Tournament requires at least 2 competitors.");
  }
  if (count > 16) {
    throw new Error("Tournament supports a maximum of 16 competitors.");
  }
}

export async function runTournament(options: TournamentOptions): Promise<TournamentResult> {
  validateTournamentSize(options.sources.length);

  const seeds = initializeSeeds(options);
  const rounds = await executeBracket(seeds, options);
  const finalRanking = buildFinalRanking(rounds, seeds);
  const result = assembleTournamentResult(seeds, rounds, finalRanking, options.profileId);
  persistTournament(result, options.dataRoot);

  return result;
}

// ---------------------------------------------------------------------------
// Phase 1: Initialize seeds
// ---------------------------------------------------------------------------

function initializeSeeds(options: TournamentOptions): TournamentSeed[] {
  const { sources, labels, dataRoot, randomSeed = 42 } = options;
  const ledger = loadEloLedger(dataRoot);

  const rawSeeds: Omit<TournamentSeed, "seed_number">[] = sources.map((source, i) => {
    const label = labels?.[i] ?? path.basename(source);
    const competitorId = deriveCompetitorId(source);
    const eloEntry = ledger.entries.find((e) => e.library_id === competitorId);
    return {
      competitor_id: competitorId,
      source,
      label,
      elo_seed: eloEntry?.elo
    };
  });

  return seedCompetitors(rawSeeds, randomSeed);
}

// ---------------------------------------------------------------------------
// Phase 2: Execute bracket
// ---------------------------------------------------------------------------

async function executeBracket(
  seeds: TournamentSeed[],
  options: TournamentOptions
): Promise<TournamentRound[]> {
  const bracketSize = nextPowerOf2(seeds.length);
  const totalRounds = Math.log2(bracketSize);
  const rounds: TournamentRound[] = [];

  let currentSlots: BracketSlot[] = buildBracketSlots(seeds, bracketSize);

  for (let roundNum = 1; roundNum <= totalRounds; roundNum++) {
    const matchCount = currentSlots.filter((s) => !s.isBye).length;
    const byeCount = currentSlots.filter((s) => s.isBye).length;
    options.onProgress?.(
      `Round ${roundNum}/${totalRounds}: ${matchCount} match${matchCount !== 1 ? "es" : ""}${byeCount > 0 ? `, ${byeCount} bye${byeCount !== 1 ? "s" : ""}` : ""}`
    );
    const { round, advancers } = await executeRound(roundNum, currentSlots, options);
    rounds.push(round);

    if (roundNum < totalRounds) {
      currentSlots = buildSlotsFromAdvancers(advancers);
    }
  }

  return rounds;
}

async function executeRound(
  roundNum: number,
  slots: BracketSlot[],
  options: TournamentOptions
): Promise<{ round: TournamentRound; advancers: (TournamentSeed | null)[] }> {
  const roundMatches: TournamentMatchResult[] = [];
  const roundByes: TournamentBye[] = [];
  const advancers: (TournamentSeed | null)[] = new Array(slots.length).fill(null);

  for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
    const slot = slots[slotIdx];

    if (slot.isBye) {
      if (!slot.byeAdvancer) {
        throw new Error(`Bye slot at round ${roundNum}, match ${slot.matchIndex} has no advancer. Bracket is malformed.`);
      }
      roundByes.push({
        round: roundNum,
        match_index: slot.matchIndex,
        competitor_id: slot.byeAdvancer.competitor_id
      });
      advancers[slotIdx] = slot.byeAdvancer;
      continue;
    }

    const left = slot.left!;
    const right = slot.right!;

    const matchRun = await runMatch({
      left,
      right,
      profileId: options.profileId,
      executor: options.executor,
      allowlistedParentRoot: options.allowlistedParentRoot,
      dataRoot: options.dataRoot
    });

    const { winnerId, decidedBySeedAdvantage } = resolveMatchWinner(matchRun, left, right);

    // Elo update: skip for seed-advantage decisions — recording a draw would
    // misrepresent the true comparison result and inflate high-seed ratings.
    if (options.updateElo !== false && !decidedBySeedAdvantage) {
      updateEloSafe(options.dataRoot, matchRun);
    }

    roundMatches.push({
      round: roundNum,
      match_index: slot.matchIndex,
      left_id: left.competitor_id,
      right_id: right.competitor_id,
      run_id: matchRun.run_id,
      winner_id: winnerId,
      left_score: matchRun.scorecard.left_score,
      right_score: matchRun.scorecard.right_score,
      decided_by_seed_advantage: decidedBySeedAdvantage
    });

    const winner = winnerId === left.competitor_id ? left : right;
    advancers[slotIdx] = winner;
  }

  return {
    round: { round_number: roundNum, matches: roundMatches, byes: roundByes },
    advancers
  };
}

// ---------------------------------------------------------------------------
// Match winner resolution
// ---------------------------------------------------------------------------

function resolveMatchWinner(
  matchRun: ComparisonRun,
  left: TournamentSeed,
  right: TournamentSeed
): { winnerId: string; decidedBySeedAdvantage: boolean } {
  if (matchRun.winner === "left") {
    return { winnerId: left.competitor_id, decidedBySeedAdvantage: false };
  }
  if (matchRun.winner === "right") {
    return { winnerId: right.competitor_id, decidedBySeedAdvantage: false };
  }

  // too_close_to_call — seed advantage: lower seed number wins
  const winnerId = left.seed_number <= right.seed_number
    ? left.competitor_id
    : right.competitor_id;
  return { winnerId, decidedBySeedAdvantage: true };
}

// ---------------------------------------------------------------------------
// Elo update (isolated, non-throwing)
// ---------------------------------------------------------------------------

function updateEloSafe(dataRoot: string, run: ComparisonRun): void {
  try {
    const ledger = loadEloLedger(dataRoot);
    recordEloMatch(ledger, run);
    saveEloLedger(dataRoot, ledger);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Elo update failed for run ${run.run_id}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Final ranking
// ---------------------------------------------------------------------------

export function buildFinalRanking(rounds: TournamentRound[], seeds: TournamentSeed[]): string[] {
  if (rounds.length === 0) {
    return seeds.map((s) => s.competitor_id);
  }

  const seedMap = new Map(seeds.map((s) => [s.competitor_id, s]));
  const ranking: string[] = [];
  const eliminated = new Map<string, number>();

  // Track eliminations per round
  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.winner_id) {
        const loserId = match.winner_id === match.left_id ? match.right_id : match.left_id;
        eliminated.set(loserId, round.round_number);
      }
    }
  }

  // Champion and runner-up from final
  const finalRound = rounds[rounds.length - 1];
  const finalMatch = finalRound?.matches[finalRound.matches.length - 1];

  if (finalMatch) {
    if (finalMatch.winner_id) {
      ranking.push(finalMatch.winner_id);
      const runnerUp = finalMatch.winner_id === finalMatch.left_id
        ? finalMatch.right_id
        : finalMatch.left_id;
      ranking.push(runnerUp);
    } else {
      // too_close_to_call final: both finalists, higher seed first
      const leftSeed = seedMap.get(finalMatch.left_id)?.seed_number ?? 999;
      const rightSeed = seedMap.get(finalMatch.right_id)?.seed_number ?? 999;
      if (leftSeed <= rightSeed) {
        ranking.push(finalMatch.left_id, finalMatch.right_id);
      } else {
        ranking.push(finalMatch.right_id, finalMatch.left_id);
      }
    }
  }

  // Remaining competitors sorted by elimination round (later = higher), then seed
  const rest = seeds
    .map((s) => s.competitor_id)
    .filter((id) => !ranking.includes(id))
    .sort((a, b) => {
      const roundA = eliminated.get(a) ?? 0;
      const roundB = eliminated.get(b) ?? 0;
      if (roundB !== roundA) return roundB - roundA;
      const seedA = seedMap.get(a)?.seed_number ?? 999;
      const seedB = seedMap.get(b)?.seed_number ?? 999;
      return seedA - seedB;
    });

  ranking.push(...rest);
  return ranking;
}

// ---------------------------------------------------------------------------
// Phase 4: Assembly and persistence
// ---------------------------------------------------------------------------

function assembleTournamentResult(
  seeds: TournamentSeed[],
  rounds: TournamentRound[],
  finalRanking: string[],
  profileId?: string
): TournamentResult {
  const bracketSize = nextPowerOf2(seeds.length);
  return {
    tournament_id: uuidv7(),
    profile_id: profileId ?? "default",
    bracket_size: bracketSize,
    competitor_count: seeds.length,
    seeds,
    rounds,
    final_ranking: finalRanking,
    created_at: new Date().toISOString()
  };
}

function persistTournament(result: TournamentResult, dataRoot: string): void {
  const paths = getDataPaths(dataRoot);
  const tournamentDir = path.join(paths.dataRoot, "tournaments");
  fs.mkdirSync(tournamentDir, { recursive: true });
  writeJson(path.join(tournamentDir, `${result.tournament_id}.json`), result);
}

// ---------------------------------------------------------------------------
// Match execution (pure comparison, no Elo)
// ---------------------------------------------------------------------------

/**
 * Derive competitor ID from source path.
 * Delegates to deriveLibraryId from elo.ts for consistency.
 */
export function deriveCompetitorId(source: string): string {
  return deriveLibraryId(source);
}

type MatchInput = {
  left: TournamentSeed;
  right: TournamentSeed;
  profileId?: string;
  executor: Executor;
  allowlistedParentRoot: string;
  dataRoot: string;
};

async function runMatch(input: MatchInput): Promise<ComparisonRun> {
  const paths = getDataPaths(input.dataRoot);
  const run = await compareLibraries({
    allowlistedParentRoot: input.allowlistedParentRoot,
    snapshotsRoot: paths.snapshotsRoot,
    executor: input.executor,
    leftRootPath: input.left.source,
    rightRootPath: input.right.source,
    comparisonMode: "cross_library",
    comparisonScenario: "head_to_head",
    profileId: input.profileId,
    leftLabel: input.left.label,
    rightLabel: input.right.label
  });

  // Persist the individual run
  const persistedRun: ComparisonRun = {
    ...run,
    run_path: path.join(paths.runsRoot, `${run.run_id}.json`),
    report_path: path.join(paths.reportsRoot, `${run.run_id}.md`)
  };
  const reportText = renderRunReport(persistedRun);
  writeJson(persistedRun.run_path!, persistedRun);
  fs.mkdirSync(path.dirname(persistedRun.report_path!), { recursive: true });
  fs.writeFileSync(persistedRun.report_path!, reportText, "utf8");

  return persistedRun;
}
