/**
 * The rules for joining two ports.
 *
 * These were driven by a real mouse drag in the browser on 2026-08-06 and the connection was
 * made correctly, which is what closed a long-standing "never verified" item. A drag is still a
 * poor instrument for asserting a rule — the port handle is about 11 pixels wide even zoomed in,
 * and a drag that misses pans the canvas instead, which looks exactly like a refusal. So the
 * rules themselves are pinned here, against the real node registry.
 */

import { describe, expect, it } from "vitest";
import { canConnect, connectEdges, edgeId, portTypeOf } from "./connect";
import { defaultGraph, REGISTRY } from "./nodes";
import type { GraphEdge } from "./types";

const { nodes, edges } = defaultGraph();

const attempt = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
  source,
  sourceHandle,
  target,
  targetHandle,
});

describe("portTypeOf", () => {
  it("reads a declared port type from the registry", () => {
    expect(portTypeOf(REGISTRY, "point-cloud", "points", "out")).toBe("point_cloud");
    expect(portTypeOf(REGISTRY, "ground-plane", "depth", "in")).toBe("depth_field");
  });

  it("returns null for an unknown node type or port", () => {
    expect(portTypeOf(REGISTRY, "no-such-node", "points", "out")).toBeNull();
    expect(portTypeOf(REGISTRY, "point-cloud", "no-such-port", "out")).toBeNull();
  });
});

describe("canConnect", () => {
  it("accepts two ports of the same type", () => {
    expect(canConnect(REGISTRY, nodes, attempt("point-cloud", "points", "viewer-3d", "points"))).toBe(true);
  });

  /**
   * The refusal that matters. A depth field arriving where a point cloud is expected would not
   * throw — the receiving node would read fields that are not there and produce nonsense.
   */
  it("refuses two ports of different types", () => {
    expect(canConnect(REGISTRY, nodes, attempt("point-cloud", "points", "viewer-3d", "plane"))).toBe(false);
    expect(canConnect(REGISTRY, nodes, attempt("ground-plane", "plane", "brush-selection", "points"))).toBe(false);
  });

  it("refuses a node wired to itself", () => {
    expect(canConnect(REGISTRY, nodes, attempt("point-cloud", "points", "point-cloud", "depth"))).toBe(false);
  });

  it("refuses an unknown node, and an incomplete drag", () => {
    expect(canConnect(REGISTRY, nodes, attempt("ghost", "points", "viewer-3d", "points"))).toBe(false);
    expect(
      canConnect(REGISTRY, nodes, { source: "point-cloud", sourceHandle: "points", target: null, targetHandle: null }),
    ).toBe(false);
  });
});

describe("connectEdges — one wire per input", () => {
  const depthInto = (list: readonly GraphEdge[], target: string, port: string) =>
    list.filter((e) => e.target === target && e.targetPort === port).map((e) => `${e.source}.${e.sourcePort}`);

  it("replaces the wire already feeding that input rather than stacking a second", () => {
    expect(depthInto(edges, "ground-plane", "depth")).toEqual(["fixture-run.depth"]);

    const next = connectEdges(REGISTRY, nodes, edges, attempt("da3-depth", "depth", "ground-plane", "depth"));

    // Exactly one wire still arrives, and it is the new one.
    expect(depthInto(next, "ground-plane", "depth")).toEqual(["da3-depth.depth"]);
    expect(next).toHaveLength(edges.length);
  });

  it("displaces only that input, leaving the rest of the graph alone", () => {
    const next = connectEdges(REGISTRY, nodes, edges, attempt("da3-depth", "depth", "ground-plane", "depth"));

    // The same source feeds several other inputs; none of them may be disturbed.
    expect(depthInto(next, "point-cloud", "depth")).toEqual(["fixture-run.depth"]);
    expect(depthInto(next, "brush-selection", "depth")).toEqual(["fixture-run.depth"]);
    expect(depthInto(next, "viewer-2d", "depth")).toEqual(["fixture-run.depth"]);
  });

  it("lets one output feed as many inputs as it likes", () => {
    const fromPoints = edges.filter((e) => e.source === "point-cloud" && e.sourcePort === "points");
    expect(fromPoints.length).toBeGreaterThan(1);
  });

  it("adds a wire to an input that had none", () => {
    const without = edges.filter((e) => !(e.target === "viewer-3d" && e.targetPort === "points"));
    const next = connectEdges(REGISTRY, nodes, without, attempt("point-cloud", "points", "viewer-3d", "points"));

    expect(next).toHaveLength(without.length + 1);
    expect(depthInto(next, "viewer-3d", "points")).toEqual(["point-cloud.points"]);
  });

  it("is a no-op when the connection is refused", () => {
    const next = connectEdges(REGISTRY, nodes, edges, attempt("point-cloud", "points", "viewer-3d", "plane"));
    expect(next).toEqual([...edges]);
  });

  it("gives a connection the same id every time, so reconnecting cannot duplicate it", () => {
    const a = attempt("point-cloud", "points", "viewer-3d", "points");
    const id = edgeId({ source: "point-cloud", sourceHandle: "points", target: "viewer-3d", targetHandle: "points" });
    const once = connectEdges(REGISTRY, nodes, edges, a);
    const twice = connectEdges(REGISTRY, nodes, once, a);

    expect(twice.filter((e) => e.id === id)).toHaveLength(1);
    expect(twice).toHaveLength(once.length);
  });
});
