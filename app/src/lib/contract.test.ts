import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  estimateVramRange,
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  planFrames,
  vramFraction,
} from "./contract";

describe("planFrames", () => {
  it("matches DA3's fps-based sampling when under the cap", () => {
    expect(planFrames(2, 10, 32)).toEqual({ count: 20, effectiveFps: 2, capped: false });
  });

  it("lowers fps instead of truncating the clip when over the cap", () => {
    // The HF Space default (10 fps) over a 10s clip wants 100 frames.
    const plan = planFrames(10, 10, 32);
    expect(plan.capped).toBe(true);
    expect(plan.count).toBe(32);
    // Frames must still span the whole clip, not just the first 3.2 seconds.
    expect(plan.effectiveFps).toBeCloseTo(3.2, 5);
    expect(plan.effectiveFps * 10).toBeCloseTo(32, 5);
  });

  it("never returns zero frames for very short clips", () => {
    expect(planFrames(10, 0.05, 32).count).toBe(1);
  });

  it("treats the cap as inclusive", () => {
    expect(planFrames(3.2, 10, 32).capped).toBe(false);
  });
});

describe("defaults track upstream", () => {
  it("uses the HF Space sampling default and DA3's video-recommended ref view", () => {
    expect(DEFAULT_PARAMS.fps).toBe(10);
    expect(DEFAULT_PARAMS.processRes).toBe(504);
    expect(DEFAULT_PARAMS.refViewStrategy).toBe("middle");
    expect(DEFAULT_PARAMS.inferGs).toBe(false);
  });
});

describe("estimateVramRange", () => {
  it("brackets the one measurement it is anchored to", () => {
    // Both extremes are fitted through 4 frames @ 392 px = 8.53 GiB, so at that
    // exact point the bracket must collapse onto the measurement.
    const { lowBytes, highBytes } = estimateVramRange(4, 392);
    expect(lowBytes / 1024 ** 3).toBeCloseTo(8.53, 2);
    expect(highBytes / 1024 ** 3).toBeCloseTo(8.53, 2);
  });

  it("widens as it extrapolates away from the measurement", () => {
    const near = estimateVramRange(4, 392);
    const far = estimateVramRange(32, 504);
    expect(far.highBytes - far.lowBytes).toBeGreaterThan(near.highBytes - near.lowBytes);
  });

  it("grows with frame count and with resolution", () => {
    expect(estimateVramRange(8, 504).highBytes).toBeGreaterThan(
      estimateVramRange(4, 504).highBytes,
    );
    expect(estimateVramRange(4, 1024).highBytes).toBeGreaterThan(
      estimateVramRange(4, 504).highBytes,
    );
  });

  it("never claims to be measured", () => {
    expect(estimateVramRange(16, 504).measured).toBe(false);
  });

  it("keeps the shipped default's lower bracket inside the L4 budget", () => {
    const plan = planFrames(DEFAULT_PARAMS.fps, 10, DEFAULT_PARAMS.maxFrames);
    expect(estimateVramRange(plan.count, DEFAULT_PARAMS.processRes).lowBytes).toBeLessThan(
      L4_TOTAL_VRAM_BYTES,
    );
  });
});

describe("formatting", () => {
  it("reports GiB above a gibibyte and MiB below", () => {
    expect(formatBytes(9163968512)).toBe("8.53 GiB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("guards against a zero denominator", () => {
    expect(vramFraction(100, 0)).toBe(0);
  });
});
