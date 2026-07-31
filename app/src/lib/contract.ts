/**
 * Wire contract for the DA3 inference service.
 *
 * Mirrors `server/contract.py` field for field — change both together.
 * Defaults are the verified upstream values; see docs/SOURCES.md.
 */

export const SCHEMA_VERSION = "verge.infer-manifest/0.1.0";

export const MODEL_REPOSITORY_ID = "depth-anything/DA3NESTED-GIANT-LARGE-1.1";
export const MODEL_REVISION = "b2359bdf726fb44ef62acca04d629dcf158053e7";

/** The L4 we deploy on — the denominator for the VRAM budget bar. */
export const L4_TOTAL_VRAM_BYTES = 24 * 1024 ** 3;

/**
 * Conservative until `scripts/vram-sweep.sh` measures the real ceiling. DA3 caps
 * nothing itself and its in-repo estimator under-predicts real usage ~4x, so this
 * number must come from hardware, not arithmetic. Raise it only from measurements.
 */
export const DEFAULT_MAX_FRAMES = 16;

/**
 * VRAM prediction, bracketed rather than pointwise.
 *
 * We have exactly ONE measurement (4 frames @ 392 px = 8.53 GiB on an L4) and the
 * model `base + frames x res_scale x per_frame` has TWO unknowns — it is
 * underdetermined. Any single "estimate" would be an arbitrary choice of split
 * dressed up as a number, so we report the interval spanned by the plausible
 * extremes instead. The interval is wide on purpose: that width is exactly the
 * argument for running scripts/vram-sweep.sh.
 *
 * Replace both brackets with a real fit once the sweep has ≥3 datapoints.
 */
const MEASURED_GIB = 8.53;
const MEASURED_FRAMES = 4;
const MEASURED_RES_SCALE = (392 / 504) ** 2;

/** High base / low per-frame: cost is dominated by fixed model+context overhead. */
const OPTIMISTIC_BASE_GIB = 8.0;
/** Low base / high per-frame: cost is dominated by per-view activations. */
const PESSIMISTIC_BASE_GIB = 4.0;

function perFrameGib(baseGib: number): number {
  return (MEASURED_GIB - baseGib) / (MEASURED_FRAMES * MEASURED_RES_SCALE);
}

export interface VramBracket {
  lowBytes: number;
  highBytes: number;
  measured: false;
}

export function estimateVramRange(frameCount: number, processRes: number): VramBracket {
  const resScale = (processRes / 504) ** 2;
  const project = (baseGib: number) =>
    (baseGib + frameCount * resScale * perFrameGib(baseGib)) * 1024 ** 3;
  const a = project(OPTIMISTIC_BASE_GIB);
  const b = project(PESSIMISTIC_BASE_GIB);
  return { lowBytes: Math.min(a, b), highBytes: Math.max(a, b), measured: false };
}

export type ProcessResMethod = "upper_bound_resize" | "lower_bound_resize";
export type RefViewStrategy = "first" | "middle" | "saddle_balanced" | "saddle_sim_range";
export type ArtifactKind = "glb" | "npz" | "depth_preview" | "gs_ply" | "gs_video";

export interface InferParams {
  /** Sampling rate the local ffmpeg pass used. The server never resamples. */
  fps: number;
  sourceDurationS?: number;
  processRes: number;
  processResMethod: ProcessResMethod;
  refViewStrategy: RefViewStrategy;
  inferGs: boolean;
  maxFrames: number;
}

/** Verified upstream defaults. The HF Space's own sampling slider defaults to 10 fps. */
export const DEFAULT_PARAMS: InferParams = {
  fps: 10,
  processRes: 504,
  processResMethod: "upper_bound_resize",
  refViewStrategy: "middle",
  inferGs: false,
  maxFrames: DEFAULT_MAX_FRAMES,
};

/** UI bounds for the fps control. DA3's own slider allows 0.1-60; we start at 1. */
export const FPS_MIN = 1;
export const FPS_MAX = 50;

export interface Artifact {
  kind: ArtifactKind;
  name: string;
  sizeBytes: number;
  sha256: string;
  url: string;
}

export interface VramStats {
  peakBytes: number;
  currentBytes: number;
  totalBytes: number;
  deviceName: string;
}

export interface Timing {
  gpuSeconds: number;
  wallSeconds: number;
  modelLoadSeconds?: number;
}

export interface FrameInfo {
  count: number;
  requestedCount: number;
  width: number;
  height: number;
  /** True when fps x duration exceeded maxFrames and we sampled down. */
  capped: boolean;
  effectiveFps?: number;
}

export interface InferManifest {
  schemaVersion: string;
  runId: string;
  modelRepositoryId: string;
  modelRevision: string;
  depthMode: "metric";
  linearUnit: "metre";
  params: InferParams;
  frames: FrameInfo;
  timing: Timing;
  vram: VramStats;
  artifacts: Artifact[];
  transient: boolean;
  expiresAfterDays: number;
}

export interface GpuSnapshot {
  available: boolean;
  modelLoaded: boolean;
  busy: boolean;
  deviceName: string;
  currentBytes: number;
  peakBytes: number;
  totalBytes: number;
}

export type GpuState = "cold" | "warming" | "warm" | "busy" | "error";

export function vramFraction(bytes: number, total: number): number {
  return total > 0 ? bytes / total : 0;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)} MiB`;
}

/**
 * How many frames an fps/duration pair yields, and what actually gets sent once
 * the cap applies. Mirrors DA3's `frame_interval = max(1, int(video_fps / fps))`
 * behaviour, then clamps. Never silently truncates the clip — it lowers fps
 * instead, so the frames still span the whole video.
 */
export function planFrames(
  fps: number,
  durationS: number,
  maxFrames: number,
): { count: number; effectiveFps: number; capped: boolean } {
  const requested = Math.max(1, Math.floor(fps * durationS));
  if (requested <= maxFrames) {
    return { count: requested, effectiveFps: fps, capped: false };
  }
  return {
    count: maxFrames,
    effectiveFps: durationS > 0 ? maxFrames / durationS : fps,
    capped: true,
  };
}
