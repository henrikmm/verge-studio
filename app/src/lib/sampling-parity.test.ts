/**
 * The frame plan is implemented twice: once in TypeScript for the UI preview
 * (contract.ts::planFrames) and once in Node for the actual ffmpeg pass
 * (scripts/extract-frames.mjs::planSampling). If they disagree, the inspector lies
 * about what a setting will do before the user pays for a GPU run.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM module, no type declarations
import { planSampling } from "../../../scripts/extract-frames.mjs";
import { planFrames } from "./contract";

const CASES: Array<[fps: number, duration: number, cap: number]> = [
  [10, 10, 16], // the shipped default: capped
  [10, 10, 32],
  [2, 10, 32], // uncapped
  [1, 60, 16],
  [50, 3, 16], // high fps, short clip
  [3.2, 10, 32], // exactly at the cap
  [10, 0.05, 16], // sub-frame clip
  [25, 8, 64],
];

describe("frame-plan parity between UI preview and ffmpeg extractor", () => {
  for (const [fps, duration, cap] of CASES) {
    it(`agrees for fps=${fps} duration=${duration}s cap=${cap}`, () => {
      const ts = planFrames(fps, duration, cap);
      const node = planSampling(fps, duration, cap) as {
        count: number;
        effectiveFps: number;
        capped: boolean;
      };
      expect(node.count).toBe(ts.count);
      expect(node.capped).toBe(ts.capped);
      expect(node.effectiveFps).toBeCloseTo(ts.effectiveFps, 9);
    });
  }
});
