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
  acceptActiveModelMask,
  activeMeasurementObject,
  automaticMaskReviewIssue,
  beginMaskCorrection,
  clearActiveMask,
  ensureMask,
  getMask,
  paintElapsedMs,
  paintMaskStroke,
  recordSegmentationAttempt,
  setBrushSize,
  setConfidencePercentile,
  setErasing,
  setMeasurementFrame,
  setMeasurementZoom,
  setOverlayOpacity,
  setMaskData,
  useMeasurementUi,
  type SegmentationProvenance,
} from "../measurement/measurement-store";
import {
  SEGMENTATION_MODEL_ID,
  SEGMENTATION_MODEL_REVISION,
  SEGMENTATION_RUNTIME,
  prepareSegmentationFrame,
  segmentPreparedFrame,
  type PreparedSegmentationFrame,
  type SegmentPrompt,
  type SegmenterProgress,
} from "../measurement/segmenter";
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

type SelectionTool = "segment" | "brush" | "erase";

function latency(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function Depth2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const liveTimerRef = useRef<number | undefined>(undefined);
  const segmentationRequestRef = useRef(0);
  const segmentationStartedRef = useRef<number | undefined>(undefined);
  const segmentationAttemptRef = useRef<string | undefined>(undefined);
  const [arrays, setArrays] = useState<Record<string, NpyArray>>();
  const [image, setImage] = useState<HTMLImageElement>();
  const [range, setRange] = useState<[number, number]>();
  const [error, setError] = useState<string>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [output, setOutput] = useState("rgb");
  const [paintSeconds, setPaintSeconds] = useState<number>();
  const [tool, setTool] = useState<SelectionTool>("brush");
  const [preparedFrame, setPreparedFrame] = useState<PreparedSegmentationFrame>();
  const [prompts, setPrompts] = useState<SegmentPrompt[]>([]);
  const [segmentProgress, setSegmentProgress] = useState<SegmenterProgress>();
  const [segmentError, setSegmentError] = useState<string>();

  const graph = useGraph();
  const ui = useMeasurementUi();
  const incoming = resolveInput(graph, VIEWER_2D_ID, "depth");
  const field = incoming?.value as DepthFieldValue | undefined;
  const descriptor = field ? closestFrame(field, ui.canonicalFrame) : undefined;
  const object = activeMeasurementObject();
  const mask = getMask();
  const reviewIssue = automaticMaskReviewIssue(mask);
  const segmentBusy = segmentProgress?.phase === "loading" || segmentProgress?.phase === "encoding" || segmentProgress?.phase === "decoding";

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
    segmentationRequestRef.current += 1;
    setPreparedFrame(undefined);
    const current = getMask();
    setPrompts(current?.segmentation?.prompts ?? []);
    segmentationAttemptRef.current = current?.segmentation?.attemptId;
    setSegmentProgress(undefined);
    setSegmentError(undefined);
  }, [descriptor?.rgbUrl, object.id]);

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
      const overlayColor = currentMask.segmentation
        ? currentMask.segmentation.accepted
          ? [45, 212, 191]
          : [251, 191, 36]
        : [251, 113, 133];
      for (let i = 0; i < currentMask.data.length; i++) {
        if (!currentMask.data[i]) continue;
        overlay.data[i * 4] = overlay.data[i * 4] * (1 - alpha) + overlayColor[0] * alpha;
        overlay.data[i * 4 + 1] = overlay.data[i * 4 + 1] * (1 - alpha) + overlayColor[1] * alpha;
        overlay.data[i * 4 + 2] = overlay.data[i * 4 + 2] * (1 - alpha) + overlayColor[2] * alpha;
      }
      ctx.putImageData(overlay, 0, 0);
    }

    for (const prompt of prompts) {
      const x = prompt.x * canvas.width;
      const y = prompt.y * canvas.height;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = prompt.label === 1 ? "#2dd4bf" : "#fb7185";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#07100f";
      ctx.font = "bold 14px ui-monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(prompt.label === 1 ? "+" : "−", x, y + 0.5);
    }
  }, [arrays, descriptor, image, output, prompts, ui.masks, ui.overlayOpacity]);

  useEffect(() => {
    if (field) syncMeasurementGraph();
  }, [field, object.id, object.mode, object.truthM, syncMeasurementGraph]);

  // Time-to-measure, shown live so the operator can see what a trial is costing. The clock
  // itself lives in the store; this only polls it. Setting the same value is a no-op render,
  // so a single interval with no dependencies is cheaper than restarting one per stroke.
  useEffect(() => {
    const tick = () => {
      const elapsed = paintElapsedMs();
      setPaintSeconds(elapsed === undefined ? undefined : Math.round(elapsed / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const attemptId = () => {
    segmentationAttemptRef.current ??=
      `segment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return segmentationAttemptRef.current;
  };

  const recordAttempt = (
    outcome: "proposed" | "accepted" | "abstained" | "failed",
    evidence: SegmentationProvenance | undefined,
    reason?: string,
  ) => {
    recordSegmentationAttempt({
      id: evidence?.attemptId ?? attemptId(),
      objectId: object.id,
      canonicalFrame: ui.canonicalFrame,
      outcome,
      reason,
      modelId: evidence?.modelId ?? SEGMENTATION_MODEL_ID,
      modelRevision: evidence?.modelRevision ?? SEGMENTATION_MODEL_REVISION,
      promptCount: evidence?.prompts.length ?? prompts.length,
      positivePrompts: (evidence?.prompts ?? prompts).filter((prompt) => prompt.label === 1).length,
      correctionStrokes: evidence?.correctionStrokes ?? 0,
      score: evidence?.score,
      scoreMargin: evidence?.scoreMargin,
      modelLoadMs: evidence?.modelLoadMs,
      frameEncodeMs: evidence?.frameEncodeMs,
      lastDecodeMs: evidence?.lastDecodeMs,
      selectionDurationMs: evidence?.selectionDurationMs,
    });
  };

  const chooseSegmentation = async () => {
    if (!descriptor || object.id !== "door-leaf") return;
    setTool("segment");
    setErasing(false);
    setSegmentError(undefined);
    if (!getMask()?.segmentation) {
      segmentationAttemptRef.current = undefined;
      attemptId();
      segmentationStartedRef.current = performance.now();
    }
    if (preparedFrame?.imageUrl === descriptor.rgbUrl) return;
    attemptId();
    segmentationStartedRef.current ??= performance.now();
    const request = ++segmentationRequestRef.current;
    try {
      const prepared = await prepareSegmentationFrame(descriptor.rgbUrl, setSegmentProgress);
      if (request !== segmentationRequestRef.current) return;
      setPreparedFrame(prepared);
      setSegmentProgress({ phase: "ready" });
    } catch (reason) {
      if (request !== segmentationRequestRef.current) return;
      setSegmentProgress(undefined);
      setSegmentError(reason instanceof Error ? reason.message : String(reason));
      recordAttempt("failed", undefined, reason instanceof Error ? reason.message : String(reason));
      setTool("brush");
    }
  };

  const proposeMask = async (nextPrompts: SegmentPrompt[]) => {
    if (!preparedFrame || segmentBusy) return;
    const request = ++segmentationRequestRef.current;
    setPrompts(nextPrompts);
    setSegmentError(undefined);
    try {
      const result = await segmentPreparedFrame(preparedFrame, nextPrompts, setSegmentProgress);
      if (request !== segmentationRequestRef.current) return;
      const scores = result.candidates.map((candidate) => candidate.score);
      const rankedScores = [...scores].sort((a, b) => b - a);
      const best = result.candidates[result.bestIndex];
      const segmentation: SegmentationProvenance = {
        attemptId: attemptId(),
        modelId: SEGMENTATION_MODEL_ID,
        modelRevision: SEGMENTATION_MODEL_REVISION,
        runtime: SEGMENTATION_RUNTIME,
        device: "webgpu",
        prompts: nextPrompts.map((prompt) => ({ ...prompt })),
        candidateScores: scores,
        selectedCandidate: result.bestIndex,
        score: best.score,
        scoreMargin: best.score - (rankedScores[1] ?? 0),
        boundaryFraction: result.boundaryFraction,
        modelLoadMs: preparedFrame.modelLoadMs,
        frameEncodeMs: preparedFrame.frameEncodeMs,
        lastDecodeMs: result.decodeMs,
        correctionStrokes: 0,
        accepted: false,
      };
      setMaskData(object.id, ui.canonicalFrame, result.width, result.height, best.data, {
        source: "model",
        segmentation,
      });
      const issue = automaticMaskReviewIssue(getMask(object.id, ui.canonicalFrame));
      recordAttempt(issue ? "abstained" : "proposed", segmentation, issue);
      setSegmentProgress({ phase: "ready" });
      syncMeasurementGraph();
    } catch (reason) {
      if (request !== segmentationRequestRef.current) return;
      setSegmentProgress({ phase: "ready" });
      setSegmentError(reason instanceof Error ? reason.message : String(reason));
      recordAttempt("failed", undefined, reason instanceof Error ? reason.message : String(reason));
    }
  };

  const undoSegmentationPrompt = () => {
    const next = prompts.slice(0, -1);
    setPrompts(next);
    if (!next.some((prompt) => prompt.label === 1)) {
      recordAttempt("abstained", getMask()?.segmentation, "cleared before acceptance");
      clearActiveMask();
      segmentationAttemptRef.current = undefined;
      segmentationStartedRef.current = undefined;
      syncMeasurementGraph();
      return;
    }
    void proposeMask(next);
  };

  const acceptSegmentation = () => {
    try {
      const started = segmentationStartedRef.current ?? performance.now();
      const accepted = acceptActiveModelMask(performance.now() - started);
      recordAttempt("accepted", accepted.segmentation);
      setSegmentError(undefined);
      syncMeasurementGraph();
    } catch (reason) {
      setSegmentError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const paintAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event);
    if (!point) return;
    const from = lastPointRef.current ?? point;
    paintMaskStroke(from, point, ui.brushSize, tool === "erase" || event.button === 2);
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
        <button
          className={`chip-toggle${tool === "segment" ? " on" : ""}`}
          disabled={segmentBusy || object.id !== "door-leaf"}
          title={object.id === "door-leaf" ? "Load SlimSAM locally, then left-click the object and right-click exclusions" : "M3c automatic height is fixture-validated for B1 only"}
          onClick={() => void chooseSegmentation()}
        >
          {segmentBusy ? "Working…" : "Segment"}
        </button>
        <button className={`chip-toggle${tool === "brush" ? " on" : ""}`} onClick={() => { setTool("brush"); setErasing(false); }}>Brush</button>
        <button className={`chip-toggle${tool === "erase" ? " on" : ""}`} onClick={() => { setTool("erase"); setErasing(true); }}>Erase</button>
        <label>Size <input aria-label="Brush size" type="range" min="2" max="120" value={ui.brushSize} disabled={tool === "segment"} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
        <button
          className="pane-btn"
          onClick={() => {
            segmentationRequestRef.current += 1;
            if (mask?.segmentation && !mask.segmentation.accepted) {
              recordAttempt("abstained", mask.segmentation, "cleared before acceptance");
            }
            segmentationAttemptRef.current = undefined;
            segmentationStartedRef.current = undefined;
            setPrompts([]);
            setSegmentError(undefined);
            clearActiveMask();
            syncMeasurementGraph();
          }}
        >Clear</button>
        {mask?.segmentation && (
          <>
            <button className="pane-btn" disabled={segmentBusy || prompts.length === 0} onClick={undoSegmentationPrompt}>Undo click</button>
            <button
              className={`chip-toggle${mask.segmentation.accepted ? " accepted" : ""}`}
              disabled={mask.segmentation.accepted || !!reviewIssue || segmentBusy}
              title={reviewIssue ?? "Accept this reviewed mask and allow the height pipeline to run"}
              onClick={acceptSegmentation}
            >
              {mask.segmentation.accepted ? "Accepted" : "Accept mask"}
            </button>
          </>
        )}
        <label>Mask <input aria-label="Mask opacity" type="range" min="0.1" max="0.9" step="0.05" value={ui.overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /></label>
        <label>Zoom <input aria-label="Canvas zoom" type="range" min="1" max="4" step="0.25" value={ui.zoom} onChange={(event) => setMeasurementZoom(Number(event.target.value))} /></label>
      </div>
      {(tool === "segment" || mask?.segmentation || segmentError) && (
        <div className="segment-toolbar" role="status">
          {segmentBusy ? (
            <span className="busy">
              {segmentProgress?.phase === "loading"
                ? `Loading SlimSAM${segmentProgress.percent === undefined ? "" : ` ${Math.round(segmentProgress.percent)}%`}`
                : segmentProgress?.phase === "encoding"
                  ? "Encoding this frame locally…"
                  : "Refining mask locally…"}
            </span>
          ) : preparedFrame && tool === "segment" ? (
            <span>Left-click object · right-click background · every click refines all candidates</span>
          ) : (
            <span>Automatic selection runs locally with WebGPU; brush selection remains available.</span>
          )}
          {mask?.segmentation && (
            <span className="mono">
              score {mask.segmentation.score.toFixed(2)} · margin {mask.segmentation.scoreMargin.toFixed(2)} · {mask.segmentation.prompts.length} clicks · load {latency(mask.segmentation.modelLoadMs)} · encode {latency(mask.segmentation.frameEncodeMs)} · refine {latency(mask.segmentation.lastDecodeMs)}
              {mask.segmentation.correctionStrokes > 0 && ` · ${mask.segmentation.correctionStrokes} brush corrections`}
            </span>
          )}
          {(segmentError || reviewIssue) && <span className="segment-warning">{segmentError ?? reviewIssue}</span>}
        </div>
      )}
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
              className={tool === "segment" ? "segmenting" : tool === "erase" ? "erasing" : "painting"}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                if (tool === "segment") {
                  if (!preparedFrame || segmentBusy) return;
                  const point = canvasPoint(event);
                  const canvas = canvasRef.current;
                  if (!point || !canvas) return;
                  const next = [
                    ...prompts,
                    {
                      x: point.x / canvas.width,
                      y: point.y / canvas.height,
                      label: event.button === 2 ? 0 : 1,
                    } as SegmentPrompt,
                  ];
                  void proposeMask(next);
                  return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                lastPointRef.current = undefined;
                beginMaskCorrection();
                const correction = getMask()?.segmentation;
                if (correction) {
                  recordAttempt("abstained", correction, "brush correction awaiting acceptance");
                }
                paintAt(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) paintAt(event);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
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
        {mask && (
          <div className="mask-readout">
            {mask.source} · {paintedPixels(mask).toLocaleString()} px selected
            {mask.segmentation && ` · ${mask.segmentation.accepted ? "accepted" : "review required"}`}
            {paintSeconds !== undefined && ` · ${paintSeconds}s`}
          </div>
        )}
      </div>
    </div>
  );
}
