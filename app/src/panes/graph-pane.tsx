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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getGraph,
  isNodeStale,
  selectEdge,
  selectNode,
  setEdges,
  setNodes,
  useGraph,
} from "../graph/graph-store";
import { toggleFocus, useDock } from "../lib/dock-store";
import { canConnect, connectEdges, portTypeOf } from "../graph/connect";
import { NodeCard } from "../graph/node-card";
import { REGISTRY } from "../graph/nodes";
import { portColor } from "../graph/types";
import { PaneShare } from "./pane-chrome";

const nodeTypes = { card: NodeCard };
const LIVE_ONLY_NODES = new Set(["frame-source", "da3-depth"]);

/** Card box used for framing. Width is fixed by `.node-card` in theme.css; height is the
 *  measured range (146–174 px) rounded up, which only affects padding, never correctness. */
const NODE_WIDTH = 182;
const NODE_HEIGHT = 175;
const FIT_PADDING_PX = 28;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.4;

function GraphCanvas() {
  const graph = useGraph();
  const dock = useDock();
  const focused = dock.focusedId === "graph";
  const { setViewport } = useReactFlow();
  const [scope, setScope] = useState<"measurement" | "full">("measurement");
  const visibleNodes = useMemo(
    () => graph.nodes.filter((node) => scope === "full" || !LIVE_ONLY_NODES.has(node.id)),
    [graph.nodes, scope],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

  const rfNodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((n) => ({
        id: n.id,
        type: "card",
        position: n.position,
        data: {},
        selected: graph.selectedId === n.id,
      })),
    [visibleNodes, graph.selectedId],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map((e) => {
        const source = graph.nodes.find((n) => n.id === e.source);
        const type = source ? portTypeOf(REGISTRY, source.type, e.sourcePort, "out") : null;
        // A wire out of a stale node is showing old data; dim it to say so.
        const dim = source ? isNodeStale(graph, source.id) : false;
        // React Flow is fully controlled here, so it cannot hold a selection of its own:
        // whatever it marks is overwritten on our next render. Carrying `selected` on the
        // edge the way nodes already do is what makes a wire selectable at all — and
        // Backspace only ever acts on selected elements, which is why deleting a wire was
        // unreachable before this. The stroke thickens too, so the highlight survives
        // grayscale and does not lean on the port hue.
        const selected = graph.selectedEdgeId === e.id;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourcePort,
          targetHandle: e.targetPort,
          selected,
          style: {
            stroke: selected ? "var(--emph-hi)" : type ? portColor(type) : "var(--text-dim)",
            strokeWidth: selected ? 3 : 1.5,
            opacity: dim && !selected ? 0.35 : 0.9,
          },
        };
      }),
    [graph, visibleIds],
  );

  const hostRef = useRef<HTMLDivElement | null>(null);

  /**
   * Fit the visible nodes, computed from the pane's real box rather than React Flow's.
   *
   * `fitView()` was measured producing `translate(67.8, -23.1) scale(0.2)` in a pane that is
   * genuinely 1280×302. Solving its own `getViewportForBounds` backwards from that output
   * gives an internal viewport of **500×55** — React Flow had measured the container during
   * Dockview's initial layout and never re-measured, so every fit was computed against a box
   * that no longer existed and then clamped to `minZoom`. That is the thumbnail-in-the-corner
   * symptom, and it is why the manual Fit button appeared to work only sometimes.
   *
   * Focus and Hide resize this pane constantly, so relying on that measurement was not an
   * option. We own the node positions and the card width is fixed by CSS, so the framing is
   * computed here and applied with `setViewport` — no dependency on React Flow's box at all.
   */
  const refit = useCallback(() => {
    const host = hostRef.current;
    // A pane collapsed to nothing has no meaningful fit; wait until it has a box again.
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
    if (visibleNodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of visibleNodes) {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.position.y + NODE_HEIGHT);
    }

    const boundsWidth = Math.max(maxX - minX, 1);
    const boundsHeight = Math.max(maxY - minY, 1);
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (host.clientWidth - FIT_PADDING_PX * 2) / boundsWidth,
          (host.clientHeight - FIT_PADDING_PX * 2) / boundsHeight,
        ),
      ),
    );
    const next = {
      x: host.clientWidth / 2 - ((minX + maxX) / 2) * zoom,
      y: host.clientHeight / 2 - ((minY + maxY) / 2) * zoom,
      zoom,
    };
    // No transition duration on purpose. An animated `setViewport` is a d3 transition, and
    // successive refits interrupt each other — the promise was measured never settling and
    // the transform never leaving identity. An instant apply cannot be interrupted.
    void setViewport(next);
  }, [setViewport, visibleNodes]);

  /**
   * Refit whenever the pane's own box changes, not just when the scope does. The old
   * rAF-after-scope-change fired before Dockview had given the pane its final size; Focus and
   * Hide now change that size constantly, so this is a prerequisite rather than polish.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timer: number;
    // Debounced, because a drag emits a resize per frame.
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refit, 90);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    schedule();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [refit, scope]);

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

  /**
   * Removals are applied; React Flow's own selection reports are not.
   *
   * Selection is driven from `onEdgeClick` into our store, exactly as nodes are driven from
   * `onNodeClick`. Consuming React Flow's `select` changes as well would make the two fight:
   * it applies our flag, reports the change back, we rewrite the flag, forever. Backspace
   * still works because React Flow's delete handler reads the `selected` flag we hand it, so
   * only the highlighted wire is ever in the removal set.
   */
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
    if (removed.size === 0) return;
    setEdges(getGraph().edges.filter((e) => !removed.has(e.id)));
  }, []);

  // Both rules live in `graph/connect.ts` so they can be tested without a mouse. A port handle
  // is ~11 px even zoomed in, which makes a drag a poor way to assert a rule.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => canConnect(REGISTRY, getGraph().nodes, connection),
    [],
  );

  const onConnect = useCallback((connection: Connection) => {
    const graph = getGraph();
    const next = connectEdges(REGISTRY, graph.nodes, graph.edges, connection);
    if (next.length !== graph.edges.length || next.some((e, i) => e.id !== graph.edges[i]?.id)) {
      setEdges(next);
    }
  }, []);

  const staleCount = visibleNodes.filter((n) => isNodeStale(graph, n.id)).length;
  const visibleWireCount = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  ).length;

  return (
    <div className="pane">
      <div className="pane-status">
        <span>
          {visibleNodes.length} nodes · {visibleWireCount} wires
        </span>
        <span className={staleCount === 0 ? "ok" : ""}>
          {staleCount === 0 ? "all current" : `${staleCount} stale`}
        </span>
        {graph.error && <span style={{ color: "var(--accent-err)" }}>{graph.error}</span>}
        <span className="hint">
          {scope === "measurement"
            ? "Measurement view · open Full graph for live DA3"
            : "Full pipeline · drag a port to rewire · click a wire, Backspace to cut it"}
        </span>
        <PaneShare />
      </div>
      <div className="pane-body graph-canvas" ref={hostRef}>
        <div className="graph-banner">
          <span className="graph-title">VERGE STUDIO / METRIC DEPTH PIPELINE</span>
          <span className="graph-sub">
            {scope === "measurement"
              ? "selected run → native point cloud → measured evidence"
              : "local frames → manual DA3 → selectable run source → measured evidence"}
          </span>
          <div className="graph-actions">
            <button className="graph-fit" onClick={() => setScope((value) => value === "full" ? "measurement" : "full")}>
              {scope === "full" ? "Measurement view" : "Full graph"}
            </button>
            <button className="graph-fit" onClick={refit}>
              Fit
            </button>
            {/* Double-clicking the tab does this too, but the graph is the pane most worth
                filling the window and a hidden gesture is not an affordance. The other panes
                with a control row carry the same verb there. */}
            <button
              className={`graph-fit${focused ? " on" : ""}`}
              title={
                focused
                  ? "Restore the other panes (Esc)"
                  : "Fill the window with the graph. The other panes keep their state and come straight back."
              }
              onClick={() => toggleFocus("graph")}
            >
              {focused ? "Restore" : "Focus"}
            </button>
          </div>
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
          onEdgeClick={(_, edge) => selectEdge(edge.id)}
          onPaneClick={() => {
            selectNode(null);
            selectEdge(null);
          }}
          // No `fitView` prop: React Flow's mount-time fit runs against the stale internal
          // viewport described above and would fight the framing computed in `refit`.
          minZoom={MIN_ZOOM}
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
