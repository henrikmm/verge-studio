import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeDesiredKeys,
  GraphCycleError,
  isStale,
  runGraph,
  topoOrder,
  upstreamOf,
} from "./evaluate";
import {
  emptyRuntime,
  type GraphEdge,
  type GraphNode,
  type NodeRegistry,
  type NodeRuntime,
} from "./types";

/**
 * A stand-in for the real pipeline with the same shape:
 * source(auto) -> gpu(MANUAL) -> cloud(auto) -> sink(auto)
 * The call counters are what the invalidation tests actually assert on.
 */
const calls = { source: 0, gpu: 0, cloud: 0, sink: 0 };

function registry(overrides: Partial<Record<string, string>> = {}): NodeRegistry {
  return {
    source: {
      type: "source",
      label: "Frame Source",
      category: "source",
      version: overrides.source ?? "0.1.0",
      execution: "auto",
      inputs: [],
      outputs: [{ id: "frames", label: "Frames", type: "frames" }],
      defaults: { fps: 10 },
      execute: async ({ params }) => {
        calls.source += 1;
        return { frames: { type: "frames", value: `frames@${String(params.fps)}` } };
      },
    },
    gpu: {
      type: "gpu",
      label: "DA3 Depth",
      category: "analysis",
      version: overrides.gpu ?? "0.1.0",
      execution: "manual",
      inputs: [{ id: "frames", label: "Frames", type: "frames", required: true }],
      outputs: [{ id: "depth", label: "Depth", type: "depth_field" }],
      defaults: { processRes: 504 },
      execute: async ({ inputs, params }) => {
        calls.gpu += 1;
        return {
          depth: { type: "depth_field", value: `depth(${String(inputs.frames?.value)})@${String(params.processRes)}` },
        };
      },
    },
    cloud: {
      type: "cloud",
      label: "Point Cloud",
      category: "geometry",
      version: overrides.cloud ?? "0.1.0",
      execution: "auto",
      inputs: [{ id: "depth", label: "Depth", type: "depth_field", required: true }],
      outputs: [{ id: "points", label: "Points", type: "point_cloud" }],
      defaults: { stride: 1 },
      execute: async ({ inputs }) => {
        calls.cloud += 1;
        return { points: { type: "point_cloud", value: `cloud(${String(inputs.depth?.value)})` } };
      },
    },
    sink: {
      type: "sink",
      label: "Viewer 3D",
      category: "sink",
      version: overrides.sink ?? "0.1.0",
      execution: "auto",
      inputs: [{ id: "points", label: "Points", type: "point_cloud", required: true }],
      outputs: [],
      defaults: {},
      execute: async () => {
        calls.sink += 1;
        return {};
      },
    },
  };
}

function pipeline(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const at = (x: number) => ({ x, y: 0 });
  return {
    nodes: [
      { id: "n-source", type: "source", params: { fps: 10 }, position: at(0), auto: true },
      { id: "n-gpu", type: "gpu", params: { processRes: 504 }, position: at(1), auto: false },
      { id: "n-cloud", type: "cloud", params: { stride: 1 }, position: at(2), auto: true },
      { id: "n-sink", type: "sink", params: {}, position: at(3), auto: true },
    ],
    edges: [
      { id: "e1", source: "n-source", sourcePort: "frames", target: "n-gpu", targetPort: "frames" },
      { id: "e2", source: "n-gpu", sourcePort: "depth", target: "n-cloud", targetPort: "depth" },
      { id: "e3", source: "n-cloud", sourcePort: "points", target: "n-sink", targetPort: "points" },
    ],
  };
}

/** Drives runGraph and keeps a runtime record the way the store will. */
function makeHarness() {
  const runtime: Record<string, NodeRuntime> = {};
  const onChange = (id: string, patch: Partial<NodeRuntime>) => {
    runtime[id] = { ...(runtime[id] ?? emptyRuntime()), ...patch };
  };
  return { runtime, onChange };
}

beforeEach(() => {
  calls.source = 0;
  calls.gpu = 0;
  calls.cloud = 0;
  calls.sink = 0;
});

