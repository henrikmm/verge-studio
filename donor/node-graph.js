import { artifactCacheKey } from "./content-hash.js";

export const NODE_GRAPH_CONTRACT_VERSION = "mvl.node-graph/0.1.0";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The Benchmark-0 diagnostic pipeline. Each stage stays separable so an oracle
 * substitution can replace exactly one node, and every port carries a type so a
 * depth field can never be wired into a pose input.
 */
export const VERGE_GRAPH_DEFINITION = Object.freeze({
  graph_contract_version: NODE_GRAPH_CONTRACT_VERSION,
  graph_id: "verge-benchmark0-graph",
  run_id: "synthetic-viewer-run-001",
  nodes: Object.freeze([
    Object.freeze({
      id: "clip-source",
      label: "Clip source",
      producer_version: "0.1.0",
      output: "clip",
      inputs: Object.freeze({}),
      edges: Object.freeze({}),
      source_content_sha256:
        "9b6a1e1cb1de6a5d1a1cbb2e1c1d3f2f19b9a1eb3ff05f19e0d38a10a5d24b31",
      parameters: Object.freeze({ clip_id: "synthetic-verge-clip-001" }),
    }),
    Object.freeze({
      id: "depth",
      label: "Depth",
      producer_version: "0.1.0",
      output: "depth_field",
      inputs: Object.freeze({ clip: "clip" }),
      edges: Object.freeze({ clip: "clip-source" }),
      parameters: Object.freeze({
        model_revision: "synthetic-oracle-depth",
        max_range_m: 30,
      }),
    }),
    Object.freeze({
      id: "pose",
      label: "Pose",
      producer_version: "0.1.0",
      output: "pose_track",
      inputs: Object.freeze({ clip: "clip" }),
      edges: Object.freeze({ clip: "clip-source" }),
      parameters: Object.freeze({ keyframe_stride: 2 }),
    }),
    Object.freeze({
      id: "scale",
      label: "Scale",
      producer_version: "0.1.0",
      output: "scale_estimate",
      inputs: Object.freeze({ pose: "pose_track" }),
      edges: Object.freeze({ pose: "pose" }),
      parameters: Object.freeze({ baseline_window_m: 8, scale_mode: "metric" }),
    }),
    Object.freeze({
      id: "segmentation",
      label: "Segmentation",
      producer_version: "0.1.0",
      output: "segmentation_mask",
      inputs: Object.freeze({ clip: "clip" }),
      edges: Object.freeze({ clip: "clip-source" }),
      parameters: Object.freeze({ grass_class_threshold: 0.5 }),
    }),
    Object.freeze({
      id: "fusion",
      label: "Fusion",
      producer_version: "0.1.0",
      output: "point_cloud",
      inputs: Object.freeze({
        depth: "depth_field",
        pose: "pose_track",
        scale: "scale_estimate",
      }),
      edges: Object.freeze({ depth: "depth", pose: "pose", scale: "scale" }),
      parameters: Object.freeze({ voxel_size_m: 0.02 }),
    }),
    Object.freeze({
      id: "ground",
      label: "Ground estimation",
      producer_version: "0.1.0",
      output: "ground_model",
      inputs: Object.freeze({
        cloud: "point_cloud",
        mask: "segmentation_mask",
      }),
      edges: Object.freeze({ cloud: "fusion", mask: "segmentation" }),
      parameters: Object.freeze({ min_support_points: 12 }),
    }),
    Object.freeze({
      id: "height",
      label: "Height",
      producer_version: "0.1.0",
      output: "height_grid",
      inputs: Object.freeze({
        cloud: "point_cloud",
        ground: "ground_model",
        mask: "segmentation_mask",
      }),
      edges: Object.freeze({
        cloud: "fusion",
        ground: "ground",
        mask: "segmentation",
      }),
      parameters: Object.freeze({ cell_size_m: 0.25, percentile: 95 }),
    }),
  ]),
});

function assertTypedPorts(nodes, byId) {
  for (const node of nodes) {
    for (const port of Object.keys(node.edges)) {
      if (!(port in node.inputs)) {
        throw new TypeError(`${node.id} has no declared input port "${port}"`);
      }
    }
    for (const [port, declaredType] of Object.entries(node.inputs)) {
      const upstreamId = node.edges[port];
      if (upstreamId === undefined) {
        throw new TypeError(`${node.id}.${port} is unconnected`);
      }
      const upstream = byId.get(upstreamId);
      if (!upstream) {
        throw new TypeError(
          `${node.id}.${port} references unknown graph node "${upstreamId}"`,
        );
      }
      if (upstream.output !== declaredType) {
        throw new TypeError(
          `${node.id}.${port} expects ${declaredType} but ` +
            `${upstream.id} emits ${upstream.output}`,
        );
      }
    }
  }
}

function topologicalOrder(nodes, byId) {
  const remaining = new Map(
    nodes.map((node) => [node.id, new Set(Object.values(node.edges))]),
  );
  const order = [];
  while (remaining.size > 0) {
    // Declaration order is the deterministic tiebreak.
    const next = nodes.find(
      (node) =>
        remaining.has(node.id) &&
        [...remaining.get(node.id)].every((upstream) => !remaining.has(upstream)),
    );
    if (!next) {
      throw new TypeError(
        `graph contains a cycle among: ${[...remaining.keys()].join(", ")}`,
      );
    }
    remaining.delete(next.id);
    order.push(byId.get(next.id));
  }
  return order;
}

