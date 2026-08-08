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
 *   2. NOT THE LARGEST — THE ONE WITH LEAST BENEATH IT. Ceilings and tabletops are
 *      horizontal too, and a tabletop can easily carry more points than the floor. What
 *      tells them apart is what is underneath. This lives in `groundPlaneQuality` as a
 *      penalty weighed against the evidence, not as a rule applied after it; the version
 *      that simply took the lowest candidate is what made the fit irreproducible, and
 *      `fitGroundPlane` records that story in full.
 *
 * DETERMINISM IS A HARD REQUIREMENT, not a nicety. This app caches node results by
 * content hash, so a fit that returned a different plane for identical inputs would
 * corrupt the cache model quietly. Open3D's `segment_plane` has shipped genuinely
 * non-deterministic results across releases; we avoid inheriting that by seeding our own
 * generator and sampling from fixed, index-ordered subsets.
 *
 * Determinism was never the problem, though, and it is worth being clear why. The fit has
 * always returned the same plane for the same seed. It returned a DIFFERENT plane for a
 * different seed, and the seed is not part of the scene — so the cache was consistent and
 * the answer was still arbitrary. Reproducible and correct are two requirements.
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
  /**
   * Orientation gate, in degrees off `up`.
   *
   * Deliberately generous, because the gravity prior is only approximate: it comes from
   * averaging camera poses, and its coherence score measures how CONSISTENT the frames
   * are, not how CORRECT they are. An operator who walked the whole clip with the phone
   * tilted forward produces a confident, consistent, tilted "up". Measured on
   * `fixtures/room/504px-112f`, the floor sits 11–19° off the camera-derived up — a gate
   * of 20° would have excluded the real floor and returned something else entirely.
   */
  maxTiltDeg?: number;
  /** Inlier band, half-thickness in metres. */
  inlierDistance?: number;
  iterations?: number;
  seed?: number;
  /** Per-point weight in [0,1] — DA3's confidence map. Absent means all points count 1. */
  weights?: ArrayLike<number>;
  /** Refuse to return a plane backed by fewer than this many points. */
  minInliers?: number;
  /** Score against every Nth point. Purely a speed knob; deterministic either way. */
  stride?: number;
  /**
   * Draw RANSAC triples from the lowest fraction of points along `up`, while still
   * scoring every candidate against the full sampled cloud. Floors are sparse in a
   * walkthrough; this makes the camera-up prior an actual proposal prior instead of
   * waiting for three floor points to be chosen from a million-point room by luck.
   */
  candidateLowestFraction?: number;
  /**
   * Reject the fit outright if more than this fraction of the cloud lies below it.
   *
   * The definition of ground: it is the surface with (almost) nothing beneath it. This
   * is the sanity gate that catches a fit landing mid-scene. Measured on
   * `fixtures/room/504px-112f`: the floor has 4.3% of the cloud below it, while the
   * wrong mid-scene plane has 60.6%.
   */
  maxBelowFraction?: number;
  /**
   * The scale on which "almost nothing beneath it" is judged when SCORING a candidate.
   *
   * Deliberately not `maxBelowFraction`. That number is a refusal threshold — the point
   * past which a plane is thrown away — and it is generous so that an honest floor over
   * rough ground survives. Scoring needs the opposite: the scale at which a floor stops
   * looking like a floor, which is much tighter. Reusing the refusal threshold as the
   * scoring scale is what made the room fixture pick a tabletop.
   *
   * Measured 2026-08-08 on `fixtures/room/504px-112f`, sweeping this value alone:
   * 0.02–0.10 lands on the floor on all 8 seeds; 0.15 is bistable (6 seeds table,
   * 2 seeds floor); 0.20 lands on the tabletop on all 8. 0.05 sits mid-plateau with a
   * factor of two either side. The door fixture and the outdoor run are unmoved across
   * the whole sweep.
   */
  belowScale?: number;
}

export interface GroundPlaneFit {
  plane: Plane;
  inlierCount: number;
  inlierFraction: number;
  /** RMS of inlier distances to the refined plane, in metres. Feeds the height error bar. */
  rmse: number;
  /** Angle between the fitted normal and the supplied up axis, in degrees. */
  tiltDeg: number;
  /**
   * `-offset`: the plane's distance from the origin along ITS OWN normal.
   *
   * Safe to compare against another fit only when the two normals agree. Use
   * `planeElevationAt` to compare planes — see the note on `Plane` in `types.ts`.
   */
  elevation: number;
  candidatesConsidered: number;
  /** Share of the cloud below the fitted plane. Near zero for a real floor. */
  belowFraction: number;
  /**
   * True when least-squares refinement wanted to rotate the plane past `maxTiltDeg` and
   * was declined, so `plane` is the last one that satisfied the gate rather than the
   * best-fitting one. `tiltDeg` can never exceed `maxTiltDeg`; this says what that cost.
   */
  tiltClamped: boolean;
  seed: number;
}

