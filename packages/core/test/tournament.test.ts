import { describe, expect, it } from "vitest";
import {
  nextPowerOf2,
  computeByeCount,
  seedCompetitors,
  generateSeedPositions,
  buildBracketSlots
} from "../src/tournament.js";
import type { TournamentSeed } from "../src/schemas.js";

describe("tournament bracket math", () => {
  it("computes next power of 2", () => {
    expect(nextPowerOf2(1)).toBe(1);
    expect(nextPowerOf2(2)).toBe(2);
    expect(nextPowerOf2(3)).toBe(4);
    expect(nextPowerOf2(4)).toBe(4);
    expect(nextPowerOf2(5)).toBe(8);
    expect(nextPowerOf2(7)).toBe(8);
    expect(nextPowerOf2(8)).toBe(8);
    expect(nextPowerOf2(9)).toBe(16);
    expect(nextPowerOf2(16)).toBe(16);
  });

  it("computes bye count", () => {
    expect(computeByeCount(4)).toBe(0);
    expect(computeByeCount(8)).toBe(0);
    expect(computeByeCount(16)).toBe(0);
    expect(computeByeCount(6)).toBe(2);
    expect(computeByeCount(5)).toBe(3);
    expect(computeByeCount(7)).toBe(1);
    expect(computeByeCount(3)).toBe(1);
    expect(computeByeCount(2)).toBe(0);
  });
});

describe("tournament seeding", () => {
  function makeSeed(id: string, elo?: number): Omit<TournamentSeed, "seed_number"> {
    return { competitor_id: id, source: `/path/${id}`, label: id, elo_seed: elo };
  }

  it("seeds by Elo when all competitors have Elo", () => {
    const seeds = seedCompetitors([
      makeSeed("c", 1400),
      makeSeed("a", 1600),
      makeSeed("b", 1500)
    ]);

    expect(seeds[0].competitor_id).toBe("a");
    expect(seeds[0].seed_number).toBe(1);
    expect(seeds[1].competitor_id).toBe("b");
    expect(seeds[1].seed_number).toBe(2);
    expect(seeds[2].competitor_id).toBe("c");
    expect(seeds[2].seed_number).toBe(3);
  });

  it("shuffles deterministically when no Elo data", () => {
    const seeds1 = seedCompetitors([
      makeSeed("a"),
      makeSeed("b"),
      makeSeed("c"),
      makeSeed("d")
    ], 42);
    const seeds2 = seedCompetitors([
      makeSeed("a"),
      makeSeed("b"),
      makeSeed("c"),
      makeSeed("d")
    ], 42);

    expect(seeds1.map((s) => s.competitor_id)).toEqual(seeds2.map((s) => s.competitor_id));
  });

  it("uses different order with different seed", () => {
    const seeds1 = seedCompetitors([
      makeSeed("a"),
      makeSeed("b"),
      makeSeed("c"),
      makeSeed("d")
    ], 42);
    const seeds2 = seedCompetitors([
      makeSeed("a"),
      makeSeed("b"),
      makeSeed("c"),
      makeSeed("d")
    ], 99);

    // With 4 items and different seeds, it's very likely the order differs
    const ids1 = seeds1.map((s) => s.competitor_id).join(",");
    const ids2 = seeds2.map((s) => s.competitor_id).join(",");
    expect(ids1).not.toBe(ids2);
  });

  it("places Elo-seeded competitors before unranked", () => {
    const seeds = seedCompetitors([
      makeSeed("unranked1"),
      makeSeed("ranked", 1500),
      makeSeed("unranked2")
    ]);

    expect(seeds[0].competitor_id).toBe("ranked");
    expect(seeds[0].seed_number).toBe(1);
  });
});

describe("bracket slot generation", () => {
  it("generates standard 8-bracket positions", () => {
    const positions = generateSeedPositions(8);
    // Recursive standard: [1,8], [4,5], [2,7], [3,6]
    // Key property: seed 1 and 2 in opposite halves
    expect(positions).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6]
    ]);
  });

  it("generates standard 4-bracket positions", () => {
    const positions = generateSeedPositions(4);
    // Standard bracket: [1,4], [2,3]
    expect(positions).toEqual([
      [1, 4],
      [2, 3]
    ]);
  });

  it("generates standard 2-bracket positions", () => {
    const positions = generateSeedPositions(2);
    expect(positions).toEqual([[1, 2]]);
  });

  it("generates standard 16-bracket positions", () => {
    const positions = generateSeedPositions(16);
    expect(positions.length).toBe(8);
    // Seed 1 vs Seed 16 in first match
    expect(positions[0]).toEqual([1, 16]);
    // Seed 2 faces seed 15 somewhere
    const seed2Match = positions.find(([a, b]) => a === 2 || b === 2);
    expect(seed2Match).toBeTruthy();
    expect(seed2Match).toEqual([2, 15]);
    // All seeds 1-16 appear exactly once
    const allSeeds = positions.flat().sort((a, b) => a - b);
    expect(allSeeds).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});

describe("bracket slots with byes", () => {
  function makeSeeds(count: number): TournamentSeed[] {
    return Array.from({ length: count }, (_, i) => ({
      competitor_id: `c${i + 1}`,
      source: `/path/c${i + 1}`,
      label: `Competitor ${i + 1}`,
      seed_number: i + 1
    }));
  }

  it("4 competitors in 4-bracket → no byes", () => {
    const slots = buildBracketSlots(makeSeeds(4), 4);
    expect(slots.length).toBe(2);
    expect(slots.every((s) => !s.isBye)).toBe(true);
  });

  it("6 competitors in 8-bracket → 2 byes", () => {
    const seeds = makeSeeds(6);
    const slots = buildBracketSlots(seeds, 8);
    expect(slots.length).toBe(4);

    const byes = slots.filter((s) => s.isBye);
    const matches = slots.filter((s) => !s.isBye);
    expect(byes.length).toBe(2);
    expect(matches.length).toBe(2);

    // Seeds 1 and 2 should get byes (they face seeds 8 and 7 which don't exist)
    const byeAdvancers = byes.map((s) => s.byeAdvancer!.seed_number).sort();
    expect(byeAdvancers).toEqual([1, 2]);
  });

  it("5 competitors in 8-bracket → 3 byes", () => {
    const seeds = makeSeeds(5);
    const slots = buildBracketSlots(seeds, 8);
    const byes = slots.filter((s) => s.isBye);
    expect(byes.length).toBe(3);

    // Seeds 1, 2, 3 should get byes
    const byeAdvancers = byes.map((s) => s.byeAdvancer!.seed_number).sort();
    expect(byeAdvancers).toEqual([1, 2, 3]);
  });

  it("7 competitors in 8-bracket → 1 bye", () => {
    const seeds = makeSeeds(7);
    const slots = buildBracketSlots(seeds, 8);
    const byes = slots.filter((s) => s.isBye);
    expect(byes.length).toBe(1);
    expect(byes[0].byeAdvancer!.seed_number).toBe(1);
  });

  it("3 competitors in 4-bracket → 1 bye", () => {
    const seeds = makeSeeds(3);
    const slots = buildBracketSlots(seeds, 4);
    const byes = slots.filter((s) => s.isBye);
    expect(byes.length).toBe(1);
    expect(byes[0].byeAdvancer!.seed_number).toBe(1);
  });
});
