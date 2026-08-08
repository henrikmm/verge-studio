/**
 * PointCloud — local CPU work on what the GPU produced.
 *
 * Two clouds are available and the node shows one of them at a time.
 *
 *   DA3 EXPORT — the GLB the model wrote. Coloured, and the reference everything measured
 *     so far was measured against. Its confidence floor is pooled across the whole run, so
 *     it deletes whichever frames the model was least sure about entirely: on this fixture
 *     three frames contribute under 2% of their pixels, and on the outdoor run five do.
 *   REBUILT — our own, from the full-resolution depth maps, taking that floor per frame.
 *     Measured 2026-08-08: the leanest frame goes from 0.8% to 57.4%, and the tabletop lands
 *     within 0.3 mm of where DA3's cloud puts it over the same floor. Fuller, same geometry.
 *
 * ONE AT A TIME, on purpose. The rebuilt cloud is 1,000,000 points beside the GLB's
 * 1,000,000, and this machine has 8 GB of memory shared with the GPU. Two nodes wired to two
 * panes would keep both resident and cached; one node with a switch cannot. The GLB is still
 * loaded either way — it carries `hf_alignment` and the camera frustums, and neither exists
 * anywhere else — but its points are released before ours are built.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildCloud, framesFromArrays } from "../../../../geometry/cloud";
import { artifactUrl } from "../../lib/infer-client";
import type { DepthFieldValue } from "../../measurement/depth-field";
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
  /**
   * Row-major transform from the raw NPZ reconstruction frame into the
   * display frame used by DA3's exported GLB (first-camera glTF axes plus
   * scene centering).
   *
   * DA3 records this as `scene.extras.hf_alignment`. Pixel selections are
   * back-projected from the NPZ, so they must cross this boundary before they can
   * be compared with the displayed cloud.
   */
  worldFromDa3: Float32Array;
  /** Which cloud these points are. Carried so a measurement can say what it measured. */
  source: CloudSource;
  /**
   * Smallest share of one frame's usable pixels that reached the cloud. Null for the GLB,
   * whose per-frame accounting only `inspect coverage` can reconstruct.
   */
  leanestFrameShare: number | null;
}

export type CloudSource = "glb" | "npz";

const IDENTITY_4X4 = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/** Read DA3's row-major NPZ-to-GLB display transform from the scene extras. */
export function worldFromDa3(object: THREE.Group): Float32Array {
  const candidate: unknown = object.userData.hf_alignment;
  if (!Array.isArray(candidate) || candidate.length !== 4) return IDENTITY_4X4.slice();
  const values: number[] = [];
  for (const row of candidate) {
    if (!Array.isArray(row) || row.length !== 4) return IDENTITY_4X4.slice();
    for (const entry of row) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) return IDENTITY_4X4.slice();
      values.push(entry);
    }
  }
  return Float32Array.from(values);
}

/** Fallback for colorless clouds: ramp along aligned world height (Y-up). */
function colorByHeight(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min) / (max - min || 1);
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

/** DA3's own point budget. Matching it keeps every recorded comparison like-for-like. */
const MAX_POINTS = 1_000_000;

/**
 * Swap DA3's points for ours, keeping the frustums and the alignment it carries.
 *
 * The GLB's own points are disposed BEFORE ours are built, not after. On an 8 GB machine
 * sharing memory with the GPU, holding two million-point clouds plus their colour buffers
 * while the second is assembled is the difference between a slow tab and a killed one.
 */
async function rebuiltCloud(
  object: THREE.Group,
  alignment: Float32Array,
  url: string,
  field: DepthFieldValue,
  { pointSize, stride }: { pointSize: number; stride: number },
) {
  const arrays = await field.loadArrays();

  for (const child of [...object.children]) {
    if (!(child instanceof THREE.Points)) continue;
    object.remove(child);
    child.geometry.dispose();
    const material = child.material;
    for (const item of Array.isArray(material) ? material : [material]) item.dispose();
  }

  const built = buildCloud(framesFromArrays(arrays), {
    confidence: { kind: "da3-per-frame" },
    weight: "none",
    maxPoints: Math.max(1, Math.floor(MAX_POINTS / stride)),
    transform: alignment,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
  // No colour of our own: the npz carries depth and confidence, never RGB. The height ramp is
  // the same fallback a colourless GLB already gets.
  colorByHeight(geometry);

  const bounds = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position") as THREE.BufferAttribute);
  const extent = bounds.getSize(new THREE.Vector3()).length();
  object.add(
    new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: (extent / 800) * pointSize,
        vertexColors: true,
        sizeAttenuation: true,
      }),
    ),
  );

  const shares = built.frames.map((f) => (f.usable > 0 ? f.kept / f.usable : 1));
  const leanestFrameShare = shares.length > 0 ? Math.min(...shares) : null;

  const value: PointCloudValue = {
    object,
    pointCount: built.pointCount,
    bbox: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    extent,
    url,
    positions: built.positions,
    worldFromDa3: alignment,
    source: "npz",
    leanestFrameShare,
  };

  return {
    points: {
      type: "point_cloud" as const,
      value,
      summary:
        `${built.pointCount.toLocaleString()} pts · rebuilt` +
        (leanestFrameShare === null ? "" : ` · leanest frame ${(leanestFrameShare * 100).toFixed(0)}%`),
    },
  };
}

export const pointCloudSpec: NodeSpec = {
  type: "point-cloud",
  label: "Point Cloud",
  category: "geometry",
  version: "0.2.0",
  execution: "auto",
  inputs: [{ id: "depth", label: "Depth Field", type: "depth_field", required: true }],
  outputs: [{ id: "points", label: "Points", type: "point_cloud" }],
  defaults: { source: "glb", stride: 1, pointSize: 1 },
  controls: [
    {
      kind: "select",
      key: "source",
      label: "Cloud",
      options: [
        { value: "glb", label: "DA3 export" },
        { value: "npz", label: "rebuilt from depth" },
      ],
    },
    { kind: "slider", key: "stride", label: "Stride", min: 1, max: 16, suffix: "×" },
    { kind: "slider", key: "pointSize", label: "Point size", min: 0.25, max: 4, step: 0.25 },
  ],
  execute: async ({ inputs, params }) => {
    const field = inputs.depth?.value as DepthFieldValue | undefined;
    const manifest = field?.manifest;
    const glb = manifest?.artifacts.find((a) => a.kind === "glb");
    if (!glb) throw new Error("manifest has no GLB artifact");

    const stride = Math.max(1, Math.floor(Number(params.stride) || 1));
    const source: CloudSource = params.source === "npz" ? "npz" : "glb";
    // Manifest URLs are service-relative; rebase them or a real cloud run 404s here.
    const object = await loadGltf(artifactUrl(glb.url));
    const alignment = worldFromDa3(object);

    if (source === "npz") {
      if (!field) throw new Error("rebuilding the cloud needs the depth field");
      return rebuiltCloud(object, alignment, glb.url, field, {
        pointSize: Number(params.pointSize ?? 1),
        stride,
      });
    }

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
      worldFromDa3: alignment,
      source,
      leanestFrameShare: null,
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
