/**
 * Grading DA3 against a tape measure — and separating the two kinds of error.
 *
 * DA3 claims metric output, so the first question is simply "is it right?". But the
 * useful question is sharper: *how much of the error can we remove, and how much is
 * irreducible?* A single object cannot answer that. Several objects at different heights
 * can, because they define a line:
 *
 *     predicted = slope · truth + intercept
 *
 *   slope ≠ 1     → a systematic SCALE bias. Correctable per clip.
 *   intercept ≠ 0 → a systematic OFFSET, e.g. the ground plane fitted too low.
 *                   Correctable, and it points at a specific bug rather than at the model.
 *   residual RMS  → the NOISE FLOOR. Not correctable. This is the number that decides
 *                   whether fine-grained work (vegetation) is viable at all.
 *
 * ⚠️ SCALE DOES NOT TRANSFER BETWEEN CLIPS. Metric scale from monocular models drifts
 * with scene, depth range and camera parameters — the classical "scale drift" problem.
 * A factor fitted on one clip must never be cached and reused on another. Calibrating
 * *within* a clip against a reference visible in that same clip is legitimate, and is
 * exactly what a scale bar in the scene has always been for.
 *
 * By default this module REPORTS and does not correct. DA3's metric output stays the
 * primary estimate and the known object is a QA gate; if the factor comes out at 1.00,
 * that is a result worth having, and silently applying a correction would have hidden it.
 */

export interface Observation {
  id: string;
  /** Tape-measure truth, metres. */
  truth: number;
  /** What the pipeline measured, metres. */
  predicted: number;
  /** The ± the pipeline reported, if any. Used only for the QA verdict. */
  uncertainty?: number;
}

export interface Residual extends Observation {
  /** What the fitted line predicts for this truth. */
  fitted: number;
  /** predicted − fitted, metres. */
  residual: number;
  /** predicted − truth, metres. */
  error: number;
}

export interface ErrorModel {
  observations: number;
  /** Slope of predicted-vs-truth. 1.0 means DA3's metric claim holds. */
  slope: number;
  /** Intercept in metres. Non-zero suggests a ground-plane bias, not a model bias. */
  intercept: number;
  /** RMS of residuals about the fitted line — the irreducible noise floor. */
  residualRms: number;
  /**
   * Through-origin scale factor: multiply a prediction by this to correct it.
   * Least squares on `truth ≈ factor · predicted`.
   */
  scaleFactor: number;
  scaleFactorStdErr: number;
  /** Largest |predicted − truth| before any correction, metres. */
  maxAbsError: number;
  /** Mean |predicted − truth| / truth, i.e. the AbsRel this pipeline actually achieves. */
  meanAbsRel: number;
  residuals: Residual[];
}

function usable(observations: readonly Observation[]): Observation[] {
  return observations.filter(
    (o) => Number.isFinite(o.truth) && Number.isFinite(o.predicted) && o.truth > 0,
  );
}

/**
 * Fit the error model.
 *
 * With a single observation there is no line to fit: slope and intercept are reported as
 * NaN rather than as a fabricated perfect fit, and only the ratio-based scale factor is
 * meaningful. Honest degradation beats a confident number derived from nothing.
 */
export function fitErrorModel(observations: readonly Observation[]): ErrorModel {
  const data = usable(observations);
  if (data.length === 0) throw new Error("fitErrorModel: no usable observations");

  // Through-origin least squares: minimise Σ(truth − factor·predicted)².
  let sumTP = 0;
  let sumPP = 0;
  for (const o of data) {
    sumTP += o.truth * o.predicted;
    sumPP += o.predicted * o.predicted;
  }
  const scaleFactor = sumPP > 0 ? sumTP / sumPP : NaN;

  let slope = NaN;
  let intercept = NaN;
  if (data.length >= 2) {
    const n = data.length;
    const meanT = data.reduce((s, o) => s + o.truth, 0) / n;
    const meanP = data.reduce((s, o) => s + o.predicted, 0) / n;
    let stt = 0;
    let stp = 0;
    for (const o of data) {
      stt += (o.truth - meanT) ** 2;
      stp += (o.truth - meanT) * (o.predicted - meanP);
    }
    if (stt > 1e-12) {
      slope = stp / stt;
      intercept = meanP - slope * meanT;
    }
  }

  const residuals: Residual[] = data.map((o) => {
    const fitted = Number.isFinite(slope) ? slope * o.truth + intercept : NaN;
    return {
      ...o,
      fitted,
      residual: Number.isFinite(fitted) ? o.predicted - fitted : NaN,
      error: o.predicted - o.truth,
    };
  });

  const finiteResiduals = residuals.map((r) => r.residual).filter(Number.isFinite);
  const residualRms =
    finiteResiduals.length > 0
      ? Math.sqrt(finiteResiduals.reduce((s, r) => s + r * r, 0) / finiteResiduals.length)
      : NaN;

  // Standard error of the through-origin factor, in factor units.
  let scaleFactorStdErr = NaN;
  if (data.length >= 2 && sumPP > 0) {
    let ss = 0;
    for (const o of data) ss += (o.truth - scaleFactor * o.predicted) ** 2;
    scaleFactorStdErr = Math.sqrt(ss / (data.length - 1) / sumPP);
  }

  return {
    observations: data.length,
    slope,
    intercept,
    residualRms,
    scaleFactor,
    scaleFactorStdErr,
    maxAbsError: Math.max(...residuals.map((r) => Math.abs(r.error))),
    meanAbsRel: data.reduce((s, o) => s + Math.abs(o.predicted - o.truth) / o.truth, 0) / data.length,
    residuals,
  };
}

export type ScaleVerdict = "within-uncertainty" | "biased" | "unknown";

/**
 * The per-clip QA gate: does the reference object read its true size?
 *
 * `within-uncertainty` means the pipeline's own error bar covers the truth — the only
 * case in which an uncorrected measurement can be reported without a caveat.
 */
export function scaleVerdict(observation: Observation): ScaleVerdict {
  if (!Number.isFinite(observation.predicted) || !Number.isFinite(observation.truth)) {
    return "unknown";
  }
  const tolerance = observation.uncertainty;
  if (!Number.isFinite(tolerance ?? NaN)) return "unknown";
  return Math.abs(observation.predicted - observation.truth) <= (tolerance as number)
    ? "within-uncertainty"
    : "biased";
}
