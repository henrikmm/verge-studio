import { useEffect, useMemo, useRef, useState } from "react";
import {
  composeUncertainty,
  fitErrorModel,
  UNCERTAINTY_LIMITATION,
  type ErrorModel,
  type UncertaintyBudget,
} from "../../../geometry";
import { invalidateFrom, isNodeStale, runAuto, setNodeParam, setNodeParams, useGraph } from "../graph/graph-store";
import { DEFAULT_RUN_ID } from "../graph/nodes/fixture-run";
import {
  BRUSH_SELECTION_ID,
  FIXTURE_RUN_ID,
  GROUND_PLANE_ID,
  MEASURE_HEIGHT_ID,
  POINT_CLOUD_ID,
  SCALE_CHECK_ID,
  type GroundPlaneValue,
  type MeasurementValue,
  type PointCloudValue,
  type SelectionValue,
} from "../graph/nodes";
import { FIXTURE_SETTINGS, builtinRunId, closestFrame, type DepthFieldValue } from "../measurement/depth-field";
import type { RunId } from "../lib/runs";
import { useRuns } from "../lib/runs-store";
import { useAdvanced } from "../lib/ui-mode";
import {
  MEASUREMENT_EVIDENCE_SCHEMA,
  archiveTargetEvidence,
  deleteMeasurementEvidence,
  listMeasurementEvidence,
  measurementEvidenceId,
  recoveredObservation,
  saveMeasurementEvidence,
  type MeasurementEvidencePacket,
} from "../measurement/evidence";
import { HelpDot } from "./help";
import {
  BUILTIN_DOOR_CLIP,
  MIN_TRIALS_FOR_SPREAD,
  addTarget,
  ensureTargets,
  measurementObjects,
  measurementObjectForClip,
  newTargetId,
  nextTargetCode,
  removeTarget,
  setActiveClip,
  activeMeasurementObject,
  activeMeasurementSubject,
  addObservation,
  currentSittingId,
  duplicateMaskTrialIds,
  exportMeasurementSession,
  getMask,
  mergeObservations,
  removeObservation,
  sessionPersistError,
  setActiveMeasurementObject,
  setBlind,
  setFocusedTrial,
  setFreeMeasurement,
  segmentationAttemptStats,
  trialIdentity,
  trialStats,
  trialsFor,
  useMeasurementUi,
  type MeasurementMode,
  type MaskSnapshot,
  type MeasurementObservation,
  type MeasurementObject,
} from "../measurement/measurement-store";
import type { RunRecord } from "../lib/runs";
import { PaneShare } from "./pane-chrome";

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/**
 * Every aggregate below reads the mean across an object's repeat trials, never a single
 * recording. With one trial this is the old behaviour; with three it is the number the
 * repeatability study exists to produce.
 */
function objectMean(observations: readonly MeasurementObservation[], objectId: string, runId?: RunId): number {
  return trialStats(observations, objectId, runId).meanM;
}

/**
 * The uncertainty budget for one object at one setting.
 *
 * Deliberately built from the object's TRIALS rather than from the live measurement: patch
 * roughness alone was what the app used to display, and it is the smallest term in this
 * project by an order of magnitude. `model` carries the clip's fitted scale, which is where
 * nearly all of the remaining error lives.
 */
function objectBudget(
  observations: readonly MeasurementObservation[],
  objectId: string,
  runId: RunId,
  model?: ErrorModel,
): UncertaintyBudget {
  const stats = trialStats(observations, objectId, runId);
  const trials = trialsFor(observations, objectId, runId);
  return composeUncertainty({
    valueM: stats.meanM,
    patchRoughnessM: mean(trials.map((trial) => trial.internalSpreadM)),
    operatorRangeM: stats.n >= MIN_TRIALS_FOR_SPREAD ? stats.rangeM : undefined,
    model,
  });
}

/** The ± a reading may honestly carry: post-calibration total, or the random term alone. */
function statedUncertainty(budget: UncertaintyBudget): number {
  return budget.calibrated ? budget.calibratedUncertaintyM : budget.randomM;
}

/**
 * Blind mode's stand-in for a reading.
 *
 * A repeat trial painted with the previous answer on screen converges on it, so nothing derived
 * from a measurement may be displayed while blind. Truths stay visible: the operator measured
 * them with their own tape and hiding them would be theatre, not independence.
 */
const VEILED = "•••";

