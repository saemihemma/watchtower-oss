/**
 * IRT EM Calibrator for Watchtower Phase 9a.
 * Orchestrates the EM algorithm using pure math functions from irt-math.ts.
 * Handles initialization, convergence, model selection (GRM vs 2PL), and Fisher weight derivation.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import {
  logsumexp,
  gaussHermiteNodes,
  grmProbabilities,
  grmLogLikelihood,
  deltaToBoundaries,
  boundariesToDelta,
  jacobian,
  fisherInformation,
  fisherInformationIntegrated,
  grmGradient,
  grmHessian,
  type ItemEStepData,
} from "./irt-math.js";
import {
  EM_MAX_ITERATIONS,
  EM_CONVERGENCE_EPSILON,
  EM_RESTARTS,
  IRT_DISCRIMINATION_MIN,
  IRT_DISCRIMINATION_MAX,
  IRT_HESSIAN_LAMBDA,
  IRT_ARMIJO_C,
  FISHER_LOW_INFO_THRESHOLD,
} from "./constants.js";
import type {
  IRTCalibrationReport,
  IRTItemParams,
  IRTModelKind,
  IRTWeightOverride,
  BenchmarkTask,
} from "./schemas.js";

/** Data format for trial responses */
export type TrialDataset = {
  items: string[]; // task_ids
  responses: TrialResponse[];
};

export type TrialResponse = {
  bundleId: string;
  scores: Map<string, number>; // task_id → normalized score (0, 0.25, 0.5, 0.75, 1.0)
};

/** Seeded random number generator (mulberry32) */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert normalized score (0, 0.25, ..., 1.0) to category index (0, 1, 2, 3, 4) */
function scoreToCategory(score: number): number {
  return Math.round(score * 4);
}

/** Compute quantiles of observed scores for boundary initialization */
function quantilesOfScores(scores: number[], ps: number[]): number[] {
  const sorted = [...scores].sort((a, b) => a - b);
  return ps.map((p) => {
    const index = Math.floor(p * (sorted.length - 1));
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  });
}

interface RestartResult {
  restartIndex: number;
  itemParams: Map<string, ItemParams>;
  marginalLL: number;
  converged: boolean;
  iterations: number;
}

interface ItemParams {
  a: number;
  deltas: number[];
  model: "grm" | "2pl";
}

