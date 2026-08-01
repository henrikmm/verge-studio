/**
 * Finding the floor.
 *
 * The obvious implementation — "RANSAC the biggest plane" — is wrong, and we measured
 * it being wrong. On `fixtures/room/504px-112f`, sequential RANSAC returns three planes
 * with 17.1%, 20.8% and 9.6% support whose normals sit 60°, 34° and 61° off vertical.
 * They are walls. In an indoor scene the largest flat surface is very often a wall, and
 * a height measured above a wall is silently, confidently wrong.
 *
 * Two priors fix it, and they are the ones every mature pipeline ends up using (there
 * is no widely-adopted "ground from an unstructured SfM cloud" library — everyone rolls
 * this combination themselves):
 *
 *   1. ORIENTATION GATE. Reject any candidate whose normal is more than `maxTiltDeg`
 *      from the gravity estimate before scoring it at all.
 *   2. LOWEST, NOT LARGEST. Among candidates that are well supported, take the one with
 *      the lowest elevation. Ceilings and tabletops are horizontal too; only height
 *      distinguishes the floor from them.
 *
 * DETERMINISM IS A HARD REQUIREMENT, not a nicety. This app caches node results by
 * content hash, so a fit that returned a different plane for identical inputs would
 * corrupt the cache model quietly. Open3D's `segment_plane` has shipped genuinely
 * non-deterministic results across releases; we avoid inheriting that by seeding our own
 * generator and sampling from fixed, index-ordered subsets.
 */

import {
  angleBetweenDeg,
  basisFromUp,
  cross,
  dot,
  normalize,
  signedHeight,
  type Plane,
  type Vec3,
} from "./types";

export class GroundPlaneNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroundPlaneNotFoundError";
  }
}

export interface GroundPlaneOptions {
  /** Gravity-derived up axis. See `geometry/gravity.ts`. */
  up: Vec3;
  /** Orientation gate, in degrees off `up`. Wider than the floor's real tilt on purpose. */
  maxTiltDeg?: number;
  /** Inlier band, half-thickness in metres. */
  inlierDistance?: number;
  iterations?: number;
  seed?: number;
  /** Per-point weight in [0,1] — DA3's confidence map. Absent means all points count 1. */
  weights?: ArrayLike<number>;
  /**
   * How much support a candidate needs, relative to the best candidate, before the
   * lowest-plane rule will consider it. Guards against a sparse smear of points below
   * the real floor winning purely for being low.
   */
  supportRatio?: number;
  /** Refuse to return a plane backed by fewer than this many points. */
  minInliers?: number;
  /** Score against every Nth point. Purely a speed knob; deterministic either way. */
  stride?: number;
}

export interface GroundPlaneFit {
  plane: Plane;
  inlierCount: number;
  inlierFraction: number;
  /** RMS of inlier distances to the refined plane, in metres. Feeds the height error bar. */
  rmse: number;
  /** Angle between the fitted normal and the supplied up axis, in degrees. */
  tiltDeg: number;
  /** Plane elevation along `up` — i.e. `-offset`. */
  elevation: number;
  candidatesConsidered: number;
  seed: number;
}

const DEFAULTS = {
  maxTiltDeg: 20,
  inlierDistance: 0.02,
  iterations: 2000,
  seed: 1,
  supportRatio: 0.5,
  minInliers: 100,
  stride: 1,
} as const;

/**
 * mulberry32 — small, fast, and fully determined by its seed.
 *
 * Deliberately not `Math.random()`: an unseeded generator would make the fit
 * non-reproducible, which breaks both the test suite and the content-hash cache.
 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointAt(points: ArrayLike<number>, index: number): Vec3 {
  const b = index * 3;
  return [points[b], points[b + 1], points[b + 2]];
}

/** Plane through three points, normal oriented towards `up`. Null if collinear. */
function planeThrough(a: Vec3, b: Vec3, c: Vec3, up: Vec3): Plane | null {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let normal = normalize(cross(u, v));
  if (!normal) return null;
  // Always point up, so `offset` and signed heights read consistently.
  if (dot(normal, up) < 0) normal = [-normal[0], -normal[1], -normal[2]];
  return { normal, offset: -dot(normal, a) };
}

interface Support {
  weight: number;
  count: number;
}

function scorePlane(
  plane: Plane,
  points: ArrayLike<number>,
  indices: Int32Array,
  weights: ArrayLike<number> | undefined,
  band: number,
): Support {
  let weight = 0;
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (Math.abs(signedHeight(plane, pointAt(points, index))) > band) continue;
    weight += weights ? weights[index] : 1;
    count += 1;
  }
  return { weight, count };
}

