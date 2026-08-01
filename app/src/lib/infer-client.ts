/**
 * Client for the DA3 service.
 *
 * Points at the Vite dev middleware (fixture-backed mock + real local ffmpeg) by
 * default; set VITE_INFER_BASE to a deployed Cloud Run URL to hit the real GPU.
 * The contract is identical either way — see server/contract.py.
 */

import type { GpuSnapshot, InferManifest, InferParams } from "./contract";

/**
 * TWO bases, because the two halves of the pipeline live in different places.
 *
 * `LOCAL_BASE` is always the Vite dev middleware: probe, upload, extract, frame. That
 * work is ffmpeg on this Mac and must never go to the cloud (local-first), and the
 * deployed service has no such routes anyway.
 *
 * `INFER_BASE` is the GPU service: gpu, warmup, shutdown, infer. Point it at a deployed
 * Cloud Run URL (or a `gcloud run services proxy` on localhost) to use real hardware;
 * left unset it falls back to the fixture-backed mock on the same dev middleware.
 *
 * These were one constant until 2026-08-01. Overriding it sent ffmpeg's own routes to
 * Cloud Run, where they 404 — the first real browser-to-cloud run would have failed on
 * frame extraction before reaching the GPU at all.
 */
const LOCAL_BASE = "/api";
const INFER_BASE = import.meta.env.VITE_INFER_BASE ?? "/api";

/** True when INFER_BASE points off-origin, i.e. at a real service rather than the mock. */
const INFER_IS_REMOTE = /^https?:\/\//i.test(INFER_BASE);

/** Cloud Run requires an identity token; the mock ignores it. */
const AUTH_TOKEN = import.meta.env.VITE_INFER_TOKEN ?? "";

/**
 * Resolve an artifact URL from a manifest into something the browser can fetch.
 *
 * The service returns service-relative paths (`/artifact/{run_id}/{name}`) which resolve
 * against the *page* origin unless we rebase them — so with a remote service every GLB
 * and npz would 404 against the Vite dev server. The mock's URLs (`/roadside/...`) are
 * genuinely served by Vite, so they are left alone.
 */
export function artifactUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("gs://")) {
    throw new Error(
      `artifact is in GCS (${url}) and needs a signed URL — the browser cannot fetch gs:// directly`,
    );
  }
  return INFER_IS_REMOTE ? `${INFER_BASE.replace(/\/$/, "")}${url}` : url;
}

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
    // Only the dev mock sets this. Absent from every real service response.
    mock: w.mock === true,
  };
}

export async function getGpu(): Promise<GpuSnapshot> {
  return toGpu((await expectOk(await fetch(`${INFER_BASE}/gpu`, { headers: headers() }))) as WireGpu);
}

export async function warmup(): Promise<GpuSnapshot> {
  const body = (await expectOk(
    await fetch(`${INFER_BASE}/warmup`, { method: "POST", headers: headers() }),
  )) as { gpu: WireGpu };
  return toGpu(body.gpu);
}

export async function shutdown(): Promise<void> {
  await expectOk(await fetch(`${INFER_BASE}/shutdown`, { method: "POST", headers: headers() }));
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
    await fetch(`${LOCAL_BASE}/probe`, {
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
    await fetch(`${LOCAL_BASE}/upload`, {
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
    await fetch(`${LOCAL_BASE}/extract`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ path, fps, maxFrames }),
    }),
  )) as { frames: string[]; plan: FramePlan; probe: VideoProbe; outDir: string };
}

/** Extracted frames live on disk; the browser reads them back through the middleware. */
export function frameUrl(path: string): string {
  return `${LOCAL_BASE}/frame?path=${encodeURIComponent(path)}`;
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
        await fetch(`${INFER_BASE}/infer`, {
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
      await fetch(`${INFER_BASE}/infer`, { method: "POST", headers: headers(), body: form }),
    ),
  );
}
