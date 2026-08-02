import {
  loadFixtureDepthField,
  type DepthFieldValue,
  type FixtureSetting,
} from "../../measurement/depth-field";
import type { NodeSpec } from "../types";

export const fixtureRunSpec: NodeSpec = {
  type: "fixture-run",
  label: "Run Source",
  category: "source",
  version: "0.3.0",
  execution: "auto",
  inputs: [{ id: "live", label: "Live DA3", type: "depth_field", required: false }],
  outputs: [{ id: "depth", label: "Depth Field", type: "depth_field" }],
  defaults: { source: "recorded", setting: "504px-112f" },
  activeInputs: (params) => String(params.source) === "live" ? ["live"] : [],
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
    {
      kind: "select",
      key: "setting",
      label: "Recorded run",
      options: [
        { value: "504px-112f", label: "504 px · 112 frames" },
        { value: "356px-256f", label: "356 px · 256 frames" },
        { value: "252px-256f", label: "252 px · 256 frames" },
      ],
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
    const setting = String(params.setting) as FixtureSetting;
    const field = await loadFixtureDepthField(setting);
    return {
      depth: {
        type: "depth_field",
        value: field,
        thumbnailUrl: field.frames[Math.floor(field.frames.length / 2)]?.rgbUrl,
        summary: `${field.manifest.frames.count}f · OFFLINE FIXTURE`,
      },
    };
  },
};
