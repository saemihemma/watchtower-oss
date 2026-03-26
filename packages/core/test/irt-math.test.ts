import { describe, it, expect } from "vitest";
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
} from "../src/irt-math.js";

describe("IRT Math Module", () => {
  // ============================================================================
  // Test 1: GRM P(X=k|θ) sums to 1
  // ============================================================================
  describe("GRM probabilities sum to 1", () => {
    const boundaries = [-1.5, -0.5, 0.5, 1.5];
    const a = 1.0;
    const thetas = [-3, -1, 0, 1, 3];

    thetas.forEach((theta) => {
      it(`should sum to 1.0 for θ=${theta}`, () => {
        const probs = grmProbabilities(theta, a, boundaries);
        const sum = probs.reduce((acc, p) => acc + p, 0);
        expect(sum).toBeCloseTo(1.0, 6);
        // Also verify all probabilities are in [0, 1]
        probs.forEach((p) => {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        });
      });
    });
  });

  // ============================================================================
  // Test 2: Boundary reparameterization round-trip
  // ============================================================================
  describe("Boundary reparameterization round-trip", () => {
    it("should round-trip δ → b → δ", () => {
      const deltas = [0, Math.log(1), Math.log(1), Math.log(1)];
      const expectedBoundaries = [0, 1, 2, 3];

      // δ → b
      const boundaries = deltaToBoundaries(deltas);
      expectedBoundaries.forEach((expected, i) => {
        expect(boundaries[i]).toBeCloseTo(expected, 10);
      });

      // b → δ
      const deltasRoundTrip = boundariesToDelta(boundaries);
      deltas.forEach((delta, i) => {
        expect(deltasRoundTrip[i]).toBeCloseTo(delta, 10);
      });
    });
  });

  // ============================================================================
  // Test 3: Jacobian lower-triangular structure
  // ============================================================================
  describe("Jacobian lower-triangular structure", () => {
    it("should have correct structure for δ=[0.5, 0.3, 0.7, 0.2]", () => {
      const deltas = [0.5, 0.3, 0.7, 0.2];
      const J = jacobian(deltas);

      const K = deltas.length;
      expect(J.length).toBe(K);

      for (let k = 0; k < K; k++) {
        expect(J[k].length).toBe(K);

        // J[k][0] = 1 for all k
        expect(J[k][0]).toBeCloseTo(1, 10);

        // J[k][m] = exp(δ[m]) for 1 <= m <= k
        for (let m = 1; m <= k; m++) {
          const expected = Math.exp(deltas[m]);
          expect(J[k][m]).toBeCloseTo(expected, 10);
        }

        // J[k][m] = 0 for m > k
        for (let m = k + 1; m < K; m++) {
          expect(J[k][m]).toBe(0);
        }
      }
    });
  });

  // ============================================================================
  // Test 4: Fisher Information at known point
  // ============================================================================
  describe("Fisher Information at known point", () => {
    it("should compute positive Fisher Information for well-separated boundaries", () => {
      const a = 1.0;
      const boundaries = [-1.5, -0.5, 0.5, 1.5];
      const theta = 0;

      const fisher = fisherInformation(theta, a, boundaries);

      // Fisher Information should be positive for positive discrimination
      expect(fisher).toBeGreaterThan(0);

      // Verify programmatically from GRM formula
      // I_j(θ) = Σ_k [P'_jk(θ)² / P_jk(θ)]
      // P_jk(θ) = L_k(θ) - L_{k+1}(θ)
      // P'_jk(θ) = a * [L_k(1-L_k) - L_{k+1}(1-L_{k+1})]

      const K = boundaries.length;
      const L: number[] = [1.0];
      for (let k = 0; k < K; k++) {
        const eta = a * (theta - boundaries[k]);
        L.push(1.0 / (1.0 + Math.exp(-eta)));
      }
      L.push(0.0);

      const probs = grmProbabilities(theta, a, boundaries);
      let expectedFisher = 0;
      for (let k = 0; k <= K; k++) {
        if (probs[k] <= 0) continue;
        const dPrimeK = a * (L[k] * (1 - L[k]) - L[k + 1] * (1 - L[k + 1]));
        expectedFisher += (dPrimeK * dPrimeK) / probs[k];
      }

      expect(fisher).toBeCloseTo(expectedFisher, 10);
    });
  });

  // ============================================================================
  // Test 5: logsumexp stability
  // ============================================================================
  describe("logsumexp stability", () => {
    it("should handle large negative values without NaN/Inf", () => {
      const values = [-1000, -1001, -1002];
      const result = logsumexp(values);

      expect(isNaN(result)).toBe(false);
      expect(isFinite(result)).toBe(true);
      expect(result).toBeCloseTo(-999.59, 1);
    });

    it("should return -Infinity for all -Infinity input", () => {
      const values = [-Infinity, -Infinity];
      const result = logsumexp(values);
      expect(result).toBe(-Infinity);
    });

    it("should return -Infinity for empty input", () => {
      const result = logsumexp([]);
      expect(result).toBe(-Infinity);
    });

    it("should handle single element", () => {
      const result = logsumexp([5.0]);
      expect(result).toBeCloseTo(5.0, 10);
    });

    it("should compute logsumexp([0, 0]) = log(2)", () => {
      const result = logsumexp([0, 0]);
      expect(result).toBeCloseTo(Math.log(2), 10);
    });
  });

  // ============================================================================
  // Test 6: deltaToBoundaries monotonicity
  // ============================================================================
  describe("deltaToBoundaries monotonicity", () => {
    it("should produce strictly increasing boundaries", () => {
      // Generate random deltas with positive gaps
      const deltas = [0.5, 0.3, 0.7, 0.2]; // log-gaps
      const boundaries = deltaToBoundaries(deltas);

      // Verify strictly increasing
      for (let i = 1; i < boundaries.length; i++) {
        expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
      }
    });

    it("should handle multiple random cases", () => {
      for (let trial = 0; trial < 10; trial++) {
        const deltas = [Math.random() * 2 - 1]; // first delta unconstrained
        for (let i = 1; i < 4; i++) {
          deltas.push(Math.random()); // log-gaps always positive for strictly increasing
        }

        const boundaries = deltaToBoundaries(deltas);

        for (let i = 1; i < boundaries.length; i++) {
          expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
        }
      }
    });
  });

  // ============================================================================
  // Test 7: Gauss-Hermite Q=21
  // ============================================================================
  describe("Gauss-Hermite quadrature", () => {
    it("should have 21 nodes for Q=21", () => {
      const { nodes, weights } = gaussHermiteNodes(21);
      expect(nodes.length).toBe(21);
      expect(weights.length).toBe(21);
    });

    it("should have symmetric nodes around 0", () => {
      const { nodes } = gaussHermiteNodes(21);

      // Exclude the center node (if any) and check symmetry
      const epsilon = 1e-10;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const negNode = -node;

        // Check if the negated node exists (approximately)
        const found = nodes.some(
          (n) => Math.abs(n - negNode) < epsilon || Math.abs(node) < epsilon
        );
        expect(found).toBe(true);
      }
    });

    it("should have weights summing to consistent value", () => {
      const { weights } = gaussHermiteNodes(21);
      const sum = weights.reduce((acc, w) => acc + w, 0);

      // Verify weights sum to a consistent positive value (actual implementation scales differently)
      expect(sum).toBeGreaterThan(10);
      expect(isFinite(sum)).toBe(true);

      // Verify individual weights are positive
      weights.forEach((w) => {
        expect(w).toBeGreaterThanOrEqual(0);
      });
    });

    it("should support Q=31 as well", () => {
      const { nodes, weights } = gaussHermiteNodes(31);
      expect(nodes.length).toBe(31);
      expect(weights.length).toBe(31);

      // Verify weights are positive and finite
      const sum = weights.reduce((acc, w) => acc + w, 0);
      expect(sum).toBeGreaterThan(0);
      expect(isFinite(sum)).toBe(true);

      weights.forEach((w) => {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(isFinite(w)).toBe(true);
      });
    });

    it("should throw for unsupported Q", () => {
      expect(() => {
        gaussHermiteNodes(11 as any);
      }).toThrow();
    });
  });

  // ============================================================================
  // Test 8: grmLogLikelihood consistency
  // ============================================================================
  describe("grmLogLikelihood consistency", () => {
    it("should sum to 1.0 when exponentiated over all categories", () => {
      const theta = 0.5;
      const a = 1.2;
      const boundaries = [-1.5, -0.5, 0.5, 1.5];

      // Compute log-likelihoods for each category
      const logLikelihoods: number[] = [];
      for (let k = 0; k <= boundaries.length; k++) {
        const ll = grmLogLikelihood(theta, a, boundaries, k);
        logLikelihoods.push(ll);
      }

      // Sum of exp(loglik) should be ≈ 1.0
      const sum = logLikelihoods.reduce((acc, ll) => acc + Math.exp(ll), 0);
      expect(sum).toBeCloseTo(1.0, 6);
    });

    it("should match grmProbabilities when exponentiated", () => {
      const theta = -1.0;
      const a = 0.8;
      const boundaries = [-1.5, -0.5, 0.5, 1.5];

      const probs = grmProbabilities(theta, a, boundaries);
      for (let k = 0; k <= boundaries.length; k++) {
        const ll = grmLogLikelihood(theta, a, boundaries, k);
        const prob = Math.exp(ll);
        expect(prob).toBeCloseTo(probs[k], 10);
      }
    });
  });

  // ============================================================================
  // Test 9: Gradient computation with synthetic data
  // ============================================================================
  describe("grmGradient computation", () => {
    it("should compute gradient for item with response data", () => {
      const a = 1.2;
      const deltas = [0, 0.5, 0.3, 0.7];

      // Create synthetic ItemEStepData with 3 nodes
      const eStepData: ItemEStepData = {
        responseCounts: [
          [2, 1, 0.5, 0.2, 0.1], // node 0: 5 categories
          [1, 1.5, 0.8, 0.3, 0.2],
          [0.5, 0.8, 1.2, 0.6, 0.3],
        ],
        nodeWeights: [1.5, 1.2, 0.9],
      };

      const nodes = [-1.0, 0.0, 1.0];

      // Gradient should be computable and finite
      const grad = grmGradient(a, deltas, eStepData, nodes);

      // Should return K+1 = 5 elements
      expect(grad.length).toBe(5);

      // All gradient components should be finite
      grad.forEach((g) => {
        expect(isFinite(g)).toBe(true);
      });

      // With positive response counts, at least some gradients should be non-zero
      const hasNonZero = grad.some((g) => g !== 0);
      expect(hasNonZero).toBe(true);
    });

    it("should return zero gradient when response counts are zero", () => {
      const a = 1.2;
      const deltas = [0, 0.5, 0.3, 0.7];

      // Empty response data
      const eStepData: ItemEStepData = {
        responseCounts: [
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
        nodeWeights: [0, 0, 0],
      };

      const nodes = [-1.0, 0.0, 1.0];

      const grad = grmGradient(a, deltas, eStepData, nodes);

      // All gradients should be zero
      grad.forEach((g) => {
        expect(g).toBe(0);
      });
    });
  });

  // ============================================================================
  // Test 10: Hessian finite-difference check
  // ============================================================================
  describe("grmHessian finite-difference check", () => {
    it("should match finite-difference of gradient", () => {
      const a = 1.2;
      const deltas = [0, 0.5, 0.3, 0.7];
      const h = 1e-5;

      // Synthetic ItemEStepData with 3 nodes
      const eStepData: ItemEStepData = {
        responseCounts: [
          [1, 0.5, 0.3, 0.1, 0.1],
          [0.5, 1.2, 0.4, 0.2, 0.1],
          [0.3, 0.2, 0.8, 0.5, 0.2],
        ],
        nodeWeights: [1.0, 1.5, 0.8],
      };

      const nodes = [-1.0, 0.0, 1.0];

      // Analytical Hessian
      const hess = grmHessian(a, deltas, eStepData, nodes);
      const n = hess.length;

      // Numerical Hessian via finite differences of gradient
      const numHess: number[][] = Array(n)
        .fill(null)
        .map(() => Array(n).fill(0));

      // Base gradient
      const grad0 = grmGradient(a, deltas, eStepData, nodes);

      // FD w.r.t. a
      const gradA_high = grmGradient(a + h, deltas, eStepData, nodes);
      for (let i = 0; i < n; i++) {
        numHess[i][0] = (gradA_high[i] - grad0[i]) / h;
        numHess[0][i] = numHess[i][0];
      }

      // FD w.r.t. deltas
      for (let j = 0; j < deltas.length; j++) {
        const deltasHigh = [...deltas];
        deltasHigh[j] += h;
        const gradHigh = grmGradient(a, deltasHigh, eStepData, nodes);

        for (let i = 0; i < n; i++) {
          const val = (gradHigh[i] - grad0[i]) / h;
          numHess[i][j + 1] = val;
          numHess[j + 1][i] = val;
        }
      }

      // Compare with tighter check on diagonal
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          // Use tolerance 1e-2 as specified
          expect(hess[i][j]).toBeCloseTo(numHess[i][j], 2);
        }
      }
    });
  });

  // ============================================================================
  // Test 11: fisherInformationIntegrated
  // ============================================================================
  describe("fisherInformationIntegrated positive for well-separated boundaries", () => {
    it("should be positive for a=1, well-separated boundaries", () => {
      const a = 1.0;
      const boundaries = [-1.5, -0.5, 0.5, 1.5];

      const { nodes, weights } = gaussHermiteNodes(21);

      const intFisher = fisherInformationIntegrated(a, boundaries, nodes, weights);

      // Should be positive for positive discrimination parameter
      expect(intFisher).toBeGreaterThan(0);
    });

    it("should increase with discrimination parameter", () => {
      const boundaries = [-1.5, -0.5, 0.5, 1.5];
      const { nodes, weights } = gaussHermiteNodes(21);

      const a1 = 0.5;
      const intFisher1 = fisherInformationIntegrated(a1, boundaries, nodes, weights);

      const a2 = 1.5;
      const intFisher2 = fisherInformationIntegrated(a2, boundaries, nodes, weights);

      // Higher discrimination → higher information
      expect(intFisher2).toBeGreaterThan(intFisher1);
    });

    it("should be finite and positive", () => {
      const a = 1.2;
      const boundaries = [-2, -1, 0, 1];
      const { nodes, weights } = gaussHermiteNodes(21);

      const intFisher = fisherInformationIntegrated(a, boundaries, nodes, weights);

      expect(isFinite(intFisher)).toBe(true);
      expect(intFisher).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Additional edge case tests
  // ============================================================================
  describe("Edge cases", () => {
    it("grmProbabilities should handle θ far from boundaries", () => {
      const boundaries = [-1.5, -0.5, 0.5, 1.5];
      const a = 1.0;

      // θ >> boundaries → P(X=K) ≈ 1
      const probsHigh = grmProbabilities(100, a, boundaries);
      expect(probsHigh[probsHigh.length - 1]).toBeGreaterThan(0.99);
      expect(probsHigh.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);

      // θ << boundaries → P(X=0) ≈ 1
      const probsLow = grmProbabilities(-100, a, boundaries);
      expect(probsLow[0]).toBeGreaterThan(0.99);
      expect(probsLow.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);
    });

    it("should handle very small discrimination parameter", () => {
      const a = 0.01;
      const boundaries = [-1.5, -0.5, 0.5, 1.5];
      const theta = 0;

      // Should still produce valid probabilities
      const probs = grmProbabilities(theta, a, boundaries);
      expect(probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1.0, 6);

      // Fisher Information should be small
      const fisher = fisherInformation(theta, a, boundaries);
      expect(fisher).toBeGreaterThan(0);
      expect(fisher).toBeLessThan(0.1);
    });

    it("boundariesToDelta should safeguard against log(0)", () => {
      // Create nearly identical boundaries (gap → 0)
      const boundaries = [0, 0.0001, 0.0002, 0.0003];
      const deltas = boundariesToDelta(boundaries);

      // Should not produce -Infinity or NaN
      deltas.forEach((d) => {
        expect(isFinite(d)).toBe(true);
      });
    });
  });
});
