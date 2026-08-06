/**
 * The rules for joining two ports with a wire.
 *
 * Extracted from the graph pane so they can be tested directly. Driving them through a real
 * mouse drag works — it was verified in the browser on 2026-08-06 — but a port handle is about
 * 11 pixels wide even zoomed in, so a drag is a poor way to assert a rule. The behaviour these
 * functions describe is worth pinning precisely: a wrong answer here silently rewires the
 * pipeline, and the panes would go on displaying whatever arrived.
 */

import type { GraphEdge, GraphNode, NodeRegistry, PortType } from "./types";

/** The port's declared type, or null when the node type or the port is unknown. */
export function portTypeOf(
  registry: NodeRegistry,
  nodeType: string,
  portId: string,
  side: "in" | "out",
): PortType | null {
  const spec = registry[nodeType];
  if (!spec) return null;
  const ports = side === "in" ? spec.inputs : spec.outputs;
  return ports.find((p) => p.id === portId)?.type ?? null;
}

/**
 * A drag in progress, or a finished one. React Flow reports handles as `undefined` on an `Edge`
 * and `null` on a `Connection`, so both are accepted and treated the same: not a port yet.
 */
export interface ConnectionAttempt {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/**
 * May these two ports be joined?
 *
 * Types must match exactly — a depth field cannot be wired into a point-cloud input, because the
 * receiving node would then be handed a value of a shape it does not understand. A node may not
 * be wired to itself.
 */
export function canConnect(
  registry: NodeRegistry,
  nodes: readonly GraphNode[],
  attempt: ConnectionAttempt,
): boolean {
  const { source, target, sourceHandle, targetHandle } = attempt;
  if (!source || !target || !sourceHandle || !targetHandle) return false;
  if (source === target) return false;

  const from = nodes.find((n) => n.id === source);
  const to = nodes.find((n) => n.id === target);
  if (!from || !to) return false;

  const out = portTypeOf(registry, from.type, sourceHandle, "out");
  const into = portTypeOf(registry, to.type, targetHandle, "in");
  return out !== null && out === into;
}

/** The id a wire gets. Derived from its endpoints, so the same connection is always the same id. */
export function edgeId(ends: {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}): string {
  return `e-${ends.source}-${ends.sourceHandle}-${ends.target}-${ends.targetHandle}`;
}

/**
 * Apply a connection, returning the new set of wires.
 *
 * **One wire per input.** An input port takes a single value, so connecting to one that is
 * already occupied replaces what was there rather than stacking a second wire — otherwise the
 * node would have two candidate values and no rule for choosing. Only the wire into *that
 * input* is displaced: an output may feed as many inputs as it likes, and the other wires
 * leaving the same port are untouched.
 *
 * Returns the original array unchanged when the connection is not allowed, so the caller can
 * treat a refusal as a no-op.
 */
export function connectEdges(
  registry: NodeRegistry,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  attempt: ConnectionAttempt,
): GraphEdge[] {
  if (!canConnect(registry, nodes, attempt)) return [...edges];

  const source = attempt.source!;
  const target = attempt.target!;
  const sourcePort = attempt.sourceHandle!;
  const targetPort = attempt.targetHandle!;

  const kept = edges.filter((e) => !(e.target === target && e.targetPort === targetPort));
  return [
    ...kept,
    { id: edgeId({ source, target, sourceHandle: sourcePort, targetHandle: targetPort }), source, sourcePort, target, targetPort },
  ];
}
