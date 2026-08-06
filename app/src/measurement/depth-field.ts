import type { Frame } from "../../../geometry";
import type { InferManifest } from "../lib/contract";
import {
  artifactUrl,
  frameUrl,
  isSignedStorageUrl,
  manifestFromWire,
  requestHeaders,
} from "../lib/infer-client";
import { parseNpz, type NpyArray } from "../lib/npz";
import type { FramesValue } from "../graph/nodes/frame-source";

/**
 * The three recorded door settings, kept as a named list because M3's resolution-vs-frames
 * verdict table is defined over exactly these. They are now the ids of BUILT-IN RUNS rather
 * than the only addressable evidence — see `lib/runs.ts`.
 */
export const FIXTURE_SETTINGS = ["504px-112f", "356px-256f", "252px-256f"] as const;
export type FixtureSetting = (typeof FIXTURE_SETTINGS)[number];

/** Built-in run id for a recorded door setting. */
export function builtinRunId(setting: FixtureSetting): string {
  return `door-${setting}`;
}

export interface DepthFrameDescriptor {
  /** Index inside depth/confidence/intrinsics/extrinsics. */
  npzIndex: number;
  /** Index in the one canonical 256-frame extraction, 1-based. */
  canonicalIndex: number;
  /** RGB frame corresponding to this exact NPZ frame. */
  rgbUrl: string;
  timestampS: number;
}

export interface DepthFieldValue {
  manifest: InferManifest;
  source: "gpu" | "mock" | "fixture";
  label: string;
  frames: DepthFrameDescriptor[];
  loadArrays: () => Promise<Record<string, NpyArray>>;
}

const RANGE_BYTES = 24 * 1024 * 1024;

/**
 * Cloud Run cannot return a >32 MiB response in one piece. Fetch the NPZ in ranges,
 * while accepting a normal 200 response from hosts that ignore Range (including some
 * local static servers). The manifest's byte count makes assembly deterministic.
 *
 * A signed GCS link skips all of that. The cap belongs to Cloud Run, not to the bucket, so
 * the whole 105 MB arrives in one request — and the identity token must be withheld, since
 * GCS treats a request carrying both a header credential and a URL signature as an
 * unauthenticated one and answers 401.
 */
export async function fetchArtifactBuffer(url: string, sizeBytes: number): Promise<ArrayBuffer> {
  const resolved = artifactUrl(url);
  if (isSignedStorageUrl(resolved)) {
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`signed artifact fetch ${response.status}`);
    const buffer = await response.arrayBuffer();
    // The signature covers the object, so a short read is a transport failure rather than
    // the wrong object — but it would surface as a corrupt point cloud, so check it here.
    if (buffer.byteLength !== sizeBytes) {
      throw new Error(
        `signed artifact: expected ${sizeBytes} bytes, got ${buffer.byteLength}`,
      );
    }
    return buffer;
  }
  if (!(sizeBytes > RANGE_BYTES)) {
    const response = await fetch(resolved, { headers: requestHeaders() });
    if (!response.ok) throw new Error(`artifact fetch ${response.status}`);
    return response.arrayBuffer();
  }

  const joined = new Uint8Array(sizeBytes);
  for (let start = 0; start < sizeBytes; start += RANGE_BYTES) {
    const end = Math.min(sizeBytes - 1, start + RANGE_BYTES - 1);
    const response = await fetch(resolved, {
      headers: requestHeaders({ Range: `bytes=${start}-${end}` }),
    });
    if (!response.ok) throw new Error(`artifact range ${start}-${end}: ${response.status}`);
    const chunk = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const expected = end - start + 1;
    if (chunk.byteLength !== expected) {
      throw new Error(`artifact range ${start}-${end}: expected ${expected} bytes, got ${chunk.byteLength}`);
    }
    joined.set(chunk, start);
  }
  return joined.buffer;
}

function memoizedArrays(manifest: InferManifest): () => Promise<Record<string, NpyArray>> {
  let cached: Promise<Record<string, NpyArray>> | undefined;
  return () => {
    if (!cached) {
      const npz = manifest.artifacts.find((artifact) => artifact.kind === "npz");
      if (!npz) return Promise.reject(new Error("manifest has no NPZ artifact"));
      cached = fetchArtifactBuffer(npz.url, npz.sizeBytes).then(parseNpz);
    }
    return cached;
  };
}

/** Exact counterpart of scripts/extract-frames.mjs::pickEvenly. */
export function canonicalFrameMap(frameCount: number, canonicalCount = 256): number[] {
  if (frameCount >= canonicalCount) return Array.from({ length: frameCount }, (_, i) => i + 1);
  if (frameCount <= 0) return [];
  if (frameCount === 1) return [1];
  return Array.from(
    { length: frameCount },
    (_, i) => Math.round((i * (canonicalCount - 1)) / (frameCount - 1)) + 1,
  );
}

/**
 * Map NPZ index → the RGB file that actually holds that frame.
 *
 * Two numbering conventions exist on disk, and using the wrong one desynchronises RGB from
 * depth **silently**, because most of the wrong filenames still exist:
 *
 * - **Built-in door fixtures** share ONE canonical 256-frame extraction between three settings
 *   (112f / 256f / 256f, ladder-strided from a single decode). NPZ frame *i* is canonical frame
 *   `canonicalFrameMap(count)[i]`, and the JPEG is named by that canonical number.
 * - **Saved cloud runs** carry their own frames, renumbered contiguously 1..N by `saveRun`
 *   (`vite-plugins/runs.mjs`). NPZ frame *i* is simply file *i+1* — the same identity the live
 *   path uses in `depthFieldFromRun`.
 *
 * Applying the canonical spread to a saved 81-frame run asked for `frame-0004` at NPZ index 1
 * and `frame-0256` at index 80: wrong-but-present frames early, 404s past index 25. Masks were
 * therefore painted on one frame and back-projected with another frame's depth and camera pose,
 * which is a silently wrong measurement rather than a visible failure. Found 2026-08-05.
 */
