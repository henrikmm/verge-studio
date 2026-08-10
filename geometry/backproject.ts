/**
 * Mask → 3D points.
 *
 * This is the piece that makes the whole interaction model work. DA3 returns, per frame,
 * a metric depth map plus intrinsics and extrinsics — so every pixel already has a known
 * world position. A mask painted (or segmented) on a 2D frame is therefore not a hint
 * about which points to use; it is an exact selection of them.
 *
 * Selection is a 2D problem. Measurement is a 3D problem. The depth map is the bridge.
 *
 * Note this reads the NPZ, not the GLB. DA3's exported GLB is a 1,000,000-point
 * subsample with no pixel provenance, so a mask cannot be mapped onto it — and
 * backprojection gives full-resolution points for the object anyway.
 *
 * Three filters run before any point is emitted, and each one exists because of a known
 * failure mode rather than a hunch:
 *
 *   EROSION — silhouette pixels blend foreground and background depth ("flying pixels").
 *   CONFIDENCE — DA3 emits a per-pixel confidence and is least confident exactly where
 *     our geometry is least reliable: glossy screens, textureless walls, grazing floors.
 *   DISCONTINUITY — a pixel whose depth disagrees sharply with its neighbours is on a
 *     depth edge, which is the classic RGB-D lie.
 */

import type { Vec3 } from "./types";

/** Apply a row-major 4x4 affine transform to flat xyz positions. */
export function transformPoints(points: ArrayLike<number>, transform: ArrayLike<number>): Float32Array {
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

/** Resize a binary source-image mask onto the depth map without inventing partial pixels. */
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

export interface Frame {
  /** Row-major depth, `width * height` metres. */
  depth: ArrayLike<number>;
  /** Optional per-pixel confidence, same layout as `depth`. */
  confidence?: ArrayLike<number>;
  /**
   * Optional per-pixel colour, `width * height * 3` bytes of RGB.
   *
   * The source photograph, resampled to the depth map's grid. DA3's npz carries depth and
   * confidence but never colour, so a cloud rebuilt from it is grey unless the frames it came
   * from are read back — which they can be, because they are on this disk.
   */
  rgb?: ArrayLike<number>;
  width: number;
  height: number;
  /** Row-major 3×3 camera matrix. */
  intrinsics: ArrayLike<number>;
  /** Row-major 3×4 world→camera `[R|t]`. */
  extrinsics: ArrayLike<number>;
}

export interface BackprojectOptions {
  /** Shrink the mask by this many pixels first. 0 disables. */
  erodeRadius?: number;
  /** Drop pixels below this DA3 confidence. Ignored when the frame has no confidence map. */
  minConfidence?: number;
  /**
   * Drop a pixel when its depth differs from a 4-neighbour by more than this FRACTION of
   * its own depth. Relative rather than absolute because depth noise scales with range.
   */
  maxRelativeDepthStep?: number;
  /** Ignore depths outside this range, in metres. Guards against 0/inf sentinels. */
  minDepth?: number;
  maxDepth?: number;
}

export interface BackprojectResult {
  /**
   * Flat xyz points in DA3's raw reconstruction frame. Callers displaying them with
   * DA3's GLB must also apply the GLB scene's `hf_alignment` transform.
   */
  points: Float32Array;
  pointCount: number;
  maskedPixels: number;
  rejected: {
    eroded: number;
    depth: number;
    confidence: number;
    discontinuity: number;
  };
}

const DEFAULTS = {
  erodeRadius: 2,
  minConfidence: 0,
  maxRelativeDepthStep: 0.05,
  minDepth: 1e-4,
  maxDepth: Infinity,
} as const;

/**
 * Binary erosion with a square structuring element.
 *
 * Square rather than circular on purpose: it is separable-cheap, and the difference
 * between a square and a disc at radius 2-3 px is far below the accuracy this pipeline
 * can resolve. What matters is that boundary pixels go away.
 */
export function erodeMask(
  mask: ArrayLike<number> | ArrayLike<boolean>,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const source = new Uint8Array(width * height);
  for (let i = 0; i < source.length; i++) source[i] = mask[i] ? 1 : 0;
  if (radius <= 0) return source;

  // Separable: erode along x, then along y.
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = 1;
      for (let dx = -radius; dx <= radius && keep; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= width || !source[y * width + sx]) keep = 0;
      }
      horizontal[y * width + x] = keep;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = 1;
      for (let dy = -radius; dy <= radius && keep; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height || !horizontal[sy * width + x]) keep = 0;
      }
      out[y * width + x] = keep;
    }
  }
  return out;
}

