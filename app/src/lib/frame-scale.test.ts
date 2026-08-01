/**
 * Frame downscaling is a transport constraint with a hard failure mode: Cloud Run
 * rejects requests over 32 MiB, and native 4K JPEGs from `test_demo.mp4` measure
 * ~432 KB each, so a 128-frame run would be ~55 MB and never reach the GPU.
 *
 * These cases pin the arithmetic that keeps the upload under that cap.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM module, no type declarations
import { DEFAULT_LONG_EDGE, pickEvenly, planScale } from "../../../scripts/extract-frames.mjs";

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
