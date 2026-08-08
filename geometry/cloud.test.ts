/**
 * The cloud builder, against frames whose answers are known exactly.
 *
 * A real fixture cannot separate "our arithmetic is wrong" from "the reconstruction is bad".
 * These frames are flat planes at exact distances with confidence laid on by hand, so every
 * assertion here has one cause.
 */

import { describe, expect, it } from "vitest";
import { buildCloud, framesFromArrays } from "./cloud";
import type { Frame } from "./backproject";

const WIDTH = 40;
const HEIGHT = 30;

/**
 * One frame looking straight down −Z at a flat wall.
 *
 * Identity rotation and zero translation, so camera space IS world space and a pixel's world
 * position is arithmetic anyone can check by hand.
 */
function flatFrame(depthM: number, confidenceAt: (x: number, y: number) => number): Frame {
  const depth = new Float32Array(WIDTH * HEIGHT).fill(depthM);
  const confidence = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) confidence[y * WIDTH + x] = confidenceAt(x, y);
  }
  return {
    depth,
    confidence,
    width: WIDTH,
    height: HEIGHT,
    intrinsics: Float32Array.from([100, 0, WIDTH / 2, 0, 100, HEIGHT / 2, 0, 0, 1]),
    extrinsics: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
  };
}

/** The reference the builder's histogram must agree with: a real sort. */
function percentileBySort(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

describe("buildCloud", () => {
  it("puts a pixel where the arithmetic says, in metres", () => {
    const cloud = buildCloud([flatFrame(2, () => 5)], { confidence: { kind: "none" } });

    expect(cloud.pointCount).toBe(WIDTH * HEIGHT);
    // The principal point looks straight ahead, so it lands on the optical axis at the depth.
    const centre = (HEIGHT / 2) * WIDTH + WIDTH / 2;
    expect(cloud.positions[centre * 3]).toBeCloseTo(0, 6);
    expect(cloud.positions[centre * 3 + 1]).toBeCloseTo(0, 6);
    expect(cloud.positions[centre * 3 + 2]).toBeCloseTo(2, 6);
    // One pixel right of centre, at focal length 100: x = 1 * 2 / 100.
    const right = (HEIGHT / 2) * WIDTH + WIDTH / 2 + 1;
    expect(cloud.positions[right * 3]).toBeCloseTo(0.02, 6);
  });

  it("scales positions linearly with depth, so metric scale cannot be lost", () => {
    const near = buildCloud([flatFrame(2, () => 5)], { confidence: { kind: "none" } });
    const far = buildCloud([flatFrame(6, () => 5)], { confidence: { kind: "none" } });
    for (let i = 0; i < 30; i++) {
      expect(far.positions[i]).toBeCloseTo(near.positions[i] * 3, 5);
    }
  });

  it("takes DA3's own threshold per frame, not once for both", () => {
    // Two frames the model was differently sure about. A pooled threshold would delete the
    // dim one entirely; a per-frame threshold thins each by the same share. Confidence varies
    // per PIXEL rather than per column, so the distribution has no heavy ties — see the note
    // on the histogram's percentile convention in `cloud.ts`.
    const bright = flatFrame(2, (x, y) => 10 + (y * WIDTH + x) * 0.01);
    const dim = flatFrame(2, (x, y) => 1 + (y * WIDTH + x) * 0.002);
    const cloud = buildCloud([bright, dim], { confidence: { kind: "da3-per-frame" } });

    const [first, second] = cloud.frames;
    expect(first.threshold).toBeGreaterThan(second.threshold);

    // Each frame's own p40, against a real sort. The bound is the SAMPLE spacing, not the
    // histogram's bin width: 1,200 samples spread over 4,096 bins sit further apart than the
    // bins do, so quantising to a bin edge can only lose one sample step. A real frame has
    // 141,120 samples and the bound is the bin width instead — checked on the door fixture in
    // `cloud-gate.test.ts`.
    const confidence = bright.confidence as Float32Array;
    const sampleSpacing = 0.01;
    expect(Math.abs(first.threshold - percentileBySort(confidence, 40))).toBeLessThan(
      1.5 * sampleSpacing,
    );

    // Neither frame is wiped out: both keep roughly the 60% DA3's rule leaves behind.
    expect(first.kept / first.pixels).toBeGreaterThan(0.5);
    expect(second.kept / second.pixels).toBeGreaterThan(0.5);
  });

  it("wipes out the dim frame when one pooled threshold is used instead", () => {
    // The defect this whole task exists to remove, reproduced deliberately.
    const bright = flatFrame(2, (x) => 10 + (x / WIDTH) * 10);
    const dim = flatFrame(2, (x) => 1 + (x / WIDTH) * 2);
    const pooled = buildCloud([bright, dim], {
      confidence: { kind: "absolute", minConfidence: 9 },
    });
    expect(pooled.frames[0].kept).toBe(bright.width * bright.height);
    expect(pooled.frames[1].kept).toBe(0);
  });

  it("carries confidence into the cloud instead of dropping it at the door", () => {
    const cloud = buildCloud([flatFrame(2, (x) => 1 + x)], { confidence: { kind: "none" } });
    expect(cloud.confidence.length).toBe(cloud.pointCount);
    // Row-major, so the first row's confidences are 1, 2, 3 ... by construction.
    expect(cloud.confidence[0]).toBeCloseTo(1, 5);
    expect(cloud.confidence[5]).toBeCloseTo(6, 5);
  });

  it("normalises weights to a mean of 1, so support percentages keep their meaning", () => {
    for (const weight of ["rank", "linear", "none"] as const) {
      const cloud = buildCloud([flatFrame(2, (x) => 1 + x * 3)], {
        confidence: { kind: "none" },
        weight,
      });
      let total = 0;
      for (const value of cloud.weights) total += value;
      expect(total / cloud.weights.length).toBeCloseTo(1, 6);
    }
  });

  it("ranks a point inside its own frame, so one frame's scale cannot out-vote another's", () => {
    // Same rank structure, wildly different raw values. Rank weights must match; linear
    // weights must not — that difference is the reason rank is the default.
    const small = buildCloud([flatFrame(2, (x) => 1 + x * 0.01)], {
      confidence: { kind: "none" },
      weight: "rank",
    });
    const large = buildCloud([flatFrame(2, (x) => 1 + x * 100)], {
      confidence: { kind: "none" },
      weight: "rank",
    });
    for (let i = 0; i < 20; i++) {
      expect(large.weights[i]).toBeCloseTo(small.weights[i], 5);
    }
  });

  it("voxels down to one point per cell, uniformly in space", () => {
    // A flat wall 40x30 px at 2 m spans 0.8 m by 0.6 m. At 10 cm that is at most 9x7 cells.
    const cloud = buildCloud([flatFrame(2, () => 5)], {
      confidence: { kind: "none" },
      voxelM: 0.1,
    });
    expect(cloud.pointsBeforeVoxel).toBe(WIDTH * HEIGHT);
    expect(cloud.pointCount).toBeLessThanOrEqual(9 * 7);
    expect(cloud.pointCount).toBeGreaterThan(20);
    // Every survivor still sits on the wall — voxelling must not move a point off the surface.
    for (let i = 0; i < cloud.pointCount; i++) {
      expect(cloud.positions[i * 3 + 2]).toBeCloseTo(2, 6);
    }
  });

  it("reports what each frame contributed, including what the depth map could not give", () => {
    const frame = flatFrame(2, () => 5);
    (frame.depth as Float32Array)[0] = Number.NaN;
    (frame.depth as Float32Array)[1] = 0;
    // Edge filter off: a hole punched in the depth map is itself a discontinuity, and this
    // case is about counting what the depth map could give, not about edges.
    const cloud = buildCloud([frame], {
      confidence: { kind: "none" },
      maxRelativeDepthStep: 0,
    });
    expect(cloud.frames[0].pixels).toBe(WIDTH * HEIGHT);
    expect(cloud.frames[0].usable).toBe(WIDTH * HEIGHT - 2);
    expect(cloud.frames[0].edges).toBe(0);
    expect(cloud.frames[0].kept).toBe(WIDTH * HEIGHT - 2);
  });

  it("honours a depth bound, so a sky fill cannot reach the cloud", () => {
    const frame = flatFrame(2, () => 5);
    for (let i = 0; i < 100; i++) (frame.depth as Float32Array)[i] = 180;
    const cloud = buildCloud([frame], {
      confidence: { kind: "none" },
      maxDepthM: 50,
      maxRelativeDepthStep: 0,
    });
    expect(cloud.pointCount).toBe(WIDTH * HEIGHT - 100);
  });

  it("drops pixels straddling a depth edge, where foreground and background blend", () => {
    // A step: the left half at 2 m, the right half at 4 m. Only the pixels either side of the
    // seam are flying pixels; the flat regions must survive untouched.
    const frame = flatFrame(2, () => 5);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = WIDTH / 2; x < WIDTH; x++) (frame.depth as Float32Array)[y * WIDTH + x] = 4;
    }
    const kept = buildCloud([frame], { confidence: { kind: "none" }, maxRelativeDepthStep: 0 });
    const filtered = buildCloud([frame], { confidence: { kind: "none" } });
    expect(kept.pointCount).toBe(WIDTH * HEIGHT);
    // Two columns lost, one either side of the seam.
    expect(filtered.pointCount).toBe(WIDTH * HEIGHT - 2 * HEIGHT);
    expect(filtered.frames[0].edges).toBe(2 * HEIGHT);
    expect(filtered.frames[0].usable).toBe(WIDTH * HEIGHT);
  });

  it("applies the display transform to every point", () => {
    // Translate by 5 along x. Rigid, so distances between points must not change.
    const transform = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const plain = buildCloud([flatFrame(2, () => 5)], { confidence: { kind: "none" } });
    const moved = buildCloud([flatFrame(2, () => 5)], {
      confidence: { kind: "none" },
      transform,
    });
    expect(moved.positions[0]).toBeCloseTo(plain.positions[0] + 5, 5);
    expect(moved.positions[2]).toBeCloseTo(plain.positions[2], 5);
  });

  it("slices npz arrays into frames without copying them", () => {
    const count = 3;
    const size = WIDTH * HEIGHT;
    const depth = new Float32Array(count * size).fill(2);
    const confidence = new Float32Array(count * size).fill(5);
    const intrinsics = new Float32Array(count * 9);
    const extrinsics = new Float32Array(count * 12);
    for (let f = 0; f < count; f++) {
      intrinsics.set([100, 0, WIDTH / 2, 0, 100, HEIGHT / 2, 0, 0, 1], f * 9);
      extrinsics.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], f * 12);
    }
    const frames = framesFromArrays({
      depth: { shape: [count, HEIGHT, WIDTH], data: depth },
      confidence: { shape: [count, HEIGHT, WIDTH], data: confidence },
      intrinsics: { shape: [count, 3, 3], data: intrinsics },
      extrinsics: { shape: [count, 3, 4], data: extrinsics },
    });
    expect(frames).toHaveLength(count);
    expect(frames[0].width).toBe(WIDTH);
    expect(frames[0].height).toBe(HEIGHT);
    expect((frames[1].depth as Float32Array).buffer).toBe(depth.buffer);
  });
});
