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
  fitGroundPlaneRobust,
  fitGroundPlaneTwoPass,
  groundPlaneQuality,
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

  /**
   * The seed is the one input that carries no information about the scene, so it must
   * not change the answer. This test used to assert the opposite — that two seeds "need
   * not agree to the millimetre" — and that permission was the defect. On real clouds it
   * bought a floor that moved up to 31.9 cm depending on the seed, and every height in
   * the project inherited that spread. Eight seeds rather than two, because the failure
   * was rare on some scenes: the door fixture agreed on 7 draws in 8.
   */
  it("gives the SAME answer for every seed, because the seed knows nothing", () => {
    const room = syntheticRoom({ noise: 0.004 });
    const fits = [1, 7, 99, 1234, 5678, 90210, 424242, 7777777].map((seed) =>
      fitGroundPlane(room.points, { up: room.up, seed }),
    );

    const elevations = fits.map((fit) => fit.elevation);
    const spread = Math.max(...elevations) - Math.min(...elevations);
    // 1 mm, which is below this project's measured operator repeatability of 1–6 mm.
    expect(spread).toBeLessThan(0.001);

    const tilts = fits.map((fit) => angleBetweenDeg(fit.plane.normal, room.up));
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeLessThan(0.5);
    for (const elevation of elevations) expect(Math.abs(elevation)).toBeLessThan(0.02);
    expect(fits[2].seed).toBe(99);
  });

  /**
   * More iterations must not make the fit worse. That sounds too obvious to test, and it
   * is exactly what failed: the old rule kept the LOWEST qualifying candidate, so drawing
   * more candidates found a lower one and the floor sank. Measured 2026-08-08 on
   * `fixtures/door/504px-112f`: the mean elevation fell from -1.082 m at 1200 iterations
   * to -1.156 m at 19200, and the seed spread on the outdoor run went 24.6 -> 49.1 cm.
   */
  it("does not drift when given more iterations to search with", () => {
    const room = syntheticRoom({ noise: 0.004 });
    const elevations = [200, 800, 3200].map(
      (iterations) => fitGroundPlane(room.points, { up: room.up, iterations }).elevation,
    );
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeLessThan(0.002);
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

  /**
   * Confidence weights must be able to take a surface away — task 2 is going to feed
   * DA3's confidence map in here, and a fit that ignored the weights would make that
   * change a silent no-op. Scoring uses WEIGHTED support for exactly this reason.
   *
   * ⚠️ What it does NOT do is refuse. This test used to assert a refusal, and that
   * refusal was luck: with the floor vetoed, the old "keep the lowest candidate" rule
   * happened to land on the tabletop, which has 29% of the cloud below it, and the gate
   * threw. Checked properly on 2026-08-08 with the app's own gates, neither the old rule
   * nor the new one refuses — the old one returns a plane with 14.87% of the cloud below
   * it and 1.12% support. Both are junk and both are reported as a floor. Recognising
   * that is TASK.md task 3; it is recorded here so the next reader does not mistake this
   * test for evidence that the refusal works.
   */
  it("lets confidence weights take the floor away", () => {
    const room = syntheticRoom();
    const zeroed = new Float32Array(room.confidence.length).fill(1);
    for (let i = 0; i < zeroed.length; i++) {
      if (Math.abs(room.points[i * 3 + 1]) < 0.05) zeroed[i] = 0;
    }
    const options = { up: room.up, minInliers: 10 } as const;
    const trusted = fitGroundPlane(room.points, options);
    const vetoed = fitGroundPlane(room.points, { ...options, weights: zeroed });

    // With the floor trusted, it is found exactly and carries the scene's evidence.
    expect(trusted.elevation).toBeCloseTo(0, 2);
    expect(trusted.inlierFraction).toBeGreaterThan(0.1);

    // Vetoed, the floor is gone: whatever is returned is somewhere else and thin.
    expect(Math.abs(vetoed.elevation)).toBeGreaterThan(0.1);
    expect(vetoed.inlierFraction).toBeLessThan(0.05);
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
      iterations: 400,
    });
    expect(fit.elevation).toBeCloseTo(0, 2);
    expect(fit.belowFraction).toBeLessThan(0.15);
  });
});

describe("fitGroundPlaneRobust", () => {
  it("compares whole-cloud and lower-region hypotheses deterministically", () => {
    const room = syntheticRoom({ noise: 0.004, rotate: true });
    const a = fitGroundPlaneRobust(room.points, { up: room.up, iterations: 500 });
    const b = fitGroundPlaneRobust(room.points, { up: room.up, iterations: 500 });

    expect(a.hypotheses).toHaveLength(2);
    expect(a.plane).toEqual(b.plane);
    expect(a.proposalFraction).toBe(b.proposalFraction);
    expect(angleBetweenDeg(a.plane.normal, room.up)).toBeLessThan(2);
  });

  it("does not mistake a thin, tilted plane with low RMSE for stronger floor evidence", () => {
    const common = {
      plane: { normal: [0, 1, 0] as Vec3, offset: 0 },
      inlierCount: 100,
      elevation: 0,
      candidatesConsidered: 20,
      tiltClamped: false,
      seed: 7,
    };
    const thin = {
      ...common,
      inlierFraction: 0.007,
      rmse: 0.01,
      tiltDeg: 28,
      belowFraction: 0.015,
    };
    const supported = {
      ...common,
      inlierFraction: 0.145,
      rmse: 0.012,
      tiltDeg: 12,
      belowFraction: 0,
    };
    const options = { maxTiltDeg: 30, inlierDistance: 0.035, maxBelowFraction: 0.2 };
    expect(groundPlaneQuality(supported, options)).toBeGreaterThan(
      groundPlaneQuality(thin, options),
    );
  });

  it("fails instead of rendering a plane below the minimum support fraction", () => {
    const room = syntheticRoom();
    expect(() => fitGroundPlaneRobust(room.points, { up: room.up, minInlierFraction: 0.9 }))
      .toThrow(/numerically thin plane/);
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
