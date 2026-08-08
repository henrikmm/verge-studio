/**
 * Measuring the flat surfaces in a scene without anyone painting anything.
 *
 * Every measurement this project has graded came from a mask: a person paints an object
 * on a photograph, those pixels become 3D points, and a height percentile is taken. That
 * makes the operator part of the instrument. It is a good instrument — the same person
 * repeats an endpoint to 1–6 mm — but it cannot check itself, and a mask placed slightly
 * wrong produces a confident number with nothing to contradict it. The 1.887 m door is
 * the case on record: a plausible spread, a supported floor, and 21 cm of error that no
 * reported statistic could see.
 *
 * This is a second instrument that shares nothing with the first. It uses no mask, no
 * segmentation model and no operator. The idea is one sentence: A HORIZONTAL SURFACE PUTS
 * ALL OF ITS POINTS AT THE SAME HEIGHT. Take every point's height above the fitted floor,
 * count how many land in each 5 mm band, and the flat surfaces appear as spikes — the
 * floor at 0, a tabletop at its own height, a seat, a shelf. A wall contributes evenly to
 * every band and makes no spike at all.
 *
 * So the height of the tabletop spike IS the floor-to-tabletop measurement, taken from
 * tens of thousands of points at once, and it can be compared against a tape measure.
 *
 * It grades the floor as well, which is the part no existing number does. Support, tilt
 * and RMSE all say how well the plane fits the points it chose; none of them says whether
 * the plane is level with the real floor. A tabletop 1.2 m across, measured against a
 * floor whose normal is wrong by 2°, smears its spike over 1.2 × sin 2° = 4.2 cm. The
 * spike's THICKNESS is therefore a direct reading of how wrong the floor's orientation is,
 * from a surface the fit never used.
 */

import { median, nmad } from "./measure";
import { basisFromUp, dot, signedHeight, type Plane, type Vec3 } from "./types";

export interface Level {
  /** Height above the fitted plane, in metres. The floor itself appears near 0. */
  height: number;
  /** Points inside the level's band. */
  count: number;
  /** Share of all sampled points. */
  fraction: number;
  /**
   * How flat the surface is, in metres: the robust spread of point heights inside the
   * band. Reads the reconstruction's noise and the floor's orientation error together.
   */
  thickness: number;
  /**
   * How much this stands out from its surroundings: the peak band's population divided by
   * the median population nearby. 1 is no feature at all; a real surface is well above 2.
   */
  prominence: number;
  /**
   * The surface's robust width along its narrower horizontal direction, in metres. What
   * separates a surface from a horizontal LINE — a shelf lip, a step nosing, or a row of
   * a regular sampling lattice — all of which put many points at one exact height without
   * being anything you could stand a tape measure on.
   */
  extent: number;
}

export interface LevelOptions {
  /** Histogram resolution, in metres. */
  binSize?: number;
  /** Ignore heights outside this range, in metres. */
  range?: readonly [number, number];
  /** A peak must be the strict maximum within this distance, in metres. */
  separation?: number;
  /** Points within this distance of a peak define its height and thickness, in metres. */
  halfBand?: number;
  /** Drop peaks holding less than this share of the cloud. */
  minFraction?: number;
  /** Drop peaks below this prominence. */
  minProminence?: number;
  /** Drop peaks narrower than this in either horizontal direction, in metres. */
  minExtent?: number;
  /** Use every Nth point. Purely a speed knob. */
  stride?: number;
}

const DEFAULTS = {
  binSize: 0.005,
  range: [-0.25, 3] as const,
  // 5 cm apart, because two real surfaces closer than that are not separable at this
  // reconstruction's noise level and reporting them as two would be an invention.
  separation: 0.05,
  halfBand: 0.02,
  minFraction: 0.002,
  minProminence: 2,
  // 5 cm across in its narrower direction. Below that it is an edge, not a surface.
  minExtent: 0.05,
  stride: 1,
};

/**
 * The horizontal surfaces in a cloud, as heights above `plane`, strongest first.
 *
 * `points` is a flat xyz array. Heights are measured along the plane's normal, so this
 * inherits the floor's orientation on purpose — that is what lets a smeared spike report
 * a tilted floor.
 */
