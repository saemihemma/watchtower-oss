import { describe, it, expect } from "vitest";
import { validateCompositionDAG, detectCycle, type DAGNode } from "../src/composition-dag.js";

describe("composition-dag", () => {
  // Test 1: Valid DAG (spec §4.1 structure)
  it("validates a valid DAG with 4 primitives → 2 composed → 2 meta", () => {
    const nodes: DAGNode[] = [
      { task_id: "p1", layer: "primitive", dependencies: [] },
      { task_id: "p2", layer: "primitive", dependencies: [] },
      { task_id: "p3", layer: "primitive", dependencies: [] },
      { task_id: "p4", layer: "primitive", dependencies: [] },
      { task_id: "c1", layer: "composed", dependencies: ["p1", "p2"] },
      { task_id: "c2", layer: "composed", dependencies: ["p3", "p4"] },
      { task_id: "m1", layer: "meta", dependencies: ["c1"] },
      { task_id: "m2", layer: "meta", dependencies: ["c1", "c2"] },
    ];
    const order = validateCompositionDAG(nodes);
    expect(order).toHaveLength(8);
    // Each node appears after all its dependencies
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(node.task_id));
      }
    }
  });

  // Test 2: Cyclic dependency A→B→A
  it("detects cyclic dependency", () => {
    const nodes: DAGNode[] = [
      { task_id: "a", layer: "composed", dependencies: ["b"] },
      { task_id: "b", layer: "composed", dependencies: ["a"] },
    ];
    expect(() => validateCompositionDAG(nodes)).toThrow(/[Cc]yclic/);
  });

  // Test 3: Missing dependency target
  it("rejects missing dependency target", () => {
    const nodes: DAGNode[] = [
      { task_id: "c1", layer: "composed", dependencies: ["nonexistent"] },
    ];
    expect(() => validateCompositionDAG(nodes)).toThrow(/unknown task 'nonexistent'/);
  });

  // Test 4: Self-reference
  it("rejects self-reference", () => {
    const nodes: DAGNode[] = [
      { task_id: "x", layer: "composed", dependencies: ["x"] },
    ];
    expect(() => validateCompositionDAG(nodes)).toThrow(/self-reference/);
  });

  // Test 5: Primitive with dependencies
  it("rejects primitive with dependencies", () => {
    const nodes: DAGNode[] = [
      { task_id: "p1", layer: "primitive", dependencies: ["p2"] },
      { task_id: "p2", layer: "primitive", dependencies: [] },
    ];
    expect(() => validateCompositionDAG(nodes)).toThrow(/Primitive task 'p1' must not have dependencies/);
  });

  // Test 6: Topological order deterministic
  it("produces deterministic topological order (sorted by task_id)", () => {
    const nodes: DAGNode[] = [
      { task_id: "d", layer: "primitive", dependencies: [] },
      { task_id: "b", layer: "primitive", dependencies: [] },
      { task_id: "a", layer: "primitive", dependencies: [] },
      { task_id: "c", layer: "composed", dependencies: ["a", "b"] },
      { task_id: "e", layer: "meta", dependencies: ["c"] },
    ];
    const order = validateCompositionDAG(nodes);
    // Deterministic: sorted by task_id among available nodes at each step.
    // a, b available initially (in-degree 0, d also). After a+b processed, c becomes available.
    // Queue state: [a, b, d] → process a → [b, d] → process b → c enters → [c, d] → process c → [d] → d → e
    expect(order[0]).toBe("a");
    expect(order[1]).toBe("b");
    expect(order[2]).toBe("c"); // c's deps (a,b) resolved, c < d lexically
    expect(order[3]).toBe("d");
    expect(order[4]).toBe("e");
  });

  // Test 7: Composed depends on meta
  it("rejects composed depending on meta", () => {
    const nodes: DAGNode[] = [
      { task_id: "c1", layer: "composed", dependencies: ["m1"] },
      { task_id: "m1", layer: "meta", dependencies: [] },
    ];
    // Note: meta with no deps would also fail in a strict DAG, but the layer rule triggers first
    expect(() => validateCompositionDAG(nodes)).toThrow(/[Cc]omposed task 'c1' cannot depend on meta task 'm1'/);
  });

  // Test 8: Meta depends on primitive
  it("rejects meta depending on primitive", () => {
    const nodes: DAGNode[] = [
      { task_id: "p1", layer: "primitive", dependencies: [] },
      { task_id: "m1", layer: "meta", dependencies: ["p1"] },
    ];
    expect(() => validateCompositionDAG(nodes)).toThrow(/Meta task 'm1' must depend on composed tasks.*layer=primitive/);
  });
});

describe("detectCycle", () => {
  it("returns null for acyclic graph", () => {
    const nodes: DAGNode[] = [
      { task_id: "a", layer: "primitive", dependencies: [] },
      { task_id: "b", layer: "composed", dependencies: ["a"] },
    ];
    expect(detectCycle(nodes)).toBeNull();
  });

  it("returns cycle path for cyclic graph", () => {
    const nodes: DAGNode[] = [
      { task_id: "a", layer: "composed", dependencies: ["b"] },
      { task_id: "b", layer: "composed", dependencies: ["a"] },
    ];
    const cycle = detectCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3); // [a, b, a] or similar
  });
});
