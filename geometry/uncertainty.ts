/**
 * The uncertainty budget — what the ± next to a measurement is actually allowed to mean.
 *
 * Until 2026-08-04 the app displayed `internalSpreadM` (the roughness of the local patch of
 * points at each endpoint, ±0.003–0.043 m) beside errors of 0.02–0.08 m, as if it were the
 * measurement uncertainty. It never was. The P0 repeatability study then measured the two
 * missing terms and settled which one dominates:
 *
 *   - operator endpoint placement repeats to 1–6 mm within a sitting — NOT the noise term;
 *   - the residual against truth is a consistent negative SCALE bias (−3.8%, −6.9%, −5.0%).
 *
 * A known bias is not an uncertainty. Standard practice (GUM: type A vs type B) is to state it
 * and correct for it, never to bury it inside a ± where it reads as random scatter. So this
 * module keeps the two apart:
 *
 *   RANDOM       patch roughness ⊕ operator repeatability → shrinks with more trials
 *   SYSTEMATIC   the clip's fitted scale bias → does not shrink; it is removed by calibration,
 *                and what survives calibration is the uncertainty OF the calibration
 *
 * ⚠️ Read `UNCERTAINTY_LIMITATION` before rendering any of this. The random term is bounded by
 * trials taken in one sitting, and the failure that actually happened in this project — a mask
 * whose lower endpoint never reached the bottom of the door — produces no spread at all.
 */

import type { ErrorModel } from "./calibrate";

/**
 * The caveat that must travel with any budget shown to a user.
 *
 * Exported as a constant so the number and its limitation cannot drift apart in the UI.
 */
export const UNCERTAINTY_LIMITATION =
  "Bounds one operator in one sitting. A mask placed in the wrong place produces no spread at all, so this cannot detect one.";

/** Below this many trials a spread describes one accident rather than a tendency. */
export const MIN_TRIALS_FOR_OPERATOR_TERM = 3;

export interface UncertaintyInputs {
  /** The raw measurement, metres. */
  valueM: number;
  /** Local point-cloud roughness at the endpoints — `MeasurementValue.internalSpreadM`. */
  patchRoughnessM: number;
  /** max − min across repeat trials. Omit below three trials; a range of two is a separation. */
  operatorRangeM?: number;
  /** The clip's fitted error model. Needs ≥2 graded objects to support a calibration claim. */
  model?: ErrorModel;
}

export type UncertaintyTermKind = "random" | "systematic";

export interface UncertaintyTerm {
  label: string;
  /** Contribution in metres, as a half-width. */
  valueM: number;
  kind: UncertaintyTermKind;
  /** Where the number came from, in words. Shown as a tooltip, not decoration. */
  note: string;
}

export interface UncertaintyBudget {
  /** Quadrature sum of the random terms, metres. Never includes a known bias. */
  randomM: number;
  /**
   * What survives calibration: the uncertainty of the correction itself. The bias that the
   * correction removes is reported as `biasRelative`, never folded in here — a known offset
   * dressed up as a ± is the exact mistake this module exists to stop.
   */
  systematicM: number;
  /**
   * Signed relative error of the RAW reading against truth, implied by the fitted scale.
   * −0.038 means "this clip reads 3.8% low". NaN without a calibration basis.
   */
  biasRelative: number;
  /** `valueM · scaleFactor` — the bias-corrected reading. NaN without a calibration basis. */
  calibratedM: number;
  /**
   * Half-width on the calibrated value: the random terms, plus the uncertainty of the
   * correction itself, plus how badly one factor serves all the graded objects.
   */
  calibratedUncertaintyM: number;
  /** True when a scale correction is supported by ≥2 graded objects in this setting. */
  calibrated: boolean;
  /** Which term is limiting. Names what to fix next instead of leaving the reader to guess. */
  dominant: "systematic" | "operator" | "roughness" | "unknown";
  /** Human sentence describing what the budget rests on. */
  basis: string;
  terms: UncertaintyTerm[];
}

function quadrature(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!finite.length) return NaN;
  return Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0));
}

