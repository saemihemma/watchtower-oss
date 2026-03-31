import { describe, expect, it } from "vitest";
import { computeCompositeScore, DEFAULT_COMPOSITE_WEIGHTS } from "../src/index.js";

describe("computeCompositeScore", () => {
  it("computes weighted average across profiles", () => {
    const result = computeCompositeScore([
      { profileId: "default", leftScore: 80, rightScore: 40 },
      { profileId: "grounded", leftScore: 60, rightScore: 60 },
      { profileId: "friction", leftScore: 50, rightScore: 70 }
    ]);

    expect(result.leftFinal).toBeGreaterThan(0);
    expect(result.rightFinal).toBeGreaterThan(0);
    expect(result.delta).toBeCloseTo(result.rightFinal - result.leftFinal, 1);
    expect(result.profileResults).toHaveLength(3);
    expect(result.excluded).toContain("efficiency");
  });

  it("renormalizes weights when profiles are missing", () => {
    const full = computeCompositeScore([
      { profileId: "default", leftScore: 100, rightScore: 0 },
      { profileId: "grounded", leftScore: 100, rightScore: 0 },
      { profileId: "friction", leftScore: 100, rightScore: 0 }
    ]);

    const partial = computeCompositeScore([
      { profileId: "default", leftScore: 100, rightScore: 0 }
    ]);

    // Both should have left > 0 and right = 0
    expect(full.leftFinal).toBeGreaterThan(0);
    expect(full.rightFinal).toBe(0);
    expect(partial.leftFinal).toBe(100); // Only default, renormalized to 100%
    expect(partial.rightFinal).toBe(0);
    expect(partial.excluded).toContain("grounded");
    expect(partial.excluded).toContain("friction");
    expect(partial.excluded).toContain("efficiency");
  });

  it("returns zeros when no profile results provided", () => {
    const result = computeCompositeScore([]);
    expect(result.leftFinal).toBe(0);
    expect(result.rightFinal).toBe(0);
    expect(result.delta).toBe(0);
  });

  it("uses default weights when none provided", () => {
    const result = computeCompositeScore([
      { profileId: "default", leftScore: 50, rightScore: 50 }
    ]);
    expect(result.weights).toBe(DEFAULT_COMPOSITE_WEIGHTS);
  });

  it("supports custom weights", () => {
    const customWeights = [
      { profileId: "default", weight: 0.5 },
      { profileId: "friction", weight: 0.5 }
    ];
    const result = computeCompositeScore(
      [
        { profileId: "default", leftScore: 100, rightScore: 0 },
        { profileId: "friction", leftScore: 0, rightScore: 100 }
      ],
      customWeights
    );
    expect(result.leftFinal).toBe(50);
    expect(result.rightFinal).toBe(50);
    expect(result.delta).toBe(0);
    expect(result.excluded).toHaveLength(0);
  });
});
