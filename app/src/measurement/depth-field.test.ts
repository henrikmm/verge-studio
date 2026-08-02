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