/**
 * Compose the budget.
 *
 * Degrades honestly rather than inventing terms it does not have: no trials means no operator
 * term (not a zero), fewer than two graded objects means no calibration (not a factor of 1.0).
 */
export function composeUncertainty(inputs: UncertaintyInputs): UncertaintyBudget {
  const { valueM, patchRoughnessM, operatorRangeM, model } = inputs;
  const terms: UncertaintyTerm[] = [];

  const roughness = Number.isFinite(patchRoughnessM) ? Math.abs(patchRoughnessM) : NaN;
  if (Number.isFinite(roughness)) {
    terms.push({
      label: "patch roughness",
      valueM: roughness,
      kind: "random",
      note: "Local scatter of the points at each endpoint band. The smallest term in this project.",
    });
  }

  // A range is a full width; half of it is the comparable half-width. At n=3–5 this is a coarse
  // estimator, which is exactly why the operator term is withheld until three trials exist.
  const operatorHalfWidth =
    Number.isFinite(operatorRangeM ?? NaN) ? Math.abs(operatorRangeM as number) / 2 : NaN;
  if (Number.isFinite(operatorHalfWidth)) {
    terms.push({
      label: "operator repeatability",
      valueM: operatorHalfWidth,
      kind: "random",
      note: "Half the max−min across repeat trials. Within one sitting only.",
    });
  }

  const randomM = quadrature([roughness, operatorHalfWidth]);

  // A calibration claim needs a line, and a line needs two points. With one graded object the
  // "factor" is just that object's ratio and says nothing about any other length.
  const calibrated =
    !!model && model.observations >= 2 && Number.isFinite(model.scaleFactor) && model.scaleFactor > 0;

  let biasRelative = NaN;
  let calibratedM = NaN;
  let calibratedUncertaintyM = NaN;
  let systematicHalfWidth = NaN;

  if (calibrated && model) {
    const factor = model.scaleFactor;
    // truth ≈ factor · predicted, so the raw reading sits (1/factor − 1) away from truth.
    biasRelative = 1 / factor - 1;
    calibratedM = valueM * factor;

    const factorTerm = Number.isFinite(model.scaleFactorStdErr)
      ? Math.abs(valueM * model.scaleFactorStdErr)
      : NaN;
    const spreadTerm = Number.isFinite(model.residualRms) ? Math.abs(model.residualRms) : NaN;
    systematicHalfWidth = quadrature([factorTerm, spreadTerm]);

    if (Number.isFinite(factorTerm)) {
      terms.push({
        label: "correction factor",
        valueM: factorTerm,
        kind: "systematic",
        note: `Standard error of the ×${factor.toFixed(3)} factor fitted over ${model.observations} graded objects.`,
      });
    }
    if (Number.isFinite(spreadTerm)) {
      terms.push({
        label: "calibration residual",
        valueM: spreadTerm,
        kind: "systematic",
        note: "How far the graded objects scatter about the fitted line — one factor cannot serve them all perfectly.",
      });
    }

    calibratedUncertaintyM = quadrature([randomM * factor, systematicHalfWidth]);
  }

  const dominant: UncertaintyBudget["dominant"] = !calibrated
    ? "unknown"
    : Number.isFinite(systematicHalfWidth) && systematicHalfWidth >= (randomM || 0)
      ? "systematic"
      : Number.isFinite(operatorHalfWidth) && operatorHalfWidth >= (roughness || 0)
        ? "operator"
        : "roughness";

  const basisParts: string[] = [];
  basisParts.push(Number.isFinite(roughness) ? "patch roughness" : "no patch roughness");
  basisParts.push(
    Number.isFinite(operatorHalfWidth)
      ? "repeat trials"
      : `no operator term (needs ${MIN_TRIALS_FOR_OPERATOR_TERM} trials)`,
  );
  basisParts.push(
    calibrated && model
      ? `scale fitted over ${model.observations} graded objects`
      : "no calibration basis in this setting",
  );

  return {
    randomM,
    systematicM: systematicHalfWidth,
    biasRelative,
    calibratedM,
    calibratedUncertaintyM,
    calibrated,
    dominant,
    basis: basisParts.join(" · "),
    terms,
  };
}
