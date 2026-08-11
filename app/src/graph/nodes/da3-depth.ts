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
import { getCloud, inferBase } from "../../lib/cloud-store";
import { registerRun } from "../../lib/runs";
import { refreshRuns } from "../../lib/runs-store";
import { update } from "../../lib/session-store";
import { beginFetching, noteFramesRead } from "../../lib/run-phase";
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
    {
      kind: "slider",
      key: "processRes",
      label: "Process res",
      min: 252,
      max: 1024,
      step: 14,
      help:
        "The size DA3 resizes every frame to before it looks at it. 504 is the default in the " +
        "model's own API, command line and demo. Memory cost grows with the square of this, so " +
        "doubling it is roughly four times the VRAM — which is why the budget bar above moves " +
        "when you drag it.",
    },
    {
      kind: "select",
      key: "processResMethod",
      label: "Res method",
      help:
        "Whether the process resolution is a ceiling or a floor for the frame's longest side. " +
        "**upper_bound_resize** shrinks anything larger and is the demo's own default. " +
        "**lower_bound_resize** grows anything smaller instead, which costs memory for pixels " +
        "the source never had.",
      options: [
        { value: "upper_bound_resize", label: "upper_bound_resize" },
        { value: "lower_bound_resize", label: "lower_bound_resize" },
      ],
    },
    {
      kind: "select",
      key: "refViewStrategy",
      label: "Ref view",
      help:
        "Which frame the other frames are reconstructed relative to — the anchor for the whole " +
        "scene's geometry. **middle** is what the model's documentation recommends for video, " +
        "where frames arrive in time order, and it is what the marked cell in the contact " +
        "sheet points at. The saddle strategies pick by image similarity instead, which suits " +
        "an unordered pile of photographs rather than a clip.",
      options: [
        { value: "middle", label: "middle" },
        { value: "saddle_balanced", label: "saddle_balanced" },
        { value: "saddle_sim_range", label: "saddle_sim_range" },
        { value: "first", label: "first" },
      ],
    },
    {
      kind: "slider",
      key: "maxFrames",
      label: "Max frames",
      min: 2,
      max: 144,
      help:
        "A second ceiling, applied by the service after the frames arrive. Frame Source has " +
        "already capped the upload, so this normally does nothing — it is the backstop for a " +
        "request built by hand.",
    },
  ],
  execute: async ({ inputs, params }) => {
    const frames = inputs.frames?.value as FramesValue | undefined;
    if (!frames || frames.paths.length === 0) throw new Error("no frames on the input");

    /**
     * Read the frames off local disk one at a time rather than all at once.
     *
     * `Promise.all` over 112 fetches is marginally faster and reports nothing until it is done.
     * Sequential reads let the count climb on screen, and this is a few hundred milliseconds of
     * local I/O against a run that can take two minutes — the wrong axis to optimise.
     */
    const blobs: Blob[] = [];
    for (const path of frames.paths) {
      blobs.push(await fetchFrameBlob(path));
      noteFramesRead(blobs.length, frames.paths.length);
    }

    const manifest: InferManifest = await infer(blobs, {
      fps: frames.plan.effectiveFps,
      sourceDurationS: frames.probe.durationS,
      processRes: Number(params.processRes),
      processResMethod: params.processResMethod as ProcessResMethod,
      refViewStrategy: params.refViewStrategy as RefViewStrategy,
      maxFrames: Number(params.maxFrames),
    });

    // The manifest is back, so the GPU is done and the remaining wait is artifacts coming down
    // the wire. This also stops the telemetry poll — nothing is left to observe on the device.
    beginFetching();

    // The status bar's last-run chip reads this. Nothing set it until 2026-08-04, so the chip
    // never rendered — and this node is the only place a real run actually happens.
    update({ lastRun: manifest });

    /**
     * Register the run — a manifest stub, nothing large.
     *
     * This is the whole "transient by default" policy in one place: the run becomes a
     * first-class, selectable, measurable thing immediately, while its ~135 MB of artifacts
     * stay on the Cloud Run instance until someone presses Save in the Runs pane. A mock run
     * is skipped: the fixture-backed mock returns the roadside artifacts, which are not
     * evidence of anything and must never look like a saved run.
     */
    if (!manifest.mock) {
      try {
        await registerRun({
          id: manifest.runId,
          label: `${frames.clipName || "clip"} · ${manifest.params.processRes} px · ${manifest.frames.count}f`,
          clipName: frames.clipName,
          clipSha256: frames.clipSha256,
          frameCount: manifest.frames.count,
          processRes: manifest.params.processRes,
          gpuSeconds: manifest.timing.gpuSeconds,
          /**
           * The real service, not the path the browser used to reach it.
           *
           * Under the local proxy `inferBase()` is `/api/cloud/svc`, which is meaningless to
           * `save-run.sh` — it runs in a shell and needs somewhere to curl. Recording the proxy
           * path made Save fail with "no such run" long after the GPU had been paid for.
           */
          serviceUrl: getCloud().serviceUrl ?? inferBase(),
          manifest,
          framePaths: frames.paths.slice(0, manifest.frames.count),
        });
        void refreshRuns();
      } catch {
        // A registry failure must not destroy a run that has already been paid for. The
        // manifest is still in the graph and the artifacts are still on the instance.
      }
    }

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
