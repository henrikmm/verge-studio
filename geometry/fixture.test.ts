/**
 * The geometry core against REAL DA3 output.
 *
 * Synthetic scenes prove the maths; only a real fixture proves the maths survives
 * contact with a reconstruction. This is where the wall-lock failure was first measured,
 * so it is also the regression test for it.
 *
 * These cases SKIP when the fixture payloads are absent. `fixtures/room/**` is gitignored
 * (a 108 MB npz and a 16 MB GLB), so a fresh clone has only the manifests — and a test
 * that fails on a fresh clone would train everyone to ignore red.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpz } from "../app/src/lib/npz";
import { estimateGravity, cameraCentres, trajectorySpan } from "./gravity";
import { fitGroundPlane } from "./plane";
import { heightsAbovePlane, percentile } from "./measure";

const ROOT = new URL("../fixtures/room/504px-112f/", import.meta.url);
const NPZ = fileURLToPath(new URL("verge-result.npz", ROOT));
const GLB = fileURLToPath(new URL("scene.glb", ROOT));
const available = existsSync(NPZ) && existsSync(GLB);

/** Read the POSITION accessor of the GLB's single points mesh. */
function readGlbPoints(path: string): Float32Array {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;

  // mode 0 = POINTS. DA3 also writes one LINES mesh per frame for the camera frustums.
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.mode !== 0) continue;
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      const view = gltf.bufferViews[accessor.bufferView];
      const offset = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      return new Float32Array(
        buffer.buffer.slice(
          buffer.byteOffset + offset,
          buffer.byteOffset + offset + accessor.count * 12,
        ),
      );
    }
  }
  throw new Error("no POINTS primitive in the GLB");
}

describe.skipIf(!available)("real fixture: fixtures/room/504px-112f", () => {
  const points = readGlbPoints(GLB);
  const npz = parseNpz(readFileSync(NPZ).buffer as ArrayBuffer);

  it("carries the 1,000,000-point cloud DA3 exports", () => {
    expect(points.length / 3).toBe(1_000_000);
  });

  it("recovers a coherent gravity direction from the camera poses", async () => {
    const { extrinsics } = await npz;
    const gravity = estimateGravity(extrinsics.data);

    expect(gravity.frameCount).toBe(112);
    // Measured 2026-08-01. High coherence means the operator held the phone upright.
    expect(gravity.coherence).toBeGreaterThan(0.9);
    expect(gravity.up[1]).toBeLessThan(0); // this clip's up is mostly -Y
  });

  it("confirms the clip has real camera translation, so DA3 had parallax to use", async () => {
    const { extrinsics } = await npz;
    const span = trajectorySpan(cameraCentres(extrinsics.data));
    // Measured: 1.26 x 1.28 x 1.69 m. A pan from a fixed point would be ~0 on all axes,
    // and cross-view attention would have had nothing to work with.
    expect(Math.max(...span)).toBeGreaterThan(1);
  });

  it("FINDS THE FLOOR, not a wall — the failure this whole design exists for", async () => {
    const { extrinsics } = await npz;
    const gravity = estimateGravity(extrinsics.data);
    const fit = fitGroundPlane(points, {
      up: gravity.up,
      inlierDistance: 0.03,
      stride: 4,
      minInliers: 500,
    });

    // Plain sequential RANSAC on this exact cloud returned planes 60deg, 34deg and 61deg
    // off vertical. With the orientation gate the fitted plane must be near-horizontal
    // relative to the (approximate) camera-derived up.
    expect(fit.tiltDeg).toBeLessThan(30);
    // And it must sit at the BOTTOM of the scene, not at a tabletop or the ceiling.
    // Measured with the shipped defaults: elevation -0.56 m, 3.7% of the cloud below it.
    const heights = heightsAbovePlane(points, fit.plane);
    const belowFraction =
      Array.from(heights).filter((h) => h < -0.05).length / heights.length;
    expect(belowFraction).toBeLessThan(0.15);
    expect(fit.inlierCount).toBeGreaterThan(500);
  });

  it("is deterministic on real data too", async () => {
    const { extrinsics } = await npz;
    const up = estimateGravity(extrinsics.data).up;
    const options = { up, inlierDistance: 0.03, stride: 8, minInliers: 200 };
    const a = fitGroundPlane(points, options);
    const b = fitGroundPlane(points, options);
    expect(a.plane.offset).toBe(b.plane.offset);
    expect(a.inlierCount).toBe(b.inlierCount);
  });

  it("produces a plausible room height above the fitted floor", async () => {
    const { extrinsics } = await npz;
    const up = estimateGravity(extrinsics.data).up;
    const fit = fitGroundPlane(points, {
      up,
      inlierDistance: 0.03,
      stride: 4,
      minInliers: 500,
    });
    const heights = heightsAbovePlane(points, fit.plane);
    const top = percentile(heights, 99.5);
    // A room is metres tall, not centimetres and not tens of metres. This is a sanity
    // gate on DA3's metric claim, not a precision check.
    expect(top).toBeGreaterThan(1);
    expect(top).toBeLessThan(5);
  });

  it("exposes depth, confidence, intrinsics and extrinsics for backprojection", async () => {
    const arrays = await npz;
    expect(arrays.depth.shape).toEqual([112, 280, 504]);
    expect(arrays.confidence.shape).toEqual([112, 280, 504]);
    expect(arrays.intrinsics.shape).toEqual([112, 3, 3]);
    expect(arrays.extrinsics.shape).toEqual([112, 3, 4]);
  });
});