export function calibrateIRT(config: {
  trialData: TrialDataset;
  profileId: string;
  catalogHash: string;
  quadratureNodes?: 21 | 31;
  maxIterations?: number;
  epsilon?: number;
}): IRTCalibrationReport {
  const Q = config.quadratureNodes ?? 21;
  const maxIter = config.maxIterations ?? EM_MAX_ITERATIONS;
  const epsilon = config.epsilon ?? EM_CONVERGENCE_EPSILON;

  const { nodes, weights } = gaussHermiteNodes(Q);
  const itemIds = config.trialData.items;
  const responses = config.trialData.responses;

  // Aggregate trial data: map item_id → list of categories observed
  const itemCategoryResponses = new Map<string, number[]>();
  for (const item of itemIds) {
    itemCategoryResponses.set(item, []);
  }

  for (const resp of responses) {
    for (const item of itemIds) {
      const score = resp.scores.get(item) ?? 0;
      const category = scoreToCategory(score);
      itemCategoryResponses.get(item)!.push(category);
    }
  }

  // Check for sparse categories: >80% in one category → 2PL fallback
  const sparseItems = new Set<string>();
  for (const [item, categories] of itemCategoryResponses) {
    if (categories.length === 0) continue;
    const counts = Array(5).fill(0);
    for (const cat of categories) {
      counts[cat]++;
    }
    const maxCount = Math.max(...counts);
    if (maxCount / categories.length > 0.8) {
      sparseItems.add(item);
    }
  }

  // Run EM with multiple restarts
  const restarts: RestartResult[] = [];
  for (let r = 0; r < EM_RESTARTS; r++) {
    const seed = 42 + r;
    const rng = mulberry32(seed);

    // Initialize parameters per item
    const itemParams = new Map<string, ItemParams>();
    for (const item of itemIds) {
      const categories = itemCategoryResponses.get(item)!;
      const isSparse = sparseItems.has(item);
      const model = isSparse ? "2pl" : "grm";

      if (model === "2pl") {
        // 2PL: single boundary b
        const quantiles = quantilesOfScores(categories.map((c) => c / 4), [0.25, 0.75]);
        const b = (quantiles[0] + quantiles[1]) / 2;
        const a = 0.5 + rng() * 1.0; // [0.5, 1.5]
        itemParams.set(item, { a: Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, a)), deltas: [b], model: "2pl" });
      } else {
        // GRM: K=4 boundaries
        const quantiles = quantilesOfScores(categories.map((c) => c / 4), [0.2, 0.4, 0.6, 0.8]);
        const deltas = boundariesToDelta(quantiles);
        const a = 0.5 + 1.0 * [0.5, 1.0, 1.5][r]; // [0.5, 1.0, 1.5] per restart
        itemParams.set(item, { a: Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, a)), deltas, model: "grm" });
      }
    }

    // Run EM
    let converged = false;
    let bestMarginalLL = -Infinity;
    let bestItemParams = new Map(itemParams);
    let iteration = 0;

    for (iteration = 0; iteration < maxIter; iteration++) {
      // E-step: compute posterior weights and aggregated E-step data per item
      const eStepDataPerItem = new Map<string, ItemEStepData>();
      for (const item of itemIds) {
        eStepDataPerItem.set(item, {
          responseCounts: Array(Q)
            .fill(0)
            .map(() => Array(5).fill(0)),
          nodeWeights: Array(Q).fill(0),
        });
      }

      let marginalLL = 0;

      for (const resp of responses) {
        // Compute log-likelihood at each quadrature node
        const logLikelihoods: number[] = [];
        for (let q = 0; q < Q; q++) {
          const theta = nodes[q];
          let logL = 0;
          for (const item of itemIds) {
            const score = resp.scores.get(item) ?? 0;
            const category = scoreToCategory(score);
            const params = itemParams.get(item)!;
            const boundaries = params.model === "2pl" ? [params.deltas[0]] : deltaToBoundaries(params.deltas);
            logL += grmLogLikelihood(theta, params.a, boundaries, category);
          }
          logLikelihoods.push(logL);
        }

        // Normalize via logsumexp
        const logZ = logsumexp(logLikelihoods);
        marginalLL += logZ;

        if (!isFinite(logZ)) {
          // Degenerate case: all likelihoods -Infinity
          // Skip E-step aggregation for this person
          continue;
        }

        // Accumulate E-step data
        for (let q = 0; q < Q; q++) {
          const theta = nodes[q];
          const w = Math.exp(logLikelihoods[q] - logZ);

          for (const item of itemIds) {
            const score = resp.scores.get(item) ?? 0;
            const category = scoreToCategory(score);
            const params = itemParams.get(item)!;
            const boundaries = params.model === "2pl" ? [params.deltas[0]] : deltaToBoundaries(params.deltas);
            const eStepData = eStepDataPerItem.get(item)!;
            eStepData.responseCounts[q][category] += w;
            eStepData.nodeWeights[q] += w;
          }
        }
      }

      // Track best iteration
      if (marginalLL > bestMarginalLL) {
        bestMarginalLL = marginalLL;
        bestItemParams = new Map(itemParams);
      }

      // M-step: Newton-Raphson for each item
      const oldParams = new Map(itemParams);
      let anySkipped = 0;

      for (const item of itemIds) {
        const params = itemParams.get(item)!;
        const eStepData = eStepDataPerItem.get(item)!;
        const isGRM = params.model === "grm";

        if (!isGRM) {
          // 2PL: simplified M-step (just update b and a)
          // Treat as GRM with K=1 boundary (one delta parameter)
          const grad = grmGradient(params.a, params.deltas, eStepData, nodes);
          const hess = grmHessian(params.a, params.deltas, eStepData, nodes);

          // Try Newton step
          if (!tryNewtonStep(params, grad, hess, eStepData, nodes, item, true)) {
            anySkipped++;
          }
        } else {
          // GRM: standard M-step
          const grad = grmGradient(params.a, params.deltas, eStepData, nodes);
          const hess = grmHessian(params.a, params.deltas, eStepData, nodes);

          if (!tryNewtonStep(params, grad, hess, eStepData, nodes, item, false)) {
            anySkipped++;
          }
        }
      }

      // Check convergence
      let maxChange = 0;
      for (const item of itemIds) {
        const oldParam = oldParams.get(item)!;
        const newParam = itemParams.get(item)!;
        maxChange = Math.max(maxChange, Math.abs(newParam.a - oldParam.a));
        for (let i = 0; i < newParam.deltas.length; i++) {
          maxChange = Math.max(maxChange, Math.abs(newParam.deltas[i] - oldParam.deltas[i]));
        }
      }

      if (maxChange < epsilon) {
        converged = true;
        break;
      }
    }

    restarts.push({
      restartIndex: r,
      itemParams: bestItemParams,
      marginalLL: bestMarginalLL,
      converged,
      iterations: iteration + 1,
    });
  }

  // Select best restart by marginal LL
  const bestRestart = restarts.reduce((best, curr) => (curr.marginalLL > best.marginalLL ? curr : best));

  // Model selection: GRM vs 2PL via AIC
  const selectedModel = selectModel(itemIds, itemCategoryResponses, bestRestart.itemParams);

  // Compute Fisher Information and weights
  const itemParamsArray: IRTItemParams[] = [];
  const fisherInfos: number[] = [];

  for (const item of itemIds) {
    const params = bestRestart.itemParams.get(item)!;
    const categories = itemCategoryResponses.get(item)!;
    const boundaries = params.model === "2pl" ? [params.deltas[0]] : deltaToBoundaries(params.deltas);

    const fisherAtMean = fisherInformation(0, params.a, boundaries);
    const fisherIntegrated = fisherInformationIntegrated(params.a, boundaries, nodes, weights);

    fisherInfos.push(fisherIntegrated);

    const responseDistribution = Array(5).fill(0);
    for (const cat of categories) {
      responseDistribution[cat]++;
    }
    const total = responseDistribution.reduce((a, b) => a + b, 1);
    for (let i = 0; i < 5; i++) {
      responseDistribution[i] /= total;
    }

    itemParamsArray.push({
      task_id: item,
      model: selectedModel,
      discrimination: params.a,
      boundaries,
      fisher_info_at_mean: fisherAtMean,
      fisher_info_integrated: fisherIntegrated,
      calibration_n: categories.length,
      fit_residual: 0, // Placeholder
      response_distribution: responseDistribution,
    });
  }

  // Compute mean ability and std (from quadrature)
  const abilityMean = 0; // Gauss-Hermite centered at 0
  const abilityStd = 1;

  // Build report
  const calibrationId = randomUUID();
  const timestamp = new Date().toISOString();

  const report: IRTCalibrationReport = {
    version: 1,
    calibration_id: calibrationId,
    profile_id: config.profileId,
    catalog_hash: config.catalogHash,
    schema_version: 4,
    model_selected: selectedModel,
    model_selection_aic: { grm: 0, twopl: 0 }, // Placeholder
    item_params: itemParamsArray,
    mean_ability: abilityMean,
    ability_std: abilityStd,
    total_trials_used: responses.length,
    total_bundles: new Set(responses.map((r) => r.bundleId)).size,
    convergence_iterations: bestRestart.iterations,
    converged: bestRestart.converged,
    n_restarts: EM_RESTARTS,
    best_restart_index: bestRestart.restartIndex,
    marginal_log_likelihood: bestRestart.marginalLL,
    timestamp,
  };

  return report;
}

