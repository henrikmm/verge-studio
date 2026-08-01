/**
 * Backprojection is the bridge between "the user selected pixels" and "we have 3D
 * points". If its camera convention is off, every measurement is wrong in a way that
 * still looks plausible — so the round-trip test below builds the forward projection
 * independently and checks the two agree.
 */

import { describe, expect, it } from "vitest";
import { backprojectMask, erodeMask, type Frame } from "./backproject";
import type { Vec3 } from "./types";

const WIDTH = 9;
const HEIGHT = 9;
const FX = 100;
const FY = 100;
const CX = 4;
const CY = 4;

const INTRINSICS = [FX, 0, CX, 0, FY, CY, 0, 0, 1];

/** Identity pose: world coordinates and camera coordinates coincide. */
const IDENTITY_POSE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** A quarter turn about Y with a translation — nothing axis-aligned survives by luck. */
const TURNED_POSE = [0, 0, 1, 0.5, 0, 1, 0, -0.25, -1, 0, 0, 1.5];

/** Forward projection, written independently of the code under test. */
function project(pose: number[], world: Vec3): { u: number; v: number; depth: number } {
  const camera: Vec3 = [
    pose[0] * world[0] + pose[1] * world[1] + pose[2] * world[2] + pose[3],
    pose[4] * world[0] + pose[5] * world[1] + pose[6] * world[2] + pose[7],
    pose[8] * world[0] + pose[9] * world[1] + pose[10] * world[2] + pose[11],
  ];
  return {
    u: (FX * camera[0]) / camera[2] + CX,
    v: (FY * camera[1]) / camera[2] + CY,
    depth: camera[2],
  };
}

function blankFrame(pose: number[]): Frame {
  return {
    depth: new Float32Array(WIDTH * HEIGHT),
    width: WIDTH,
    height: HEIGHT,
    intrinsics: INTRINSICS,
    extrinsics: pose,
  };
}

/** Mask covering the whole image, so erosion is the only thing that trims it. */
function fullMask(): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT).fill(1);
}

