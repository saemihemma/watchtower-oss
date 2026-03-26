/**
 * Tournament bracket engine for Watchtower.
 *
 * Single-elimination knockout bracket with standard seeding and bye logic.
 * Supports 2–16 competitors. Non-power-of-2 fields get byes in round 1.
 */

import { mulberry32 } from "./math-helpers.js";
import type {
  TournamentBye,
  TournamentMatchResult,
  TournamentResult,
  TournamentRound,
  TournamentSeed
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Bracket math
// ---------------------------------------------------------------------------

/** Return the smallest power of 2 >= n. */
export function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let power = 1;
  while (power < n) {
    power *= 2;
  }
  return power;
}

/** Number of byes = bracket_size - competitor_count. */
export function computeByeCount(competitorCount: number): number {
  return nextPowerOf2(competitorCount) - competitorCount;
}

// ---------------------------------------------------------------------------
// Deterministic shuffle
// ---------------------------------------------------------------------------

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed competitors for tournament bracket placement.
 *
 * If Elo data exists: sort by Elo descending (highest = seed 1).
 * If no Elo: shuffle deterministically using provided randomSeed.
 * Mixed: Elo-ranked first (sorted), then unranked (shuffled).
 */
export function seedCompetitors(
  competitors: Omit<TournamentSeed, "seed_number">[],
  randomSeed = 42
): TournamentSeed[] {
  const withElo = competitors.filter((c) => c.elo_seed !== undefined);
  const withoutElo = competitors.filter((c) => c.elo_seed === undefined);

  const sortedElo = [...withElo].sort((a, b) => (b.elo_seed ?? 0) - (a.elo_seed ?? 0));
  const rng = mulberry32(randomSeed);
  const shuffledRest = shuffleArray(withoutElo, rng);

  const ordered = [...sortedElo, ...shuffledRest];
  return ordered.map((c, i) => ({ ...c, seed_number: i + 1 }));
}

// ---------------------------------------------------------------------------
// Bracket slot assignment — standard tournament seeding
// ---------------------------------------------------------------------------

/**
 * Generate standard seeding positions for a bracket of given size.
 *
 * For bracket size 8, returns match pairs:
 *   [1,8], [4,5], [3,6], [2,7]
 *
 * This ensures seed 1 and seed 2 can only meet in the final,
 * and top seeds face lowest seeds in round 1.
 */
export function generateSeedPositions(bracketSize: number): Array<[number, number]> {
  if (bracketSize === 1) return [];
  if (bracketSize === 2) return [[1, 2]];

  // Recursive construction of standard tournament bracket
  const positions = buildSeedOrder(bracketSize);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < positions.length; i += 2) {
    pairs.push([positions[i], positions[i + 1]]);
  }
  return pairs;
}

function buildSeedOrder(size: number): number[] {
  if (size === 2) return [1, 2];

  const half = buildSeedOrder(size / 2);
  const result: number[] = [];
  for (const seed of half) {
    result.push(seed, size + 1 - seed);
  }
  return result;
}

export type BracketSlot = {
  matchIndex: number;
  left: TournamentSeed | null;
  right: TournamentSeed | null;
  isBye: boolean;
  byeAdvancer: TournamentSeed | null;
};

/**
 * Build bracket slots for round 1.
 * Seeds beyond competitor count become byes (null).
 */
export function buildBracketSlots(
  seeds: TournamentSeed[],
  bracketSize: number
): BracketSlot[] {
  const pairs = generateSeedPositions(bracketSize);
  const seedMap = new Map<number, TournamentSeed>();
  for (const seed of seeds) {
    seedMap.set(seed.seed_number, seed);
  }

  return pairs.map(([leftSeedNum, rightSeedNum], index) => {
    const left = seedMap.get(leftSeedNum) ?? null;
    const right = seedMap.get(rightSeedNum) ?? null;

    const isBye = left === null || right === null;
    const byeAdvancer = isBye ? (left ?? right) : null;

    return {
      matchIndex: index,
      left,
      right,
      isBye,
      byeAdvancer
    };
  });
}

