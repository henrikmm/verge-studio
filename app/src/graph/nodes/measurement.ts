import {
  backprojectMask,
  anchorGroundPlaneToLowQuantile,
  estimateGravity,
  fitGroundPlaneTwoPass,
  fitErrorModel,
  measureHeight,
  measureVerticalExtent,
  normalize,
  percentile,
  scaleVerdict,
  signedHeight,
  type BackprojectResult,
  type ErrorModel,
  type GroundPlaneFit,
  type GravityEstimate,
  type Plane,
  type Vec3,
} from "../../../../geometry";
import {
  closestFrame,
  geometryFrame,
  type DepthFieldValue,
  type DepthFrameDescriptor,
} from "../../measurement/depth-field";
import { getMask, type MeasurementMode } from "../../measurement/measurement-store";
import type { NodeSpec } from "../types";
import type { PointCloudValue } from "./point-cloud";

export const GROUND_PLANE_ID = "ground-plane";
export const BRUSH_SELECTION_ID = "brush-selection";
export const MEASURE_HEIGHT_ID = "measure-height";
export const SCALE_CHECK_ID = "scale-check";

export interface GroundPlaneValue {
  plane: Plane;
  initial: GroundPlaneFit;
  refined: GroundPlaneFit;
  gravity: GravityEstimate;
}

export interface SelectionValue {
  objectId: string;
  frame: DepthFrameDescriptor;
  points: Float32Array;
  diagnostics: BackprojectResult;
  confidenceThreshold: number;
  maskRevision: number;
}

export interface MeasurementValue {
  objectId: string;
  mode: MeasurementMode;
  rawM: number;
  internalSpreadM: number;
  pointCount: number;
  ruler: { bottom: Vec3; top: Vec3 };
  details: Record<string, number>;
}

export interface ScaleCheckValue {
  truthM: number;
  rawM: number;
  errorM: number;
  absoluteRelativeError: number;
  correctionFactor: number;
  verdict: ReturnType<typeof scaleVerdict>;
  model: ErrorModel;
}

/** Apply a row-major 4x4 affine transform to flat xyz positions. */
export function transformPoints(
  points: ArrayLike<number>,
  transform: ArrayLike<number>,
): Float32Array {
  if (transform.length !== 16) throw new Error(`expected a 4x4 transform, got ${transform.length} values`);
  const out = new Float32Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    out[i] = transform[0] * x + transform[1] * y + transform[2] * z + transform[3];
    out[i + 1] = transform[4] * x + transform[5] * y + transform[6] * z + transform[7];
    out[i + 2] = transform[8] * x + transform[9] * y + transform[10] * z + transform[11];
  }
  return out;
}

/** Directions use only the rotation/scale part of an affine transform. */
export function transformDirection(direction: Vec3, transform: ArrayLike<number>): Vec3 {
  if (transform.length !== 16) throw new Error(`expected a 4x4 transform, got ${transform.length} values`);
  const aligned = normalize([
    transform[0] * direction[0] + transform[1] * direction[1] + transform[2] * direction[2],
    transform[4] * direction[0] + transform[5] * direction[1] + transform[6] * direction[2],
    transform[8] * direction[0] + transform[9] * direction[1] + transform[10] * direction[2],
  ]);
  if (!aligned) throw new Error("DA3 scene alignment has a degenerate rotation");
  return aligned;
}

export function resampleMaskNearest(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / targetWidth));
      out[y * targetWidth + x] = source[sy * sourceWidth + sx] ? 1 : 0;
    }
  }
  return out;
}

function percentileThreshold(values: ArrayLike<number> | undefined, p: number): number {
  if (!values) return 0;
  return percentile(values, Math.max(0, Math.min(100, p)));
}

