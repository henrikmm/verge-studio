/**
 * Wire contract for the DA3 inference service.
 *
 * Mirrors `server/contract.py` field for field — change both together.
 * Defaults are the verified upstream values; see docs/SOURCES.md.
 */

export const SCHEMA_VERSION = "verge.infer-manifest/0.1.0";

export const MODEL_REPOSITORY_ID = "depth-anything/DA3NESTED-GIANT-LARGE-1.1";
export const MODEL_REVISION = "b2359bdf726fb44ef62acca04d629dcf158053e7";

/**
 * The L4 we deploy on — the denominator for the VRAM budget bar.
 * MEASURED from `torch.cuda.mem_get_info()` on the real device: 22.03 GiB usable.
 * An L4's advertised "24 GB" is decimal and some is reserved, so 24 GiB was wrong.
 */
export const L4_TOTAL_VRAM_BYTES = 23_659_151_360;

/** VRAM resident after the model loads, before any inference. Measured. */
export const MODEL_RESIDENT_BYTES = 7_050_625_024;

/**
 * Set from measurement: 32 frames @ 504 px peaked at 14.03 GiB of the L4's 22.03 GiB,
 * leaving ~8 GiB headroom, with no OOM anywhere in the sweep. 32 is the largest count
 * actually run — the UI allows more, clearly marked as unmeasured.
 */
export const DEFAULT_MAX_FRAMES = 32;

/**
 * Measured peak VRAM, from scripts/vram-sweep.sh on a real L4 (2026-07-31).
 * Raw data in docs/vram-measurements.json.
 *
 * IMPORTANT — what these numbers are: peaks observed on a WARM instance running the
 * sweep in ascending order. PyTorch's caching allocator retains freed blocks between
 * runs, so each reading includes cache from earlier runs. That is why 8 and 16 report
 * an identical 12.79 GiB, and 24 and 32 an identical 14.03 GiB — the readings quantise
 * to allocator growth steps rather than tracking true per-run cost.
 *
 * They are therefore SAFE UPPER BOUNDS for sequential use, and conservative for a
 * cold instance running one batch. Good enough to set a frame cap; not a clean
 * cost model. See task: isolate per-run peaks with empty_cache() between runs.
 */
export const VRAM_MEASUREMENTS: ReadonlyArray<{ frames: number; peakBytes: number }> = [
  { frames: 4, peakBytes: 10_863_247_360 },
  { frames: 8, peakBytes: 13_732_151_296 },
  { frames: 16, peakBytes: 13_732_151_296 },
  { frames: 24, peakBytes: 15_065_939_968 },
  { frames: 32, peakBytes: 15_065_939_968 },
];

/** Highest frame count we have actually run. Beyond this we are extrapolating. */
export const MAX_MEASURED_FRAMES = 32;
/** The resolution every measurement was taken at. */
export const MEASURED_PROCESS_RES = 504;

export interface VramPrediction {
  bytes: number;
  /** True only when interpolating inside measured data at the measured resolution. */
  measured: boolean;
}

/**
 * Peak VRAM for a given frame count, interpolated from real measurements.
 * Anything outside the measured envelope is flagged so the UI can say so.
 */
export function predictVram(frameCount: number, processRes: number): VramPrediction {
  const inResRange = processRes === MEASURED_PROCESS_RES;
  const points = VRAM_MEASUREMENTS;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  let bytes: number;
  // `measured` means this exact configuration was actually run — interpolating
  // between two real points is still a guess, even when both ends agree.
  const exact = points.some((p) => p.frames === frameCount);

  if (frameCount <= first.frames) {
    // Below the measured floor: scale down from the first point, but never below
    // what the model alone occupies.
    bytes = Math.max(MODEL_RESIDENT_BYTES, first.peakBytes * (frameCount / first.frames));
  } else if (frameCount >= last.frames) {
    // Extrapolate on the slope of the last measured segment.
    const prev = points[points.length - 3]!; // last distinct step
    const slope = (last.peakBytes - prev.peakBytes) / (last.frames - prev.frames);
    bytes = last.peakBytes + slope * (frameCount - last.frames);
  } else {
    let lo = first;
    let hi = last;
    for (let i = 0; i < points.length - 1; i++) {
      if (frameCount >= points[i]!.frames && frameCount <= points[i + 1]!.frames) {
        lo = points[i]!;
        hi = points[i + 1]!;
        break;
      }
    }
    const span = hi.frames - lo.frames;
    const t = span === 0 ? 0 : (frameCount - lo.frames) / span;
    bytes = lo.peakBytes + t * (hi.peakBytes - lo.peakBytes);
  }

  // Resolution scales the token count quadratically; only 504 was measured.
  const resScale = (processRes / MEASURED_PROCESS_RES) ** 2;
  return { bytes: bytes * resScale, measured: exact && inResRange };
}

export type ProcessResMethod = "upper_bound_resize" | "lower_bound_resize";
export type RefViewStrategy = "first" | "middle" | "saddle_balanced" | "saddle_sim_range";
/**
 * "npz" is the bundle the service writes with the key names `npz.ts` reads.
 * "npz_native" is DA3's own export — kept and served, but distinguished so a
 * lookup by kind can never pick it up by accident.
 */
export type ArtifactKind =
  | "glb"
  | "npz"
  | "npz_native"
  | "depth_preview"
  | "gs_ply"
  | "gs_video";

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

/**
 * Two peaks, because they answer different questions and routinely disagree.
 * `peakBytes` is the driver high-water mark — use it to decide whether a
 * configuration fits. `torchPeakBytes` is the caching allocator's, isolated to this
 * run by an `empty_cache()` at entry — use it, with `baselineBytes`, to model what an
 * extra frame costs. See server/vram.py for why the driver number alone was misleading.
 *
 * Both new fields are 0 on manifests written before 2026-08-01.
 */
export interface VramStats {
  peakBytes: number;
  currentBytes: number;
  totalBytes: number;
  deviceName: string;
  torchPeakBytes: number;
  baselineBytes: number;
}

/** Observations recorded during a run so open questions need no extra cloud session. */
export interface Diagnostics {
  /** Each npz DA3 itself wrote, mapped to its array key names. */
  nativeNpz: Record<string, string[]>;
  exportDirListing: string[];
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
  diagnostics?: Diagnostics;
  transient: boolean;
  expiresAfterDays: number;
  /**
   * True when this manifest came from the fixture-backed dev mock rather than a GPU.
   * The real service never sets it. Surfaced on the node card because a screenshot of
   * a mock run is otherwise indistinguishable from a real one — see docs/DESIGN.md's
   * honesty rules.
   */
  mock?: boolean;
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
