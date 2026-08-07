/**
 * The four states Viewport 3D can be in about the floor.
 *
 * Pinned here rather than in the browser because only two of them are reachable by hand. "Stale"
 * takes a parameter edit with the re-run withheld, and "failed" needs a fit that genuinely refuses
 * — which the door fixture will not do on request: driven to a 1 cm inlier band with a 10° tilt
 * gate it still returned a floor, at 4.7% support. A state that is hard to provoke is exactly the
 * one that ships broken, and it is the one that matters most in an unfamiliar room.
 *
 * The distinction under test is not cosmetic. Before 2026-08-07 every one of these rendered as an
 * unchanged viewport, so "the fit refused" and "the fit is fine" were the same picture.
 */

import { describe, expect, it } from "vitest";
import { readFloorState } from "./floor-state";
import type { GraphStoreState } from "../graph/graph-store";
import { defaultGraph, GROUND_PLANE_ID, VIEWER_3D_ID } from "../graph/nodes";
import { emptyRuntime, type NodeRuntime } from "../graph/types";

const { nodes, edges } = defaultGraph();

/** Stands in for a real fit. `readFloorState` passes the value through without inspecting it. */
const PLANE_VALUE = { plane: { normal: [0, 1, 0], offset: -1 } } as never;

function graphWith(runtime: NodeRuntime, desiredKey = "key-1"): GraphStoreState {
  return {
    nodes,
    edges,
    runtime: { [GROUND_PLANE_ID]: runtime },
    desiredKeys: { [GROUND_PLANE_ID]: desiredKey },
    selectedId: null,
    selectedEdgeId: null,
    running: false,
    error: null,
  };
}

const held = (heldKey: string): NodeRuntime => ({
  status: "ok",
  heldKey,
  outputs: { plane: { type: "plane", value: PLANE_VALUE, summary: "" } },
  elapsedMs: 12,
  error: null,
});

describe("readFloorState", () => {
  it("reports a current fit as ok, and hands back the value the pane draws", () => {
    const state = readFloorState(graphWith(held("key-1"), "key-1"));
    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" && state.ground).toBe(PLANE_VALUE);
  });

  it("reports a held fit whose inputs have moved as stale, not as ok", () => {
    // The held key no longer matches what the node's configuration wants.
    expect(readFloorState(graphWith(held("key-1"), "key-2")).kind).toBe("stale");
  });

  it("carries the fit's own refusal message, which is the useful part", () => {
    const state = readFloorState(
      graphWith({
        status: "error",
        heldKey: null,
        outputs: null,
        elapsedMs: 30,
        error: "the best horizontal candidate has 61% of the cloud BELOW it",
      }),
    );
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toContain("61% of the cloud BELOW it");
  });

  it("still reports a failure when the node recorded no message", () => {
    const state = readFloorState(
      graphWith({ status: "error", heldKey: null, outputs: null, elapsedMs: 30, error: null }),
    );
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message.length).toBeGreaterThan(0);
  });

  it("treats a node that has never produced anything as absent, not as a failure", () => {
    // Blocked by an upstream node rather than broken — there is nothing to warn about.
    expect(readFloorState(graphWith(emptyRuntime())).kind).toBe("absent");
    expect(
      readFloorState(graphWith({ ...emptyRuntime(), status: "blocked" })).kind,
    ).toBe("absent");
  });

  it("is absent when nothing is wired to the plane input at all", () => {
    const unwired: GraphStoreState = {
      ...graphWith(held("key-1"), "key-1"),
      edges: edges.filter((e) => !(e.target === VIEWER_3D_ID && e.targetPort === "plane")),
    };
    expect(readFloorState(unwired).kind).toBe("absent");
  });

  it("follows the wire rather than assuming the ground node feeds it", () => {
    // Rewired to a different source: the pane must report on whatever now feeds the port, and a
    // healthy ground-plane node elsewhere must not be mistaken for this input being fine.
    const rewired: GraphStoreState = {
      ...graphWith(held("key-1"), "key-1"),
      edges: edges.map((e) =>
        e.target === VIEWER_3D_ID && e.targetPort === "plane" ? { ...e, source: "elsewhere" } : e,
      ),
    };
    expect(readFloorState(rewired).kind).toBe("absent");
  });
});
