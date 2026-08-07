/**
 * The maths behind the floor overlay.
 *
 * Worth pinning because these drawings are used to JUDGE a fit, so a bug here does not look like a
 * bug — it looks like a verdict. A grid built in the gravity basis instead of the plane's own
 * would draw a level grid through a tilted floor and quietly hide the disagreement the overlay
 * exists to reveal, and it would look perfectly fine on screen.
 */

import { describe, expect, it } from "vitest";
import { buildGridSegments, chooseGridSpacing, collectPointsBelow } from "./floor-overlay";
import { signedHeight, type Plane, type Vec3 } from "../../../geometry";

/** A level floor 1 m below the origin, in the y-up convention the tests read most easily. */
const LEVEL: Plane = { normal: [0, 1, 0], offset: 1 };
/** The same floor rolled 30° about x, still through (0,-1,0) — what a grid has to stay glued to. */
const TILTED: Plane = {
  normal: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
  offset: Math.cos(Math.PI / 6),
};

describe("chooseGridSpacing", () => {
  it("picks a spacing a person can reckon with, never an arbitrary fraction", () => {
    const allowed = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50];
    for (const radius of [0.1, 0.4, 1.7, 3, 8.25, 40, 300]) {
      expect(allowed).toContain(chooseGridSpacing(radius));
    }
  });

  it("keeps a small patch legible and a large one from becoming a solid sheet", () => {
    // Roughly a dozen divisions across the diameter at both extremes of scale.
    for (const radius of [0.5, 2, 10, 60]) {
      const divisions = (radius * 2) / chooseGridSpacing(radius);
      expect(divisions).toBeGreaterThan(2);
      expect(divisions).toBeLessThan(30);
    }
  });

  it("survives a degenerate radius rather than dividing by zero", () => {
    expect(chooseGridSpacing(0)).toBe(0.05);
    expect(chooseGridSpacing(-1)).toBe(0.05);
  });
});

describe("buildGridSegments", () => {
  const center = [0, -1, 0] as const;

  it("puts every vertex ON the plane, for a tilted floor as well as a level one", () => {
    for (const plane of [LEVEL, TILTED]) {
      const segments = buildGridSegments(plane, center, 2, 0.5);
      expect(segments.length).toBeGreaterThan(0);
      for (let i = 0; i + 2 < segments.length; i += 3) {
        const height = signedHeight(plane, [segments[i], segments[i + 1], segments[i + 2]]);
        expect(Math.abs(height)).toBeLessThan(1e-5);
      }
    }
  });

  it("clips to the circle, so no line runs past the evidence backing it", () => {
    const radius = 2;
    const segments = buildGridSegments(LEVEL, center, radius, 0.5);
    for (let i = 0; i + 2 < segments.length; i += 3) {
      const dx = segments[i] - center[0];
      const dy = segments[i + 1] - center[1];
      const dz = segments[i + 2] - center[2];
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(radius + 1e-6);
    }
  });

  it("drops a centre that is off the plane onto it, instead of drawing a floating grid", () => {
    // Half a metre above the floor. A grid hovering there looks exactly like a floor fitted half a
    // metre too high, which is a wrong verdict rendered as a convincing picture.
    const floating = [0, -0.5, 0] as const;
    const segments = buildGridSegments(LEVEL, floating, 2, 0.5);
    expect(segments.length).toBeGreaterThan(0);
    for (let i = 0; i + 2 < segments.length; i += 3) {
      const height = signedHeight(LEVEL, [segments[i], segments[i + 1], segments[i + 2]]);
      expect(Math.abs(height)).toBeLessThan(1e-5);
    }
  });

  it("emits whole segments — a stray vertex would draw a line to the origin", () => {
    const segments = buildGridSegments(LEVEL, center, 2, 0.5);
    expect(segments.length % 6).toBe(0);
  });

  it("returns nothing rather than hanging or NaN on a degenerate request", () => {
    expect(buildGridSegments(LEVEL, center, 0, 0.5).length).toBe(0);
    expect(buildGridSegments(LEVEL, center, 2, 0).length).toBe(0);
    expect(buildGridSegments(LEVEL, center, -2, 0.5).length).toBe(0);
  });

  it("gets denser as the spacing tightens", () => {
    const coarse = buildGridSegments(LEVEL, center, 2, 1).length;
    const fine = buildGridSegments(LEVEL, center, 2, 0.25).length;
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe("collectPointsBelow", () => {
  it("takes what is under the plane and leaves what is on or above it", () => {
    const positions = Float32Array.from([
      0, -2, 0, // 1 m under: below
      0, -1, 0, // on the plane: not below
      0, 0, 0, // 1 m above: not below
      1, -5, 1, // well under: below
    ]);
    const below = collectPointsBelow(positions, LEVEL);
    expect(below.length / 3).toBe(2);
    expect(Array.from(below)).toEqual([0, -2, 0, 1, -5, 1]);
  });

  it("uses the same 5 cm tolerance the reported BELOW percentage uses", () => {
    // A point 4 cm under is inside the band and must NOT be drawn, or the picture would accuse a
    // floor of something its own statistic does not.
    const justInside = Float32Array.from([0, -1.04, 0]);
    const justOutside = Float32Array.from([0, -1.06, 0]);
    expect(collectPointsBelow(justInside, LEVEL).length).toBe(0);
    expect(collectPointsBelow(justOutside, LEVEL).length).toBe(3);
  });

  it("agrees with the fit's own belowFraction on a synthetic scene", () => {
    // 100 points, 30 of them a clear metre under the floor.
    const positions = new Float32Array(100 * 3);
    for (let i = 0; i < 100; i++) {
      positions[i * 3] = i * 0.01;
      positions[i * 3 + 1] = i < 30 ? -2 : 0;
      positions[i * 3 + 2] = 0;
    }
    const fraction = collectPointsBelow(positions, LEVEL).length / 3 / 100;
    expect(fraction).toBeCloseTo(0.3, 6);
  });

  it("measures along the plane's normal, not along world down", () => {
    // (0,-1.4,1) sits ABOVE the tilted floor — the plane has dropped to y≈-1.577 by z=1 — while
    // being LOWER in world y than the plane's centre at y=-1. A naive "is it under the centre"
    // test would light this point up; only a normal-based one leaves it alone.
    const above: Vec3 = [0, -1.4, 1];
    expect(signedHeight(TILTED, above)).toBeGreaterThan(0);
    expect(collectPointsBelow(Float32Array.from(above), TILTED).length).toBe(0);
  });
});
