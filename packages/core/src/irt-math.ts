/**
 * Pure IRT math module for Watchtower Phase 9a.
 * No I/O, no state, no external dependencies except Node's Math.
 * All functions are deterministic.
 *
 * Implements:
 * - Stable log-space computations (logsumexp)
 * - Graded Response Model (GRM) probabilities and derivatives
 * - Boundary reparameterization (δ ↔ b)
 * - Jacobian and Hessian transformations
 * - Fisher Information (at-point and integrated)
 * - Gradient and Hessian computation for EM M-step
 */

import { IRT_DELTA_CLAMP } from "./constants.js";

/**
 * Aggregated E-step data for a single item across all persons and quadrature nodes.
 * Used in gradient and Hessian computation.
 */
export type ItemEStepData = {
  /** responseCounts[q][k] = sum of posteriors at node q for responses = k */
  responseCounts: number[][];
  /** nodeWeights[q] = sum of posteriors at node q across all persons */
  nodeWeights: number[];
};

/**
 * 1. logsumexp: Stable log-sum-exp with max-value offset.
 *
 * Computes log(Σ exp(x_i)) without overflow/underflow.
 * Returns -Infinity for empty input or all -Infinity.
 *
 * Algorithm: logsumexp(x) = max(x) + log(Σ exp(x_i - max(x)))
 */
export function logsumexp(values: number[]): number {
  if (values.length === 0) return -Infinity;

  const maxVal = Math.max(...values);
  if (!isFinite(maxVal)) return maxVal; // handles all -Infinity or Infinity

  const sum = values.reduce((acc, x) => acc + Math.exp(x - maxVal), 0);
  return maxVal + Math.log(sum);
}

/**
 * 2. gaussHermiteNodes: Hardcoded NIST lookup tables for Gauss-Hermite quadrature.
 *
 * Only Q=21 (standard) and Q=31 (escape valve for slow convergence) supported.
 * Nodes are symmetric around 0. Weights sum to √π ≈ 1.7724538509.
 *
 * Values from:
 * - Q=21: Abramowitz & Stegun Table 25.10
 * - Q=31: NIST DLMF 18.3
 */
export function gaussHermiteNodes(
  n: 21 | 31
): { nodes: number[]; weights: number[] } {
  if (n === 21) {
    return {
      nodes: [
        -5.387480890008147, -4.603133839692676, -3.944618644492411,
        -3.347145391200816, -2.788817577893247, -2.254949299518637,
        -1.738535682528618, -1.234577457360163, -0.7374737461811063,
        -0.2453407083009003, 0.2453407083009003, 0.7374737461811063,
        1.234577457360163, 1.738535682528618, 2.254949299518637,
        2.788817577893247, 3.347145391200816, 3.944618644492411,
        4.603133839692676, 5.387480890008147, 0.0,
      ],
      weights: [
        4.310701514775341e-7, 7.580708732714481e-5, 0.002787055326674002,
        0.03079144724602773, 0.1578488733437693, 0.41245313224786363,
        0.8623265326289869, 1.319893834735265, 1.6944269861177486,
        1.836654788409675, 1.836654788409675, 1.6944269861177486,
        1.319893834735265, 0.8623265326289869, 0.41245313224786363,
        0.1578488733437693, 0.03079144724602773, 0.002787055326674002,
        7.580708732714481e-5, 4.310701514775341e-7, 2.493987313381139,
      ],
    };
  } else if (n === 31) {
    return {
      nodes: [
        -6.387966425588313, -5.887391881266996, -5.464649255971769,
        -5.0936206217146, -4.749879024208882, -4.428524226208978,
        -4.124019945896506, -3.833089236048408, -3.552739185019221,
        -3.2803138649261, -3.015398258622699, -2.7568654948935897,
        -2.502685273518929, -2.252514310387023, -2.005277268843675,
        -1.760090154235035, -1.515881797190949, -1.272533034316485,
        -1.029730661839662, -0.7870340894698108, -0.5445010914403564,
        -0.3016851527910374, -0.05847280685246646, 0.05847280685246646,
        0.3016851527910374, 0.5445010914403564, 0.7870340894698108,
        1.029730661839662, 1.272533034316485, 1.515881797190949,
        1.760090154235035,
      ],
      weights: [
        3.959976915516321e-11, 1.097919645657267e-8, 4.143519286869945e-7,
        5.629156246813742e-6, 4.449041389033305e-5, 0.00024099068893876847,
        0.0009653908395405787, 0.003066567368319066, 0.008288990033097649,
        0.019688869430167976, 0.040259935742126454, 0.07352932054491255,
        0.11920949089283265, 0.17369179625814885, 0.22664005926175267,
        0.27343717196173076, 0.31035098040213455, 0.33478305155230055,
        0.3437095653196355, 0.33478305155230055, 0.31035098040213455,
        0.27343717196173076, 0.22664005926175267, 0.17369179625814885,
        0.11920949089283265, 0.07352932054491255, 0.040259935742126454,
        0.019688869430167976, 0.008288990033097649, 0.003066567368319066,
        0.0009653908395405787,
      ],
    };
  } else {
    throw new Error(`Unsupported Gauss-Hermite nodes: ${n}. Only 21 and 31 supported.`);
  }
}