describe("backprojectMask", () => {
  it("round-trips a known world point through an identity pose", () => {
    const world: Vec3 = [0.02, 0.04, 2];
    const { u, v, depth } = project(IDENTITY_POSE, world);
    expect(u).toBeCloseTo(5, 9); // lands exactly on a pixel centre
    expect(v).toBeCloseTo(6, 9);

    const frame = blankFrame(IDENTITY_POSE);
    const depths = frame.depth as Float32Array;
    depths.fill(depth); // flat wall, so the discontinuity filter has nothing to reject
    const mask = new Uint8Array(WIDTH * HEIGHT);
    mask[v * WIDTH + u] = 1;

    const result = backprojectMask(frame, mask, { erodeRadius: 0 });
    expect(result.pointCount).toBe(1);
    expect(result.points[0]).toBeCloseTo(world[0], 5);
    expect(result.points[1]).toBeCloseTo(world[1], 5);
    expect(result.points[2]).toBeCloseTo(world[2], 5);
  });

  it("round-trips through a rotated, translated pose", () => {
    // Chosen so the camera-space point lands on a pixel centre INSIDE this 9x9 test
    // image: R·world + t = (0.02, 0.04, 2), which projects to exactly (5, 6).
    const world: Vec3 = [-0.5, 0.29, -0.48];
    const { u, v, depth } = project(TURNED_POSE, world);
    const pu = Math.round(u);
    const pv = Math.round(v);
    expect(Math.abs(u - pu)).toBeLessThan(1e-6);
    expect(Math.abs(v - pv)).toBeLessThan(1e-6);

    const frame = blankFrame(TURNED_POSE);
    (frame.depth as Float32Array).fill(depth);
    const mask = new Uint8Array(WIDTH * HEIGHT);
    mask[pv * WIDTH + pu] = 1;

    const result = backprojectMask(frame, mask, { erodeRadius: 0 });
    expect(result.pointCount).toBe(1);
    expect(result.points[0]).toBeCloseTo(world[0], 4);
    expect(result.points[1]).toBeCloseTo(world[1], 4);
    expect(result.points[2]).toBeCloseTo(world[2], 4);
  });

  it("erodes the mask before projecting, so silhouette pixels never enter", () => {
    const frame = blankFrame(IDENTITY_POSE);
    (frame.depth as Float32Array).fill(2);
    const result = backprojectMask(frame, fullMask(), { erodeRadius: 2 });

    // A 9x9 mask eroded by 2 leaves the central 5x5.
    expect(result.pointCount).toBe(25);
    expect(result.maskedPixels).toBe(81);
    expect(result.rejected.eroded).toBe(56);
  });

  it("drops pixels below the confidence threshold", () => {
    const frame = blankFrame(IDENTITY_POSE);
    (frame.depth as Float32Array).fill(2);
    const confidence = new Float32Array(WIDTH * HEIGHT).fill(0.9);
    for (let i = 0; i < 20; i++) confidence[i] = 0.1;

    const result = backprojectMask({ ...frame, confidence }, fullMask(), {
      erodeRadius: 0,
      minConfidence: 0.5,
    });
    expect(result.rejected.confidence).toBe(20);
    expect(result.pointCount).toBe(61);
  });

  it("rejects pixels sitting on a depth cliff", () => {
    // Left half at 2 m, right half at 4 m: the two columns either side of the seam are
    // the classic flying-pixel location.
    const frame = blankFrame(IDENTITY_POSE);
    const depths = frame.depth as Float32Array;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) depths[y * WIDTH + x] = x < 4 ? 2 : 4;
    }
    const result = backprojectMask(frame, fullMask(), {
      erodeRadius: 0,
      maxRelativeDepthStep: 0.05,
    });
    expect(result.rejected.discontinuity).toBe(2 * HEIGHT);
  });

  it("keeps a smooth gradient that the discontinuity filter should not touch", () => {
    const frame = blankFrame(IDENTITY_POSE);
    const depths = frame.depth as Float32Array;
    for (let i = 0; i < depths.length; i++) depths[i] = 2 + (i % WIDTH) * 0.01;
    const result = backprojectMask(frame, fullMask(), {
      erodeRadius: 0,
      maxRelativeDepthStep: 0.05,
    });
    expect(result.rejected.discontinuity).toBe(0);
  });

  it("drops non-finite and out-of-range depths", () => {
    const frame = blankFrame(IDENTITY_POSE);
    const depths = frame.depth as Float32Array;
    depths.fill(2);
    depths[0] = NaN;
    depths[1] = 0;
    depths[2] = Infinity;
    const result = backprojectMask(frame, fullMask(), {
      erodeRadius: 0,
      maxRelativeDepthStep: 0,
    });
    expect(result.rejected.depth).toBe(3);
    expect(result.pointCount).toBe(78);
  });

  it("refuses mismatched array shapes rather than reading past the end", () => {
    const frame = blankFrame(IDENTITY_POSE);
    expect(() => backprojectMask(frame, new Uint8Array(5))).toThrow(/mask has 5 values/);
    expect(() =>
      backprojectMask({ ...frame, depth: new Float32Array(5) }, fullMask()),
    ).toThrow(/depth has 5 values/);
  });

  it("refuses a camera with no focal length", () => {
    const frame = blankFrame(IDENTITY_POSE);
    expect(() =>
      backprojectMask({ ...frame, intrinsics: [0, 0, 4, 0, 0, 4, 0, 0, 1] }, fullMask()),
    ).toThrow(/focal length/);
  });
});

describe("erodeMask", () => {
  it("shrinks a solid block by the radius on every side", () => {
    const mask = new Uint8Array(25);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) mask[y * 5 + x] = 1;

    const eroded = erodeMask(mask, 5, 5, 1);
    expect(Array.from(eroded).filter(Boolean)).toHaveLength(1);
    expect(eroded[2 * 5 + 2]).toBe(1);
  });

  it("erases a shape thinner than the radius entirely", () => {
    const mask = new Uint8Array(25);
    for (let x = 0; x < 5; x++) mask[2 * 5 + x] = 1; // a 1px line
    expect(Array.from(erodeMask(mask, 5, 5, 1)).filter(Boolean)).toHaveLength(0);
  });

  it("is a no-op at radius 0", () => {
    const mask = new Uint8Array([1, 0, 1, 1]);
    expect(Array.from(erodeMask(mask, 2, 2, 0))).toEqual([1, 0, 1, 1]);
  });

  it("treats the image border as outside, so edge pixels erode away", () => {
    const mask = new Uint8Array(9).fill(1);
    const eroded = erodeMask(mask, 3, 3, 1);
    expect(Array.from(eroded).filter(Boolean)).toHaveLength(1);
    expect(eroded[4]).toBe(1);
  });
});
