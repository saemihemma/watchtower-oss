import { describe, it, expect } from "vitest";
import {
  bayesianUpdate,
  bootstrapDeltaCI,
  coefficientOfVariation,
  ropeDecision
} from "../src/stats.js";

describe("Bayesian Update", () => {
  it("should compute posterior with weak prior and strong likelihood", () => {
    const result = bayesianUpdate({
      priorMean: 0.5,
      priorSigma: 0.15,
      observedMean: 0.8,
      likelihoodSigma: 0.1,
      n: 10
    });

    // Posterior should be close to observed mean when likelihood is strong
    expect(result.posteriorMean).toBeGreaterThan(0.7);
    expect(result.posteriorMean).toBeLessThan(0.9);
    expect(result.posteriorSigma).toBeGreaterThan(0);
    expect(result.posteriorSigma).toBeLessThan(0.15);
    expect(result.ci95[0]).toBeLessThan(result.posteriorMean);
    expect(result.ci95[1]).toBeGreaterThan(result.posteriorMean);
  });

  it("should compute posterior with strong prior and weak likelihood", () => {
    const result = bayesianUpdate({
      priorMean: 0.5,
      priorSigma: 0.05, // Strong prior
      observedMean: 0.8,
      likelihoodSigma: 0.3, // Weak likelihood
      n: 1
    });

    // Posterior should be closer to prior when prior is strong
    expect(result.posteriorMean).toBeGreaterThan(0.5);
    expect(result.posteriorMean).toBeLessThan(0.7);
  });

  it("should produce valid 95% CI", () => {
    const result = bayesianUpdate({
      priorMean: 0.5,
      priorSigma: 0.15,
      observedMean: 0.6,
      likelihoodSigma: 0.1,
      n: 5
    });

    expect(result.ci95[0]).toBeLessThan(result.posteriorMean);
    expect(result.ci95[1]).toBeGreaterThan(result.posteriorMean);
    const margin = result.ci95[1] - result.ci95[0];
    expect(margin).toBeGreaterThan(0);
  });
});

describe("Bootstrap Delta CI", () => {
  it("should detect right superiority when right mean > left mean", () => {
    const leftScores = [0.3, 0.35, 0.32, 0.33, 0.34];
    const rightScores = [0.7, 0.72, 0.68, 0.71, 0.69];

    const result = bootstrapDeltaCI({
      leftScores,
      rightScores,
      nResamples: 5000,
      seed: 123
    });

    expect(result.meanDelta).toBeGreaterThan(0.3); // Right is clearly better
    expect(result.probRightSuperior).toBeGreaterThan(0.95); // High probability
    expect(result.ci95[0]).toBeGreaterThan(0); // CI doesn't include 0
  });

  it("should detect left superiority when left mean > right mean", () => {
    const leftScores = [0.7, 0.72, 0.68, 0.71, 0.69];
    const rightScores = [0.3, 0.35, 0.32, 0.33, 0.34];

    const result = bootstrapDeltaCI({
      leftScores,
      rightScores,
      nResamples: 5000,
      seed: 123
    });

    expect(result.meanDelta).toBeLessThan(-0.3); // Left is clearly better
    expect(result.probRightSuperior).toBeLessThan(0.05); // Low probability
    expect(result.ci95[1]).toBeLessThan(0); // CI doesn't include 0
  });

  it("should include zero in CI for similar distributions", () => {
    const leftScores = [0.5, 0.51, 0.49, 0.50, 0.52];
    const rightScores = [0.5, 0.50, 0.51, 0.49, 0.50];

    const result = bootstrapDeltaCI({
      leftScores,
      rightScores,
      nResamples: 5000,
      seed: 123
    });

    expect(result.ci95[0]).toBeLessThan(0);
    expect(result.ci95[1]).toBeGreaterThan(0); // CI contains 0
    expect(result.probRightSuperior).toBeCloseTo(0.5, 0.1);
  });

  it("should return empty CI for empty arrays", () => {
    const result = bootstrapDeltaCI({
      leftScores: [],
      rightScores: []
    });

    expect(result.ci95).toEqual([0, 0]);
    expect(result.probRightSuperior).toEqual(0.5);
    expect(result.meanDelta).toEqual(0);
  });

  it("should be reproducible with same seed", () => {
    const leftScores = [0.4, 0.45, 0.42];
    const rightScores = [0.6, 0.65, 0.62];

    const result1 = bootstrapDeltaCI({
      leftScores,
      rightScores,
      nResamples: 1000,
      seed: 999
    });

    const result2 = bootstrapDeltaCI({
      leftScores,
      rightScores,
      nResamples: 1000,
      seed: 999
    });

    expect(result1.ci95[0]).toEqual(result2.ci95[0]);
    expect(result1.ci95[1]).toEqual(result2.ci95[1]);
    expect(result1.meanDelta).toEqual(result2.meanDelta);
  });
});