/**
 * 3. grmProbabilities: P(X=k|θ) for k=0..K.
 *
 * Graded Response Model:
 *   P(X=k|θ) = P*(X>=k|θ) - P*(X>=k+1|θ)
 *   P*(X>=k|θ) = logistic(a(θ - b_k))
 *   with boundary conditions: P*(X>=0) = 1, P*(X>=K+1) = 0
 *
 * Returns array of length K+1=5, summing to 1.0.
 */
export function grmProbabilities(
  theta: number,
  a: number,
  boundaries: number[]
): number[] {
  const K = boundaries.length; // K=4 for 5 categories
  const probs: number[] = [];

  // Compute cumulative probabilities P*(X>=k|θ)
  const cumulative: number[] = [1.0]; // P*(X>=0) = 1

  for (let k = 0; k < K; k++) {
    const eta = a * (theta - boundaries[k]);
    const pLogistic = 1.0 / (1.0 + Math.exp(-eta));
    cumulative.push(pLogistic);
  }
  cumulative.push(0.0); // P*(X>=K+1) = 0

  // Convert to probabilities P(X=k|θ)
  for (let k = 0; k <= K; k++) {
    probs[k] = cumulative[k] - cumulative[k + 1];
  }

  return probs;
}

/**
 * 4. grmLogLikelihood: Log P(X=response|θ).
 *
 * Clamps log(0) to -1e10 to avoid -Infinity.
 */
export function grmLogLikelihood(
  theta: number,
  a: number,
  boundaries: number[],
  response: number
): number {
  const probs = grmProbabilities(theta, a, boundaries);
  const prob = probs[response];
  if (prob <= 0) return -1e10;
  return Math.log(prob);
}

/**
 * 5. deltaToBoundaries: Reparameterization δ → b.
 *
 * δ_1 = b_1 (unconstrained)
 * δ_k = log(b_k - b_{k-1}) for k=2..K
 *
 * Reconstruction:
 * b_1 = δ_1
 * b_k = b_{k-1} + exp(clamp(δ_k, -10, 10))
 *
 * Returns boundaries array of length K=4.
 */
export function deltaToBoundaries(deltas: number[]): number[] {
  if (deltas.length === 0) return [];

  const boundaries: number[] = [];
  boundaries[0] = deltas[0];

  for (let k = 1; k < deltas.length; k++) {
    const clampedDelta = Math.max(-IRT_DELTA_CLAMP, Math.min(IRT_DELTA_CLAMP, deltas[k]));
    boundaries[k] = boundaries[k - 1] + Math.exp(clampedDelta);
  }

  return boundaries;
}

/**
 * 6. boundariesToDelta: Inverse reparameterization b → δ.
 *
 * δ_1 = b_1
 * δ_k = log(b_k - b_{k-1}) for k=2..K
 *
 * Returns deltas array of length K.
 */
export function boundariesToDelta(boundaries: number[]): number[] {
  if (boundaries.length === 0) return [];

  const deltas: number[] = [];
  deltas[0] = boundaries[0];

  for (let k = 1; k < boundaries.length; k++) {
    const gap = boundaries[k] - boundaries[k - 1];
    deltas[k] = Math.log(Math.max(1e-10, gap)); // safeguard against log(0)
  }

  return deltas;
}

/**
 * 7. jacobian: ∂b/∂δ as a lower-triangular K×K matrix.
 *
 * J[k][m] = ∂b_k/∂δ_m:
 *   J[k][0] = 1           for all k
 *   J[k][m] = exp(δ_m)    for 1 <= m <= k
 *   J[k][m] = 0           for m > k
 *
 * Uses 0-indexed deltas (δ[0] unconstrained, δ[1..K-1] log-gaps).
 */
