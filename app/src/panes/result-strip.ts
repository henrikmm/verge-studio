/**
 * The one sentence this app exists to say: *it measures X, the tape says Y, here is how far off.*
 *
 * That sentence used to be the hardest thing in the pane to find. The 3D overlay led with
 * `FLOOR 24.2% SUPPORT · 0.0% BELOW · 22.1° TILT · 1.0 cm RMSE` — four numbers about how the
 * ground plane was fitted, which matter while debugging a fit and at no other time — and the
 * measurement itself was a fragment two lines down. Worse, the whole block floated over the scene
 * at top left, which is exactly where the thing being measured usually is.
 *
 * So the reading now lives in reserved chrome that cannot overlap the canvas, and this module
 * decides what it says. It is a pure function for two reasons: the wording is the part with the
 * honesty rules in it, and wording is not testable through WebGL.
 *
 * ## The rules encoded here
 *
 * - **Blind mode wins over everything.** A repeat trial painted with the previous answer on
 *   screen converges on it, so while blind this strip may not leak a value, an error or a
 *   percentage. Truths stay visible: the operator measured those with their own tape.
 * - **No truth means no grade.** A target nobody has taped is measurable and ungradable, and the
 *   strip says exactly that rather than quoting an error against nothing.
 * - **A refusal is an answer.** No ground, or a held fit whose inputs have moved, is stated here
 *   instead of a number. A stale plane must never read as a current measurement.
 */

import type { FloorState } from "./floor-state";

/** What the strip is currently able to say. Decides the glyph and the emphasis, not the hue. */
export type ResultKind =
  /** A reading with a tape truth behind it — the only state that carries an error. */
  | "graded"
  /** A reading with nothing to grade it against. */
  | "ungraded"
  /** Readings withheld because blind mode is on. */
  | "blind"
  /** The ground fit refused, or is stale, so no reading may be quoted. */
  | "refused"
  /** Nothing painted yet. */
  | "idle";

export interface ResultReadout {
  kind: ResultKind;
  /** `T1 Table`, or an empty string when no target is selected. */
  target: string;
  /** What kind of length this is, in words. */
  basis: string;
  /** The measured value, already formatted, or a placeholder. */
  value: string;
  /** The tape truth, or why there is none. */
  truth: string;
  /** Signed error in centimetres, blank when there is nothing to compare. */
  error: string;
  /** The same error as a share of the truth, signed. */
  errorPercent: string;
  /** One line of explanation for the refused and idle states. */
  note: string;
}

export interface ResultInput {
  floor: FloorState;
  measurement?: { rawM: number; rulerKind: "floor_height" | "extent" };
  target?: { code: string; name: string; truthM: number | null };
  blind: boolean;
}

const VEILED = "•••";
const EMPTY = "—";

export function describeResult({ floor, measurement, target, blind }: ResultInput): ResultReadout {
  const label = target ? `${target.code} ${target.name}` : "";
  // Short, because this row has to hold five things and a `?` at 1280×800 without wrapping, and
  // the basis is the one item whose meaning survives being clipped to two words — it sits
  // immediately beside the value it qualifies.
  const basis = !measurement ? "" : measurement.rulerKind === "extent" ? "EXTENT" : "ABOVE FLOOR";

  const blank: ResultReadout = {
    kind: "idle",
    target: label,
    basis,
    value: EMPTY,
    truth: EMPTY,
    error: EMPTY,
    errorPercent: EMPTY,
    note: "",
  };

  /**
   * The refusals come first, and they come before the measurement test on purpose.
   *
   * A measurement can survive on the wire after the plane under it has gone stale — the two are
   * different nodes and only one of them re-ran. Quoting the height in that window would be the
   * app presenting held evidence as a current answer, which is the exact failure `floor-state.ts`
   * was written to end.
   */
  if (floor.kind === "failed") {
    return { ...blank, kind: "refused", note: `NO GROUND — ${floor.message}` };
  }
  if (floor.kind === "stale") {
    return { ...blank, kind: "refused", note: "GROUND STALE — re-run the graph before reading this" };
  }

  if (!measurement || !Number.isFinite(measurement.rawM)) {
    return {
      ...blank,
      note: target ? "paint this target in Depth 2D to measure it" : "select a target in Objects",
    };
  }

  const truthM = target?.truthM ?? null;

  if (blind) {
    return {
      ...blank,
      kind: "blind",
      value: VEILED,
      truth: truthM === null ? "no tape truth" : `${truthM.toFixed(3)} m`,
      error: VEILED,
      errorPercent: VEILED,
      note: "blind mode — readings hidden so a repeat trial stays independent",
    };
  }

  const value = `${measurement.rawM.toFixed(3)} m`;

  if (truthM === null || !(truthM > 0)) {
    return {
      ...blank,
      kind: "ungraded",
      value,
      truth: "no tape truth",
      note: "measurable, but nothing to grade it against",
    };
  }

  const errorM = measurement.rawM - truthM;
  return {
    kind: "graded",
    target: label,
    basis,
    value,
    truth: `${truthM.toFixed(3)} m`,
    error: `${signed(errorM * 100, 1)} cm`,
    errorPercent: `${signed((errorM / truthM) * 100, 1)}%`,
    note: "",
  };
}

function signed(value: number, digits: number): string {
  // `-0.0 cm` is a real possibility for a reading that lands a fraction under the truth, and it
  // reads as a bug rather than as a very good measurement.
  const fixed = value.toFixed(digits);
  return Number(fixed) > 0 ? `+${fixed}` : Number(fixed) === 0 ? (0).toFixed(digits) : fixed;
}
