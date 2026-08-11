/**
 * Run Source — which recorded run the measurement branch reads, or the live DA3 output.
 *
 * The `setting` parameter used to be one of three hardcoded door fixture directories, which
 * meant a live run could be measured but never recorded: there was no stable identity to key
 * a measurement to. It is now a run id from the registry (`lib/runs.ts`), so a saved cloud run
 * is selectable on exactly the same footing as the built-in door fixtures.
 */

import { getRun } from "../../lib/runs-store";
import { loadRunDepthField, type DepthFieldValue } from "../../measurement/depth-field";
import type { NodeSpec } from "../types";

export const DEFAULT_RUN_ID = "door-504px-112f";

export const fixtureRunSpec: NodeSpec = {
  type: "fixture-run",
  label: "Run Source",
  category: "source",
  version: "0.5.0",
  execution: "auto",
  /**
   * Required, and that is what produces the empty first screen rather than an error.
   *
   * `activeInputs` drops this port entirely when the source is a recorded run, so requiring it
   * costs the recorded path nothing. On the live path with no run yet, the evaluator marks the
   * node `blocked` — no output, no red status, and the viewers fall through to their own empty
   * states. Throwing instead would open the app on a failure for the ordinary case of not having
   * run anything yet.
   */
  inputs: [{ id: "live", label: "Live DA3", type: "depth_field", required: true }],
  outputs: [{ id: "depth", label: "Depth Field", type: "depth_field" }],
  /**
   * Live by default since 2026-08-11.
   *
   * `recorded` was the default and it made the app's own configuration wrong for the thing the
   * app is for. Loading a clip and running DA3 left the viewers on the door fixture, because the
   * branch they read was still pointed at recorded evidence — a paid run that did not appear.
   * Recorded evidence is now reached by choosing a run in the Runs pane, which is where the
   * question "which past run?" belongs and where the answer is listed with its size on disk.
   */
  defaults: { source: "live", runId: DEFAULT_RUN_ID },
  activeInputs: (params) => (String(params.source) === "live" ? ["live"] : []),
  controls: [
    {
      kind: "select",
      key: "source",
      label: "Source",
      help:
        "Which reconstruction everything downstream measures. **Live DA3 output** is the run " +
        "made in this session — it costs GPU time and is discarded on reload unless you save " +
        "it in the Runs pane. **Recorded evidence** is a run already on this disk: a built-in " +
        "fixture or one you saved. Recorded runs are free, repeatable, and are what the " +
        "measurements in MEASUREMENTS.md are graded against. Pick one from the Runs pane.",
      options: [
        { value: "live", label: "live DA3 output" },
        { value: "recorded", label: "recorded evidence" },
      ],
    },
    // The recorded run is chosen in the Runs pane, which knows what is on disk and how big
    // it is. A static option list here could only ever describe the three built-ins.
    {
      kind: "readout",
      key: "runId",
      label: "Recorded run",
      help:
        "The saved run feeding the measurement branch, when Source is recorded evidence. " +
        "Change it in the Runs pane — it lists what is actually on this disk, with each run's " +
        "size, which a fixed list here never could.",
    },
  ],
  execute: async ({ inputs, params }) => {
    if (String(params.source) === "live") {
      const input = inputs.live;
      const field = input?.value as DepthFieldValue | undefined;
      if (!input || !field) throw new Error("run DA3 manually before selecting the live source");
      return {
        depth: {
          ...input,
          summary: `${field.manifest.frames.count}f · LIVE DA3`,
        },
      };
    }

    const runId = String(params.runId || DEFAULT_RUN_ID);
    const run = await getRun(runId);
    if (!run) throw new Error(`run ${runId} is not in the registry`);
    const field = await loadRunDepthField(run);
    return {
      depth: {
        type: "depth_field",
        value: field,
        thumbnailUrl: field.frames[Math.floor(field.frames.length / 2)]?.rgbUrl,
        summary: `${field.manifest.frames.count}f · ${run.builtin ? "BUILT-IN RUN" : "SAVED RUN"}`,
      },
    };
  },
};
