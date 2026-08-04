/**
 * These cases pin the one property that matters: a known bias must never end up inside the
 * random ±. The app shipped the opposite for the whole of M3b — patch roughness displayed as
 * if it bounded the total error — and the P0 study is what exposed it.
 */

import { describe, expect, it } from "vitest";
import { fitErrorModel, type Observation } from "./calibrate";
import { composeUncertainty, UNCERTAINTY_LIMITATION } from "./uncertainty";

/** The real 2026-08-04 trial means at 504px · 112f. */
const CLIP_B: Observation[] = [
  { id: "door-leaf", truth: 2.1, predicted: 2.0197 },
  { id: "table-top", truth: 0.75, predicted: 0.6983 },
  { id: "pc-tower", truth: 0.45, predicted: 0.4275 },
];

describe("composeUncertainty", () => {
  it("keeps a known scale bias out of the random term", () => {
    const model = fitErrorModel(CLIP_B);
    const budget = composeUncertainty({
      valueM: 2.0197,
      patchRoughnessM: 0.003,
      operatorRangeM: 0.0059,
      model,
    });

    // Random is millimetric: roughness ⊕ half the 5.9 mm operator range.
    expect(budget.randomM).toBeGreaterThan(0.003);
    expect(budget.randomM).toBeLessThan(0.006);
    // The bias against truth is an order of magnitude larger and is reported separately.
    expect(budget.biasRelative).toBeLessThan(-0.02);
    expect(budget.biasRelative).toBeGreaterThan(-0.06);
    expect(Math.abs(budget.biasRelative) * budget.calibratedM).toBeGreaterThan(budget.randomM * 5);
  });

  it("calibrates the door onto its truth", () => {
    const model = fitErrorModel(CLIP_B);
    const budget = composeUncertainty({ valueM: 2.0197, patchRoughnessM: 0.003, model });
    expect(budget.calibrated).toBe(true);
    // ×1.04 lands within a few cm of the 2.10 m tape truth.
    expect(budget.calibratedM).toBeGreaterThan(2.06);
    expect(budget.calibratedM).toBeLessThan(2.14);
    expect(budget.calibratedUncertaintyM).toBeGreaterThan(0);
    expect(budget.dominant).toBe("systematic");
  });

  it("withholds the operator term rather than reporting it as zero", () => {
    const budget = composeUncertainty({ valueM: 0.7, patchRoughnessM: 0.004 });
    expect(budget.terms.some((term) => term.label === "operator repeatability")).toBe(false);
    expect(budget.randomM).toBeCloseTo(0.004, 9);
    expect(budget.basis).toContain("needs 3 trials");
  });

  it("refuses to calibrate from a single graded object", () => {
    // One object gives a ratio, not a line — it says nothing about any other length.
    const model = fitErrorModel([{ id: "door-leaf", truth: 2.1, predicted: 2.0197 }]);
    const budget = composeUncertainty({ valueM: 0.7, patchRoughnessM: 0.004, model });
    expect(budget.calibrated).toBe(false);
    expect(budget.calibratedM).toBeNaN();
    expect(budget.biasRelative).toBeNaN();
    expect(budget.dominant).toBe("unknown");
    expect(budget.basis).toContain("no calibration basis");
  });

  it("survives having no model at all", () => {
    const budget = composeUncertainty({ valueM: 1, patchRoughnessM: NaN });
    expect(budget.randomM).toBeNaN();
    expect(budget.calibrated).toBe(false);
    expect(budget.terms).toHaveLength(0);
  });

  it("names the operator as dominant when placement is the loose term", () => {
    const model = fitErrorModel(synthesiseExact());
    // A 10 cm spread across trials dwarfs both roughness and a perfect calibration.
    const budget = composeUncertainty({
      valueM: 2,
      patchRoughnessM: 0.002,
      operatorRangeM: 0.1,
      model,
    });
    expect(budget.dominant).toBe("operator");
  });

  it("states its own limitation", () => {
    expect(UNCERTAINTY_LIMITATION).toContain("wrong place");
  });
});

/** A clip with no bias and no scatter, so only the supplied random terms can dominate. */
function synthesiseExact(): Observation[] {
  return [0.45, 0.75, 2.1].map((truth, i) => ({ id: `o${i}`, truth, predicted: truth }));
}
