/** Regression for the visibly tilted M3b floor reported on the door fixture. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpz } from "../app/src/lib/npz";
import { estimateGravity } from "./gravity";
import { fitGroundPlaneRobust } from "./plane";
import { normalize, planeElevationAt, type Vec3 } from "./types";

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

async function fit(setting: string, overrides: { maxTiltDeg?: number; seed?: number } = {}) {
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
    maxBelowFraction: 0.2,
    seed: 7,
    ...overrides,
  });
}

const fixtureRoot = new URL("../fixtures/door/", import.meta.url);
const available = ["504px-112f", "252px-256f"].every((setting) =>
  ["scene.glb", "verge-result.npz"].every((name) =>
    existsSync(fileURLToPath(new URL(`${setting}/${name}`, fixtureRoot))),
  ),
);

describe.skipIf(!available)("door floor regression", () => {
  it("chooses the strongly supported floor at 504px", async () => {
    const floor = await fit("504px-112f");
    expect(floor.inlierFraction).toBeGreaterThan(0.1);
    expect(floor.tiltDeg).toBeLessThan(20);
    expect(floor.belowFraction).toBeLessThan(0.02);
    expect(floor.rmse).toBeLessThan(0.02);
    // Deliberately no assertion on `proposalFraction`. Both proposal pools now find the
    // same plane on this fixture, so which one is recorded as the winner is a coin toss
    // between two identical answers — a property of the tie-break, not of the floor.
  }, 15_000);

  /**
   * THE GATE for TASK.md task 1, run on real data rather than a synthetic room.
   *
   * The seed is the one input carrying no information about the scene. Before 2026-08-08
   * it moved this fixture's floor by 11.8 cm and its tilt by 5.15°, and every reported
   * height was measured up from that. The tolerance is 1 cm and 0.5°, set below the
   * project's own measured operator repeatability of 1–6 mm (MEASUREMENTS.md) so that the
   * seed stops being a term in the error budget at all. Measured here: 0.06 cm, 0.07°.
   */
  it("returns the same floor whatever the seed — the reproducibility gate", async () => {
    const seeds = [7, 108, 209, 310, 411, 512, 613, 714];
    const fits = await Promise.all(seeds.map((seed) => fit("504px-112f", { seed })));

    const centroid: Vec3 = [0, 0, 0];
    const elevations = fits.map((f) => planeElevationAt(f.plane, centroid, f.plane.normal));
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeLessThan(0.01);

    const tilts = fits.map((f) => f.tiltDeg);
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeLessThan(0.5);

    // Every one of them must be the real floor, not merely the same wrong answer.
    for (const floor of fits) {
      expect(floor.inlierFraction).toBeGreaterThan(0.1);
      expect(floor.belowFraction).toBeLessThan(0.02);
    }
  }, 30_000);

  /**
   * The gate has to bound the number it names, at every setting rather than one.
   *
   * Measured 2026-08-07, before this was fixed: `maxTiltDeg` 10 returned a plane reported
   * at 11.3°. The orientation gate rejected tilted CANDIDATES and then least-squares
   * refinement rotated the winner past the limit, which nothing re-checked. A sweep rather
   * than the single failing value, because one value passing is how the original defect
   * survived — the code was only ever exercised at 30°.
   */
  it.each([8, 10, 12, 15, 20, 30])("never reports a tilt above a %i deg gate", async (limit) => {
    const floor = await fit("504px-112f", { maxTiltDeg: limit });
    expect(floor.tiltDeg).toBeLessThanOrEqual(limit);
  }, 15_000);

  it("reports that it declined a refinement rather than clamping silently", async () => {
    // 10° is the measured case: refinement wants 11.3° and is refused.
    const clamped = await fit("504px-112f", { maxTiltDeg: 10 });
    expect(clamped.tiltClamped).toBe(true);
    expect(clamped.tiltDeg).toBeLessThanOrEqual(10);

    // At the app's own default the refinement fits inside the gate, so nothing is declined
    // and the fit is exactly what it was before this change.
    const free = await fit("504px-112f");
    expect(free.tiltClamped).toBe(false);
  }, 15_000);

  it("still finds a floor when the 252px cloud is degraded", async () => {
    const floor = await fit("252px-256f");
    expect(floor.inlierFraction).toBeGreaterThan(0.02);
    expect(floor.tiltDeg).toBeLessThan(15);
    expect(floor.belowFraction).toBeLessThan(0.02);
  }, 15_000);
});
