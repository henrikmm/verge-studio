/**
 * Moving through the cloud with the keyboard.
 *
 * A trackpad makes orbiting a 3D scene a chore, so this adds the navigation a game would give
 * you: hold a key and travel. What it deliberately does NOT do is replace the orbit camera. The
 * keys translate the whole rig — the camera and the point it orbits, together — so dragging still
 * orbits exactly as before, now around whatever you have walked up to. A fly camera would have
 * meant giving that up, and orbiting an object is the right tool for looking at one.
 *
 * ## Which way is up is not a detail here
 *
 * DA3's exported scene is aligned to the FIRST CAMERA, not to gravity. Measured 2026-08-07 on the
 * fixtures: the scene's +Y axis sits 9.6° from true up on the door clip, 12.5° on the saved
 * outdoor run, and **33.2°** on the room clip. Walking along a +Y-based horizontal in that room
 * would climb or sink at a third of a right angle while looking level — the kind of wrongness that
 * feels like a broken control rather than a wrong assumption, so it would be hard to diagnose from
 * the symptom.
 *
 * `resolveUpAxis` therefore prefers evidence over convention, and reports which evidence it used
 * so the pane can say so out loud.
 *
 * Pure functions over plain numbers, tested without WebGL — same reason as `floor-overlay.ts`.
 */

import { basisFromUp, cross, dot, normalize, type Vec3 } from "../../../geometry";

/** Keys held down right now, lower-cased `KeyboardEvent.key` or the arrow names. */
export type HeldKeys = ReadonlySet<string>;

export type UpAxisSource =
  /** The fitted floor's own normal — the best evidence available, and what the floor is drawn on. */
  | "floor"
  /** Averaged camera-down across frames, DA3's only other handle on gravity. */
  | "camera"
  /** Nothing to go on. The scene's +Y, which is the first camera's up, not the world's. */
  | "scene";

export interface UpAxis {
  up: Vec3;
  source: UpAxisSource;
}

const SCENE_UP: Vec3 = [0, 1, 0];

/**
 * The floor's normal, else the camera-derived vertical, else the scene's +Y.
 *
 * Floor first because it is the one the viewport already draws its grid on: if walking used a
 * different up from the grid the operator is checking against, two correct things would disagree
 * on screen for no visible reason.
 *
 * `coherence` gates the camera fallback for the reason `geometry/gravity.ts` gives — a capture
 * that tumbled yields a confident-looking vector that is worthless. 0.7 is that module's own
 * stated threshold, not a new one invented here.
 */
export function resolveUpAxis(candidates: {
  floorNormal?: Vec3;
  cameraUp?: Vec3;
  coherence?: number;
}): UpAxis {
  const floor = candidates.floorNormal ? normalize(candidates.floorNormal) : null;
  if (floor) return { up: floor, source: "floor" };

  const camera = candidates.cameraUp ? normalize(candidates.cameraUp) : null;
  if (camera && (candidates.coherence ?? 0) >= 0.7) return { up: camera, source: "camera" };

  return { up: SCENE_UP, source: "scene" };
}

/**
 * How fast a key press moves you, in metres per second.
 *
 * Scaled by the scene rather than fixed, because the scenes differ by an order of magnitude: the
 * room fixture is about 3 m across and the saved outdoor run 24 m. One metre per second is a
 * sprint in the first and a crawl in the second. A fifth of the cloud's diagonal per second
 * crosses any scene in about five seconds, which is the same *felt* speed in both.
 */
export const BASE_SPEED_FRACTION = 0.2;

/** Multipliers on that base. Shift covers ground, Alt lines up on a door frame. */
export const FAST_MULTIPLIER = 4;
export const SLOW_MULTIPLIER = 0.2;

/** Radians per second of keyboard look. A full turn in four seconds at normal speed. */
export const TURN_RATE = Math.PI / 2;

/** How close to straight up or down the pitch may get, in radians. Stops the view flipping. */
export const PITCH_LIMIT = 0.02;

export interface NavIntent {
  /** Displacement of the whole rig this frame, in metres, display space. */
  move: Vec3;
  /** Rotation about the up axis this frame, radians. Positive turns left. */
  yaw: number;
  /** Rotation about the camera's right axis, radians. Positive looks up. */
  pitch: number;
  /** True when any navigation key is down, so the caller can skip the work entirely. */
  active: boolean;
}

const NOTHING: NavIntent = { move: [0, 0, 0], yaw: 0, pitch: 0, active: false };

export interface NavOptions {
  /** Unit vector the camera is looking along. */
  forward: Vec3;
  /** Unit up axis from `resolveUpAxis`. */
  up: Vec3;
  /** Seconds since the previous frame. */
  dt: number;
  /** Diagonal of the cloud's bounding box, in metres. */
  extent: number;
  /**
   * `false` keeps W and S level with the ground, which is what makes this feel like walking and
   * stops a downward glance from burying you in the floor. `true` follows the view instead, for
   * diving at something specific.
   */
  fly?: boolean;
}

/**
 * What the held keys ask for this frame.
 *
 * Everything is per SECOND and multiplied by elapsed time, never per key event. Per-event movement
 * would run at whatever rate the machine renders and would arrive in the operating system's
 * key-repeat stutter — a delay, then a burst — rather than smoothly.
 */
