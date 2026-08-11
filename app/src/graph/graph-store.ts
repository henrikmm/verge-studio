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
import { computeDesiredKeys, downstreamOf, isStale, runGraph, type RunReport } from "./evaluate";
import { defaultGraph, REGISTRY } from "./nodes";
import {
  disposeNodeOutputs,
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
  /**
   * The highlighted wire, if any. Purely a view concern — it is never saved and never
   * reaches a cache key, so selecting a wire cannot restale a node or change a result.
   */
  selectedEdgeId: string | null;
  running: boolean;
  /** Structural problems (a cycle, an unknown node type), not node failures. */
  error: string | null;
}

/**
 * Node parameters survive a reload; nothing else does.
 *
 * The pane layout (`dock-store`) and the measurement objects, targets and painted trials
 * (`measurement-store`) have both persisted for a while. The graph did not — so a browser
 * reload, or a Mac waking from sleep and discarding the tab, silently reset Run Source to the
 * built-in door fixture while the operator's own targets stayed on screen. Reported 2026-08-05
 * after an hour's break: "the default was the standard run not the da3Test one".
 *
 * Only `params` are stored. Runtime outputs hold live THREE.Group objects and decoded typed
 * arrays, which are neither serializable nor safe to resurrect — a restored graph is stale by
 * construction and re-runs its CPU nodes, which is the honest state anyway.
 *
 * The clip identity is deliberately EXCLUDED. `videoPath` points into the OS temp dir, which is
 * cleared on reboot, so restoring it would make Frame Source auto-run and fail against a file
 * that no longer exists. Losing the run selection was the actual complaint; a persisted clip
 * needs a durable copy of the video, which is a separate piece of work.
 *
 * Versioned, for the same reason the dock layout is. Bumped v1 → v2 on 2026-08-11 with Run
 * Source's default moving from `recorded` to `live`. Stored params are merged OVER the spec
 * defaults, so without a bump every profile that had ever opened the app would keep the old
 * default and the fix would only be visible on a fresh machine. The cost is one reset of the
 * inference parameters, which are the documented defaults anyway.
 */
const PARAMS_KEY = "verge.graph.params.v2";
const UNSAVED_PARAMS: Record<string, readonly string[]> = {
  "frame-source": ["videoPath", "videoName", "videoSha256", "durationS"],
};

function loadParams(): Record<string, Record<string, JsonValue>> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(PARAMS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, JsonValue>>) : {};
  } catch {
    // Corrupt or unavailable storage must never stop the app from opening.
    return {};
  }
}

function saveParams(nodes: GraphNode[]): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const stored: Record<string, Record<string, JsonValue>> = {};
    for (const node of nodes) {
      const skip = UNSAVED_PARAMS[node.type] ?? [];
      stored[node.id] = Object.fromEntries(
        Object.entries(node.params).filter(([key]) => !skip.includes(key)),
      );
    }
    window.localStorage.setItem(PARAMS_KEY, JSON.stringify(stored));
  } catch {
    // A full or disabled localStorage must never take the app down with it.
  }
}

/**
 * Restore stored params onto the default graph.
 *
 * Merged onto the spec defaults rather than replacing them, so a node that gains a parameter in
 * a later version still gets its default instead of `undefined` reaching an execute().
 */
function restoreGraph() {
  const graph = defaultGraph();
  const stored = loadParams();
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      stored[node.id] ? { ...node, params: { ...node.params, ...stored[node.id] } } : node,
    ),
  };
}

const initial = restoreGraph();

const state: GraphStoreState = {
  nodes: initial.nodes,
  edges: initial.edges,
  runtime: Object.fromEntries(initial.nodes.map((n) => [n.id, emptyRuntime()])),
  desiredKeys: {},
  selectedId: "fixture-run",
  selectedEdgeId: null,
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
  saveParams(state.nodes);
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
  const retained = new Set(nodes.map((node) => node.id));
  for (const [id, runtime] of Object.entries(state.runtime)) {
    if (!retained.has(id)) deferDispose(runtime.outputs);
  }
  state.nodes = nodes;
  // A node added by the user needs a runtime slot before anything reads it.
  for (const node of nodes) state.runtime[node.id] ??= emptyRuntime();
  recomputeKeys();
  commit();
}

