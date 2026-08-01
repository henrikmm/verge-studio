/**
 * Frame downscaling is a transport constraint with a hard failure mode: Cloud Run
 * rejects requests over 32 MiB, and native 4K JPEGs from `test_demo.mp4` measure
 * ~432 KB each, so a 128-frame run would be ~55 MB and never reach the GPU.
 *
 * These cases pin the arithmetic that keeps the upload under that cap.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_EDGE,
  displayDimensions,
  pickEvenly,
  planScale,
  readRotation,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../../scripts/extract-frames.mjs";

type Scale = { width: number; height: number; scaled: boolean };
const scaleOf = (w: number, h: number, edge?: number): Scale =>
  planScale(w, h, edge) as Scale;

describe("planScale", () => {
  it("scales the real test_demo.mp4 4K frame to a 1024 px long edge", () => {
    expect(scaleOf(3840, 2160)).toEqual({ width: 1024, height: 576, scaled: true });
  });

  it("never upscales a source already under the limit", () => {
    expect(scaleOf(640, 360)).toEqual({ width: 640, height: 360, scaled: false });
  });

  it("passes through a source sitting exactly on the limit", () => {
    expect(scaleOf(1024, 768)).toEqual({ width: 1024, height: 768, scaled: false });
  });

  it("measures the long edge on height for portrait sources", () => {
    expect(scaleOf(1080, 1920)).toEqual({ width: 576, height: 1024, scaled: true });
  });

  it("returns even dimensions, which is what JPEG chroma subsampling wants", () => {
    // 1999x1001 scales by 1024/1999; the naive height is 512.8, which must not
    // survive as an odd or fractional value.
    const { width, height } = scaleOf(1999, 1001);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });

  it("preserves aspect ratio to within the even-rounding step", () => {
    const source = 3840 / 2160;
    const { width, height } = scaleOf(3840, 2160);
    expect(width / height).toBeCloseTo(source, 6);
  });

  it("disables scaling entirely for a non-positive long edge", () => {
    expect(scaleOf(3840, 2160, 0)).toEqual({ width: 3840, height: 2160, scaled: false });
  });

  it("honours a smaller long edge when a caller asks for one", () => {
    expect(scaleOf(3840, 2160, 512)).toEqual({ width: 512, height: 288, scaled: true });
  });

  it("keeps the default at 1024 px, the value the upload budget assumes", () => {
    expect(DEFAULT_LONG_EDGE).toBe(1024);
  });

  it("keeps a 256-frame upload well inside Cloud Run's 32 MiB cap", () => {
    // Measured from this clip: ~62 KB/frame at 1024 px vs ~432 KB at native 4K.
    const scaled = scaleOf(3840, 2160);
    expect(scaled.scaled).toBe(true);
    const budgetBytes = 256 * 62 * 1024;
    expect(budgetBytes).toBeLessThan(32 * 1024 * 1024);
  });
});

/**
 * Rotation metadata is the trap that nearly poisoned the M3 cloud session.
 *
 * `test-demo-door.mp4` STORES 1920x1080 and carries `rotation=-90`; ffmpeg autorotates
 * on decode, so the filter chain receives 1080x1920. Planning a scale filter from the
 * stored size emits `scale=1024:576` and stretches every portrait frame into landscape
 * — reaching the GPU with a wrong aspect ratio, and wrong geometry downstream of that.
 */
