/**
 * Composite scoring — aggregates results across multiple profiles into a single
 * weighted final score.
 *
 * Formula: final = (process × 0.55) + (grounded × 0.20) + (friction × 0.15) + (efficiency × 0.10)
 * Efficiency is derived from token cost comparison. If unavailable, weights are renormalized.
 */

export type CompositeWeight = {
  profileId: string;
  weight: number;
};

export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeight[] = [
  { profileId: "default", weight: 0.55 },
  { profileId: "grounded", weight: 0.20 },
  { profileId: "friction", weight: 0.15 },
  { profileId: "efficiency", weight: 0.10 }
];

export type ProfileResult = {
  profileId: string;
  leftScore: number;
  rightScore: number;
};

export type CompositeResult = {
  leftFinal: number;
  rightFinal: number;
  delta: number;
  profileResults: ProfileResult[];
  weights: CompositeWeight[];
  /** Profiles that were excluded (not run or not available). */
  excluded: string[];
};

/**
 * Compute a composite score from multiple profile results.
 * Missing profiles are excluded and weights renormalized.
 */
export function computeCompositeScore(
  results: ProfileResult[],
  weights: CompositeWeight[] = DEFAULT_COMPOSITE_WEIGHTS
): CompositeResult {
  const resultMap = new Map(results.map((r) => [r.profileId, r]));
  const excluded: string[] = [];

  let totalWeight = 0;
  let leftWeighted = 0;
  let rightWeighted = 0;

  for (const { profileId, weight } of weights) {
    const result = resultMap.get(profileId);
    if (!result) {
      excluded.push(profileId);
      continue;
    }
    totalWeight += weight;
    leftWeighted += result.leftScore * weight;
    rightWeighted += result.rightScore * weight;
  }

  const leftFinal = totalWeight > 0 ? Number((leftWeighted / totalWeight).toFixed(2)) : 0;
  const rightFinal = totalWeight > 0 ? Number((rightWeighted / totalWeight).toFixed(2)) : 0;

  return {
    leftFinal,
    rightFinal,
    delta: Number((rightFinal - leftFinal).toFixed(2)),
    profileResults: results,
    weights,
    excluded
  };
}
