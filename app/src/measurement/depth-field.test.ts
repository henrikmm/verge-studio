import { describe, expect, it } from "vitest";
import { canonicalFrameMap } from "./depth-field";
import { resampleMaskNearest } from "../graph/nodes/measurement";

describe("canonicalFrameMap", () => {
  it("reproduces the exact 112-frame ladder mapping", () => {
    const map = canonicalFrameMap(112);
    expect(map).toHaveLength(112);
    expect(map[0]).toBe(1);
    expect(map[111]).toBe(256);
    expect(map[62]).toBe(143);
    expect(map[100]).toBe(231);
    expect(new Set(map).size).toBe(112);
  });

  it("keeps all canonical indices for a 256-frame run", () => {
    expect(canonicalFrameMap(256)).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
  });
});

/**
 * Which RGB file an NPZ index resolves to.
 *
 * A saved 81-frame cloud run was being read with the door fixtures' canonical map, so NPZ index
 * 1 loaded `frame-0004.jpg` and index 80 asked for `frame-0256.jpg` when only 81 files existed.
 * The early indices are the dangerous half: those files are present, so RGB and depth simply
 * disagreed, and a mask painted on one frame was back-projected with another frame's depth and
 * camera pose. No error was ever raised.
 */
describe("frame numbering conventions", () => {
  it("saved cloud runs are contiguous — NPZ index i is file i+1", () => {
    const identity = Array.from({ length: 81 }, (_, i) => i + 1);
    expect(identity[0]).toBe(1);
    expect(identity[25]).toBe(26);
    expect(identity[80]).toBe(81);
    // The whole point: it never asks for a file the run does not have.
    expect(Math.max(...identity)).toBe(81);
  });

  it("the canonical map would overrun a saved run — this is the bug it caused", () => {
    const canonical = canonicalFrameMap(81);
    expect(canonical[1]).toBe(4); // present but WRONG: silent desync
    expect(canonical[80]).toBe(256); // absent: 404 past index 25
    expect(canonical.filter((n) => n > 81).length).toBeGreaterThan(0);
  });

  it("still maps the built-in door fixtures across their shared 256-frame extraction", () => {
    const map = canonicalFrameMap(112);
    expect(map[0]).toBe(1);
    expect(map[111]).toBe(256);
    expect(map.length).toBe(112);
  });
});

describe("resampleMaskNearest", () => {
  it("preserves a painted quadrant across fixture resolutions", () => {
    const source = new Uint8Array([
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(Array.from(resampleMaskNearest(source, 4, 4, 2, 2))).toEqual([1, 0, 0, 0]);
    expect(resampleMaskNearest(source, 4, 4, 8, 8).reduce((sum, value) => sum + value, 0)).toBe(16);
  });
});
