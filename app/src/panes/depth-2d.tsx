import { useEffect, useRef, useState } from "react";
import { parseNpz, percentile } from "../lib/npz";
import { turbo } from "../lib/turbo";

export function Depth2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("loading result.npz…");
  const [range, setRange] = useState<[number, number]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/roadside/result.npz");
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const arrays = await parseNpz(await res.arrayBuffer());
        if (cancelled) return;
        const { depth } = arrays;
        const [frames, h, w] = depth.shape;
        const frame0 = depth.data.subarray(0, h * w);
        const lo = percentile(frame0, 2);
        const hi = percentile(frame0, 98);

        const canvas = canvasRef.current!;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < h * w; i++) {
          const t = (frame0[i] - lo) / (hi - lo);
          const [r, g, b] = turbo(t);
          img.data[i * 4] = r;
          img.data[i * 4 + 1] = g;
          img.data[i * 4 + 2] = b;
          img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        setRange([lo, hi]);
        setStatus(`${w}×${h} · frame 1/${frames} · metric`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ramp = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
    .map((t) => `rgb(${turbo(t).join(",")})`)
    .join(",")})`;

  return (
    <div className="pane">
      <div className="pane-status">
        {error ? (
          <span style={{ color: "var(--accent-err)" }}>{error}</span>
        ) : (
          <span className="ok">{status}</span>
        )}
        <span className="hint">DA3 depth · turbo</span>
      </div>
      <div className="pane-body">
        <div className="depth-wrap">
          <canvas ref={canvasRef} />
        </div>
        {range && (
          <div className="depth-legend">
            <span>{range[0].toFixed(1)} m</span>
            <div className="ramp" style={{ background: ramp }} />
            <span>{range[1].toFixed(1)} m</span>
          </div>
        )}
      </div>
    </div>
  );
}
