import {
  backprojectMask,
  composeUncertainty,
  estimateGravity,
  fitGroundPlaneRobust,
  fitErrorModel,
  measureHeight,
  measureVerticalExtent,
  normalize,
  percentile,
  scaleVerdict,
  selectEndpointEvidence,
  signedHeight,
  type BackprojectResult,
  type ErrorModel,
  type GravityEstimate,
  type Plane,
  type RobustGroundPlaneFit,
  type Vec3,
} from "../../../../geometry";
import {
  closestFrame,
  geometryFrame,
  type DepthFieldValue,
  type DepthFrameDescriptor,
} from "../../measurement/depth-field";
import {
  getMask,
  type MaskSource,
  type MeasurementMode,
  type SegmentationProvenance,
} from "../../measurement/measurement-store";
import type { NodeSpec } from "../types";
import type { PointCloudValue } from "./point-cloud";

export const GROUND_PLANE_ID = "ground-plane";
export const BRUSH_SELECTION_ID = "brush-selection";
export const MEASURE_HEIGHT_ID = "measure-height";
export const SCALE_CHECK_ID = "scale-check";

export interface GroundPlaneValue {
  plane: Plane;
  fit: RobustGroundPlaneFit;
  gravity: GravityEstimate;
  evidence: {
    points: Float32Array;
    center: Vec3;
    radius: number;
  };
}

export interface SelectionValue {
  objectId: string;
  frame: DepthFrameDescriptor;
  points: Float32Array;
  diagnostics: BackprojectResult;
  confidenceThreshold: number;
  maskRevision: number;
  maskSource: MaskSource;
  segmentation?: SegmentationProvenance;
}

export interface MeasurementValue {
  objectId: string;
  mode: MeasurementMode;
  rawM: number;
  internalSpreadM: number;
  pointCount: number;
  ruler: { bottom: Vec3; top: Vec3 };
  rulerKind: "floor_height" | "extent";
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
  /**
   * The random half-width this verdict was judged against — patch roughness only, because a
   * single node sees one measurement and cannot know the operator spread or the clip's scale.
   * The full budget is composed in the Objects pane, which has the trials and the error model.
   */
  randomM: number;
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

function pointBandCentroid(
  points: ArrayLike<number>,
  plane: Plane,
  wanted: number,
  band = 0.05,
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const point: Vec3 = [points[i], points[i + 1], points[i + 2]];
    if (Math.abs(signedHeight(plane, point) - wanted) > band) continue;
    x += point[0];
    y += point[1];
    z += point[2];
    count += 1;
  }
  return count > 0 ? [x / count, y / count, z / count] : pointNearestHeight(points, plane, wanted);
}

function verticalRuler(
  tangentAnchor: Vec3,
  plane: Plane,
  bottomHeight: number,
  topHeight: number,
): { bottom: Vec3; top: Vec3 } {
  const anchorHeight = signedHeight(plane, tangentAnchor);
  const base: Vec3 = [
    tangentAnchor[0] - plane.normal[0] * anchorHeight,
    tangentAnchor[1] - plane.normal[1] * anchorHeight,
    tangentAnchor[2] - plane.normal[2] * anchorHeight,
  ];
  return {
    bottom: [
      base[0] + plane.normal[0] * bottomHeight,
      base[1] + plane.normal[1] * bottomHeight,
      base[2] + plane.normal[2] * bottomHeight,
    ],
    top: [
      base[0] + plane.normal[0] * topHeight,
      base[1] + plane.normal[1] * topHeight,
      base[2] + plane.normal[2] * topHeight,
    ],
  };
}

