import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_PARAMS,
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  MODEL_RESIDENT_BYTES,
  planFrames,
  MAX_MEASURED_FRAMES,
  MIN_OOM_FRAMES,
  predictVram,
  vramFraction,
  VRAM_MEASUREMENTS,
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

describe("predictVram", () => {
  it("returns each measured point exactly", () => {
    for (const { frames, peakBytes } of VRAM_MEASUREMENTS) {
      const p = predictVram(frames, 504);
      expect(p.bytes).toBe(peakBytes);
      expect(p.measured).toBe(true);
    }
  });

  it("interpolates between measured points and flags it as not measured", () => {
    // 96 sits between the measured 64 and 112 rungs of the 2026-08-01 ladder.
    const p = predictVram(96, 504);
    expect(p.measured).toBe(false);
    const lo = predictVram(64, 504).bytes;
    const hi = predictVram(112, 504).bytes;
    expect(p.bytes).toBeGreaterThan(lo);
    expect(p.bytes).toBeLessThan(hi);
  });

  it("flags extrapolation beyond the measured envelope", () => {
    // 128 is the largest measured point; 144 ran but is not in the interpolation table.
    expect(predictVram(144, 504).measured).toBe(false);
    expect(predictVram(144, 504).bytes).toBeGreaterThan(predictVram(128, 504).bytes);
  });

  it("flags any resolution other than the one measured", () => {
    expect(predictVram(32, 504).measured).toBe(true);
    expect(predictVram(32, 1024).measured).toBe(false);
    expect(predictVram(32, 1024).bytes).toBeGreaterThan(predictVram(32, 504).bytes);
  });

  it("never predicts less than the resident model", () => {
    expect(predictVram(1, 504).bytes).toBeGreaterThanOrEqual(MODEL_RESIDENT_BYTES);
  });

  it("keeps the shipped default inside the measured L4 budget", () => {
    const plan = planFrames(DEFAULT_PARAMS.fps, 10, DEFAULT_PARAMS.maxFrames);
    const p = predictVram(plan.count, DEFAULT_PARAMS.processRes);
    expect(p.bytes).toBeLessThan(L4_TOTAL_VRAM_BYTES);
  });

  it("keeps the frame cap below the count that actually OOMed", () => {
    // The ladder measured 144 frames running and 160 OOMing at 504 px. The cap must
    // sit under the ceiling, not on it — 128 and 144 both completed at ~99% of the
    // device, which is not a margin.
    expect(DEFAULT_MAX_FRAMES).toBeLessThan(MIN_OOM_FRAMES);
    expect(DEFAULT_MAX_FRAMES).toBeLessThanOrEqual(MAX_MEASURED_FRAMES);
    expect(predictVram(DEFAULT_MAX_FRAMES, 504).bytes).toBeLessThan(L4_TOTAL_VRAM_BYTES);
  });

  it("predicts the 112-frame cap within 5% of what the L4 actually did", () => {
    // Measured 2026-08-01: 22_848_471_040 bytes driver peak at 112 frames @ 504 px.
    const predicted = predictVram(112, 504).bytes;
    expect(Math.abs(predicted - 22_848_471_040) / 22_848_471_040).toBeLessThan(0.05);
  });
});

describe("measured device constants", () => {
  it("uses the real usable VRAM, not the advertised 24 GiB", () => {
    // torch.cuda.mem_get_info() on the deployed L4 reported 23_659_151_360 bytes.
    expect(L4_TOTAL_VRAM_BYTES).toBe(23_659_151_360);
    expect(L4_TOTAL_VRAM_BYTES).toBeLessThan(24 * 1024 ** 3);
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