describe("topoOrder", () => {
  it("orders producers before consumers", () => {
    const { nodes, edges } = pipeline();
    expect(topoOrder(nodes, edges)).toEqual(["n-source", "n-gpu", "n-cloud", "n-sink"]);
  });

  it("detects cycles instead of looping forever", () => {
    const { nodes, edges } = pipeline();
    edges.push({
      id: "loop",
      source: "n-sink",
      sourcePort: "out",
      target: "n-source",
      targetPort: "in",
    });
    expect(() => topoOrder(nodes, edges)).toThrow(GraphCycleError);
  });

  it("ignores edges pointing at deleted nodes", () => {
    const { nodes, edges } = pipeline();
    edges.push({ id: "ghost", source: "gone", sourcePort: "o", target: "n-sink", targetPort: "i" });
    expect(() => topoOrder(nodes, edges)).not.toThrow();
  });
});

describe("upstreamOf", () => {
  it("returns only ancestors, in execution order", () => {
    const { nodes, edges } = pipeline();
    expect(upstreamOf("n-cloud", nodes, edges)).toEqual(["n-source", "n-gpu", "n-cloud"]);
    expect(upstreamOf("n-source", nodes, edges)).toEqual(["n-source"]);
  });
});

describe("computeDesiredKeys — the invalidation rule", () => {
  it("restamps the changed node and everything downstream, and nothing else", () => {
    const { nodes, edges } = pipeline();
    const before = computeDesiredKeys(nodes, edges, registry());

    const changed = nodes.map((n) =>
      n.id === "n-gpu" ? { ...n, params: { processRes: 756 } } : n,
    );
    const after = computeDesiredKeys(changed, edges, registry());

    expect(after.get("n-source")).toBe(before.get("n-source"));
    expect(after.get("n-gpu")).not.toBe(before.get("n-gpu"));
    expect(after.get("n-cloud")).not.toBe(before.get("n-cloud"));
    expect(after.get("n-sink")).not.toBe(before.get("n-sink"));
  });

  it("propagates a source change through the whole chain", () => {
    const { nodes, edges } = pipeline();
    const before = computeDesiredKeys(nodes, edges, registry());
    const changed = nodes.map((n) => (n.id === "n-source" ? { ...n, params: { fps: 4 } } : n));
    const after = computeDesiredKeys(changed, edges, registry());

    for (const id of ["n-source", "n-gpu", "n-cloud", "n-sink"]) {
      expect(after.get(id), id).not.toBe(before.get(id));
    }
  });

  it("invalidates downstream when a node's version is bumped", () => {
    const { nodes, edges } = pipeline();
    const before = computeDesiredKeys(nodes, edges, registry());
    const after = computeDesiredKeys(nodes, edges, registry({ gpu: "0.2.0" }));

    expect(after.get("n-source")).toBe(before.get("n-source"));
    expect(after.get("n-gpu")).not.toBe(before.get("n-gpu"));
    expect(after.get("n-cloud")).not.toBe(before.get("n-cloud"));
  });

  it("distinguishes which output port a consumer reads", () => {
    const nodes: GraphNode[] = [
      { id: "a", type: "source", params: {}, position: { x: 0, y: 0 }, auto: true },
      { id: "b", type: "sink", params: {}, position: { x: 1, y: 0 }, auto: true },
    ];
    const viaFrames: GraphEdge[] = [
      { id: "e", source: "a", sourcePort: "frames", target: "b", targetPort: "points" },
    ];
    const viaOther: GraphEdge[] = [
      { id: "e", source: "a", sourcePort: "preview", target: "b", targetPort: "points" },
    ];
    const k1 = computeDesiredKeys(nodes, viaFrames, registry()).get("b");
    const k2 = computeDesiredKeys(nodes, viaOther, registry()).get("b");
    expect(k1).not.toBe(k2);
  });

  it("gives identical nodes with identical inputs the same key", () => {
    const nodes: GraphNode[] = [
      { id: "a", type: "source", params: { fps: 10 }, position: { x: 0, y: 0 }, auto: true },
      { id: "b", type: "source", params: { fps: 10 }, position: { x: 0, y: 1 }, auto: true },
    ];
    const keys = computeDesiredKeys(nodes, [], registry());
    expect(keys.get("a")).toBe(keys.get("b"));
  });
});

describe("isStale", () => {
  it("treats a node that has never produced output as stale", () => {
    expect(isStale(undefined, "k")).toBe(true);
    expect(isStale(emptyRuntime(), "k")).toBe(true);
  });

  it("is fresh only when the held key matches", () => {
    const held: NodeRuntime = { ...emptyRuntime(), heldKey: "k", outputs: {} };
    expect(isStale(held, "k")).toBe(false);
    expect(isStale(held, "other")).toBe(true);
  });
});

