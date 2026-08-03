/** Regression for the visibly tilted M3b floor reported on the door fixture. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpz } from "../app/src/lib/npz";
import { estimateGravity } from "./gravity";
import { fitGroundPlaneRobust } from "./plane";
import { normalize, type Vec3 } from "./types";

function readGlb(path: string): { points: Float32Array; alignment: number[] } {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.mode !== 0) continue;
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      const view = gltf.bufferViews[accessor.bufferView];
      const offset = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      return {
        points: new Float32Array(
          buffer.buffer.slice(
            buffer.byteOffset + offset,
            buffer.byteOffset + offset + accessor.count * 12,
          ),
        ),
        alignment: (gltf.scenes[gltf.scene].extras.hf_alignment as number[][]).flat(),
      };
    }
  }
  throw new Error("no POINTS primitive in GLB");
}

function transformDirection(direction: Vec3, transform: number[]): Vec3 {
  const value = normalize([
    transform[0] * direction[0] + transform[1] * direction[1] + transform[2] * direction[2],
    transform[4] * direction[0] + transform[5] * direction[1] + transform[6] * direction[2],
    transform[8] * direction[0] + transform[9] * direction[1] + transform[10] * direction[2],
  ]);
  if (!value) throw new Error("alignment has a degenerate rotation");
  return value;
}

async function fit(setting: string) {
  const root = new URL(`../fixtures/door/${setting}/`, import.meta.url);
  const { points, alignment } = readGlb(fileURLToPath(new URL("scene.glb", root)));
  const arrays = await parseNpz(readFileSync(new URL("verge-result.npz", root)).buffer as ArrayBuffer);
  if (!arrays.extrinsics) throw new Error("fixture has no extrinsics");
  const gravity = estimateGravity(arrays.extrinsics.data);
  const up = transformDirection(gravity.up, alignment);
  return fitGroundPlaneRobust(points, {
    up,
    maxTiltDeg: 30,
    inlierDistance: 0.035,
    iterations: 1200,
    stride: 16,
    minInliers: 100,
    minInlierFraction: 0.01,
    proposalFractions: [1, 0.35],
    supportRatio: 0.1,
    maxBelowFraction: 0.2,
    seed: 7,
  });
}

const fixtureRoot = new URL("../fixtures/door/", import.meta.url);
const available = ["504px-112f", "252px-256f"].every((setting) =>
  ["scene.glb", "verge-result.npz"].every((name) =>
    existsSync(fileURLToPath(new URL(`${setting}/${name}`, fixtureRoot))),
  ),
);

describe.skipIf(!available)("door floor regression", () => {
  it("chooses the strongly supported whole-cloud floor at 504px", async () => {
    const floor = await fit("504px-112f");
    expect(floor.proposalFraction).toBe(1);
    expect(floor.inlierFraction).toBeGreaterThan(0.1);
    expect(floor.tiltDeg).toBeLessThan(20);
    expect(floor.belowFraction).toBeLessThan(0.02);
    expect(floor.rmse).toBeLessThan(0.02);
  }, 15_000);

  it("keeps the gravity-aligned lower-region floor when the 252px cloud is degraded", async () => {
    const floor = await fit("252px-256f");
    expect(floor.proposalFraction).toBe(0.35);
    expect(floor.inlierFraction).toBeGreaterThan(0.02);
    expect(floor.tiltDeg).toBeLessThan(15);
    expect(floor.belowFraction).toBeLessThan(0.02);
  }, 15_000);
});