function collectPlaneEvidence(
  points: ArrayLike<number>,
  plane: Plane,
  band: number,
  stride: number,
): GroundPlaneValue["evidence"] {
  const selected: number[] = [];
  let x = 0;
  let y = 0;
  let z = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(stride));
  for (let i = 0; i + 2 < points.length; i += 3 * step) {
    const point: Vec3 = [points[i], points[i + 1], points[i + 2]];
    if (Math.abs(signedHeight(plane, point)) > band) continue;
    selected.push(...point);
    x += point[0];
    y += point[1];
    z += point[2];
    count += 1;
  }
  if (count === 0) throw new Error("fitted floor has no displayable supporting points");
  const rawCenter: Vec3 = [x / count, y / count, z / count];
  const centerHeight = signedHeight(plane, rawCenter);
  const center: Vec3 = [
    rawCenter[0] - plane.normal[0] * centerHeight,
    rawCenter[1] - plane.normal[1] * centerHeight,
    rawCenter[2] - plane.normal[2] * centerHeight,
  ];
  const radii: number[] = [];
  for (let i = 0; i + 2 < selected.length; i += 3) {
    const dx = selected[i] - center[0];
    const dy = selected[i + 1] - center[1];
    const dz = selected[i + 2] - center[2];
    const normalDistance = dx * plane.normal[0] + dy * plane.normal[1] + dz * plane.normal[2];
    radii.push(Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - normalDistance * normalDistance)));
  }
  return {
    points: Float32Array.from(selected),
    center,
    radius: Math.max(0.2, percentile(radii, 90)),
  };
}

export const groundPlaneSpec: NodeSpec = {
  type: "ground-plane",
  label: "Ground Plane",
  category: "geometry",
  version: "0.4.0",
  execution: "auto",
  inputs: [
    { id: "depth", label: "Depth Field", type: "depth_field", required: true },
    { id: "points", label: "Points", type: "point_cloud", required: true },
  ],
  outputs: [{ id: "plane", label: "Floor Plane", type: "plane" }],
  defaults: { inlierDistance: 0.035, maxTiltDeg: 30, stride: 16, iterations: 1200 },
  controls: [
    { kind: "slider", key: "inlierDistance", label: "Inlier band", min: 0.01, max: 0.1, step: 0.005, suffix: " m" },
    { kind: "slider", key: "maxTiltDeg", label: "Initial tilt", min: 10, max: 45, step: 1, suffix: "°" },
    { kind: "slider", key: "stride", label: "Fit stride", min: 4, max: 32, step: 1, suffix: "×" },
    { kind: "slider", key: "iterations", label: "RANSAC", min: 250, max: 5000, step: 250 },
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
    const fit = fitGroundPlaneRobust(cloud.positions, {
      up: gravity.up,
      maxTiltDeg: Number(params.maxTiltDeg),
      inlierDistance: Number(params.inlierDistance),
      iterations: Number(params.iterations),
      stride: Number(params.stride),
      minInliers: 100,
      minInlierFraction: 0.01,
      proposalFractions: [1, 0.35],
      supportRatio: 0.1,
      maxBelowFraction: 0.2,
      seed: 7,
    });
    const evidence = collectPlaneEvidence(
      cloud.positions,
      fit.plane,
      Number(params.inlierDistance),
      Number(params.stride),
    );
    const value: GroundPlaneValue = {
      plane: fit.plane,
      fit,
      gravity,
      evidence,
    };
    return {
      plane: {
        type: "plane",
        value,
        summary: `${(fit.inlierFraction * 100).toFixed(1)}% support · ${fit.tiltDeg.toFixed(1)}° tilt · ${(fit.rmse * 100).toFixed(1)} cm RMSE`,
      },
    };
  },
};

export const brushSelectionSpec: NodeSpec = {
  type: "brush-selection",
  label: "Brush Selection",
  category: "analysis",
  version: "0.4.0",
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
            maskSource: "brush",
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
      maskSource: mask.source,
      segmentation: mask.segmentation,
    };
    return {
      selection: {
        type: "selection",
        value,
        summary: `${result.pointCount.toLocaleString()} pts · ${mask.source} · frame ${descriptor.canonicalIndex}`,
      },
    };
  },
};

