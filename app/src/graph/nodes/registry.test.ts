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

  /**
   * Two nodes wait to be asked, for the same reason in two currencies: DA3 spends GPU money,
   * and Frame Source spends up to 11.7 s of this Mac decoding a 4K clip. Neither may start
   * because a slider moved.
   */
  it("starts the costly nodes paused and everything else automatic", () => {
    const costly = ["da3-depth", "frame-source"];
    for (const id of costly) expect(nodes.find((n) => n.id === id)?.auto, id).toBe(false);
    for (const node of nodes.filter((n) => !costly.includes(n.id))) {
      expect(node.auto, node.id).toBe(true);
    }
  });

  // Whatever else moves, these two stay out of any pass the user did not explicitly ask for.
  // `runAutoFree` builds its deny set from exactly this predicate.
  it("marks both costly nodes manual in the registry", () => {
    expect(REGISTRY["da3-depth"]!.execution).toBe("manual");
    expect(REGISTRY["frame-source"]!.execution).toBe("manual");
  });

  /**
   * The app opens pointed at the run it is about to make, not at a fixture of a different room.
   * It defaulted to `recorded` until 2026-08-11, which meant loading a clip and paying for a run
   * left the viewers showing the door fixture — the run was invisible unless you found a
   * dropdown in another pane.
   */
  it("points Run Source at the live branch by default", () => {
    expect(nodes.find((n) => n.id === "fixture-run")?.params.source).toBe("live");
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

  /**
   * On the recorded path the measurement branch is insulated from the live one.
   *
   * This is what lets a saved run be re-measured without the DA3 controls touching it, and it is
   * why `activeInputs` drops the live port entirely rather than merely ignoring its value. Both
   * cases below used to hold on the DEFAULT graph, because the default was `recorded`; they are
   * now stated against a Run Source explicitly set to it, which is what they were always
   * really about.
   */
  const recorded = nodes.map((node) =>
    node.id === "fixture-run" ? { ...node, params: { ...node.params, source: "recorded" } } : node,
  );

  it("keeps a recorded measurement branch reusable when live DA3 parameters change", () => {
    const before = computeDesiredKeys(recorded, edges, REGISTRY);
    const changed = recorded.map((n) =>
      n.id === "da3-depth" ? { ...n, params: { ...n.params, processRes: 756 } } : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).not.toBe(before.get("da3-depth"));
    expect(after.get(VIEWER_2D_ID)).toBe(before.get(VIEWER_2D_ID));
    expect(after.get(VIEWER_3D_ID)).toBe(before.get(VIEWER_3D_ID));
  });

  it("restamps only the live branch when the source video changes under a recorded run", () => {
    const before = computeDesiredKeys(recorded, edges, REGISTRY);
    const changed = recorded.map((n) =>
      n.id === "frame-source"
        ? { ...n, params: { ...n.params, videoSha256: "a".repeat(64) } }
        : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).not.toBe(before.get("frame-source"));
    expect(after.get("da3-depth")).not.toBe(before.get("da3-depth"));
    for (const node of recorded.filter(
      (candidate) => !["frame-source", "da3-depth"].includes(candidate.id),
    )) {
      expect(after.get(node.id), node.id).toBe(before.get(node.id));
    }
  });

  /**
   * And the mirror, which is the new default's whole purpose: on the live path the measurement
   * branch DOES follow the run. A processRes change restamps everything downstream, so the
   * viewers, the floor fit and the measurement all go stale together rather than quoting numbers
   * from a reconstruction that no longer exists.
   */
  it("carries a live DA3 parameter change through to the measurement branch and the viewers", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((n) =>
      n.id === "da3-depth" ? { ...n, params: { ...n.params, processRes: 756 } } : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get("frame-source")).toBe(before.get("frame-source"));
    for (const id of [
      "da3-depth",
      "fixture-run",
      "point-cloud",
      "ground-plane",
      "measure-height",
      VIEWER_2D_ID,
      VIEWER_3D_ID,
    ]) {
      expect(after.get(id), id).not.toBe(before.get(id));
    }
  });

  it("carries a new clip through to the viewers on the live path", () => {
    const before = computeDesiredKeys(nodes, edges, REGISTRY);
    const changed = nodes.map((n) =>
      n.id === "frame-source"
        ? { ...n, params: { ...n.params, videoSha256: "a".repeat(64) } }
        : n,
    );
    const after = computeDesiredKeys(changed, edges, REGISTRY);

    expect(after.get(VIEWER_2D_ID)).not.toBe(before.get(VIEWER_2D_ID));
    expect(after.get(VIEWER_3D_ID)).not.toBe(before.get(VIEWER_3D_ID));
  });

  it("restamps the complete measurement branch when the fixture setting changes", () => {
    const before = computeDesiredKeys(recorded, edges, REGISTRY);
    const changed = recorded.map((node) =>
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
