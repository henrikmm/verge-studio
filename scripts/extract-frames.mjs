// Local frame extraction — the Mac does this, never the cloud.
//
// Mirrors DA3's own video handling (app/modules/file_handlers.py::_process_video):
// sample by target FPS, not by "N frames across the clip". The one thing we add is
// a frame cap, because DA3 imposes none and a 24 GiB L4 does.
//
// When fps x duration exceeds the cap we LOWER THE FPS rather than truncating the
// clip, so the frames still span the whole video. Callers are told the effective fps.
//
// Frames are also downscaled to a long edge of 1024 px by default. This is a transport
// constraint, not a quality choice: Cloud Run's documented HTTP/1 request cap is 32 MiB,
// and 4K JPEGs measure ~432 KB each, so a 128-frame run would be ~55 MB and fail. The
// pixels are wasted anyway -- DA3 resizes to process_res (504) internally.
//
// Usage: node scripts/extract-frames.mjs <video> <outDir> [--fps 10] [--max-frames 32]
//                                                         [--long-edge 1024]

import { execFile } from "node:child_process";
import { copyFile, link, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Hardware decode. Sampling by FPS spreads frames across the whole clip, so ffmpeg
 * must decode the ENTIRE video for any frame count -- 1579 frames of 3840x2160 HEVC
 * for `test_demo.mp4`, whether you asked for 32 frames or 256.
 *
 * On this Mac (6 cores, only 2 of them performance) software HEVC decode saturates
 * every core for the whole pass. Measured 2026-08-01 on a 3 s window: software 4.8 s,
 * videotoolbox 1.8 s -- 2.7x faster, on the dedicated media engine instead of the CPU.
 * Sustained software decode froze the machine outright; this is the fix for that.
 */
const HWACCEL = process.platform === "darwin" ? ["-hwaccel", "videotoolbox"] : [];

/**
 * Cap decode threads. The wall-clock cost is small next to hardware decode, and it
 * leaves the machine usable while a long extraction runs -- which matters more than
 * shaving seconds off a pass that happens once.
 */
const THREAD_ARGS = ["-threads", "2"];

export class FfmpegMissingError extends Error {
  constructor() {
    super("ffmpeg/ffprobe not found on PATH — install with: brew install ffmpeg");
    this.name = "FfmpegMissingError";
  }
}

async function requireFfmpeg() {
  try {
    await Promise.all([run("ffmpeg", ["-version"]), run("ffprobe", ["-version"])]);
  } catch {
    throw new FfmpegMissingError();
  }
}

/** Duration in seconds, plus native fps and pixel dimensions. */
export async function probeVideo(videoPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
    "-of", "json",
    videoPath,
  ]);
  const probed = JSON.parse(stdout);
  const stream = probed.streams?.[0];
  if (!stream) throw new Error(`no video stream in ${videoPath}`);

  // avg_frame_rate is a rational like "30000/1001".
  const [num, den] = String(stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  const nativeFps = den > 0 ? num / den : 0;
  const duration = Number(probed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`could not determine duration of ${videoPath}`);
  }
  return {
    durationS: duration,
    nativeFps,
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

/**
 * Decide the sampling rate before touching ffmpeg, so the UI can show the user
 * what a setting will cost before they commit to a GPU run.
 */
export function planSampling(fps, durationS, maxFrames) {
  const requestedCount = Math.max(1, Math.floor(fps * durationS));
  if (requestedCount <= maxFrames) {
    return { count: requestedCount, effectiveFps: fps, capped: false, requestedCount };
  }
  return {
    count: maxFrames,
    effectiveFps: maxFrames / durationS,
    capped: true,
    requestedCount,
  };
}

/** Long edge, in pixels, that frames are downscaled to before upload. */
export const DEFAULT_LONG_EDGE = 1024;

/**
 * Target frame dimensions for a given source size.
 *
 * Downscale only -- a source already under the limit is passed through untouched,
 * because upscaling would inflate the upload for no information gain. Both axes are
 * rounded to even numbers, which is what ffmpeg's own `-2` does and what JPEG's
 * chroma subsampling wants.
 *
 * The arithmetic is done here rather than in an ffmpeg `scale` expression so the
 * caller can report exact output dimensions without parsing ffmpeg's output, and so
 * the filter string stays free of the commas that would otherwise need escaping in a
 * filtergraph.
 */
export function planScale(width, height, longEdge = DEFAULT_LONG_EDGE) {
  const longest = Math.max(width, height);
  if (!(longEdge > 0) || !(longest > longEdge)) {
    return { width, height, scaled: false };
  }
  const factor = longEdge / longest;
  const even = (n) => Math.max(2, Math.round((n * factor) / 2) * 2);
  return { width: even(width), height: even(height), scaled: true };
}

/**
 * Extract JPEG frames to `outDir`. Returns absolute paths plus the sampling plan
 * that produced them.
 */
export async function extractFrames(
  videoPath,
  outDir,
  { fps = 10, maxFrames = 32, longEdge = DEFAULT_LONG_EDGE } = {},
) {
  await requireFfmpeg();
  await stat(videoPath); // throws a clear ENOENT if the video is missing

  const probe = await probeVideo(videoPath);
  const plan = planSampling(fps, probe.durationS, maxFrames);
  const scale = planScale(probe.width, probe.height, longEdge);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const filters = [`fps=${plan.effectiveFps.toFixed(9)}`];
  if (scale.scaled) filters.push(`scale=${scale.width}:${scale.height}`);

  const ffmpegArgs = (accel) => [
    "-nostdin",
    "-v", "error",
    ...accel,
    ...THREAD_ARGS,
    "-i", videoPath,
    "-vf", filters.join(","),
    "-frames:v", String(plan.count),
    "-q:v", "2",
    join(outDir, "frame-%04d.jpg"),
  ];

  // Hardware decode does not support every codec or profile, and a hard failure here
  // would be a confusing dead end. Fall back to software rather than refusing to run.
  let usedHwaccel = HWACCEL.length > 0;
  try {
    await run("ffmpeg", ffmpegArgs(HWACCEL));
  } catch (err) {
    if (!usedHwaccel) throw err;
    usedHwaccel = false;
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await run("ffmpeg", ffmpegArgs([]));
  }

  const names = (await readdir(outDir)).filter((n) => n.endsWith(".jpg")).sort();
  if (names.length < 2) {
    throw new Error(
      `extraction produced ${names.length} frame(s) — DA3 needs multiple views; ` +
        `check the video is longer than ${(1 / fps).toFixed(2)}s`,
    );
  }
  return {
    frames: names.map((n) => join(outDir, n)),
    plan: { ...plan, count: names.length },
    probe,
    scale,
    usedHwaccel,
  };
}

/**
 * Pick `count` items spanning the whole list, endpoints always included.
 *
 * This is what makes a frame ladder cost ONE decode instead of one per rung. A
 * 256-frame extraction sampled across the clip already contains the 128-frame set
 * (every 2nd), the 64-frame set (every 4th) and the 32-frame set (every 8th) -- and
 * each subset still spans the entire video, which is the only property that matters
 * for DA3's cross-view attention.
 *
 * Re-extracting per rung decoded the same 4K stream five times over and froze the
 * machine on 2026-08-01. Never do that again: extract the largest rung, then stride.
 */
export function pickEvenly(items, count) {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  if (count === 1) return [items[0]];
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return picked;
}

/**
 * Build ladder subsets from one extraction, as hardlinks -- no copying, no re-decode.
 * Returns one entry per rung, largest first, each with its own effective fps.
 */
export async function buildLadder(frames, counts, outRoot, durationS) {
  const rungs = [];
  for (const count of [...counts].sort((a, b) => b - a)) {
    if (count > frames.length) continue;
    const dir = join(outRoot, `f-${count}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const picked = pickEvenly(frames, count);
    const linked = [];
    for (const [i, src] of picked.entries()) {
      const dest = join(dir, `frame-${String(i + 1).padStart(4, "0")}.jpg`);
      // Hardlink, so N rungs cost one copy of the bytes on disk.
      try {
        await link(src, dest);
      } catch {
        await copyFile(src, dest); // different filesystem
      }
      linked.push(dest);
    }
    rungs.push({
      count,
      dir,
      frames: linked,
      effectiveFps: durationS > 0 ? count / durationS : 0,
    });
  }
  return rungs;
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [video, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!video || !outDir) {
    console.error(
      "usage: node scripts/extract-frames.mjs <video> <outDir> " +
        "[--fps 10] [--max-frames 32] [--long-edge 1024]",
    );
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(process.argv[i + 1]);
  };
  // --ladder 32,64,128,192,256 decodes ONCE at the largest rung and strides the rest.
  const ladderIndex = process.argv.indexOf("--ladder");
  const ladderCounts =
    ladderIndex === -1
      ? null
      : String(process.argv[ladderIndex + 1])
          .split(",")
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0);

  const started = Date.now();
  const result = await extractFrames(video, outDir, {
    fps: flag("fps", 10),
    maxFrames: ladderCounts ? Math.max(...ladderCounts) : flag("max-frames", 32),
    longEdge: flag("long-edge", DEFAULT_LONG_EDGE),
  });
  const { plan, probe, scale, frames, usedHwaccel } = result;
  console.log(
    `${plan.count} frames @ ${plan.effectiveFps.toFixed(2)} fps ` +
      `(${probe.durationS.toFixed(2)}s source, ${probe.width}x${probe.height})` +
      (plan.capped ? ` — capped from ${plan.requestedCount}` : "") +
      (scale.scaled ? ` — scaled to ${scale.width}x${scale.height}` : " — not scaled") +
      ` — ${usedHwaccel ? "hwaccel" : "software"} decode, ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (ladderCounts) {
    const rungs = await buildLadder(frames, ladderCounts, outDir, probe.durationS);
    console.log(`\nladder from ONE decode (hardlinked, no re-extraction):`);
    for (const r of rungs) {
      console.log(`  ${String(r.count).padStart(4)} frames @ ${r.effectiveFps.toFixed(2)} fps  ${r.dir}`);
    }
    const skipped = ladderCounts.filter((c) => c > frames.length);
    if (skipped.length) {
      console.log(`  (skipped ${skipped.join(", ")} — more than the ${frames.length} extracted)`);
    }
  }
}
