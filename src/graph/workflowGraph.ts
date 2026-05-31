/**
 * Visual workflow graph — maps a `RunTrace` into nodes + edges for a
 * node-based canvas (XYFlow / React Flow in the production UI).
 *
 * The production app's headline UX is visual-first: the orchestration is not a
 * chat log, it's a graph you can inspect — each plan step becomes a node, edges
 * show execution order, and node color encodes success/failure. This module is
 * the pure, UI-agnostic transform that feeds that canvas. The actual rendering
 * (`@xyflow/react`, layout maths, drag state) lives in the React layer; keeping
 * the transform pure makes it trivial to test and reason about.
 */

import type { RunTrace } from "../types.js";

/** Minimal shapes compatible with XYFlow's `Node` / `Edge` (decoupled here). */
export interface FlowNode {
  readonly id: string;
  readonly type: "goal" | "step";
  readonly position: { readonly x: number; readonly y: number };
  readonly data: {
    readonly label: string;
    readonly status?: "ok" | "failed";
    readonly detail?: string;
  };
}

export interface FlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly animated: boolean;
}

const NODE_GAP_Y = 120;

/**
 * Build a top-to-bottom flow: goal → step 1 → step 2 → ...
 * Node `status` drives color in the UI; failed steps surface in red.
 */
export function traceToGraph(trace: RunTrace): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const goalId = `goal:${trace.runId}`;
  nodes.push({
    id: goalId,
    type: "goal",
    position: { x: 0, y: 0 },
    data: { label: trace.goal },
  });

  let prevId = goalId;
  trace.observations.forEach((obs, i) => {
    const id = `step:${i}`;
    nodes.push({
      id,
      type: "step",
      position: { x: 0, y: (i + 1) * NODE_GAP_Y },
      data: {
        label: obs.step.tool,
        status: obs.ok ? "ok" : "failed",
        detail: obs.step.rationale,
      },
    });
    edges.push({
      id: `e:${prevId}->${id}`,
      source: prevId,
      target: id,
      animated: obs.ok,
    });
    prevId = id;
  });

  return { nodes, edges };
}
