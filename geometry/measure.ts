/**
 * Turning a set of points into a height, honestly.
 *
 * The naive version — "take the highest point" — is the single biggest accuracy trap in
 * this whole pipeline, and two unrelated literatures say so. Object silhouettes produce
 * "flying pixels": boundary pixels blend foreground and background depth, so they land
 * strung out in space between the object and whatever is behind it. The top edge of a
 * door is *entirely* silhouette, which is exactly where a `max()` would sample. Forestry
 * canopy-height pipelines reached the same conclusion from the other direction and use
 * per-cell P95 rather than max for treetops.
 *
 * So: a high percentile, never the maximum.
 *
 * The uncertainty is not decoration either. Following the M3C2 convention (local surface
 * roughness + point density + registration error → a stated confidence interval), we
 * combine the roughness of the sampled top surface with the ground plane's own fit error.
 * NMAD (median absolute deviation × 1.4826) is the robust dispersion estimator that
 * pairs with a median/percentile estimate — it does not get dragged by the same outliers
 * the percentile exists to dodge, and the scaling makes it read like a standard deviation.
 */

import { signedHeight, type Plane, type Vec3 } from "./types";

/** MAD → σ-comparable, under a Gaussian. */
const NMAD_SCALE = 1.4826;

export interface MeasureOptions {
  /** Which percentile of the height distribution counts as "the top". */
  percentile?: number;
  /** Refuse to report below this many usable points — sparse patches lie. */
  minPoints?: number;
  /** Half-thickness of the band around the top used to estimate surface roughness, in metres. */
  topBand?: number;
  /** RMSE of the ground-plane fit, folded into the reported uncertainty in quadrature. */
  planeRmse?: number;
}

export interface HeightMeasurement {
  /** Height above the plane, in metres. */
  height: number;
  /** ± in metres: top-surface roughness and ground-plane error, combined in quadrature. */
  uncertainty: number;
  /** Roughness of the top band alone (NMAD), before the plane error is folded in. */
  topRoughness: number;
  pointCount: number;
  topBandCount: number;
  percentile: number;
  /** Highest single point. Reported for comparison only — never use it as the height. */
  maxHeight: number;
}

export class InsufficientSupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientSupportError";
  }
}

/** Nearest-rank percentile over finite values. `sorted` must already be ascending. */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const finite = Float64Array.from(Array.from(values).filter(Number.isFinite)).sort();
  return percentileOfSorted(finite, p);
}

export function median(values: ArrayLike<number>): number {
  return percentile(values, 50);
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function nmad(values: ArrayLike<number>): number {
  const finite = Array.from(values).filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  const mid = median(finite);
  const deviations = finite.map((v) => Math.abs(v - mid));
  return NMAD_SCALE * median(deviations);
}

/** Signed heights of a flat xyz array above a plane, in the array's point order. */
export function heightsAbovePlane(points: ArrayLike<number>, plane: Plane): Float64Array {
  const count = Math.floor(points.length / 3);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const b = i * 3;
    out[i] = signedHeight(plane, [points[b], points[b + 1], points[b + 2]]);
  }
  return out;
}

/**
 * Height of an object's point set above the ground plane.
 *
 * `points` is the object's points only — i.e. the result of backprojecting its mask —
 * not the whole cloud.
 */
export function measureHeight(
  points: ArrayLike<number>,
  plane: Plane,
  options: MeasureOptions = {},
): HeightMeasurement {
  const p = options.percentile ?? 98;
  const minPoints = options.minPoints ?? 200;
  const topBand = options.topBand ?? 0.05;
  const planeRmse = options.planeRmse ?? 0;

  const heights = Array.from(heightsAbovePlane(points, plane)).filter(Number.isFinite);
  if (heights.length < minPoints) {
    throw new InsufficientSupportError(
      `only ${heights.length} usable points (minimum ${minPoints}) — too sparse to measure. ` +
        `Widen the mask, lower the confidence threshold, or pick a frame with a better view.`,
    );
  }

  const sorted = Float64Array.from(heights).sort();
  const height = percentileOfSorted(sorted, p);

  // Roughness of the top surface itself, not of the whole object: a door's height
  // uncertainty comes from how cleanly its top edge reconstructed, not from the spread
  // of the whole door.
  const band: number[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] < height - topBand) break;
    if (sorted[i] <= height + topBand) band.push(sorted[i]);
  }
  const topRoughness = band.length >= 3 ? nmad(band) : NaN;
  const roughness = Number.isFinite(topRoughness) ? topRoughness : 0;

  return {
    height,
    uncertainty: Math.hypot(roughness, planeRmse),
    topRoughness,
    pointCount: heights.length,
    topBandCount: band.length,
    percentile: p,
    maxHeight: sorted[sorted.length - 1],
  };
}

/** Straight-line distance between two world points, in metres. */
export function measureDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
