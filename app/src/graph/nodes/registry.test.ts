import { describe, expect, it } from "vitest";
import { computeDesiredKeys, downstreamOf, topoOrder, upstreamOf } from "../evaluate";
import { defaultGraph, REGISTRY, VIEWER_2D_ID, VIEWER_3D_ID } from "./index";

const { nodes, edges } = defaultGraph();

describe("the default pipeline", () => {
  it("is acyclic and orders the source first, the viewers last", () => {
    const order = topoOrder(nodes, edges);
    expect(order[0]).toBe("frame-source");
    expect(order.indexOf("da3-depth")).toBeLessThan(order.indexOf("point-cloud"));
    expect(order).toContain(VIEWER_3D_ID);
    expect(order).toContain(VIEWER_2D_ID);
  });

  it("registers every node type it uses", () => {
    for (const node of nodes) expect(REGISTRY[node.type], node.type).toBeDefined();
  });

  it("connects every required input", () => {
    for (const node of nodes) {
      for (const port of REGISTRY[node.type]!.inputs) {
        if (!port.required) continue;
        const edge = edges.find((e) => e.target === node.id && e.targetPort === port.id);
        expect(edge, `${node.id}.${port.id}`).toBeDefined();
      }
    }
  });

  it("only ever connects ports of the same type", () => {
    for (const edge of edges) {
      const from = REGISTRY[nodes.find((n) => n.id === edge.source)!.type]!;
      const to = REGISTRY[nodes.find((n) => n.id === edge.target)!.type]!;
      const out = from.outputs.find((p) => p.id === edge.sourcePort);
      const inp = to.inputs.find((p) => p.id === edge.targetPort);
      expect(out?.type, edge.id).toBe(inp?.type);
    }
  });

  it("starts the paid node paused and everything else automatic", () => {
    expect(nodes.find((n) => n.id === "da3-depth")?.auto).toBe(false);
    for (const node of nodes.filter((n) => n.id !== "da3-depth")) {
      expect(node.auto, node.id).toBe(true);
    }
  });

  it("taps Depth 2D off the depth wire, not through the point cloud", () => {
    expect(upstreamOf(VIEWER_2D_ID, nodes, edges)).not.toContain("point-cloud");
    expect(upstreamOf(VIEWER_3D_ID, nodes, edges)).toContain("point-cloud");
  });

  it("finds the complete measurement branch for an explicit recompute", () => {
    expect(downstreamOf(["ground-plane", "brush-selection"], nodes, edges)).toEqual([
      "ground-plane",
      "brush-selection",
      "measure-height",
      "scale-check",
      VIEWER_3D_ID,
    ]);
  });
});

describe("invalidation on the real pipeline", () => {
  it("does not restamp DA3Depth when a downstream CPU param changes", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((n) =>
      n.id === "point-cloud" ? { ...n, params: { ...n.params, stride: 4 } } : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    // The whole point: fiddling with the cloud must never re-bill the GPU.
    expect(after.get("frame-source")).toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).toBe(before.get("da3-depth"));
    expect(after.get("point-cloud")).not.toBe(before.get("point-cloud"));
    expect(after.get(VIEWER_3D_ID)).not.toBe(before.get(VIEWER_3D_ID));
    // Depth 2D taps the depth wire, so it is untouched by a point-cloud change.
    expect(after.get(VIEWER_2D_ID)).toBe(before.get(VIEWER_2D_ID));
  });

  it("keeps the offline measurement branch reusable when live DA3 parameters change", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((n) =>
      n.id === "da3-depth" ? { ...n, params: { ...n.params, processRes: 756 } } : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).not.toBe(before.get("da3-depth"));
    expect(after.get(VIEWER_2D_ID)).toBe(before.get(VIEWER_2D_ID));
    expect(after.get(VIEWER_3D_ID)).toBe(before.get(VIEWER_3D_ID));
  });

  it("restamps only the live branch when the source video content changes", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((n) =>
      n.id === "frame-source"
        ? { ...n, params: { ...n.params, videoSha256: "a".repeat(64) } }
        : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).not.toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).not.toBe(before.get("da3-depth"));
    for (const node of nodes.filter((candidate) => !["frame-source", "da3-depth"].includes(candidate.id))) {
      expect(after.get(node.id), node.id).toBe(before.get(node.id));
    }
  });

  it("restamps the complete measurement branch when the fixture setting changes", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((node) =>
      node.id === "fixture-run"
        ? { ...node, params: { ...node.params, setting: "252px-256f" } }
        : node,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).toBe(before.get("da3-depth"));
    for (const id of ["fixture-run", "point-cloud", "ground-plane", "brush-selection", "measure-height", "scale-check", VIEWER_2D_ID, VIEWER_3D_ID]) {
      expect(after.get(id), id).not.toBe(before.get(id));
    }
  });
});
