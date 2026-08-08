/**
 * Reading a saved DA3 run from disk, for the tests that grade against real output.
 *
 * Not part of the geometry itself and deliberately absent from `index.ts` — it touches the
 * filesystem, which the app's bundle must never pull in. It exists because three test files
 * needed the same twenty lines of GLB parsing, and a fourth copy is how two of them quietly
 * end up disagreeing about which mesh holds the points.
 */

import { readFileSync } from "node:fs";
import { normalize, type Vec3 } from "./types";

export interface GlbCloud {
  /** Flat xyz in the GLB's display frame. */
  points: Float32Array;
  /** Row-major 4×4 `hf_alignment`: DA3's raw reconstruction frame → this display frame. */
  alignment: number[];
}

/**
 * The point cloud and the display transform out of a DA3 GLB.
 *
 * Mode 0 is POINTS. DA3 also writes one LINES mesh per frame for the camera frustums, so
 * taking the first primitive rather than the first POINTS primitive reads a frustum.
 */
export function readGlbCloud(path: string): GlbCloud {
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
  throw new Error(`no POINTS primitive in the GLB at ${path}`);
}

/** Rotate a direction by a row-major 4×4. Translation is deliberately ignored. */
export function transformDirection(direction: Vec3, transform: ArrayLike<number>): Vec3 {
  const value = normalize([
    transform[0] * direction[0] + transform[1] * direction[1] + transform[2] * direction[2],
    transform[4] * direction[0] + transform[5] * direction[1] + transform[6] * direction[2],
    transform[8] * direction[0] + transform[9] * direction[1] + transform[10] * direction[2],
  ]);
  if (!value) throw new Error("the alignment has a degenerate rotation");
  return value;
}