export interface TwoPassGroundPlaneFit {
  /** Camera-pose-up result. Useful evidence when the refit changes the answer. */
  initial: GroundPlaneFit;
  /** Final result, refitted with the first floor normal as the new up axis. */
  refined: GroundPlaneFit;
}

export interface GroundPlaneHypothesis {
  /** Fraction of the gravity-sorted cloud used to propose RANSAC triples. */
  proposalFraction: number;
  /** Higher is better. Combines support with the physical sanity checks below. */
  qualityScore: number;
  fit: GroundPlaneFit;
}

export interface RobustGroundPlaneOptions extends Omit<GroundPlaneOptions, "candidateLowestFraction"> {
  /** Competing proposal pools. Whole-cloud + lower-region is the measured default. */
  proposalFractions?: readonly number[];
  /** Refuse a numerically thin plane even when RANSAC can polish it to a low RMSE. */
  minInlierFraction?: number;
}

export interface RobustGroundPlaneFit extends GroundPlaneFit {
  proposalFraction: number;
  qualityScore: number;
  hypotheses: readonly GroundPlaneHypothesis[];
}

const DEFAULTS = {
  maxTiltDeg: 30,
  inlierDistance: 0.02,
  iterations: 2000,
  seed: 1,
  minInliers: 100,
  stride: 1,
  candidateLowestFraction: 1,
  maxBelowFraction: 0.15,
  belowScale: 0.05,
} as const;

/**
 * Comparable quality across candidates and across proposal strategies.
 *
 * RMSE alone is unsafe: an arbitrary diagonal slice can be extremely thin. Support is
 * therefore the base evidence, with soft penalties for disagreeing with camera-derived
 * up, leaving points below the plane, and using most of the allowed inlier band.
 *
 * This is the ONLY thing that ranks a plane against another plane. It used to decide
 * between two finished hypotheses and nothing else; it now decides between every RANSAC
 * candidate as well, which is what made the fit reproducible. See `fitGroundPlane`.
 */
export function groundPlaneQuality(
  fit: GroundPlaneFit,
  options: Pick<
    GroundPlaneOptions,
    "maxTiltDeg" | "inlierDistance" | "maxBelowFraction" | "belowScale"
  > = {},
): number {
  const maxTilt = Math.max(1, options.maxTiltDeg ?? DEFAULTS.maxTiltDeg);
  const inlierDistance = Math.max(1e-6, options.inlierDistance ?? DEFAULTS.inlierDistance);
  const belowScale = Math.max(1e-6, options.belowScale ?? DEFAULTS.belowScale);
  const tiltPenalty = 2 * (fit.tiltDeg / maxTilt) ** 2;
  const belowPenalty = 2 * (fit.belowFraction / belowScale) ** 2;
  const residualPenalty = fit.rmse / inlierDistance;
  return Math.log(Math.max(1e-6, fit.inlierFraction)) - tiltPenalty - belowPenalty - residualPenalty;
}

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

/**
 * How far under a plane a point must sit before it counts as below it, in metres.
 *
 * Shared by the reported `belowFraction` and by the per-candidate scoring pass, so the
 * number a candidate is ranked on and the number the operator reads are the same number.
 */
const BELOW_TOLERANCE = 0.05;

interface Support {
  weight: number;
  count: number;
  /** Points more than `BELOW_TOLERANCE` under the plane — what `belowFraction` reports. */
  belowCount: number;
  /** Sum of squared inlier distances, so a candidate's RMSE costs no second pass. */
  squared: number;
}

/**
 * Everything one candidate needs, from one walk over the sampled cloud.
 *
 * The below-count and the squared residual are gathered here rather than later because
 * every candidate is now scored on all three, and a second pass per candidate would
 * multiply the cost of the fit. Measured 2026-08-08: about 20% slower per fit than
 * counting inliers alone.
 */
