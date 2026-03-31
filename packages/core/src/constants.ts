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

// --- IRT calibration (irt-calibrator.ts) ---

/** Minimum trials required before IRT calibration will run. */
export const IRT_MIN_TRIALS = 30;

/** Minimum distinct bundles required for IRT calibration. */
export const IRT_MIN_BUNDLES = 5;

/** Maximum EM iterations before declaring non-convergence. */
export const EM_MAX_ITERATIONS = 200;

/** EM convergence tolerance: max absolute parameter change between iterations. */
export const EM_CONVERGENCE_EPSILON = 0.001;

/** Gauss-Hermite quadrature nodes for E-step. 21 is standard; 31 for slow convergence. */
export const EM_QUADRATURE_NODES = 21;

/** Fisher Information threshold below which a task is classified as "low_info". */
export const FISHER_LOW_INFO_THRESHOLD = 0.1;

/** Number of EM restarts with different initializations. */
export const EM_RESTARTS = 3;

/** Discrimination parameter lower bound. */
export const IRT_DISCRIMINATION_MIN = 0.2;

/** Discrimination parameter upper bound. */
export const IRT_DISCRIMINATION_MAX = 3.0;

/** Delta clamp range for boundary reparameterization (prevents exp() overflow). */
export const IRT_DELTA_CLAMP = 10;

/** Tikhonov regularization lambda for Hessian. */
export const IRT_HESSIAN_LAMBDA = 1e-6;

/** Armijo line search sufficient decrease constant. */
export const IRT_ARMIJO_C = 1e-4;

// --- Construction-Verification (cv-executor.ts) ---

/** Default weight for the construction phase in C-V scoring. */
export const CV_CONSTRUCTION_WEIGHT_DEFAULT = 0.3;

/** Default weight for the verification phase in C-V scoring. */
export const CV_VERIFICATION_WEIGHT_DEFAULT = 0.7;

// --- Composition collapse detection (composition.ts) ---

/** Primitive score floor above which collapse can be detected. */
export const COLLAPSE_PRIMITIVE_FLOOR = 0.6;

/** Composed score ceiling below which collapse is detected (when primitives above floor). */
export const COLLAPSE_COMPOSED_CEILING = 0.3;

// --- Token tax (verdict.ts) ---

/** Token count below which no penalty is applied. */
export const TOKEN_TAX_BASELINE = 800;

/** Maximum score penalty fraction (0–1). Score cannot be reduced below (1 - cap) × raw. */
export const TOKEN_TAX_CAP = 0.5;

/** Maximum token delta considered for efficiency scoring. */
export const TOKEN_COST_DELTA_MAX = 2000;

// --- Randomization (engine.ts) ---

/** Default seed for prompt template randomization. */
export const DEFAULT_RANDOMIZATION_SEED = 42;

// --- Batch runner (batch-runner.ts) ---

/** Maximum parallel batch runs (file system contention + LLM API rate limits). */
export const BATCH_MAX_PARALLEL = 8;

/** Default parallel batch runs. */
export const BATCH_DEFAULT_PARALLEL = 4;

/** Batch runs above this count require --confirm for real executors. */
export const BATCH_CONFIRM_THRESHOLD = 10;

/** Maximum number of runs allowed in a single batch. */
export const BATCH_MAX_RUNS = 500;
