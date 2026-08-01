/**
 * Which way is up?
 *
 * DA3's world frame starts at the reference camera, at whatever angle that camera
 * happened to be held. Nothing in the reconstruction knows about gravity, so "height"
 * is meaningless until we recover an up axis.
 *
 * There is no IMU in a video-only pipeline. What we do have is the per-frame camera
 * pose, and a person walking through a room holds the phone roughly upright — so the
 * camera's own down axis, averaged over every frame, approximates gravity. Measured on
 * `fixtures/room/504px-112f`: coherence 0.925 across 112 frames, i.e. the frames agree
 * strongly about which way down is.
 *
 * The coherence number matters as much as the direction. It is the mean resultant
 * length of the per-frame directions: 1.0 means every frame agrees exactly, and values
 * near 0 mean the camera tumbled and the estimate is worthless. Callers must gate on it
 * rather than trusting the vector blindly — a tilted-the-whole-time capture produces a
 * confident-looking but wrong "up".
 *
 * Extrinsics are world→camera `[R|t]`, DA3's convention, laid out row-major as (N,3,4):
 * `p_camera = R · p_world + t`. In OpenCV camera axes, +Y points DOWN in the image, so
 * the camera's down direction expressed in world coordinates is `Rᵀ·(0,1,0)`, which is
 * the second ROW of R.
 */

import { normalize, type Vec3 } from "./types";

export interface GravityEstimate {
  /** Unit vector pointing up (opposite gravity), in DA3 world coordinates. */
  up: Vec3;
  /**
   * Mean resultant length of the per-frame down axes, in [0, 1]. 1.0 = perfect
   * agreement. Below ~0.7 the capture tumbled and `up` should not be trusted.
   */
  coherence: number;
  frameCount: number;
}

const MATRIX_STRIDE = 12; // 3x4, row-major

function requireExtrinsics(extrinsics: ArrayLike<number>): number {
  const frameCount = Math.floor(extrinsics.length / MATRIX_STRIDE);
  if (frameCount < 1 || extrinsics.length % MATRIX_STRIDE !== 0) {
    throw new Error(
      `extrinsics must be (N,3,4) row-major — got ${extrinsics.length} values, ` +
        `which is not a multiple of ${MATRIX_STRIDE}`,
    );
  }
  return frameCount;
}

/**
 * Estimate the up axis from camera poses.
 *
 * Averaging unit vectors and renormalising is the standard mean-direction estimator for
 * tightly clustered directions. It is deliberately not a full rotation average: the
 * spread here is small by construction (a handheld walkthrough), and the magnitude of
 * the unnormalised sum is exactly the coherence we want to report.
 */
export function estimateGravity(extrinsics: ArrayLike<number>): GravityEstimate {
  const frameCount = requireExtrinsics(extrinsics);

  let sx = 0;
  let sy = 0;
  let sz = 0;
  let counted = 0;
  for (let f = 0; f < frameCount; f++) {
    const base = f * MATRIX_STRIDE;
    // Second row of R = camera-down expressed in world coordinates.
    const down = normalize([extrinsics[base + 4], extrinsics[base + 5], extrinsics[base + 6]]);
    if (!down) continue;
    sx += down[0];
    sy += down[1];
    sz += down[2];
    counted += 1;
  }
  if (counted === 0) throw new Error("estimateGravity: no usable rotation rows in extrinsics");

  const coherence = Math.hypot(sx, sy, sz) / counted;
  const up = normalize([-sx, -sy, -sz]);
  if (!up) {
    throw new Error(
      "estimateGravity: camera down axes cancel out — the capture has no consistent " +
        "orientation, so gravity cannot be recovered from poses",
    );
  }
  return { up, coherence, frameCount: counted };
}

/**
 * Camera centres in world coordinates: `C = -Rᵀ·t`.
 *
 * DA3's quality comes from cross-view attention, which needs real camera TRANSLATION —
 * a pan from a fixed point has no parallax and produces poor geometry no matter what
 * the downstream code does. The spread of these centres is how we check that a clip
 * actually moved before trusting anything measured from it.
 */
export function cameraCentres(extrinsics: ArrayLike<number>): Vec3[] {
  const frameCount = requireExtrinsics(extrinsics);
  const centres: Vec3[] = [];
  for (let f = 0; f < frameCount; f++) {
    const b = f * MATRIX_STRIDE;
    const t: Vec3 = [extrinsics[b + 3], extrinsics[b + 7], extrinsics[b + 11]];
    // -Rᵀ·t — the i-th component is the dot of R's i-th COLUMN with t.
    centres.push([
      -(extrinsics[b + 0] * t[0] + extrinsics[b + 4] * t[1] + extrinsics[b + 8] * t[2]),
      -(extrinsics[b + 1] * t[0] + extrinsics[b + 5] * t[1] + extrinsics[b + 9] * t[2]),
      -(extrinsics[b + 2] * t[0] + extrinsics[b + 6] * t[1] + extrinsics[b + 10] * t[2]),
    ]);
  }
  return centres;
}

/** Axis-aligned extent of the camera path, in metres. Near-zero on all axes = a pan. */
export function trajectorySpan(centres: readonly Vec3[]): Vec3 {
  if (centres.length === 0) return [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of centres) {
    for (let axis = 0; axis < 3; axis++) {
      if (c[axis] < min[axis]) min[axis] = c[axis];
      if (c[axis] > max[axis]) max[axis] = c[axis];
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}
