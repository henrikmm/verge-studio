/**
 * Graph store behaviour that the UI depends on but cannot assert for itself.
 *
 * Two properties are covered here. The first is that changing a control brings the graph back up
 * to date on its own — before this, an Inspector edit marked work as out of date and then left
 * it there, so switching Run Source stranded eight nodes and a paid run looked like a failure.
 * The second is that a wire can be selected at all, which is what makes deleting one possible:
 * React Flow is fully controlled here, so a selection it holds internally is overwritten on the
 * next render, and Backspace only ever acts on selected elements.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PARAM_RUN_DELAY_MS,
  cancelScheduledAutoRun,
  getGraph,
  scheduleAutoRun,
  selectEdge,
  selectNode,
  setEdges,
  setNodeParam,
  setNodeParamAndRun,
} from "./graph-store";
import { REGISTRY } from "./nodes";

afterEach(() => {
  cancelScheduledAutoRun();
  vi.useRealTimers();
  selectNode(null);
  selectEdge(null);
});

describe("the refresh after a parameter edit", () => {
  it("schedules exactly one pass for a burst of edits", () => {
    vi.useFakeTimers();
    const node = getGraph().nodes[0]!;

    for (let i = 0; i < 6; i++) setNodeParamAndRun(node.id, "__probe", i);

    // A slider drag emits a value per frame. Each edit replaces the pending pass rather than
    // queueing another, so the graph is evaluated once, at the end of the gesture.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("waits out the full delay before evaluating", () => {
    vi.useFakeTimers();
    scheduleAutoRun();
    vi.advanceTimersByTime(PARAM_RUN_DELAY_MS - 1);
    // Still pending: the pass belongs to the end of the gesture, not the middle of it.
    expect(vi.getTimerCount()).toBe(1);
    cancelScheduledAutoRun();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the value immediately, whatever the run does later", () => {
    vi.useFakeTimers();
    const node = getGraph().nodes[0]!;
    setNodeParamAndRun(node.id, "__probe", 42);
    expect(getGraph().nodes.find((n) => n.id === node.id)?.params.__probe).toBe(42);
    cancelScheduledAutoRun();
  });

  it("leaves the raw setter free of any scheduling", () => {
    vi.useFakeTimers();
    const node = getGraph().nodes[0]!;
    setNodeParam(node.id, "__probe", 7);
    // Callers that drive their own run still exist; the raw setter must not run behind them.
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The refresh bars every costly node by name, so this pins the assumption that produces that
   * list: the registry, not a hardcoded id, is what marks a node as one that spends money.
   */
  it("marks cloud inference as the costly node the refresh must never reach", () => {
    const costly = getGraph()
      .nodes.filter((n) => REGISTRY[n.type]?.execution === "manual")
      .map((n) => n.id);
    expect(costly).toContain("da3-depth");
  });
});

describe("wire selection", () => {
  it("selects a wire and clears it again", () => {
    const edge = getGraph().edges[0]!;
    selectEdge(edge.id);
    expect(getGraph().selectedEdgeId).toBe(edge.id);
    selectEdge(null);
    expect(getGraph().selectedEdgeId).toBeNull();
  });

  it("holds a node or a wire, never both", () => {
    const node = getGraph().nodes[0]!;
    const edge = getGraph().edges[0]!;

    selectNode(node.id);
    selectEdge(edge.id);
    expect(getGraph().selectedId).toBeNull();
    expect(getGraph().selectedEdgeId).toBe(edge.id);

    selectNode(node.id);
    expect(getGraph().selectedId).toBe(node.id);
    expect(getGraph().selectedEdgeId).toBeNull();
  });

  /**
   * Deleting a wire is the case this exists for. A highlight left pointing at a wire that is
   * gone would leave Backspace armed at nothing, and the next wire to reuse the id would
   * inherit a selection nobody made.
   */
  it("drops the highlight when the wire it points at is removed", () => {
    const edges = getGraph().edges;
    const edge = edges[0]!;
    selectEdge(edge.id);

    setEdges(edges.filter((e) => e.id !== edge.id));
    expect(getGraph().selectedEdgeId).toBeNull();

    setEdges(edges);
  });

  it("keeps the highlight when an unrelated wire is removed", () => {
    const edges = getGraph().edges;
    const kept = edges[0]!;
    const other = edges[1]!;
    selectEdge(kept.id);

    setEdges(edges.filter((e) => e.id !== other.id));
    expect(getGraph().selectedEdgeId).toBe(kept.id);

    setEdges(edges);
  });

  it("is not part of the saved graph", () => {
    const edge = getGraph().edges[0]!;
    selectEdge(edge.id);
    // Selection is a view concern. It never reaches a cache key, so highlighting a wire
    // cannot restale a node or change a result.
    const keysBefore = { ...getGraph().desiredKeys };
    selectEdge(null);
    expect(getGraph().desiredKeys).toEqual(keysBefore);
  });
});
