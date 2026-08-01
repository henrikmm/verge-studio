/**
 * Client for the DA3 service.
 *
 * Points at the Vite dev middleware (fixture-backed mock + real local ffmpeg) by
 * default; set VITE_INFER_BASE to a deployed Cloud Run URL to hit the real GPU.
 * The contract is identical either way — see server/contract.py.
 */

import type { GpuSnapshot, InferManifest, InferParams } from "./contract";

const BASE = import.meta.env.VITE_INFER_BASE ?? "/api";

/** Cloud Run requires an identity token; the mock ignores it. */
const AUTH_TOKEN = import.meta.env.VITE_INFER_TOKEN ?? "";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return AUTH_TOKEN ? { ...extra, authorization: `Bearer ${AUTH_TOKEN}` } : extra;
}

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// The wire format is snake_case (Python); the app is camelCase.
interface WireGpu {
  available: boolean;
  model_loaded: boolean;
  busy: boolean;
  device_name: string;
  current_bytes: number;
  peak_bytes: number;
  total_bytes: number;
}

function toGpu(w: WireGpu): GpuSnapshot {
  return {
    available: w.available,
    modelLoaded: w.model_loaded,
    busy: w.busy,
    deviceName: w.device_name,
    currentBytes: w.current_bytes,
    peakBytes: w.peak_bytes,
    totalBytes: w.total_bytes,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toManifest(w: any): InferManifest {
  return {
    schemaVersion: w.schema_version,
    runId: w.run_id,
    modelRepositoryId: w.model_repository_id,
    modelRevision: w.model_revision,
    depthMode: w.depth_mode,
    linearUnit: w.linear_unit,
    params: {
      fps: w.params.fps,
      sourceDurationS: w.params.source_duration_s ?? undefined,
      processRes: w.params.process_res,
      processResMethod: w.params.process_res_method,
      refViewStrategy: w.params.ref_view_strategy,
      inferGs: w.params.infer_gs,
      maxFrames: w.params.max_frames,
    },
    frames: {
      count: w.frames.count,
      requestedCount: w.frames.requested_count,
      width: w.frames.width,
      height: w.frames.height,
      capped: w.frames.capped,
      effectiveFps: w.frames.effective_fps ?? undefined,
    },
    timing: {
      gpuSeconds: w.timing.gpu_seconds,
      wallSeconds: w.timing.wall_seconds,
      modelLoadSeconds: w.timing.model_load_seconds ?? undefined,
    },
    vram: {
      peakBytes: w.vram.peak_bytes,
      currentBytes: w.vram.current_bytes,
      totalBytes: w.vram.total_bytes,
      deviceName: w.vram.device_name,
      // 0 on manifests written before the per-run isolation fix (2026-08-01).
      torchPeakBytes: w.vram.torch_peak_bytes ?? 0,
      baselineBytes: w.vram.baseline_bytes ?? 0,
    },
    artifacts: (w.artifacts ?? []).map((a: any) => ({
      kind: a.kind,
      name: a.name,
      sizeBytes: a.size_bytes,
      sha256: a.sha256,
      url: a.url,
    })),
    diagnostics: w.diagnostics
      ? {
          nativeNpz: w.diagnostics.native_npz ?? {},
          exportDirListing: w.diagnostics.export_dir_listing ?? [],
        }
      : undefined,
    transient: w.transient,
    expiresAfterDays: w.expires_after_days,
  };
}

export async function getGpu(): Promise<GpuSnapshot> {
  return toGpu((await expectOk(await fetch(`${BASE}/gpu`, { headers: headers() }))) as WireGpu);
}

export async function warmup(): Promise<GpuSnapshot> {
  const body = (await expectOk(
    await fetch(`${BASE}/warmup`, { method: "POST", headers: headers() }),
  )) as { gpu: WireGpu };
  return toGpu(body.gpu);
}

export async function shutdown(): Promise<void> {
  await expectOk(await fetch(`${BASE}/shutdown`, { method: "POST", headers: headers() }));
}

export interface VideoProbe {
  durationS: number;
  nativeFps: number;
  width: number;
  height: number;
}

/** A probed video plus the content digest that makes its cache key honest. */
export interface VideoSource extends VideoProbe {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** Local ffmpeg — never the cloud. */
export async function probeVideo(path: string): Promise<VideoSource> {
  return (await expectOk(
    await fetch(`${BASE}/probe`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path }),
    }),
  )) as VideoSource;
}

/**
 * Hand a dropped file to the dev middleware, which writes it somewhere ffmpeg can
 * reach and returns the path. Browsers never expose the real one.
 */
export async function uploadVideo(file: File): Promise<VideoSource> {
  return (await expectOk(
    await fetch(`${BASE}/upload`, {
      method: "POST",
      headers: headers({ "x-filename": file.name, "content-type": "application/octet-stream" }),
      body: file,
    }),
  )) as VideoSource;
}

export interface FramePlan {
  count: number;
  effectiveFps: number;
  capped: boolean;
  requestedCount: number;
}

export async function extractFrames(
  path: string,
  fps: number,
  maxFrames: number,
): Promise<{ frames: string[]; plan: FramePlan; probe: VideoProbe; outDir: string }> {
  return (await expectOk(
    await fetch(`${BASE}/extract`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path, fps, maxFrames }),
    }),
  )) as { frames: string[]; plan: FramePlan; probe: VideoProbe; outDir: string };
}

/** Extracted frames live on disk; the browser reads them back through the middleware. */
export function frameUrl(path: string): string {
  return `${BASE}/frame?path=${encodeURIComponent(path)}`;
}

export async function fetchFrameBlob(path: string): Promise<Blob> {
  const res = await fetch(frameUrl(path), { headers: headers() });
  if (!res.ok) throw new Error(`frame ${path}: ${res.status}`);
  return res.blob();
}

/**
 * Real service: multipart upload of the extracted frames.
 * Mock: a JSON summary, since the fixture stands in for the result.
 */
export async function infer(
  frames: Blob[] | { frameCount: number },
  params: InferParams,
): Promise<InferManifest> {
  if (!Array.isArray(frames)) {
    return toManifest(
      await expectOk(
        await fetch(`${BASE}/infer`, {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify({
            frameCount: frames.frameCount,
            processRes: params.processRes,
            fps: params.fps,
          }),
        }),
      ),
    );
  }

  const form = new FormData();
  for (const [i, blob] of frames.entries()) {
    form.append("frames", blob, `frame-${String(i).padStart(4, "0")}.jpg`);
  }
  form.append(
    "params",
    JSON.stringify({
      fps: params.fps,
      source_duration_s: params.sourceDurationS,
      process_res: params.processRes,
      process_res_method: params.processResMethod,
      ref_view_strategy: params.refViewStrategy,
      infer_gs: params.inferGs,
      max_frames: params.maxFrames,
    }),
  );
  return toManifest(
    await expectOk(
      await fetch(`${BASE}/infer`, { method: "POST", headers: headers(), body: form }),
    ),
  );
}