export function setEdges(edges: GraphEdge[]) {
  state.edges = edges;
  // A highlight pointing at a wire that no longer exists would leave Backspace armed at
  // nothing, and the next wire to reuse that id would inherit the selection.
  if (state.selectedEdgeId && !edges.some((e) => e.id === state.selectedEdgeId)) {
    state.selectedEdgeId = null;
  }
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

/**
 * Change a parameter and then bring the graph back up to date on its own.
 *
 * `setNodeParam` only marks work as out of date; something else has to actually redo it. The
 * Inspector never did, so changing a value there left the graph stranded: switching Run Source
 * from the recorded fixture to the live output stalled eight nodes with no visible way forward,
 * and the panes went on showing the old room. The run had already been paid for. It recovered
 * only because nudging an unrelated Depth 2D slider happens to call `runAuto()` — which is not
 * an affordance anyone could be expected to find.
 *
 * Only free work is redone — see `runAutoFree()`, which bars every costly node outright, so
 * cloud inference can never be started by moving a control. That safety property is why the
 * raw setters stay available for the callers that drive their own run.
 *
 * The short delay coalesces a slider drag into one pass at the end. Without it, every
 * intermediate value starts a run that the next value immediately aborts.
 */
export const PARAM_RUN_DELAY_MS = 180;

let pendingRun: ReturnType<typeof setTimeout> | null = null;

/** Redo the free work shortly, folding a burst of edits into a single pass. */
export function scheduleAutoRun(delayMs: number = PARAM_RUN_DELAY_MS): void {
  if (pendingRun) clearTimeout(pendingRun);
  pendingRun = setTimeout(() => {
    pendingRun = null;
    void runAutoFree();
  }, delayMs);
}

/** Tests and teardown: drop a scheduled pass without running it. */
export function cancelScheduledAutoRun(): void {
  if (pendingRun) clearTimeout(pendingRun);
  pendingRun = null;
}

/** `setNodeParam`, then catch the graph up. The Inspector's control path. */
export function setNodeParamAndRun(nodeId: string, key: string, value: JsonValue) {
  setNodeParam(nodeId, key, value);
  scheduleAutoRun();
}

/** `setNodeParams`, then catch the graph up. */
export function setNodeParamsAndRun(nodeId: string, patch: Record<string, JsonValue>) {
  setNodeParams(nodeId, patch);
  scheduleAutoRun();
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
  if (state.selectedId === nodeId && state.selectedEdgeId === null) return;
  state.selectedId = nodeId;
  // One selection at a time: the Inspector follows the node, and Backspace has to have
  // exactly one meaning. Picking a node therefore drops any highlighted wire.
  state.selectedEdgeId = null;
  commit();
}

/** Highlight a wire, or clear the highlight with `null`. */
export function selectEdge(edgeId: string | null) {
  if (state.selectedEdgeId === edgeId && (edgeId === null || state.selectedId === null)) return;
  state.selectedEdgeId = edgeId;
  if (edgeId !== null) state.selectedId = null;
  commit();
}

export function nodeById(s: GraphStoreState, id: string): GraphNode | undefined {
  return s.nodes.find((n) => n.id === id);
}

export function isNodeStale(s: GraphStoreState, id: string): boolean {
  return isStale(s.runtime[id], s.desiredKeys[id] ?? "");
}

/**
 * Discard cached results from these nodes through the end of their branches.
 * This is the explicit "do it again" path; normal parameter edits still use the
 * content-addressed cache and preserve unrelated work.
 */
export function invalidateFrom(nodeIds: readonly string[]): string[] {
  const affected = downstreamOf(nodeIds, state.nodes, state.edges);
  if (affected.length === 0) return affected;
  const runtime = { ...state.runtime };
  for (const id of affected) {
    deferDispose(runtime[id]?.outputs);
    runtime[id] = emptyRuntime();
  }
  state.runtime = runtime;
  commit();
  return affected;
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

/** Evidence views must never treat a retained stale output as a fresh measurement. */
export function resolveCurrentInput(
  s: GraphStoreState,
  nodeId: string,
  portId: string,
): NodeOutput | null {
  const edge = s.edges.find((e) => e.target === nodeId && e.targetPort === portId);
  if (!edge) return null;
  const source = s.runtime[edge.source];
  if (!source?.outputs || source.status !== "ok" || isNodeStale(s, edge.source)) return null;
  return source.outputs[edge.sourcePort] ?? null;
}

let activeRun: AbortController | null = null;

/**
 * Let mounted panes detach an old object before its WebGL buffers disappear.
 *
 * Two animation frames also cover a hidden pane: nothing is mounted there, so the graph remains
 * the owner and performs the release itself. Point-cloud disposers are idempotent because both
 * paths may meet on the same output.
 */
function deferDispose(outputs: Record<string, NodeOutput> | null | undefined): void {
  if (!outputs) return;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(() => disposeNodeOutputs(outputs)));
  } else {
    setTimeout(() => disposeNodeOutputs(outputs), 0);
  }
}

export interface RunRequest {
  /** Evaluate only what this node needs. Omit for the whole graph. */
  target?: string;
  /** Manual nodes cleared to run this pass — the explicit Run the user pressed. */
  allowManual?: boolean | ReadonlySet<string>;
  /** Nodes barred from this pass regardless of their badge. See `RunOptions.deny`. */
  deny?: ReadonlySet<string>;
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
      deny: request.deny,
      signal: controller.signal,
      onChange: (id, patch) => {
        const previous = state.runtime[id] ?? emptyRuntime();
        state.runtime = { ...state.runtime, [id]: { ...previous, ...patch } };
        commit();
        if (patch.outputs && previous.outputs && patch.outputs !== previous.outputs) {
          deferDispose(previous.outputs);
        }
      },
    });
  } finally {
    // An aborted pass can finish after its replacement has started. It must not clear the
    // replacement's running state or make the status bar claim the graph is idle.
    if (activeRun === controller) {
      activeRun = null;
      state.running = false;
      commit();
    }
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

/**
 * The refresh that follows an edit the user made to a control.
 *
 * Stricter than `runAuto()` on purpose. `runAuto()` honours the A/P badge, so a node the user
 * deliberately set to auto will run — that is what the badge is for. This pass does not, because
 * the user asked to change a value, not to start a run, and the Inspector is exactly where the
 * DA3 sampling controls live. Every node the registry calls costly stays out of it, so no
 * amount of slider dragging can reach the GPU.
 */
export function runAutoFree(): Promise<RunReport> {
  const costly = new Set(
    state.nodes.filter((n) => REGISTRY[n.type]?.execution === "manual").map((n) => n.id),
  );
  return run({ allowManual: false, deny: costly });
}

recomputeKeys();
snapshot = { ...state };
