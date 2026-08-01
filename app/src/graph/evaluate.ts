/**
 * Graph evaluation: what is stale, in what order does it run, and what may run at all.
 *
 * The invalidation rule is content-addressed, not timestamp-based. Every node has a
 * *desired* cache key derived from its parameters plus the desired keys of its inputs.
 * A node is stale when the key of the result it holds differs from its desired key.
 * Because the desired key is built from upstream desired keys — not from upstream's
 * held output — changing one parameter restamps that node and everything downstream
 * of it immediately, while siblings and ancestors keep their keys and their results.
 * That is the "param change re-executes only downstream" behaviour M2 is judged on.
 */

import { artifactCacheKey, sha256Hex } from "./cache-key";
import type {
  GraphEdge,
  GraphNode,
  NodeOutput,
  NodeRegistry,
  NodeRuntime,
  NodeSpec,
} from "./types";

export class GraphCycleError extends Error {
  constructor(public readonly involved: string[]) {
    super(`graph has a cycle involving: ${involved.join(", ")}`);
    this.name = "GraphCycleError";
  }
}

function specFor(registry: NodeRegistry, node: GraphNode): NodeSpec {
  const spec = registry[node.type];
  if (!spec) throw new Error(`no registry entry for node type "${node.type}" (id ${node.id})`);
  return spec;
}

/** Kahn's algorithm. Deterministic: ties break on the caller's node order. */
export function topoOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const edge of edges) {
    // Edges pointing at deleted nodes are ignored rather than throwing: React Flow
    // can hand us a dangling edge for a frame during a node deletion.
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (order.length !== ids.length) {
    throw new GraphCycleError(ids.filter((id) => !order.includes(id)));
  }
  return order;
}

/** Every ancestor of `nodeId` plus itself, in execution order. */
export function upstreamOf(nodeId: string, nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const incoming = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (incoming.has(edge.target)) incoming.get(edge.target)!.push(edge.source);
  }
  const needed = new Set<string>();
  const walk = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const parent of incoming.get(id) ?? []) walk(parent);
  };
  walk(nodeId);
  return topoOrder(nodes, edges).filter((id) => needed.has(id));
}

/**
 * A downstream node's identity must distinguish *which* output port it consumes, so
 * the upstream key alone is not enough. Folding the port name in keeps the value a
 * valid sha256 (what artifactCacheKey validates) while staying deterministic.
 */
function portIdentity(upstreamKey: string, sourcePort: string): string {
  return sha256Hex(`${upstreamKey}/${sourcePort}`);
}

/**
 * Desired cache key per node id, in execution order.
 *
 * Keys are derived from the node *type*, not its id, so two identically configured
 * nodes fed identical inputs share a key — duplicating a node is free.
 */
export function computeDesiredKeys(
  nodes: GraphNode[],
  edges: GraphEdge[],
  registry: NodeRegistry,
): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keys = new Map<string, string>();

  for (const id of topoOrder(nodes, edges)) {
    const node = byId.get(id)!;
    const spec = specFor(registry, node);
    const inputContentSha256: Record<string, string> = {};
    for (const edge of edges) {
      if (edge.target !== id) continue;
      const upstreamKey = keys.get(edge.source);
      if (upstreamKey === undefined) continue; // dangling edge
      inputContentSha256[edge.targetPort] = portIdentity(upstreamKey, edge.sourcePort);
    }
    keys.set(
      id,
      artifactCacheKey({
        producerNode: node.type,
        producerVersion: spec.version,
        inputContentSha256,
        parameters: node.params,
      }),
    );
  }
  return keys;
}

/** A node is stale when what it holds is not what its current configuration wants. */
export function isStale(runtime: NodeRuntime | undefined, desiredKey: string): boolean {
  if (!runtime || runtime.outputs === null) return true;
  return runtime.heldKey !== desiredKey;
}

export interface RunReport {
  ran: string[];
  /** Cache hits — the held key already matched, so the node was skipped. */
  reused: string[];
  /** Could not run: required input missing, or an upstream node is not up to date. */
  blocked: string[];
  failed: string[];
}

export interface RunOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  registry: NodeRegistry;
  runtime: Record<string, NodeRuntime>;
  /** Run only what this node needs. Omit to evaluate the whole graph. */
  target?: string;
  /**
   * Which manual (`auto: false`) nodes may run this pass. `true` allows all.
   * Anything not allowed stays stale and blocks its descendants — that is what
   * stops a slider drag from billing a GPU run.
   */
  allowManual?: boolean | ReadonlySet<string>;
  onChange: (id: string, patch: Partial<NodeRuntime>) => void;
  signal?: AbortSignal;
  now?: () => number;
}

function mayRun(node: GraphNode, allow: RunOptions["allowManual"]): boolean {
  if (node.auto) return true;
  if (allow === true) return true;
  if (!allow) return false;
  return allow.has(node.id);
}

export async function runGraph(options: RunOptions): Promise<RunReport> {
  const { nodes, edges, registry, runtime, onChange, signal } = options;
  const now = options.now ?? (() => performance.now());
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const desired = computeDesiredKeys(nodes, edges, registry);
  const order = options.target
    ? upstreamOf(options.target, nodes, edges)
    : topoOrder(nodes, edges);

  const report: RunReport = { ran: [], reused: [], blocked: [], failed: [] };
  // Outputs available to downstream nodes this pass, including ones just produced.
  const live = new Map<string, Record<string, NodeOutput>>();
  // Nodes whose held result matches their desired key right now. A node may only run
  // when all of its required sources are here; otherwise it would mix a fresh result
  // with a stale input and silently claim to be current.
  const upToDate = new Set<string>();

  for (const [id, state] of Object.entries(runtime)) {
    if (state.outputs && !isStale(state, desired.get(id) ?? "")) {
      upToDate.add(id);
      live.set(id, state.outputs);
    }
  }

  for (const id of order) {
    if (signal?.aborted) break;
    const node = byId.get(id)!;
    const spec = specFor(registry, node);
    const key = desired.get(id)!;

    if (upToDate.has(id)) {
      report.reused.push(id);
      onChange(id, { status: "ok" });
      continue;
    }

    const inputs: Record<string, NodeOutput> = {};
    let blocked = false;
    for (const port of spec.inputs) {
      const edge = edges.find((e) => e.target === id && e.targetPort === port.id);
      if (!edge) {
        if (port.required) blocked = true;
        continue;
      }
      const fromNode = live.get(edge.source);
      const output = fromNode?.[edge.sourcePort];
      if (!output || !upToDate.has(edge.source)) {
        blocked = true;
        continue;
      }
      inputs[port.id] = output;
    }

    if (blocked) {
      report.blocked.push(id);
      onChange(id, { status: "blocked" });
      continue;
    }

    if (!mayRun(node, options.allowManual)) {
      // Not an error — this is the paused/manual node doing its job.
      report.blocked.push(id);
      onChange(id, { status: "stale" });
      continue;
    }

    onChange(id, { status: "running", error: null });
    const started = now();
    try {
      const outputs = await spec.execute({ params: node.params, inputs, signal: signal ?? neverAborts() });
      const elapsedMs = now() - started;
      live.set(id, outputs);
      upToDate.add(id);
      report.ran.push(id);
      onChange(id, { status: "ok", heldKey: key, outputs, elapsedMs, error: null });
    } catch (err) {
      const elapsedMs = now() - started;
      report.failed.push(id);
      onChange(id, {
        status: "error",
        elapsedMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

let sharedNeverAborts: AbortSignal | undefined;
function neverAborts(): AbortSignal {
  sharedNeverAborts ??= new AbortController().signal;
  return sharedNeverAborts;
}
