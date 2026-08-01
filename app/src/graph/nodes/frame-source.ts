/**
 * FrameSource — local ffmpeg only. The Mac samples the video; the cloud never does.
 *
 * `videoSha256` is a parameter rather than incidental metadata on purpose: it makes
 * the cache key track the video's *content*, so replacing a file at the same path
 * correctly invalidates everything downstream instead of hitting a stale cache.
 */

import { extractFrames, frameUrl, type FramePlan, type VideoProbe } from "../../lib/infer-client";
import type { NodeSpec } from "../types";

export interface FramesValue {
  paths: string[];
  plan: FramePlan;
  probe: VideoProbe;
}

export const frameSourceSpec: NodeSpec = {
  type: "frame-source",
  label: "Frame Source",
  category: "source",
  version: "0.1.0",
  execution: "auto",
  inputs: [],
  outputs: [{ id: "frames", label: "Frames", type: "frames" }],
  defaults: {
    videoPath: "",
    videoName: "",
    videoSha256: "",
    durationS: 0,
    fps: 10,
    maxFrames: 32,
  },
  execute: async ({ params }) => {
    const videoPath = String(params.videoPath ?? "");
    if (!videoPath) throw new Error("no video — drop a clip onto this node");

    const { frames, plan, probe } = await extractFrames(
      videoPath,
      Number(params.fps),
      Number(params.maxFrames),
    );

    const value: FramesValue = { paths: frames, plan, probe };
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
