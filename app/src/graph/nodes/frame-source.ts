/**
 * FrameSource — local ffmpeg only. The local computer samples the video; the cloud never does.
 *
 * `videoSha256` is a parameter rather than incidental metadata on purpose: it makes
 * the cache key track the video's *content*, so replacing a file at the same path
 * correctly invalidates everything downstream instead of hitting a stale cache.
 *
 * ## Manual since 2026-08-11, for the same reason DA3 is
 *
 * `manual` has always meant "this costs something, so it waits to be asked". That was read as
 * *money*, and ffmpeg is free — but it is not cheap. Sampling decodes the ENTIRE clip whatever
 * the frame count: measured on the original development computer, 1.7 s for a 13.5 s 1080p clip
 * and 11.7 s for a 15.8 s
 * 4K60 one. As an auto node it paid that on every settle of the two sliders below, and it
 * started before the operator had seen what the settings would do.
 *
 * Being manual buys the guard for free. `runAutoFree` — the pass that follows a control edit —
 * denies every manual node, so dragging Sampling FPS restamps the cache key, updates the plan on
 * screen and runs nothing. The work happens when Extract is pressed.
 */

import { extractFrames, frameUrl, type FramePlan, type VideoProbe } from "../../lib/infer-client";
import type { NodeSpec } from "../types";

export interface FramesValue {
  paths: string[];
  plan: FramePlan;
  probe: VideoProbe;
  /** Clip identity, carried downstream so a registered run knows which video it measured.
   *  Metric scale does not transfer between clips, so this decides which measurement
   *  targets a run may legitimately be graded against. */
  clipName: string;
  clipSha256: string;
}

export const frameSourceSpec: NodeSpec = {
  type: "frame-source",
  label: "Frame Source",
  category: "source",
  version: "0.2.0",
  execution: "manual",
  inputs: [],
  outputs: [{ id: "frames", label: "Frames", type: "frames" }],
  defaults: {
    videoPath: "",
    videoName: "",
    videoSha256: "",
    durationS: 0,
    /**
     * Probed at load, so the plan can be shown before ffmpeg runs.
     *
     * The downscale target is a function of the source dimensions, and until 2026-08-11 the only
     * way to learn it was to extract and read the answer back — which is exactly the work the
     * plan exists to let somebody decide about.
     */
    nativeFps: 0,
    width: 0,
    height: 0,
    fps: 10,
    maxFrames: 112,
  },
  controls: [
    { kind: "readout", key: "videoName", label: "Clip" },
    { kind: "readout", key: "durationS", label: "Duration" },
    {
      kind: "slider",
      key: "fps",
      label: "Sampling FPS",
      min: 1,
      max: 50,
      help:
        "How many frames a second to take from the clip. Accuracy here comes from comparing " +
        "many views of one scene, so frames are sampled across the WHOLE clip at this rate — " +
        "the clip is never trimmed to a window. If this rate would exceed the frame cap the " +
        "app lowers it and shows the arithmetic, rather than shortening the video.",
    },
    {
      kind: "slider",
      key: "maxFrames",
      label: "Max frames",
      min: 2,
      max: 144,
      help:
        "The ceiling on frames sent to the GPU, because the card's memory is finite and the " +
        "model imposes no limit of its own. 112 is the default and it is deliberately below " +
        "the measured ceiling: 144 frames ran at 21.88 GiB of 22.03, and 160 ran out of " +
        "memory. 112 measured 17.23 GiB, roughly 15% headroom.",
    },
  ],
  execute: async ({ params }) => {
    const videoPath = String(params.videoPath ?? "");
    if (!videoPath) throw new Error("no video — drop a clip onto this node");

    const { frames, plan, probe } = await extractFrames(
      videoPath,
      Number(params.fps),
      Number(params.maxFrames),
    );

    const value: FramesValue = {
      paths: frames,
      plan,
      probe,
      clipName: String(params.videoName ?? ""),
      clipSha256: String(params.videoSha256 ?? ""),
    };
    return {
      frames: {
        type: "frames",
        value,
        thumbnailUrl: frames[0] ? frameUrl(frames[0]) : undefined,
        summary: `${plan.count}f · ${plan.effectiveFps.toFixed(2)} fps${plan.capped ? " (capped)" : ""}`,
      },
    };
  },
};