/** Attempt Newton-Raphson step with Armijo line search and regularization */
function tryNewtonStep(
  params: ItemParams,
  grad: number[],
  hess: number[][],
  eStepData: ItemEStepData,
  nodes: number[],
  itemId: string,
  is2PL: boolean
): boolean {
  // Try to invert Hessian via Cholesky (negative-definite check)
  try {
    const negH = hess.map((row) => row.map((v) => -v));
    const L = choleskyFactorization(negH);

    // Solve L * L^T * d = grad → d = Newton direction
    const d = solveCholesky(L, grad);

    // Armijo backtracking line search
    let alpha = 1.0;
    const oldParams = { ...params };
    const oldA = params.a;
    const oldDeltas = [...params.deltas];

    for (let iter = 0; iter < 50; iter++) {
      const newA = Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, oldA - alpha * d[0]));
      const newDeltas = oldDeltas.map((delta, i) => delta - alpha * d[i + 1]);

      // Evaluate log-likelihood at new point
      const newBoundaries = params.model === "2pl" ? [newDeltas[0]] : deltaToBoundaries(newDeltas);
      const llNew = computeLogLikelihood(newA, newBoundaries, eStepData, nodes, is2PL ? 1 : 4);
      const llOld = computeLogLikelihood(oldA, params.model === "2pl" ? [params.deltas[0]] : deltaToBoundaries(params.deltas), eStepData, nodes, is2PL ? 1 : 4);

      if (llNew > llOld + IRT_ARMIJO_C * alpha * dotProduct(grad, d)) {
        params.a = newA;
        params.deltas = newDeltas;
        return true;
      }

      alpha *= 0.5;
    }

    // Fallback: if no sufficient decrease, take small step anyway
    params.a = Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, oldA - 0.01 * d[0]));
    params.deltas = oldDeltas.map((delta, i) => delta - 0.01 * d[i + 1]);
    return true;
  } catch (e) {
    // Cholesky failed: try regularization
    try {
      const negH = hess.map((row) => row.map((v) => -v));
      const regH = negH.map((row, i) => row.map((v, j) => (i === j ? v + IRT_HESSIAN_LAMBDA : v)));
      const L = choleskyFactorization(regH);
      const d = solveCholesky(L, grad);

      // Same line search with regularized direction
      let alpha = 1.0;
      const oldA = params.a;
      const oldDeltas = [...params.deltas];

      for (let iter = 0; iter < 50; iter++) {
        const newA = Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, oldA - alpha * d[0]));
        const newDeltas = oldDeltas.map((delta, i) => delta - alpha * d[i + 1]);

        const newBoundaries = params.model === "2pl" ? [newDeltas[0]] : deltaToBoundaries(newDeltas);
        const llNew = computeLogLikelihood(newA, newBoundaries, eStepData, nodes, is2PL ? 1 : 4);
        const llOld = computeLogLikelihood(oldA, params.model === "2pl" ? [params.deltas[0]] : deltaToBoundaries(params.deltas), eStepData, nodes, is2PL ? 1 : 4);

        if (llNew > llOld + IRT_ARMIJO_C * alpha * dotProduct(grad, d)) {
          params.a = newA;
          params.deltas = newDeltas;
          return true;
        }

        alpha *= 0.5;
      }

      params.a = Math.max(IRT_DISCRIMINATION_MIN, Math.min(IRT_DISCRIMINATION_MAX, oldA - 0.01 * d[0]));
      params.deltas = oldDeltas.map((delta, i) => delta - 0.01 * d[i + 1]);
      return true;
    } catch (e2) {
      // Still singular: skip Newton step
      console.warn(`[watchtower/irt] Hessian singular for item ${itemId}, skipping Newton step.`);
      return false;
    }
  }
}

