/**
 * DA3Depth — the only node that costs money, and therefore the only `manual` one.
 * It goes stale and waits for an explicit Run; nothing upstream can trigger it.
 *
 * It always sends real multipart frames, offline and in the cloud alike: the Vite
 * dev middleware parses the same multipart body the FastAPI service does, so this
 * path is exercised locally instead of being first tried against a billing GPU.
 *
 * `fps` is not a parameter here. Sampling already happened locally in FrameSource and
 * the server never resamples, so the manifest reports the effective rate that produced
 * the frames it actually received.
 */

import { artifactUrl, fetchFrameBlob, infer } from "../../lib/infer-client";
import type { InferManifest, ProcessResMethod, RefViewStrategy } from "../../lib/contract";
import { DEFAULT_MAX_FRAMES } from "../../lib/contract";
import { depthFieldFromRun } from "../../measurement/depth-field";
import { update } from "../../lib/session-store";
import type { NodeSpec } from "../types";
import type { FramesValue } from "./frame-source";

export const da3DepthSpec: NodeSpec = {
  type: "da3-depth",
  label: "DA3 Depth",
  category: "analysis",
  version: "0.1.0",
  execution: "manual",
  inputs: [{ id: "frames", label: "Frames", type: "frames", required: true }],
  outputs: [{ id: "depth", label: "Depth Field", type: "depth_field" }],
  defaults: {
    processRes: 504,
    processResMethod: "upper_bound_resize",
    refViewStrategy: "middle",
    maxFrames: DEFAULT_MAX_FRAMES,
  },
  controls: [
    { kind: "slider", key: "processRes", label: "Process res", min: 252, max: 1024, step: 14 },
    {
      kind: "select",
      key: "processResMethod",
      label: "Res method",
      options: [
        { value: "upper_bound_resize", label: "upper_bound_resize" },
        { value: "lower_bound_resize", label: "lower_bound_resize" },
      ],
    },
    {
      kind: "select",
      key: "refViewStrategy",
      label: "Ref view",
      options: [
        { value: "middle", label: "middle" },
        { value: "saddle_balanced", label: "saddle_balanced" },
        { value: "saddle_sim_range", label: "saddle_sim_range" },
        { value: "first", label: "first" },
      ],
    },
    { kind: "slider", key: "maxFrames", label: "Max frames", min: 2, max: 144 },
  ],
  execute: async ({ inputs, params }) => {
    const frames = inputs.frames?.value as FramesValue | undefined;
    if (!frames || frames.paths.length === 0) throw new Error("no frames on the input");

    const blobs = await Promise.all(frames.paths.map(fetchFrameBlob));
    const manifest: InferManifest = await infer(blobs, {
      fps: frames.plan.effectiveFps,
      sourceDurationS: frames.probe.durationS,
      processRes: Number(params.processRes),
      processResMethod: params.processResMethod as ProcessResMethod,
      refViewStrategy: params.refViewStrategy as RefViewStrategy,
      maxFrames: Number(params.maxFrames),
    });

    // The status bar's last-run chip reads this. Nothing set it until 2026-08-04, so the chip
    // never rendered — and this node is the only place a real run actually happens.
    update({ lastRun: manifest });

    const preview = manifest.artifacts.find((a) => a.kind === "depth_preview");
    const field = depthFieldFromRun(manifest, frames);
    // Honesty: a mock run must never be mistakable for a real one on the card. The
    // device name carries it too, but the summary is what shows without selecting.
    const provenance = manifest.mock ? " · MOCK" : "";
    return {
      depth: {
        type: "depth_field",
        value: field,
        thumbnailUrl: preview?.url ? artifactUrl(preview.url) : undefined,
        summary: `${manifest.frames.count}f · ${manifest.timing.gpuSeconds.toFixed(1)}s GPU${provenance}`,
      },
    };
  },
};
