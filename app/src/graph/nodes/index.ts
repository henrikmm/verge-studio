/**
 * The node registry and the graph the app opens with.
 *
 * The default graph is the M2 pipeline from the approved plan:
 *
 *   FrameSource ──frames──> DA3Depth ──depth──> PointCloud ──points──> Viewport 3D
 *                                    └──depth──────────────────────> Depth 2D
 *
 * Depth 2D taps the depth field directly rather than going through PointCloud, which
 * is the point of a graph: two views of the same wire, neither re-running the other.
 */

import type { GraphEdge, GraphNode, NodeRegistry } from "../types";
import { da3DepthSpec } from "./da3-depth";
import { frameSourceSpec } from "./frame-source";
import { pointCloudSpec } from "./point-cloud";
import { viewer2dSpec, viewer3dSpec } from "./viewers";

export const REGISTRY: NodeRegistry = {
  [frameSourceSpec.type]: frameSourceSpec,
  [da3DepthSpec.type]: da3DepthSpec,
  [pointCloudSpec.type]: pointCloudSpec,
  [viewer3dSpec.type]: viewer3dSpec,
  [viewer2dSpec.type]: viewer2dSpec,
};

/** Node ids the panes bind to. Stable, because the panes look them up by id. */
export const VIEWER_3D_ID = "viewer-3d";
export const VIEWER_2D_ID = "viewer-2d";

function node(id: string, type: string, x: number, y: number): GraphNode {
  const spec = REGISTRY[type];
  if (!spec) throw new Error(`unknown node type ${type}`);
  return {
    id,
    type,
    params: { ...spec.defaults },
    position: { x, y },
    // Seeded from the spec: DA3Depth starts paused because it costs money.
    auto: spec.execution === "auto",
  };
}

export function defaultGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: [
      node("frame-source", "frame-source", 40, 120),
      node("da3-depth", "da3-depth", 300, 120),
      node("point-cloud", "point-cloud", 560, 40),
      node(VIEWER_3D_ID, "viewer-3d", 820, 40),
      node(VIEWER_2D_ID, "viewer-2d", 560, 280),
    ],
    edges: [
      {
        id: "e-frames",
        source: "frame-source",
        sourcePort: "frames",
        target: "da3-depth",
        targetPort: "frames",
      },
      {
        id: "e-depth",
        source: "da3-depth",
        sourcePort: "depth",
        target: "point-cloud",
        targetPort: "depth",
      },
      {
        id: "e-points",
        source: "point-cloud",
        sourcePort: "points",
        target: VIEWER_3D_ID,
        targetPort: "points",
      },
      {
        id: "e-depth-2d",
        source: "da3-depth",
        sourcePort: "depth",
        target: VIEWER_2D_ID,
        targetPort: "depth",
      },
    ],
  };
}

export { da3DepthSpec, frameSourceSpec, pointCloudSpec, viewer2dSpec, viewer3dSpec };
export type { FramesValue } from "./frame-source";
export type { PointCloudValue } from "./point-cloud";
