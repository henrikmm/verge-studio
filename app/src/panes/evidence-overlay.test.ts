import { describe, expect, it } from "vitest";
import { collectRunEvidence, representativeTrial, type EvidenceQuery } from "./evidence-overlay";
import { trialIdentity, type MeasurementObject, type MeasurementObservation } from "../measurement/measurement-store";

const RUN = "door-504px-112f";

function trial(overrides: Partial<MeasurementObservation> = {}): MeasurementObservation {
  const objectId = overrides.objectId ?? "door-leaf";
  const trialIndex = overrides.trialIndex ?? 1;
  return {
    id: `${objectId}:${RUN}#${trialIndex}`,
    objectId,
    runId: RUN,
    trialIndex,
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
    capturedAt: `2026-08-12T12:00:0${trialIndex}.000Z`,
    sittingId: "sitting-one",
    ruler: { bottom: [0, 0, 0], top: [0, 2, 0] },
    rulerKind: "extent",
    ...overrides,
  };
}

function target(overrides: Partial<MeasurementObject> = {}): MeasurementObject {
  return {
    id: "door-leaf",
    code: "B1",
    name: "Door leaf",
    definition: "physical leaf, bottom edge to top edge",
    truthM: 2.1,
    mode: "vertical_extent",
    suggestedFrame: 1,
    maskInstruction: "paint it",
    ...overrides,
  };
}

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    observations: [trial()],
    targets: [target()],
    runId: RUN,
    context: "object",
    showEvidence: true,
    focusedTrialId: null,
    blind: false,
    ...overrides,
  };
}

describe("representativeTrial", () => {
  it("picks the reading nearest the group's median, not the latest", () => {
    const rows = [
      trial({ trialIndex: 1, rawM: 1.9 }),
      trial({ trialIndex: 2, rawM: 2.0 }),
      trial({ trialIndex: 3, rawM: 2.6 }),
    ];

    expect(representativeTrial(rows)?.trialIndex).toBe(2);
  });

  it("breaks a tie on the lower trial number, so the choice does not drift", () => {
    const rows = [trial({ trialIndex: 2, rawM: 1.9 }), trial({ trialIndex: 1, rawM: 2.1 })];

    // Median of two is their mean; both sit 0.1 m from it.
    expect(representativeTrial(rows)?.trialIndex).toBe(1);
  });

  it("ignores a trial whose reading is not a number", () => {
    const rows = [trial({ trialIndex: 1, rawM: NaN }), trial({ trialIndex: 2, rawM: 2.2 })];

    expect(representativeTrial(rows)?.trialIndex).toBe(2);
  });
});

describe("collectRunEvidence", () => {
  it("draws one ruler per measured object rather than one per trial", () => {
    const items = collectRunEvidence(
      query({
        observations: [
          trial({ trialIndex: 1, rawM: 2.0 }),
          trial({ trialIndex: 2, rawM: 2.1 }),
          trial({ trialIndex: 3, rawM: 2.2 }),
          trial({ objectId: "table-top", trialIndex: 1, rawM: 0.75 }),
        ],
        targets: [target(), target({ id: "table-top", code: "B2", name: "Table top" })],
      }),
    );

    expect(items.map((item) => item.code)).toEqual(["B1", "B2"]);
    expect(items[0].valueM).toBeCloseTo(2.1, 6);
    expect(items[0].label).toBe("B1 · 2.100 m · median of 3");
    expect(items[1].label).toBe("B2 · 0.750 m");
  });

  it("shows nothing in free measurement, where nothing is recorded", () => {
    expect(collectRunEvidence(query({ context: "free" }))).toEqual([]);
  });

  it("shows nothing in blind mode, because a ruler gives away the endpoints", () => {
    expect(collectRunEvidence(query({ blind: true }))).toEqual([]);
  });

  it("skips trials recorded before the ruler was frozen", () => {
    const items = collectRunEvidence(
      query({ observations: [trial({ ruler: undefined, rulerKind: undefined })] }),
    );

    expect(items).toEqual([]);
  });

  it("counts only the trials a ruler could have come from, never every trial of the object", () => {
    // The door target as it stands on disk: six trials, one that froze its endpoints. Labelling
    // that one `median of 6` would claim a middle reading drawn from five rulers that do not exist.
    const items = collectRunEvidence(
      query({
        observations: [
          trial({ trialIndex: 1, rawM: 1.8, ruler: undefined, rulerKind: undefined }),
          trial({ trialIndex: 2, rawM: 1.9, ruler: undefined, rulerKind: undefined }),
          trial({ trialIndex: 3, rawM: 2.3 }),
        ],
      }),
    );

    expect(items[0].label).toBe("B1 · 2.300 m");
    expect(items[0].valueM).toBeCloseTo(2.3, 6);
  });

  it("still draws a trial whose target definition this profile does not have", () => {
    // Targets live in browser storage keyed by clip; the packets on disk do not restore them.
    const items = collectRunEvidence(query({ targets: [] }));

    expect(items).toHaveLength(1);
    expect(items[0].code).toBe("door-leaf");
    expect(items[0].label).toBe("door-leaf · 2.000 m");
  });

  it("ignores trials belonging to another run", () => {
    const other = trial({ runId: "20260811-161356-d387ec" });

    expect(collectRunEvidence(query({ observations: [other] }))).toEqual([]);
  });

  it("swaps in the clicked trial and marks it, leaving the other objects drawn", () => {
    const clicked = trial({ trialIndex: 3, rawM: 2.35 });
    const items = collectRunEvidence(
      query({
        observations: [
          trial({ trialIndex: 1, rawM: 2.0 }),
          trial({ trialIndex: 2, rawM: 2.1 }),
          clicked,
          trial({ objectId: "table-top", trialIndex: 1, rawM: 0.75 }),
        ],
        targets: [target(), target({ id: "table-top", code: "B2", name: "Table top" })],
        focusedTrialId: trialIdentity(clicked),
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0].valueM).toBeCloseTo(2.35, 6);
    expect(items[0].focused).toBe(true);
    expect(items[0].label).toBe("B1 · 2.350 m · trial 3 of 3");
    expect(items[1].focused).toBe(false);
  });

  it("still draws a clicked trial when the layer is switched off", () => {
    const clicked = trial({ trialIndex: 2, rawM: 2.4 });
    const items = collectRunEvidence(
      query({
        observations: [trial({ trialIndex: 1 }), clicked, trial({ objectId: "table-top" })],
        targets: [target(), target({ id: "table-top", code: "B2", name: "Table top" })],
        showEvidence: false,
        focusedTrialId: trialIdentity(clicked),
      }),
    );

    expect(items.map((item) => item.code)).toEqual(["B1"]);
    expect(items[0].valueM).toBeCloseTo(2.4, 6);
  });

  it("draws nothing when the layer is off and no trial is clicked", () => {
    expect(collectRunEvidence(query({ showEvidence: false }))).toEqual([]);
  });
});
