import { beforeEach, describe, expect, it } from "vitest";
import {
  addObservation,
  clearActiveMask,
  clearObservations,
  ensureMask,
  exportMeasurementSession,
  getMask,
  getMeasurementUi,
  paintMask,
  paintMaskStroke,
  setActiveMeasurementObject,
  setMaskData,
  setMeasurementFrame,
} from "./measurement-store";

describe("measurement store", () => {
  beforeEach(() => {
    clearObservations();
    setActiveMeasurementObject("door-leaf");
    setMeasurementFrame(1);
    setMaskData("door-leaf", 1, 24, 20, new Uint8Array(24 * 20));
  });

  it("paints continuous strokes, erases them and clears without mutating older masks", () => {
    const empty = ensureMask(24, 20);
    expect(empty.data.reduce((sum, value) => sum + value, 0)).toBe(0);

    const dot = paintMask(5, 10, 3, false);
    const dotCount = dot.data.reduce((sum, value) => sum + value, 0);
    expect(dotCount).toBeGreaterThan(20);

    const stroke = paintMaskStroke({ x: 5, y: 10 }, { x: 18, y: 10 }, 3, false);
    expect(stroke.data.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(dotCount);
    expect(dot.data).not.toBe(stroke.data);

    const erased = paintMask(11, 10, 2, true);
    expect(erased.data.reduce((sum, value) => sum + value, 0)).toBeLessThan(
      stroke.data.reduce((sum, value) => sum + value, 0),
    );

    clearActiveMask();
    expect(getMask()?.data.every((value) => value === 0)).toBe(true);
  });

  it("replaces one object/frame/run observation instead of averaging incompatible evidence", () => {
    const base = {
      objectId: "door-leaf",
      setting: "356px-256f" as const,
      canonicalFrame: 1,
      npzFrame: 1,
      internalSpreadM: 0.04,
      pointCount: 8000,
      confidenceThreshold: 0.5,
      floorRmseM: 0.02,
      floorTiltDeg: 0.5,
      floorBelowFraction: 0.02,
      gravityCoherence: 0.95,
    };
    addObservation({ ...base, rawM: 1.4 });
    addObservation({ ...base, rawM: 1.41 });
    addObservation({ ...base, setting: "504px-112f", rawM: 1.65 });

    const observations = getMeasurementUi().observations;
    expect(observations).toHaveLength(2);
    expect(observations.find((item) => item.setting === "356px-256f")?.rawM).toBe(1.41);
    expect(observations.find((item) => item.setting === "504px-112f")?.rawM).toBe(1.65);
  });

  it("exports portable RLE masks and the clarified physical measurement definitions", () => {
    const data = new Uint8Array(12);
    data.fill(1, 2, 5);
    data.fill(1, 8, 10);
    setMaskData("door-leaf", 1, 4, 3, data);

    const exported = JSON.parse(exportMeasurementSession()) as {
      schemaVersion: string;
      definitions: Array<{ id: string; mode: string; definition: string }>;
      masks: Record<string, { paintedPixels: number; runs: number[] }>;
    };
    expect(exported.schemaVersion).toBe("verge.measurement-session/0.1.0");
    expect(exported.definitions.find((item) => item.id === "door-leaf")).toMatchObject({
      mode: "vertical_extent",
      definition: "physical leaf, bottom edge to top edge",
    });
    expect(exported.definitions.find((item) => item.id === "table-top")).toMatchObject({
      mode: "vertical_extent",
    });
    expect(exported.masks["door-leaf:1"]).toMatchObject({
      paintedPixels: 5,
      runs: [2, 3, 8, 2],
    });
  });
});
