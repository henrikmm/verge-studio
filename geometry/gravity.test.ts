/**
 * Gravity is recovered from camera poses because a video-only pipeline has no IMU.
 * The estimate is only as good as the assumption that the operator held the phone
 * roughly upright — so the coherence score matters as much as the direction, and these
 * cases pin both.
 */

import { describe, expect, it } from "vitest";
import { cameraCentres, estimateGravity, trajectorySpan } from "./gravity";
import { angleBetweenDeg, type Vec3 } from "./types";

/**
 * Build world→camera extrinsics from the camera's world-space axes.
 * Rows of R are the camera axes in world coordinates; OpenCV's +Y is DOWN the image.
 */
function extrinsicsFrom(right: Vec3, down: Vec3, forward: Vec3, t: Vec3): number[] {
  return [
    right[0], right[1], right[2], t[0],
    down[0], down[1], down[2], t[1],
    forward[0], forward[1], forward[2], t[2],
  ];
}

const UPRIGHT = () => extrinsicsFrom([1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, 0]);

describe("estimateGravity", () => {
  it("recovers up from an upright camera", () => {
    const { up, coherence, frameCount } = estimateGravity(Float32Array.from(UPRIGHT()));
    expect(angleBetweenDeg(up, [0, 1, 0])).toBeLessThan(1e-6);
    expect(coherence).toBeCloseTo(1, 6);
    expect(frameCount).toBe(1);
  });

  it("reports perfect coherence when every frame agrees", () => {
    const frames = Float32Array.from([...UPRIGHT(), ...UPRIGHT(), ...UPRIGHT()]);
    const { coherence, frameCount } = estimateGravity(frames);
    expect(coherence).toBeCloseTo(1, 6);
    expect(frameCount).toBe(3);
  });

  it("averages out handheld wobble and still points up", () => {
    const values: number[] = [];
    for (let i = 0; i < 20; i++) {
      // Roll the camera a few degrees either side of upright, as a walking hand does.
      const angle = ((i % 5) - 2) * 0.05;
      const down: Vec3 = [Math.sin(angle), -Math.cos(angle), 0];
      const right: Vec3 = [Math.cos(angle), Math.sin(angle), 0];
      values.push(...extrinsicsFrom(right, down, [0, 0, 1], [0, 0, 0]));
    }
    const { up, coherence } = estimateGravity(Float32Array.from(values));
    expect(angleBetweenDeg(up, [0, 1, 0])).toBeLessThan(2);
    // Wobbling costs a little coherence, which is exactly what the number is for.
    expect(coherence).toBeGreaterThan(0.99);
    expect(coherence).toBeLessThan(1);
  });

  it("reports LOW coherence for a tumbling capture, instead of a confident wrong answer", () => {
    const values = [
      ...extrinsicsFrom([1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, 0]),
      ...extrinsicsFrom([0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 0, 0]),
      ...extrinsicsFrom([0, 0, 1], [0, 0, -1], [1, 0, 0], [0, 0, 0]),
    ];
    const { coherence } = estimateGravity(Float32Array.from(values));
    expect(coherence).toBeLessThan(0.7);
  });

  it("throws when the down axes cancel exactly — no up exists to report", () => {
    const values = [
      ...extrinsicsFrom([1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, 0]),
      ...extrinsicsFrom([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]),
    ];
    expect(() => estimateGravity(Float32Array.from(values))).toThrow(/no consistent orientation/);
  });

  it("rejects a badly shaped extrinsics array rather than reading garbage", () => {
    expect(() => estimateGravity(new Float32Array(11))).toThrow(/\(N,3,4\)/);
    expect(() => estimateGravity(new Float32Array(0))).toThrow(/\(N,3,4\)/);
  });

  it("matches the real fixture's measured coherence sign convention", () => {
    // The measured up on fixtures/room/504px-112f is (0.101, -0.903, -0.418): mostly
    // -Y. A camera whose down axis is +Y-ish must therefore yield a -Y-ish up.
    const values = extrinsicsFrom([1, 0, 0], [-0.101, 0.903, 0.418], [0, 0, 1], [0, 0, 0]);
    const { up } = estimateGravity(Float32Array.from(values));
    expect(up[1]).toBeLessThan(0);
  });
});

describe("cameraCentres", () => {
  it("recovers the camera position from world→camera extrinsics", () => {
    // With C the camera centre, t = -R·C. Build t for a known C and read it back.
    const centre: Vec3 = [1.5, -0.4, 2.25];
    const right: Vec3 = [1, 0, 0];
    const down: Vec3 = [0, -1, 0];
    const forward: Vec3 = [0, 0, 1];
    const t: Vec3 = [
      -(right[0] * centre[0] + right[1] * centre[1] + right[2] * centre[2]),
      -(down[0] * centre[0] + down[1] * centre[1] + down[2] * centre[2]),
      -(forward[0] * centre[0] + forward[1] * centre[1] + forward[2] * centre[2]),
    ];
    const [recovered] = cameraCentres(Float32Array.from(extrinsicsFrom(right, down, forward, t)));
    expect(recovered[0]).toBeCloseTo(centre[0], 5);
    expect(recovered[1]).toBeCloseTo(centre[1], 5);
    expect(recovered[2]).toBeCloseTo(centre[2], 5);
  });
});

describe("trajectorySpan", () => {
  it("measures the extent of a walked path", () => {
    const span = trajectorySpan([
      [0, 0, 0],
      [1.26, 0.5, -1.0],
      [0.3, 1.28, 0.69],
    ]);
    expect(span[0]).toBeCloseTo(1.26, 6);
    expect(span[1]).toBeCloseTo(1.28, 6);
    expect(span[2]).toBeCloseTo(1.69, 6);
  });

  it("reports zero for a pan from a fixed point — the no-parallax case DA3 cannot use", () => {
    expect(trajectorySpan([[1, 2, 3], [1, 2, 3], [1, 2, 3]])).toEqual([0, 0, 0]);
  });

  it("handles an empty path", () => {
    expect(trajectorySpan([])).toEqual([0, 0, 0]);
  });
});
