import { useMemo } from "react";
import { fitErrorModel } from "../../../geometry";
import { invalidateFrom, isNodeStale, runAuto, setNodeParam, setNodeParams, useGraph } from "../graph/graph-store";
import {
  BRUSH_SELECTION_ID,
  FIXTURE_RUN_ID,
  GROUND_PLANE_ID,
  MEASURE_HEIGHT_ID,
  SCALE_CHECK_ID,
  type GroundPlaneValue,
  type MeasurementValue,
  type SelectionValue,
} from "../graph/nodes";
import { FIXTURE_SETTINGS, type FixtureSetting } from "../measurement/depth-field";
import {
  MEASUREMENT_OBJECTS,
  MIN_TRIALS_FOR_SPREAD,
  activeMeasurementObject,
  addObservation,
  duplicateMaskTrialIds,
  exportMeasurementSession,
  getMask,
  removeObservation,
  setActiveMeasurementObject,
  trialStats,
  trialsFor,
  useMeasurementUi,
  type MeasurementObservation,
  type MeasurementObject,
} from "../measurement/measurement-store";

const GPU_TIMES: Record<FixtureSetting, number> = {
  "504px-112f": 31.27,
  "356px-256f": 40.83,
  "252px-256f": 16.47,
};

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/**
 * Every aggregate below reads the mean across an object's repeat trials, never a single
 * recording. With one trial this is the old behaviour; with three it is the number the
 * repeatability study exists to produce.
 */
