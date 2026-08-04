/**
 * Inspector — bound to graph selection. Click a node, its parameters appear.
 *
 * The rows are generated from the selected node's `controls` schema, so a new node
 * type brings its own inspector with it. The GPU and Last-run sections stay global:
 * they describe the machine, not the node.
 */

import { useEffect, useState } from "react";
import {
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  MAX_MEASURED_FRAMES,
  planFrames,
  predictVram,
  type InferManifest,
} from "../lib/contract";
import { getGpu, shutdown, warmup } from "../lib/infer-client";
import { update, useSession } from "../lib/session-store";
import {
  isNodeStale,
  nodeById,
  runNode,
  setNodeAuto,
  setNodeParam,
  useGraph,
} from "../graph/graph-store";
import { REGISTRY } from "../graph/nodes";
import type { ControlSpec } from "../graph/types";
import type { DepthFieldValue } from "../measurement/depth-field";

function Row({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="inspector-row">
      <span className="k">{k}</span>
      <span className="v" title={title ?? v}>
        {v}
      </span>
    </div>
  );
}

/**
 * Fraction of the measured L4 budget. Neutral while there is headroom, amber past 75%,
 * red past 92% — the two thresholds that matter are the only ones that take a hue.
 */
function VramBar({ used, total, label }: { used: number; total: number; label: string }) {
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  const tone =
    fraction > 0.92
      ? "var(--accent-err)"
      : fraction > 0.75
        ? "var(--accent-busy)"
        : "var(--emph)";
  return (
    <div className="vram">
      <div className="vram-head">
        <span className="k">{label}</span>
        <span className="v num">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="vram-track">
        <div className="vram-fill" style={{ width: `${fraction * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

function Control({
  spec,
  value,
  onChange,
}: {
  spec: ControlSpec;
  value: unknown;
  onChange: (v: string | number | boolean) => void;
}) {
  if (spec.kind === "readout") {
    const text =
      typeof value === "number" ? value.toFixed(2) : String(value || "").split("/").pop() || "—";
    return <Row k={spec.label} v={text} title={String(value ?? "")} />;
  }

  if (spec.kind === "select") {
    return (
      <div className="inspector-row control">
        <span className="k">{spec.label}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.kind === "checkbox") {
    return (
      <div className="inspector-row control">
        <span className="k">{spec.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="v num">{value ? "on" : "off"}</span>
      </div>
    );
  }

  return (
    <div className="inspector-row control">
      <span className="k">{spec.label}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        value={Number(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="v num">
        {Number(value)}
        {spec.suffix ?? ""}
      </span>
    </div>
  );
}

export function Inspector() {
  const session = useSession();
  const graph = useGraph();
  const [busy, setBusy] = useState(false);

  const selected = graph.selectedId ? nodeById(graph, graph.selectedId) : undefined;
  const spec = selected ? REGISTRY[selected.type] : undefined;
  const runtime = selected ? graph.runtime[selected.id] : undefined;
  const stale = selected ? isNodeStale(graph, selected.id) : false;

  // The frame plan belongs to the source node: it owns the clip and the sampling rate.
  const source = nodeById(graph, "frame-source");
  const durationS = Number(source?.params.durationS ?? 0);
  const plan = planFrames(
    Number(source?.params.fps ?? 10),
    durationS,
    Number(source?.params.maxFrames ?? 32),
  );
  const depthNode = nodeById(graph, "da3-depth");
  const vram = predictVram(plan.count, Number(depthNode?.params.processRes ?? 504));

  const lastField = (graph.runtime["da3-depth"]?.outputs?.depth?.value ?? null) as
    | DepthFieldValue
    | null;
  const lastRun: InferManifest | null = lastField?.manifest ?? null;

  const { gpu } = session;

  // Poll GPU telemetry: fast while a run is in flight so the bar actually moves,
  // slow when idle so a warm cloud instance is not kept busy for nothing.
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      try {
        const snapshot = await getGpu();
        if (!cancelled) update({ gpu: snapshot });
      } catch {
        if (!cancelled) update({ gpu: null });
      }
      if (!cancelled) timer = window.setTimeout(tick, graph.running ? 250 : 4000);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graph.running]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    update({ error: null });
    try {
      await fn();
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <div className="pane-status">
        <span className={gpu?.available ? "ok" : ""}>{gpu?.deviceName ?? "no GPU"}</span>
        <span className="hint">{selected ? spec?.label : "no selection"}</span>
      </div>
      <div className="pane-body inspector">
        {selected && spec ? (
          <>
            <div className="inspector-section">
              <h3>{spec.label}</h3>
              <Row k="Status" v={stale ? "stale" : (runtime?.status ?? "idle")} />
              <Row k="Elapsed" v={`${(runtime?.elapsedMs ?? 0).toFixed(1)} ms`} />
              <Row
                k="Cache key"
                v={(graph.desiredKeys[selected.id] ?? "").slice(0, 12) || "—"}
                title={graph.desiredKeys[selected.id]}
              />
              <div className="inspector-row control">
                <span className="k">Mode</span>
                <input
                  type="checkbox"
                  checked={selected.auto}
                  onChange={(e) => setNodeAuto(selected.id, e.target.checked)}
                />
                <span className="v num">{selected.auto ? "auto" : "paused"}</span>
              </div>
              {runtime?.error && <div className="inspector-note error">{runtime.error}</div>}
            </div>

            {spec.controls && spec.controls.length > 0 && (
              <div className="inspector-section">
                <h3>Parameters</h3>
                {spec.controls.map((control) => (
                  <Control
                    key={control.key}
                    spec={control}
                    value={selected.params[control.key]}
                    onChange={(v) => setNodeParam(selected.id, control.key, v)}
                  />
                ))}
                {spec.execution === "manual" && (
                  <div className="inspector-actions">
                    <button
                      disabled={graph.running}
                      onClick={() => void runNode(selected.id)}
                      title="The only control that spends GPU time"
                    >
                      Run {spec.label}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="inspector-section">
            <h3>Inspector</h3>
            <Row k="—" v="select a node" />
          </div>
        )}

        <div className="inspector-section">
          <h3>Frame plan</h3>
          {durationS > 0 ? (
            <>
              <Row k="Frames" v={`${plan.count}`} />
              <Row k="Effective FPS" v={plan.effectiveFps.toFixed(2)} />
              <VramBar
                used={vram.bytes}
                total={L4_TOTAL_VRAM_BYTES}
                label={vram.measured ? "VRAM (measured)" : "VRAM (interpolated)"}
              />
              {plan.count > MAX_MEASURED_FRAMES && (
                <div className="inspector-note">
                  Beyond {MAX_MEASURED_FRAMES} frames is extrapolated — the sweep has not run
                  that high. Peak VRAM here is a projection, not a measurement.
                </div>
              )}
              {vram.bytes > L4_TOTAL_VRAM_BYTES && (
                <div className="inspector-note">
                  Projected over the L4's {formatBytes(L4_TOTAL_VRAM_BYTES)} — expect an OOM.
                  Lower the frame cap or the process resolution.
                </div>
              )}
              {plan.capped && (
                <div className="inspector-note">
                  {Number(source?.params.fps)} fps × {durationS.toFixed(1)}s ={" "}
                  {Math.floor(Number(source?.params.fps) * durationS)} frames, over the{" "}
                  {Number(source?.params.maxFrames)}-frame cap. FPS lowered to{" "}
                  {plan.effectiveFps.toFixed(2)} so the frames still span the whole clip.
                </div>
              )}
            </>
          ) : (
            <Row k="—" v="no clip loaded" />
          )}
        </div>

        <div className="inspector-section">
          <h3>GPU</h3>
          {gpu ? (
            <>
              <VramBar
                used={gpu.busy ? gpu.currentBytes : gpu.peakBytes}
                total={gpu.totalBytes}
                label={gpu.busy ? "VRAM live" : "VRAM peak"}
              />
              <Row k="State" v={gpu.busy ? "busy" : gpu.modelLoaded ? "warm" : "cold"} />
            </>
          ) : (
            <Row k="State" v="unreachable" />
          )}
          <div className="inspector-actions">
            <button disabled={busy} onClick={() => act(async () => void (await warmup()))}>
              Warm up
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => act(async () => void (await shutdown()))}
            >
              Release
            </button>
          </div>
        </div>

        <div className="inspector-section">
          <h3>Last run</h3>
          {lastRun ? (
            <>
              <Row k="Frames" v={`${lastRun.frames.count}`} />
              <Row k="GPU time" v={`${lastRun.timing.gpuSeconds.toFixed(2)} s`} />
              <Row k="Wall" v={`${lastRun.timing.wallSeconds.toFixed(2)} s`} />
              <Row k="Peak VRAM" v={formatBytes(lastRun.vram.peakBytes)} />
              <Row k="Model" v={lastRun.modelRevision.slice(0, 8)} />
            </>
          ) : (
            <Row k="—" v="no run yet" />
          )}
        </div>

        {session.error && <div className="inspector-note error">{session.error}</div>}
      </div>
    </div>
  );
}
