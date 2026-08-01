/**
 * The percentile-not-max rule is the single most important line of defence in this
 * pipeline, so it gets a test that would fail loudly if anyone "simplified" it back to
 * `Math.max`. The flying-pixel case below is not hypothetical: it is what silhouette
 * pixels do at the top edge of every object we care about.
 */

import { describe, expect, it } from "vitest";
import {
  heightsAbovePlane,
  InsufficientSupportError,
  measureDistance,
  measureHeight,
  median,
  nmad,
  percentile,
} from "./measure";
import { syntheticRoom } from "./synthetic";
import type { Plane } from "./types";

const FLOOR: Plane = { normal: [0, 1, 0], offset: 0 };

/** A slab of points at a known height, with a little surface roughness. */
function slab(height: number, count: number, roughness = 0): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = (i % 20) * 0.01;
    out[i * 3 + 1] = height + (roughness > 0 ? ((i % 7) - 3) * (roughness / 3) : 0);
    out[i * 3 + 2] = Math.floor(i / 20) * 0.01;
  }
  return out;
}

describe("statistics", () => {
  it("takes the nearest-rank percentile", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(1);
  });

  it("ignores non-finite values instead of poisoning the result", () => {
    expect(percentile([1, NaN, 3, Infinity, 5], 50)).toBe(3);
    // Nearest-rank, so an even-sized sample takes the LOWER of the two middles rather
    // than interpolating. Deliberate: interpolation invents a value no point had.
    expect(median([2, NaN, 4])).toBe(2);
  });

  it("scales MAD so it reads like a standard deviation", () => {
    // Symmetric spread of ±1 about 0 → MAD 1 → NMAD 1.4826.
    expect(nmad([-1, 0, 1])).toBeCloseTo(1.4826, 4);
  });

  it("does not let a single outlier drag NMAD, which is the whole point", () => {
    const clean = nmad([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    const withOutlier = nmad([1, 1, 1, 1, 1, 2, 2, 2, 2, 1000]);
    expect(withOutlier).toBeCloseTo(clean, 6);
  });

  it("returns NaN for an empty sample rather than 0, which would read as certainty", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(nmad([])).toBeNaN();
  });
});

describe("heightsAbovePlane", () => {
  it("measures signed height above the plane", () => {
    const heights = heightsAbovePlane(new Float32Array([0, 0.5, 0, 0, -0.25, 0]), FLOOR);
    expect(Array.from(heights)).toEqual([0.5, -0.25]);
  });
});

describe("measureHeight", () => {
  it("recovers a known height from a clean slab", () => {
    const result = measureHeight(slab(0.75, 400), FLOOR);
    expect(result.height).toBeCloseTo(0.75, 6);
    expect(result.pointCount).toBe(400);
  });

  it("IGNORES FLYING PIXELS that a max() would have believed", () => {
    // 400 good points on the object's top face at 0.75, plus 4 silhouette pixels that
    // landed way out in space. This is exactly the failure the percentile rule exists
    // for: `max` reports 1.9 m, a 153% error on a 0.75 m object.
    const good = slab(0.75, 400);
    const points = new Float32Array(good.length + 12);
    points.set(good);
    const strays = [1.2, 1.5, 1.7, 1.9];
    strays.forEach((y, i) => {
      points[good.length + i * 3] = 0;
      points[good.length + i * 3 + 1] = y;
      points[good.length + i * 3 + 2] = 0;
    });

    const result = measureHeight(points, FLOOR, { minPoints: 10 });
    expect(result.maxHeight).toBeCloseTo(1.9, 6);
    expect(result.height).toBeCloseTo(0.75, 2);
    expect(Math.abs(result.height - 0.75)).toBeLessThan(0.05);
  });

  it("reports surface roughness as the uncertainty", () => {
    const rough = measureHeight(slab(0.75, 400, 0.02), FLOOR);
    const smooth = measureHeight(slab(0.75, 400, 0), FLOOR);
    expect(rough.uncertainty).toBeGreaterThan(smooth.uncertainty);
  });

  it("folds the ground plane's own error into the uncertainty in quadrature", () => {
    const withPlaneError = measureHeight(slab(0.75, 400, 0.02), FLOOR, { planeRmse: 0.03 });
    const withoutPlaneError = measureHeight(slab(0.75, 400, 0.02), FLOOR);
    expect(withPlaneError.uncertainty).toBeCloseTo(
      Math.hypot(withoutPlaneError.uncertainty, 0.03),
      6,
    );
  });

  it("refuses to report from too few points rather than guessing", () => {
    expect(() => measureHeight(slab(0.75, 10), FLOOR)).toThrow(InsufficientSupportError);
    expect(() => measureHeight(slab(0.75, 10), FLOOR)).toThrow(/too sparse/);
  });

  it("honours a custom percentile", () => {
    const result = measureHeight(slab(0.75, 400), FLOOR, { percentile: 50 });
    expect(result.percentile).toBe(50);
  });

  it("measures the synthetic table at its exact true height", () => {
    const room = syntheticRoom();
    const result = measureHeight(room.tablePoints, FLOOR, { minPoints: 100 });
    expect(result.height).toBeCloseTo(room.truth.tableHeight, 3);
  });

  it("still works when the world frame is rotated", () => {
    const room = syntheticRoom({ rotate: true });
    // Plane through the origin with the rotated up as its normal.
    const plane: Plane = { normal: room.up, offset: 0 };
    const result = measureHeight(room.tablePoints, plane, { minPoints: 100 });
    expect(result.height).toBeCloseTo(room.truth.tableHeight, 3);
  });
});

describe("measureDistance", () => {
  it("measures a straight line between two world points", () => {
    expect(measureDistance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 9);
  });
});
