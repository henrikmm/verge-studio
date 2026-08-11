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
  activeMeasurementSubject,
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
  setFreeMeasurementMode,
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
import { ProvenanceBanner } from "./provenance";

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

function segmentationInstruction(objectId: string): string {
  switch (objectId) {
    case "table-top":
      return "Click the tabletop surface; the fitted floor plane supplies the lower reference automatically.";
    case "pc-tower":
      return "Click the complete PC tower from its tabletop contact to its top.";
    case "monitor-own":
      return "Click the monitor and stand. This frame can select them, but the hidden stand contact prevents a trustworthy automatic height.";
    case "monitor-top":
      return "Click the monitor screen; the fitted floor plane supplies the lower reference automatically.";
    default:
      return "Click the complete door leaf from bottom edge to top edge.";
  }
}

function reusePreparedFrame(current: PreparedSegmentationFrame | undefined) {
  return current
    ? {
        ...current,
        modelLoadMs: 0,
        modelLoadCached: true,
        frameEncodeMs: 0,
        frameEncodeCached: true,
      }
    : current;
}

function acceptanceLabel(accepted: boolean, validated: boolean, heightUnavailable: boolean) {
  if (accepted) {
    if (heightUnavailable) return "Accepted · height unavailable";
    return validated ? "Accepted" : "Accepted · experimental";
  }
  if (heightUnavailable) return "Accept mask · height unavailable";
  return validated
    ? "Accept mask → calculate height"
    : "Accept experimental mask → calculate height";
}

