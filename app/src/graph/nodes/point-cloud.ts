/**
 * PointCloud — local CPU work on the GLB the GPU produced.
 *
 * DA3's own GLB exporter already emits a confidence-filtered, colored point cloud
 * with camera frustums, so this node loads that rather than back-projecting depth
 * itself (docs/SOURCES.md: prefer DA3-native geometry over new backprojection code).
 * What it adds is decimation, height-ramp fallback coloring, and the stats the card
 * and the viewport report.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { InferManifest } from "../../lib/contract";
import { artifactUrl } from "../../lib/infer-client";
import type { NodeSpec } from "../types";

export interface PointCloudValue {
  object: THREE.Group;
  pointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Diagonal of the bounding box — the viewport frames the camera off this. */
  extent: number;
  url: string;
  /**
   * Flat xyz positions of every point, in world space.
   *
   * Kept alongside the Three.js group because `geometry/` takes plain arrays and knows
   * nothing about Three.js — that independence is what lets the ground-plane fit be
   * tested headlessly against synthetic scenes. Sharing the same buffers the geometry
   * already holds, so this costs no extra memory.
   */
  positions: Float32Array;
}

/** Fallback for colorless clouds: ramp along world height (z-up in DA3's world frame). */
function colorByHeight(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < min) min = z;
    if (z > max) max = z;
  }
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) - min) / (max - min || 1);
    c.setHSL(0.66 - 0.66 * t, 0.85, 0.55);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Keep every Nth point. Cheap way to make a 350k-point cloud interactive. */
function decimate(geometry: THREE.BufferGeometry, stride: number): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const col = geometry.getAttribute("color");
  const kept = Math.floor((pos.count + stride - 1) / stride);
  const positions = new Float32Array(kept * 3);
  const colors = col ? new Float32Array(kept * 3) : null;

  let w = 0;
  for (let i = 0; i < pos.count; i += stride) {
    positions[w * 3] = pos.getX(i);
    positions[w * 3 + 1] = pos.getY(i);
    positions[w * 3 + 2] = pos.getZ(i);
    if (colors && col) {
      colors[w * 3] = col.getX(i);
      colors[w * 3 + 1] = col.getY(i);
      colors[w * 3 + 2] = col.getZ(i);
    }
    w += 1;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, w * 3), 3));
  if (colors) out.setAttribute("color", new THREE.BufferAttribute(colors.subarray(0, w * 3), 3));
  return out;
}

function loadGltf(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(`GLB load failed: ${url}`)),
    );
  });
}

export const pointCloudSpec: NodeSpec = {
  type: "point-cloud",
  label: "Point Cloud",
  category: "geometry",
  version: "0.1.0",
  execution: "auto",
  inputs: [{ id: "depth", label: "Depth Field", type: "depth_field", required: true }],
  outputs: [{ id: "points", label: "Points", type: "point_cloud" }],
  defaults: { stride: 1, pointSize: 1 },
  controls: [
    { kind: "slider", key: "stride", label: "Stride", min: 1, max: 16, suffix: "×" },
    { kind: "slider", key: "pointSize", label: "Point size", min: 0.25, max: 4, step: 0.25 },
  ],
  execute: async ({ inputs, params }) => {
    const manifest = inputs.depth?.value as InferManifest | undefined;
    const glb = manifest?.artifacts.find((a) => a.kind === "glb");
    if (!glb) throw new Error("manifest has no GLB artifact");

    const stride = Math.max(1, Math.floor(Number(params.stride) || 1));
    // Manifest URLs are service-relative; rebase them or a real cloud run 404s here.
    const object = await loadGltf(artifactUrl(glb.url));

    const bounds = new THREE.Box3().setFromObject(object);
    const extent = bounds.getSize(new THREE.Vector3()).length();
    let pointCount = 0;
    const positionChunks: Float32Array[] = [];

    object.traverse((child) => {
      if (!(child instanceof THREE.Points)) return;
      if (!child.geometry.hasAttribute("color")) colorByHeight(child.geometry);
      if (stride > 1) {
        const original = child.geometry;
        child.geometry = decimate(original, stride);
        original.dispose();
      }
      const position = child.geometry.getAttribute("position");
      positionChunks.push(new Float32Array(position.array.buffer, position.array.byteOffset, position.count * 3));
      pointCount += position.count;
      child.material = new THREE.PointsMaterial({
        size: (extent / 800) * Number(params.pointSize ?? 1),
        vertexColors: true,
        sizeAttenuation: true,
      });
    });

    // DA3 exports one points mesh today, so the common case is a straight reference with
    // no copy. Concatenating only when there are several keeps it correct either way.
    const positions =
      positionChunks.length === 1
        ? positionChunks[0]
        : (() => {
            const merged = new Float32Array(pointCount * 3);
            let offset = 0;
            for (const chunk of positionChunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            return merged;
          })();

    const value: PointCloudValue = {
      object,
      pointCount,
      bbox: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      extent,
      url: glb.url,
      positions,
    };

    return {
      points: {
        type: "point_cloud",
        value,
        summary: `${pointCount.toLocaleString()} pts${stride > 1 ? ` · 1/${stride}` : ""}`,
      },
    };
  },
};
