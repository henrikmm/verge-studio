/**
 * The ground plane is the reference every height is measured against, so a wrong plane
 * is not a small error — it silently corrupts every number downstream.
 *
 * These cases pin the two priors that make the fit work, and both exist because the
 * obvious implementation was measured failing on the real fixture: plain sequential
 * RANSAC on `fixtures/room/504px-112f` returned three planes tilted 60°/34°/61° off
 * vertical. They were walls.
 */

import { describe, expect, it } from "vitest";
import { fitGroundPlane, fitPlaneFromSeeds, GroundPlaneNotFoundError } from "./plane";
import { syntheticRoom } from "./synthetic";
import { angleBetweenDeg, signedHeight, type Vec3 } from "./types";

describe("fitGroundPlane", () => {
  it("finds the floor even though the walls carry more points", () => {
    const room = syntheticRoom();
    const fit = fitGroundPlane(room.points, { up: room.up });

    expect(angleBetweenDeg(fit.plane.normal, room.up)).toBeLessThan(1);
    expect(fit.elevation).toBeCloseTo(room.truth.floorElevation, 2);
    expect(fit.rmse).toBeLessThan(0.005);
  });

  it("picks the floor over the ceiling — lowest, not largest", () => {
    // The ceiling is horizontal AND has more points than the floor (2500 vs 1600), so a
    // fitter that ranks horizontal candidates by support alone lands on the ceiling.
    const room = syntheticRoom();
    const fit = fitGroundPlane(room.points, { up: room.up });
    expect(fit.elevation).toBeLessThan(room.truth.ceilingHeight / 2);
  });

  it("works in a rotated world frame, which is the only frame DA3 ever gives us", () => {
    const room = syntheticRoom({ rotate: true });
    const fit = fitGroundPlane(room.points, { up: room.up });

    expect(angleBetweenDeg(fit.plane.normal, room.up)).toBeLessThan(1);
    expect(fit.elevation).toBeCloseTo(0, 2);
  });

  it("is deterministic — the content-hash cache depends on it", () => {
    const room = syntheticRoom({ rotate: true, noise: 0.004 });
    const a = fitGroundPlane(room.points, { up: room.up });
    const b = fitGroundPlane(room.points, { up: room.up });

    expect(a.plane.normal).toEqual(b.plane.normal);
    expect(a.plane.offset).toBe(b.plane.offset);
    expect(a.inlierCount).toBe(b.inlierCount);
  });

  it("gives a different but still-correct answer for a different seed", () => {
    const room = syntheticRoom({ noise: 0.004 });
    const a = fitGroundPlane(room.points, { up: room.up, seed: 1 });
    const b = fitGroundPlane(room.points, { up: room.up, seed: 99 });

    expect(b.seed).toBe(99);
    expect(a.elevation).toBeCloseTo(b.elevation, 2);
  });

  it("survives noisy points without drifting off the floor", () => {
    const room = syntheticRoom({ noise: 0.01, rotate: true });
    const fit = fitGroundPlane(room.points, { up: room.up, inlierDistance: 0.03 });

    expect(fit.elevation).toBeCloseTo(0, 1);
    expect(angleBetweenDeg(fit.plane.normal, room.up)).toBeLessThan(3);
  });

  it("fails loudly when no horizontal surface exists rather than returning a wall", () => {
    // Walls only: every candidate is vertical, so the orientation gate rejects them all.
    const room = syntheticRoom({ floor: false, ceiling: false, table: false });
    expect(() => fitGroundPlane(room.points, { up: room.up })).toThrow(GroundPlaneNotFoundError);
  });

  it("returns the LOWEST HORIZONTAL SURFACE, which is not always the floor", () => {
    // A documented limitation, not a bug. With the floor hidden, the lowest horizontal
    // thing in the room is the tabletop, and the fit returns it — confidently and with
    // good support (measured: 934 inliers, RMSE 0.011 m). Nothing in the geometry can
    // tell "floor" from "lowest flat thing", which is precisely why the UI has to
    // surface elevation, inlier count and tilt instead of just a number.
    const room = syntheticRoom({ floor: false, ceiling: false });
    const fit = fitGroundPlane(room.points, { up: room.up });
    expect(fit.elevation).toBeCloseTo(room.truth.tableHeight, 1);
    expect(fit.inlierCount).toBeGreaterThan(500);
  });

  it("fails loudly when the floor is too sparse to trust", () => {
    const room = syntheticRoom();
    expect(() =>
      fitGroundPlane(room.points, { up: room.up, minInliers: 1_000_000 }),
    ).toThrow(GroundPlaneNotFoundError);
  });

  it("refuses a cloud with fewer than three points", () => {
    expect(() => fitGroundPlane(new Float32Array([0, 0, 0]), { up: [0, 1, 0] })).toThrow(
      GroundPlaneNotFoundError,
    );
  });

  it("reports tilt against the supplied up axis", () => {
    const room = syntheticRoom();
    const fit = fitGroundPlane(room.points, { up: room.up });
    expect(fit.tiltDeg).toBeGreaterThanOrEqual(0);
    expect(fit.tiltDeg).toBeLessThan(1);
  });

  it("makes a wrong gravity estimate look wrong instead of plausible", () => {
    // Claim "up" is 45° off vertical: the real floor, ceiling and tabletop are all now
    // outside a 10° gate, so the only survivors are spurious planes slicing diagonally
    // through the wall grids. They still pass — an orientation gate cannot prove a plane
    // is real — but their support collapses (measured: 1.1% vs 14.1% of points). That
    // gap is the signal the UI must show, which is why `inlierFraction` is returned.
    const room = syntheticRoom();
    const correct = fitGroundPlane(room.points, { up: room.up });
    const wrong = fitGroundPlane(room.points, { up: [0.7071, 0.7071, 0] as Vec3, maxTiltDeg: 10 });

    expect(wrong.inlierFraction).toBeLessThan(correct.inlierFraction / 5);
  });

  it("lets confidence weights suppress a decoy surface", () => {
    const room = syntheticRoom();
    const zeroed = new Float32Array(room.confidence.length).fill(1);
    // Zero the confidence of every point at the floor: the fit should then be forced up
    // to the next well-supported horizontal surface instead of returning the floor.
    for (let i = 0; i < zeroed.length; i++) {
      const y = room.points[i * 3 + 1];
      if (Math.abs(y) < 0.05) zeroed[i] = 0;
    }
    const fit = fitGroundPlane(room.points, { up: room.up, weights: zeroed, minInliers: 10 });
    expect(fit.elevation).toBeGreaterThan(0.1);
  });

  it("subsamples deterministically when strided", () => {
    const room = syntheticRoom();
    const a = fitGroundPlane(room.points, { up: room.up, stride: 4 });
    const b = fitGroundPlane(room.points, { up: room.up, stride: 4 });
    expect(a.plane.offset).toBe(b.plane.offset);
    expect(a.elevation).toBeCloseTo(0, 2);
  });
});