/** Compute log-likelihood for current parameters */
function computeLogLikelihood(a: number, boundaries: number[], eStepData: ItemEStepData, nodes: number[], K: number): number {
  let ll = 0;
  const Q = nodes.length;

  for (let q = 0; q < Q; q++) {
    const theta = nodes[q];
    const probs = grmProbabilities(theta, a, boundaries);

    for (let k = 0; k <= K; k++) {
      const count = eStepData.responseCounts[q][k];
      if (count > 0 && probs[k] > 0) {
        ll += count * Math.log(probs[k]);
      }
    }
  }

  return ll;
}

/** Simple Cholesky factorization for positive-definite matrix */
function choleskyFactorization(A: number[][]): number[][] {
  const n = A.length;
  const L = Array(n)
    .fill(0)
    .map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) {
        sum -= L[i][k] * L[j][k];
      }

      if (i === j) {
        if (sum <= 0) throw new Error("Matrix not positive definite");
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }

  return L;
}

/** Solve L*L^T*x = b using forward/backward substitution */
function solveCholesky(L: number[][], b: number[]): number[] {
  const n = L.length;

  // Forward substitution: L*y = b
  const y = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let j = 0; j < i; j++) {
      sum -= L[i][j] * y[j];
    }
    y[i] = sum / L[i][i];
  }

  // Backward substitution: L^T*x = y
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let j = i + 1; j < n; j++) {
      sum -= L[j][i] * x[j];
    }
    x[i] = sum / L[i][i];
  }

  return x;
}