function objectMean(observations: readonly MeasurementObservation[], objectId: string, setting?: FixtureSetting): number {
  return trialStats(observations, objectId, setting).meanM;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(0)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function doorFactor(observations: readonly MeasurementObservation[], setting: FixtureSetting): number {
  const raw = objectMean(observations, "door-leaf", setting);
  return Number.isFinite(raw) && raw > 0 ? 2.1 / raw : NaN;
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

function downloadSession(): void {
  const blob = new Blob([exportMeasurementSession()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "verge-m3b-measurements.json";
  link.click();
  URL.revokeObjectURL(url);
}

function EvidenceRow({ object, setting }: { object: MeasurementObject; setting: FixtureSetting }) {
  const ui = useMeasurementUi();
  const active = ui.activeObjectId === object.id;
  const stats = trialStats(ui.observations, object.id, setting);
  const absError = Number.isFinite(stats.meanM) ? Math.abs(stats.meanM - object.truthM) : NaN;
  const thin = stats.n > 0 && stats.n < MIN_TRIALS_FOR_SPREAD;

  return (
    <button className={`object-row${active ? " active" : ""}`} onClick={() => selectObject(object)}>
      <span className="object-code">{object.code}</span>
      <span className="object-copy">
        <b>{object.name}</b>
        <small>{object.definition}</small>
      </span>
      <span className="object-reading">
        <b>{formatM(stats.meanM)}</b>
        <small>
          {stats.n === 0
            ? `truth ${object.truthM.toFixed(3)} m`
            : `|e| ${absError.toFixed(3)} · n${stats.n}${stats.n > 1 ? ` ±${stats.rangeM.toFixed(3)}` : ""}`}
        </small>
      </span>
      {thin && <span className="trial-flag" title={`${MIN_TRIALS_FOR_SPREAD} trials needed before the spread means anything`}>{stats.n}/{MIN_TRIALS_FOR_SPREAD}</span>}
    </button>
  );
}

export function ObjectsPane() {
  const graph = useGraph();
  const ui = useMeasurementUi();
  const object = activeMeasurementObject();
  const fixture = graph.nodes.find((node) => node.id === FIXTURE_RUN_ID);
  const sourceMode = String(fixture?.params.source ?? "recorded") as "recorded" | "live";
  const setting = String(fixture?.params.setting ?? "504px-112f") as FixtureSetting;
  const currentValue = <T,>(nodeId: string, portId: string): T | undefined => {
    const runtime = graph.runtime[nodeId];
    if (runtime?.status !== "ok" || isNodeStale(graph, nodeId)) return undefined;
    return runtime.outputs?.[portId]?.value as T | undefined;
  };
  const selection = currentValue<SelectionValue>(BRUSH_SELECTION_ID, "selection");
  const ground = currentValue<GroundPlaneValue>(GROUND_PLANE_ID, "plane");
  const measurement = currentValue<MeasurementValue>(MEASURE_HEIGHT_ID, "measurement");
  const measurementError = graph.runtime[MEASURE_HEIGHT_ID]?.error;

  const factor = doorFactor(ui.observations, setting);
  const corrected = measurement ? correctedValue(measurement.rawM, factor) : NaN;
  const derivedMonitorTop = objectMean(ui.observations, "table-top", setting) + objectMean(ui.observations, "monitor-own", setting);
  const currentRunObservations = ui.observations.filter((item) => item.setting === setting);
  const activeStats = trialStats(ui.observations, object.id, setting);
  const activeTrials = trialsFor(ui.observations, object.id, setting);
  const repeatedMasks = duplicateMaskTrialIds(ui.observations, object.id, setting);

  // One point per object, at its trial mean. Feeding every trial in would let a thrice-measured
  // door outvote a once-measured table and shrink the residual by repetition alone.
  const errorModelPoints = useMemo(
    () =>
      MEASUREMENT_OBJECTS.map((item) => {
        const stats = trialStats(ui.observations, item.id, setting);
        const spreads = trialsFor(ui.observations, item.id, setting).map((trial) => trial.internalSpreadM);
        return { id: item.id, truth: item.truthM, predicted: stats.meanM, uncertainty: mean(spreads) };
      }).filter((point) => Number.isFinite(point.predicted)),
    [setting, ui.observations],
  );

  const resolutionRows = useMemo(
    () =>
      FIXTURE_SETTINGS.map((candidate) => {
        const holdouts = MEASUREMENT_OBJECTS.filter(
          (item) => item.id !== "door-leaf" && !item.availabilityNote,
        )
          .map((item) => ({ item, raw: objectMean(ui.observations, item.id, candidate) }))
          .filter((entry) => Number.isFinite(entry.raw));
        const calibration = doorFactor(ui.observations, candidate);
        const rawMae = mean(holdouts.map(({ item, raw }) => Math.abs(raw - item.truthM)));
        const correctedMae = Number.isFinite(calibration)
          ? mean(
              holdouts.map(({ item, raw }) =>
                Math.abs(correctedValue(raw, calibration) - item.truthM),
              ),
            )
          : NaN;
        return { setting: candidate, views: holdouts.length, rawMae, correctedMae, calibration };
      }),
    [ui.observations],
  );

  const capture = () => {
    if (!measurement || !selection || !ground) return;
    addObservation({
      objectId: object.id,
      setting,
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
    });
  };

  const recompute = async () => {
    invalidateFrom([GROUND_PLANE_ID, BRUSH_SELECTION_ID]);
    await runAuto();
  };

  return (
    <div className="pane">
      <div className="pane-status">
        <span className="ok">M3b evidence</span>
        <span>{ui.observations.length} trials</span>
        <span className="hint">{sourceMode === "recorded" ? "recorded DA3 evidence" : "live DA3 exploration"}</span>
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
              aria-label="Recorded fixture run"
              value={setting}
              disabled={sourceMode !== "recorded"}
              onChange={(event) => {
                setNodeParam(FIXTURE_RUN_ID, "setting", event.target.value);
                void runAuto();
              }}
            >
              <option value="504px-112f">504 px · 112f</option>
              <option value="356px-256f">356 px · 256f</option>
              <option value="252px-256f">252 px · 256f</option>
            </select>
          </label>
          <span>{sourceMode === "recorded" ? `GPU ${GPU_TIMES[setting].toFixed(2)} s` : "run DA3 manually"}</span>
        </section>

        <section className="object-list" aria-label="Measurement objects">
          {MEASUREMENT_OBJECTS.map((item) => (
            <EvidenceRow key={item.id} object={item} setting={setting} />
          ))}
        </section>

        <section className="evidence-card">
          <div className="evidence-title">
            <span><b>{object.code}</b> {object.name}</span>
            <span className="truth">truth {object.truthM.toFixed(3)} m</span>
          </div>
          <p>{object.definition}</p>
          <div className="reading-grid">
            <span>RAW DA3</span><b>{measurement ? formatM(measurement.rawM) : "—"}</b>
            <span>INTERNAL SPREAD</span><b>{measurement ? `±${measurement.internalSpreadM.toFixed(3)} m` : "—"}</b>
            <span>{object.id === "door-leaf" ? "CALIBRATION TARGET" : "DOOR-SCALE CHECK"}</span><b>{formatM(corrected)}</b>
            <span>SELECTED</span><b>{selection ? `${selection.diagnostics.pointCount.toLocaleString()} pts` : "—"}</b>
          </div>
          {measurementError && <div className="evidence-warning">{measurementError}</div>}
          {object.availabilityNote && <div className="evidence-warning">{object.availabilityNote}</div>}
          {!Number.isFinite(factor) && object.id !== "door-leaf" && (
            <div className="evidence-warning">Record B1 in this setting before treating the corrected number as evidence.</div>
          )}
          {object.id === "monitor-top" && (
            <div className="composition-check">
              <span>Composition B2 + B4</span>
              <b>{formatM(derivedMonitorTop)}</b>
              <small>Cross-check only; it is not a fifth independent object.</small>
            </div>
          )}
          <section className="trial-block">
            <div className="trial-head">
              <div>
                <span>REPEAT TRIALS</span>
                <b>{activeStats.n}</b>
              </div>
              <div>
                <span>OPERATOR SPREAD</span>
                <b className={activeStats.n >= MIN_TRIALS_FOR_SPREAD ? "" : "unproven"}>
                  {activeStats.n > 1 ? `${activeStats.rangeM.toFixed(3)} m` : "—"}
                </b>
              </div>
              <div>
                <span>MEDIAN PAINT</span>
                <b>{formatDuration(activeStats.medianPaintMs)}</b>
              </div>
            </div>
            {activeTrials.length > 0 && (
              <ol className="trial-list">
                {activeTrials.map((trial) => (
                  <li key={trial.id} className={repeatedMasks.has(trial.id) ? "repeated-mask" : ""}>
                    <span className="mono">#{trial.trialIndex}</span>
                    <b>{trial.rawM.toFixed(3)} m</b>
                    <span className="mono">{(trial.rawM - object.truthM >= 0 ? "+" : "") + (trial.rawM - object.truthM).toFixed(3)}</span>
                    <span className="mono">
                      {repeatedMasks.has(trial.id)
                        ? "same mask as an earlier trial"
                        : trial.mask
                          ? `${trial.mask.paintedPixels.toLocaleString()} px · ${trial.mask.digest.slice(0, 8)}`
                          : "no mask evidence"}
                    </span>
                    <span className="mono">{formatDuration(trial.paintDurationMs ?? NaN)}</span>
                    <button className="trial-drop" title="Discard this trial" onClick={() => removeObservation(trial.id)}>×</button>
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
            <button disabled={sourceMode !== "recorded" || !measurement || !selection || !ground} onClick={capture}>
              Record trial {activeStats.n + 1}
            </button>
            <button disabled={graph.running} onClick={() => void recompute()}>
              {graph.running ? "Recomputing…" : "Recompute from source"}
            </button>
          </div>
          <small className="honesty-note">Masks are operator evidence. Review the pink RGB/depth edges and 3D highlight before accepting a row.</small>
          <small className="honesty-note"><b>Paint:</b> {object.maskInstruction}</small>
        </section>

        <section className="resolution-card">
          <h3>Resolution vs frame-count verdict</h3>
          <div className="resolution-head"><span>Setting</span><span>Holdouts</span><span>Raw MAE</span><span>Door-scaled</span></div>
          {resolutionRows.map((row) => (
            <div className="resolution-row" key={row.setting}>
              <span>{row.setting}</span>
              <span>{row.views}/3</span>
              <span>{formatM(row.rawMae)}</span>
              <span>{formatM(row.correctedMae)}</span>
            </div>
          ))}
          <p>
            The single door-derived factor is shown as a secondary scale check for every length. Raw DA3 remains primary; B4 stays excluded until its stand contact is visible.
          </p>
        </section>

        <section className="error-model-card">
          <h3>Current-run raw error model</h3>
          {errorModelPoints.length >= 2 ? (() => {
            const model = fitErrorModel(errorModelPoints);
            return <div className="reading-grid"><span>SLOPE</span><b>{model.slope.toFixed(3)}</b><span>INTERCEPT</span><b>{model.intercept.toFixed(3)} m</b><span>RESIDUAL RMS</span><b>{model.residualRms.toFixed(3)} m</b><span>MEAN ABSREL</span><b>{(model.meanAbsRel * 100).toFixed(1)}%</b><span>MAX ERROR</span><b>{model.maxAbsError.toFixed(3)} m</b></div>;
          })() : <p>Record at least two distinct truths.</p>}
          <small className="honesty-note">
            Fitted over {errorModelPoints.length} object{errorModelPoints.length === 1 ? "" : "s"} from{" "}
            {currentRunObservations.length} trial{currentRunObservations.length === 1 ? "" : "s"}. Each object
            contributes its trial mean once — repeat trials of one door are not independent truths.
          </small>
          <div className="evidence-actions"><button onClick={downloadSession}>Export evidence JSON</button></div>
        </section>
      </div>
    </div>
  );
}
