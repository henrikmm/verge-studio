/**
 * Graph state shared by the canvas, the inspector and the panes.
 *
 * Same `useSyncExternalStore` pattern as `lib/session-store.ts` — no state library.
 * Desired cache keys are recomputed on every mutation and kept in the snapshot, so
 * "is this node stale?" is a plain comparison anywhere in the UI rather than a
 * recomputation each render.
 */

import { useSyncExternalStore } from "react";
import type { JsonValue } from "./cache-key";
import { computeDesiredKeys, isStale, runGraph, type RunReport } from "./evaluate";
import { defaultGraph, REGISTRY } from "./nodes";
import {
  emptyRuntime,
  type GraphEdge,
  type GraphNode,
  type NodeOutput,
  type NodeRuntime,
} from "./types";

export interface GraphStoreState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  runtime: Record<string, NodeRuntime>;
  /** Node id → the cache key its current configuration wants. */
  desiredKeys: Record<string, string>;
  selectedId: string | null;
  running: boolean;
  /** Structural problems (a cycle, an unknown node type), not node failures. */
  error: string | null;
}

const initial = defaultGraph();

const state: GraphStoreState = {
  nodes: initial.nodes,
  edges: initial.edges,
  runtime: Object.fromEntries(initial.nodes.map((n) => [n.id, emptyRuntime()])),
  desiredKeys: {},
  selectedId: "da3-depth",
  running: false,
  error: null,
};

const listeners = new Set<() => void>();
let snapshot: GraphStoreState = { ...state };

function recomputeKeys() {
  try {
    state.desiredKeys = Object.fromEntries(computeDesiredKeys(state.nodes, state.edges, REGISTRY));
    state.error = null;
  } catch (err) {
    // Keep the last good keys so the UI stays usable while the graph is mid-edit.
    state.error = err instanceof Error ? err.message : String(err);
  }
}

function commit() {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): GraphStoreState {
  return snapshot;
}

export function useGraph(): GraphStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getGraph(): GraphStoreState {
  return state;
}

export function setNodes(nodes: GraphNode[]) {
  state.nodes = nodes;
  // A node added by the user needs a runtime slot before anything reads it.
  for (const node of nodes) state.runtime[node.id] ??= emptyRuntime();
  recomputeKeys();
  commit();
}

export function setEdges(edges: GraphEdge[]) {
  state.edges = edges;
  recomputeKeys();
  commit();
}

export function setNodeParam(nodeId: string, key: string, value: JsonValue) {
  state.nodes = state.nodes.map((n) =>
    n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n,
  );
  recomputeKeys();
  commit();
}

/** Bulk update — a drop replaces path, name, digest and duration at once. */
export function setNodeParams(nodeId: string, patch: Record<string, JsonValue>) {
  state.nodes = state.nodes.map((n) =>
    n.id === nodeId ? { ...n, params: { ...n.params, ...patch } } : n,
  );
  recomputeKeys();
  commit();
}

/** The A/P badge. */
export function setNodeAuto(nodeId: string, auto: boolean) {
  state.nodes = state.nodes.map((n) => (n.id === nodeId ? { ...n, auto } : n));
  commit();
}

export function selectNode(nodeId: string | null) {
  // Idempotent on purpose. React Flow reports the selection on every render pass,
  // including an empty one at mount; committing unconditionally re-renders the
  // canvas, which reports again, which is an infinite loop.
  if (state.selectedId === nodeId) return;
  state.selectedId = nodeId;
  commit();
}

export function nodeById(s: GraphStoreState, id: string): GraphNode | undefined {
  return s.nodes.find((n) => n.id === id);
}

export function isNodeStale(s: GraphStoreState, id: string): boolean {
  return isStale(s.runtime[id], s.desiredKeys[id] ?? "");
}

/**
 * What is arriving on a node's input port right now. Panes use this: a sink computes
 * nothing, it just reads the wire feeding it.
 */
export function resolveInput(
  s: GraphStoreState,
  nodeId: string,
  portId: string,
): NodeOutput | null {
  const edge = s.edges.find((e) => e.target === nodeId && e.targetPort === portId);
  if (!edge) return null;
  return s.runtime[edge.source]?.outputs?.[edge.sourcePort] ?? null;
}

let activeRun: AbortController | null = null;

export interface RunRequest {
  /** Evaluate only what this node needs. Omit for the whole graph. */
  target?: string;
  /** Manual nodes cleared to run this pass — the explicit Run the user pressed. */
  allowManual?: boolean | ReadonlySet<string>;
}

export async function run(request: RunRequest = {}): Promise<RunReport> {
  activeRun?.abort();
  const controller = new AbortController();
  activeRun = controller;

  state.running = true;
  commit();
  try {
    return await runGraph({
      nodes: state.nodes,
      edges: state.edges,
      registry: REGISTRY,
      runtime: state.runtime,
      target: request.target,
      allowManual: request.allowManual,
      signal: controller.signal,
      onChange: (id, patch) => {
        state.runtime = { ...state.runtime, [id]: { ...(state.runtime[id] ?? emptyRuntime()), ...patch } };
        commit();
      },
    });
  } finally {
    if (activeRun === controller) activeRun = null;
    state.running = false;
    commit();
  }
}

/**
 * Run the node the user asked for, clearing it — and only it — to spend GPU time.
 *
 * Deliberately not scoped with `target`: the whole graph is evaluated so the free
 * CPU nodes downstream refresh in the same pass. Restricting to ancestors would run
 * the expensive node and then leave the views showing stale results.
 */
export function runNode(nodeId: string): Promise<RunReport> {
  return run({ allowManual: new Set([nodeId]) });
}

/** Re-evaluate everything that can run for free. Manual nodes stay stale. */
export function runAuto(): Promise<RunReport> {
  return run({ allowManual: false });
}

recomputeKeys();
snapshot = { ...state };
