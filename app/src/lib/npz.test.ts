import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpz, percentile } from "./npz";

const fixture = fileURLToPath(new URL("../../../fixtures/roadside/result.npz", import.meta.url));

describe("parseNpz on the real DA3 fixture", () => {
  it("reads all four arrays with expected shapes", async () => {
    const buf = (await readFile(fixture)).buffer as ArrayBuffer;
    const arrays = await parseNpz(buf);
    expect(Object.keys(arrays).sort()).toEqual(["confidence", "depth", "extrinsics", "intrinsics"]);
    expect(arrays.depth.shape).toEqual([4, 224, 392]);
    expect(arrays.confidence.shape).toEqual([4, 224, 392]);
    expect(arrays.extrinsics.shape).toEqual([4, 3, 4]);
    expect(arrays.intrinsics.shape).toEqual([4, 3, 3]);
  });

  it("depth values are finite positive meters in a plausible range", async () => {
    const buf = (await readFile(fixture)).buffer as ArrayBuffer;
    const { depth } = await parseNpz(buf);
    const frame0 = depth.data.subarray(0, 224 * 392);
    const lo = percentile(frame0, 2);
    const hi = percentile(frame0, 98);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThan(1000);
  });
});
