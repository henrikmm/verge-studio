import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { runAuto, setNodeParams, useGraph, resolveInput } from "../graph/graph-store";
import {
  BRUSH_SELECTION_ID,
  MEASURE_HEIGHT_ID,
  SCALE_CHECK_ID,
  VIEWER_2D_ID,
} from "../graph/nodes";
import { arrayFrame, closestFrame, type DepthFieldValue } from "../measurement/depth-field";
import {
  activeMeasurementObject,
  clearActiveMask,
  ensureMask,
  getMask,
  paintMaskStroke,
  setBrushSize,
  setConfidencePercentile,
  setErasing,
  setMeasurementFrame,
  setMeasurementZoom,
  setOverlayOpacity,
  useMeasurementUi,
} from "../measurement/measurement-store";
import { percentile, type NpyArray } from "../lib/npz";
import { turbo } from "../lib/turbo";
import { OutputRow, PaneControls } from "./pane-chrome";

const OUTPUTS = [
  { id: "rgb", label: "RGB" },
  { id: "depth", label: "Depth" },
  { id: "confidence", label: "Confidence" },
];

function paintedPixels(mask: ReturnType<typeof getMask>): number {
  return mask ? mask.data.reduce((sum, value) => sum + value, 0) : 0;
}

export function Depth2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const liveTimerRef = useRef<number | undefined>(undefined);
  const [arrays, setArrays] = useState<Record<string, NpyArray>>();
  const [image, setImage] = useState<HTMLImageElement>();
  const [range, setRange] = useState<[number, number]>();
  const [error, setError] = useState<string>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [output, setOutput] = useState("rgb");

  const graph = useGraph();
  const ui = useMeasurementUi();
  const incoming = resolveInput(graph, VIEWER_2D_ID, "depth");
  const field = incoming?.value as DepthFieldValue | undefined;
  const descriptor = field ? closestFrame(field, ui.canonicalFrame) : undefined;
  const object = activeMeasurementObject();
  const mask = getMask();

  const syncMeasurementGraph = useCallback(() => {
    const active = activeMeasurementObject();
    const currentMask = getMask();
    setNodeParams(BRUSH_SELECTION_ID, {
      objectId: active.id,
      canonicalFrame: ui.canonicalFrame,
      maskRevision: currentMask?.revision ?? 0,
      confidencePercentile: ui.confidencePercentile,
    });
    setNodeParams(MEASURE_HEIGHT_ID, { mode: active.mode });
    setNodeParams(SCALE_CHECK_ID, { truthM: active.truthM });
    void runAuto();
  }, [ui.canonicalFrame, ui.confidencePercentile]);

  useEffect(() => {
    if (!field || paused) return;
    let cancelled = false;
    const started = performance.now();
    setError(undefined);
    setArrays(undefined);
    field
      .loadArrays()
      .then((loaded) => {
        if (cancelled) return;
        setArrays(loaded);
        setElapsedMs(performance.now() - started);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [field, paused]);

  useEffect(() => {
    if (!descriptor || paused) return;
    let cancelled = false;
    const next = new Image();
    next.onload = () => {
      if (cancelled) return;
      setImage(next);
      ensureMask(next.naturalWidth, next.naturalHeight);
    };
    next.onerror = () => {
      if (!cancelled) setError(`could not load RGB frame ${descriptor.canonicalIndex}`);
    };
    next.src = descriptor.rgbUrl;
    return () => {
      cancelled = true;
    };
  }, [descriptor, paused]);

  useEffect(() => {
    if (descriptor && descriptor.canonicalIndex !== ui.canonicalFrame) {
      setMeasurementFrame(descriptor.canonicalIndex);
    }
  }, [descriptor, ui.canonicalFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !descriptor) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (output === "rgb" || !arrays) {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      setRange(undefined);
    } else {
      const source = arrays[output] ?? arrays.depth;
      if (!source) return;
      const [, h, w] = source.shape;
      const values = arrayFrame(source, descriptor.npzIndex);
      const lo = percentile(values, 2);
      const hi = percentile(values, 98);
      const scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
      const scratchCtx = scratch.getContext("2d");
      if (!scratchCtx) return;
      const rendered = scratchCtx.createImageData(w, h);
      for (let i = 0; i < values.length; i++) {
        const [r, g, b] = turbo((values[i] - lo) / (hi - lo || 1));
        rendered.data[i * 4] = r;
        rendered.data[i * 4 + 1] = g;
        rendered.data[i * 4 + 2] = b;
        rendered.data[i * 4 + 3] = 255;
      }
      scratchCtx.putImageData(rendered, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
      setRange([lo, hi]);
    }

    const currentMask = getMask();
    if (currentMask && currentMask.width === canvas.width && currentMask.height === canvas.height) {
      const overlay = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const alpha = ui.overlayOpacity;
      for (let i = 0; i < currentMask.data.length; i++) {
        if (!currentMask.data[i]) continue;
        overlay.data[i * 4] = overlay.data[i * 4] * (1 - alpha) + 251 * alpha;
        overlay.data[i * 4 + 1] = overlay.data[i * 4 + 1] * (1 - alpha) + 113 * alpha;
        overlay.data[i * 4 + 2] = overlay.data[i * 4 + 2] * (1 - alpha) + 133 * alpha;
      }
      ctx.putImageData(overlay, 0, 0);
    }
  }, [arrays, descriptor, image, output, ui.masks, ui.overlayOpacity]);

  useEffect(() => {
    if (field) syncMeasurementGraph();
  }, [field, object.id, object.mode, object.truthM, syncMeasurementGraph]);

  const paintAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
    const from = lastPointRef.current ?? point;
    paintMaskStroke(from, point, ui.brushSize, ui.erasing || event.button === 2);
    lastPointRef.current = point;
    window.clearTimeout(liveTimerRef.current);
    liveTimerRef.current = window.setTimeout(syncMeasurementGraph, 120);
  };

  const framePosition = descriptor ? field?.frames.indexOf(descriptor) ?? 0 : 0;
  const unit = output === "depth" ? " m" : "";
  const status = field
    ? `${field.label} · frame ${descriptor?.canonicalIndex ?? "—"}/256 · NPZ ${(descriptor?.npzIndex ?? 0) + 1}/${field.frames.length}`
    : "no input";

  const ramp = useMemo(
    () =>
      `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
        .map((value) => `rgb(${turbo(value).join(",")})`)
        .join(",")})`,
    [],
  );

  return (
    <div className="pane measurement-canvas-pane">
      <PaneControls
        status={field ? (arrays ? "Running" : "Loading") : "Idle"}
        elapsedMs={elapsedMs}
        paused={paused}
        onPause={() => setPaused((value) => !value)}
        extra={
          error ? (
            <span style={{ color: "var(--accent-err)" }}>{error}</span>
          ) : (
            <span className="pane-note">{status}</span>
          )
        }
      />
      <OutputRow choices={OUTPUTS} active={output} onSelect={setOutput} hint={object.maskInstruction} />
      <div className="brush-toolbar">
        <span className="tool-context"><b>{object.code}</b> {object.name}</span>
        <button className={`chip-toggle${!ui.erasing ? " on" : ""}`} onClick={() => setErasing(false)}>Brush</button>
        <button className={`chip-toggle${ui.erasing ? " on" : ""}`} onClick={() => setErasing(true)}>Erase</button>
        <label>Size <input aria-label="Brush size" type="range" min="2" max="120" value={ui.brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
        <button className="pane-btn" onClick={() => { clearActiveMask(); syncMeasurementGraph(); }}>Clear</button>
        <label>Mask <input aria-label="Mask opacity" type="range" min="0.1" max="0.9" step="0.05" value={ui.overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /></label>
        <label>Zoom <input aria-label="Canvas zoom" type="range" min="1" max="4" step="0.25" value={ui.zoom} onChange={(event) => setMeasurementZoom(Number(event.target.value))} /></label>
      </div>
      <div className="frame-toolbar">
        <span>FRAME</span>
        <input
          aria-label="Measurement frame"
          type="range"
          min="0"
          max={Math.max(0, (field?.frames.length ?? 1) - 1)}
          value={framePosition}
          onChange={(event) => {
            const selected = field?.frames[Number(event.target.value)];
            if (selected) setMeasurementFrame(selected.canonicalIndex);
          }}
        />
        <span className="mono">{descriptor?.canonicalIndex ?? "—"} · {descriptor?.timestampS.toFixed(2) ?? "—"}s</span>
        <label>Drop low conf <input aria-label="Confidence percentile" type="range" min="0" max="80" step="5" value={ui.confidencePercentile} onChange={(event) => setConfidencePercentile(Number(event.target.value))} /></label>
        <span className="mono">{ui.confidencePercentile}%</span>
      </div>
      <div className="pane-body depth-stage">
        {field ? (
          <div
            className="depth-canvas-frame"
            style={{
              height: image ? `${ui.zoom * 100}%` : undefined,
              aspectRatio: image ? `${image.naturalWidth} / ${image.naturalHeight}` : undefined,
            }}
          >
            <canvas
              ref={canvasRef}
              className={ui.erasing ? "erasing" : "painting"}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                lastPointRef.current = undefined;
                paintAt(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) paintAt(event);
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                lastPointRef.current = undefined;
                syncMeasurementGraph();
              }}
            />
          </div>
        ) : (
          <div className="pane-empty">No depth field on the wire yet.</div>
        )}
        {range && field && (
          <div className="depth-legend">
            <span>{range[0].toFixed(2)}{unit}</span>
            <div className="ramp" style={{ background: ramp }} />
            <span>{range[1].toFixed(2)}{unit}</span>
          </div>
        )}
        {mask && <div className="mask-readout">{paintedPixels(mask).toLocaleString()} px selected</div>}
      </div>
    </div>
  );
}
