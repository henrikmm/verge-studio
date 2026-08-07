/**
 * Why the fitted floor is, or is not, on the wire.
 *
 * `resolveCurrentInput` returns null for four different reasons, and until 2026-08-07 Viewport 3D
 * rendered all four identically — as an unchanged viewport. A fit that FAILED looked exactly like
 * a fit that was fine, because the only thing distinguishing them was the absence of a faint disc
 * that most of the time you were not looking for anyway.
 *
 * That is the worst confusion this pane can produce in an unfamiliar room, where the ground fit is
 * both the step most likely to break and the one whose failure the numbers hide: support, tilt and
 * RMSE all describe how well the plane fits the points it chose, and none of them describes whether
 * it chose the right points. Naming the state costs one line of text and removes the ambiguity.
 *
 * Lives outside `viewport-3d.tsx` so it can be tested without standing up WebGL.
 */

import { isNodeStale, resolveCurrentInput, type GraphStoreState } from "../graph/graph-store";
import { VIEWER_3D_ID, type GroundPlaneValue } from "../graph/nodes";

export type FloorState =
  /** A current fit, safe to draw and safe to quote. */
  | { kind: "ok"; ground: GroundPlaneValue }
  /** A held fit that no longer matches its inputs. Reported, deliberately not drawn. */
  | { kind: "stale" }
  /** The fit ran and refused. Its own message is the most useful thing the pane can say. */
  | { kind: "failed"; message: string }
  /** Nothing is wired to the plane input, or nothing upstream has produced one yet. */
  | { kind: "absent" };

/**
 * The source node is found through the edge rather than hardcoded to `GROUND_PLANE_ID`, so
 * rewiring the plane input keeps reporting the truth about whatever now feeds it. The graph is
 * the program; a pane that assumed its own wiring would quietly lie the moment you changed it.
 */
export function readFloorState(graph: GraphStoreState): FloorState {
  const edge = graph.edges.find(
    (candidate) => candidate.target === VIEWER_3D_ID && candidate.targetPort === "plane",
  );
  if (!edge) return { kind: "absent" };

  const runtime = graph.runtime[edge.source];
  if (runtime?.status === "error") {
    return { kind: "failed", message: runtime.error ?? "the ground fit failed" };
  }

  const value = resolveCurrentInput(graph, VIEWER_3D_ID, "plane")?.value as
    | GroundPlaneValue
    | undefined;
  if (value) return { kind: "ok", ground: value };

  // Held outputs that no longer match their inputs. The geometry stays hidden — a stale plane
  // must never be read as a current measurement — but the pane says so rather than going blank.
  if (runtime?.outputs && isNodeStale(graph, edge.source)) return { kind: "stale" };
  return { kind: "absent" };
}