/**
 * Least-squares refinement as a height field `w = a·u + b·v + c` in the gravity basis.
 *
 * A 3×3 normal-equation solve rather than an eigen decomposition of the covariance.
 * That is legitimate here precisely because the orientation gate already guarantees the
 * surface is within `maxTiltDeg` of horizontal, so it is single-valued over the (u,v)
 * plane and cannot be near-vertical where a height field would blow up. It is also the
 * same parameterisation the donor's ground contract uses (`coefficients_z_ax_by_c`).
 */
function refine(
  points: ArrayLike<number>,
  inliers: number[],
  weights: ArrayLike<number> | undefined,
  up: Vec3,
): Plane | null {
  const { e1, e2, up: w } = basisFromUp(up);
  let suu = 0, svv = 0, suv = 0, su = 0, sv = 0, sw = 0, suw = 0, svw = 0, s1 = 0;
  for (const index of inliers) {
    const p = pointAt(points, index);
    const weight = weights ? weights[index] : 1;
    if (!(weight > 0)) continue;
    const u = dot(p, e1);
    const v = dot(p, e2);
    const h = dot(p, w);
    suu += weight * u * u;
    svv += weight * v * v;
    suv += weight * u * v;
    su += weight * u;
    sv += weight * v;
    sw += weight * h;
    suw += weight * u * h;
    svw += weight * v * h;
    s1 += weight;
  }
  if (s1 <= 0) return null;

  // Cramer's rule on the symmetric 3x3 normal equations.
  const m = [
    [suu, suv, su],
    [suv, svv, sv],
    [su, sv, s1],
  ];
  const rhs = [suw, svw, sw];
  const det3 = (x: number[][]) =>
    x[0][0] * (x[1][1] * x[2][2] - x[1][2] * x[2][1]) -
    x[0][1] * (x[1][0] * x[2][2] - x[1][2] * x[2][0]) +
    x[0][2] * (x[1][0] * x[2][1] - x[1][1] * x[2][0]);
  const det = det3(m);
  // Degenerate spread (all inliers on a line) — keep the RANSAC plane rather than
  // dividing by a near-zero determinant and producing a wild normal.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

  const replaceColumn = (col: number) => m.map((row, r) => row.map((x, c) => (c === col ? rhs[r] : x)));
  const a = det3(replaceColumn(0)) / det;
  const b = det3(replaceColumn(1)) / det;
  const c = det3(replaceColumn(2)) / det;

  // Surface is w - a·u - b·v - c = 0, so the world normal is up - a·e1 - b·e2.
  const normal = normalize([
    w[0] - a * e1[0] - b * e2[0],
    w[1] - a * e1[1] - b * e2[1],
    w[2] - a * e1[2] - b * e2[2],
  ]);
  if (!normal) return null;
  // A point on the plane: u = v = 0, w = c.
  return { normal, offset: -c * dot(normal, w) };
}

function collectInliers(
  plane: Plane,
  points: ArrayLike<number>,
  indices: Int32Array,
  band: number,
): number[] {
  const inliers: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (Math.abs(signedHeight(plane, pointAt(points, index))) <= band) inliers.push(index);
  }
  return inliers;
}

function rmsError(plane: Plane, points: ArrayLike<number>, inliers: readonly number[]): number {
  if (inliers.length === 0) return NaN;
  let sum = 0;
  for (const index of inliers) {
    const d = signedHeight(plane, pointAt(points, index));
    sum += d * d;
  }
  return Math.sqrt(sum / inliers.length);
}

/**
 * Fit the ground plane of a point cloud.
 *
 * `points` is a flat xyz array (the layout Three.js and DA3's GLB both use).
 * Throws `GroundPlaneNotFoundError` rather than returning a poorly supported plane —
 * an honest failure is worth far more than a confident wrong floor.
 */
