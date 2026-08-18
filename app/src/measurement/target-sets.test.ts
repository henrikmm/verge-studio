/**
 * Per-clip targets.
 *
 * The failure this guards against is subtle and expensive: a truth measured in one clip being
 * applied to another. Metric scale does not transfer between clips (REGISTRY decision 6),
 * so an inherited 2.100 m door would produce a confident, wrong calibration factor on a scene
 * that has never been tape-measured.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_DOOR_CLIP,
  addTarget,
  activeClipKey,
  activeMeasurementObject,
  measurementObjects,
  removeTarget,
  setActiveClip,
} from "./measurement-store";

beforeEach(() => {
  setActiveClip(BUILTIN_DOOR_CLIP);
});

describe("target sets are per clip", () => {
  it("ships the door set for the built-in clip", () => {
    expect(measurementObjects(BUILTIN_DOOR_CLIP).map((item) => item.code)).toEqual([
      "B1",
      "B2",
      "B3",
      "B4",
      "B5",
    ]);
  });

  it("gives an unknown clip an EMPTY set rather than the door's truths", () => {
    setActiveClip("sha-of-some-other-video");
    expect(activeClipKey()).toBe("sha-of-some-other-video");
    // The whole point: no inherited 2.100 m door.
    expect(measurementObjects()).toEqual([]);
    expect(activeMeasurementObject()).toBeUndefined();
  });

  it("keeps a new clip's targets out of the door set and vice versa", () => {
    setActiveClip("clip-x");
    addTarget({
      id: "gate",
      code: "T1",
      name: "Gate",
      definition: "ground to top rail",
      truthM: 1.8,
      mode: "vertical_extent",
      suggestedFrame: 12,
      maskInstruction: "Paint the gate.",
    });
    expect(measurementObjects("clip-x").map((item) => item.id)).toEqual(["gate"]);
    expect(measurementObjects(BUILTIN_DOOR_CLIP).some((item) => item.id === "gate")).toBe(false);
  });

  it("accepts a target with no truth — measurable but ungradable", () => {
    setActiveClip("clip-y");
    addTarget({
      id: "post",
      code: "T1",
      name: "Post",
      definition: "ground to cap",
      truthM: null,
      mode: "vertical_extent",
      suggestedFrame: 3,
      maskInstruction: "Paint the post.",
    });
    expect(measurementObjects("clip-y")[0].truthM).toBeNull();
  });

  it("refuses to delete a built-in target", () => {
    removeTarget("door-leaf", { runIds: [], clip: BUILTIN_DOOR_CLIP });
    expect(measurementObjects(BUILTIN_DOOR_CLIP).some((item) => item.id === "door-leaf")).toBe(true);
  });

  it("deletes an operator-authored target", () => {
    setActiveClip("clip-z");
    addTarget({
      id: "sign",
      code: "T1",
      name: "Sign",
      definition: "ground to top",
      truthM: 2.4,
      mode: "vertical_extent",
      suggestedFrame: 5,
      maskInstruction: "Paint the sign.",
    });
    removeTarget("sign", { runIds: [], clip: "clip-z" });
    expect(measurementObjects("clip-z")).toEqual([]);
  });
});
