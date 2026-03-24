/**
 * Watchtower v2 Statistical Engine
 * Implements Bayesian conjugate normal, bootstrap CI, CV, and ROPE verdict.
 */

import { CV_MODERATE_THRESHOLD, CV_UNSTABLE_THRESHOLD } from "./constants.js";

/**
 * Simple seeded PRNG (mulberry32) for reproducible bootstrap sampling.
 */
function createSeededRandom(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bayesian conjugate normal-normal update.
 * Prior: N(mu0, sigma0^2), Likelihood: N(mu, sigma_x^2), n observations
 * Returns posterior N(mu_n, sigma_n^2)
 */
export function bayesianUpdate(params: {
  priorMean: number;
  priorSigma: number;
  observedMean: number;
  likelihoodSigma: number;
  n: number;
}): { posteriorMean: number; posteriorSigma: number; ci95: [number, number] } {
  const { priorMean, priorSigma, observedMean, likelihoodSigma, n } = params;

  const priorPrecision = 1 / (priorSigma * priorSigma);
  const likelihoodPrecision = n / (likelihoodSigma * likelihoodSigma);
  const posteriorPrecision = priorPrecision + likelihoodPrecision;
  const posteriorSigma = Math.sqrt(1 / posteriorPrecision);

  const posteriorMean =
    posteriorSigma * posteriorSigma * (priorPrecision * priorMean + likelihoodPrecision * observedMean);

  const z95 = 1.96;
  const ci95: [number, number] = [
    posteriorMean - z95 * posteriorSigma,
    posteriorMean + z95 * posteriorSigma
  ];

  return { posteriorMean, posteriorSigma, ci95 };
}

/**
 * Bootstrap confidence interval on the delta between two score arrays.
 * Percentile method, B resamples (default 10000).
 * Returns [lower, upper] 95% CI, mean delta, and probability of right superiority.
 */
export function bootstrapDeltaCI(params: {
  leftScores: number[];
  rightScores: number[];
  nResamples?: number;
  seed?: number;
}): { ci95: [number, number]; probRightSuperior: number; meanDelta: number } {
  const { leftScores, rightScores, nResamples = 10000, seed = 42 } = params;

  if (leftScores.length === 0 || rightScores.length === 0) {
    return { ci95: [0, 0], probRightSuperior: 0.5, meanDelta: 0 };
  }

  const rng = createSeededRandom(seed);
  const deltas: number[] = [];

  for (let i = 0; i < nResamples; i++) {
    let leftSum = 0;
    for (let j = 0; j < leftScores.length; j++) {
      const idx = Math.floor(rng() * leftScores.length);
      leftSum += leftScores[idx];
    }
    const leftMean = leftSum / leftScores.length;

    let rightSum = 0;
    for (let j = 0; j < rightScores.length; j++) {
      const idx = Math.floor(rng() * rightScores.length);
      rightSum += rightScores[idx];
    }
    const rightMean = rightSum / rightScores.length;

    deltas.push(rightMean - leftMean);
  }

  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(deltas.length * 0.025)];
  const upper = deltas[Math.floor(deltas.length * 0.975)];

  const probRightSuperior = deltas.filter((d) => d > 0).length / deltas.length;

  const meanDelta =
    rightScores.reduce((a, b) => a + b, 0) / rightScores.length -
    leftScores.reduce((a, b) => a + b, 0) / leftScores.length;

  return {
    ci95: [lower, upper],
    probRightSuperior,
    meanDelta
  };
}

/**
 * Coefficient of Variation = std / mean.
 * Returns CV, mean, std, and stability label.
 */
export function coefficientOfVariation(scores: number[]): {
  cv: number;
  mean: number;
  std: number;
  stabilityLabel: "stable" | "moderate" | "unstable";
} {
  if (scores.length === 0) {
    return { cv: 0, mean: 0, std: 0, stabilityLabel: "stable" };
  }

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);

  const cv = mean === 0 ? 0 : std / Math.abs(mean);

  let stabilityLabel: "stable" | "moderate" | "unstable" = "stable";
  if (cv > CV_UNSTABLE_THRESHOLD) {
    stabilityLabel = "unstable";
  } else if (cv > CV_MODERATE_THRESHOLD) {
    stabilityLabel = "moderate";
  }

  return { cv, mean, std, stabilityLabel };
}

/**
 * ROPE decision: given 95% CI on delta, compare to [-epsilon, +epsilon].
 * Returns verdict.
 */
export function ropeDecision(params: {
  ci95: [number, number];
  epsilon: number;
}): "left_wins" | "right_wins" | "equivalent" | "undecided" {
  const { ci95: [lower, upper], epsilon } = params;

  if (upper < -epsilon) {
    return "left_wins";
  }
  if (lower > epsilon) {
    return "right_wins";
  }
  if (lower >= -epsilon && upper <= epsilon) {
    return "equivalent";
  }
  return "undecided";
}