export function createNodeGraph({ definition = VERGE_GRAPH_DEFINITION } = {}) {
  if (!definition?.nodes?.length) {
    throw new TypeError("node graph definition must contain at least one node");
  }

  const byId = new Map();
  for (const node of definition.nodes) {
    if (byId.has(node.id)) {
      throw new TypeError(`duplicate graph node: ${node.id}`);
    }
    if (
      node.source_content_sha256 !== undefined &&
      !SHA256_PATTERN.test(node.source_content_sha256)
    ) {
      throw new TypeError(`${node.id} source hash must be a lowercase SHA-256 digest`);
    }
    byId.set(node.id, {
      ...node,
      inputs: { ...node.inputs },
      edges: { ...node.edges },
      parameters: { ...node.parameters },
    });
  }

  assertTypedPorts([...byId.values()], byId);
  const order = topologicalOrder(definition.nodes, byId);

  const descendants = new Map(order.map((node) => [node.id, new Set()]));
  for (const node of [...order].reverse()) {
    for (const upstreamId of new Set(Object.values(node.edges))) {
      const set = descendants.get(upstreamId);
      set.add(node.id);
      for (const id of descendants.get(node.id)) set.add(id);
    }
  }

  const cacheKeys = new Map();
  const completed = new Map();
  const listeners = new Set();

  function recomputeFrom(nodeIds) {
    for (const node of order) {
      if (nodeIds && !nodeIds.has(node.id)) continue;
      const inputs = {};
      if (node.source_content_sha256 !== undefined) {
        inputs.source = node.source_content_sha256;
      }
      for (const [port, upstreamId] of Object.entries(node.edges)) {
        inputs[port] = cacheKeys.get(upstreamId);
      }
      cacheKeys.set(
        node.id,
        artifactCacheKey({
          producer_node: node.id,
          producer_version: node.producer_version,
          parameters: node.parameters,
          input_content_sha256: inputs,
        }),
      );
    }
  }

  recomputeFrom(null);
  // The graph is seeded from the completed run recorded in the provenance
  // bundle, so every node starts cached rather than pending.
  for (const node of order) completed.set(node.id, cacheKeys.get(node.id));

  function stateOf(nodeId) {
    return cacheKeys.get(nodeId) === completed.get(nodeId)
      ? "cached"
      : "rerun_required";
  }

  function viewOf(node) {
    return Object.freeze({
      id: node.id,
      label: node.label,
      producer_version: node.producer_version,
      output: node.output,
      inputs: Object.freeze({ ...node.inputs }),
      edges: Object.freeze({ ...node.edges }),
      parameters: Object.freeze({ ...node.parameters }),
      source_content_sha256: node.source_content_sha256,
      cache_key: cacheKeys.get(node.id),
      state: stateOf(node.id),
    });
  }

  function requireNode(nodeId) {
    const node = byId.get(nodeId);
    if (!node) throw new RangeError(`unknown graph node: ${nodeId}`);
    return node;
  }

  function invalidate(nodeId) {
    const affected = new Set([nodeId, ...descendants.get(nodeId)]);
    recomputeFrom(affected);
    const invalidatedNodeIds = order
      .filter((node) => affected.has(node.id))
      .map((node) => node.id);
    const change = Object.freeze({
      changed_node_id: nodeId,
      invalidated_node_ids: Object.freeze(invalidatedNodeIds),
    });
    for (const listener of listeners) listener(change);
    return change;
  }

  function getRerunPlan() {
    const plan = { rerun_required: [], cached: [] };
    for (const node of order) plan[stateOf(node.id)].push(node.id);
    return plan;
  }

  return Object.freeze({
    definition,
    getNodes: () => order.map(viewOf),
    getNode: (nodeId) => viewOf(requireNode(nodeId)),
    getCacheKey: (nodeId) => cacheKeys.get(requireNode(nodeId).id),
    getRerunPlan,
    setParameter(nodeId, name, value) {
      const node = requireNode(nodeId);
      if (!(name in node.parameters)) {
        throw new RangeError(`unknown parameter "${name}" on graph node ${nodeId}`);
      }
      node.parameters = { ...node.parameters, [name]: value };
      return invalidate(nodeId);
    },
    setSourceContentHash(nodeId, digest) {
      const node = requireNode(nodeId);
      if (node.source_content_sha256 === undefined) {
        throw new RangeError(`${nodeId} is not a source node`);
      }
      if (!SHA256_PATTERN.test(digest)) {
        throw new TypeError("source hash must be a lowercase SHA-256 digest");
      }
      node.source_content_sha256 = digest;
      return invalidate(nodeId);
    },
    recordCompletedRun(nodeId) {
      const node = requireNode(nodeId);
      const staleInput = Object.values(node.edges).find(
        (upstreamId) => stateOf(upstreamId) === "rerun_required",
      );
      if (staleInput) {
        throw new RangeError(
          `${nodeId} cannot complete while ${staleInput} awaits a rerun`,
        );
      }
      completed.set(node.id, cacheKeys.get(node.id));
      for (const listener of listeners) {
        listener({ changed_node_id: node.id, invalidated_node_ids: [] });
      }
      return viewOf(node);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