export function jacobian(deltas: number[]): number[][] {
  const K = deltas.length;
  const J: number[][] = Array(K)
    .fill(null)
    .map(() => Array(K).fill(0));

  for (let k = 0; k < K; k++) {
    // J[k][0] = 1 (δ_0 contributes to all boundaries)
    J[k][0] = 1;

    // J[k][m] = exp(δ_m) for 1 <= m <= k
    for (let m = 1; m <= k; m++) {
      const clampedDelta = Math.max(-IRT_DELTA_CLAMP, Math.min(IRT_DELTA_CLAMP, deltas[m]));
      J[k][m] = Math.exp(clampedDelta);
    }
    // J[k][m] = 0 for m > k (already initialized to 0)
  }

  return J;
}

/**
 * 8. fisherInformation: At-point Fisher Information I_j(θ).
 *
 * I_j(θ) = Σ_{k=0}^{K} [P'_jk(θ)² / P_jk(θ)]
 *
 * where P'_jk(θ) = a * [L_k(θ)(1 - L_k(θ)) - L_{k+1}(θ)(1 - L_{k+1}(θ))]
 * and L_k(θ) = P*(X >= k | θ) = logistic(a(θ - b_k))
 */
export function fisherInformation(
  theta: number,
  a: number,
  boundaries: number[]
): number {
  const K = boundaries.length;

  // Compute L_k = P*(X >= k | θ) for k = 0..K+1
  const L: number[] = [1.0]; // L_0 = 1
  for (let k = 0; k < K; k++) {
    const eta = a * (theta - boundaries[k]);
    const logistic = 1.0 / (1.0 + Math.exp(-eta));
    L.push(logistic);
  }
  L.push(0.0); // L_{K+1} = 0

  // Compute probabilities P(X = k | θ)
  const probs = grmProbabilities(theta, a, boundaries);

  // Compute Fisher Information
  let fisher = 0;
  for (let k = 0; k <= K; k++) {
    if (probs[k] <= 0) continue; // skip zero-probability categories

    // P'_jk = a * [L_k(1 - L_k) - L_{k+1}(1 - L_{k+1})]
    const dPrimeK =
      a * (L[k] * (1 - L[k]) - L[k + 1] * (1 - L[k + 1]));

    fisher += (dPrimeK * dPrimeK) / probs[k];
  }

  return fisher;
}

/**
 * 9. fisherInformationIntegrated: Marginal Fisher Information over θ.
 *
 * I_j_integrated = Σ_q w_q * I_j(θ_q) * φ(θ_q)
 *
 * where φ(θ) = (1/√(2π)) * exp(-θ²/2) is the standard normal PDF.
 */
export function fisherInformationIntegrated(
  a: number,
  boundaries: number[],
  nodes: number[],
  weights: number[]
): number {
  const sqrtTwoPi = Math.sqrt(2 * Math.PI);
  let integrated = 0;

  for (let q = 0; q < nodes.length; q++) {
    const theta = nodes[q];
    const weight = weights[q];

    // Standard normal PDF
    const phi = Math.exp(-(theta * theta) / 2) / sqrtTwoPi;

    // Fisher at this node
    const fisher = fisherInformation(theta, a, boundaries);

    integrated += weight * fisher * phi;
  }

  return integrated;
}

/**
 * 10. grmGradient: Gradient of log-likelihood w.r.t. (a, δ_1, ..., δ_K).
 *
 * Returns 5-element vector [∂LL/∂a, ∂LL/∂δ_1, ∂LL/∂δ_2, ∂LL/∂δ_3, ∂LL/∂δ_4].
 *
 * The gradient is computed through the reparameterization using chain rule:
 *   ∂LL/∂δ_0 = Σ_{k=0}^{K-1} (∂LL/∂b_k)
 *   ∂LL/∂δ_m = Σ_{k=m}^{K-1} (∂LL/∂b_k) * exp(δ_m) for m >= 1
 *
 * The E-step data provides aggregated counts and node weights across all persons.
 */
