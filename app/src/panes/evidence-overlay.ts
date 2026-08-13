/**
 * What a run's recorded evidence looks like in the 3D scene.
 *
 * A recorded trial keeps its number, its frozen mask and — since 2026-08-12 — the two endpoints
 * the number was read between. The mask has always been inspectable in the Objects pane; the
 * ruler was computed, drawn live, written to disk and then never read back, so a person opening a
 * saved run saw four measurements and nothing in the scene that produced them. This module
 * decides WHICH evidence is on screen; `viewport-3d.tsx` draws whatever it returns.
 *
 * ## Why this is a list of items rather than a list of rulers
 *
 * A ruler is the first form of evidence, not the only one — a photograph with the measured span
 * marked on it is the obvious next one. `EvidenceItem` is a discriminated union so a second kind
 * can be added without touching the selection rules below, which are about which TRIAL speaks for
 * an object and have nothing to do with how it is drawn.
 */

import type { Vec3 } from "../../../geometry";
import {
  trialsFor,
  trialIdentity,
  type MeasurementContext,
  type MeasurementObject,
  type MeasurementObservation,
} from "../measurement/measurement-store";
import type { RunId } from "../lib/runs";

export interface EvidenceRuler {
  kind: "ruler";
  /** `trialIdentity` of the trial this was frozen from. Stable across reloads. */
  id: string;
  objectId: string;
  /** The target's short code, e.g. `B1` — what the label in the scene says. */
  code: string;
  /** Drawn beside the ruler. Carries the value and why THIS trial is the one shown. */
  label: string;
  valueM: number;
  bottom: Vec3;
  top: Vec3;
  rulerKind: "floor_height" | "extent";
  /** The operator clicked this trial's row. Drawn at full strength; the rest are dimmed. */
  focused: boolean;
}

export type EvidenceItem = EvidenceRuler;

export interface EvidenceQuery {
  observations: readonly MeasurementObservation[];
  targets: readonly MeasurementObject[];
  runId: RunId;
  context: MeasurementContext;
  showEvidence: boolean;
  focusedTrialId: string | null;
  blind: boolean;
}

/**
 * The trial that speaks for an object: the one nearest the group's median reading.
 *
 * Not the latest, which would make the picture depend on the order the operator happened to
 * work in, and not the closest to truth, which would quietly select for the flattering trial.
 * The median is the figure the Objects pane already reports for the object, so the ruler on
 * screen and the number in the pane describe the same trial. Ties go to the lower trial number,
 * so the choice does not move when nothing about the evidence has.
 */
export function representativeTrial(
  trials: readonly MeasurementObservation[],
): MeasurementObservation | undefined {
  const rows = trials.filter((row) => Number.isFinite(row.rawM));
  if (!rows.length) return undefined;
  const sorted = [...rows].sort((a, b) => a.rawM - b.rawM);
  const middle =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2].rawM
      : (sorted[sorted.length / 2 - 1].rawM + sorted[sorted.length / 2].rawM) / 2;
  return rows.reduce((best, row) => {
    const distance = Math.abs(row.rawM - middle);
    const bestDistance = Math.abs(best.rawM - middle);
    if (distance < bestDistance - 1e-12) return row;
    if (distance <= bestDistance + 1e-12 && row.trialIndex < best.trialIndex) return row;
    return best;
  });
}

/**
 * `candidates` counts the trials this ruler was CHOSEN FROM, which is the trials that kept a
 * ruler — not every trial of the object.
 *
 * Counting them all overstates the evidence: the door target has six trials and one that froze
 * its endpoints, and labelling that one `median of 6` claims a middle reading drawn from six when
 * five of them could not be drawn at all. A lone ruler over an object measured four times still
 * has to say it is one of four, so the qualifier stays wherever there is more than one candidate.
 */
function rulerLabel(
  code: string,
  trial: MeasurementObservation,
  candidates: number,
  focused: boolean,
): string {
  const value = `${code} · ${trial.rawM.toFixed(3)} m`;
  if (candidates < 2) return value;
  return focused
    ? `${value} · trial ${trial.trialIndex} of ${candidates}`
    : `${value} · median of ${candidates}`;
}

/**
 * Every piece of recorded evidence that should be drawn right now.
 *
 * Three states return nothing at all, and each is deliberate:
 *
 * - **Free measurement.** Nothing is recorded in Free, so there is no evidence to expose; the
 *   live ruler for the mask being painted is drawn separately and is not this module's business.
 * - **Blind mode.** Blind exists so a repeat trial is not anchored by the previous answer. A
 *   ruler standing in the scene gives away the endpoint placement even with the number removed,
 *   which is the larger half of what blind is protecting.
 * - **Nothing recorded yet**, or trials recorded before the ruler was frozen (see
 *   `MeasurementObservation.ruler`).
 */
export function collectRunEvidence(query: EvidenceQuery): EvidenceItem[] {
  const { observations, targets, runId, context, showEvidence, focusedTrialId, blind } = query;
  if (context !== "object" || blind) return [];

  // Grouped by the object each TRIAL names, not by the target list. A run's evidence outlives the
  // definitions it was recorded against: targets live in browser storage keyed by clip, so a
  // fresh profile opening a saved run has the packets and none of the targets — which is exactly
  // the state a person seeing this project for the first time is in. Falling back to the recorded
  // object id keeps the rulers on screen and merely gives them a plainer name.
  const measured = [...new Set(observations.filter((row) => row.runId === runId).map((row) => row.objectId))];

  const items: EvidenceItem[] = [];
  for (const objectId of measured) {
    const trials = trialsFor(observations, objectId, runId);
    const withRuler = trials.filter((row) => row.ruler !== undefined);
    if (!withRuler.length) continue;

    const focused = withRuler.find((row) => trialIdentity(row) === focusedTrialId);
    // Switching the layer off does not overrule an explicit click: asking for one trial's
    // evidence is a narrower request than asking for the run's, not a contradicting one.
    const chosen = focused ?? (showEvidence ? representativeTrial(withRuler) : undefined);
    if (!chosen?.ruler) continue;

    const code = targets.find((target) => target.id === objectId)?.code ?? objectId;
    items.push({
      kind: "ruler",
      id: trialIdentity(chosen),
      objectId,
      code,
      label: rulerLabel(code, chosen, withRuler.length, focused !== undefined),
      valueM: chosen.rawM,
      bottom: chosen.ruler.bottom,
      top: chosen.ruler.top,
      rulerKind: chosen.rulerKind ?? "extent",
      focused: focused !== undefined,
    });
  }

  // By code, so the legend and the scene agree and neither depends on target insertion order.
  return items.sort((a, b) => a.code.localeCompare(b.code));
}
