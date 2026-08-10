import { describe, expect, it } from "vitest";
import { measurementEvidenceId } from "./evidence";
import type { MeasurementObservation } from "./measurement-store";

function observation(overrides: Partial<MeasurementObservation> = {}): MeasurementObservation {
  return {
    id: "door-leaf:door-504px-112f#1",
    objectId: "door-leaf",
    runId: "door-504px-112f",
    trialIndex: 1,
    canonicalFrame: 1,
    npzFrame: 1,
    rawM: 2,
    internalSpreadM: 0.01,
    pointCount: 500,
    confidenceThreshold: 1,
    floorRmseM: 0.01,
    floorTiltDeg: 1,
    floorBelowFraction: 0.01,
    gravityCoherence: 0.99,
    capturedAt: "2026-08-09T12:00:00.000Z",
    sittingId: "sitting-one",
    ...overrides,
  };
}

describe("measurementEvidenceId", () => {
  it("does not let trial #1 in a later sitting overwrite trial #1 from an earlier sitting", () => {
    const first = observation();
    const later = observation({
      sittingId: "sitting-two",
      capturedAt: "2026-08-10T12:00:00.000Z",
    });

    expect(first.id).toBe(later.id);
    expect(measurementEvidenceId(first)).not.toBe(measurementEvidenceId(later));
  });
});