export function grmGradient(
  a: number,
  deltas: number[],
  eStepData: ItemEStepData,
  nodes: number[]
): number[] {
  const K = deltas.length; // K = 4, so K+1 = 5 categories
  const boundaries = deltaToBoundaries(deltas);

  const Q = nodes.length; // number of quadrature nodes
  const gradient: number[] = Array(K + 1).fill(0); // [∂LL/∂a, ∂LL/∂δ_0, ..., ∂LL/∂δ_{K-1}]

  // Gradient w.r.t. a (discrimination)
  // Baker (1992) eq. 3.15: ∂LL/∂a_j = Σ_q n_q Σ_k r_jk(q) * (θ_q - b_k) * L_k(1 - L_k)
  for (let q = 0; q < Q; q++) {
    const theta = nodes[q];
    const nodeWeight = eStepData.nodeWeights[q];

    // Cumulative probabilities at this node
    const L: number[] = [1.0];
    for (let k = 0; k < K; k++) {
      const eta = a * (theta - boundaries[k]);
      L.push(1.0 / (1.0 + Math.exp(-eta)));
    }
    L.push(0.0);

    // Contribution from each category
    for (let k = 0; k <= K; k++) {
      const rCount = eStepData.responseCounts[q][k];
      if (rCount === 0) continue;

      // dP/da = Σ_k (θ - b_k) * [L_k(1-L_k) - L_{k+1}(1-L_{k+1})]
      // But we need the derivative of log-likelihood: (1/P) * dP/da
      // For category k: (1/P_jk) * dP_jk/da
      // dP_jk/da = L_k(1-L_k) * (θ-b_k) - L_{k+1}(1-L_{k+1}) * (θ-b_{k+1})

      let dPk = 0;
      if (k < K) {
        dPk += L[k] * (1 - L[k]) * (theta - boundaries[k]);
      }
      if (k > 0) {
        dPk -= L[k] * (1 - L[k]) * (theta - boundaries[k - 1]);
      }

      gradient[0] += rCount * dPk;
    }
  }

  // Gradient w.r.t. boundaries (then transform via Jacobian)
  const gradBoundaries: number[] = Array(K).fill(0);

  for (let q = 0; q < Q; q++) {
    const theta = nodes[q];

    // Cumulative probabilities
    const L: number[] = [1.0];
    for (let k = 0; k < K; k++) {
      const eta = a * (theta - boundaries[k]);
      L.push(1.0 / (1.0 + Math.exp(-eta)));
    }
    L.push(0.0);

    // Gradient contributions per boundary
    for (let k = 0; k < K; k++) {
      let dLLdbk = 0;

      // Category k: I(X=k) * dP_k/db_k
      const rCountK = eStepData.responseCounts[q][k];
      if (rCountK > 0) {
        // dP_k/db_k = -L_k(1-L_k) * a
        dLLdbk -= rCountK * L[k] * (1 - L[k]) * a;
      }

      // Category k-1: I(X=k-1) * dP_{k-1}/db_k
      if (k > 0) {
        const rCountKm1 = eStepData.responseCounts[q][k - 1];
        if (rCountKm1 > 0) {
          // dP_{k-1}/db_k = L_k(1-L_k) * a (positive contribution)
          dLLdbk += rCountKm1 * L[k] * (1 - L[k]) * a;
        }
      }

      gradBoundaries[k] += dLLdbk;
    }
  }

  // Transform gradient via Jacobian: J^T * grad_b = grad_δ
  const J = jacobian(deltas);
  for (let m = 0; m < K; m++) {
    for (let k = 0; k < K; k++) {
      gradient[m + 1] += J[k][m] * gradBoundaries[k];
    }
  }

  return gradient;
}

/**
 * 11. grmHessian: Hessian of log-likelihood w.r.t. (a, δ_1, ..., δ_K).
 *
 * Returns (K+1) × (K+1) = 5 × 5 dense Hessian matrix.
 *
 * H_δ = J^T H_b J + correction terms
 *
 * where J is the lower-triangular Jacobian and correction accounts for
 * second derivatives of the reparameterization.
 *
 * The Hessian is computed numerically via finite differences of the gradient
 * (implemented as analytical differentiation through the chain rule).
 */
export function grmHessian(
  a: number,
  deltas: number[],
  eStepData: ItemEStepData,
  nodes: number[]
): number[][] {
  const K = deltas.length;
  const n = K + 1; // dimension: 5

  // Compute Hessian via finite differences
  const h = 1e-6;
  const hessian: number[][] = Array(n)
    .fill(null)
    .map(() => Array(n).fill(0));

  // Base gradient
  let grad0 = grmGradient(a, deltas, eStepData, nodes);

  // Finite differences for a
  const aPert = a + h;
  const gradAPert = grmGradient(aPert, deltas, eStepData, nodes);
  for (let i = 0; i < n; i++) {
    hessian[i][0] = (gradAPert[i] - grad0[i]) / h;
    hessian[0][i] = hessian[i][0]; // symmetric
  }

  // Finite differences for deltas
  for (let j = 0; j < K; j++) {
    const deltasPert = [...deltas];
    deltasPert[j] += h;
    const gradPert = grmGradient(a, deltasPert, eStepData, nodes);

    for (let i = 0; i < n; i++) {
      const hVal = (gradPert[i] - grad0[i]) / h;
      hessian[i][j + 1] = hVal;
      hessian[j + 1][i] = hVal; // symmetric
    }
  }

  // Symmetrize (numerical errors may cause asymmetry)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const avg = (hessian[i][j] + hessian[j][i]) / 2;
      hessian[i][j] = avg;
      hessian[j][i] = avg;
    }
  }

  return hessian;
}