/** Dot product of two vectors */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Select between GRM and 2PL via AIC */
function selectModel(itemIds: string[], itemCategoryResponses: Map<string, number[]>, itemParams: Map<string, ItemParams>): IRTModelKind {
  // For now, default to GRM (can be enhanced with actual AIC computation)
  return "grm";
}

/**
 * Convert BatchOutput.runs into TrialResponse[] for IRT calibration.
 * Each (runId, sideId) pair becomes one respondent.
 * Only valid trials with non-null scores are included.
 *
 * @returns { responses, validCount, taskIds } for minimum-data validation.
 */
export function batchTrialsToDataset(
  runs: ReadonlyArray<{
    runId: string;
    taskTrialResults: ReadonlyArray<{
      task_id: string;
      side_id: string;
      normalized_score: number | null;
      status: string;
    }>;
  }>
): { responses: TrialResponse[]; validCount: number; taskIds: string[] } {
  const responses: TrialResponse[] = [];
  const allTaskIds = new Set<string>();
  let validCount = 0;

  for (const run of runs) {
    // Group this run's valid trials by side
    const bySide = new Map<string, Map<string, number>>();

    for (const trial of run.taskTrialResults) {
      if (trial.status !== "valid" || trial.normalized_score === null) continue;
      validCount++;
      allTaskIds.add(trial.task_id);

      if (!bySide.has(trial.side_id)) {
        bySide.set(trial.side_id, new Map());
      }
      bySide.get(trial.side_id)!.set(trial.task_id, trial.normalized_score);
    }

    // Each side of this run = one respondent
    for (const [sideId, scores] of bySide) {
      responses.push({
        bundleId: `${run.runId}:${sideId}`,
        scores
      });
    }
  }

  return {
    responses,
    validCount,
    taskIds: [...allTaskIds]
  };
}

export function deriveWeightsFromCalibration(report: IRTCalibrationReport, tasks: BenchmarkTask[]): IRTWeightOverride[] {
  const taskMap = new Map(tasks.map((t) => [t.task_id, t]));
  const fisherMax = Math.max(...report.item_params.map((p) => p.fisher_info_integrated), 0.1);

  const weights: IRTWeightOverride[] = [];

  for (const param of report.item_params) {
    const task = taskMap.get(param.task_id);
    if (!task) {
      console.warn(`[watchtower/irt] Task ${param.task_id} not in profile.`);
      continue;
    }

    const normalizedFisher = param.fisher_info_integrated / fisherMax;
    const reason = normalizedFisher < FISHER_LOW_INFO_THRESHOLD ? "low_info" : "high_info";

    weights.push({
      task_id: param.task_id,
      irt_weight: normalizedFisher,
      original_weight: 1.0,
      reason,
    });
  }

  return weights;
}

export function writeCalibrationReport(report: IRTCalibrationReport, outputDir: string): string {
  const dateStr = report.timestamp.split("T")[0];
  const filename = `${report.profile_id}-${dateStr}.json`;
  const filePath = path.join(outputDir, filename);
  const tmpPath = filePath + ".tmp";

  writeFileSync(tmpPath, JSON.stringify(report, null, 2), "utf-8");
  renameSync(tmpPath, filePath);

  return filePath;
}

export function loadCalibrationReport(filePath: string): IRTCalibrationReport {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Cannot read IRT calibration file: ${filePath}. Ensure it was created by 'watchtower calibrate'.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`IRT calibration file is not valid JSON: ${filePath}`);
  }

  const report = parsed as IRTCalibrationReport;
  if (!report.calibration_id || !report.profile_id || !Array.isArray(report.item_params)) {
    throw new Error(`IRT calibration file has invalid structure: ${filePath}. Missing required fields.`);
  }

  return report;
}
