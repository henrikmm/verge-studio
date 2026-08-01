/**
 * The graph canvas. Warm-toned surface distinct from the pane bodies, dot grid, a
 * banner naming the pipeline, and a Fit control top-right — see docs/DESIGN.md.
 *
 * Connections are type-checked: `isValidConnection` refuses to join ports of
 * different types, so a depth field cannot be wired into a point-cloud input.
 */

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import {
  getGraph,
  isNodeStale,
  selectNode,
  setEdges,
  setNodes,
  useGraph,
} from "../graph/graph-store";
import { NodeCard } from "../graph/node-card";
import { REGISTRY } from "../graph/nodes";
import { portColor, type PortType } from "../graph/types";

const nodeTypes = { card: NodeCard };

function portTypeOf(nodeType: string, portId: string, side: "in" | "out"): PortType | null {
  const spec = REGISTRY[nodeType];
  if (!spec) return null;
  const ports = side === "in" ? spec.inputs : spec.outputs;
  return ports.find((p) => p.id === portId)?.type ?? null;
}

function GraphCanvas() {
  const graph = useGraph();
  const { fitView } = useReactFlow();

  const rfNodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: "card",
        position: n.position,
        data: {},
        selected: graph.selectedId === n.id,
      })),
    [graph.nodes, graph.selectedId],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const source = graph.nodes.find((n) => n.id === e.source);
        const type = source ? portTypeOf(source.type, e.sourcePort, "out") : null;
        // A wire out of a stale node is showing old data; dim it to say so.
        const dim = source ? isNodeStale(graph, source.id) : false;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourcePort,
          targetHandle: e.targetPort,
          style: {
            stroke: type ? portColor(type) : "var(--text-dim)",
            strokeWidth: 1.5,
            opacity: dim ? 0.35 : 0.9,
          },
        };
      }),
    [graph],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let nodes = getGraph().nodes;
    let touched = false;
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const at = change.position;
        nodes = nodes.map((n) => (n.id === change.id ? { ...n, position: at } : n));
        touched = true;
      } else if (change.type === "remove") {
        nodes = nodes.filter((n) => n.id !== change.id);
        touched = true;
      }
    }
    if (touched) setNodes(nodes);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
    if (removed.size === 0) return;
    setEdges(getGraph().edges.filter((e) => !removed.has(e.id)));
  }, []);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const { source, target, sourceHandle, targetHandle } = connection;
    if (!source || !target || !sourceHandle || !targetHandle) return false;
    if (source === target) return false;
    const nodes = getGraph().nodes;
    const from = nodes.find((n) => n.id === source);
    const to = nodes.find((n) => n.id === target);
    if (!from || !to) return false;
    const out = portTypeOf(from.type, sourceHandle, "out");
    const inp = portTypeOf(to.type, targetHandle, "in");
    return out !== null && out === inp;
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;
      const { source, target, sourceHandle, targetHandle } = connection;
      const existing = getGraph().edges.filter(
        // One wire per input port: connecting replaces rather than stacks.
        (e) => !(e.target === target && e.targetPort === targetHandle),
      );
      setEdges([
        ...existing,
        {
          id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
          source: source!,
          sourcePort: sourceHandle!,
          target: target!,
          targetPort: targetHandle!,
        },
      ]);
    },
    [isValidConnection],
  );

  const staleCount = graph.nodes.filter((n) => isNodeStale(graph, n.id)).length;

  return (
    <div className="pane">
      <div className="pane-status">
        <span>
          {graph.nodes.length} nodes · {graph.edges.length} wires
        </span>
        <span className={staleCount === 0 ? "ok" : ""}>
          {staleCount === 0 ? "all current" : `${staleCount} stale`}
        </span>
        {graph.error && <span style={{ color: "var(--accent-err)" }}>{graph.error}</span>}
        <span className="hint">Drag a port to rewire · drop a video on Frame Source</span>
      </div>
      <div className="pane-body graph-canvas">
        <div className="graph-banner">
          <span className="graph-title">VERGE STUDIO / METRIC DEPTH PIPELINE</span>
          <span className="graph-sub">
            Local frames → cloud DA3 forward pass → native point cloud → measured views
          </span>
          <button className="graph-fit" onClick={() => fitView({ padding: 0.15, duration: 200 })}>
            Fit
          </button>
        </div>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          // Selection is driven by clicks, not by onSelectionChange. The store already
          // feeds `selected` into each node; also consuming React Flow's report of it
          // makes the two oscillate — RF applies our flag, reports the change back, we
          // rewrite the flag, forever.
          onNodeClick={(_, node) => selectNode(node.id)}
          onPaneClick={() => selectNode(null)}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#332f2c" />
        </ReactFlow>
      </div>
    </div>
  );
}

export function GraphPane() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}
