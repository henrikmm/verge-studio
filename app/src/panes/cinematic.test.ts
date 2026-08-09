/**
 * The two promises Cinematic makes, checked without WebGL: a lap is seamless, and the camera
 * never ends up under the floor. Both are properties of the pose function alone, which is why
 * it is a pure function in the first place.
 */

import { describe, expect, it } from "vitest";
import { signedHeight, type Plane, type Vec3 } from "../../../geometry";
import {
  ORBIT_RATE_DEG_S,
  angleFacing,
  cinematicPose,
  dollyFactor,
  rateFactor,
  HOLD_AFTER_INPUT_MS,
  RESUME_MS,
} from "./cinematic";

const UP: Vec3 = [0, 1, 0];
const SCENE = { center: [0, 1, 0] as Vec3, up: UP, radius: 4, centerHeight: 1 };

/** A floor at y = 0 with its normal pointing up, matching `SCENE`'s `centerHeight`. */
const FLOOR: Plane = { normal: UP, offset: 0 };

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("cinematicPose", () => {
  it("returns to the same place after a full turn", () => {
    const start = cinematicPose(SCENE, 0.7);
    const lap = cinematicPose(SCENE, 0.7 + 2 * Math.PI);
    expect(distance(start.position, lap.position)).toBeLessThan(1e-9);
    expect(lap.elevationDeg).toBeCloseTo(start.elevationDeg, 9);
  });

  it("holds its radius to within the dolly's own depth, and no more", () => {
    const radii = Array.from({ length: 64 }, (_, i) =>
      distance(cinematicPose(SCENE, (i / 64) * 2 * Math.PI).position, SCENE.center),
    );
    // The dolly is ±8%, so nothing may stray further than that from the nominal radius.
    for (const r of radii) {
      expect(r).toBeGreaterThan(SCENE.radius * 0.91);
      expect(r).toBeLessThan(SCENE.radius * 1.09);
    }
  });

  it("looks at the scene centre from every angle", () => {
    for (const angle of [0, 1, 2.5, -3]) {
      expect(cinematicPose(SCENE, angle).target).toEqual(SCENE.center);
    }
  });

  it("stays above the fitted floor all the way round", () => {
    for (let i = 0; i < 128; i += 1) {
      const pose = cinematicPose(SCENE, (i / 128) * 2 * Math.PI);
      expect(signedHeight(FLOOR, pose.position)).toBeGreaterThan(0);
    }
  });

  it("raises the shot when the scene centre sits on the floor", () => {
    // Centre at floor level: the base 18° would still clear it, but only by 1.2 m of a 4 m
    // radius. Drop the centre BELOW the floor and the base elevation is no longer enough.
    const sunken = { ...SCENE, center: [0, -3, 0] as Vec3, centerHeight: -3 };
    const pose = cinematicPose(sunken, 0);
    expect(pose.elevationDeg).toBeGreaterThan(18);
    expect(signedHeight(FLOOR, pose.position)).toBeGreaterThan(0);
  });

  it("leaves the framing alone when no floor was fitted", () => {
    const { centerHeight: _unused, ...noFloor } = SCENE;
    expect(cinematicPose(noFloor, 0).elevationDeg).toBeCloseTo(18, 6);
  });

  it("keeps the operator's zoom and tilt", () => {
    const wide = cinematicPose(SCENE, 0, 0, 2);
    const near = cinematicPose(SCENE, 0, 0, 1);
    expect(distance(wide.position, SCENE.center)).toBeCloseTo(
      distance(near.position, SCENE.center) * 2,
      6,
    );
    expect(cinematicPose(SCENE, 0, 0.3).elevationDeg).toBeGreaterThan(near.elevationDeg);
  });

  it("works with an up axis that is not +Y", () => {
    // DA3's scene is aligned to the first camera, so the measured up is routinely tilted.
    const tilted = { ...SCENE, up: [0.3, 0.9, -0.31] as Vec3 };
    const pose = cinematicPose(tilted, 1.1);
    expect(Number.isFinite(pose.position[0])).toBe(true);
    expect(distance(pose.position, tilted.center)).toBeGreaterThan(0);
  });
});

describe("dollyFactor", () => {
  it("is periodic over one revolution", () => {
    expect(dollyFactor(0.4 + 2 * Math.PI)).toBeCloseTo(dollyFactor(0.4), 12);
  });
});

describe("angleFacing", () => {
  it("recovers the angle a pose was generated at, so entering the mode does not jump", () => {
    const angle = 2.2;
    const pose = cinematicPose(SCENE, angle);
    // Modulo a full turn: atan2 returns the principal value.
    const recovered = angleFacing(SCENE, pose.position);
    expect(Math.abs(Math.sin(recovered - angle))).toBeLessThan(1e-9);
  });

  it("does not produce NaN for a camera sitting on the axis", () => {
    expect(angleFacing(SCENE, SCENE.center)).toBe(0);
  });
});

describe("rateFactor", () => {
  it("holds still while the operator is interacting, then eases back to full speed", () => {
    expect(rateFactor(0)).toBe(0);
    expect(rateFactor(HOLD_AFTER_INPUT_MS - 1)).toBe(0);
    const mid = rateFactor(HOLD_AFTER_INPUT_MS + RESUME_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(rateFactor(HOLD_AFTER_INPUT_MS + RESUME_MS)).toBe(1);
    expect(rateFactor(60_000)).toBe(1);
  });
});

describe("the rate itself", () => {
  it("is a full turn per minute", () => {
    expect((360 / ORBIT_RATE_DEG_S) * 1).toBe(60);
  });
});