describe("fitPlaneFromSeeds", () => {
  it("fits the floor from three hand-picked points", () => {
    const room = syntheticRoom();
    const seeds: Vec3[] = [
      [-1.5, 0, -1.5],
      [1.5, 0, -1.2],
      [0.2, 0, 1.6],
    ];
    const fit = fitPlaneFromSeeds(room.points, seeds, { up: room.up });

    expect(angleBetweenDeg(fit.plane.normal, room.up)).toBeLessThan(1);
    expect(fit.elevation).toBeCloseTo(0, 2);
    expect(fit.inlierCount).toBeGreaterThan(100);
  });

  it("rejects collinear seeds instead of returning a meaningless plane", () => {
    const room = syntheticRoom();
    const collinear: Vec3[] = [
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ];
    expect(() => fitPlaneFromSeeds(room.points, collinear, { up: room.up })).toThrow(
      GroundPlaneNotFoundError,
    );
  });

  it("needs at least three seeds", () => {
    const room = syntheticRoom();
    expect(() =>
      fitPlaneFromSeeds(room.points, [[0, 0, 0], [1, 0, 0]], { up: room.up }),
    ).toThrow(GroundPlaneNotFoundError);
  });
});

describe("plane conventions", () => {
  it("orients the normal upwards so heights read positive above the floor", () => {
    const room = syntheticRoom();
    const fit = fitGroundPlane(room.points, { up: room.up });
    expect(signedHeight(fit.plane, [0, 1, 0])).toBeGreaterThan(0);
    expect(signedHeight(fit.plane, [0, -1, 0])).toBeLessThan(0);
  });
});
