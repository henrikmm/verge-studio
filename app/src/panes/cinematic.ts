/**
 * Cinematic — the view that shows the reconstruction off without being driven.
 *
 * The first thing anyone sees in this pane is a static cloud they have to learn to orbit, and a
 * still image of a point cloud is the least convincing way to present one: the depth cue that
 * makes it read as a *place* rather than as speckle is parallax, and parallax needs motion. Ten
 * seconds of slow turn does more than any readout to say what this project produces.
 *
 * ## What it does
 *
 * A turntable. The camera rides a circle around the scene's centre, tilted above the fitted
 * ground, looking inwards, with a slow in-and-out dolly so the framing breathes instead of
 * tracing a machine-perfect ring.
 *
 * Two properties are worth stating because they are the ones the tests hold:
 *
 * 1. **A full turn returns exactly where it started.** The dolly is a function of the ORBIT
 *    ANGLE, not of elapsed time — two cycles per revolution — so there is no second clock that
 *    can drift out of phase with the first and leave a visible seam each lap.
 * 2. **The camera never goes under the ground.** The elevation is raised as far as it takes to
 *    keep the camera above the fitted plane, which matters because the scene centre is the middle
 *    of the cloud's bounding box and in a room with a tall ceiling that can sit well above the
 *    floor — or, in a bad reconstruction, below it. A cinematic mode that opens underground is
 *    worse than none.
 *
 * The pose is a pure function so both can be tested without WebGL, matching `viewport-nav.ts` and
 * `camera-track.ts`. The component owns only the angle and the clock.
 */

import { basisFromUp, type Vec3 } from "../../../geometry";

/** Degrees per second. 6°/s is a full turn per minute — slow enough to read a scene by, fast
 *  enough that the motion is obvious within a second of arriving. */
export const ORBIT_RATE_DEG_S = 6;

/** How far above the horizontal the camera rides, before any correction for the floor. */
const BASE_ELEVATION_DEG = 18;

/** Ceiling on that correction. Past this the shot is a plan view and stops reading as a place. */
const MAX_ELEVATION_DEG = 72;

/** Dolly depth and rate: ±8% of the radius, twice per revolution. */
const DOLLY_AMPLITUDE = 0.08;
const DOLLY_CYCLES_PER_TURN = 2;

/** Clearance kept above the fitted plane, as a fraction of the orbit radius. */
const MIN_CLEARANCE = 0.08;

export interface CinematicScene {
  /** Centre of the cloud's bounding box — what the camera looks at. */
  center: Vec3;
  /** Which way is up, already resolved from floor → camera path → scene +Y. */
  up: Vec3;
  /** Orbit radius at the middle of the dolly, before the operator's own zoom. */
  radius: number;
  /**
   * Height of `center` above the fitted ground, signed. Omitted when no floor was fitted, in
   * which case there is nothing to stay above and the base elevation is used unchanged.
   */
  centerHeight?: number;
}

export interface CinematicPose {
  position: Vec3;
  /** Always the scene centre: a turntable looks inwards by definition. */
  target: Vec3;
  /** What the elevation ended up being, after any correction. Reported so the pane can say so. */
  elevationDeg: number;
}

/**
 * Where the camera is at this point in the turn.
 *
 * `angle` is unbounded radians — the caller accumulates it — and `elevationOffset` and
 * `radiusScale` carry the operator's own drag and wheel, so interacting with a cinematic shot
 * adjusts the shot rather than dropping out of the mode.
 */
export function cinematicPose(
  scene: CinematicScene,
  angle: number,
  elevationOffset = 0,
  radiusScale = 1,
): CinematicPose {
  const { e1, e2, up } = basisFromUp(scene.up);
  const radius = Math.max(1e-3, scene.radius * radiusScale * dollyFactor(angle));

  let elevation = degToRad(BASE_ELEVATION_DEG) + elevationOffset;

  /**
   * Raise the shot until the camera clears the ground.
   *
   * The camera's height above the plane is the centre's height plus `radius·sin(elevation)`, so
   * the elevation that just clears it is an arcsine. Only ever raises: a scene whose centre is
   * already high above the floor keeps the framing it was given.
   */
  if (scene.centerHeight !== undefined) {
    const needed = (MIN_CLEARANCE * radius - scene.centerHeight) / radius;
    if (needed > Math.sin(elevation)) {
      elevation = Math.asin(Math.min(1, needed));
    }
  }
  elevation = clamp(elevation, degToRad(-MAX_ELEVATION_DEG), degToRad(MAX_ELEVATION_DEG));

  const horizontal = radius * Math.cos(elevation);
  const vertical = radius * Math.sin(elevation);
  const position: Vec3 = [
    scene.center[0] + horizontal * (Math.cos(angle) * e1[0] + Math.sin(angle) * e2[0]) + vertical * up[0],
    scene.center[1] + horizontal * (Math.cos(angle) * e1[1] + Math.sin(angle) * e2[1]) + vertical * up[1],
    scene.center[2] + horizontal * (Math.cos(angle) * e1[2] + Math.sin(angle) * e2[2]) + vertical * up[2],
  ];

  return { position, target: scene.center, elevationDeg: radToDeg(elevation) };
}

/** The breathing radius. Periodic in `angle` with period 2π, which is what makes a lap seamless. */
export function dollyFactor(angle: number): number {
  return 1 + DOLLY_AMPLITUDE * Math.sin(DOLLY_CYCLES_PER_TURN * angle);
}

/**
 * Where on the circle the camera already is, so entering the mode does not jump halfway round
 * the scene. Projects the current view direction onto the orbit plane and reads its angle.
 */
export function angleFacing(scene: CinematicScene, cameraPosition: Vec3): number {
  const { e1, e2 } = basisFromUp(scene.up);
  const offset: Vec3 = [
    cameraPosition[0] - scene.center[0],
    cameraPosition[1] - scene.center[1],
    cameraPosition[2] - scene.center[2],
  ];
  const x = offset[0] * e1[0] + offset[1] * e1[1] + offset[2] * e1[2];
  const y = offset[0] * e2[0] + offset[1] * e2[1] + offset[2] * e2[2];
  // Both components vanish only if the camera sits exactly on the axis, where every angle is
  // equally correct. Zero is as good as any and cannot produce a NaN pose.
  return x === 0 && y === 0 ? 0 : Math.atan2(y, x);
}

/**
 * How much of the orbit rate applies right now.
 *
 * Motion stops while the operator is dragging and for a moment afterwards, then returns over
 * `RESUME_MS` rather than snapping back to speed — a shot that lurches the instant a mouse button
 * comes up reads as a bug, not as a resume.
 */
export const HOLD_AFTER_INPUT_MS = 1200;
export const RESUME_MS = 900;

export function rateFactor(msSinceInput: number): number {
  if (msSinceInput < HOLD_AFTER_INPUT_MS) return 0;
  const t = (msSinceInput - HOLD_AFTER_INPUT_MS) / RESUME_MS;
  if (t >= 1) return 1;
  // Smoothstep: zero slope at both ends, so neither the departure nor the arrival is a step.
  return t * t * (3 - 2 * t);
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
