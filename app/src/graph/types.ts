/**
 * The node-graph data model.
 *
 * Ports are typed so a depth field can never be wired into a camera input, and the
 * wire inherits its source port's color (docs/DESIGN.md). Every node declares a
 * `version` that goes into its cache key, so fixing a node's code invalidates the
 * results it produced before the fix.
 */

import type { JsonValue } from "./cache-key";

export type PortType =
  | "frames"
  | "depth_field"
  | "point_cloud"
  | "plane"
  | "selection"
  | "measurement"
  | "camera"
  | "scalar";

/** Straight from the port/wire color table in docs/DESIGN.md. */
export const PORT_COLORS: Record<PortType, string> = {
  frames: "#d8d8d8",
  depth_field: "#5aa0e8",
  point_cloud: "#4ade80",
  plane: "#f3c969",
  selection: "#fb7185",
  measurement: "#e8a95b",
  camera: "#e879a0",
  scalar: "#f59e0b",
};

/**
 * Node header hues, ~35% saturation per DESIGN.md's reading of the Sentinel
 * reference: purple for sources/generators, teal for analysis, magenta for the
 * geometry stage, muted blue for sinks.
 */
export type NodeCategory = "source" | "analysis" | "geometry" | "sink";

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  source: "#5b4a7d",
  analysis: "#356b70",
  geometry: "#7d4a63",
  sink: "#454f70",
};

/**
 * Whether a node may run without being asked.
 *
 * `manual` exists for one reason: `DA3Depth` costs money. An auto node re-runs as
 * soon as its inputs change; a manual node goes stale and waits for an explicit Run,
 * so dragging a slider can never trigger cloud inference. See the paid-work rule in AGENTS.md.
 */
export type ExecutionKind = "auto" | "manual";

export interface PortSpec {
  id: string;
  /** Ports are labelled text rows in the card, not bare dots (DESIGN.md). */
  label: string;
  type: PortType;
  /** An unconnected required input blocks the node instead of running it empty. */
  required?: boolean;
}

export type Params = Record<string, JsonValue>;

/** What flows along a wire. `value` is node-specific; the port type constrains it. */
export interface NodeOutput {
  type: PortType;
  value: unknown;
  /** Drawn in the node card's thumbnail slot when present. */
  thumbnailUrl?: string;
  /** Short mono line under the thumbnail, e.g. "351,232 pts". */
  summary?: string;
  /**
   * Release resources owned only by this output.
   *
   * Most outputs are plain data and omit this. Point clouds own WebGL buffers, though, and a
   * content-addressed replacement must release the old buffers instead of trusting the browser
   * to notice that a Three.js object became unreachable.
   */
  dispose?: () => void;
}

/** Dispose a node result once it is no longer reachable from the graph. */
export function disposeNodeOutputs(outputs: Record<string, NodeOutput> | null | undefined): void {
  if (!outputs) return;
  for (const output of Object.values(outputs)) output.dispose?.();
}

export interface ExecuteContext {
  params: Params;
  /** Keyed by this node's input port id. Absent for unconnected optional inputs. */
  inputs: Record<string, NodeOutput>;
  signal: AbortSignal;
}

/** Resolves to the node's outputs, keyed by output port id. */
export type Executor = (ctx: ExecuteContext) => Promise<Record<string, NodeOutput>>;

/**
 * How the inspector renders a parameter. Declared on the node so the inspector stays
 * generic — adding a node adds its controls, with no inspector change. DESIGN.md asks
 * for mixed control types, not sliders only.
 */
interface ControlBase {
  key: string;
  label: string;
  /**
   * What this control is, in a sentence or two — rendered behind a `?` beside the label.
   *
   * DESIGN.md draws the line here: text explaining what a control *is* goes behind the dot,
   * text about the state the app is in right now stays on the page. A native `title` is not
   * an acceptable home for a paragraph — a second of delay, an OS-styled light box, and
   * nothing at all for a keyboard.
   */
  help?: string;
}

export type ControlSpec =
  | (ControlBase & {
      kind: "slider";
      min: number;
      max: number;
      step?: number;
      suffix?: string;
    })
  | (ControlBase & { kind: "select"; options: { value: string; label: string }[] })
  | (ControlBase & { kind: "checkbox" })
  | (ControlBase & { kind: "readout" });

export interface NodeSpec {
  type: string;
  label: string;
  category: NodeCategory;
  /** Bump on any behaviour change — it is part of every cache key this node produces. */
  version: string;
  execution: ExecutionKind;
  inputs: PortSpec[];
  outputs: PortSpec[];
  defaults: Params;
  /**
   * Optional input switch for nodes that expose alternate branches. Inactive ports
   * neither block execution nor participate in the content-addressed cache key.
   */
  activeInputs?: (params: Params) => readonly string[];
  /**
   * Parameters that define one output's semantic content.
   *
   * Omit for the normal case where every parameter changes every output. A node with a
   * display-only control can keep its measurement output stable, so downstream measurements do
   * not rerun merely because point size or display density changed.
   */
  outputParameters?: (outputPort: string, params: Params) => Params;
  /** Inspector rows, in the order they should appear. */
  controls?: ControlSpec[];
  execute: Executor;
}

export type NodeRegistry = Record<string, NodeSpec>;

export function portColor(type: PortType): string {
  return PORT_COLORS[type];
}

export interface GraphNode {
  id: string;
  /** Key into the registry. */
  type: string;
  params: Params;
  position: { x: number; y: number };
  /**
   * The `A`/`P` badge. Seeded from the spec's `execution` but user-overridable in
   * both directions: pin an auto node to stop it re-running, or opt a manual node
   * into auto if you accept the cost.
   */
  auto: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

/**
 * `stale` — parameters moved and the held result no longer matches.
 * `blocked` — cannot run: a required input is unconnected, or an upstream node is
 * itself stale/failed, so running would mix fresh output with old input.
 */
export type NodeStatus = "idle" | "stale" | "blocked" | "running" | "ok" | "error";

export interface NodeRuntime {
  status: NodeStatus;
  /** Cache key of the result currently held. Null until the node has produced one. */
  heldKey: string | null;
  outputs: Record<string, NodeOutput> | null;
  elapsedMs: number;
  error: string | null;
}

export function emptyRuntime(): NodeRuntime {
  return { status: "idle", heldKey: null, outputs: null, elapsedMs: 0, error: null };
}