export function fitGroundPlane(
  points: ArrayLike<number>,
  options: GroundPlaneOptions,
): GroundPlaneFit {
  const opts = { ...DEFAULTS, ...options };
  const up = normalize(opts.up);
  if (!up) throw new Error("fitGroundPlane: up vector is degenerate");

  const total = Math.floor(points.length / 3);
  if (total < 3) throw new GroundPlaneNotFoundError(`need at least 3 points, got ${total}`);

  const stride = Math.max(1, Math.floor(opts.stride));
  const sampled = new Int32Array(Math.ceil(total / stride));
  for (let i = 0, w = 0; i < total; i += stride) sampled[w++] = i;

  const random = makeRandom(opts.seed);
  const pick = () => sampled[Math.min(sampled.length - 1, Math.floor(random() * sampled.length))];

  let best: { plane: Plane; support: Support; elevation: number } | null = null;
  const candidates: { plane: Plane; support: Support; elevation: number }[] = [];

  for (let iter = 0; iter < opts.iterations; iter++) {
    const ia = pick();
    const ib = pick();
    const ic = pick();
    if (ia === ib || ib === ic || ia === ic) continue;

    const plane = planeThrough(pointAt(points, ia), pointAt(points, ib), pointAt(points, ic), up);
    if (!plane) continue;
    // Orientation gate FIRST — a wall must never even be scored.
    if (angleBetweenDeg(plane.normal, up) > opts.maxTiltDeg) continue;

    const support = scorePlane(plane, points, sampled, opts.weights, opts.inlierDistance);
    if (support.count === 0) continue;
    const candidate = { plane, support, elevation: -plane.offset };
    candidates.push(candidate);
    if (!best || support.weight > best.support.weight) best = candidate;
  }

  if (!best) {
    throw new GroundPlaneNotFoundError(
      `no horizontal plane found within ${opts.maxTiltDeg}° of the up axis after ` +
        `${opts.iterations} iterations — either the floor is not in the cloud, or the ` +
        `gravity estimate is wrong (check its coherence before trusting it)`,
    );
  }

  // The lowest well-supported horizontal plane, not the largest: a tabletop or a ceiling
  // is every bit as flat and horizontal as the floor is.
  const threshold = best.support.weight * opts.supportRatio;
  let chosen = best;
  for (const candidate of candidates) {
    if (candidate.support.weight >= threshold && candidate.elevation < chosen.elevation) {
      chosen = candidate;
    }
  }

  let inliers = collectInliers(chosen.plane, points, sampled, opts.inlierDistance);
  let plane = refine(points, inliers, opts.weights, up) ?? chosen.plane;
  // Re-collect against the refined plane: refinement moves it, so the old inlier set is
  // no longer exactly the set of points within the band.
  inliers = collectInliers(plane, points, sampled, opts.inlierDistance);
  const improved = refine(points, inliers, opts.weights, up);
  if (improved) {
    plane = improved;
    inliers = collectInliers(plane, points, sampled, opts.inlierDistance);
  }

  if (inliers.length < opts.minInliers) {
    throw new GroundPlaneNotFoundError(
      `best horizontal plane has only ${inliers.length} inliers (minimum ${opts.minInliers}) — ` +
        `too little floor is visible to measure heights against`,
    );
  }

  return {
    plane,
    inlierCount: inliers.length,
    inlierFraction: inliers.length / sampled.length,
    rmse: rmsError(plane, points, inliers),
    tiltDeg: angleBetweenDeg(plane.normal, up),
    elevation: -plane.offset,
    candidatesConsidered: candidates.length,
    seed: opts.seed,
  };
}

/**
 * Fallback for when the automatic fit fails: the user marks floor points by hand.
 *
 * The floor is often the worst-sampled surface in a walkthrough — it is seen at a
 * grazing angle, so it gets few points and noisy depth. When that defeats the automatic
 * fit, three clicks beat a wrong answer. Seeds define the plane; nearby cloud points
 * within `inlierDistance` then refine it.
 */
export function fitPlaneFromSeeds(
  points: ArrayLike<number>,
  seeds: readonly Vec3[],
  options: GroundPlaneOptions,
): GroundPlaneFit {
  const opts = { ...DEFAULTS, ...options };
  const up = normalize(opts.up);
  if (!up) throw new Error("fitPlaneFromSeeds: up vector is degenerate");
  if (seeds.length < 3) {
    throw new GroundPlaneNotFoundError(`need at least 3 seed points, got ${seeds.length}`);
  }

  // Flatten seeds into the same layout, then least-squares fit them directly.
  const seedArray = new Float64Array(seeds.length * 3);
  for (const [i, s] of seeds.entries()) {
    seedArray[i * 3] = s[0];
    seedArray[i * 3 + 1] = s[1];
    seedArray[i * 3 + 2] = s[2];
  }
  const seedIndices = Array.from({ length: seeds.length }, (_, i) => i);
  const seeded = refine(seedArray, seedIndices, undefined, up);
  if (!seeded) {
    throw new GroundPlaneNotFoundError("seed points are collinear — pick three spread-out points");
  }

  const total = Math.floor(points.length / 3);
  const stride = Math.max(1, Math.floor(opts.stride));
  const sampled = new Int32Array(Math.ceil(total / stride));
  for (let i = 0, w = 0; i < total; i += stride) sampled[w++] = i;

  let plane = seeded;
  let inliers = collectInliers(plane, points, sampled, opts.inlierDistance);
  const refined = inliers.length >= 3 ? refine(points, inliers, opts.weights, up) : null;
  if (refined) {
    plane = refined;
    inliers = collectInliers(plane, points, sampled, opts.inlierDistance);
  }

  return {
    plane,
    inlierCount: inliers.length,
    inlierFraction: sampled.length > 0 ? inliers.length / sampled.length : 0,
    rmse: inliers.length > 0 ? rmsError(plane, points, inliers) : 0,
    tiltDeg: angleBetweenDeg(plane.normal, up),
    elevation: -plane.offset,
    candidatesConsidered: 0,
    seed: opts.seed,
  };
}
