/**
 * PointCloud — local CPU work on what the GPU produced.
 *
 * Two clouds are available and the node shows one of them at a time.
 *
 *   DA3 EXPORT — the GLB the model wrote. Coloured, and the reference everything measured
 *     so far was measured against. Its confidence floor is pooled across the whole run, so
 *     it deletes whichever frames the model was least sure about entirely: on this fixture
 *     three frames contribute under 2% of their pixels, and on the outdoor run five do.
 *   REBUILT — our own, from the full-resolution depth maps. The display keeps every finite,
 *     non-edge point because confidence is a warning, not a missing prediction. Measurements
 *     stay on a separate 1M sample with DA3's confidence floor taken per frame, which preserves
 *     the graded baseline while the picture becomes complete.
 *
 * ONE DISPLAY OBJECT AT A TIME, on purpose. This machine has 8 GB of memory shared with the GPU.
 * The stable measurement sample is positions only; it does not create a second Three.js object
 * or a second set of WebGL buffers. The GLB is still parsed either way because it carries
 * `hf_alignment` and the camera frustums, but its exported points are released before ours build.
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
   * Stable input to geometry and measurement nodes.
   *
   * The rebuilt display budget is an appearance control. It must not refit the floor every time
   * somebody asks to see more points, so this stays at the measured 1M per-frame-confidence
   * baseline while `positions` describes what is visible.
   */
  measurementPositions: Float32Array;
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
  /**
   * Share of finite, non-edge display candidates the point budget kept. Null for the GLB.
   */
  keptOfCandidates: number | null;
  /** True when the points carry the photographs' own colour rather than a height ramp. */
  coloured: boolean;
}

export type CloudSource = "glb" | "npz";
export type CloudColour = "rgb" | "height";

export const POINT_CLOUD_ID = "point-cloud";

/**
 * The two clouds, as the viewport offers them.
 *
 * Lives here rather than in the pane so the chips and the node's own control cannot describe
 * the same switch differently — they read one list.
 */
/** How a rebuilt cloud is coloured, as the viewport offers it. */
export const CLOUD_COLOURS: { id: CloudColour; label: string; title: string }[] = [
  {
    id: "rgb",
    label: "Photo",
    title:
      "The colour the camera saw, sampled from the source frames on disk and resampled onto the depth map's grid. The npz carries no colour of its own, so this reads the photographs back.",
  },
  {
    id: "height",
    label: "Height",
    title:
      "A ramp along the vertical, blue low to red high. A reading of one coordinate rather than a picture of the scene — useful for seeing whether a surface is level, useless for recognising what it is.",
  },
];

/**
 * Point budgets, as the viewport offers them.
 *
 * The default matches DA3's own 1,000,000 so the two clouds are comparable on sight. It is also
 * the thing that makes a fully-covered cloud still look holey: on the 99-frame outdoor run that
 * budget keeps 7% of the finite, non-edge candidates. Raising it is how you see the scene rather
 * than a comparison.
 */
export const CLOUD_BUDGETS: { id: string; label: string; title: string }[] = [
  { id: "1000000", label: "1M", title: "DA3's own budget. The like-for-like comparison." },
  { id: "3000000", label: "3M", title: "Three times the points. About 350 MB of positions and colour." },
  { id: "6000000", label: "6M", title: "Most of what a 99-frame run has to give. Watch the memory." },
];

export const CLOUD_SOURCES: { id: CloudSource; label: string; title: string }[] = [
  {
    id: "glb",
    label: "DA3",
    title:
      "The cloud the model exported. Coloured, and what every measurement on record was taken against. Its confidence floor is pooled across the whole run, so it deletes the frames the model was least sure about entirely — three of this fixture's 112, and five of the outdoor run's 99.",
  },
  {
    id: "npz",
    label: "Ours",
    title:
      "Rebuilt here from the full-resolution depth maps. The picture keeps every finite, non-edge point; confidence remains on a separate fixed measurement cloud instead of erasing uncertain regions. Photo colour comes from the saved source frames.",
  },
];

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

