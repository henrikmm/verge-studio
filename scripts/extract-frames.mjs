// Local frame extraction — the Mac does this, never the cloud.
//
// Mirrors DA3's own video handling (app/modules/file_handlers.py::_process_video):
// sample by target FPS, not by "N frames across the clip". The one thing we add is
// a frame cap, because DA3 imposes none and a 24 GiB L4 does.
//
// When fps x duration exceeds the cap we LOWER THE FPS rather than truncating the
// clip, so the frames still span the whole video. Callers are told the effective fps.
//
// Usage: node scripts/extract-frames.mjs <video> <outDir> [--fps 10] [--max-frames 32]

import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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

/**
 * Extract JPEG frames to `outDir`. Returns absolute paths plus the sampling plan
 * that produced them.
 */
export async function extractFrames(videoPath, outDir, { fps = 10, maxFrames = 32 } = {}) {
  await requireFfmpeg();
  await stat(videoPath); // throws a clear ENOENT if the video is missing

  const probe = await probeVideo(videoPath);
  const plan = planSampling(fps, probe.durationS, maxFrames);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await run("ffmpeg", [
    "-nostdin",
    "-v", "error",
    "-i", videoPath,
    "-vf", `fps=${plan.effectiveFps.toFixed(9)}`,
    "-frames:v", String(plan.count),
    "-q:v", "2",
    join(outDir, "frame-%04d.jpg"),
  ]);

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
  };
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [video, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!video || !outDir) {
    console.error("usage: node scripts/extract-frames.mjs <video> <outDir> [--fps 10] [--max-frames 32]");
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(process.argv[i + 1]);
  };
  const result = await extractFrames(video, outDir, {
    fps: flag("fps", 10),
    maxFrames: flag("max-frames", 32),
  });
  const { plan, probe } = result;
  console.log(
    `${plan.count} frames @ ${plan.effectiveFps.toFixed(2)} fps ` +
      `(${probe.durationS.toFixed(2)}s source, ${probe.width}x${probe.height})` +
      (plan.capped ? ` — capped from ${plan.requestedCount}` : ""),
  );
}
