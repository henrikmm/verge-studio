/**
 * Client for the DA3 service.
 *
 * Points at the Vite dev middleware (fixture-backed mock + real local ffmpeg) by
 * default; set VITE_INFER_BASE to a deployed Cloud Run URL to hit the real GPU.
 * The contract is identical either way — see server/contract.py.
 */

import type { GpuSnapshot, InferManifest, InferParams } from "./contract";
import { startTeardown, streamJob } from "./cloud-control";
import { getCloud, inferBase, isRemote, noteRequest, noteRun } from "./cloud-store";
import { localApiHeaders } from "./local-api";
import {
  beginServerWait,
  beginUpload,
  noteUploadProgress,
  setGpuReader,
} from "./run-phase";

/**
 * TWO bases, because the two halves of the pipeline live in different places.
 *
 * `LOCAL_BASE` is always the Vite dev middleware: probe, upload, extract, frame. That
 * work is local ffmpeg and must never go to the cloud (local-first), and the
 * deployed service has no such routes anyway.
 *
 * The GPU base — gpu, warmup, shutdown, infer — now lives in `cloud-store` and is chosen at
 * RUNTIME. It used to be `import.meta.env.VITE_INFER_BASE`, fixed at dev-server start, which
 * meant pointing at a real service required killing Vite, exporting a variable and restarting.
 * That is a bad property for the one setting that decides whether a GPU is billing.
 *
 * These were a single constant until 2026-08-01. Overriding it sent ffmpeg's own routes to
 * Cloud Run, where they 404 — the first real browser-to-cloud run would have failed on
 * frame extraction before reaching the GPU at all.
 */
const LOCAL_BASE = "/api";

/** Seeds the connect field only; it no longer decides anything by itself. */
export const ENV_INFER_BASE: string = import.meta.env.VITE_INFER_BASE ?? "";
export const ENV_INFER_TOKEN: string = import.meta.env.VITE_INFER_TOKEN ?? "";

/**
 * Resolve an artifact URL from a manifest into something the browser can fetch.
 *
 * The service returns service-relative paths (`/artifact/{run_id}/{name}`) which resolve
 * against the *page* origin unless we rebase them — so with a remote service every GLB
 * and npz would 404 against the Vite dev server. The mock's URLs (`/roadside/...`) are
 * genuinely served by Vite, so they are left alone.
 *
 * Absolute URLs pass through untouched, which is how a signed GCS link works: the browser
 * fetches the bucket directly, with no dev server and no Cloud Run instance in the path.
 */
export function artifactUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("gs://")) {
    // Not reachable from a well-formed manifest: the service puts a signed https link in
    // `url` and keeps the gs:// address in `gs_uri`. Worth keeping as a loud failure —
    // if the two ever swap, this says so instead of producing a mystery network error.
    throw new Error(
      `artifact url is a gs:// address (${url}); the browser needs the signed link, and the ` +
        `durable address belongs in gsUri`,
    );
  }
  return isRemote() ? `${inferBase()}${url}` : url;
}

/**
 * True for a signed GCS link, which must be fetched differently from a service path.
 *
 * Two consequences, both of which fail confusingly if missed. GCS rejects a request that
 * carries an `Authorization` header *and* a URL signature — the header wins and the
 * signature is treated as an unauthenticated attempt — so the dev server's identity token
 * must not travel here. And the 32 MiB response cap is Cloud Run's, not the bucket's, so a
 * 105 MB npz comes down whole rather than in five ranged pieces.
 */
export function isSignedStorageUrl(url: string): boolean {
  return /^https:\/\/storage\.googleapis\.com\//i.test(url) && /[?&]X-Goog-Signature=/i.test(url);
}

export function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getCloud().token;
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}

function inferRequestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = requestHeaders(extra);
  return isLocalApiBase(inferBase()) ? localApiHeaders(headers) : headers;
}

/** Both the mock root (`/api`) and the cloud proxy below it are privileged local routes. */
export function isLocalApiBase(base: string): boolean {
  return base === "/api" || base.startsWith("/api/");
}

/**
 * Every GPU-service call goes through here so the instance timer and request count reflect
 * reality. Local ffmpeg routes deliberately do not — they cost nothing and touch no instance.
 */
async function gpuFetch(path: string, init?: RequestInit): Promise<Response> {
  noteRequest();
  return fetch(`${inferBase()}${path}`, {
    ...init,
    headers: inferRequestHeaders((init?.headers ?? {}) as Record<string, string>),
  });
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
export function manifestFromWire(w: any): InferManifest {
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
      // Absent on local-disk runs and on anything written before durable storage existed.
      gsUri: a.gs_uri ?? undefined,
    })),
    diagnostics: w.diagnostics
      ? {
          nativeNpz: w.diagnostics.native_npz ?? {},
          exportDirListing: w.diagnostics.export_dir_listing ?? [],
          publishMode: w.diagnostics.publish_mode ?? undefined,
          publishErrors: w.diagnostics.publish_errors ?? undefined,
        }
      : undefined,
    transient: w.transient,
    expiresAfterDays: w.expires_after_days,
    // Only the dev mock sets this. Absent from every real service response.
    mock: w.mock === true,
  };
}

export async function getGpu(): Promise<GpuSnapshot> {
  return toGpu((await expectOk(await gpuFetch("/gpu"))) as WireGpu);
}