export const measureHeightSpec: NodeSpec = {
  type: "measure-height",
  label: "Measure Height",
  category: "geometry",
  version: "0.4.1",
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
    if (selection.segmentation && !selection.segmentation.accepted) {
      return {
        measurement: {
          type: "measurement",
          value: null,
          summary: "height withheld · accept the automatic mask",
        },
      };
    }
    if (selection.segmentation && selection.objectId === "monitor-own") {
      return {
        measurement: {
          type: "measurement",
          value: null,
          summary: "automatic height unavailable · stand contact is occluded",
        },
      };
    }
    const mode = String(params.mode) as MeasurementMode;
    let measurementPoints = selection.points;
    let endpointPointCount = 0;
    let pointsPerEnd = 0;
    let fullMaskControlM = NaN;
    if (selection.segmentation && mode === "vertical_extent") {
      fullMaskControlM = measureVerticalExtent(selection.points, ground.plane, {
        lowerPercentile: Number(params.lowerPercentile),
        upperPercentile: Number(params.percentile),
        minPoints: Number(params.minPoints),
      }).height;
      const endpointEvidence = selectEndpointEvidence(selection.points, ground.plane, {
        tailFraction: 0.1,
        minPointsPerEnd: 40,
      });
      measurementPoints = endpointEvidence.points;
      endpointPointCount = endpointEvidence.points.length / 3;
      pointsPerEnd = endpointEvidence.pointsPerEnd;
    }
    let rawM: number;
    let internalSpreadM: number;
    let topHeight: number;
    let bottomHeight: number;
    let rulerAnchor: Vec3;
    let rulerKind: MeasurementValue["rulerKind"];
    let details: Record<string, number>;
    if (mode === "vertical_extent") {
      const result = measureVerticalExtent(measurementPoints, ground.plane, {
        lowerPercentile: Number(params.lowerPercentile),
        upperPercentile: Number(params.percentile),
        minPoints: Number(params.minPoints),
      });
      rawM = result.height;
      internalSpreadM = result.uncertainty;
      bottomHeight = result.bottom;
      topHeight = result.top;
      const bottomCentroid = pointBandCentroid(measurementPoints, ground.plane, result.bottom);
      const topCentroid = pointBandCentroid(measurementPoints, ground.plane, result.top);
      rulerAnchor = [
        (bottomCentroid[0] + topCentroid[0]) / 2,
        (bottomCentroid[1] + topCentroid[1]) / 2,
        (bottomCentroid[2] + topCentroid[2]) / 2,
      ];
      rulerKind = "extent";
      details = {
        bottomM: result.bottom,
        topM: result.top,
        bottomRoughnessM: result.bottomRoughness,
        topRoughnessM: result.topRoughness,
        ...(endpointPointCount > 0
          ? {
              endpointPointCount,
              pointsPerEnd,
              fullMaskControlM,
              endpointAdapterDeltaM: result.height - fullMaskControlM,
            }
          : {}),
      };
    } else {
      const result = measureHeight(selection.points, ground.plane, {
        percentile: Number(params.percentile),
        minPoints: Number(params.minPoints),
        planeRmse: ground.fit.rmse,
      });
      rawM = result.height;
      internalSpreadM = result.uncertainty;
      bottomHeight = 0;
      topHeight = result.height;
      rulerAnchor = pointBandCentroid(selection.points, ground.plane, result.height);
      rulerKind = "floor_height";
      details = { topRoughnessM: result.topRoughness, floorRmseM: ground.fit.rmse, maxHeightM: result.maxHeight };
    }
    const value: MeasurementValue = {
      objectId: selection.objectId,
      mode,
      rawM,
      internalSpreadM,
      pointCount: selection.diagnostics.pointCount,
      ruler: verticalRuler(rulerAnchor, ground.plane, bottomHeight, topHeight),
      rulerKind,
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
    if (!measurement) {
      return {
        check: { type: "measurement", value: null, summary: "height withheld" },
      };
    }
    const truthM = Number(params.truthM);
    // What this verdict answers is "is the error explainable by point noise, or is it bias?" —
    // NOT "is the measurement accurate". Until 2026-08-04 the patch roughness was passed here
    // and then displayed elsewhere as if it were the total uncertainty, which is how a 1.887 m
    // door came to sit beside a ±0.037 m that covered none of its 0.213 m error.
    const { randomM } = composeUncertainty({
      valueM: measurement.rawM,
      patchRoughnessM: measurement.internalSpreadM,
    });
    const observation = { id: measurement.objectId, truth: truthM, predicted: measurement.rawM, uncertainty: randomM };
    const model = fitErrorModel([observation]);
    const value: ScaleCheckValue = {
      truthM,
      rawM: measurement.rawM,
      errorM: measurement.rawM - truthM,
      absoluteRelativeError: Math.abs(measurement.rawM - truthM) / truthM,
      correctionFactor: model.scaleFactor,
      verdict: scaleVerdict(observation),
      model,
      randomM,
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
