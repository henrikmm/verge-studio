import { describe, expect, it } from "vitest";
import { describeResult } from "./result-strip";
import type { FloorState } from "./floor-state";

const OK: FloorState = {
  kind: "ok",
  // Only the discriminant is read here; the strip never touches the fit's numbers.
  ground: {} as never,
};
const TARGET = { code: "T1", name: "Doorway", truthM: 2.1 };
const MEASUREMENT = { rawM: 2.045, rulerKind: "extent" as const };

describe("describeResult", () => {
  it("grades a reading against its tape truth", () => {
    const result = describeResult({ floor: OK, measurement: MEASUREMENT, target: TARGET, blind: false });
    expect(result.kind).toBe("graded");
    expect(result.target).toBe("T1 Doorway");
    expect(result.value).toBe("2.045 m");
    expect(result.truth).toBe("2.100 m");
    expect(result.error).toBe("-5.5 cm");
    expect(result.errorPercent).toBe("-2.6%");
  });

  it("signs an overestimate the other way", () => {
    const result = describeResult({
      floor: OK,
      measurement: { rawM: 2.2, rulerKind: "floor_height" },
      target: TARGET,
      blind: false,
    });
    expect(result.error).toBe("+10.0 cm");
    expect(result.errorPercent).toBe("+4.8%");
    expect(result.basis).toBe("ABOVE FLOOR");
  });

  it("never prints a negative zero", () => {
    const result = describeResult({
      floor: OK,
      measurement: { rawM: 2.09999, rulerKind: "extent" },
      target: TARGET,
      blind: false,
    });
    expect(result.error).toBe("0.0 cm");
    expect(result.errorPercent).toBe("0.0%");
  });

  it("measures an untaped target without inventing a grade", () => {
    const result = describeResult({
      floor: OK,
      measurement: MEASUREMENT,
      target: { code: "T2", name: "Table", truthM: null },
      blind: false,
    });
    expect(result.kind).toBe("ungraded");
    expect(result.value).toBe("2.045 m");
    expect(result.truth).toBe("no tape truth");
    expect(result.error).toBe("—");
    expect(result.errorPercent).toBe("—");
  });

  it("leaks nothing while blind, but keeps the tape truth visible", () => {
    const result = describeResult({ floor: OK, measurement: MEASUREMENT, target: TARGET, blind: true });
    expect(result.kind).toBe("blind");
    expect(result.value).toBe("•••");
    expect(result.error).toBe("•••");
    expect(result.errorPercent).toBe("•••");
    expect(result.truth).toBe("2.100 m");
    // The whole readout must not contain the measured number in any field.
    expect(JSON.stringify(result)).not.toContain("2.045");
  });

  it("refuses rather than quoting a height over a failed fit", () => {
    const result = describeResult({
      floor: { kind: "failed", message: "no plane met the support gate" },
      measurement: MEASUREMENT,
      target: TARGET,
      blind: false,
    });
    expect(result.kind).toBe("refused");
    expect(result.value).toBe("—");
    expect(result.note).toContain("no plane met the support gate");
  });

  it("refuses over a stale fit too — held evidence is not a current answer", () => {
    const result = describeResult({
      floor: { kind: "stale" },
      measurement: MEASUREMENT,
      target: TARGET,
      blind: false,
    });
    expect(result.kind).toBe("refused");
    expect(result.value).toBe("—");
    expect(JSON.stringify(result)).not.toContain("2.045");
  });

  it("asks for the missing step when nothing is painted", () => {
    expect(describeResult({ floor: OK, target: TARGET, blind: false }).note).toContain("paint");
    expect(describeResult({ floor: OK, blind: false }).note).toContain("free measurement");
  });

  it("does not quote a non-finite measurement", () => {
    const result = describeResult({
      floor: OK,
      measurement: { rawM: NaN, rulerKind: "extent" },
      target: TARGET,
      blind: false,
    });
    expect(result.kind).toBe("idle");
    expect(result.value).toBe("—");
  });
});
