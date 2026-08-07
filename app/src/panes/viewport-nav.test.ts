/**
 * The maths behind keyboard navigation.
 *
 * Worth pinning because the two ways this can be wrong are both invisible in a screenshot. A
 * movement that is not scaled by elapsed time looks correct on the machine it was written on and
 * runs at a different speed everywhere else; and walking along the SCENE's +Y instead of the
 * measured up climbs 33.2° on the room fixture while the horizon still looks level. Neither shows
 * up as an error — they show up as a control that feels bad, which is much harder to trace back.
 */

import { describe, expect, it } from "vitest";
import {
  BASE_SPEED_FRACTION,
  FAST_MULTIPLIER,
  PITCH_LIMIT,
  SLOW_MULTIPLIER,
  clampPitch,
  navigationIntent,
  navigationKeyFor,
  resolveUpAxis,
  rotateAbout,
  type HeldKeys,
} from "./viewport-nav";
import { dot, length, normalize, type Vec3 } from "../../../geometry";

const keys = (...held: string[]): HeldKeys => new Set(held);

/** A camera looking along -Z in a y-up scene: the case that is easiest to check by hand. */
const BASE = { forward: [0, 0, -1] as Vec3, up: [0, 1, 0] as Vec3, dt: 1, extent: 10 };

/** The room fixture's measured up, 33.2° from the scene's +Y. See `viewport-nav.ts`. */
const ROOM_UP = normalize([-0.12, 0.837, 0.534]) as Vec3;

describe("resolveUpAxis", () => {
  it("prefers the fitted floor, so walking agrees with the grid drawn on screen", () => {
    const axis = resolveUpAxis({ floorNormal: [0, 0, 1], cameraUp: [0, 1, 0], coherence: 0.95 });
    expect(axis.source).toBe("floor");
    expect(axis.up).toEqual([0, 0, 1]);
  });

  it("falls back to the camera path when there is no floor", () => {
    const axis = resolveUpAxis({ cameraUp: [0, 2, 0], coherence: 0.9 });
    expect(axis.source).toBe("camera");
    // Normalised, so callers never have to wonder whether it is a unit vector.
    expect(axis.up).toEqual([0, 1, 0]);
  });

  it("refuses an incoherent camera vertical rather than trusting a tumbled capture", () => {
    const axis = resolveUpAxis({ cameraUp: [0.3, 0.9, 0.1], coherence: 0.4 });
    expect(axis.source).toBe("scene");
    expect(axis.up).toEqual([0, 1, 0]);
  });

  it("says it is guessing when it has nothing to go on", () => {
    expect(resolveUpAxis({}).source).toBe("scene");
  });
});

describe("navigationIntent", () => {
  it("does nothing at all when no key is held", () => {
    expect(navigationIntent(keys(), BASE).active).toBe(false);
  });

  it("walks along the view direction", () => {
    const { move } = navigationIntent(keys("w"), BASE);
    expect(move[2]).toBeLessThan(0);
    expect(Math.abs(move[0])).toBeLessThan(1e-12);
  });

  it("puts S exactly opposite W, and cancels when both are held", () => {
    const ahead = navigationIntent(keys("w"), BASE).move;
    const back = navigationIntent(keys("s"), BASE).move;
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(-ahead[i], 12);
    expect(navigationIntent(keys("w", "s"), BASE).active).toBe(false);
  });

  it("strafes perpendicular to both the view and the up axis", () => {
    const { move } = navigationIntent(keys("d"), BASE);
    expect(dot(move, BASE.forward)).toBeCloseTo(0, 12);
    expect(dot(move, BASE.up)).toBeCloseTo(0, 12);
    // D is to the RIGHT of a camera looking down -Z, which is +X.
    expect(move[0]).toBeGreaterThan(0);
  });

  it("keeps walking level in a scene whose up is not the scene's +Y", () => {
    // The room fixture case. Every horizontal move must stay in the real ground plane, so a
    // walk cannot gain or lose height no matter which way the camera happens to point.
    for (const key of ["w", "s", "a", "d"]) {
      for (const forward of [[0, 0, -1], [0.5, -0.8, 0.3], [-0.2, 0.9, 0.4]] as Vec3[]) {
        const { move } = navigationIntent(keys(key), { ...BASE, forward, up: ROOM_UP });
        expect(dot(move, ROOM_UP)).toBeCloseTo(0, 9);
      }
    }
  });

  it("moves straight up and down along the measured vertical, not the scene's", () => {
    const { move } = navigationIntent(keys("e"), { ...BASE, up: ROOM_UP });
    const direction = normalize(move) as Vec3;
    for (let i = 0; i < 3; i++) expect(direction[i]).toBeCloseTo(ROOM_UP[i], 9);
  });

  it("still walks when looking straight down, instead of stalling", () => {
    // The projection of the view onto the ground is zero here; the fallback keeps a direction.
    const { move } = navigationIntent(keys("w"), { ...BASE, forward: [0, -1, 0] });
    expect(length(move)).toBeGreaterThan(0);
    expect(dot(move, BASE.up)).toBeCloseTo(0, 9);
  });

  it("flies along the view when asked, including its vertical component", () => {
    const forward = normalize([0, -1, -1]) as Vec3;
    const { move } = navigationIntent(keys("w"), { ...BASE, forward, fly: true });
    expect(dot(move, BASE.up)).toBeLessThan(0);
  });

  it("scales with elapsed time, so speed does not depend on the machine", () => {
    const slow = navigationIntent(keys("w"), { ...BASE, dt: 1 / 30 }).move;
    const fast = navigationIntent(keys("w"), { ...BASE, dt: 1 / 60 }).move;
    expect(length(slow)).toBeCloseTo(length(fast) * 2, 12);
  });

  it("crosses any scene at the same felt speed, whatever its size", () => {
    for (const extent of [3, 24, 400]) {
      const { move } = navigationIntent(keys("w"), { ...BASE, extent, dt: 1 });
      expect(length(move)).toBeCloseTo(extent * BASE_SPEED_FRACTION, 9);
    }
  });

  it("applies Shift and Alt as the documented multipliers", () => {
    const plain = length(navigationIntent(keys("w"), BASE).move);
    expect(length(navigationIntent(keys("w", "shift"), BASE).move)).toBeCloseTo(
      plain * FAST_MULTIPLIER,
      9,
    );
    expect(length(navigationIntent(keys("w", "alt"), BASE).move)).toBeCloseTo(
      plain * SLOW_MULTIPLIER,
      9,
    );
  });

  it("turns and looks with the arrow keys, and cancels opposites", () => {
    expect(navigationIntent(keys("arrowleft"), BASE).yaw).toBeGreaterThan(0);
    expect(navigationIntent(keys("arrowright"), BASE).yaw).toBeLessThan(0);
    expect(navigationIntent(keys("arrowup"), BASE).pitch).toBeGreaterThan(0);
    expect(navigationIntent(keys("arrowleft", "arrowright"), BASE).active).toBe(false);
  });

  it("survives a degenerate up axis instead of emitting NaNs into the camera", () => {
    const intent = navigationIntent(keys("w"), { ...BASE, up: [0, 0, 0] });
    expect(intent.active).toBe(false);
    for (const value of intent.move) expect(Number.isFinite(value)).toBe(true);
  });

  it("ignores a zero or negative frame time", () => {
    expect(navigationIntent(keys("w"), { ...BASE, dt: 0 }).active).toBe(false);
    expect(navigationIntent(keys("w"), { ...BASE, dt: -0.5 }).active).toBe(false);
  });
});