/**
 * Build next-round bracket slots from an array of advancers.
 * Pairs consecutive advancers. Null entries = byes.
 */
export function buildSlotsFromAdvancers(advancers: (TournamentSeed | null)[]): BracketSlot[] {
  const slots: BracketSlot[] = [];
  for (let i = 0; i < advancers.length; i += 2) {
    const left = advancers[i] ?? null;
    const right = advancers[i + 1] ?? null;
    const isBye = left === null || right === null;
    slots.push({
      matchIndex: slots.length,
      left,
      right,
      isBye,
      byeAdvancer: isBye ? (left ?? right) : null
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Bracket rendering
// ---------------------------------------------------------------------------

function roundLabel(roundNumber: number, totalRounds: number): string {
  if (roundNumber === totalRounds) return "Final";
  if (roundNumber === totalRounds - 1) return "Semifinals";
  if (roundNumber === totalRounds - 2) return "Quarterfinals";
  return `Round ${roundNumber}`;
}

export function renderTournamentResult(result: TournamentResult): string {
  const totalRounds = result.rounds.length;
  const lines: string[] = [
    `# Watchtower Tournament — ${result.bracket_size}-bracket`,
    "",
    `Competitors: ${result.competitor_count} | Bracket size: ${result.bracket_size} | Byes: ${result.bracket_size - result.competitor_count}`,
    "",
    "## Seeding",
    "| Seed | Competitor | Elo |",
    "|------|-----------|-----|"
  ];

  for (const seed of result.seeds) {
    lines.push(`| ${seed.seed_number} | ${seed.label} | ${seed.elo_seed ?? "—"} |`);
  }

  for (const round of result.rounds) {
    const label = roundLabel(round.round_number, totalRounds);
    lines.push("", `## ${label}`);

    for (const bye of round.byes) {
      const seed = result.seeds.find((s) => s.competitor_id === bye.competitor_id);
      lines.push(`- [BYE] Seed ${seed?.seed_number ?? "?"} (${seed?.label ?? bye.competitor_id}) → advances`);
    }

    for (const match of round.matches) {
      const leftSeed = result.seeds.find((s) => s.competitor_id === match.left_id);
      const rightSeed = result.seeds.find((s) => s.competitor_id === match.right_id);
      const leftLabel = leftSeed?.label ?? match.left_id;
      const rightLabel = rightSeed?.label ?? match.right_id;

      if (match.winner_id === null) {
        lines.push(
          `- Match ${match.match_index}: ${leftLabel} vs ${rightLabel} → too close to call (${match.left_score.toFixed(1)} vs ${match.right_score.toFixed(1)})`
        );
      } else {
        const winnerLabel = match.winner_id === match.left_id ? leftLabel : rightLabel;
        const seedAdvice = match.decided_by_seed_advantage ? " [seed advantage]" : "";
        lines.push(
          `- Match ${match.match_index}: ${leftLabel} vs ${rightLabel} → ${winnerLabel} wins (${match.left_score.toFixed(1)} vs ${match.right_score.toFixed(1)})${seedAdvice}`
        );
      }
    }
  }

  lines.push("", "## Final Ranking");
  lines.push("| Place | Competitor |", "|-------|-----------|");
  const placeLabels = ["1st", "2nd", "3rd-4th", "3rd-4th", "5th-8th", "5th-8th", "5th-8th", "5th-8th"];
  for (let i = 0; i < result.final_ranking.length; i++) {
    const id = result.final_ranking[i];
    const seed = result.seeds.find((s) => s.competitor_id === id);
    const place = i < placeLabels.length ? placeLabels[i] : `${i + 1}th`;
    lines.push(`| ${place} | ${seed?.label ?? id} |`);
  }

  return lines.join("\n");
}
