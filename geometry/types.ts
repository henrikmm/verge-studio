/**
 * Shared geometry types.
 *
 * This package holds only what DA3 does not already give us: a ground plane, a
 * height above it, and a known-object scale check. Everything here is a pure
 * function over plain arrays — no Three.js, no DOM — so it can be tested headlessly
 * against synthetic scenes whose answers are known exactly.
 *
 * Units are metres throughout, matching DA3's `linear_unit: "metre"`.
 */

export type Vec3 = readonly [number, number, number];

/**
 * A plane as `normal · p + offset = 0`, with `normal` a unit vector.
 *
 * The normal always points **up** (towards the sky, away from the ground), which is
 * what makes `signedHeight` read as "height above the floor" rather than an unsigned
 * distance.
 *
 * `-offset` is the plane's distance from the origin **along its own normal**, which is
 * its elevation along the up axis only when the two coincide. Two planes with different
 * tilts have their offsets measured along different directions, so subtracting one from
 * the other does not give a height difference. Measured 2026-08-08 on the outdoor run:
 * the seed-to-seed spread read 31.9 cm as a difference of offsets and 39.6 cm measured
 * properly, as the planes' heights under a common point. Use `planeElevationAt` when
 * comparing planes; `-offset` is only safe for one plane against itself.
 */
export interface Plane {
  normal: Vec3;
  offset: number;
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Returns null rather than NaNs for a degenerate (zero-length) vector. */
export function normalize(a: Vec3): Vec3 | null {
  const len = length(a);
  if (!(len > 1e-12)) return null;
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Signed distance from the plane, positive above it (because the normal points up). */
export function signedHeight(plane: Plane, p: Vec3): number {
  return dot(plane.normal, p) + plane.offset;
}

/**
 * Where the plane sits along `up`, directly under `reference`.
 *
 * The comparable version of "how high is this plane". Two fits of the same scene can have
 * different normals, and their `-offset` values are then distances along two different
 * directions — subtracting them measures nothing. Reading both planes' heights under one
 * shared point compares like with like. NaN when the plane is edge-on to `up`, where the
 * question has no answer.
 */
export function planeElevationAt(plane: Plane, reference: Vec3, up: Vec3): number {
  const axis = normalize(up);
  if (!axis) return NaN;
  const alongNormal = dot(plane.normal, axis);
  if (Math.abs(alongNormal) < 1e-9) return NaN;
  return dot(reference, axis) - signedHeight(plane, reference) / alongNormal;
}

/** Angle between two unit-ish vectors, in degrees. Clamped, so acos never sees 1+ε. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return NaN;
  return (Math.acos(Math.min(1, Math.max(-1, dot(na, nb)))) * 180) / Math.PI;
}

/**
 * An orthonormal basis whose third axis is `up`.
 *
 * Used to fit a near-horizontal plane as a height field `w = a·u + b·v + c`, which is
 * a 3×3 linear solve rather than an eigen decomposition. The seed axis is chosen as
 * whichever cardinal direction is least aligned with `up`, so the cross product can
 * never be degenerate.
 */
export function basisFromUp(up: Vec3): { e1: Vec3; e2: Vec3; up: Vec3 } {
  const w = normalize(up);
  if (!w) throw new Error("basisFromUp: up vector is degenerate");
  const abs: Vec3 = [Math.abs(w[0]), Math.abs(w[1]), Math.abs(w[2])];
  const seed: Vec3 =
    abs[0] <= abs[1] && abs[0] <= abs[2] ? [1, 0, 0] : abs[1] <= abs[2] ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize(cross(seed, w));
  if (!e1) throw new Error("basisFromUp: degenerate basis");
  const e2 = normalize(cross(w, e1));
  if (!e2) throw new Error("basisFromUp: degenerate basis");
  return { e1, e2, up: w };
}
