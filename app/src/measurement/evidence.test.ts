import { describe, expect, it } from "vitest";
import {
  MEASUREMENT_EVIDENCE_SCHEMA,
  measurementEvidenceId,
  recoveredObservation,
  type MeasurementEvidencePacket,
} from "./evidence";
import type { MeasurementObservation } from "./measurement-store";
import type { Vec3 } from "../../../geometry";

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

function packet(overrides: Partial<MeasurementEvidencePacket> = {}): MeasurementEvidencePacket {
  return {
    schemaVersion: MEASUREMENT_EVIDENCE_SCHEMA,
    evidenceId: "evidence-1",
    runId: "door-504px-112f",
    run: {
      id: "door-504px-112f",
      label: "Door · 504 px · 112f",
      clipName: "door.mp4",
      clipSha256: "abc",
      createdAt: "2026-08-09T12:00:00.000Z",
      frameCount: 112,
      processRes: 504,
    },
    target: null,
    observation: observation(),
    ...overrides,
  };
}

/** A 0.2.0 packet's `live` block, which is where the ruler used to be the only copy. */
function liveBlock(ruler: { bottom: Vec3; top: Vec3 }): MeasurementEvidencePacket["live"] {
  return {
    selection: {
      rejected: { eroded: 0, depth: 0, confidence: 0, discontinuity: 0 },
      maskedPixels: 10,
      pointCount: 500,
    },
    measurement: {
      mode: "vertical_extent",
      rawM: 2,
      internalSpreadM: 0.01,
      pointCount: 500,
      ruler,
      rulerKind: "extent",
      details: {},
    },
    ground: {
      plane: { normal: [0, 1, 0], offset: 0 },
      supportFraction: 0.2,
      rmseM: 0.01,
      tiltDeg: 1,
      belowFraction: 0.04,
      gravityCoherence: 0.99,
    },
  };
}

describe("recoveredObservation", () => {
  it("lifts a 0.2.0 packet's ruler into the trial the recovery path merges", () => {
    const recovered = recoveredObservation(
      packet({ live: liveBlock({ bottom: [0, 0, 0], top: [0, 2, 0] }) }),
    );

    expect(recovered.ruler?.top).toEqual([0, 2, 0]);
    expect(recovered.rulerKind).toBe("extent");
  });

  it("leaves a packet with no stored ruler anywhere without one", () => {
    // Recomputing it would need the floor of the session that recorded it, which these packets
    // predate. An absent ruler is the honest answer.
    expect(recoveredObservation(packet()).ruler).toBeUndefined();
  });

  it("does not let the outer copy overwrite the trial's own", () => {
    const own = observation({ ruler: { bottom: [1, 0, 0], top: [1, 2, 0] }, rulerKind: "extent" });
    const recovered = recoveredObservation(
      packet({ observation: own, live: liveBlock({ bottom: [0, 0, 0], top: [0, 2, 0] }) }),
    );

    expect(recovered.ruler?.bottom).toEqual([1, 0, 0]);
  });
});