describe("runGraph", () => {
  it("runs the chain once when the manual node is allowed", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const report = await runGraph({
      nodes,
      edges,
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    });

    expect(report.ran).toEqual(["n-source", "n-gpu", "n-cloud", "n-sink"]);
    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 1, sink: 1 });
    expect(h.runtime["n-sink"]?.status).toBe("ok");
  });

  it("reuses everything on an unchanged second pass", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const opts = {
      nodes,
      edges,
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    };
    await runGraph(opts);
    const second = await runGraph({ ...opts, runtime: h.runtime });

    expect(second.ran).toEqual([]);
    expect(second.reused).toEqual(["n-source", "n-gpu", "n-cloud", "n-sink"]);
    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 1, sink: 1 });
  });

  it("re-executes ONLY downstream of a changed parameter", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const reg = registry();
    await runGraph({
      nodes,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    });
    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 1, sink: 1 });

    const changed = nodes.map((n) =>
      n.id === "n-cloud" ? { ...n, params: { stride: 4 } } : n,
    );
    const second = await runGraph({
      nodes: changed,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    });

    expect(second.reused).toEqual(["n-source", "n-gpu"]);
    expect(second.ran).toEqual(["n-cloud", "n-sink"]);
    // The expensive node did not run again. This is the whole point.
    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 2, sink: 2 });
  });

  it("never runs a manual node that was not allowed, and blocks its descendants", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const report = await runGraph({
      nodes,
      edges,
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: false,
    });

    expect(calls.source).toBe(1);
    expect(calls.gpu).toBe(0);
    expect(calls.cloud).toBe(0);
    expect(report.blocked).toEqual(["n-gpu", "n-cloud", "n-sink"]);
    expect(h.runtime["n-gpu"]?.status).toBe("stale");
    expect(h.runtime["n-cloud"]?.status).toBe("blocked");
  });

  it("allows a single named manual node — the per-node Run button", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    await runGraph({
      nodes,
      edges,
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      target: "n-gpu",
      allowManual: new Set(["n-gpu"]),
    });

    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 0, sink: 0 });
  });

  it("does not re-run an upstream node when a later pass targets it again", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const reg = registry();
    await runGraph({
      nodes,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      target: "n-source",
    });
    await runGraph({
      nodes,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      target: "n-gpu",
      allowManual: new Set(["n-gpu"]),
    });
    expect(calls).toEqual({ source: 1, gpu: 1, cloud: 0, sink: 0 });
  });

  it("blocks a node whose required input is unconnected", async () => {
    const { nodes } = pipeline();
    const h = makeHarness();
    const report = await runGraph({
      nodes,
      edges: [],
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    });

    expect(report.ran).toEqual(["n-source"]);
    expect(report.blocked).toEqual(["n-gpu", "n-cloud", "n-sink"]);
  });

  it("records the failure and blocks descendants when a node throws", async () => {
    const { nodes, edges } = pipeline();
    const reg = registry();
    reg.gpu.execute = vi.fn(async () => {
      throw new Error("CUDA out of memory");
    });
    const h = makeHarness();
    const report = await runGraph({
      nodes,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
    });

    expect(report.failed).toEqual(["n-gpu"]);
    expect(report.blocked).toEqual(["n-cloud", "n-sink"]);
    expect(h.runtime["n-gpu"]?.status).toBe("error");
    expect(h.runtime["n-gpu"]?.error).toMatch(/out of memory/);
    // A failed node must not be recorded as holding a valid result.
    expect(h.runtime["n-gpu"]?.heldKey).toBeNull();
    expect(calls.cloud).toBe(0);
  });

  it("records elapsed time per node", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    let clock = 0;
    await runGraph({
      nodes,
      edges,
      registry: registry(),
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
      now: () => (clock += 5),
    });
    expect(h.runtime["n-source"]?.elapsedMs).toBe(5);
  });

  it("stops early when aborted", async () => {
    const { nodes, edges } = pipeline();
    const h = makeHarness();
    const controller = new AbortController();
    const reg = registry();
    const original = reg.source.execute;
    reg.source.execute = async (ctx) => {
      controller.abort();
      return original(ctx);
    };

    await runGraph({
      nodes,
      edges,
      registry: reg,
      runtime: h.runtime,
      onChange: h.onChange,
      allowManual: true,
      signal: controller.signal,
    });

    expect(calls.source).toBe(1);
    expect(calls.gpu).toBe(0);
  });
});
