/**
 * The typed half of the inspector, gathered in one place.
 *
 * The inspector is plain JavaScript so it starts instantly and depends on nothing, but the
 * things it inspects — the ground fit, the gravity estimate, the depth arrays, the colour map —
 * are TypeScript that the app and the tests already use. Re-implementing any of them here would
 * create the one failure this tool must never have: an inspector that disagrees with the thing
 * it is inspecting, and is therefore trusted while being wrong.
 *
 * So nothing is written here. This file only re-exports, and `typed.mjs` compiles it on demand.
 * If a number the inspector prints ever needs new code, that code belongs in `geometry/` with a
 * test, and its name belongs on this list.
 */

export { parseNpz, type NpyArray } from "../../app/src/lib/npz";
export { turbo } from "../../app/src/lib/turbo";
export { resolveUpAxis } from "../../app/src/panes/viewport-nav";

export { backprojectFrame } from "../../geometry/backproject";
export { estimateGravity, cameraCentres, trajectorySpan } from "../../geometry/gravity";
export {
  GroundPlaneNotFoundError,
  fitGroundPlane,
  fitGroundPlaneRobust,
  groundPlaneQuality,
} from "../../geometry/plane";
export { horizontalLevels, levelNear, type Level } from "../../geometry/levels";
export {
  heightsAbovePlane,
  median,
  nmad,
  percentile,
  percentileOfSorted,
} from "../../geometry/measure";
export {
  angleBetweenDeg,
  basisFromUp,
  cross,
  dot,
  normalize,
  planeElevationAt,
  signedHeight,
  type Plane,
  type Vec3,
} from "../../geometry/types";
