/**
 * Watchtower scoring constants.
 * All magic numbers used in verdict, stats-verdict, and scoring logic live here.
 */

// --- Winner determination (verdict.ts) ---

/** Minimum absolute score delta (on 0–100 scale) to declare a winner. */
export const WINNER_DELTA_THRESHOLD = 5;

/** Task-level score drop (on 0–1 scale) that counts as a critical regression. */
export const CRITICAL_REGRESSION_THRESHOLD = -0.15;

// --- Confidence (verdict.ts) ---

/** Max failed-trial rate for "high" confidence. */
export const HIGH_CONFIDENCE_MAX_FAIL_RATE = 0.1;

/** Max failed-trial rate for "medium" confidence. */
export const MEDIUM_CONFIDENCE_MAX_FAIL_RATE = 0.2;

/** Trial score range (max − min, 0–1 scale) above which a category is "unstable". */
export const UNSTABLE_SCORE_RANGE = 0.5;

// --- Devil's Advocate (verdict.ts) ---

/** Score delta (on 0–100 scale) below which the winner's margin deserves caution. */
export const CAUTION_MARGIN = 10;

/** Max top-reasons or Devil's Advocate arguments returned. */
export const MAX_REASONS = 5;

/** Max category-level reasons returned in top reasons. */
export const MAX_CATEGORY_REASONS = 4;

// --- Bayesian / stats defaults (stats-verdict.ts) ---

export const DEFAULT_PRIOR_MEAN = 0.5;
export const DEFAULT_PRIOR_SIGMA = 0.15;
export const DEFAULT_LIKELIHOOD_SIGMA = 0.1;
export const DEFAULT_ROPE_EPSILON = 5;
export const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;
export const DEFAULT_BOOTSTRAP_SEED = 42;

// --- CV stability thresholds (stats.ts) ---

export const CV_UNSTABLE_THRESHOLD = 0.2;
export const CV_MODERATE_THRESHOLD = 0.1;

// --- Elo defaults (elo.ts) ---

export const ELO_INITIAL_RATING = 1500;
export const ELO_K_FACTOR = 32;
