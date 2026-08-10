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

export interface VerticalExtentMeasurement {
  /** Robust top minus robust bottom along the fitted up axis, in metres. */
  height: number;
  uncertainty: number;
  bottom: number;
  top: number;
  bottomRoughness: number;
  topRoughness: number;
  pointCount: number;
  lowerPercentile: number;
  upperPercentile: number;
  minHeight: number;
  maxHeight: number;
}

export interface VerticalExtentOptions {
  lowerPercentile?: number;
  upperPercentile?: number;
  minPoints?: number;
  endBand?: number;
}

export interface EndpointGeometry {
  bottomCentroid: Vec3;
  topCentroid: Vec3;
  ruler: { bottom: Vec3; top: Vec3 };
  /** Endpoint separation perpendicular to the fitted up axis. */
  lateralOffset: number;
  /** Straight-line distance between the two endpoint centroids. */
  centroidDistance: number;
}

export interface VoxelConnectivity {
  componentCount: number;
  largestPointCount: number;
  largestPointFraction: number;
  voxelCount: number;
}

export interface EndpointEvidenceOptions {
  /** Fraction retained at each end of the full-object height distribution. */
  tailFraction?: number;
  /** Refuse an automatic measurement unless each physical endpoint has this support. */
  minPointsPerEnd?: number;
}

