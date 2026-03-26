import { describe, it, expect } from "vitest";
import { detectCollapse } from "../src/composition-scorer.js";

describe("detectCollapse - Boundary & Oracle Tests", () => {
  /**
   * Oracle test scenarios from QA/red-team plan
   * Each test verifies both `detected` and `severity` to ±0.0001 tolerance
   */

  // Oracle 4.1: meanPrim=0.75, meanComp=0.25, floor=0.6, ceiling=0.3
  // Expected: detected=true, severity=0.6579
  it("Oracle 4.1: Clear collapse (prim=0.75, comp=0.25)", () => {
    const result = detectCollapse([0.75], [0.25], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.6579, 4);
    expect(result.mean_primitive).toBeCloseTo(0.75, 4);
    expect(result.mean_composed).toBeCloseTo(0.25, 4);
  });

  // Oracle 4.2: meanPrim=0.80, meanComp=0.10, floor=0.6, ceiling=0.3
  // Expected: detected=true, severity=0.8642
  it("Oracle 4.2: Severe collapse (prim=0.80, comp=0.10)", () => {
    const result = detectCollapse([0.80], [0.10], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.8642, 4);
    expect(result.mean_primitive).toBeCloseTo(0.80, 4);
    expect(result.mean_composed).toBeCloseTo(0.10, 4);
  });

  // Oracle 4.3: meanPrim=0.59999, meanComp=0.25, floor=0.6, ceiling=0.3
  // Expected: detected=false, severity=0 (prim just below floor)
  it("Oracle 4.3: No collapse (prim=0.59999 < floor)", () => {
    const result = detectCollapse([0.59999], [0.25], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBeCloseTo(0.59999, 4);
    expect(result.mean_composed).toBeCloseTo(0.25, 4);
  });

  // Oracle 4.4: meanPrim=0.60001, meanComp=0.25, floor=0.6, ceiling=0.3
  // Expected: detected=true, severity=0.5738 (prim just above floor)
  it("Oracle 4.4: Collapse detected (prim=0.60001 > floor)", () => {
    const result = detectCollapse([0.60001], [0.25], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.5738, 4);
    expect(result.mean_primitive).toBeCloseTo(0.60001, 4);
    expect(result.mean_composed).toBeCloseTo(0.25, 4);
  });

  // Oracle 4.5: meanPrim=0.75, meanComp=0.30001, floor=0.6, ceiling=0.3
  // Expected: detected=false, severity=0 (comp just above ceiling)
  it("Oracle 4.5: No collapse (comp=0.30001 > ceiling)", () => {
    const result = detectCollapse([0.75], [0.30001], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBeCloseTo(0.75, 4);
    expect(result.mean_composed).toBeCloseTo(0.30001, 4);
  });

  // Oracle 4.6: meanPrim=0.75, meanComp=0.29999, floor=0.6, ceiling=0.3
  // Expected: detected=true, severity=0.5922 (comp just below ceiling)
  it("Oracle 4.6: Collapse detected (comp=0.29999 < ceiling)", () => {
    const result = detectCollapse([0.75], [0.29999], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.592118, 4);
    expect(result.mean_primitive).toBeCloseTo(0.75, 4);
    expect(result.mean_composed).toBeCloseTo(0.29999, 4);
  });

  // Oracle 4.7: meanPrim=0.09, meanComp=0.01, floor=0.6, ceiling=0.3
  // Expected: detected=false, severity=0 (both below thresholds)
  it("Oracle 4.7: No collapse (both prim and comp low)", () => {
    const result = detectCollapse([0.09], [0.01], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBeCloseTo(0.09, 4);
    expect(result.mean_composed).toBeCloseTo(0.01, 4);
  });

  // Oracle 4.8: meanPrim=0.50, meanComp=0.25, floor=0.6, ceiling=0.3
  // Expected: detected=false, severity=0 (prim below floor)
  it("Oracle 4.8: No collapse (prim=0.50 < floor)", () => {
    const result = detectCollapse([0.50], [0.25], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBeCloseTo(0.50, 4);
    expect(result.mean_composed).toBeCloseTo(0.25, 4);
  });

  /**
   * Additional edge case tests
   */

  // Absurd thresholds: floor=0.0, ceiling=1.0 with prim=0.5, comp=0.4
  // Both conditions met trivially → should detect
  it("Edge: Absurd thresholds (floor=0.0, ceiling=1.0) → detects", () => {
    const result = detectCollapse([0.5], [0.4], {
      primitive_floor: 0.0,
      composed_ceiling: 1.0,
    });
    expect(result.detected).toBe(true);
    // severity = (0.5 - 0.4) / (0.5 + 0.01) = 0.1 / 0.51 ≈ 0.1961
    expect(result.severity).toBeCloseTo(0.1961, 4);
  });

  // Empty arrays: both empty → should handle gracefully
  // mean will be 0 (from initial value), should not detect
  it("Edge: Both arrays empty → no detection", () => {
    const result = detectCollapse([], [], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBe(0);
    expect(result.mean_composed).toBe(0);
  });

  // Primitive array empty, composed not
  it("Edge: Empty primitives array → no detection", () => {
    const result = detectCollapse([], [0.1], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(false);
    expect(result.severity).toBe(0);
    expect(result.mean_primitive).toBe(0);
    expect(result.mean_composed).toBe(0.1);
  });

  // Composed array empty, primitives not
  it("Edge: Empty composed array → no detection", () => {
    const result = detectCollapse([0.8], [], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.9877, 4);
    expect(result.mean_primitive).toBe(0.8);
    expect(result.mean_composed).toBe(0);
  });

  // Single value per array (minimum viable input)
  it("Edge: Single values (minimum viable input)", () => {
    const result = detectCollapse([0.75], [0.2]);
    expect(result.detected).toBe(true);
    expect(result.mean_primitive).toBe(0.75);
    expect(result.mean_composed).toBe(0.2);
  });

  // Multiple values averaging to oracle point
  it("Edge: Multiple values averaging correctly", () => {
    // Average [0.7, 0.8] = 0.75, [0.2, 0.3] = 0.25
    const result = detectCollapse([0.7, 0.8], [0.2, 0.3], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.mean_primitive).toBeCloseTo(0.75, 4);
    expect(result.mean_composed).toBeCloseTo(0.25, 4);
    expect(result.severity).toBeCloseTo(0.6579, 4);
  });

  // Severity guarding: when meanPrim < 0.1, severity is 0
  it("Severity guard: meanPrim < 0.1 → severity=0", () => {
    const result = detectCollapse([0.095], [0.01], {
      primitive_floor: 0.09,
      composed_ceiling: 0.02,
    });
    expect(result.detected).toBe(true); // 0.095 > 0.09 and 0.01 < 0.02
    expect(result.severity).toBe(0); // guarded because meanPrim < 0.1
  });

  // Severity calculation with various means
  it("Severity calculation: (gap) / (baseline + 0.01)", () => {
    // severity = (0.8 - 0.2) / (0.8 + 0.01) = 0.6 / 0.81 ≈ 0.7407
    const result = detectCollapse([0.8], [0.2], {
      primitive_floor: 0.6,
      composed_ceiling: 0.3,
    });
    expect(result.detected).toBe(true);
    expect(result.severity).toBeCloseTo(0.7407, 4);
  });
});