describe("rotation handling", () => {
  const rotationOf = (stream: unknown): number => readRotation(stream) as number;
  const displayOf = (w: number, h: number, r: number) =>
    displayDimensions(w, h, r) as { width: number; height: number };

  it("reads modern side_data rotation", () => {
    expect(rotationOf({ side_data_list: [{ rotation: -90 }] })).toBe(270);
  });

  it("falls back to the legacy rotate tag", () => {
    expect(rotationOf({ tags: { rotate: "90" } })).toBe(90);
  });

  it("prefers side_data over the legacy tag when a file carries both", () => {
    expect(rotationOf({ side_data_list: [{ rotation: 180 }], tags: { rotate: "90" } })).toBe(180);
  });

  it("reports no rotation for an unrotated stream", () => {
    expect(rotationOf({ width: 3840, height: 2160 })).toBe(0);
    expect(rotationOf({ side_data_list: [{ displaymatrix: "..." }] })).toBe(0);
    expect(rotationOf(undefined)).toBe(0);
  });

  it("swaps axes for a quarter turn in either direction", () => {
    expect(displayOf(1920, 1080, 270)).toEqual({ width: 1080, height: 1920 });
    expect(displayOf(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
  });

  it("leaves axes alone for 0 and 180 degrees", () => {
    expect(displayOf(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(displayOf(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
  });

  it("plans the real door clip as portrait, not squashed landscape", () => {
    // The bug: planScale(1920, 1080) -> 1024x576, applied to a 1080x1920 decode.
    const display = displayOf(1920, 1080, rotationOf({ side_data_list: [{ rotation: -90 }] }));
    expect(scaleOf(display.width, display.height)).toEqual({
      width: 576,
      height: 1024,
      scaled: true,
    });
  });

  it("keeps the door clip's aspect ratio through the whole plan", () => {
    const display = displayOf(1920, 1080, 270);
    const { width, height } = scaleOf(display.width, display.height);
    expect(width / height).toBeCloseTo(display.width / display.height, 6);
  });
});

/**
 * Sampling by FPS forces ffmpeg to decode the WHOLE clip whatever the frame count, so
 * a five-rung ladder used to mean five full 4K HEVC decodes. That froze the machine on
 * 2026-08-01. These cases pin the property that makes one decode enough: the largest
 * rung contains every smaller rung, and every rung still spans the entire clip.
 */
describe("pickEvenly", () => {
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i);
  const pick = (items: number[], n: number): number[] => pickEvenly(items, n) as number[];

  it("returns exactly the requested count", () => {
    for (const n of [2, 32, 64, 128, 192]) {
      expect(pick(seq(256), n)).toHaveLength(n);
    }
  });

  it("always includes both endpoints, so subsets span the whole clip", () => {
    for (const n of [2, 32, 64, 128, 192]) {
      const got = pick(seq(256), n);
      expect(got[0]).toBe(0);
      expect(got[got.length - 1]).toBe(255);
    }
  });

  it("returns strictly increasing frames — never a duplicate or a reorder", () => {
    const got = pick(seq(256), 192);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]!);
  });

  it("strides exactly for power-of-two divisors of the 256-frame superset", () => {
    // This is the ladder's core claim: 128 is every 2nd frame, 64 every 4th, 32 every 8th.
    expect(pick(seq(257), 129)).toEqual(seq(129).map((i) => i * 2));
    expect(pick(seq(257), 65)).toEqual(seq(65).map((i) => i * 4));
    expect(pick(seq(257), 33)).toEqual(seq(33).map((i) => i * 8));
  });

  it("passes the list through when asked for at least as many as exist", () => {
    expect(pick(seq(32), 32)).toEqual(seq(32));
    expect(pick(seq(32), 99)).toEqual(seq(32));
  });

  it("handles the degenerate counts without throwing", () => {
    expect(pick(seq(10), 0)).toEqual([]);
    expect(pick(seq(10), 1)).toEqual([0]);
  });

  it("does not mutate the source list", () => {
    const source = seq(64);
    pick(source, 8);
    expect(source).toEqual(seq(64));
  });
});

describe("upload budget", () => {
  it("keeps the largest ladder rung inside the request cap", () => {
    // Measured from this clip: ~62 KB/frame at 1024 px vs ~432 KB at native 4K.
    const scaled = scaleOf(3840, 2160);
    expect(scaled.scaled).toBe(true);
    const budgetBytes = 256 * 62 * 1024;
    expect(budgetBytes).toBeLessThan(32 * 1024 * 1024);
  });
});
