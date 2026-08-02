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
import {
  fitGroundPlane,
  fitGroundPlaneTwoPass,
  anchorGroundPlaneToLowQuantile,
  fitPlaneFromSeeds,
  GroundPlaneNotFoundError,
} from "./plane";
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
    // Both land on the floor; they need not agree to the millimetre, because a different
    // seed samples a different triple. Agreeing on the SURFACE is the property that matters.
    expect(Math.abs(a.elevation)).toBeLessThan(0.02);
    expect(Math.abs(b.elevation)).toBeLessThan(0.02);
  });

  it("survives noisy points without drifting off the floor", () => {
    const room = syntheticRoom({ noise: 0.01, rotate: true });
    const fit = fitGroundPlane(room.points, { up: room.up, inlierDistance: 0.03 });

    expect(fit.elevation).toBeCloseTo(0, 1);
    expect(angleBetweenDeg(fit.plane.normal, room.up)).toBeLessThan(3);
  });

  it("fails loudly on a scene with only vertical structure", () => {
    // One wall spanning well above and below the middle. Every horizontal candidate has
    // roughly half the cloud beneath it, so none of them can be ground and the fit must
    // say so rather than return the least-bad slice.
    const wall = new Float32Array(60 * 60 * 3);
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        const k = (i * 60 + j) * 3;
        wall[k] = 0;
        wall[k + 1] = -2 + (4 * i) / 59;
        wall[k + 2] = -2 + (4 * j) / 59;
      }
    }
    expect(() => fitGroundPlane(wall, { up: [0, 1, 0] })).toThrow(GroundPlaneNotFoundError);
  });

  it("settles at the BASE of the scene when the floor itself is missing", () => {
    // A documented limitation, not a bug. Nothing in the geometry can tell "the floor"
    // from "the lowest thing with nothing under it" — with the floor hidden, the bottom
    // of the walls serves. The fit is still returned, so the UI must surface elevation,
    // inlier count and tilt rather than just a number.
    const room = syntheticRoom({ floor: false, ceiling: false });
    const fit = fitGroundPlane(room.points, { up: room.up });
    expect(fit.elevation).toBeLessThan(0.3);
    expect(fit.belowFraction).toBeLessThan(0.15);
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

  it("refuses to fit at all when the gravity estimate is badly wrong", () => {
    // Claim "up" is 45° off vertical. The real floor, ceiling and tabletop all fall
    // outside a 10° gate, leaving only spurious planes slicing through the wall grids —
    // and those have 17% of the cloud beneath them, so the below-ground gate rejects
    // them. Failing here is the correct outcome: with a wrong up axis there is no
    // meaningful ground to find, and any plane returned would poison every height.
    const room = syntheticRoom();
    expect(() =>
      fitGroundPlane(room.points, { up: [0.7071, 0.7071, 0] as Vec3, maxTiltDeg: 10 }),
    ).toThrow(GroundPlaneNotFoundError);
  });

  it("lets confidence weights veto a surface — even into an honest failure", () => {
    // Zeroing DA3's confidence across the floor removes the only real ground. The fit is
    // then pushed up to the tabletop, which has 29% of the cloud below it, and the gate
    // refuses it. That is the behaviour we want from confidence gating: it can say "no
    // trustworthy ground here", rather than quietly measuring from a table.
    const room = syntheticRoom();
    const zeroed = new Float32Array(room.confidence.length).fill(1);
    for (let i = 0; i < zeroed.length; i++) {
      if (Math.abs(room.points[i * 3 + 1]) < 0.05) zeroed[i] = 0;
    }
    expect(() =>
      fitGroundPlane(room.points, { up: room.up, weights: zeroed, minInliers: 10 }),
    ).toThrow(/BELOW it/);
  });

  it("subsamples deterministically when strided", () => {
    const room = syntheticRoom();
    const a = fitGroundPlane(room.points, { up: room.up, stride: 4 });
    const b = fitGroundPlane(room.points, { up: room.up, stride: 4 });
    expect(a.plane.offset).toBe(b.plane.offset);
    expect(a.elevation).toBeCloseTo(0, 2);
  });

  it("can draw proposals from the lowest gravity-aligned part of the cloud", () => {
    const room = syntheticRoom({ noise: 0.004 });
    const fit = fitGroundPlane(room.points, {
      up: room.up,
      candidateLowestFraction: 0.25,
      // This synthetic prior is exact. Keep the orientation gate correspondingly tight
      // so a low, tilted slice through the wall grids cannot masquerade as a floor.
      maxTiltDeg: 5,
      // The synthetic floor is deliberately sparse but still much stronger than a
      // horizontal wall slice. Require that distinction in this proposal-prior test.
      supportRatio: 0.5,
      iterations: 400,
    });
    expect(fit.elevation).toBeCloseTo(0, 2);
    expect(fit.belowFraction).toBeLessThan(0.15);
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

describe("fitGroundPlaneTwoPass", () => {
  it("uses the first floor normal as the refined up axis", () => {
    const room = syntheticRoom({ rotate: true, noise: 0.004 });
    const fit = fitGroundPlaneTwoPass(room.points, { up: room.up, seed: 12, iterations: 400 });
    expect(fit.initial.seed).toBe(12);
    expect(fit.refined.seed).toBe(13);
    expect(angleBetweenDeg(fit.refined.plane.normal, fit.initial.plane.normal)).toBeLessThan(10);
    expect(fit.refined.elevation).toBeCloseTo(0, 2);
  });
});

describe("anchorGroundPlaneToLowQuantile", () => {
  it("moves a parallel plane down to the robust floor envelope", () => {
    const room = syntheticRoom();
    const fit = fitGroundPlane(room.points, { up: room.up });
    const shifted = {
      ...fit,
      plane: { normal: fit.plane.normal, offset: fit.plane.offset - 0.4 },
      elevation: fit.elevation + 0.4,
    };
    const anchored = anchorGroundPlaneToLowQuantile(room.points, shifted, 2);
    expect(anchored.elevation).toBeCloseTo(0, 2);
    expect(anchored.belowFraction).toBeLessThan(0.03);
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