export function navigationIntent(keys: HeldKeys, options: NavOptions): NavIntent {
  const { dt, extent } = options;
  if (keys.size === 0 || !(dt > 0)) return NOTHING;

  const up = normalize(options.up);
  const forward = normalize(options.forward);
  if (!up || !forward) return NOTHING;

  const held = (...names: string[]) => names.some((name) => keys.has(name));
  const axis = (positive: string[], negative: string[]) =>
    (held(...positive) ? 1 : 0) - (held(...negative) ? 1 : 0);

  // Right is always horizontal — strafing that tilts with the view is disorienting, and is why
  // this is derived from the up axis rather than from the camera's own right vector.
  const right = normalize(cross(forward, up)) ?? basisFromUp(up).e1;

  // Walk mode projects the view direction onto the ground plane. Looking straight down leaves
  // nothing to project, so fall back to the horizontal axis perpendicular to `right`, which keeps
  // W meaning "the way I was facing" instead of stopping dead.
  const alongView = normalize(cross(up, right)) ?? forward;
  const walk = options.fly ? forward : alongView;

  const forwardInput = axis(["w"], ["s"]);
  const rightInput = axis(["d"], ["a"]);
  const upInput = axis(["e"], ["q"]);

  const speed =
    Math.max(1e-6, extent) *
    BASE_SPEED_FRACTION *
    (held("shift") ? FAST_MULTIPLIER : 1) *
    (held("alt") ? SLOW_MULTIPLIER : 1) *
    dt;

  const move: Vec3 = [
    (walk[0] * forwardInput + right[0] * rightInput + up[0] * upInput) * speed,
    (walk[1] * forwardInput + right[1] * rightInput + up[1] * upInput) * speed,
    (walk[2] * forwardInput + right[2] * rightInput + up[2] * upInput) * speed,
  ];

  const turn = TURN_RATE * dt * (held("shift") ? 2 : 1) * (held("alt") ? SLOW_MULTIPLIER : 1);
  const yaw = axis(["arrowleft"], ["arrowright"]) * turn;
  const pitch = axis(["arrowup"], ["arrowdown"]) * turn;

  return {
    move,
    yaw,
    pitch,
    active: forwardInput !== 0 || rightInput !== 0 || upInput !== 0 || yaw !== 0 || pitch !== 0,
  };
}

/** Every key this module consumes. The pane uses it to decide what to swallow. */
export const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "w", "a", "s", "d", "q", "e", "f",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
]);

const BY_CODE: Record<string, string> = {
  KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyQ: "q", KeyE: "e", KeyF: "f",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  ShiftLeft: "shift", ShiftRight: "shift", AltLeft: "alt", AltRight: "alt",
};

const BY_KEY: Record<string, string> = {
  w: "w", a: "a", s: "s", d: "d", q: "q", e: "e", f: "f",
  arrowup: "arrowup", arrowdown: "arrowdown", arrowleft: "arrowleft", arrowright: "arrowright",
  shift: "shift", alt: "alt",
};

/**
 * Which navigation key a press is, or null for one we do not use.
 *
 * Driven by `KeyboardEvent.code` — the key's POSITION — rather than `.key`, which reports the
 * character produced. On macOS that distinction is not academic: Option is the precision modifier
 * here, and Option+W reports `∑`, not `w`. Reading `.key` would therefore register the press and
 * never see the matching release, leaving the operator gliding forever with nothing held down.
 * Using positions also means the modifier and the letter cannot disagree about which key moved.
 *
 * `key` is consulted only when `code` is EMPTY, which is what synthetic senders produce —
 * automation, remote input, some on-screen keyboards. A press that carries a code we do not
 * recognise is a key we genuinely do not use, and must stay unclaimed. Ordering it this way keeps
 * the Option fix intact: macOS still reports `KeyW`, so the fallback never runs there.
 */
export function navigationKeyFor(code: string, key?: string): string | null {
  const byCode = BY_CODE[code];
  if (byCode) return byCode;
  if (code) return null;
  return BY_KEY[key?.toLowerCase() ?? ""] ?? null;
}

/**
 * How much pitch may still be applied before the view tips over its own pole.
 *
 * Orbit cameras are defined by an angle from the up axis, so pitching past vertical does not
 * continue smoothly — it flips the horizon. Clamping the REQUESTED rotation rather than the
 * resulting angle keeps the motion from stalling at the limit in a way that feels like a dropped
 * key press: you simply stop rising.
 */
export function clampPitch(polarAngle: number, requested: number): number {
  const next = polarAngle - requested;
  const clamped = Math.min(Math.PI - PITCH_LIMIT, Math.max(PITCH_LIMIT, next));
  return polarAngle - clamped;
}

/**
 * Rotate `vector` about `axis` by `radians` (Rodrigues). Used for keyboard yaw, where the whole
 * camera-to-target offset turns about the true up rather than about the scene's +Y.
 */
export function rotateAbout(vector: Vec3, axis: Vec3, radians: number): Vec3 {
  const k = normalize(axis);
  if (!k || radians === 0) return vector;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const kv = cross(k, vector);
  const kd = dot(k, vector) * (1 - cos);
  return [
    vector[0] * cos + kv[0] * sin + k[0] * kd,
    vector[1] * cos + kv[1] * sin + k[1] * kd,
    vector[2] * cos + kv[2] * sin + k[2] * kd,
  ];
}
