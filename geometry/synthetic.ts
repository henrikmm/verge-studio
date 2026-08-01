/**
 * Synthetic scenes with exactly known answers.
 *
 * Used by the tests only (not re-exported from `index.ts`). Testing geometry against a
 * real fixture cannot distinguish "our maths is wrong" from "the reconstruction is bad";
 * a synthetic room where the floor is at exactly 0 and the table top at exactly 0.75 can.
 *
 * The default room is built to be ADVERSARIAL in the specific way we measured on real
 * data: the walls carry more points than the floor, so a fitter that ranks planes by
 * support alone will pick a wall, and the ceiling is horizontal too, so one that ignores
 * elevation will pick the ceiling.
 */

import { normalize, type Vec3 } from "./types";

export interface SyntheticRoom {
  /** Flat xyz, in the (possibly rotated) world frame. */
  points: Float32Array;
  /** Per-point confidence, 1 everywhere unless `decoyConfidence` lowered it. */
  confidence: Float32Array;
  /** Ground-truth up axis in the same frame. */
  up: Vec3;
  /** Points belonging to the table, as a flat xyz array. */
  tablePoints: Float32Array;
  /** Exact heights the fitter should recover. */
  truth: { floorElevation: number; tableHeight: number; ceilingHeight: number };
}

export interface SyntheticRoomOptions {
  /** Gaussian-ish noise amplitude on every point, metres. */
  noise?: number;
  /** Rotate the whole scene, so nothing is axis-aligned. */
  rotate?: boolean;
  /** Include the ceiling (a second, higher horizontal plane). */
  ceiling?: boolean;
  /** Include the floor. Off = "no floor visible". */
  floor?: boolean;
  /** Include the table. Off with `floor: false` = no horizontal surface at all. */
  table?: boolean;
  tableHeight?: number;
  seed?: number;
}

function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotation about a fixed, deliberately awkward axis — nothing lands on an axis plane. */
function rotation(): (p: Vec3) => Vec3 {
  const axis = normalize([0.37, 0.55, -0.75]) as Vec3;
  const angle = 0.7;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return (p: Vec3): Vec3 => {
    // Rodrigues.
    const dotAP = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
    const crossAP: Vec3 = [
      axis[1] * p[2] - axis[2] * p[1],
      axis[2] * p[0] - axis[0] * p[2],
      axis[0] * p[1] - axis[1] * p[0],
    ];
    return [
      p[0] * c + crossAP[0] * s + axis[0] * dotAP * (1 - c),
      p[1] * c + crossAP[1] * s + axis[1] * dotAP * (1 - c),
      p[2] * c + crossAP[2] * s + axis[2] * dotAP * (1 - c),
    ];
  };
}

export function syntheticRoom(options: SyntheticRoomOptions = {}): SyntheticRoom {
  const noise = options.noise ?? 0;
  const tableHeight = options.tableHeight ?? 0.75;
  const ceilingHeight = 2.5;
  const random = makeRandom(options.seed ?? 7);
  const jitter = () => (noise > 0 ? (random() - 0.5) * 2 * noise : 0);

  const canonical: Vec3[] = [];
  const table: Vec3[] = [];

  // Floor at y = 0, deliberately SPARSE: a walkthrough sees the floor at a grazing angle.
  if (options.floor !== false) {
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        canonical.push([-2 + (4 * i) / 39, 0, -2 + (4 * j) / 39]);
      }
    }
  }

  // Two walls, DENSER than the floor. This is the trap: ranked by support alone, a wall
  // wins — which is exactly what plain RANSAC did on the real fixture.
  for (const x of [-2, 2]) {
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        canonical.push([x, (ceilingHeight * i) / 59, -2 + (4 * j) / 59]);
      }
    }
  }

  // Ceiling: horizontal too, so orientation alone cannot pick the floor.
  if (options.ceiling !== false) {
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 50; j++) {
        canonical.push([-2 + (4 * i) / 49, ceilingHeight, -2 + (4 * j) / 49]);
      }
    }
  }

  // A table: top face plus legs, standing on the floor.
  if (options.table !== false) {
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        const p: Vec3 = [-0.5 + i / 29, tableHeight, -0.4 + (0.8 * j) / 29];
        table.push(p);
      }
    }
    for (let i = 0; i < 20; i++) {
      table.push([-0.45, (tableHeight * i) / 19, -0.35]);
      table.push([0.45, (tableHeight * i) / 19, 0.35]);
    }
  }

  const transform = options.rotate ? rotation() : (p: Vec3) => p;
  const all = [...canonical, ...table];

  const points = new Float32Array(all.length * 3);
  const confidence = new Float32Array(all.length).fill(1);
  for (const [i, p] of all.entries()) {
    const moved = transform([p[0] + jitter(), p[1] + jitter(), p[2] + jitter()]);
    points[i * 3] = moved[0];
    points[i * 3 + 1] = moved[1];
    points[i * 3 + 2] = moved[2];
  }

  const tablePoints = new Float32Array(table.length * 3);
  for (const [i, p] of table.entries()) {
    const moved = transform(p);
    tablePoints[i * 3] = moved[0];
    tablePoints[i * 3 + 1] = moved[1];
    tablePoints[i * 3 + 2] = moved[2];
  }

  return {
    points,
    confidence,
    up: transform([0, 1, 0]),
    tablePoints,
    truth: { floorElevation: 0, tableHeight, ceilingHeight },
  };
}