export function horizontalLevels(
  points: ArrayLike<number>,
  plane: Plane,
  options: LevelOptions = {},
): Level[] {
  const opts = { ...DEFAULTS, ...options };
  const binSize = Math.max(1e-4, opts.binSize);
  const [low, high] = opts.range;
  const stride = Math.max(1, Math.floor(opts.stride));

  const binCount = Math.max(1, Math.ceil((high - low) / binSize));
  const bins = new Int32Array(binCount);
  // Height plus the point's two in-plane coordinates, kept together so a peak's width can
  // be measured without walking the cloud a second time.
  const { e1, e2 } = basisFromUp(plane.normal);
  const samples: { h: number; u: number; v: number }[] = [];
  let sampled = 0;

  for (let i = 0; i + 2 < points.length; i += 3 * stride) {
    const p: Vec3 = [points[i], points[i + 1], points[i + 2]];
    const h = signedHeight(plane, p);
    if (!Number.isFinite(h)) continue;
    sampled += 1;
    if (h < low || h >= high) continue;
    bins[Math.min(binCount - 1, Math.floor((h - low) / binSize))] += 1;
    samples.push({ h, u: dot(p, e1), v: dot(p, e2) });
  }
  if (sampled === 0 || samples.length === 0) return [];
  samples.sort((a, b) => a.h - b.h);
  const heights = samples.map((s) => s.h);

  const window = Math.max(1, Math.round(opts.separation / binSize));
  const levels: Level[] = [];

  for (let b = 0; b < binCount; b++) {
    const population = bins[b];
    if (population === 0) continue;

    // A peak is the strict maximum of its neighbourhood. Ties are broken towards the
    // lower bin so one broad surface reports once rather than twice.
    let isPeak = true;
    for (let k = Math.max(0, b - window); k <= Math.min(binCount - 1, b + window); k++) {
      if (k === b) continue;
      if (bins[k] > population || (bins[k] === population && k < b)) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;

    // Background over bins that HOLD SOMETHING. Counting the empty space outside the
    // cloud would make every scene's lowest surface look infinitely prominent, which is
    // precisely where the floor is and precisely where a false reading costs most.
    const neighbourhood: number[] = [];
    for (let k = Math.max(0, b - window); k <= Math.min(binCount - 1, b + window); k++) {
      if (k !== b && bins[k] > 0) neighbourhood.push(bins[k]);
    }
    if (neighbourhood.length === 0) continue;
    const prominence = population / Math.max(1, median(neighbourhood));
    if (prominence < opts.minProminence) continue;

    // Take the height from the POINTS, not the bin, so the answer is not quantised to the
    // histogram. The median resists the tail of points that belong to whatever the
    // surface is carrying.
    const centre = low + (b + 0.5) * binSize;
    const from = lowerBound(heights, centre - opts.halfBand);
    const to = lowerBound(heights, centre + opts.halfBand);
    if (to <= from) continue;
    const fraction = (to - from) / sampled;
    if (fraction < opts.minFraction) continue;

    const band = samples.slice(from, to);
    // A surface has width in BOTH horizontal directions. A line of points at one exact
    // height does not, and there are plenty of those: a shelf lip, a step nosing, the
    // rows of a regular sampling lattice.
    const extent = Math.min(
      nmad(band.map((s) => s.u)),
      nmad(band.map((s) => s.v)),
    );
    if (extent < opts.minExtent) continue;

    levels.push({
      height: median(band.map((s) => s.h)),
      count: band.length,
      fraction,
      thickness: nmad(band.map((s) => s.h)),
      prominence,
      extent,
    });
  }

  return levels.sort((a, b) => b.count - a.count);
}

/** Index of the first element not less than `value`, in a sorted array. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The level nearest an expected height, or null if nothing is there.
 *
 * For grading against a tape measurement: ask for the surface near 0.75 m rather than
 * hunting through a list. `tolerance` is how far the answer may be and still be the same
 * surface — wide enough to admit the error being measured, narrow enough not to catch a
 * different piece of furniture.
 */
export function levelNear(
  levels: readonly Level[],
  expected: number,
  tolerance = 0.15,
): Level | null {
  let best: Level | null = null;
  for (const level of levels) {
    const distance = Math.abs(level.height - expected);
    if (distance > tolerance) continue;
    if (!best || distance < Math.abs(best.height - expected)) best = level;
  }
  return best;
}