export function Depth2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ width: number; height: number }>();
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
  const [segmentationElapsedMs, setSegmentationElapsedMs] = useState(0);

  const graph = useGraph();
  const ui = useMeasurementUi();
  const incoming = resolveInput(graph, VIEWER_2D_ID, "depth");
  const field = incoming?.value as DepthFieldValue | undefined;
  const descriptor = field ? closestFrame(field, ui.canonicalFrame) : undefined;
  const namedObject = activeMeasurementObject();
  const object = activeMeasurementSubject();
  const mask = getMask();
  const reviewIssue = automaticMaskReviewIssue(mask);
  const automaticFixtureValidated = namedObject?.id === "door-leaf";
  const segmentBusy = segmentProgress?.phase === "loading" || segmentProgress?.phase === "encoding" || segmentProgress?.phase === "decoding";
  const segmentationTotalMs = mask?.segmentation
    ? (mask.segmentation.selectionDurationMs ?? 0) > 0
      ? mask.segmentation.selectionDurationMs
      : segmentationElapsedMs > 0
        ? segmentationElapsedMs
        : undefined
    : undefined;

  const syncMeasurementGraph = useCallback(() => {
    const active = activeMeasurementSubject();
    const currentMask = getMask();
    setNodeParams(BRUSH_SELECTION_ID, {
      objectId: active.id,
      canonicalFrame: ui.canonicalFrame,
      maskRevision: currentMask?.revision ?? 0,
      confidencePercentile: ui.confidencePercentile,
    });
    setNodeParams(MEASURE_HEIGHT_ID, { mode: active.mode });
    // null truth means "measurable but ungradable" — the node treats 0 as no grading.
    setNodeParams(SCALE_CHECK_ID, { truthM: active.truthM ?? 0 });
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
    segmentationStartedRef.current = undefined;
    setSegmentationElapsedMs(current?.segmentation?.selectionDurationMs ?? 0);
    setSegmentProgress(undefined);
    setSegmentError(undefined);
  }, [descriptor?.rgbUrl, object.id]);

  useEffect(() => {
    if (namedObject || tool !== "segment") return;
    setTool("brush");
    setErasing(false);
  }, [namedObject, tool]);

  useEffect(() => {
    if (descriptor && descriptor.canonicalIndex !== ui.canonicalFrame) {
      setMeasurementFrame(descriptor.canonicalIndex);
    }
  }, [descriptor, ui.canonicalFrame]);

  /**
   * How much room the frame has, measured rather than left to CSS.
   *
   * Sizing it by height alone let a landscape frame run off the side of the pane: the outdoor
   * run's 1024×576 frame drew 835 px wide inside a 427 px stage, so half of it was scrollable
   * but invisible with nothing on screen saying so. The portrait door fixture hid the bug —
   * 576×1024 fits a tall narrow pane by height, which is the one shape that already worked.
   *
   * Measured on the BORDER box, which a scrollbar does not change. Watching the content box
   * would feed the scrollbar back into the fit: it appears, takes 15 px away, the frame shrinks
   * to fit, the scrollbar goes, the frame grows, forever.
   */
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      // Floored: the stage is 505.33 px tall on the door fixture, and a frame fitted to the
      // third of a pixel the client box rounds away is a scrollbar on an image that fits.
      setStage(
        box
          ? { width: Math.floor(box.inlineSize), height: Math.floor(box.blockSize) }
          : { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) },
      );
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, []);

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
      // The one place hue is not negotiable: this overlay lies on photographic content,
      // and clip B's room is white walls. A neutral mask would vanish exactly where the
      // door is. Amber still means unreviewed, matching the rest of the app.
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
      // Include vs exclude reads as light vs dark, not as two hues. The white ring is
      // what separates either from the scene underneath.
      const positive = prompt.label === 1;
      ctx.fillStyle = positive ? "#f4f4f6" : "#17171a";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = positive ? "#17171a" : "#f4f4f6";
      ctx.font = "bold 14px ui-monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(positive ? "+" : "−", x, y + 0.5);
    }
  }, [arrays, descriptor, image, output, prompts, ui.masks, ui.overlayOpacity]);

  useEffect(() => {
    if (field) syncMeasurementGraph();
  }, [field, object.id, object.mode, object.truthM, syncMeasurementGraph]);

  // Show both brush time and complete automatic-selection time. The latter starts before model
  // setup/frame encoding and stops only on acceptance, so a fast decoder cannot hide cold-start
  // or operator-review cost.
  useEffect(() => {
    const tick = () => {
      const elapsed = paintElapsedMs();
      setPaintSeconds(elapsed === undefined ? undefined : Math.round(elapsed / 1000));
      if (segmentationStartedRef.current !== undefined) {
        setSegmentationElapsedMs(performance.now() - segmentationStartedRef.current);
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
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
      objectId: namedObject?.id ?? "",
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
    if (!descriptor) return;
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
    segmentationStartedRef.current ??= performance.now();
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
        modelLoadCached: preparedFrame.modelLoadCached,
        frameEncodeMs: preparedFrame.frameEncodeMs,
        frameEncodeCached: preparedFrame.frameEncodeCached,
        lastDecodeMs: result.decodeMs,
        correctionStrokes: 0,
        accepted: false,
      };
      if (!namedObject) return;
      setMaskData(namedObject.id, ui.canonicalFrame, result.width, result.height, best.data, {
        source: "model",
        segmentation,
      });
      const issue = automaticMaskReviewIssue(getMask(namedObject.id, ui.canonicalFrame));
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
      setPreparedFrame(reusePreparedFrame);
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
      const selectionDurationMs = performance.now() - started;
      const accepted = acceptActiveModelMask(selectionDurationMs);
      recordAttempt("accepted", accepted.segmentation);
      segmentationStartedRef.current = undefined;
      setSegmentationElapsedMs(selectionDurationMs);
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

  /**
   * The frame's size on screen. Zoom 1 is the whole frame, whatever its shape; every zoom above
   * that scales the same fit, so the slider is the only thing that ever produces a scrollbar.
   * Floored, because half a pixel of overflow is still a scrollbar.
   */
  const frameSize = useMemo(() => {
    if (!image || !stage || stage.width <= 0 || stage.height <= 0) return undefined;
    const fit = Math.min(stage.width / image.naturalWidth, stage.height / image.naturalHeight);
    return {
      width: Math.floor(image.naturalWidth * fit * ui.zoom),
      height: Math.floor(image.naturalHeight * fit * ui.zoom),
    };
  }, [image, stage, ui.zoom]);

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
        paneId="depth"
        onPause={() => setPaused((value) => !value)}
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
        hint={tool === "segment" ? segmentationInstruction(object.id) : object.maskInstruction}
      />
      <div className="brush-toolbar">
        <span className="tool-context"><b>{object.code}</b> {object.name}</span>
        {namedObject && <button
          className={`chip-toggle${tool === "segment" ? " on" : ""}`}
          disabled={segmentBusy}
          title="Load SlimSAM locally, then left-click the object and right-click exclusions"
          onClick={() => void chooseSegmentation()}
        >
          {segmentBusy ? "Working…" : "Segment"}
        </button>}
        {!namedObject && <span className="free-mode-choices" aria-label="Free measurement definition">
          <button
            className={`chip-toggle${object.mode === "vertical_extent" ? " on" : ""}`}
            onClick={() => setFreeMeasurementMode("vertical_extent")}
          >Extent</button>
          <button
            className={`chip-toggle${object.mode === "top_above_floor" ? " on" : ""}`}
            onClick={() => setFreeMeasurementMode("top_above_floor")}
          >Above floor</button>
        </span>}
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
            setSegmentationElapsedMs(0);
            setPreparedFrame(reusePreparedFrame);
            setPrompts([]);
            setSegmentError(undefined);
            clearActiveMask();
            syncMeasurementGraph();
          }}
        >Clear</button>
        <label>Mask <input aria-label="Mask opacity" type="range" min="0.1" max="0.9" step="0.05" value={ui.overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /></label>
        <label>Zoom <input aria-label="Canvas zoom" type="range" min="1" max="4" step="0.25" value={ui.zoom} onChange={(event) => setMeasurementZoom(Number(event.target.value))} /></label>
      </div>
      {(tool === "segment" || mask?.segmentation || segmentError) && (
        <div className="segment-toolbar">
          {segmentBusy ? (
            <span className="busy" role="status">
              {segmentProgress?.phase === "loading"
                ? `Loading SlimSAM${segmentProgress.percent === undefined ? "" : ` ${Math.round(segmentProgress.percent)}%`} · ${latency(segmentationElapsedMs)}`
                : segmentProgress?.phase === "encoding"
                  ? `Encoding this frame locally… ${latency(segmentationElapsedMs)}`
                  : `Refining mask locally… ${latency(segmentationElapsedMs)}`}
            </span>
          ) : preparedFrame && tool === "segment" ? (
            <span>Left-click object · right-click background · every click refines all candidates</span>
          ) : (
            <span>Automatic selection runs locally with WebGPU; brush selection remains available.</span>
          )}
          {mask?.segmentation && (
            <span className="segment-actions">
              <button
                className={`chip-toggle${mask.segmentation.accepted ? " accepted" : ""}`}
                disabled={mask.segmentation.accepted || !!reviewIssue || segmentBusy}
                title={reviewIssue ?? "Accept this reviewed mask and calculate RAW DA3 height"}
                onClick={acceptSegmentation}
              >
                {acceptanceLabel(
                  mask.segmentation.accepted,
                  automaticFixtureValidated,
                  !!namedObject?.availabilityNote,
                )}
              </button>
              <button className="pane-btn" disabled={segmentBusy || prompts.length === 0} onClick={undoSegmentationPrompt}>Undo click</button>
            </span>
          )}
          {mask?.segmentation && (
            <span className="mono">
              score {mask.segmentation.score.toFixed(2)} · margin {mask.segmentation.scoreMargin.toFixed(2)} · {mask.segmentation.prompts.length} clicks · setup {mask.segmentation.modelLoadCached ? "cached" : latency(mask.segmentation.modelLoadMs)} · frame encode {mask.segmentation.frameEncodeCached ? "cached" : latency(mask.segmentation.frameEncodeMs)} · last click {latency(mask.segmentation.lastDecodeMs)} · operator total {latency(segmentationTotalMs)}
              {mask.segmentation.correctionStrokes > 0 && ` · ${mask.segmentation.correctionStrokes} brush corrections`}
            </span>
          )}
          {(segmentError || reviewIssue) && <span className="segment-warning">{segmentError ?? reviewIssue}</span>}
          {mask?.segmentation && namedObject?.availabilityNote && (
            <span className="segment-warning">Mask selection is available, but automatic height is withheld: {namedObject.availabilityNote}</span>
          )}
          {mask?.segmentation && !automaticFixtureValidated && !namedObject?.availabilityNote && (
            <span className="segment-warning">Experimental on {object.code}: inspect the RGB mask and 3D highlight carefully; only B1 has fixture-validated automatic evidence.</span>
          )}
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
      <ProvenanceBanner field={field} />
      <div className="pane-body depth-stage">
        <div className="depth-scroll" ref={stageRef}>
          {field ? (
            <div
              className="depth-canvas-frame"
              style={
                frameSize ? { width: `${frameSize.width}px`, height: `${frameSize.height}px` } : undefined
              }
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
                  const beforeCorrection = getMask()?.segmentation;
                  if (beforeCorrection?.accepted && segmentationStartedRef.current === undefined) {
                    segmentationStartedRef.current =
                      performance.now() - (beforeCorrection.selectionDurationMs ?? 0);
                  }
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
            // One child: `.pane-empty` is a centring grid, so loose text nodes beside an
            // inline element would each become their own centred cell.
            <div className="pane-empty">
              <p>
                No depth field yet. In <b>Setup</b>: drop a clip, extract the frames, then Run.
                <br />
                To look at a run that already exists, pick one in <b>Runs</b>.
              </p>
            </div>
          )}
        </div>
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
