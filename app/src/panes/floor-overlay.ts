/**
 * The pictures that let a person judge a fitted floor.
 *
 * Support, tilt and RMSE all answer "how well does this plane fit the points it chose". None of
 * them answers "did it choose the right points", and that is the failure that costs a measurement:
 * a plane slicing diagonally across a room fits its own inliers beautifully. A visibly wrong floor
 * once hid behind a 2 cm RMSE here, and it was a person looking at the screen who caught it.
 *
 * So these three drawings are chosen for what the eye is good at and the numbers are not:
 *
 *   1. A metric GRID rather than a filled disc. Straight lines converge in perspective and a flat
 *      translucent fill does not, so the grid is what makes "is this level, and does it sit at the
 *      base of the walls" answerable at a glance. Its squares are a known size, so it doubles as a
 *      ruler against which the scene's scale can be sanity-checked.
 *   2. Both UP AXES as arrows from the same origin. The fit reports its disagreement with the
 *      camera-derived vertical as a number of degrees; two arrows make that disagreement a shape.
 *   3. The points BELOW the plane. This is the definition of ground drawn directly — "the surface
 *      with almost nothing beneath it" — and it is the one test that separates a real floor from a
 *      mid-scene plane cleanly: 4.3% below the true floor of the room fixture against 60.6% below
 *      the wrong one.
 *
 * Pure functions over plain arrays wherever the maths lives, so the parts that can be wrong are
 * tested without standing up WebGL.
 */

import * as THREE from "three";
import { basisFromUp, signedHeight, type Plane, type Vec3 } from "../../../geometry";

/**
 * Metres between grid lines, from a rounded set a person can actually reckon with.
 *
 * A grid is only a ruler if its spacing is a number you can hold in your head — 0.5 m, not
 * 0.437 m — so the spacing is chosen from a fixed ladder rather than computed from the radius.
 * Aiming for roughly a dozen divisions keeps a small indoor patch legible without turning a large
 * outdoor one into a solid sheet of lines.
 */
const GRID_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50] as const;
const TARGET_DIVISIONS = 12;

export function chooseGridSpacing(radius: number): number {
  const target = (Math.max(0, radius) * 2) / TARGET_DIVISIONS;
  return GRID_STEPS.find((step) => step >= target) ?? GRID_STEPS[GRID_STEPS.length - 1];
}

/**
 * A square grid on the plane, clipped to a circle of `radius` about `center`.
 *
 * Circular rather than square because the disc it replaces was already clipped to the extent of
 * its own supporting evidence — a deliberate earlier fix, after a floor drawn far wider than the
 * points backing it made ordinary tilt look like a plane projected outside the cloud.
 *
 * Returns a flat xyz array of line-segment endpoints, two points per segment.
 */
export function buildGridSegments(
  plane: Plane,
  center: Vec3,
  radius: number,
  spacing: number,
): Float32Array {
  const out: number[] = [];
  if (!(radius > 0) || !(spacing > 0)) return Float32Array.from(out);

  // The grid lies IN the plane, so its basis comes from the plane's own normal rather than from
  // gravity. Using the gravity up here would draw a level grid through a tilted floor and hide the
  // very disagreement the overlay exists to show.
  const { e1, e2 } = basisFromUp(plane.normal);

  // Drop the origin onto the plane rather than trusting it to be there. Today's caller does
  // project its centre, but a grid floating a few centimetres off its own plane is invisible as a
  // bug and reads as a real offset in the fit — so the guarantee belongs here, not in the caller.
  const drop = signedHeight(plane, center);
  const origin: Vec3 = [
    center[0] - plane.normal[0] * drop,
    center[1] - plane.normal[1] * drop,
    center[2] - plane.normal[2] * drop,
  ];
  const at = (u: number, v: number): Vec3 => [
    origin[0] + u * e1[0] + v * e2[0],
    origin[1] + u * e1[1] + v * e2[1],
    origin[2] + u * e1[2] + v * e2[2],
  ];

  const steps = Math.floor(radius / spacing);
  for (let i = -steps; i <= steps; i++) {
    const offset = i * spacing;
    // Chord half-length at this offset, so every line stops exactly on the circle.
    const half = Math.sqrt(Math.max(0, radius * radius - offset * offset));
    if (half <= 0) continue;
    out.push(...at(offset, -half), ...at(offset, half));
    out.push(...at(-half, offset), ...at(half, offset));
  }
  return Float32Array.from(out);
}

/**
 * The points sitting under the plane.
 *
 * `tolerance` defaults to the same 5 cm the fit's own `belowFraction` uses, so what is drawn and
 * what is reported are the same test. If the picture and the number could disagree, the number
 * would stop being evidence for the picture.
 */
export function collectPointsBelow(
  positions: ArrayLike<number>,
  plane: Plane,
  tolerance = 0.05,
): Float32Array {
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const point: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
    if (signedHeight(plane, point) < -tolerance) out.push(point[0], point[1], point[2]);
  }
  return Float32Array.from(out);
}

/**
 * Dispose a whole subtree, not just its root.
 *
 * `ArrowHelper` is an `Object3D` holding a Line and a Mesh, so the pane's original
 * dispose-the-child loop would have walked straight past both of its buffers and leaked them on
 * every re-render.
 *
 * Textures are disposed alongside the material that carries them. `Material.dispose()` does not
 * touch them — it cannot know whether a texture is shared — and the evidence labels mint a fresh
 * canvas texture per rebuild, which is once per click in the trial list.
 */
export function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const drawable = node as Partial<THREE.Mesh>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (!material) return;
    for (const item of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(item)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      item.dispose();
    }
  });
}