function pointNearestHeight(points: ArrayLike<number>, plane: Plane, wanted: number): Vec3 {
  let best: Vec3 = [points[0] ?? 0, points[1] ?? 0, points[2] ?? 0];
  let bestDistance = Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const point: Vec3 = [points[i], points[i + 1], points[i + 2]];
    const distance = Math.abs(signedHeight(plane, point) - wanted);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function verticalRuler(top: Vec3, plane: Plane, height: number): { bottom: Vec3; top: Vec3 } {
  return {
    top,
    bottom: [
      top[0] - plane.normal[0] * height,
      top[1] - plane.normal[1] * height,
      top[2] - plane.normal[2] * height,
    ],
  };
}

export const groundPlaneSpec: NodeSpec = {
  type: "ground-plane",
  label: "Ground Plane",
  category: "geometry",
  version: "0.3.0",
  execution: "auto",
  inputs: [
    { id: "depth", label: "Depth Field", type: "depth_field", required: true },
    { id: "points", label: "Points", type: "point_cloud", required: true },
  ],
  outputs: [{ id: "plane", label: "Floor Plane", type: "plane" }],
  defaults: { inlierDistance: 0.035, maxTiltDeg: 30, stride: 16, iterations: 1200, candidateLowestPercent: 35, floorQuantile: 2 },
  controls: [
    { kind: "slider", key: "inlierDistance", label: "Inlier band", min: 0.01, max: 0.1, step: 0.005, suffix: " m" },
    { kind: "slider", key: "maxTiltDeg", label: "Initial tilt", min: 10, max: 45, step: 1, suffix: "°" },
    { kind: "slider", key: "stride", label: "Fit stride", min: 4, max: 32, step: 1, suffix: "×" },
    { kind: "slider", key: "iterations", label: "RANSAC", min: 250, max: 5000, step: 250 },
    { kind: "slider", key: "candidateLowestPercent", label: "Lowest proposals", min: 10, max: 100, step: 5, suffix: "%" },
    { kind: "slider", key: "floorQuantile", label: "Floor anchor", min: 0.5, max: 10, step: 0.5, suffix: "%" },
  ],
  execute: async ({ inputs, params }) => {
    const field = inputs.depth?.value as DepthFieldValue | undefined;
    const cloud = inputs.points?.value as PointCloudValue | undefined;
    if (!field || !cloud) throw new Error("ground plane needs matching depth and point cloud");
    const arrays = await field.loadArrays();
    const extrinsics = arrays.extrinsics;
    if (!extrinsics) throw new Error("NPZ has no extrinsics");
    const rawGravity = estimateGravity(extrinsics.data);
    const gravity: GravityEstimate = {
      ...rawGravity,
      up: transformDirection(rawGravity.up, cloud.worldFromDa3),
    };
    if (gravity.coherence < 0.7) {
      throw new Error(`camera up is incoherent (${gravity.coherence.toFixed(2)}); do not fit a floor automatically`);
    }
    const fit = fitGroundPlaneTwoPass(cloud.positions, {
      up: gravity.up,
      maxTiltDeg: Number(params.maxTiltDeg),
      inlierDistance: Number(params.inlierDistance),
      iterations: Number(params.iterations),
      stride: Number(params.stride),
      candidateLowestFraction: Number(params.candidateLowestPercent) / 100,
      minInliers: 100,
      supportRatio: 0.02,
      maxBelowFraction: 0.2,
      seed: 7,
    });
    const anchored = anchorGroundPlaneToLowQuantile(
      cloud.positions,
      fit.refined,
      Number(params.floorQuantile),
      Number(params.stride),
      Number(params.inlierDistance),
    );
    const value: GroundPlaneValue = {
      plane: anchored.plane,
      initial: fit.initial,
      refined: anchored,
      gravity,
    };
    return {
      plane: {
        type: "plane",
        value,
        summary: `${(anchored.inlierFraction * 100).toFixed(1)}% floor · ${(anchored.rmse * 100).toFixed(1)} cm RMSE`,
      },
    };
  },
};

export const brushSelectionSpec: NodeSpec = {
  type: "brush-selection",
  label: "Brush Selection",
  category: "analysis",
  version: "0.3.0",
  execution: "auto",
  inputs: [
    { id: "depth", label: "Depth Field", type: "depth_field", required: true },
    { id: "points", label: "Point Cloud", type: "point_cloud", required: true },
  ],
  outputs: [{ id: "selection", label: "Selected Points", type: "selection" }],
  defaults: {
    objectId: "door-leaf",
    canonicalFrame: 143,
    maskRevision: 0,
    confidencePercentile: 20,
    erodeRadius: 2,
    maxRelativeDepthStep: 0.08,
  },
  controls: [
    { kind: "readout", key: "objectId", label: "Object" },
    { kind: "readout", key: "canonicalFrame", label: "Frame" },
    { kind: "slider", key: "confidencePercentile", label: "Drop lowest", min: 0, max: 80, step: 5, suffix: "%" },
    { kind: "slider", key: "erodeRadius", label: "Erode", min: 0, max: 6, step: 1, suffix: " px" },
    { kind: "slider", key: "maxRelativeDepthStep", label: "Edge gate", min: 0, max: 0.25, step: 0.01 },
  ],
  execute: async ({ inputs, params }) => {
    const field = inputs.depth?.value as DepthFieldValue | undefined;
    const cloud = inputs.points?.value as PointCloudValue | undefined;
    if (!field || !cloud) throw new Error("selection needs matching depth and point cloud");
    const objectId = String(params.objectId);
    const requestedFrame = Number(params.canonicalFrame);
    const descriptor = closestFrame(field, requestedFrame);
    if (!descriptor) throw new Error("depth field has no frames");
    const arrays = await field.loadArrays();
    const frame = geometryFrame(arrays, descriptor);
    const mask = getMask(objectId, requestedFrame);
    if (!mask) {
      const empty: BackprojectResult = {
        points: new Float32Array(),
        pointCount: 0,
        maskedPixels: 0,
        rejected: { eroded: 0, depth: 0, confidence: 0, discontinuity: 0 },
      };
      return {
        selection: {
          type: "selection",
          value: {
            objectId,
            frame: descriptor,
            points: empty.points,
            diagnostics: empty,
            confidenceThreshold: 0,
            maskRevision: Number(params.maskRevision),
          } satisfies SelectionValue,
          summary: "paint a mask in Depth 2D",
        },
      };
    }
    const sampledMask = resampleMaskNearest(mask.data, mask.width, mask.height, frame.width, frame.height);
    const threshold = percentileThreshold(frame.confidence, Number(params.confidencePercentile));
    const result = backprojectMask(frame, sampledMask, {
      erodeRadius: Number(params.erodeRadius),
      minConfidence: threshold,
      maxRelativeDepthStep: Number(params.maxRelativeDepthStep),
    });
    // The NPZ stores DA3's raw reconstruction frame. The GLB stores the same scene
    // after its first-camera/glTF display transform was applied. Put the selected
    // pixels into that displayed frame before measuring or highlighting them.
    result.points = transformPoints(result.points, cloud.worldFromDa3);
    const value: SelectionValue = {
      objectId,
      frame: descriptor,
      points: result.points,
      diagnostics: result,
      confidenceThreshold: threshold,
      maskRevision: mask.revision,
    };
    return {
      selection: {
        type: "selection",
        value,
        summary: `${result.pointCount.toLocaleString()} pts · frame ${descriptor.canonicalIndex}`,
      },
    };
  },
};

export const measureHeightSpec: NodeSpec = {
  type: "measure-height",
  label: "Measure Height",
  category: "geometry",
  version: "0.2.0",
  execution: "auto",
  inputs: [
    { id: "selection", label: "Selection", type: "selection", required: true },
    { id: "plane", label: "Floor Plane", type: "plane", required: true },
  ],
  outputs: [{ id: "measurement", label: "Measurement", type: "measurement" }],
  defaults: { mode: "top_above_floor", percentile: 98, lowerPercentile: 2, minPoints: 80 },
  controls: [
    {
      kind: "select",
      key: "mode",
      label: "Definition",
      options: [
        { value: "top_above_floor", label: "top above floor" },
        { value: "vertical_extent", label: "object vertical extent" },
      ],
    },
    { kind: "slider", key: "percentile", label: "Upper", min: 90, max: 99.5, step: 0.5, suffix: "%" },
    { kind: "slider", key: "lowerPercentile", label: "Lower", min: 0.5, max: 10, step: 0.5, suffix: "%" },
    { kind: "slider", key: "minPoints", label: "Min points", min: 20, max: 1000, step: 20 },
  ],
  execute: async ({ inputs, params }) => {
    const selection = inputs.selection?.value as SelectionValue | undefined;
    const ground = inputs.plane?.value as GroundPlaneValue | undefined;
    if (!selection || !ground) throw new Error("measurement needs a selection and a floor");
    if (selection.points.length === 0) throw new Error("paint an object mask before measuring");
    const mode = String(params.mode) as MeasurementMode;
    let rawM: number;
    let internalSpreadM: number;
    let topHeight: number;
    let details: Record<string, number>;
    if (mode === "vertical_extent") {
      const result = measureVerticalExtent(selection.points, ground.plane, {
        lowerPercentile: Number(params.lowerPercentile),
        upperPercentile: Number(params.percentile),
        minPoints: Number(params.minPoints),
      });
      rawM = result.height;
      internalSpreadM = result.uncertainty;
      topHeight = result.top;
      details = { bottomM: result.bottom, topM: result.top, bottomRoughnessM: result.bottomRoughness, topRoughnessM: result.topRoughness };
    } else {
      const result = measureHeight(selection.points, ground.plane, {
        percentile: Number(params.percentile),
        minPoints: Number(params.minPoints),
        planeRmse: ground.refined.rmse,
      });
      rawM = result.height;
      internalSpreadM = result.uncertainty;
      topHeight = result.height;
      details = { topRoughnessM: result.topRoughness, floorRmseM: ground.refined.rmse, maxHeightM: result.maxHeight };
    }
    const top = pointNearestHeight(selection.points, ground.plane, topHeight);
    const value: MeasurementValue = {
      objectId: selection.objectId,
      mode,
      rawM,
      internalSpreadM,
      pointCount: selection.diagnostics.pointCount,
      ruler: verticalRuler(top, ground.plane, rawM),
      details,
    };
    return {
      measurement: {
        type: "measurement",
        value,
        summary: `${rawM.toFixed(3)} m · spread ${internalSpreadM.toFixed(3)} m`,
      },
    };
  },
};

export const scaleCheckSpec: NodeSpec = {
  type: "scale-check",
  label: "Scale Check",
  category: "analysis",
  version: "0.2.0",
  execution: "auto",
  inputs: [{ id: "measurement", label: "Measurement", type: "measurement", required: true }],
  outputs: [{ id: "check", label: "Scale Evidence", type: "measurement" }],
  defaults: { truthM: 2.1 },
  controls: [{ kind: "slider", key: "truthM", label: "Known truth", min: 0.05, max: 3, step: 0.001, suffix: " m" }],
  execute: async ({ inputs, params }) => {
    const measurement = inputs.measurement?.value as MeasurementValue | undefined;
    if (!measurement) throw new Error("scale check has no measurement");
    const truthM = Number(params.truthM);
    const observation = { id: measurement.objectId, truth: truthM, predicted: measurement.rawM, uncertainty: measurement.internalSpreadM };
    const model = fitErrorModel([observation]);
    const value: ScaleCheckValue = {
      truthM,
      rawM: measurement.rawM,
      errorM: measurement.rawM - truthM,
      absoluteRelativeError: Math.abs(measurement.rawM - truthM) / truthM,
      correctionFactor: model.scaleFactor,
      verdict: scaleVerdict(observation),
      model,
    };
    return {
      check: {
        type: "measurement",
        value,
        summary: `${value.errorM >= 0 ? "+" : ""}${value.errorM.toFixed(3)} m · ${(value.absoluteRelativeError * 100).toFixed(1)}%`,
      },
    };
  },
};
