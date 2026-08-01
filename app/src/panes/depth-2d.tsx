/**
 * Depth 2D — a tap on the depth wire, straight off DA3Depth rather than through
 * PointCloud. Two views of the same wire, neither re-running the other.
 *
 * The npz is fetched from the manifest's artifact URL, so this reads a real cloud
 * run and the fixture through identical code.
 */

import { useEffect, useRef, useState } from "react";
import type { InferManifest } from "../lib/contract";
import { resolveInput, useGraph } from "../graph/graph-store";
import { VIEWER_2D_ID } from "../graph/nodes";
import { parseNpz, percentile } from "../lib/npz";
import { turbo } from "../lib/turbo";
import { OutputRow, PaneControls } from "./pane-chrome";

const OUTPUTS = [
  { id: "depth", label: "Depth" },
  { id: "confidence", label: "Confidence" },
];

export function Depth2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("no input");
  const [range, setRange] = useState<[number, number]>();
  const [error, setError] = useState<string>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [output, setOutput] = useState("depth");

  const graph = useGraph();
  const incoming = resolveInput(graph, VIEWER_2D_ID, "depth");
  const manifest = incoming?.value as InferManifest | undefined;
  const npzUrl = manifest?.artifacts.find((a) => a.kind === "npz")?.url;

  useEffect(() => {
    if (!npzUrl || paused) return;
    let cancelled = false;
    const started = performance.now();

    (async () => {
      try {
        setError(undefined);
        const res = await fetch(npzUrl);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const arrays = await parseNpz(await res.arrayBuffer());
        if (cancelled) return;

        const array = arrays[output] ?? arrays.depth;
        if (!array) throw new Error(`npz has no "${output}" array`);
        const [frames, h, w] = array.shape;
        const frame0 = array.data.subarray(0, h * w);
        const lo = percentile(frame0, 2);
        const hi = percentile(frame0, 98);

        const canvas = canvasRef.current!;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < h * w; i++) {
          const t = (frame0[i] - lo) / (hi - lo || 1);
          const [r, g, b] = turbo(t);
          img.data[i * 4] = r;
          img.data[i * 4 + 1] = g;
          img.data[i * 4 + 2] = b;
          img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        setRange([lo, hi]);
        setElapsedMs(performance.now() - started);
        setStatus(`${w}×${h} · frame 1/${frames} · ${output === "depth" ? "metric" : "conf"}`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [npzUrl, output, paused]);

  const ramp = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
    .map((t) => `rgb(${turbo(t).join(",")})`)
    .join(",")})`;

  const unit = output === "depth" ? " m" : "";

  return (
    <div className="pane">
      <PaneControls
        status={manifest ? "Running" : "Idle"}
        elapsedMs={elapsedMs}
        paused={paused}
        onPause={() => setPaused((p) => !p)}
        extra={
          error ? (
            <span style={{ color: "var(--accent-err)" }}>{error}</span>
          ) : (
            <span className="pane-note">{status}</span>
          )
        }
      />
      <OutputRow
        choices={OUTPUTS}
        active={output}
        onSelect={setOutput}
        hint="DA3 native npz, turbo colormap, 2–98th percentile"
      />
      <div className="pane-body">
        <div className="depth-wrap">
          {npzUrl ? (
            <canvas ref={canvasRef} />
          ) : (
            <div className="pane-empty">No depth field on the wire yet.</div>
          )}
        </div>
        {range && npzUrl && (
          <div className="depth-legend">
            <span>
              {range[0].toFixed(1)}
              {unit}
            </span>
            <div className="ramp" style={{ background: ramp }} />
            <span>
              {range[1].toFixed(1)}
              {unit}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