/**
 * The camera terms every backprojection needs, validated once.
 *
 * Shared so `backprojectMask` and `backprojectFrame` cannot drift apart on convention:
 * two copies of this arithmetic is exactly how a selection and the cloud it is compared
 * against end up in different coordinate frames while both look plausible.
 */
function cameraOf(frame: Frame) {
  const { width, height, depth, intrinsics: k, extrinsics: e } = frame;
  if (depth.length !== width * height) {
    throw new Error(`depth has ${depth.length} values, expected ${width}x${height}`);
  }
  if (k.length < 9) throw new Error("intrinsics must be a row-major 3x3");
  if (e.length < 12) throw new Error("extrinsics must be a row-major 3x4");
  const fx = k[0];
  const fy = k[4];
  if (!(Math.abs(fx) > 0) || !(Math.abs(fy) > 0)) {
    throw new Error("intrinsics have a zero focal length");
  }
  return { fx, fy, cx: k[2], cy: k[5], t: [e[3], e[7], e[11]] as Vec3, e };
}

/** True when the pixel sits on a depth edge and should not be trusted. */
function onDepthDiscontinuity(
  depth: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  d: number,
  maxRelativeStep: number,
): boolean {
  const limit = Math.abs(d) * maxRelativeStep;
  const neighbours = [
    x > 0 ? depth[y * width + x - 1] : d,
    x < width - 1 ? depth[y * width + x + 1] : d,
    y > 0 ? depth[(y - 1) * width + x] : d,
    y < height - 1 ? depth[(y + 1) * width + x] : d,
  ];
  for (const n of neighbours) {
    if (!Number.isFinite(n)) return true;
    if (Math.abs(n - d) > limit) return true;
  }
  return false;
}

/**
 * Backproject the masked pixels of one frame into world-space points.
 *
 * Camera convention is OpenCV, matching DA3: `p_camera = R·p_world + t`, +Z forward,
 * +Y down the image. So `p_world = Rᵀ·(p_camera − t)`.
 */
export function backprojectMask(
  frame: Frame,
  mask: ArrayLike<number> | ArrayLike<boolean>,
  options: BackprojectOptions = {},
): BackprojectResult {
  const opts = { ...DEFAULTS, ...options };
  const { width, height, depth, confidence } = frame;
  const { fx, fy, cx, cy, t, e } = cameraOf(frame);

  if (mask.length !== width * height) {
    throw new Error(`mask has ${mask.length} values, expected ${width}x${height}`);
  }

  let maskedPixels = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) maskedPixels += 1;

  const kept = erodeMask(mask, width, height, opts.erodeRadius);
  let erodedAway = 0;
  for (let i = 0; i < kept.length; i++) if (mask[i] && !kept[i]) erodedAway += 1;

  const out = new Float32Array(maskedPixels * 3);
  let written = 0;
  const rejected = { eroded: erodedAway, depth: 0, confidence: 0, discontinuity: 0 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!kept[index]) continue;

      const d = depth[index];
      if (!Number.isFinite(d) || d < opts.minDepth || d > opts.maxDepth) {
        rejected.depth += 1;
        continue;
      }
      if (confidence && confidence[index] < opts.minConfidence) {
        rejected.confidence += 1;
        continue;
      }
      if (
        opts.maxRelativeDepthStep > 0 &&
        onDepthDiscontinuity(depth, width, height, x, y, d, opts.maxRelativeDepthStep)
      ) {
        rejected.discontinuity += 1;
        continue;
      }

      // Pixel → camera ray → metric camera-space point.
      const cxm = ((x - cx) * d) / fx;
      const cym = ((y - cy) * d) / fy;
      const rel: Vec3 = [cxm - t[0], cym - t[1], d - t[2]];
      // Rᵀ·rel — component i is the dot of R's i-th COLUMN with rel.
      out[written * 3] = e[0] * rel[0] + e[4] * rel[1] + e[8] * rel[2];
      out[written * 3 + 1] = e[1] * rel[0] + e[5] * rel[1] + e[9] * rel[2];
      out[written * 3 + 2] = e[2] * rel[0] + e[6] * rel[1] + e[10] * rel[2];
      written += 1;
    }
  }

  return {
    points: out.subarray(0, written * 3),
    pointCount: written,
    maskedPixels,
    rejected,
  };
}