function scorePlane(
  plane: Plane,
  points: ArrayLike<number>,
  indices: Int32Array,
  weights: ArrayLike<number> | undefined,
  band: number,
): Support {
  let weight = 0;
  let count = 0;
  let belowCount = 0;
  let squared = 0;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const height = signedHeight(plane, pointAt(points, index));
    if (height < -BELOW_TOLERANCE) belowCount += 1;
    if (Math.abs(height) > band) continue;
    weight += weights ? weights[index] : 1;
    count += 1;
    squared += height * height;
  }
  return { weight, count, belowCount, squared };
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

  const replaceColumn = (col: number) =>
    m.map((row, r) => row.map((x, c) => (c === col ? rhs[r] : x)));
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

/** Share of the cloud sitting below a plane. The ground has almost nothing under it. */
function belowFraction(
  plane: Plane,
  points: ArrayLike<number>,
  indices: Int32Array,
  tolerance = BELOW_TOLERANCE,
): number {
  if (indices.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    if (signedHeight(plane, pointAt(points, indices[i])) < -tolerance) count += 1;
  }
  return count / indices.length;
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
 *
 * THE WINNER IS THE BEST CANDIDATE, NOT THE LOWEST ONE. Until 2026-08-08 this kept the
 * lowest candidate that cleared a support bar, and `groundPlaneQuality` was applied only
 * afterwards, to the one plane each proposal pool returned. So the score never saw the
 * candidates, and the decision was a minimum over a random sample — an extreme value,
 * which has no fixed point. Drawing more candidates finds a lower one, forever.
 *
 * That is not a tuning problem, and the measurements say so. Changing only the seed moved
 * the floor by up to 31.9 cm; raising the iteration count made it WORSE, not better. On
 * `fixtures/door/504px-112f`, 7 of 8 seeds found the good floor at 1200 iterations and
 * NONE of them did at 19200, by which point the plane had sunk 7.4 cm and its support had
 * fallen from 14.6% to 13.3%. The outdoor run's spread went 24.6 → 31.9 → 49.1 cm as
 * iterations rose. RANSAC converges because it takes the arg-max of a score over all the
 * data; take a minimum instead and the guarantee is gone.
 *
 * Ranking every candidate on `groundPlaneQuality` restores it. Across the five
 * reconstructions at the operating resolution the seed now moves the floor by at most
 * 0.23 cm and 0.04°, against 10–40 cm and 5–15° before.
 *
 * "Lowest, not largest" has not been abandoned — it has been made continuous. A tabletop
 * and a ceiling are rejected by the below-plane penalty, which is decision 3 expressed as
 * a score instead of a tiebreak, and unlike a tiebreak it can be weighed against the
 * evidence rather than applied after it. The scale that penalty is measured on matters as
 * much as the ranking: see `belowScale`.
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

  const proposalFraction = Math.max(0.01, Math.min(1, opts.candidateLowestFraction));
  const proposal =
    proposalFraction < 1
      ? Int32Array.from(
          Array.from(sampled)
            .sort((a, b) => dot(pointAt(points, a), up) - dot(pointAt(points, b), up))
            .slice(0, Math.max(3, Math.ceil(sampled.length * proposalFraction))),
        )
      : sampled;
  const random = makeRandom(opts.seed);
  const pick = () => proposal[Math.min(proposal.length - 1, Math.floor(random() * proposal.length))];

  // Total weight of the sampled cloud, so a candidate's support can be expressed as a
  // fraction on the same scale the reported `inlierFraction` uses.
  let totalWeight = 0;
  for (let i = 0; i < sampled.length; i++) {
    totalWeight += opts.weights ? opts.weights[sampled[i]] : 1;
  }
  totalWeight = Math.max(1e-9, totalWeight);

  interface Candidate {
    plane: Plane;
    support: Support;
    quality: number;
  }

  let chosen: Candidate | null = null;
  let candidatesConsidered = 0;

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
    candidatesConsidered += 1;
    if (support.count < opts.minInliers) continue;

    const quality = groundPlaneQuality(
      {
        plane,
        inlierCount: support.count,
        // WEIGHTED, so a confidence map can still veto a surface: zeroing the weights
        // over the floor has to remove the floor's support, not merely discount it.
        inlierFraction: support.weight / totalWeight,
        rmse: Math.sqrt(support.squared / support.count),
        tiltDeg: angleBetweenDeg(plane.normal, up),
        elevation: -plane.offset,
        candidatesConsidered: 0,
        belowFraction: support.belowCount / sampled.length,
        tiltClamped: false,
        seed: opts.seed,
      },
      opts,
    );
    if (!chosen || quality > chosen.quality) chosen = { plane, support, quality };
  }

  if (!chosen) {
    throw new GroundPlaneNotFoundError(
      candidatesConsidered === 0
        ? `no horizontal plane found within ${opts.maxTiltDeg}° of the up axis after ` +
            `${opts.iterations} iterations — either the floor is not in the cloud, or the ` +
            `gravity estimate is wrong (check its coherence before trusting it)`
        : `${candidatesConsidered} horizontal planes were found within ${opts.maxTiltDeg}° of ` +
            `the up axis, and none of them had ${opts.minInliers} points supporting it — the ` +
            `cloud has flat surfaces at this orientation but none with enough evidence to ` +
            `measure heights against`,
    );
  }

  let inliers = collectInliers(chosen.plane, points, sampled, opts.inlierDistance);
  let plane = chosen.plane;
  let tiltClamped = false;

  /**
   * Accept a refinement only if it stays inside the tilt gate.
   *
   * The orientation gate above rejects a tilted CANDIDATE, but least-squares refinement
   * afterwards is free to rotate the winner, and the tilt reported at the end was never
   * re-checked. Measured 2026-08-07 on `door-504px-112f`: `maxTiltDeg` set to 10° returned
   * a plane reported at 11.3°. A control that does not bound the number it controls makes
   * every fit unfalsifiable — the operator cannot tell a floor the gate allowed from one
   * it should have excluded.
   *
   * Refusing the refinement rather than the whole fit is deliberate. Refinement is an
   * improvement step, not the evidence; declining it returns the last plane that DID
   * satisfy the gate, so no floor accepted before this change is rejected by it. The
   * caller is told, because a silently unrefined plane is its own kind of lie.
   */
  const accept = (candidate: Plane | null): boolean => {
    if (!candidate) return false;
    if (angleBetweenDeg(candidate.normal, up) > opts.maxTiltDeg) {
      tiltClamped = true;
      return false;
    }
    plane = candidate;
    // Re-collect against the refined plane: refinement moves it, so the old inlier set is
    // no longer exactly the set of points within the band.
    inliers = collectInliers(plane, points, sampled, opts.inlierDistance);
    return true;
  };

  accept(refine(points, inliers, opts.weights, up));
  accept(refine(points, inliers, opts.weights, up));

  if (inliers.length < opts.minInliers) {
    throw new GroundPlaneNotFoundError(
      `best horizontal plane has only ${inliers.length} inliers (minimum ${opts.minInliers}) — ` +
        `too little floor is visible to measure heights against`,
    );
  }

  // Final gate: the ground is the surface with nothing under it.
  //
  // This replaced a footprint-density test that looked principled and did not survive
  // contact with real data: a walkthrough sees the floor at a grazing angle, so the real
  // floor fills only ~10% of its own bounding box while a WRONG mid-scene plane fills
  // 26%. Density penalises exactly the surface we want. What separates them cleanly is
  // how much of the cloud sits below: 4.3% for the floor, 60.6% for the mid-scene plane.
  const below = belowFraction(plane, points, sampled);
  if (below > opts.maxBelowFraction) {
    throw new GroundPlaneNotFoundError(
      `the best horizontal candidate has ${(below * 100).toFixed(0)}% of the cloud BELOW it ` +
        `(maximum ${(opts.maxBelowFraction * 100).toFixed(0)}%), so it is a surface part way ` +
        `up the scene rather than its ground. Either the floor is not in the cloud, or the ` +
        `gravity estimate is too far off to gate on.`,
    );
  }

  return {
    plane,
    inlierCount: inliers.length,
    inlierFraction: inliers.length / sampled.length,
    rmse: rmsError(plane, points, inliers),
    tiltDeg: angleBetweenDeg(plane.normal, up),
    elevation: -plane.offset,
    candidatesConsidered,
    belowFraction: below,
    tiltClamped,
    seed: opts.seed,
  };
}