describe("navigationKeyFor", () => {
  it("maps the movement keys by their position on the keyboard", () => {
    expect(navigationKeyFor("KeyW")).toBe("w");
    expect(navigationKeyFor("KeyD")).toBe("d");
    expect(navigationKeyFor("ArrowLeft")).toBe("arrowleft");
  });

  it("treats both Shift and both Alt keys as the same modifier", () => {
    expect(navigationKeyFor("ShiftLeft")).toBe("shift");
    expect(navigationKeyFor("ShiftRight")).toBe("shift");
    expect(navigationKeyFor("AltLeft")).toBe("alt");
    expect(navigationKeyFor("AltRight")).toBe("alt");
  });

  it("ignores keys this pane has no business swallowing", () => {
    for (const code of ["KeyZ", "Backspace", "Escape", "Space", "Digit1", ""]) {
      expect(navigationKeyFor(code)).toBeNull();
    }
  });

  it("still identifies W while Alt is held, which is where `.key` would fail", () => {
    // macOS turns Option+W into "∑". A press keyed on the character would never be released.
    expect(navigationKeyFor("KeyW", "∑")).toBe("w");
    expect(navigationKeyFor("∑")).toBeNull();
  });

  it("falls back to the character only when no code was sent at all", () => {
    // Synthetic senders — automation, remote input, on-screen keyboards — leave `code` empty.
    expect(navigationKeyFor("", "f")).toBe("f");
    expect(navigationKeyFor("", "ArrowLeft")).toBe("arrowleft");
    expect(navigationKeyFor("", "Shift")).toBe("shift");
    expect(navigationKeyFor("", "z")).toBeNull();
    // A real press carrying an unused code is a key we do not want, whatever it typed.
    expect(navigationKeyFor("KeyZ", "w")).toBeNull();
  });
});

describe("clampPitch", () => {
  it("passes a rotation through untouched away from the poles", () => {
    expect(clampPitch(Math.PI / 2, 0.1)).toBeCloseTo(0.1, 12);
  });

  it("stops short of straight up rather than flipping the horizon", () => {
    const applied = clampPitch(0.05, 1);
    expect(0.05 - applied).toBeCloseTo(PITCH_LIMIT, 12);
  });

  it("stops short of straight down too", () => {
    const applied = clampPitch(Math.PI - 0.05, -1);
    expect(Math.PI - 0.05 - applied).toBeCloseTo(Math.PI - PITCH_LIMIT, 12);
  });
});

describe("rotateAbout", () => {
  it("turns a quarter circle about the up axis", () => {
    const turned = rotateAbout([0, 0, -1], [0, 1, 0], Math.PI / 2);
    expect(turned[0]).toBeCloseTo(-1, 9);
    expect(turned[2]).toBeCloseTo(0, 9);
  });

  it("preserves length and leaves the axis itself alone", () => {
    const axis = ROOM_UP;
    expect(length(rotateAbout([3, -1, 2], axis, 0.7))).toBeCloseTo(length([3, -1, 2]), 9);
    const spun = rotateAbout(axis, axis, 1.2);
    for (let i = 0; i < 3; i++) expect(spun[i]).toBeCloseTo(axis[i], 9);
  });
});