export interface FrameCloudOptions {
  /** Drop pixels below this DA3 confidence. Ignored when the frame has no confidence map. */
  minConfidence?: number;
  /** Ignore depths outside this range, in metres. Guards against 0/inf sentinels. */
  minDepth?: number;
  maxDepth?: number;
  /**
   * Drop a pixel whose depth differs from a 4-neighbour by more than this FRACTION of its
   * own depth. 0 disables, which is the default and what coverage accounting needs.
   *
   * Off by default because the two callers want opposite things. `coverage` asks "could this
   * pixel have reached the cloud", and a filter here would remove pixels and then blame their
   * absence on something else. A cloud being BUILT wants the opposite: silhouette pixels
   * blend foreground and background depth, and those flying pixels land strung out in space.
   */
  maxRelativeDepthStep?: number;
}

export interface FrameCloud {
  /** `width * height * 3`, indexed by pixel. Entries where `valid` is 0 are meaningless. */
  points: Float32Array;
  /** 1 where the pixel produced a point. Same layout as the depth map. */
  valid: Uint8Array;
  validCount: number;
  /**
   * Pixels that had usable depth but sat on a depth edge, so `maxRelativeDepthStep` dropped
   * them. Always 0 when that filter is off. Reported separately so a caller can still say how
   * many pixels the depth map could have given it.
   */
  edgeRejected: number;
}

/**
 * Every pixel of one frame as a 3D point, INDEXED BY PIXEL.
 *
 * `backprojectMask` compacts its output, which is right for measuring an object and wrong
 * for asking "is this part of the picture in the cloud at all" — that question needs the
 * answer to stay addressable by pixel so it can be drawn back onto the photograph.
 *
 * Erosion is never applied here, and the discontinuity test is off unless asked for. Those
 * filters exist to keep a *measurement* honest; in coverage accounting they would remove
 * pixels and then blame their absence on something else. A caller BUILDING a cloud does want
 * the discontinuity test, so it is available — see `maxRelativeDepthStep`.
 */
export function backprojectFrame(frame: Frame, options: FrameCloudOptions = {}): FrameCloud {
  const opts = {
    minConfidence: 0,
    minDepth: DEFAULTS.minDepth,
    maxDepth: Infinity,
    maxRelativeDepthStep: 0,
    ...options,
  };
  const { width, height, depth, confidence } = frame;
  const { fx, fy, cx, cy, t, e } = cameraOf(frame);

  const points = new Float32Array(width * height * 3);
  const valid = new Uint8Array(width * height);
  let validCount = 0;
  let edgeRejected = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const d = depth[index];
      if (!Number.isFinite(d) || d < opts.minDepth || d > opts.maxDepth) continue;
      if (confidence && confidence[index] < opts.minConfidence) continue;
      if (
        opts.maxRelativeDepthStep > 0 &&
        onDepthDiscontinuity(depth, width, height, x, y, d, opts.maxRelativeDepthStep)
      ) {
        edgeRejected += 1;
        continue;
      }

      const cxm = ((x - cx) * d) / fx;
      const cym = ((y - cy) * d) / fy;
      const rel: Vec3 = [cxm - t[0], cym - t[1], d - t[2]];
      points[index * 3] = e[0] * rel[0] + e[4] * rel[1] + e[8] * rel[2];
      points[index * 3 + 1] = e[1] * rel[0] + e[5] * rel[1] + e[9] * rel[2];
      points[index * 3 + 2] = e[2] * rel[0] + e[6] * rel[1] + e[10] * rel[2];
      valid[index] = 1;
      validCount += 1;
    }
  }

  return { points, valid, validCount, edgeRejected };
}
