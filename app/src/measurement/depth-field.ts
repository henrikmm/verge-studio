import type { Frame } from "../../../geometry";
import type { InferManifest } from "../lib/contract";
import { artifactUrl, frameUrl, manifestFromWire, requestHeaders } from "../lib/infer-client";
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
 */
export async function fetchArtifactBuffer(url: string, sizeBytes: number): Promise<ArrayBuffer> {
  const resolved = artifactUrl(url);
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

function recordedDescriptors(
  manifest: InferManifest,
  framesBase: string,
): DepthFrameDescriptor[] {
  const map = canonicalFrameMap(manifest.frames.count);
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
    frames: recordedDescriptors(manifest, run.framesBase),
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
