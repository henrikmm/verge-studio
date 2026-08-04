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
  version: "0.4.0",
  execution: "auto",
  inputs: [{ id: "live", label: "Live DA3", type: "depth_field", required: false }],
  outputs: [{ id: "depth", label: "Depth Field", type: "depth_field" }],
  defaults: { source: "recorded", runId: DEFAULT_RUN_ID },
  activeInputs: (params) => (String(params.source) === "live" ? ["live"] : []),
  controls: [
    {
      kind: "select",
      key: "source",
      label: "Source",
      options: [
        { value: "recorded", label: "recorded evidence" },
        { value: "live", label: "live DA3 output" },
      ],
    },
    // The recorded run is chosen in the Runs pane, which knows what is on disk and how big
    // it is. A static option list here could only ever describe the three built-ins.
    { kind: "readout", key: "runId", label: "Recorded run" },
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
