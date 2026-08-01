/**
 * The error model is M3's real deliverable — more than any single object's number.
 * These cases pin that it can actually separate a scale bias from an offset from noise,
 * because that separation is what decides whether the project's accuracy problem is
 * fixable by calibration or is a hard floor.
 */

import { describe, expect, it } from "vitest";
import { fitErrorModel, scaleVerdict, type Observation } from "./calibrate";

/** The clip-B reference set: 0.45 → 2.10 m, a 4.7× span. */
const TRUTHS = [0.45, 0.534, 0.75, 1.284, 2.1];

function synthesise(slope: number, intercept: number, noise: number[] = []): Observation[] {
  return TRUTHS.map((truth, i) => ({
    id: `object-${i}`,
    truth,
    predicted: slope * truth + intercept + (noise[i] ?? 0),
  }));
}

describe("fitErrorModel", () => {
  it("reports a clean bill of health when the model is exact", () => {
    const model = fitErrorModel(synthesise(1, 0));
    expect(model.slope).toBeCloseTo(1, 9);
    expect(model.intercept).toBeCloseTo(0, 9);
    expect(model.scaleFactor).toBeCloseTo(1, 9);
    expect(model.residualRms).toBeCloseTo(0, 9);
    expect(model.meanAbsRel).toBeCloseTo(0, 9);
  });

  it("recovers a pure SCALE bias — the correctable case", () => {
    // Everything reads 7% small: slope 0.93, no offset, and a 1/0.93 correction factor.
    const model = fitErrorModel(synthesise(0.93, 0));
    expect(model.slope).toBeCloseTo(0.93, 6);
    expect(model.intercept).toBeCloseTo(0, 6);
    expect(model.scaleFactor).toBeCloseTo(1 / 0.93, 6);
    expect(model.residualRms).toBeCloseTo(0, 9);
  });

  it("recovers a pure OFFSET — which points at the ground plane, not the model", () => {
    // Every height reads 4 cm high: a floor fitted 4 cm too low would do exactly this,
    // and it is NOT a scale problem, so a scale correction would not fix it.
    const model = fitErrorModel(synthesise(1, 0.04));
    expect(model.slope).toBeCloseTo(1, 6);
    expect(model.intercept).toBeCloseTo(0.04, 6);
    expect(model.residualRms).toBeCloseTo(0, 9);
  });

  it("separates bias from noise — the number that decides if this is viable", () => {
    const noise = [0.01, -0.012, 0.008, -0.009, 0.011];
    const model = fitErrorModel(synthesise(0.95, 0.02, noise));
    expect(model.slope).toBeCloseTo(0.95, 1);
    expect(model.intercept).toBeCloseTo(0.02, 1);
    // The residual scatter survives after both biases are removed. That is the floor.
    expect(model.residualRms).toBeGreaterThan(0.005);
    expect(model.residualRms).toBeLessThan(0.02);
  });

  it("reports AbsRel, so the result is comparable with published depth benchmarks", () => {
    // A flat 10% underestimate everywhere is AbsRel 0.10 — DA3's own reported figure.
    const model = fitErrorModel(synthesise(0.9, 0));
    expect(model.meanAbsRel).toBeCloseTo(0.1, 6);
  });

  it("degrades honestly with a single observation instead of faking a perfect fit", () => {
    const model = fitErrorModel([{ id: "door", truth: 2.1, predicted: 2.0 }]);
    expect(model.slope).toBeNaN();
    expect(model.intercept).toBeNaN();
    expect(model.residualRms).toBeNaN();
    // The ratio is still meaningful with one reference; the LINE is not.
    expect(model.scaleFactor).toBeCloseTo(2.1 / 2.0, 6);
  });

  it("keeps every residual for the results table", () => {
    const model = fitErrorModel(synthesise(0.95, 0));
    expect(model.residuals).toHaveLength(TRUTHS.length);
    expect(model.residuals[4].error).toBeCloseTo(0.95 * 2.1 - 2.1, 6);
  });

  it("reports the worst absolute error, which is what a user actually feels", () => {
    const model = fitErrorModel(synthesise(0.9, 0));
    expect(model.maxAbsError).toBeCloseTo(0.1 * 2.1, 6);
  });

  it("ignores unusable rows rather than propagating NaN through the fit", () => {
    const model = fitErrorModel([
      ...synthesise(1, 0),
      { id: "unmeasured", truth: 0.3, predicted: NaN },
      { id: "bad-truth", truth: 0, predicted: 0.5 },
    ]);
    expect(model.observations).toBe(TRUTHS.length);
    expect(model.slope).toBeCloseTo(1, 9);
  });

  it("throws when nothing is usable", () => {
    expect(() => fitErrorModel([])).toThrow(/no usable observations/);
  });

  it("gives a standard error that grows with scatter", () => {
    const tight = fitErrorModel(synthesise(0.95, 0, [0.001, -0.001, 0.001, -0.001, 0.001]));
    const loose = fitErrorModel(synthesise(0.95, 0, [0.05, -0.05, 0.05, -0.05, 0.05]));
    expect(loose.scaleFactorStdErr).toBeGreaterThan(tight.scaleFactorStdErr);
  });
});

describe("scaleVerdict", () => {
  it("passes when the reported error bar covers the truth", () => {
    expect(scaleVerdict({ id: "door", truth: 2.1, predicted: 2.08, uncertainty: 0.05 })).toBe(
      "within-uncertainty",
    );
  });

  it("flags a bias the error bar cannot explain away", () => {
    expect(scaleVerdict({ id: "door", truth: 2.1, predicted: 1.85, uncertainty: 0.05 })).toBe(
      "biased",
    );
  });

  it("says unknown rather than guessing when no uncertainty was reported", () => {
    expect(scaleVerdict({ id: "door", truth: 2.1, predicted: 2.08 })).toBe("unknown");
    expect(scaleVerdict({ id: "door", truth: 2.1, predicted: NaN, uncertainty: 0.05 })).toBe(
      "unknown",
    );
  });
});