function veil(blind: boolean, text: string): string {
  return blind ? VEILED : text;
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "—";
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(0)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

/**
 * The clip's calibration target: the longest object whose truth is actually known.
 *
 * This was hardcoded to the door's 2.10 m. Longest wins because the same absolute endpoint
 * error is a smaller fraction of a longer reference — clip B's door is 2.8x less fractional
 * error than its table for the same slip (see MEASUREMENTS.md).
 */
function calibrationTarget(targets: readonly MeasurementObject[]): MeasurementObject | undefined {
  return targets
    .filter((item) => item.truthM !== null && !item.availabilityNote)
    .sort((a, b) => (b.truthM ?? 0) - (a.truthM ?? 0))[0];
}

function clipScaleFactor(
  observations: readonly MeasurementObservation[],
  runId: RunId,
  targets: readonly MeasurementObject[],
): number {
  const target = calibrationTarget(targets);
  if (!target || target.truthM === null) return NaN;
  const raw = objectMean(observations, target.id, runId);
  return Number.isFinite(raw) && raw > 0 ? target.truthM / raw : NaN;
}

function correctedValue(raw: number, factor: number): number {
  if (!Number.isFinite(raw)) return NaN;
  // A multiplicative metric-scale correction applies to lengths regardless of where
  // their endpoints sit. It does not move the floor or add an offset.
  return Number.isFinite(factor) ? raw * factor : NaN;
}

function formatM(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(3)} m` : "—";
}

function evidencePacket(
  run: RunRecord,
  target: MeasurementObject | null,
  observation: MeasurementObservation,
  live?: MeasurementEvidencePacket["live"],
): MeasurementEvidencePacket {
  return {
    schemaVersion: MEASUREMENT_EVIDENCE_SCHEMA,
    evidenceId: measurementEvidenceId(observation),
    runId: run.id,
    run: {
      id: run.id,
      label: run.label,
      clipName: run.clipName,
      clipSha256: run.clipSha256,
      createdAt: run.createdAt,
      frameCount: run.frameCount,
      processRes: run.processRes,
    },
    target,
    observation,
    ...(live ? { live } : {}),
  };
}

/**
 * The preview fits inside this box, in CSS pixels — a portrait frame is 576×1024, so sizing by
 * width alone gave a 391 px tall thumbnail that ran off the bottom of the pane.
 */
const FROZEN_MASK_BOX = 200;

/**
 * A recorded trial's brush, drawn from the run-length pairs frozen with it.
 *
 * Read-only on purpose. A frozen mask is evidence of a measurement that already happened, so it
 * must never become the working mask: painting from it would produce a repeat trial that repeats
 * the code rather than the measuring, which is the thing `duplicateMaskTrialIds` exists to catch.
 */
function FrozenMask({ mask, frameUrl }: { mask: MaskSnapshot; frameUrl?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Same colours as the live overlay in Depth 2D, so a trial's brush looks like the brush.
    const colour = mask.segmentation
      ? mask.segmentation.accepted
        ? [45, 212, 191]
        : [251, 191, 36]
      : [251, 113, 133];
    const scratch = document.createElement("canvas");
    scratch.width = mask.width;
    scratch.height = mask.height;
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) return;
    const painted = scratchCtx.createImageData(mask.width, mask.height);
    for (let i = 0; i + 1 < mask.runs.length; i += 2) {
      const end = mask.runs[i] + mask.runs[i + 1];
      for (let pixel = mask.runs[i]; pixel < end; pixel++) {
        painted.data[pixel * 4] = colour[0];
        painted.data[pixel * 4 + 1] = colour[1];
        painted.data[pixel * 4 + 2] = colour[2];
        painted.data[pixel * 4 + 3] = 210;
      }
    }
    scratchCtx.putImageData(painted, 0, 0);

    let cancelled = false;
    const draw = (frame?: HTMLImageElement) => {
      if (cancelled) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (frame) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      else {
        ctx.fillStyle = "#17171a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    };

    if (!frameUrl) {
      draw();
      return;
    }
    const frame = new Image();
    // The frame is a nicety: without it the brush still reads as a silhouette, which is enough
    // to tell two trials apart.
    frame.onload = () => draw(frame);
    frame.onerror = () => draw();
    frame.src = frameUrl;
    return () => {
      cancelled = true;
    };
  }, [mask, frameUrl]);

  const fit = Math.min(FROZEN_MASK_BOX / mask.width, FROZEN_MASK_BOX / mask.height);
  return (
    <figure className="trial-mask">
      <canvas
        ref={canvasRef}
        width={Math.round(mask.width * fit)}
        height={Math.round(mask.height * fit)}
      />
      <figcaption className="mono">
        {mask.paintedPixels.toLocaleString()} px · {mask.width}×{mask.height} · {mask.digest}
      </figcaption>
    </figure>
  );
}

function selectObject(object: MeasurementObject): void {
  setActiveMeasurementObject(object.id);
  const mask = getMask(object.id, object.suggestedFrame);
  setNodeParams(BRUSH_SELECTION_ID, {
    objectId: object.id,
    canonicalFrame: object.suggestedFrame,
    maskRevision: mask?.revision ?? 0,
  });
  setNodeParam(MEASURE_HEIGHT_ID, "mode", object.mode);
  setNodeParam(SCALE_CHECK_ID, "truthM", object.truthM);
  void runAuto();
}

function selectFree(canonicalFrame: number): void {
  setFreeMeasurement();
  const subject = activeMeasurementSubject();
  const mask = getMask(subject.id, canonicalFrame);
  setNodeParams(BRUSH_SELECTION_ID, {
    objectId: subject.id,
    canonicalFrame,
    maskRevision: mask?.revision ?? 0,
  });
  setNodeParam(MEASURE_HEIGHT_ID, "mode", subject.mode);
  setNodeParam(SCALE_CHECK_ID, "truthM", 0);
  void runAuto();
}

function downloadSession(clipRunIds: readonly RunId[]): void {
  const blob = new Blob([exportMeasurementSession(clipRunIds)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  // Named for what it is. It was `verge-m3b-measurements.json` while the pane's own status row
  // said `M3c evidence` — two internal milestone names, disagreeing, on one screen, and neither
  // of them meaning anything to whoever opens the file six months from now.
  link.download = "verge-measurements.json";
  link.click();
  URL.revokeObjectURL(url);
}

function EvidenceRow({
  object,
  runId,
  model,
}: {
  object: MeasurementObject;
  runId: RunId;
  model?: ErrorModel;
}) {
  const ui = useMeasurementUi();
  const active = ui.measurementContext === "object" && ui.activeObjectId === object.id;
  const stats = trialStats(ui.observations, object.id, runId);
  const absError =
    Number.isFinite(stats.meanM) && object.truthM !== null
      ? Math.abs(stats.meanM - object.truthM)
      : NaN;
  const thin = stats.n > 0 && stats.n < MIN_TRIALS_FOR_SPREAD;
  const budget = objectBudget(ui.observations, object.id, runId, model);
  const stated = statedUncertainty(budget);

  return (
    <button className={`object-row${active ? " active" : ""}`} onClick={() => selectObject(object)}>
      <span className="object-code">{object.code}</span>
      <span className="object-copy">
        <b>{object.name}</b>
        <small>{object.definition}</small>
      </span>
      <span className="object-reading">
        <b>{veil(ui.blind, formatM(stats.meanM))}</b>
        <small title={budget.basis}>
          {stats.n === 0
            ? object.truthM === null
              ? "no truth — ungradable"
              : `truth ${object.truthM.toFixed(3)} m`
            : ui.blind
              ? `n${stats.n} · ${stats.sittingCount} sitting${stats.sittingCount === 1 ? "" : "s"}`
              : `|e| ${absError.toFixed(3)} · n${stats.n}${Number.isFinite(stated) ? ` · ±${stated.toFixed(3)}` : ""}`}
        </small>
      </span>
      {thin && <span className="trial-flag" title={`${MIN_TRIALS_FOR_SPREAD} trials needed before the spread means anything`}>{stats.n}/{MIN_TRIALS_FOR_SPREAD}</span>}
    </button>
  );
}

/**
 * Add a measurement target to the active clip.
 *
 * The truth field is deliberately optional. Requiring one would make the app unusable on any
 * scene the operator has not tape-measured, and would push people to type a guess — which is
 * strictly worse than an honest "ungradable", because a guessed truth silently poisons the
 * clip's scale factor and every calibrated reading derived from it.
 */
function AddTargetForm({
  clipName,
  existing,
  suggestedFrame,
  onAdd,
}: {
  clipName: string;
  existing: readonly MeasurementObject[];
  suggestedFrame: number;
  onAdd: (target: Omit<MeasurementObject, "builtin">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [definition, setDefinition] = useState("");
  const [truth, setTruth] = useState("");
  const [mode, setMode] = useState<MeasurementMode>("vertical_extent");

  if (!open) {
    return (
      <button className="add-target-open" onClick={() => setOpen(true)}>
        + Add target{clipName ? ` to ${clipName}` : ""}
      </button>
    );
  }

  const trimmedTruth = truth.trim();
  const parsedTruth = trimmedTruth === "" ? null : Number(trimmedTruth);
  const truthInvalid = parsedTruth !== null && (!Number.isFinite(parsedTruth) || parsedTruth <= 0);

  return (
    <div className="add-target">
      <label>
        NAME
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Doorway" />
      </label>
      <label>
        DEFINITION
        <input
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          placeholder="floor to lintel underside"
        />
      </label>
      <label>
        MODE
        <select value={mode} onChange={(e) => setMode(e.target.value as MeasurementMode)}>
          <option value="vertical_extent">vertical extent (own bottom → top)</option>
          <option value="top_above_floor">top above the fitted floor</option>
        </select>
      </label>
      <label>
        TRUTH m
        <input
          value={truth}
          onChange={(e) => setTruth(e.target.value)}
          placeholder="optional — leave blank if untaped"
        />
      </label>
      <small className="honesty-note">
        Frame {suggestedFrame} will be this target's suggested frame. Without a truth the target
        is measurable but never graded, and it cannot contribute to the clip's scale factor.
      </small>
      {truthInvalid && <div className="evidence-warning">Truth must be a positive number of metres, or blank.</div>}
      <div className="evidence-actions">
        <button
          disabled={name.trim() === "" || truthInvalid}
          onClick={() => {
            onAdd({
              // Deliberately not the name. See `newTargetId`: a name that decided the id made
              // re-typing a deleted target's name resurrect its trials.
              id: newTargetId(name, existing),
              code: nextTargetCode(existing),
              name: name.trim(),
              definition: definition.trim() || "operator-defined target",
              truthM: parsedTruth,
              mode,
              suggestedFrame,
              maskInstruction:
                mode === "vertical_extent"
                  ? "Paint the object continuously from its lower endpoint to its upper endpoint."
                  : "Paint the top surface and a visible floor patch; a connecting stroke is fine.",
            });
            setOpen(false);
            setName("");
            setDefinition("");
            setTruth("");
          }}
        >
          Add
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function ObjectsPane() {
  const advanced = useAdvanced();
  const graph = useGraph();
  const ui = useMeasurementUi();
  const object = activeMeasurementObject();
  const runs = useRuns();
  const syncedEvidence = useRef(new Set<string>());
  /** Runs whose disk evidence has been read this page load. Ref guards the fetch, state gates the write. */
  const loadedEvidence = useRef(new Set<string>());
  const [evidenceRead, setEvidenceRead] = useState<ReadonlySet<string>>(new Set());
  const [evidenceStatus, setEvidenceStatus] = useState<string>();
  /** Trial whose frozen brush is open. One at a time — these are full-resolution masks. */
  const [shownBrush, setShownBrush] = useState<string>();
  // Read on every store change, which is when a save has just been attempted.
  const persistError = ui && sessionPersistError();
  const fixture = graph.nodes.find((node) => node.id === FIXTURE_RUN_ID);
  const sourceMode = String(fixture?.params.source ?? "recorded") as "recorded" | "live";
  /**
   * Measurements are keyed by RUN, not by one of three fixture directory names. That is what
   * lets a saved cloud run hold trials at all — before this, `Record trial` was disabled for
   * anything but the built-in door settings because there was no stable key for a live run.
   */
  const runId = String(fixture?.params.runId ?? DEFAULT_RUN_ID) as RunId;
  const activeRun = runs.runs.find((item) => item.id === runId);

  /**
   * Every run made from the SAME clip as the active one.
   *
   * Targets belong to a clip, trials belong to a run, and one clip can have several runs — the
   * door's three resolutions are one target set over three runs. Anything that acts on a target
   * as a whole (removing it, exporting it) needs that list, and must not reach past it: two clips
   * can hold targets with the same id among the ids minted before `newTargetId`.
   */
  const clipRunIds = useMemo(
    () =>
      activeRun
        ? runs.runs.filter((item) => item.clipSha256 === activeRun.clipSha256).map((item) => item.id)
        : [],
    [activeRun, runs.runs],
  );
  const clipTrialCount = useMemo(
    () => ui.observations.filter((item) => clipRunIds.includes(item.runId)).length,
    [clipRunIds, ui.observations],
  );

  /**
   * Read a run's recorded trials off disk when it is selected, and the targets they belong to.
   *
   * The packets on disk are the copy that survives a cleared cache or a different machine, and
   * until now nothing read them: a fresh profile showed 0 trials beside 33 stored packets.
   *
   * Recovering the TARGETS as well is what makes that recovery visible. Each packet carries the
   * full definition it was recorded against, and dropping it left a clip holding trials with no
   * row to show them under — `RoomNewFixture` on 2026-08-13, 16 packets on disk and an empty
   * target list on screen, which is what "the objects were lost" was.
   *
   * Every packet is marked synced BEFORE the merge, whether or not it turns out to be new. The
   * effect below writes any trial it has not seen, so without this, opening a run would post all
   * of its own evidence straight back at it.
   */
  useEffect(() => {
    if (!activeRun?.persisted || !activeRun.available) return;
    if (loadedEvidence.current.has(activeRun.id)) return;
    loadedEvidence.current.add(activeRun.id);
    const runIdentifier = activeRun.id;
    const clipKey = activeRun.clipSha256;
    let cancelled = false;
    void listMeasurementEvidence(runIdentifier)
      .then((packets) => {
        if (cancelled) return;
        for (const packet of packets) {
          syncedEvidence.current.add(packet.evidenceId ?? measurementEvidenceId(packet.observation));
        }
        const restored = ensureTargets(
          clipKey,
          packets.map((packet) => packet.target).filter((target): target is MeasurementObject => !!target),
        );
        const recovered = mergeObservations(packets.map(recoveredObservation));
        setEvidenceRead((read) => new Set([...read, runIdentifier]));
        if (recovered.length || restored.length) {
          const parts = [
            recovered.length
              ? `${recovered.length} recorded trial${recovered.length === 1 ? "" : "s"}`
              : "",
            restored.length ? `${restored.length} target${restored.length === 1 ? "" : "s"}` : "",
          ].filter(Boolean);
          setEvidenceStatus(`Recovered ${parts.join(" and ")} from disk`);
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        // Retryable: dropping the mark lets a later selection of this run try again.
        loadedEvidence.current.delete(runIdentifier);
        setEvidenceStatus(
          `Could not read recorded evidence: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.id, activeRun?.persisted, activeRun?.available]);

  /**
   * Catch up any trial disk does not have yet.
   *
   * It waits for that run's evidence to have been READ first. Without the wait, a session
   * restored from `localStorage` was written straight back before the listing returned:
   * 17 of the door archive's files were rewritten on every page load, for no change. An
   * explicit Record does not come through here — `capture` writes its own richer packet — so
   * gating this costs nothing when the listing is unavailable.
   */
  useEffect(() => {
    for (const observation of ui.observations) {
      if (!evidenceRead.has(observation.runId)) continue;
      const evidenceId = measurementEvidenceId(observation);
      if (syncedEvidence.current.has(evidenceId)) continue;
      const run = runs.runs.find((item) => item.id === observation.runId);
      if (!run?.persisted || !run.available || !observation.mask) continue;
      const target = measurementObjectForClip(run.clipSha256, observation.objectId) ?? null;
      syncedEvidence.current.add(evidenceId);
      void saveMeasurementEvidence(evidencePacket(run, target, observation))
        .catch((reason) => {
          syncedEvidence.current.delete(evidenceId);
          setEvidenceStatus(`Recorded locally, but disk evidence failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        });
    }
  }, [evidenceRead, runs.loadedAt, runs.runs, ui.observations]);

  /**
   * Targets follow the CLIP the active run came from. Selecting a run from a different video
   * therefore swaps the whole target list rather than grading a new scene against door truths.
   */
  useEffect(() => {
    if (activeRun?.clipSha256) setActiveClip(activeRun.clipSha256);
  }, [activeRun?.clipSha256]);
  const targets = measurementObjects(ui.clipKey);
  const currentValue = <T,>(nodeId: string, portId: string): T | undefined => {
    const runtime = graph.runtime[nodeId];
    if (runtime?.status !== "ok" || isNodeStale(graph, nodeId)) return undefined;
    return runtime.outputs?.[portId]?.value as T | undefined;
  };
  const selection = currentValue<SelectionValue>(BRUSH_SELECTION_ID, "selection");
  const ground = currentValue<GroundPlaneValue>(GROUND_PLANE_ID, "plane");
  const measurement = currentValue<MeasurementValue>(MEASURE_HEIGHT_ID, "measurement");
  const pointCloud = currentValue<PointCloudValue>(POINT_CLOUD_ID, "cloud");
  const measurementError = graph.runtime[MEASURE_HEIGHT_ID]?.error;

  /**
   * The RGB frame a trial was measured on, when the active run is loaded. A trial's frame is
   * canonical, and a run holds only some of the 256, so it snaps the same way the measurement did.
   */
  const depthField = currentValue<DepthFieldValue>(FIXTURE_RUN_ID, "depth");
  const frameUrl = (canonicalFrame: number): string | undefined =>
    depthField ? closestFrame(depthField, canonicalFrame)?.rgbUrl : undefined;

  const factor = clipScaleFactor(ui.observations, runId, targets);
  const corrected = measurement ? correctedValue(measurement.rawM, factor) : NaN;
  const derivedMonitorTop = objectMean(ui.observations, "table-top", runId) + objectMean(ui.observations, "monitor-own", runId);
  const currentRunObservations = ui.observations.filter((item) => item.runId === runId);
  const activeStats = trialStats(ui.observations, object?.id ?? "", runId);
  const activeTrials = trialsFor(ui.observations, object?.id ?? "", runId);
  const repeatedMasks = duplicateMaskTrialIds(ui.observations, object?.id ?? "", runId);
  const automaticStats = segmentationAttemptStats(
    ui.segmentationAttempts.filter((attempt) => attempt.objectId === object?.id),
  );
  const rawDa3Text = measurement
    ? formatM(measurement.rawM)
    : selection?.segmentation && !selection.segmentation.accepted
      ? "LOCKED · ACCEPT MASK"
      : selection?.segmentation && object?.availabilityNote
        ? "UNAVAILABLE · OCCLUDED ENDPOINT"
        : "—";

  // One point per object, at its trial mean. Feeding every trial in would let a thrice-measured
  // door outvote a once-measured table and shrink the residual by repetition alone.
  const errorModelPoints = useMemo(
    () =>
      targets
        // A target with no tape truth cannot constrain a scale fit. Including it with a zero
        // would drag the slope toward the origin and manufacture a bias that is not there.
        .filter((item): item is MeasurementObject & { truthM: number } => item.truthM !== null)
        .map((item) => {
          const stats = trialStats(ui.observations, item.id, runId);
          const spreads = trialsFor(ui.observations, item.id, runId).map((trial) => trial.internalSpreadM);
          return { id: item.id, truth: item.truthM, predicted: stats.meanM, uncertainty: mean(spreads) };
        })
        .filter((point) => Number.isFinite(point.predicted)),
    [runId, targets, ui.observations],
  );

  // The clip's scale, fitted over every graded object in this setting. Two points minimum:
  // one object yields a ratio, not a line, and a ratio cannot be applied to another length.
  const clipModel = useMemo(
    () => (errorModelPoints.length >= 2 ? fitErrorModel(errorModelPoints) : undefined),
    [errorModelPoints],
  );

  // Falls back to the recorded trials when nothing is painted, so the budget describes the
  // object's actual evidence instead of going blank the moment the mask is cleared.
  const liveBudget = measurement
    ? composeUncertainty({
        valueM: measurement.rawM,
        patchRoughnessM: measurement.internalSpreadM,
        operatorRangeM: activeStats.n >= MIN_TRIALS_FOR_SPREAD ? activeStats.rangeM : undefined,
        model: clipModel,
      })
    : activeStats.n > 0
      ? objectBudget(ui.observations, object?.id ?? "", runId, clipModel)
      : undefined;

  /**
   * The resolution comparison only means something for the clip its three runs were made from.
   *
   * `FIXTURE_SETTINGS` is three recorded runs of the DOOR clip at different resolutions and frame
   * counts. Until now the card built from them rendered for every clip: on `da3Test.mp4` it drew
   * three rows of `—` under a heading promising a verdict, and closed with a sentence about B4's
   * stand contact — a target that clip does not contain. A comparison with nothing in it is not a
   * neutral blank, it is a claim that the comparison was run and came back empty.
   */
  const showsResolutionVerdict = ui.clipKey === BUILTIN_DOOR_CLIP;

  /** How many graded targets a setting could have scored. Was written as a literal `3`. */
  const holdoutCount = targets.filter(
    (item) => item.truthM !== null && item.id !== calibrationTarget(targets)?.id && !item.availabilityNote,
  ).length;

  const resolutionRows = useMemo(
    () =>
      FIXTURE_SETTINGS.map((setting) => {
        const candidate = builtinRunId(setting);
        const calibration = calibrationTarget(targets);
        const holdouts = targets
          .filter(
            (item): item is MeasurementObject & { truthM: number } =>
              item.truthM !== null && item.id !== calibration?.id && !item.availabilityNote,
          )
          .map((item) => ({ item, raw: objectMean(ui.observations, item.id, candidate) }))
          .filter((entry) => Number.isFinite(entry.raw));
        const factor = clipScaleFactor(ui.observations, candidate, targets);
        const rawMae = mean(holdouts.map(({ item, raw }) => Math.abs(raw - item.truthM)));
        const correctedMae = Number.isFinite(factor)
          ? mean(holdouts.map(({ item, raw }) => Math.abs(correctedValue(raw, factor) - item.truthM)))
          : NaN;
        return { setting, views: holdouts.length, rawMae, correctedMae, factor };
      }),
    [targets, ui.observations],
  );

  const capture = async () => {
    if (!object || !measurement || !selection || !ground || !activeRun) return;
    const observation = addObservation({
      objectId: object.id,
      runId,
      canonicalFrame: selection.frame.canonicalIndex,
      npzFrame: selection.frame.npzIndex + 1,
      rawM: measurement.rawM,
      internalSpreadM: measurement.internalSpreadM,
      pointCount: measurement.pointCount,
      confidenceThreshold: selection.confidenceThreshold,
      floorRmseM: ground.fit.rmse,
      floorSupportFraction: ground.fit.inlierFraction,
      floorTiltDeg: ground.fit.tiltDeg,
      floorBelowFraction: ground.fit.belowFraction,
      gravityCoherence: ground.gravity.coherence,
      // The 3D evidence for the number, frozen beside the mask. It travels inside the
      // observation rather than only in the packet's `live` block so the recovery path — which
      // merges observations and drops everything else — brings the ruler back off disk too.
      ruler: measurement.ruler,
      rulerKind: measurement.rulerKind,
    });
    const evidenceId = measurementEvidenceId(observation);
    // Mark it before the first await. addObservation schedules the migration effect, and without
    // this guard that mask-only sync can race the richer explicit Record packet below.
    syncedEvidence.current.add(evidenceId);
    setEvidenceStatus("Saving recorded trial…");
    try {
      await saveMeasurementEvidence(
        evidencePacket(activeRun, object, observation, {
          cloudSource: pointCloud?.source ??
            (graph.nodes.find((node) => node.id === POINT_CLOUD_ID)?.params.source === "npz" ? "npz" : "glb"),
          selection: {
            rejected: selection.diagnostics.rejected,
            maskedPixels: selection.diagnostics.maskedPixels,
            pointCount: selection.diagnostics.pointCount,
          },
          measurement: {
            mode: measurement.mode,
            rawM: measurement.rawM,
            internalSpreadM: measurement.internalSpreadM,
            pointCount: measurement.pointCount,
            ruler: measurement.ruler,
            rulerKind: measurement.rulerKind,
            details: measurement.details,
          },
          ground: {
            plane: ground.plane,
            supportFraction: ground.fit.inlierFraction,
            rmseM: ground.fit.rmse,
            tiltDeg: ground.fit.tiltDeg,
            belowFraction: ground.fit.belowFraction,
            gravityCoherence: ground.gravity.coherence,
          },
        }),
      );
      setEvidenceStatus(`Recorded #${observation.trialIndex} on disk`);
    } catch (reason) {
      syncedEvidence.current.delete(evidenceId);
      setEvidenceStatus(`Recorded locally, but disk evidence failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const discardTrial = async (trial: MeasurementObservation) => {
    try {
      const evidenceId = measurementEvidenceId(trial);
      await deleteMeasurementEvidence(trial.runId, evidenceId);
      removeObservation(trial);
      syncedEvidence.current.delete(evidenceId);
      setEvidenceStatus(`Discarded trial #${trial.trialIndex}`);
    } catch (reason) {
      setEvidenceStatus(`Could not discard disk evidence: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  /**
   * Remove a target, and with it every trial recorded against it on this CLIP's runs.
   *
   * Both halves matter. Removing the definition alone left the trials in the store, invisible and
   * still counted, and a later target that slugified to the same id adopted them. Removing them
   * without archiving would destroy a recording nobody can repaint. So: say how many are going,
   * archive them on disk, then drop the rows.
   *
   * A clip's targets span all of its runs — the same room reconstructed at two resolutions is two
   * runs and one target set — so this reaches every run of the clip, and nothing outside it.
   */
  const dropTarget = async (target: MeasurementObject) => {
    // The button is not rendered for a built-in, and `removeTarget` refuses one anyway — but the
    // archiving below runs first, so without this a built-in would have its evidence put away and
    // then keep its row, which is the one outcome neither branch intends.
    if (target.builtin) return;
    const scope = clipRunIds;
    const doomed = ui.observations.filter(
      (item) => item.objectId === target.id && scope.includes(item.runId),
    );
    const confirmation = doomed.length
      ? `Remove ${target.name} and its ${doomed.length} recorded trial${doomed.length === 1 ? "" : "s"}?\n\nThe trials are archived to ~/verge-runs/.archive and stop counting here. Re-adding this name later creates a NEW target — they will not come back.`
      : `Remove ${target.name}?\n\nIt has no recorded trials.`;
    if (!window.confirm(confirmation)) return;

    let archived = 0;
    try {
      for (const run of scope) archived += await archiveTargetEvidence(run, target.id);
    } catch (reason) {
      // Stop before touching the store. Dropping the rows while their packets are still on disk
      // would make the next selection of this run recover them, which looks exactly like the
      // resurrection bug this whole change removes.
      setEvidenceStatus(`Could not archive this target's evidence: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    const removed = removeTarget(target.id, { runIds: scope, clip: ui.clipKey });
    for (const trial of removed) syncedEvidence.current.delete(measurementEvidenceId(trial));
    setEvidenceStatus(
      archived || removed.length
        ? `Removed ${target.name}; archived ${archived} trial${archived === 1 ? "" : "s"}`
        : `Removed ${target.name}`,
    );
  };

  /**
   * Local rebuild only — it does NOT rerun DA3, reload the video or bill anything.
   *
   * The old label said "Recompute from source", which read as if it went back to the GPU. It
   * discards cached results at `GroundPlane`/`BrushSelection` and reruns the CPU measurement
   * branch: floor, mask→3D points, extent, scale check and the 3D overlay. Painting or changing
   * object/source already invalidates those nodes, so this is a recovery action, not a step in
   * the normal evidence workflow.
   */
  const recompute = async () => {
    invalidateFrom([GROUND_PLANE_ID, BRUSH_SELECTION_ID]);
    await runAuto();
  };

  return (
    <div className="pane">
      {/* `M3c evidence` used to sit here — a milestone number from a plan nobody is reading any
          more. What a status row owes the reader is numbers about the thing in front of them. */}
      <div className="pane-status">
        {/* No glyph in the text: `.pane-status .ok` and `.busy` already draw one in CSS, and
            writing a second one produced "● ● Evidence". */}
        <span className={ui.blind ? "busy" : "ok"}>
          {ui.blind ? "BLIND" : ui.measurementContext === "free" ? "Free" : "Evidence"}
        </span>
        <span>
          {/* Both halves count the same clip. The trial half was `ui.observations.length`, the
              whole store — so this read "5 targets · 33 trials · RoomNewFixture.mp4" while 16 of
              those trials were the room's and 17 were the door's. */}
          {targets.length} target{targets.length === 1 ? "" : "s"} · {clipTrialCount} trials
        </span>
        <span className="hint">{activeRun?.clipName || "no clip"}</span>
        <PaneShare />
      </div>
      <div className="pane-body objects-pane">
        <section className="object-context">
          <label>
            SOURCE
            <select
              aria-label="Measurement source"
              value={sourceMode}
              onChange={(event) => {
                setNodeParam(FIXTURE_RUN_ID, "source", event.target.value);
                void runAuto();
              }}
            >
              <option value="recorded">Recorded</option>
              <option value="live">Live DA3</option>
            </select>
          </label>
          <label>
            RUN
            <select
              aria-label="Recorded run"
              value={runId}
              disabled={sourceMode !== "recorded"}
              onChange={(event) => {
                setNodeParam(FIXTURE_RUN_ID, "runId", event.target.value);
                void runAuto();
              }}
            >
              {runs.runs
                // Only runs whose bytes are on this disk can be measured. A transient stub is
                // listed in the Runs pane, but it has nothing to backproject.
                .filter((item) => item.persisted)
                .map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.available}>
                    {item.label}
                    {item.available ? "" : " (payload missing)"}
                  </option>
                ))}
            </select>
          </label>
          <span>
            {sourceMode === "recorded"
              ? `recorded DA3 run ${(activeRun?.gpuSeconds ?? 0).toFixed(2)} s`
              : "run DA3 manually"}
          </span>
          {/* Lives here, not in the status row: that row is nowrap+overflow:hidden and clips
              its right edge in a narrow pane, which is no place for a mode control. */}
          <button
            className={`chip-toggle${ui.blind ? " on" : ""}`}
            title={
              ui.blind
                ? "Reveal readings. Any trial painted after this point is no longer independent of what you have seen."
                : "Hide every reading so a repeat trial cannot converge on the previous answer."
            }
            onClick={() => setBlind(!ui.blind)}
          >
            {ui.blind ? "BLIND ON" : "Blind"}
          </button>
        </section>

        <section className="object-list" aria-label="Measurement objects">
          <button
            className={`object-row free-row${ui.measurementContext === "free" ? " active" : ""}`}
            onClick={() => selectFree(ui.canonicalFrame)}
          >
            <span className="object-code">FREE</span>
            <span className="object-copy">
              <b>Ad hoc measurement</b>
              <small>temporary brush · never recorded</small>
            </span>
            <span className="object-reading">
              <b>{measurement && ui.measurementContext === "free" ? formatM(measurement.rawM) : "—"}</b>
              <small>{ui.freeMeasurementMode === "vertical_extent" ? "extent" : "above floor"}</small>
            </span>
          </button>
          {targets.map((item) => (
            <EvidenceRow key={item.id} object={item} runId={runId} model={clipModel} />
          ))}
          <AddTargetForm
            clipName={activeRun?.clipName ?? ""}
            existing={targets}
            suggestedFrame={ui.canonicalFrame}
            onAdd={(target) => {
              addTarget(target);
              void runAuto();
            }}
          />
        </section>

        {!object ? (
          <section className="evidence-card">
            <div className="evidence-title">
              <span><b>FREE</b> Ad hoc measurement</span>
            </div>
            <div className="reading-grid">
              <span>RAW DA3</span><b>{measurement ? formatM(measurement.rawM) : "—"}</b>
              <span>SELECTED</span><b>{selection ? `${selection.diagnostics.pointCount.toLocaleString()} pts` : "—"}</b>
              <span>DEFINITION</span><b>{ui.freeMeasurementMode === "vertical_extent" ? "extent" : "above floor"}</b>
              <span>STORAGE</span><b>temporary</b>
            </div>
          </section>
        ) : (
        <section className="evidence-card">
          <div className="evidence-title">
            <span><b>{object.code}</b> {object.name}</span>
            <span className="truth">
              {object.truthM === null ? "no truth" : `truth ${object.truthM.toFixed(3)} m`}
            </span>
            {!object.builtin && (
              <button
                className="trial-drop"
                title="Remove this target and archive every trial recorded against it."
                onClick={() => void dropTarget(object)}
              >
                ×
              </button>
            )}
          </div>
          <p>{object.definition}</p>
          <div className="reading-grid">
            <span>RAW DA3</span>
            <b>{veil(ui.blind, rawDa3Text)}</b>
            <span>SELECTED</span><b>{selection ? `${selection.diagnostics.pointCount.toLocaleString()} pts` : "—"}</b>
            <span>SELECTION</span><b>{selection?.maskSource ?? "—"}</b>
            {/*
              `experimental` used to be suppressed for `door-leaf` and shown for everything else,
              which had it exactly backwards: the door is the ONE target automatic selection has
              ever been tried on, and one attempt is not a benchmark. REGISTRY section 7 gates
              trust in automatic masks generally, so the caveat belongs on all of them.
            */}
            {selection?.segmentation && (
              <>
                <span>AUTOMATIC REVIEW</span>
                <b>
                  {selection.segmentation.accepted
                    ? `accepted · experimental · ${selection.segmentation.prompts.length} clicks`
                    : "height withheld"}
                </b>
              </>
            )}
            {advanced && selection?.segmentation && measurement && Number.isFinite(measurement.details.fullMaskControlM) && (
              <>
                <span>FULL-MASK CONTROL</span><b>{formatM(measurement.details.fullMaskControlM)}</b>
                <span>ENDPOINT ADAPTER</span><b>{formatM(measurement.details.endpointAdapterDeltaM)}</b>
              </>
            )}
            {advanced && automaticStats.total > 0 && (
              <>
                <span>AUTO ATTEMPTS · {object.code}</span><b>{automaticStats.accepted}/{automaticStats.total} accepted</b>
                <span>ABSTAIN / FAIL</span><b>{automaticStats.abstained} / {automaticStats.failed}</b>
              </>
            )}
            <span>
              {object.id === calibrationTarget(targets)?.id ? "CALIBRATION TARGET" : "SCALE-CHECKED"}
            </span>
            <b>{veil(ui.blind, formatM(corrected))}</b>
          </div>

          {/*
            The uncertainty budget, split by kind. Until 2026-08-04 this box showed a single
            "INTERNAL SPREAD ±0.003 m" beside errors of 0.02–0.08 m. P0 measured the terms and
            found the residual is systematic scale, not scatter — so the bias is now stated and
            corrected rather than hidden inside a ± that never covered it.

            Advanced, because it is the anatomy of a number rather than the number: what Standard
            needs is the reading and its error, and those are two rows above and in the 3D pane's
            result strip. The one thing here that is a live warning about this run — no calibration
            basis — is rendered outside the switch below.
          */}
          {advanced && (
          <div className="budget-block">
            <div className="reading-grid">
              <span>CLIP SCALE BIAS</span>
              <b>{veil(ui.blind, liveBudget?.calibrated ? formatPercent(liveBudget.biasRelative) : "—")}</b>
              <span>CALIBRATED</span>
              <b>
                {veil(
                  ui.blind,
                  liveBudget?.calibrated
                    ? `${formatM(liveBudget.calibratedM)} ± ${liveBudget.calibratedUncertaintyM.toFixed(3)}`
                    : "—",
                )}
              </b>
              <span>RANDOM · one sitting</span>
              <b>{veil(ui.blind, liveBudget && Number.isFinite(liveBudget.randomM) ? `±${liveBudget.randomM.toFixed(3)} m` : "—")}</b>
              <span>SYSTEMATIC · after correction</span>
              <b>{veil(ui.blind, liveBudget?.calibrated ? `±${liveBudget.systematicM.toFixed(3)} m` : "—")}</b>
              {liveBudget && (
                <small>
                  {measurement ? "live measurement" : `${activeStats.n}-trial mean`} · {liveBudget.basis}
                  {liveBudget.dominant !== "unknown" && ` — limited by ${liveBudget.dominant}`}
                </small>
              )}
            </div>
            <span className="budget-help">
              <HelpDot label="What this budget can and cannot cover">
                <p>⚠️ {UNCERTAINTY_LIMITATION}</p>
              </HelpDot>
            </span>
          </div>
          )}
          {/*
            Outside the switch: this describes the state of THIS run rather than explaining the
            feature, so hiding it in Standard would be the honesty rule broken by a mode.
          */}
          {liveBudget && !liveBudget.calibrated && (
            <div className="evidence-warning">
              No calibration basis in this setting: record at least two different objects before
              any bias figure can be quoted. The raw reading stands alone until then.
            </div>
          )}
          {measurementError && <div className="evidence-warning">{measurementError}</div>}
          {object.availabilityNote && <div className="evidence-warning">{object.availabilityNote}</div>}
          {!Number.isFinite(factor) && object.id !== calibrationTarget(targets)?.id && (
            <div className="evidence-warning">
              {calibrationTarget(targets)
                ? `Record ${calibrationTarget(targets)?.code} on this run before treating the corrected number as evidence.`
                : "No target in this clip has a tape truth, so there is no scale reference at all. The raw reading stands alone."}
            </div>
          )}
          {object.id === "monitor-top" && (
            <div className="composition-check">
              <span>Composition B2 + B4</span>
              <b>{veil(ui.blind, formatM(derivedMonitorTop))}</b>
              <small>Cross-check only; it is not a fifth independent object.</small>
            </div>
          )}
          <section className="trial-block">
            {/*
              Two counts in Standard, six in Advanced.
              `Record trial` stays in Standard, so the count it increments has to stay with it —
              a button whose only feedback lives behind a mode switch is a button that appears to
              do nothing. The medians and the two spread ranges are the repeatability STUDY, and
              that is what Advanced is for.
            */}
            <div className="trial-head">
              <div>
                <span>REPEAT TRIALS</span>
                <b>{activeStats.n}</b>
              </div>
              <div>
                <span>SITTINGS</span>
                <b className={activeStats.sittingCount >= 2 ? "" : "unproven"}>{activeStats.sittingCount}</b>
              </div>
              {advanced && (
              <>
              <div>
                <span>MEDIAN PAINT</span>
                <b>{formatDuration(activeStats.medianPaintMs)}</b>
              </div>
              <div>
                <span>IN-SITTING</span>
                <b
                  className={activeStats.n >= MIN_TRIALS_FOR_SPREAD ? "" : "unproven"}
                  title="Back-to-back repeats. Measured at 1–6 mm in P0 — small, and not an operator bound."
                >
                  {veil(
                    ui.blind,
                    Number.isFinite(activeStats.withinSittingRangeM)
                      ? `${activeStats.withinSittingRangeM.toFixed(3)} m`
                      : "—",
                  )}
                </b>
              </div>
              <div>
                <span>CROSS-SITTING</span>
                <b
                  className={activeStats.sittingCount >= 2 ? "" : "unproven"}
                  title="Range of the per-sitting means. The only figure here that bounds the operator."
                >
                  {veil(
                    ui.blind,
                    Number.isFinite(activeStats.betweenSittingRangeM)
                      ? `${activeStats.betweenSittingRangeM.toFixed(3)} m`
                      : "—",
                  )}
                </b>
              </div>
              </>
              )}
            </div>
            {activeStats.n > 0 && activeStats.sittingCount < 2 && (
              <div className="evidence-warning">
                One sitting — not yet an operator bound. Back-to-back repeats measured 1–6 mm in
                P0, while the same objects moved 21–133 mm between sittings. Come back later, turn
                blind mode on, and repaint before reading the previous answer.
              </div>
            )}
            {advanced && activeTrials.length > 0 && (
              <ol className="trial-list">
                {activeTrials.map((trial) => (
                  <li
                    key={trialIdentity(trial)}
                    className={repeatedMasks.has(trialIdentity(trial)) ? "repeated-mask" : ""}
                  >
                    <span className="mono">#{trial.trialIndex}</span>
                    <b>{veil(ui.blind, `${trial.rawM.toFixed(3)} m`)}</b>
                    <span className="mono">
                      {veil(
                        ui.blind,
                        object.truthM === null
                          ? "—"
                          : (trial.rawM - object.truthM >= 0 ? "+" : "") +
                            (trial.rawM - object.truthM).toFixed(3),
                      )}
                    </span>
                    {trial.mask && !repeatedMasks.has(trialIdentity(trial)) ? (
                      <button
                        className="trial-brush"
                        title={shownBrush === trialIdentity(trial) ? "Hide this trial's brush" : "Show the brush this trial was measured from"}
                        aria-expanded={shownBrush === trialIdentity(trial)}
                        onClick={() =>
                          setShownBrush(shownBrush === trialIdentity(trial) ? undefined : trialIdentity(trial))
                        }
                      >
                        {`${trial.mask.source ?? "brush"} · ${trial.mask.paintedPixels.toLocaleString()} px · ${trial.mask.digest.slice(0, 8)}${trial.mask.segmentation ? ` · ${trial.mask.segmentation.prompts.length} clicks/${trial.mask.segmentation.correctionStrokes} edits · ${((trial.mask.segmentation.selectionDurationMs ?? 0) / 1000).toFixed(1)}s` : ""}`}
                      </button>
                    ) : (
                      <span className="mono">
                        {repeatedMasks.has(trialIdentity(trial)) ? "same mask as an earlier trial" : "no mask evidence"}
                      </span>
                    )}
                    {/*
                      Light up this trial's ruler in the 3D scene. A reading in this list and the
                      two endpoints it was taken between are the same evidence; until now only the
                      number was reachable, and the ruler existed on disk with no way to see it.
                    */}
                    {trial.ruler ? (
                      <button
                        className="trial-ruler"
                        aria-pressed={ui.focusedTrialId === trialIdentity(trial)}
                        title={
                          ui.focusedTrialId === trialIdentity(trial)
                            ? "Stop singling out this trial's ruler in Viewport 3D"
                            : "Show the two endpoints this reading was taken between, in Viewport 3D"
                        }
                        onClick={() =>
                          setFocusedTrial(
                            ui.focusedTrialId === trialIdentity(trial) ? null : trialIdentity(trial),
                          )
                        }
                      >
                        ruler
                      </button>
                    ) : (
                      <span
                        className="mono"
                        title="Recorded before trials kept their ruler. It cannot be recovered: replaying the mask needs the floor this trial was measured against, and that was not stored either."
                      >
                        —
                      </span>
                    )}
                    <span className="mono">{formatDuration(trial.paintDurationMs ?? NaN)}</span>
                    <button className="trial-drop" title="Discard this trial" onClick={() => void discardTrial(trial)}>×</button>
                    {shownBrush === trialIdentity(trial) && trial.mask && (
                      <FrozenMask mask={trial.mask} frameUrl={frameUrl(trial.canonicalFrame)} />
                    )}
                  </li>
                ))}
              </ol>
            )}
            {repeatedMasks.size > 0 && (
              <div className="evidence-warning">
                {repeatedMasks.size} trial{repeatedMasks.size === 1 ? " reuses" : "s reuse"} an earlier
                trial's mask. Those rows repeat one measurement rather than repeating the measuring, so
                they understate the spread. Discard them or repaint.
              </div>
            )}
            {activeStats.n > 0 && activeStats.n < MIN_TRIALS_FOR_SPREAD && (
              <div className="evidence-warning">
                {MIN_TRIALS_FOR_SPREAD - activeStats.n} more independent trial
                {MIN_TRIALS_FOR_SPREAD - activeStats.n === 1 ? "" : "s"} before this object's spread is
                evidence rather than one accident. Clear the mask and repaint from scratch — reusing the
                existing mask measures the code, not the operator.
              </div>
            )}
          </section>
          <div className="evidence-actions">
            {/*
              Recording no longer requires one of three door fixtures. It requires a run with a
              STABLE IDENTITY whose bytes are on disk — otherwise a recorded trial would point
              at evidence that dies with a cloud instance, which is the reproducibility promise
              the trial store exists to keep. Save the run first, then measure it.
            */}
            <button
              disabled={
                sourceMode !== "recorded" ||
                !activeRun?.persisted ||
                !measurement ||
                !selection ||
                !ground
              }
              title={
                sourceMode !== "recorded"
                  ? "Select a recorded run — a live output has no stable identity to key a trial to."
                  : !activeRun?.persisted
                    ? "Save this run to disk first. A trial recorded against a transient run would reference evidence that dies with the instance."
                    : "Freeze this measurement and its mask as a numbered trial."
              }
              onClick={() => void capture()}
            >
              Record trial {activeStats.n + 1}
            </button>
            <button
              disabled={graph.running}
              title="Discards cached results from GroundPlane and BrushSelection down, then reruns the local CPU branch. DA3 is not run and nothing is billed."
              onClick={() => void recompute()}
            >
              {graph.running ? "Rebuilding…" : "Rebuild measurement"}
            </button>
          </div>
          {evidenceStatus && <div className={evidenceStatus.includes("failed") || evidenceStatus.includes("Could not") ? "evidence-warning" : "honesty-note"}>{evidenceStatus}</div>}
          {/* A trial the browser cannot store is a trial that will not be there tomorrow. */}
          {persistError && <div className="evidence-warning">{persistError}</div>}
          {/*
            The instruction stays; the two paragraphs around it went behind `?`.

            It is the difference DESIGN.md draws between explanation and state: what to paint,
            right now, for THIS target is the next action. How masks are reviewed and what a
            sitting id is for are things you read once.
          */}
          <small className="honesty-note">
            <b>Paint:</b> {object.maskInstruction}
            <HelpDot label="How masks and sittings are recorded">
              <p>
                <b>Masks are evidence.</b> An automatic proposal stays amber and exposes no height
                until you review it; an accepted mask turns teal, and a later brush edit needs
                accepting again.
              </p>
              <p>
                Trials recorded now carry sitting{" "}
                <span className="mono">{currentSittingId().slice(-6)}</span>. A genuinely separate
                repeat means coming back later and painting again — repeats inside one sitting
                measure the code, not the operator.
              </p>
            </HelpDot>
          </small>
        </section>
        )}

        {/*
          Both cards are the repeatability study rather than the measurement, so both are Advanced.
          The resolution card additionally only exists for the clip its three runs came from —
          see `showsResolutionVerdict`.
        */}
        {advanced && showsResolutionVerdict && (
          <section className="resolution-card">
            <h3>
              Resolution vs frame count · door clip
              <HelpDot label="What this table compares">
                <p>
                  Three recorded runs of the door clip at different resolutions and frame counts,
                  each graded on the targets that are <b>not</b> the calibration target.
                </p>
                <p>
                  <b>Raw MAE</b> is mean absolute error straight from DA3. <b>Scaled</b> applies
                  the clip's single calibration factor and is a secondary check only — the raw
                  reading stays primary.
                </p>
              </HelpDot>
            </h3>
            <div className="resolution-head"><span>Setting</span><span>Holdouts</span><span>Raw MAE</span><span>Scaled</span></div>
            {resolutionRows.map((row) => (
              <div className="resolution-row" key={row.setting}>
                <span>{row.setting}</span>
                {/* Was hardcoded `/3`. The count is however many graded holdouts this clip has,
                    which changes the moment a target is added or taped. */}
                <span>{row.views}/{holdoutCount}</span>
                <span>{veil(ui.blind, formatM(row.rawMae))}</span>
                <span>{veil(ui.blind, formatM(row.correctedMae))}</span>
              </div>
            ))}
          </section>
        )}

        {advanced && (
          <section className="error-model-card">
            <h3>
              Current-run raw error model
              <HelpDot label="How the error model is fitted">
                <p>
                  A straight line through every graded target in this run: predicted length against
                  tape truth. <b>Scale factor</b> is what the clip's metric scale is off by,{" "}
                  <b>residual RMS</b> is what is left after correcting for it.
                </p>
                <p>
                  Each object contributes its trial mean once. Feeding in every trial would let a
                  thrice-measured door outvote a once-measured table and shrink the residual by
                  repetition alone.
                </p>
              </HelpDot>
            </h3>
            {ui.blind ? (
              <p>Hidden while blind mode is on.</p>
            ) : clipModel ? (
              <div className="reading-grid"><span>SLOPE</span><b>{clipModel.slope.toFixed(3)}</b><span>INTERCEPT</span><b>{clipModel.intercept.toFixed(3)} m</b><span>RESIDUAL RMS</span><b>{clipModel.residualRms.toFixed(3)} m</b><span>SCALE FACTOR</span><b>×{clipModel.scaleFactor.toFixed(3)}</b><span>MEAN ABSREL</span><b>{(clipModel.meanAbsRel * 100).toFixed(1)}%</b><span>MAX ERROR</span><b>{clipModel.maxAbsError.toFixed(3)} m</b></div>
            ) : <p>Record at least two distinct truths.</p>}
            <small className="honesty-note">
              Fitted over {errorModelPoints.length} object{errorModelPoints.length === 1 ? "" : "s"} from{" "}
              {currentRunObservations.length} trial{currentRunObservations.length === 1 ? "" : "s"}.
            </small>
            <div className="evidence-actions"><button onClick={() => downloadSession(clipRunIds)}>Export evidence JSON</button></div>
          </section>
        )}
      </div>
    </div>
  );
}
