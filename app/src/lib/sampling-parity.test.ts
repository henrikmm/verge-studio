/**
 * The frame plan is implemented twice: once in TypeScript for the UI preview
 * (contract.ts::planFrames, planScale) and once in Node for the actual ffmpeg pass
 * (scripts/extract-frames.mjs::planSampling, planScale). If they disagree, the Setup pane lies
 * about what a setting will do before the user pays for a GPU run.
 *
 * The plan is now shown BEFORE extraction and decides whether the operator presses the button,
 * so a divergence here is no longer a cosmetic mismatch after the fact — it is a wrong number
 * being acted on.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM module, no type declarations
import { DEFAULT_LONG_EDGE as NODE_LONG_EDGE, planSampling, planScale as nodePlanScale } from "../../../scripts/extract-frames.mjs";
import { DEFAULT_LONG_EDGE, planFrames, planScale } from "./contract";

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

/**
 * Sizes drawn from real clips on this disk plus the awkward cases around the limit: a source
 * already under it, one exactly on it, a portrait clip (the rotated 4K one decodes this way),
 * and an odd width that has to round to even.
 */
const SIZES: Array<[width: number, height: number]> = [
  [3840, 2160],
  [2160, 3840],
  [1920, 1080],
  [1024, 576],
  [1024, 1024],
  [800, 600],
  [1023, 577],
  [4096, 2160],
  [1080, 1920],
];

describe("frame-scale parity between UI preview and ffmpeg extractor", () => {
  it("agrees on the long edge itself", () => {
    expect(DEFAULT_LONG_EDGE).toBe(NODE_LONG_EDGE);
  });

  for (const [width, height] of SIZES) {
    it(`agrees for ${width}x${height}`, () => {
      const ts = planScale(width, height);
      const node = nodePlanScale(width, height) as {
        width: number;
        height: number;
        scaled: boolean;
      };
      expect(node.width).toBe(ts.width);
      expect(node.height).toBe(ts.height);
      expect(node.scaled).toBe(ts.scaled);
    });
  }

  it("never upscales", () => {
    const plan = planScale(640, 480);
    expect(plan).toEqual({ width: 640, height: 480, scaled: false });
  });

  // Only when it actually resizes. A source that passes through untouched keeps whatever
  // dimensions it had, odd ones included — rounding it would be a resize nobody asked for.
  it("keeps both axes even whenever it resizes, which is what the JPEG encoder wants", () => {
    for (const [width, height] of SIZES) {
      const plan = planScale(width, height);
      if (!plan.scaled) continue;
      expect(plan.width % 2).toBe(0);
      expect(plan.height % 2).toBe(0);
    }
  });
});