/** Release every geometry and material below an object. Safe to call more than once. */
export function disposeObject3D(root: THREE.Object3D): void {
  root.removeFromParent();
  root.traverse((node) => {
    const drawable = node as Partial<THREE.Mesh>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (!material) return;
    for (const item of Array.isArray(material) ? material : [material]) item.dispose();
  });
}

function aborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("point-cloud build aborted");
}

async function loadGltf(url: string, signal: AbortSignal): Promise<THREE.Group> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GLB load failed (${response.status}): ${url}`);
  const data = await response.arrayBuffer();
  aborted(signal);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      data,
      "",
      (gltf) => {
        if (signal.aborted) {
          disposeObject3D(gltf.scene);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("point-cloud build aborted"),
          );
          return;
        }
        resolve(gltf.scene);
      },
      (err) => reject(err instanceof Error ? err : new Error(`GLB parse failed: ${url}`)),
    );
  });
}

/** DA3's own point budget. Matching it keeps every recorded comparison like-for-like. */
const MAX_POINTS = 1_000_000;

/**
 * A display-only change must not rebuild the exact measurement sample.
 *
 * The legacy sampler deliberately materialises every candidate before its partial shuffle so its
 * 1M result stays byte-for-byte compatible with the measured baseline. Keeping the 12 MB result
 * on the depth field avoids repeating that large transient allocation on every colour, density or
 * point-size change. Weak keys let a run and its sample leave memory together.
 */
const measurementPositionsByField = new WeakMap<DepthFieldValue, Float32Array>();

/**
 * The source photographs, resampled onto the depth map's grid.
 *
 * The npz carries depth and confidence and no colour at all, so a cloud rebuilt from it is grey
 * unless the frames are read back — and they are on disk, served by the same route Depth 2D
 * already uses. One canvas is reused for every frame; a canvas per frame is 99 allocations of
 * half a megapixel and the browser keeps them all alive until it feels like not to.
 *
 * If one frame fails, the whole cloud falls back to the height ramp. Mixing photo colour with a
 * zero-filled frame would turn real points black and look exactly like missing geometry.
 */
async function loadFrameColors(
  field: DepthFieldValue,
  width: number,
  height: number,
  count: number,
  signal: AbortSignal,
): Promise<Uint8Array[] | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  const byNpzIndex = new Map(field.frames.map((frame) => [frame.npzIndex, frame.rgbUrl]));
  const colors: (Uint8Array | undefined)[] = new Array(count).fill(undefined);

  for (let f = 0; f < count; f++) {
    aborted(signal);
    const url = byNpzIndex.get(f);
    if (!url) continue;
    try {
      const response = await fetch(artifactUrl(url), { signal });
      if (!response.ok) continue;
      const bitmap = await createImageBitmap(await response.blob());
      try {
        aborted(signal);
        // The photograph is full resolution and the depth map is not, so this resamples as it
        // draws — the same nearest-ish mapping the mask resampler uses, done by the browser.
        context.drawImage(bitmap, 0, 0, width, height);
      } finally {
        bitmap.close();
      }
      const { data } = context.getImageData(0, 0, width, height);
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = data[i * 4];
        rgb[i * 3 + 1] = data[i * 4 + 1];
        rgb[i * 3 + 2] = data[i * 4 + 2];
      }
      colors[f] = rgb;
    } catch (error) {
      if (signal.aborted) throw error;
      // A missing frame is a colourless frame, never a failed cloud.
    }
  }
  // Partial colour is worse than no colour: zero-filled missing frames render as black holes.
  return colors.every((color): color is Uint8Array => color !== undefined) ? colors : null;
}

/**
 * Swap DA3's points for ours, keeping the frustums and the alignment it carries.
 *
 * The GLB's own points are disposed BEFORE ours are built, not after. On an 8 GB machine shared
 * with the GPU, holding both display clouds while the second is assembled can kill the tab.
 */
async function rebuiltCloud(
  object: THREE.Group,
  alignment: Float32Array,
  url: string,
  field: DepthFieldValue,
  {
    pointSize,
    stride,
    budget,
    colour,
    signal,
  }: {
    pointSize: number;
    stride: number;
    budget: number;
    colour: CloudColour;
    signal: AbortSignal;
  },
) {
  const arrays = await field.loadArrays();
  aborted(signal);
  const frames = framesFromArrays(arrays);

  const exportedPoints: THREE.Points[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Points) exportedPoints.push(child);
  });
  for (const child of exportedPoints) {
    child.removeFromParent();
    child.geometry.dispose();
    const material = child.material;
    for (const item of Array.isArray(material) ? material : [material]) item.dispose();
  }

  if (colour === "rgb" && frames.length > 0) {
    const photos = await loadFrameColors(
      field,
      frames[0].width,
      frames[0].height,
      frames.length,
      signal,
    );
    if (photos) for (let f = 0; f < frames.length; f++) frames[f].rgb = photos[f];
  }

  // This is the measurement baseline already graded against the door fixture. It does not move
  // when the operator changes a display budget or asks to see low-confidence geometry.
  let measurementPositions = measurementPositionsByField.get(field);
  if (!measurementPositions) {
    measurementPositions = buildCloud(frames, {
      confidence: { kind: "da3-per-frame" },
      weight: "none",
      maxPoints: MAX_POINTS,
      includeColors: false,
      transform: alignment,
      signal,
    }).positions;
    measurementPositionsByField.set(field, measurementPositions);
  }

  // DA3 returned finite depth for the regions that looked like holes. Confidence was merely low,
  // so the display keeps those points and lets the budget thin them uniformly afterwards.
  const built = buildCloud(frames, {
    confidence: { kind: "none" },
    weight: "none",
    maxPoints: Math.max(1, Math.floor(budget / stride)),
    sampling: "reservoir",
    includeColors: colour === "rgb",
    transform: alignment,
    signal,
  });
  aborted(signal);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
  if (built.colors) {
    // Normalised, so Three reads the bytes as 0–1 without us building a second float buffer.
    geometry.setAttribute("color", new THREE.BufferAttribute(built.colors, 3, true));
  } else {
    // Asked for the ramp, or the photographs could not be read. Either way, height is a
    // reading of one coordinate and never pretends to be what the camera saw.
    colorByHeight(geometry);
  }

  const bounds = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute("position") as THREE.BufferAttribute,
  );
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
  // What the budget cost, after finite-depth and deliberate edge checks but no confidence floor.
  const keptOfCandidates =
    built.pointsBeforeVoxel > 0 ? built.pointCount / built.pointsBeforeVoxel : 1;

  const value: PointCloudValue = {
    object,
    pointCount: built.pointCount,
    bbox: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    extent,
    url,
    positions: built.positions,
    measurementPositions,
    worldFromDa3: alignment,
    source: "npz",
    leanestFrameShare,
    keptOfCandidates,
    coloured: built.colors !== null,
  };

  return {
    points: {
      type: "point_cloud" as const,
      value,
      summary:
        `${built.pointCount.toLocaleString()} pts · rebuilt` +
        (leanestFrameShare === null ? "" : ` · leanest frame ${(leanestFrameShare * 100).toFixed(0)}%`) +
        ` · ${(keptOfCandidates * 100).toFixed(0)}% of finite candidates`,
    },
    measurement: {
      type: "point_cloud" as const,
      value,
      summary: `${measurementPositions.length / 3} pts · stable measurement sample`,
    },
  };
}

export const pointCloudSpec: NodeSpec = {
  type: "point-cloud",
  label: "Point Cloud",
  category: "geometry",
  version: "0.3.0",
  execution: "auto",
  inputs: [{ id: "depth", label: "Depth Field", type: "depth_field", required: true }],
  outputs: [
    { id: "points", label: "Display", type: "point_cloud" },
    { id: "measurement", label: "Measure", type: "point_cloud" },
  ],
  outputParameters: (outputPort, params) => {
    if (outputPort !== "measurement") return params;
    const source = params.source === "npz" ? "npz" : "glb";
    // The rebuilt measurement sample is deliberately independent of every display control.
    // DA3's export still honours stride because that is the only cloud it has.
    return source === "npz"
      ? { source, measurementRule: "da3-per-frame-1m" }
      : { source, stride: params.stride };
  },
  defaults: { source: "glb", colour: "rgb", budget: 1_000_000, stride: 1, pointSize: 1 },
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
    {
      kind: "select",
      key: "colour",
      label: "Colour",
      options: [
        { value: "rgb", label: "photograph" },
        { value: "height", label: "height ramp" },
      ],
    },
    {
      kind: "slider",
      key: "budget",
      label: "Points",
      min: 250_000,
      max: 6_000_000,
      step: 250_000,
    },
    { kind: "slider", key: "stride", label: "Stride", min: 1, max: 16, suffix: "×" },
    { kind: "slider", key: "pointSize", label: "Point size", min: 0.25, max: 4, step: 0.25 },
  ],
  execute: async ({ inputs, params, signal }) => {
    const field = inputs.depth?.value as DepthFieldValue | undefined;
    const manifest = field?.manifest;
    const glb = manifest?.artifacts.find((a) => a.kind === "glb");
    if (!glb) throw new Error("manifest has no GLB artifact");

    const stride = Math.max(1, Math.floor(Number(params.stride) || 1));
    const source: CloudSource = params.source === "npz" ? "npz" : "glb";
    // Manifest URLs are service-relative; rebase them or a real cloud run 404s here.
    const object = await loadGltf(artifactUrl(glb.url), signal);
    const alignment = worldFromDa3(object);

    try {
      if (source === "npz") {
        if (!field) throw new Error("rebuilding the cloud needs the depth field");
        const outputs = await rebuiltCloud(object, alignment, glb.url, field, {
          pointSize: Number(params.pointSize ?? 1),
          stride,
          budget: Math.max(1, Math.floor(Number(params.budget) || MAX_POINTS)),
          colour: params.colour === "height" ? "height" : "rgb",
          signal,
        });
        let disposed = false;
        return {
          ...outputs,
          points: {
            ...outputs.points,
            dispose: () => {
              if (disposed) return;
              disposed = true;
              disposeObject3D(object);
            },
          },
        };
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
        positionChunks.push(
          new Float32Array(
            position.array.buffer,
            position.array.byteOffset,
            position.count * 3,
          ),
        );
        pointCount += position.count;
        const previousMaterial = child.material;
        child.material = new THREE.PointsMaterial({
          size: (extent / 800) * Number(params.pointSize ?? 1),
          vertexColors: true,
          sizeAttenuation: true,
        });
        for (const item of Array.isArray(previousMaterial)
          ? previousMaterial
          : [previousMaterial]) {
          item.dispose();
        }
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
        measurementPositions: positions,
        worldFromDa3: alignment,
        source,
        leanestFrameShare: null,
        keptOfCandidates: null,
        // DA3's export carries vertex colours; the ramp only fires on a GLB that has none.
        coloured: true,
      };

      let disposed = false;
      return {
        points: {
          type: "point_cloud",
          value,
          summary: `${pointCount.toLocaleString()} pts${stride > 1 ? ` · 1/${stride}` : ""}`,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            disposeObject3D(object);
          },
        },
        measurement: {
          type: "point_cloud",
          value,
          summary: `${pointCount.toLocaleString()} pts · DA3 measurement cloud`,
        },
      };
    } catch (error) {
      disposeObject3D(object);
      throw error;
    }
  },
};
