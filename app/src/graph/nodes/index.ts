/**
 * The node registry and the graph the app opens with.
 *
 * The default graph keeps the paid live path and the reproducible evidence path in
 * one honest data flow:
 *
 *   FrameSource ──> DA3Depth ──live──> RunSource ──> measurement pipeline
 *                                      (or recorded fixture)
 *
 * Depth 2D taps the depth field directly rather than going through PointCloud, which
 * is the point of a graph: two views of the same wire, neither re-running the other.
 */

import type { GraphEdge, GraphNode, NodeRegistry } from "../types";
import { da3DepthSpec } from "./da3-depth";
import { frameSourceSpec } from "./frame-source";
import { fixtureRunSpec } from "./fixture-run";
import {
  BRUSH_SELECTION_ID,
  GROUND_PLANE_ID,
  MEASURE_HEIGHT_ID,
  SCALE_CHECK_ID,
  brushSelectionSpec,
  groundPlaneSpec,
  measureHeightSpec,
  scaleCheckSpec,
} from "./measurement";
import { pointCloudSpec } from "./point-cloud";
import { viewer2dSpec, viewer3dSpec } from "./viewers";

export const REGISTRY: NodeRegistry = {
  [frameSourceSpec.type]: frameSourceSpec,
  [fixtureRunSpec.type]: fixtureRunSpec,
  [da3DepthSpec.type]: da3DepthSpec,
  [pointCloudSpec.type]: pointCloudSpec,
  [groundPlaneSpec.type]: groundPlaneSpec,
  [brushSelectionSpec.type]: brushSelectionSpec,
  [measureHeightSpec.type]: measureHeightSpec,
  [scaleCheckSpec.type]: scaleCheckSpec,
  [viewer3dSpec.type]: viewer3dSpec,
  [viewer2dSpec.type]: viewer2dSpec,
};

/** Node ids the panes bind to. Stable, because the panes look them up by id. */
export const VIEWER_3D_ID = "viewer-3d";
export const VIEWER_2D_ID = "viewer-2d";
export const FIXTURE_RUN_ID = "fixture-run";

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
      node("frame-source", "frame-source", 20, 20),
      node("da3-depth", "da3-depth", 220, 20),
      node(FIXTURE_RUN_ID, "fixture-run", 420, 120),
      node("point-cloud", "point-cloud", 620, 20),
      node(GROUND_PLANE_ID, "ground-plane", 820, 20),
      node(BRUSH_SELECTION_ID, "brush-selection", 820, 260),
      node(MEASURE_HEIGHT_ID, "measure-height", 1020, 140),
      node(SCALE_CHECK_ID, "scale-check", 1220, 220),
      node(VIEWER_3D_ID, "viewer-3d", 1220, 0),
      node(VIEWER_2D_ID, "viewer-2d", 620, 360),
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
        id: "e-live-source",
        source: "da3-depth",
        sourcePort: "depth",
        target: FIXTURE_RUN_ID,
        targetPort: "live",
      },
      {
        id: "e-fixture-points",
        source: FIXTURE_RUN_ID,
        sourcePort: "depth",
        target: "point-cloud",
        targetPort: "depth",
      },
      { id: "e-fixture-ground", source: FIXTURE_RUN_ID, sourcePort: "depth", target: GROUND_PLANE_ID, targetPort: "depth" },
      { id: "e-points-ground", source: "point-cloud", sourcePort: "points", target: GROUND_PLANE_ID, targetPort: "points" },
      { id: "e-fixture-selection", source: FIXTURE_RUN_ID, sourcePort: "depth", target: BRUSH_SELECTION_ID, targetPort: "depth" },
      { id: "e-points-selection", source: "point-cloud", sourcePort: "points", target: BRUSH_SELECTION_ID, targetPort: "points" },
      { id: "e-selection-measure", source: BRUSH_SELECTION_ID, sourcePort: "selection", target: MEASURE_HEIGHT_ID, targetPort: "selection" },
      { id: "e-ground-measure", source: GROUND_PLANE_ID, sourcePort: "plane", target: MEASURE_HEIGHT_ID, targetPort: "plane" },
      { id: "e-measure-scale", source: MEASURE_HEIGHT_ID, sourcePort: "measurement", target: SCALE_CHECK_ID, targetPort: "measurement" },
      {
        id: "e-points",
        source: "point-cloud",
        sourcePort: "points",
        target: VIEWER_3D_ID,
        targetPort: "points",
      },
      {
        id: "e-depth-2d",
        source: FIXTURE_RUN_ID,
        sourcePort: "depth",
        target: VIEWER_2D_ID,
        targetPort: "depth",
      },
      { id: "e-ground-view", source: GROUND_PLANE_ID, sourcePort: "plane", target: VIEWER_3D_ID, targetPort: "plane" },
      { id: "e-selection-view", source: BRUSH_SELECTION_ID, sourcePort: "selection", target: VIEWER_3D_ID, targetPort: "selection" },
      { id: "e-measure-view", source: MEASURE_HEIGHT_ID, sourcePort: "measurement", target: VIEWER_3D_ID, targetPort: "measurement" },
    ],
  };
}

export {
  BRUSH_SELECTION_ID,
  GROUND_PLANE_ID,
  MEASURE_HEIGHT_ID,
  SCALE_CHECK_ID,
  brushSelectionSpec,
  da3DepthSpec,
  fixtureRunSpec,
  frameSourceSpec,
  groundPlaneSpec,
  measureHeightSpec,
  pointCloudSpec,
  scaleCheckSpec,
  viewer2dSpec,
  viewer3dSpec,
};
export type { FramesValue } from "./frame-source";
export type { PointCloudValue, CloudSource, CloudColour } from "./point-cloud";
export { POINT_CLOUD_ID, CLOUD_SOURCES, CLOUD_COLOURS, CLOUD_BUDGETS } from "./point-cloud";
export type { GroundPlaneValue, MeasurementValue, ScaleCheckValue, SelectionValue } from "./measurement";