export interface EndpointEvidence {
  points: Float32Array;
  sourcePointCount: number;
  pointsPerEnd: number;
  tailFraction: number;
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
 * Convert a full-object segmentation into balanced endpoint evidence.
 *
 * The brush protocol historically painted compact patches at the top and bottom. A
 * full door mask is a different distribution: P2/P98 land several centimetres inside
 * the leaf simply because most points are in its middle. Keeping equal tails restores
 * the endpoint-focused evidence without letting the much larger middle dominate, while
 * the existing P2/P98 estimator still rejects the noisiest pixels inside each tail.
 */
export function selectEndpointEvidence(
  points: ArrayLike<number>,
  plane: Plane,
  options: EndpointEvidenceOptions = {},
): EndpointEvidence {
  const tailFraction = options.tailFraction ?? 0.1;
  const minPointsPerEnd = options.minPointsPerEnd ?? 40;
  if (!(tailFraction > 0 && tailFraction <= 0.25)) {
    throw new Error("selectEndpointEvidence: tailFraction must be in (0, 0.25]");
  }
  const ranked: Array<{ index: number; height: number }> = [];
  for (let index = 0; index + 2 < points.length; index += 3) {
    const height = signedHeight(plane, [points[index], points[index + 1], points[index + 2]]);
    if (Number.isFinite(height)) ranked.push({ index, height });
  }
  if (ranked.length < minPointsPerEnd * 2) {
    throw new InsufficientSupportError(
      `automatic mask has ${ranked.length} usable points, but needs at least ${minPointsPerEnd} at each endpoint. ` +
        "Refine the mask, lower the confidence threshold, or use a clearer frame.",
    );
  }
  ranked.sort((a, b) => a.height - b.height);
  const pointsPerEnd = Math.min(
    Math.floor(ranked.length / 2),
    Math.max(minPointsPerEnd, Math.floor(ranked.length * tailFraction)),
  );
  const selected = [
    ...ranked.slice(0, pointsPerEnd),
    ...ranked.slice(ranked.length - pointsPerEnd),
  ];
  const out = new Float32Array(selected.length * 3);
  selected.forEach((entry, outputIndex) => {
    out[outputIndex * 3] = points[entry.index];
    out[outputIndex * 3 + 1] = points[entry.index + 1];
    out[outputIndex * 3 + 2] = points[entry.index + 2];
  });
  return { points: out, sourcePointCount: ranked.length, pointsPerEnd, tailFraction };
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

/**
 * An object's own vertical size, independent of where it is standing.
 *
 * Both ends are percentiles: using max-min would hand the answer to the two noisiest
 * silhouette pixels. Plane elevation cancels out, but its normal supplies the vertical
 * axis so this still shares the same floor evidence as height-above-floor.
 */
export function measureVerticalExtent(
  points: ArrayLike<number>,
  plane: Plane,
  options: VerticalExtentOptions = {},
): VerticalExtentMeasurement {
  const lowerPercentile = options.lowerPercentile ?? 2;
  const upperPercentile = options.upperPercentile ?? 98;
  const minPoints = options.minPoints ?? 200;
  const endBand = options.endBand ?? 0.05;
  if (!(lowerPercentile < upperPercentile)) {
    throw new Error("measureVerticalExtent: lower percentile must be below upper percentile");
  }

  const heights = Array.from(heightsAbovePlane(points, plane)).filter(Number.isFinite);
  if (heights.length < minPoints) {
    throw new InsufficientSupportError(
      `only ${heights.length} usable points (minimum ${minPoints}) — too sparse to measure. ` +
        `Widen the mask, lower the confidence threshold, or pick a frame with a better view.`,
    );
  }
  const sorted = Float64Array.from(heights).sort();
  const bottom = percentileOfSorted(sorted, lowerPercentile);
  const top = percentileOfSorted(sorted, upperPercentile);
  const bottomBand = Array.from(sorted).filter((value) => value >= bottom - endBand && value <= bottom + endBand);
  const topBand = Array.from(sorted).filter((value) => value >= top - endBand && value <= top + endBand);
  const bottomRoughness = bottomBand.length >= 3 ? nmad(bottomBand) : 0;
  const topRoughness = topBand.length >= 3 ? nmad(topBand) : 0;

  return {
    height: top - bottom,
    uncertainty: Math.hypot(bottomRoughness, topRoughness),
    bottom,
    top,
    bottomRoughness,
    topRoughness,
    pointCount: heights.length,
    lowerPercentile,
    upperPercentile,
    minHeight: sorted[0],
    maxHeight: sorted[sorted.length - 1],
  };
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

/** Centre of the reconstructed surface close to one measured endpoint. */
export function pointBandCentroid(
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

/** Draw a vertical ruler through an endpoint anchor, regardless of the object's lean. */
export function verticalRuler(
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

/** Shared geometry behind the app ruler and the recorded-evidence inspector. */
export function endpointGeometry(
  points: ArrayLike<number>,
  plane: Plane,
  bottomHeight: number,
  topHeight: number,
  band = 0.05,
): EndpointGeometry {
  const bottomCentroid = pointBandCentroid(points, plane, bottomHeight, band);
  const topCentroid = pointBandCentroid(points, plane, topHeight, band);
  const delta: Vec3 = [
    topCentroid[0] - bottomCentroid[0],
    topCentroid[1] - bottomCentroid[1],
    topCentroid[2] - bottomCentroid[2],
  ];
  const vertical = delta[0] * plane.normal[0] + delta[1] * plane.normal[1] + delta[2] * plane.normal[2];
  const centroidDistance = Math.hypot(...delta);
  const lateralOffset = Math.sqrt(Math.max(0, centroidDistance ** 2 - vertical ** 2));
  const anchor: Vec3 = [
    (bottomCentroid[0] + topCentroid[0]) / 2,
    (bottomCentroid[1] + topCentroid[1]) / 2,
    (bottomCentroid[2] + topCentroid[2]) / 2,
  ];
  return {
    bottomCentroid,
    topCentroid,
    ruler: verticalRuler(anchor, plane, bottomHeight, topHeight),
    lateralOffset,
    centroidDistance,
  };
}

/** A compact 3D coherence diagnostic for an endpoint patch, not a segmentation algorithm. */
export function voxelConnectivity(
  points: ArrayLike<number>,
  voxelSize = 0.05,
): VoxelConnectivity {
  if (!(voxelSize > 0)) throw new Error("voxelConnectivity: voxelSize must be positive");
  const voxels = new Map<string, { xyz: [number, number, number]; points: number }>();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = Math.floor(points[i] / voxelSize);
    const y = Math.floor(points[i + 1] / voxelSize);
    const z = Math.floor(points[i + 2] / voxelSize);
    if (![x, y, z].every(Number.isFinite)) continue;
    const key = `${x},${y},${z}`;
    const existing = voxels.get(key);
    if (existing) existing.points += 1;
    else voxels.set(key, { xyz: [x, y, z], points: 1 });
  }
  const unseen = new Set(voxels.keys());
  let componentCount = 0;
  let largestPointCount = 0;
  while (unseen.size) {
    const first = unseen.values().next().value as string;
    unseen.delete(first);
    const queue = [first];
    let componentPoints = 0;
    for (let at = 0; at < queue.length; at++) {
      const current = voxels.get(queue[at]);
      if (!current) continue;
      componentPoints += current.points;
      const [cx, cy, cz] = current.xyz;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const neighbour = `${cx + dx},${cy + dy},${cz + dz}`;
            if (unseen.delete(neighbour)) queue.push(neighbour);
          }
        }
      }
    }
    componentCount += 1;
    largestPointCount = Math.max(largestPointCount, componentPoints);
  }
  const pointCount = Math.floor(points.length / 3);
  return {
    componentCount,
    largestPointCount,
    largestPointFraction: pointCount > 0 ? largestPointCount / pointCount : 0,
    voxelCount: voxels.size,
  };
}

/** Straight-line distance between two world points, in metres. */
export function measureDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
