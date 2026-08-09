import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { disposeObject3D } from "./point-cloud";

describe("point-cloud resource ownership", () => {
  it("disposes geometry and material in nested Three.js groups", () => {
    const root = new THREE.Group();
    const nested = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.PointsMaterial();
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    nested.add(new THREE.Points(geometry, material));
    root.add(nested);

    disposeObject3D(root);

    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });
});