/**
 * Hand the phase machine a way to read telemetry.
 *
 * Injected rather than imported, so `run-phase.ts` does not depend on this module — it is
 * driven straight through its whole sequence in the tests, with no network and no mock server.
 */
setGpuReader(getGpu);

export async function warmup(): Promise<GpuSnapshot> {
  const body = (await expectOk(
    await gpuFetch("/warmup", { method: "POST" }),
  )) as { gpu: WireGpu };
  return toGpu(body.gpu);
}

/**
 * Frees the model from VRAM. It does NOT delete the service and does NOT stop billing —
 * see `scripts/teardown.sh` and `deleteService()` for the action that actually does.
 */
export async function releaseModel(): Promise<void> {
  await expectOk(await gpuFetch("/shutdown", { method: "POST" }));
}

/**
 * Deletes the Cloud Run service via the local dev middleware, which shells out to
 * `scripts/teardown.sh`. This is the only action in the app that stops the meter. It keeps
 * the ~12 GB image, so the next deploy still takes the build-skip branch (~1 min, not 20).
 */
export async function deleteService(onLine?: (line: string) => void): Promise<{ output: string }> {
  const lines: string[] = [];
  const collect = (line: string) => {
    lines.push(line);
    onLine?.(line);
  };
  const { job } = await startTeardown();
  const result = await streamJob(job.id, collect);
  if (result.status !== "succeeded") {
    throw new Error(`teardown failed (${result.error ?? `exit ${result.exitCode}`})`);
  }
  return { output: lines.join("\n").trim() };
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
      headers: localApiHeaders(requestHeaders({ "content-type": "application/json" })),
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
      headers: localApiHeaders(requestHeaders({ "x-filename": file.name, "content-type": "application/octet-stream" })),
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

/**
 * What the frames were downscaled to before upload, and whether they were touched at all.
 *
 * ffmpeg has always returned this and the client always dropped it, so the one number an
 * operator needs to judge a plan — the pixel size the model will actually see — was computed,
 * serialised, and thrown away one line before it could be shown.
 */
export interface FrameScale {
  width: number;
  height: number;
  scaled: boolean;
}

export interface ExtractResult {
  frames: string[];
  plan: FramePlan;
  probe: VideoProbe;
  scale: FrameScale;
  outDir: string;
}

export async function extractFrames(
  path: string,
  fps: number,
  maxFrames: number,
): Promise<ExtractResult> {
  return (await expectOk(
    await fetch(`${LOCAL_BASE}/extract`, {
      method: "POST",
      headers: localApiHeaders(requestHeaders({ "content-type": "application/json" })),
      body: JSON.stringify({ path, fps, maxFrames }),
    }),
  )) as ExtractResult;
}

/** Extracted frames live on disk; the browser reads them back through the middleware. */
export function frameUrl(path: string): string {
  return `${LOCAL_BASE}/frame?path=${encodeURIComponent(path)}`;
}

export async function fetchFrameBlob(path: string): Promise<Blob> {
  const res = await fetch(frameUrl(path), { headers: requestHeaders() });
  if (!res.ok) throw new Error(`frame ${path}: ${res.status}`);
  return res.blob();
}

/**
 * POST the frames and report the upload as it goes.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: fetch cannot report upload progress.
 * There is no event, no stream, no callback — a request body is opaque until the response
 * arrives. So a 9.9 MB frame upload (measured, 111 frames of a 4K clip) was indistinguishable
 * from a hung request, and it is the only stage of a run with a real percentage to show.
 *
 * The response is still parsed exactly as `expectOk` would, so failures read the same either way.
 */
function postFrames(url: string, form: FormData, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    for (const [key, value] of Object.entries(headers)) request.setRequestHeader(key, value);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) noteUploadProgress(event.loaded, event.total);
    };
    // The bytes are gone and the server now owns the request. Which of waking, loading or
    // inferring it is doing is not knowable from here — the telemetry poll decides that.
    request.upload.onload = () => beginServerWait();

    request.onload = () => {
      const status = request.status;
      if (status < 200 || status >= 300) {
        return reject(new Error(`${status}: ${String(request.responseText).slice(0, 300)}`));
      }
      try {
        resolve(JSON.parse(request.responseText));
      } catch {
        reject(new Error(`${status}: response was not JSON`));
      }
    };
    request.onerror = () => reject(new Error("network error while uploading frames"));
    request.ontimeout = () => reject(new Error("the request timed out"));
    request.onabort = () => reject(new Error("the run was cancelled"));

    request.send(form);
  });
}

/**
 * Real service: multipart upload of the extracted frames.
 * Mock: a JSON summary, since the fixture stands in for the result.
 */
export async function infer(
  frames: Blob[] | { frameCount: number },
  params: InferParams,
): Promise<InferManifest> {
  noteRun();
  if (!Array.isArray(frames)) {
    beginServerWait();
    return manifestFromWire(
      await expectOk(
        await gpuFetch("/infer", {
          method: "POST",
          headers: inferRequestHeaders({ "content-type": "application/json" }),
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
      max_frames: params.maxFrames,
    }),
  );

  beginUpload(frames.reduce((total, blob) => total + blob.size, 0));
  noteRequest();
  return manifestFromWire(
    await postFrames(`${inferBase()}/infer`, form, inferRequestHeaders()),
  );
}