function recordedDescriptors(
  manifest: InferManifest,
  framesBase: string,
  canonicalFrames: boolean,
): DepthFrameDescriptor[] {
  const map = canonicalFrames
    ? canonicalFrameMap(manifest.frames.count)
    : Array.from({ length: manifest.frames.count }, (_, i) => i + 1);
  const fps = manifest.frames.effectiveFps ?? manifest.params.fps;
  return map.map((canonicalIndex, npzIndex) => ({
    npzIndex,
    canonicalIndex,
    rgbUrl: `${framesBase}frame-${String(canonicalIndex).padStart(4, "0")}.jpg`,
    timestampS: npzIndex / fps,
  }));
}

/**
 * Load a persisted run's evidence.
 *
 * This used to be `loadFixtureDepthField(setting)`, hardcoded to `/door/<setting>/`, which is
 * why recorded evidence could only ever be one of three door directories. The bases now come
 * from the run record: built-ins resolve through Vite's publicDir, saved runs through
 * `/api/run-artifact`, since they live outside the project at ~/verge-runs.
 */
export async function loadRunDepthField(run: {
  id: string;
  label: string;
  artifactBase: string | null;
  framesBase: string | null;
  available: boolean;
  /** True only for the built-in door fixtures, which share one canonical 256-frame extraction.
   *  Absent on records written before 2026-08-05, where `builtin` was the only signal. */
  canonicalFrames?: boolean;
  builtin?: boolean;
}): Promise<DepthFieldValue> {
  if (!run.artifactBase || !run.framesBase) {
    throw new Error(
      `run ${run.id} is not saved to this disk — its artifacts are still only on the cloud instance`,
    );
  }
  if (!run.available) {
    throw new Error(`run ${run.id} is registered but its payloads are missing from this disk`);
  }

  const manifestUrl = `${run.artifactBase}manifest.json`;
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`run manifest ${response.status}`);
  const manifest = manifestFromWire(await response.json());
  manifest.artifacts = manifest.artifacts.map((item) => ({
    ...item,
    url: `${run.artifactBase}${item.name}`,
  }));
  return {
    manifest,
    source: "fixture",
    label: run.label,
    // Falls back to `builtin` so a run record written before the flag existed still resolves
    // correctly rather than silently taking the wrong numbering.
    frames: recordedDescriptors(
      manifest,
      run.framesBase,
      run.canonicalFrames ?? run.builtin ?? false,
    ),
    loadArrays: memoizedArrays(manifest),
  };
}

export function depthFieldFromRun(manifest: InferManifest, frames: FramesValue): DepthFieldValue {
  const fps = manifest.frames.effectiveFps ?? frames.plan.effectiveFps;
  const descriptors = frames.paths.slice(0, manifest.frames.count).map((path, npzIndex) => ({
    npzIndex,
    canonicalIndex: npzIndex + 1,
    rgbUrl: frameUrl(path),
    timestampS: npzIndex / fps,
  }));
  return {
    manifest,
    source: manifest.mock ? "mock" : "gpu",
    label: manifest.mock ? "MOCK RUN" : `DA3 · ${manifest.runId}`,
    frames: descriptors,
    loadArrays: memoizedArrays(manifest),
  };
}

export function closestFrame(
  field: DepthFieldValue,
  canonicalIndex: number,
): DepthFrameDescriptor | undefined {
  let best: DepthFrameDescriptor | undefined;
  for (const frame of field.frames) {
    if (!best || Math.abs(frame.canonicalIndex - canonicalIndex) < Math.abs(best.canonicalIndex - canonicalIndex)) {
      best = frame;
    }
  }
  return best;
}

function frameSlice(array: NpyArray, index: number): Float32Array {
  const perFrame = array.shape.slice(1).reduce((product, value) => product * value, 1);
  return array.data.subarray(index * perFrame, (index + 1) * perFrame);
}

export function geometryFrame(
  arrays: Record<string, NpyArray>,
  descriptor: DepthFrameDescriptor,
): Frame {
  const depth = arrays.depth;
  const intrinsics = arrays.intrinsics;
  const extrinsics = arrays.extrinsics;
  if (!depth || !intrinsics || !extrinsics) {
    throw new Error("NPZ needs depth, intrinsics and extrinsics arrays");
  }
  const [, height, width] = depth.shape;
  if (!width || !height) throw new Error(`unexpected depth shape ${depth.shape.join("×")}`);
  return {
    depth: frameSlice(depth, descriptor.npzIndex),
    confidence: arrays.confidence ? frameSlice(arrays.confidence, descriptor.npzIndex) : undefined,
    width,
    height,
    intrinsics: frameSlice(intrinsics, descriptor.npzIndex),
    extrinsics: frameSlice(extrinsics, descriptor.npzIndex),
  };
}

export function arrayFrame(array: NpyArray, index: number): Float32Array {
  return frameSlice(array, index);
}
