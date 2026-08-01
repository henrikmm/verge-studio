/**
 * Sinks. "The graph is the program — viewports are taps on wires" (docs/DESIGN.md),
 * so these nodes compute nothing. A pane binds to one and renders whatever arrives
 * on its input; rewiring the input changes what the pane shows, with no re-run.
 *
 * They still participate in cache keys, which is what makes a pane go visibly stale
 * the moment an upstream parameter moves.
 */

import type { NodeSpec } from "../types";

export const viewer3dSpec: NodeSpec = {
  type: "viewer-3d",
  label: "Viewport 3D",
  category: "sink",
  version: "0.1.0",
  execution: "auto",
  inputs: [{ id: "points", label: "Points", type: "point_cloud", required: true }],
  outputs: [],
  defaults: {},
  execute: async () => ({}),
};

export const viewer2dSpec: NodeSpec = {
  type: "viewer-2d",
  label: "Depth 2D",
  category: "sink",
  version: "0.1.0",
  execution: "auto",
  inputs: [{ id: "depth", label: "Depth Field", type: "depth_field", required: true }],
  outputs: [],
  defaults: {},
  execute: async () => ({}),
};
