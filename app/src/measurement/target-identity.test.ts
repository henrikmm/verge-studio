/**
 * What a target IS, and what happens to its trials when it stops existing.
 *
 * All three failures below were observed together on `RoomNewFixture` on 2026-08-13. A target was
 * removed and its name typed again; the app asked for trial 4 of an object the operator believed
 * they had just created, because the trials of the old one had never gone anywhere and the name
 * was the key that found them again.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_DOOR_CLIP,
  addObservation,
  addTarget,
  clearObservations,
  ensureTargets,
  exportMeasurementSession,
  measurementObjects,
  newTargetId,
  nextTargetCode,
  removeObservationsForRun,
  removeTarget,
  setActiveClip,
  trialsFor,
  type MeasurementObject,
  type MeasurementObservation,
} from "./measurement-store";

const ROOM = "sha-room";
const ROOM_RUN = "20260811-161356-d387ec";
/** The same clip reconstructed a second time. One target set, two runs. */
const ROOM_RUN_HIRES = "20260811-999999-aaaaaa";
const OTHER_RUN = "door-504px-112f";

const BASE = {
  canonicalFrame: 1,
  npzFrame: 1,
  internalSpreadM: 0.004,
  pointCount: 900,
  confidenceThreshold: 0.5,
  floorRmseM: 0.012,
  floorTiltDeg: 11.8,
  floorBelowFraction: 0.004,
  gravityCoherence: 0.95,
};

function target(id: string, name: string): Omit<MeasurementObject, "builtin"> {
  return {
    id,
    name,
    code: "T1",
    definition: "operator-defined target",
    truthM: 0.44,
    mode: "vertical_extent",
    suggestedFrame: 12,
    maskInstruction: "Paint it.",
  };
}

function record(objectId: string, runId: string, rawM: number): MeasurementObservation {
  return addObservation({ ...BASE, objectId, runId, rawM });
}

beforeEach(() => {
  clearObservations();
  setActiveClip(ROOM);
  for (const item of measurementObjects(ROOM)) removeTarget(item.id, { runIds: [], clip: ROOM });
});

describe("a target's identity is not its name", () => {
  it("mints a different id for the same name twice", () => {
    const first = newTargetId("PC Tower", []);
    const second = newTargetId("PC Tower", [{ ...target(first, "PC Tower"), builtin: false }]);
    expect(second).not.toBe(first);
    // The slug still leads, because it is what a person reads in an export or a file name.
    expect(first.startsWith("pc-tower-")).toBe(true);
    expect(second.startsWith("pc-tower-")).toBe(true);
  });

  it("gives a nameless target an id rather than an empty one", () => {
    expect(newTargetId("···", [])).toMatch(/^target-[a-z0-9]+$/);
  });

  it("never reissues a short code a deleted target used", () => {
    const set = [
      { ...target("a-1111", "Monitor"), code: "T1", builtin: false },
      { ...target("b-2222", "Table"), code: "T2", builtin: false },
    ];
    expect(nextTargetCode(set)).toBe("T3");
    // Remove T1 and the next target must still be T3. Counting rows made it T2, and the scene
    // then drew two different rulers both labelled T2.
    expect(nextTargetCode(set.slice(1))).toBe("T3");
    expect(nextTargetCode([])).toBe("T1");
  });

  it("does not hand a re-typed name the deleted target's trials", () => {
    const first = newTargetId("PC Tower", measurementObjects(ROOM));
    addTarget(target(first, "PC Tower"), ROOM);
    record(first, ROOM_RUN, 0.4476);
    record(first, ROOM_RUN, 0.4491);
    record(first, ROOM_RUN, 0.4328);
    expect(removeTarget(first, { runIds: [ROOM_RUN], clip: ROOM })).toHaveLength(3);

    const second = newTargetId("PC Tower", measurementObjects(ROOM));
    addTarget(target(second, "PC Tower"), ROOM);
    // The bug: this was trial 4 of an object created a second ago.
    expect(record(second, ROOM_RUN, 0.4434).trialIndex).toBe(1);
    expect(trialsFor([], second, ROOM_RUN)).toHaveLength(0);
  });
});

