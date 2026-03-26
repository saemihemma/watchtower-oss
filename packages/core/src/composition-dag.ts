/**
 * DAG validation for composition task dependencies.
 *
 * Validates that composition tasks form a directed acyclic graph.
 * Uses Kahn's algorithm (BFS topological sort) with deterministic
 * ordering: the in-degree-0 queue is maintained sorted by task_id.
 */

import type { CompositionLayer } from "./schemas.js";

export type DAGNode = {
  task_id: string;
  layer: CompositionLayer;
  dependencies: string[];
};

/**
 * Validate that composition tasks form a DAG. Returns topological order.
 *
 * Throws on: cyclic dependency, missing dependency target, self-reference,
 * primitive with dependencies, composed depending on meta,
 * meta depending on primitive.
 *
 * Determinism: queue processes nodes in sorted task_id order.
 */
export function validateCompositionDAG(nodes: DAGNode[]): string[] {
  const nodeMap = new Map<string, DAGNode>();
  for (const node of nodes) {
    nodeMap.set(node.task_id, node);
  }

  // --- Pre-Kahn validation ---

  for (const node of nodes) {
    // Self-reference
    if (node.dependencies.includes(node.task_id)) {
      throw new Error(`Task '${node.task_id}' has self-reference in dependencies.`);
    }

    // Primitive must have empty dependencies
    if (node.layer === "primitive" && node.dependencies.length > 0) {
      throw new Error(
        `Primitive task '${node.task_id}' must not have dependencies.`
      );
    }

    for (const dep of node.dependencies) {
      // Missing dependency target
      const target = nodeMap.get(dep);
      if (!target) {
        throw new Error(`Task '${node.task_id}' depends on unknown task '${dep}'.`);
      }

      // Composed cannot depend on meta
      if (node.layer === "composed" && target.layer === "meta") {
        throw new Error(
          `Composed task '${node.task_id}' cannot depend on meta task '${dep}'.`
        );
      }

      // Meta must depend only on composed
      if (node.layer === "meta" && target.layer !== "composed") {
        throw new Error(
          `Meta task '${node.task_id}' must depend on composed tasks, got '${dep}' (layer=${target.layer}).`
        );
      }
    }
  }

  // --- Kahn's algorithm ---

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.task_id, 0);
    adjacency.set(node.task_id, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      adjacency.get(dep)!.push(node.task_id);
      inDegree.set(node.task_id, (inDegree.get(node.task_id) ?? 0) + 1);
    }
  }

  // Deterministic queue: sorted by task_id
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current)!) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position for determinism
        const insertIdx = queue.findIndex(q => q > neighbor);
        if (insertIdx === -1) {
          queue.push(neighbor);
        } else {
          queue.splice(insertIdx, 0, neighbor);
        }
      }
    }
  }

  if (order.length !== nodes.length) {
    // Remaining nodes are in a cycle
    const cycleMembers = nodes
      .filter(n => !order.includes(n.task_id))
      .map(n => n.task_id);
    const cyclePath = detectCycle(nodes);
    const pathStr = cyclePath ? cyclePath.join(" → ") : cycleMembers.join(", ");
    throw new Error(`Cyclic dependency detected: ${pathStr}`);
  }

  return order;
}

/**
 * Detect a cycle in the dependency graph.
 * @returns Cycle path as [A, B, ..., A] if found, null otherwise.
 */
export function detectCycle(nodes: DAGNode[]): string[] | null {
  const nodeMap = new Map<string, DAGNode>();
  for (const node of nodes) {
    nodeMap.set(node.task_id, node);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const node of nodes) {
    color.set(node.task_id, WHITE);
  }

  for (const node of nodes) {
    if (color.get(node.task_id) === WHITE) {
      const cycle = dfsVisit(node.task_id, nodeMap, color, parent);
      if (cycle) return cycle;
    }
  }

  return null;
}

function dfsVisit(
  nodeId: string,
  nodeMap: Map<string, DAGNode>,
  color: Map<string, number>,
  parent: Map<string, string | null>
): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  color.set(nodeId, GRAY);

  const node = nodeMap.get(nodeId)!;
  for (const dep of node.dependencies) {
    if (!nodeMap.has(dep)) continue; // skip missing deps (caught elsewhere)

    if (color.get(dep) === GRAY) {
      // Back edge — reconstruct cycle
      const cycle: string[] = [dep, nodeId];
      let cur = nodeId;
      while (parent.get(cur) !== undefined && parent.get(cur) !== dep) {
        cur = parent.get(cur)!;
        if (cur === dep) break;
      }
      cycle.push(dep);
      return cycle.reverse();
    }

    if (color.get(dep) === WHITE) {
      parent.set(dep, nodeId);
      const cycle = dfsVisit(dep, nodeMap, color, parent);
      if (cycle) return cycle;
    }
  }

  color.set(nodeId, BLACK);
  return null;
}
