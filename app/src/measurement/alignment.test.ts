import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { transformDirection, transformPoints } from "../graph/nodes/measurement";
import { worldFromDa3 } from "../graph/nodes/point-cloud";

const ALIGNMENT = [
  [0, 0, -1, 3],
  [0, 1, 0, 4],
  [1, 0, 0, 5],
  [0, 0, 0, 1],
];

describe("DA3 GLB alignment", () => {
  it("reads the row-major transform from the scene extras", () => {
    const scene = new THREE.Group();
    scene.userData.hf_alignment = ALIGNMENT;
    expect(Array.from(worldFromDa3(scene))).toEqual(ALIGNMENT.flat());
  });

  it("falls back to identity when an older GLB has no alignment", () => {
    const scene = new THREE.Group();
    expect(Array.from(worldFromDa3(scene))).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  });

  it("puts NPZ points into the displayed GLB coordinate frame", () => {
    const aligned = transformPoints(Float32Array.from([1, 2, 3, -1, 0, 2]), ALIGNMENT.flat());
    expect(Array.from(aligned)).toEqual([0, 6, 6, 1, 4, 4]);
  });

  it("rotates directions without applying translation", () => {
    expect(transformDirection([1, 0, 0], ALIGNMENT.flat())).toEqual([0, 0, 1]);
  });
});