describe("Coefficient of Variation", () => {
  it("should identify stable distribution (low CV)", () => {
    const scores = [0.5, 0.51, 0.49, 0.50, 0.52, 0.48];

    const result = coefficientOfVariation(scores);

    expect(result.cv).toBeLessThan(0.1);
    expect(result.stabilityLabel).toEqual("stable");
    expect(result.mean).toBeCloseTo(0.5, 1);
  });

  it("should identify moderate distribution (medium CV)", () => {
    const scores = [0.4, 0.5, 0.6, 0.45, 0.55, 0.5];

    const result = coefficientOfVariation(scores);

    expect(result.cv).toBeGreaterThan(0.08);
    expect(result.cv).toBeLessThan(0.22);
    expect(result.stabilityLabel).toEqual("moderate");
  });

  it("should identify unstable distribution (high CV)", () => {
    const scores = [0.1, 0.8, 0.2, 0.9, 0.15, 0.85];

    const result = coefficientOfVariation(scores);

    expect(result.cv).toBeGreaterThan(0.2);
    expect(result.stabilityLabel).toEqual("unstable");
  });

  it("should handle single value", () => {
    const scores = [0.5];

    const result = coefficientOfVariation(scores);

    expect(result.std).toEqual(0);
    expect(result.cv).toEqual(0);
    expect(result.stabilityLabel).toEqual("stable");
  });

  it("should handle empty array", () => {
    const scores: number[] = [];

    const result = coefficientOfVariation(scores);

    expect(result.cv).toEqual(0);
    expect(result.mean).toEqual(0);
    expect(result.std).toEqual(0);
    expect(result.stabilityLabel).toEqual("stable");
  });

  it("should handle all zero scores", () => {
    const scores = [0, 0, 0];

    const result = coefficientOfVariation(scores);

    expect(result.mean).toEqual(0);
    expect(result.std).toEqual(0);
    expect(result.cv).toEqual(0);
  });
});

describe("ROPE Decision", () => {
  it("should return right_wins when CI is entirely above epsilon", () => {
    const result = ropeDecision({
      ci95: [0.08, 0.15],
      epsilon: 0.05
    });

    expect(result).toEqual("right_wins");
  });

  it("should return left_wins when CI is entirely below -epsilon", () => {
    const result = ropeDecision({
      ci95: [-0.15, -0.08],
      epsilon: 0.05
    });

    expect(result).toEqual("left_wins");
  });

  it("should return equivalent when CI is entirely within ROPE", () => {
    const result = ropeDecision({
      ci95: [-0.02, 0.03],
      epsilon: 0.05
    });

    expect(result).toEqual("equivalent");
  });

  it("should return undecided when CI overlaps ROPE boundary", () => {
    const result = ropeDecision({
      ci95: [0.02, 0.08],
      epsilon: 0.05
    });

    expect(result).toEqual("undecided");
  });

  it("should return undecided when CI overlaps left ROPE boundary", () => {
    const result = ropeDecision({
      ci95: [-0.08, -0.02],
      epsilon: 0.05
    });

    expect(result).toEqual("undecided");
  });

  it("should handle zero delta", () => {
    const result = ropeDecision({
      ci95: [-0.02, 0.02],
      epsilon: 0.05
    });

    expect(result).toEqual("equivalent");
  });
});