/**
 * Fit several physically plausible floor hypotheses and keep the strongest one.
 *
 * A hard lower-cloud crop fixed sparse floors in one reconstruction and created a
 * diagonal floor in another. Treating full-cloud and lower-region sampling as competing
 * hypotheses retains both useful behaviours and makes the decision from measured
 * evidence instead of a clip-specific constant.
 */
export function fitGroundPlaneRobust(
  points: ArrayLike<number>,
  options: RobustGroundPlaneOptions,
): RobustGroundPlaneFit {
  const {
    proposalFractions = [1, 0.35],
    minInlierFraction = 0.01,
    ...fitOptions
  } = options;
  const fractions = Array.from(
    new Set(proposalFractions.map((value) => Math.max(0.01, Math.min(1, value)))),
  );
  const hypotheses: GroundPlaneHypothesis[] = [];
  const failures: string[] = [];

  for (const proposalFraction of fractions) {
    try {
      const fit = fitGroundPlane(points, {
        ...fitOptions,
        candidateLowestFraction: proposalFraction,
      });
      hypotheses.push({
        proposalFraction,
        qualityScore: groundPlaneQuality(fit, fitOptions),
        fit,
      });
    } catch (error) {
      failures.push(
        `${Math.round(proposalFraction * 100)}% proposals: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const chosen = hypotheses.sort((a, b) => b.qualityScore - a.qualityScore)[0];
  if (!chosen) {
    throw new GroundPlaneNotFoundError(
      `no floor hypothesis survived: ${failures.join(" | ")}`,
    );
  }
  if (chosen.fit.inlierFraction < minInlierFraction) {
    throw new GroundPlaneNotFoundError(
      `best floor hypothesis has only ${(chosen.fit.inlierFraction * 100).toFixed(2)}% support ` +
        `(minimum ${(minInlierFraction * 100).toFixed(2)}%) — do not project measurements ` +
        `from a numerically thin plane`,
    );
  }

  return {
    ...chosen.fit,
    proposalFraction: chosen.proposalFraction,
    qualityScore: chosen.qualityScore,
    hypotheses,
  };
}

/**
 * Legacy explicit two-pass helper.
 *
 * Useful only when the caller has independently validated the first plane. Do not use
 * it as automatic floor selection: a wrong first plane becomes the second pass's frame
 * of reference, which caused the visibly tilted M3b door-floor regression.
 */
export function fitGroundPlaneTwoPass(
  points: ArrayLike<number>,
  options: GroundPlaneOptions,
): TwoPassGroundPlaneFit {
  const initial = fitGroundPlane(points, options);
  const refined = fitGroundPlane(points, {
    ...options,
    up: initial.plane.normal,
    maxTiltDeg: Math.min(options.maxTiltDeg ?? DEFAULTS.maxTiltDeg, 10),
    seed: (options.seed ?? DEFAULTS.seed) + 1,
  });
  return { initial, refined };
}

/**
 * Move an independently validated, already-oriented plane onto a robust lower envelope.
 *
 * RANSAC is good at recovering a floor normal but a sparse walkthrough can leave its
 * chosen parallel plane partway up the room. A low percentile is the robust version of
 * "lowest point": it ignores a few reconstruction outliers while using wall bottoms and
 * floor points that never formed a dense enough plane proposal on their own. Do not use
 * this to rescue an unvalidated automatic plane; the anchor can amplify a bad normal.
 */
export function anchorGroundPlaneToLowQuantile(
  points: ArrayLike<number>,
  fit: GroundPlaneFit,
  quantile = 2,
  stride = 1,
  inlierDistance = 0.035,
): GroundPlaneFit {
  const step = Math.max(1, Math.floor(stride));
  const heights: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3 * step) {
    const value = dot(fit.plane.normal, [points[i], points[i + 1], points[i + 2]]);
    if (Number.isFinite(value)) heights.push(value);
  }
  if (heights.length < 3) throw new GroundPlaneNotFoundError("not enough points to anchor the floor");
  heights.sort((a, b) => a - b);
  const rank = Math.ceil((Math.max(0, Math.min(100, quantile)) / 100) * heights.length);
  const elevation = heights[Math.min(heights.length - 1, Math.max(0, rank - 1))];
  const plane: Plane = { normal: fit.plane.normal, offset: -elevation };
  let inlierCount = 0;
  let squared = 0;
  let below = 0;
  for (let i = 0; i + 2 < points.length; i += 3 * step) {
    const distance = signedHeight(plane, [points[i], points[i + 1], points[i + 2]]);
    if (Math.abs(distance) <= inlierDistance) {
      inlierCount += 1;
      squared += distance * distance;
    }
    if (distance < -0.05) below += 1;
  }
  return {
    ...fit,
    plane,
    elevation,
    inlierCount,
    inlierFraction: inlierCount / heights.length,
    rmse: inlierCount > 0 ? Math.sqrt(squared / inlierCount) : NaN,
    belowFraction: below / heights.length,
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
    belowFraction: belowFraction(plane, points, sampled),
    // The seeded fit has no tilt gate to clamp against: the operator picked the three
    // points, and overriding their choice with a limit meant for random candidates would
    // defeat the reason this path exists.
    tiltClamped: false,
    seed: opts.seed,
  };
}
