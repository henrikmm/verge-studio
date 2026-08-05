/**
 * The node card, per the anatomy in docs/DESIGN.md: colored category header with
 * A/P badges, labelled port rows with type-colored dots, an output thumbnail, and a
 * mono elapsed-ms footer.
 *
 * The card reads the store directly rather than through React Flow's `data`, so a
 * status change during a run repaints without the graph being rebuilt.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useRef, useState } from "react";
import { uploadVideo } from "../lib/infer-client";
import {
  isNodeStale,
  nodeById,
  resolveInput,
  runAuto,
  runNode,
  setNodeAuto,
  setNodeParams,
  useGraph,
} from "./graph-store";
import { REGISTRY } from "./nodes";
import { CATEGORY_COLORS, emptyRuntime, portColor, type NodeStatus, type PortSpec } from "./types";

const STATUS_COLOR: Record<NodeStatus, string> = {
  idle: "var(--text-dim)",
  stale: "var(--accent-busy)",
  blocked: "var(--text-dim)",
  running: "var(--accent-busy)",
  ok: "var(--emph-hi)",
  error: "var(--accent-err)",
};

/**
 * The glyph, not the colour, is what says which state this is — the footer is 10px mono
 * and the palette is deliberately near-neutral, so hue alone could not carry six states.
 */
const STATUS_GLYPH: Record<NodeStatus, string> = {
  idle: "○",
  stale: "◐",
  blocked: "○",
  running: "◐",
  ok: "●",
  error: "▲",
};

function PortRow({ port, side }: { port: PortSpec; side: "in" | "out" }) {
  const dot = (
    <span className="port-dot" style={{ background: portColor(port.type) }} aria-hidden />
  );
  return (
    <div className={`port-row ${side}`}>
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={port.id}
        className="port-handle"
        style={{ background: portColor(port.type) }}
      />
      {side === "in" ? dot : null}
      <span className="port-label">{port.label}</span>
      {side === "out" ? dot : null}
    </div>
  );
}

export function NodeCard({ id, selected }: NodeProps) {
  const graph = useGraph();
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const node = nodeById(graph, id);
  if (!node) return null;
  const spec = REGISTRY[node.type];
  if (!spec) return null;

  const runtime = graph.runtime[id] ?? emptyRuntime();
  const stale = isNodeStale(graph, id);
  // A node that holds no result yet reads as idle, not stale-with-old-output.
  const status: NodeStatus =
    runtime.status === "running" || runtime.status === "error"
      ? runtime.status
      : stale
        ? runtime.outputs
          ? "stale"
          : runtime.status
        : "ok";

  const own = Object.values(runtime.outputs ?? {}).find((o) => o.thumbnailUrl || o.summary);
  // Sinks compute nothing, so they show what is arriving on their input instead.
  const tapped = spec.outputs.length === 0 ? resolveInput(graph, id, spec.inputs[0]?.id ?? "") : null;
  const shown = own ?? tapped ?? null;

  const acceptsVideo = node.type === "frame-source";

  /**
   * One path for both ways of choosing a clip.
   *
   * Dragging was the only way in until 2026-08-05, and it is the awkward one: the drop target
   * is this card, which the Graph pane's default "Measurement view" filters out entirely. The
   * Browse button reaches the same code through the OS file dialog.
   */
  const loadVideo = async (file: File | undefined) => {
    if (!file) return;
    setDropError(null);
    setLoading(true);
    try {
      const source = await uploadVideo(file);
      setNodeParams(id, {
        videoPath: source.path,
        videoName: source.name,
        videoSha256: source.sha256,
        durationS: source.durationS,
      });
      await runAuto();
    } catch (err) {
      setDropError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    if (!acceptsVideo) return;
    event.preventDefault();
    event.stopPropagation();
    setDropping(false);
    await loadVideo(event.dataTransfer.files[0]);
  };

  return (
    <div
      className={`node-card${selected ? " selected" : ""}${stale ? " stale" : ""}${dropping ? " dropping" : ""}`}
      onDrop={acceptsVideo ? onDrop : undefined}
      onDragOver={
        acceptsVideo
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropping(true);
            }
          : undefined
      }
      onDragLeave={acceptsVideo ? () => setDropping(false) : undefined}
    >
      <div className="node-head" style={{ background: CATEGORY_COLORS[spec.category] }}>
        <span className="node-name">{spec.label}</span>
        {spec.execution === "manual" && (
          <button
            className="node-run"
            title="Run this node — the only thing that spends GPU time"
            onClick={(e) => {
              e.stopPropagation();
              void runNode(id);
            }}
          >
            ▶
          </button>
        )}
        <button
          className={`node-badge${node.auto ? " on" : ""}`}
          title={node.auto ? "Auto: re-runs when inputs change" : "Paused: waits for an explicit run"}
          onClick={(e) => {
            e.stopPropagation();
            setNodeAuto(id, !node.auto);
          }}
        >
          {node.auto ? "A" : "P"}
        </button>
      </div>

      <div className="node-ports">
        {spec.inputs.map((port) => (
          <PortRow key={port.id} port={port} side="in" />
        ))}
        {spec.outputs.map((port) => (
          <PortRow key={port.id} port={port} side="out" />
        ))}
      </div>

      <div className="node-thumb">
        {shown?.thumbnailUrl ? (
          <img src={shown.thumbnailUrl} alt="" />
        ) : (
          <span className="node-thumb-empty">
            {loading
              ? "reading clip…"
              : acceptsVideo && !node.params.videoPath
                ? "drop a video, or"
                : (shown?.summary ?? "no output")}
          </span>
        )}
        {acceptsVideo && (
          <>
            {/*
              The OS file dialog, because dragging is the awkward path: the drop target is this
              card, and the Graph pane opens in a view that hides it. `nodrag` keeps React Flow
              from treating the click as the start of a node drag.
            */}
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                void loadVideo(e.target.files?.[0]);
                // Clearing lets the same file be picked again after a failure.
                e.target.value = "";
              }}
            />
            <button
              className="node-browse nodrag"
              disabled={loading}
              title="Choose a video file. It is copied to a temp dir so ffmpeg has a real path — browsers never expose one."
              onClick={(e) => {
                e.stopPropagation();
                fileInput.current?.click();
              }}
            >
              {node.params.videoPath ? "Change clip…" : "Browse…"}
            </button>
          </>
        )}
      </div>

      <div className="node-foot">
        <span className="ms" style={{ color: STATUS_COLOR[status] }} title={status}>
          {STATUS_GLYPH[status]} {runtime.elapsedMs.toFixed(1)}ms
        </span>
        {shown?.summary && shown.thumbnailUrl && <span className="node-sum">{shown.summary}</span>}
        {runtime.status === "error" && (
          <span className="node-err" title={runtime.error ?? ""}>
            error
          </span>
        )}
      </div>

      {dropError && <div className="node-err-line">{dropError}</div>}
    </div>
  );
}