describe("removing a target takes its trials with it", () => {
  it("removes them across every run of the clip, and nothing outside it", () => {
    const id = "pc-tower";
    addTarget(target(id, "PC Tower"), ROOM);
    record(id, ROOM_RUN, 0.4476);
    record(id, ROOM_RUN_HIRES, 0.4482);
    // The door's built-in `pc-tower` is a different physical object under an id minted before
    // `newTargetId`. Removing the room's target must not reach it.
    const foreign = record(id, OTHER_RUN, 0.4267);

    const removed = removeTarget(id, { runIds: [ROOM_RUN, ROOM_RUN_HIRES], clip: ROOM });
    expect(removed.map((item) => item.runId).sort()).toEqual([ROOM_RUN_HIRES, ROOM_RUN].sort());
    expect(trialsFor(stored(), id, OTHER_RUN)).toEqual([foreign]);
  });

  it("refuses to remove a built-in target, and leaves its trials alone", () => {
    setActiveClip(BUILTIN_DOOR_CLIP);
    record("door-leaf", OTHER_RUN, 2.02);
    expect(removeTarget("door-leaf", { runIds: [OTHER_RUN], clip: BUILTIN_DOOR_CLIP })).toEqual([]);
    expect(trialsFor(stored(), "door-leaf", OTHER_RUN)).toHaveLength(1);
  });
});

describe("deleting a run takes its trials with it", () => {
  it("drops that run's rows and keeps every other run's", () => {
    addTarget(target("table-9f2a", "Table"), ROOM);
    record("table-9f2a", ROOM_RUN, 0.7447);
    record("table-9f2a", ROOM_RUN, 0.7457);
    const kept = record("table-9f2a", ROOM_RUN_HIRES, 0.7451);

    expect(removeObservationsForRun(ROOM_RUN)).toHaveLength(2);
    expect(stored()).toEqual([kept]);
  });
});

describe("definitions come back from disk with their trials", () => {
  it("fills in a target the session no longer has", () => {
    const restored = ensureTargets(ROOM, [{ ...target("pc-case-1a2b", "PC Case"), builtin: true }]);
    expect(restored).toHaveLength(1);
    expect(measurementObjects(ROOM).map((item) => item.name)).toEqual(["PC Case"]);
    // Only the door set ships with the app. A recovered definition marked built-in would be
    // undeletable, which is how a recovered mistake becomes permanent.
    expect(measurementObjects(ROOM)[0].builtin).toBe(false);
  });

  it("never overwrites the live definition with the older disk copy", () => {
    addTarget({ ...target("table-9f2a", "Table"), truthM: 0.73 }, ROOM);
    const restored = ensureTargets(ROOM, [{ ...target("table-9f2a", "Table"), truthM: 0.75 }]);
    expect(restored).toEqual([]);
    expect(measurementObjects(ROOM)[0].truthM).toBe(0.73);
  });
});

describe("the exported file describes one clip", () => {
  it("leaves out trials recorded on another clip's run", () => {
    addTarget(target("pc-tower", "PC Tower"), ROOM);
    record("pc-tower", ROOM_RUN, 0.4476);
    // Same object id, different clip: exactly the collision the door and the room had.
    record("pc-tower", OTHER_RUN, 0.4267);

    const exported = JSON.parse(exportMeasurementSession([ROOM_RUN])) as {
      clipKey: string;
      runIds: string[];
      observations: MeasurementObservation[];
      repeatability: Array<{ objectId: string; runId: string; n: number }>;
    };
    expect(exported.clipKey).toBe(ROOM);
    expect(exported.runIds).toEqual([ROOM_RUN]);
    expect(exported.observations.map((item) => item.rawM)).toEqual([0.4476]);
    expect(exported.repeatability.map((row) => row.runId)).toEqual([ROOM_RUN]);
  });
});

/** The store's own rows, read back the way the panes read them. */
function stored(): MeasurementObservation[] {
  return JSON.parse(exportMeasurementSession([ROOM_RUN, ROOM_RUN_HIRES, OTHER_RUN])).observations;
}
