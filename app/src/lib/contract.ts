/**
 * Wire contract for the DA3 inference service.
 *
 * Mirrors `server/contract.py` field for field — change both together.
 * Defaults are the verified upstream values; see docs/SOURCES.md.
 *
 * ONE DELIBERATE DIVERGENCE (2026-08-04): the server still declares `infer_gs: bool = False`
 * and the `gs_ply` / `gs_video` artifact kinds. Gaussian splats were dropped from the roadmap
 * — no measurement node consumes them — so the client no longer sends or understands them.
 * The server side is left alone on purpose: editing `server/` changes the image source hash
 * and forces a ~20 min rebuild for dead code. It has a default, so omitting the field is safe.
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
 * Frame cap, set from the 2026-08-01 ladder on a real L4.
 *
 * MEASURED CEILING: 144 frames @ 504 px ran (21.88 GiB of 22.03); 160 OOMed. So the
 * hard ceiling sits between 144 and 160.
 *
 * 112 is deliberately BELOW that, not at it. Both 128 and 144 completed at ~99% of the
 * device, which is not an operating point — any variation in scene content or allocator
 * state crosses the line. 112 measured 17.23 GiB of allocator against a ~19.5 GiB
 * ceiling, roughly 15% headroom, and matched the fitted model to within 0.25 GiB.
 *
 * On the 26.61 s test clip this is 4.21 effective fps, up from 1.20 at the old cap of 32.
 */
export const DEFAULT_MAX_FRAMES = 112;

/**
 * Measured peak VRAM from scripts/vram-sweep.sh on a real L4 (2026-08-01), at 504 px.
 * Raw data, including the 356/252 px ladders, in docs/vram-measurements.json.
 *
 * These are DRIVER peaks with each run isolated by empty_cache() +
 * reset_peak_memory_stats(), so unlike the 2026-07-31 set they are per-run costs rather
 * than cumulative high-water marks. The driver figure includes the CUDA context and
 * allocator reserve, so it saturates near the device limit; the cleaner signal for
 * modelling is the allocator peak, which fits
 *
 *     allocator ≈ 0.0700 GiB/frame + 9.39 GiB
 *
 * across 32/64/128/144 frames. Note that is HALF the 0.14 GiB/frame the old
 * contaminated data implied — which is why the real ceiling landed at ~144 rather
 * than the predicted ~110.
 */
const GIB = 1_073_741_824;

/** The rungs exactly as measured, in frame order. */
const MEASURED_DRIVER_PEAKS: ReadonlyArray<{ frames: number; peakBytes: number }> = [
  { frames: 32, peakBytes: 15_294_529_536 },
  { frames: 64, peakBytes: 18_186_502_144 },
  { frames: 112, peakBytes: 22_848_471_040 },
  { frames: 128, peakBytes: 23_561_502_720 },
  // The 144 rung was overwritten by the sweep-merge bug and recovered from console output, so
  // only its GiB figure survives (`"recovered": true`, null peak_bytes in the JSON). Derived
  // here rather than back-computed to fake byte precision that was genuinely lost.
  { frames: 144, peakBytes: Math.round(21.88 * GIB) },
];

/**
 * The table the UI interpolates, forced non-decreasing.
 *
 * 144 measures LOWER than 128 (21.88 vs 21.94 GiB). VRAM did not fall: the driver figure
 * includes the CUDA context and allocator reserve, so past ~21.5 GiB it is a plateau against
 * the 22.03 GiB device limit with measurement scatter on top, not a curve. The allocator series
 * is the one that stays clean and monotonic (18.35 → 19.47 GiB across the same rungs). Taking a
 * running maximum keeps the estimate physical without editing the measurements above.
 */
export const VRAM_MEASUREMENTS: ReadonlyArray<{ frames: number; peakBytes: number }> =
  MEASURED_DRIVER_PEAKS.map((point, index, all) => ({
    frames: point.frames,
    peakBytes: Math.max(...all.slice(0, index + 1).map((entry) => entry.peakBytes)),
  }));

/** Highest frame count we have actually run to success. Beyond this we are extrapolating. */
export const MAX_MEASURED_FRAMES = 144;

/** Lowest frame count measured to OOM at 504 px. The ceiling is in (144, 160). */
export const MIN_OOM_FRAMES = 160;
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
export type ArtifactKind = "glb" | "npz" | "npz_native" | "depth_preview";

export interface InferParams {
  /** Sampling rate the local ffmpeg pass used. The server never resamples. */
  fps: number;
  sourceDurationS?: number;
  processRes: number;
  processResMethod: ProcessResMethod;
  refViewStrategy: RefViewStrategy;
  maxFrames: number;
}

/** Verified upstream defaults. The HF Space's own sampling slider defaults to 10 fps. */
export const DEFAULT_PARAMS: InferParams = {
  fps: 10,
  processRes: 504,
  processResMethod: "upper_bound_resize",
  refViewStrategy: "middle",
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
