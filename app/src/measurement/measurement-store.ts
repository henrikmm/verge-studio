import { useSyncExternalStore } from "react";
import { median, nmad } from "../../../geometry";
import { sha256Hex } from "../graph/cache-key";
import type { FixtureSetting } from "./depth-field";

export type MeasurementMode = "top_above_floor" | "vertical_extent";
export type MaskSource = "brush" | "model" | "model+brush";

export interface SegmentationPromptRecord {
  x: number;
  y: number;
  label: 0 | 1;
}

/** Reproducible evidence for a browser-generated mask. */
export interface SegmentationProvenance {
  attemptId: string;
  modelId: string;
  modelRevision: string;
  runtime: string;
  device: "webgpu";
  prompts: SegmentationPromptRecord[];
  candidateScores: number[];
  selectedCandidate: number;
  score: number;
  scoreMargin: number;
  boundaryFraction: number;
  modelLoadMs: number;
  modelLoadCached?: boolean;
  frameEncodeMs: number;
  frameEncodeCached?: boolean;
  lastDecodeMs: number;
  selectionDurationMs?: number;
  correctionStrokes: number;
  accepted: boolean;
}

export type SegmentationAttemptOutcome = "proposed" | "accepted" | "abstained" | "failed";

/** One automatic-selection attempt, including attempts that never became measurements. */
export interface SegmentationAttempt {
  id: string;
  objectId: string;
  canonicalFrame: number;
  outcome: SegmentationAttemptOutcome;
  reason?: string;
  updatedAt: string;
  modelId: string;
  modelRevision: string;
  promptCount: number;
  positivePrompts: number;
  correctionStrokes: number;
  score?: number;
  scoreMargin?: number;
  modelLoadMs?: number;
  frameEncodeMs?: number;
  lastDecodeMs?: number;
  selectionDurationMs?: number;
}

export interface SegmentationAttemptStats {
  total: number;
  proposed: number;
  accepted: number;
  abstained: number;
  failed: number;
}

export interface MeasurementObject {
  id: string;
  code: string;
  name: string;
  definition: string;
  truthM: number;
  mode: MeasurementMode;
  suggestedFrame: number;
  maskInstruction: string;
  availabilityNote?: string;
  maskOwnerId?: string;
}

export const MEASUREMENT_OBJECTS: readonly MeasurementObject[] = [
  {
    id: "door-leaf",
    code: "B1",
    name: "Door leaf",
    definition: "physical leaf, bottom edge to top edge",
    truthM: 2.1,
    mode: "vertical_extent",
    suggestedFrame: 1,
    maskInstruction: "Paint the door leaf continuously from its bottom edge to its top edge.",
  },
  {
    id: "table-top",
    code: "B2",
    name: "Table top",
    definition: "floor plane to tabletop surface",
    truthM: 0.75,
    mode: "top_above_floor",
    suggestedFrame: 231,
    maskInstruction: "Paint the tabletop edge and a visible floor patch; a connecting stroke is fine.",
  },
  {
    id: "pc-tower",
    code: "B3",
    name: "PC tower",
    definition: "tower base on tabletop to tower top",
    truthM: 0.45,
    mode: "vertical_extent",
    suggestedFrame: 187,
    maskInstruction: "Paint the tower continuously from its tabletop contact to its top.",
  },
  {
    id: "monitor-own",
    code: "B4",
    name: "Monitor + stand",
    definition: "stand contact on tabletop to screen top",
    truthM: 0.534,
    mode: "vertical_extent",
    suggestedFrame: 219,
    maskInstruction: "Paint from the stand/table contact to the top of the screen.",
    availabilityNote: "The laptop occludes the stand/table contact in the recorded clip. Do not grade B4 without another view.",
  },
  {
    id: "monitor-top",
    code: "B5",
    name: "Monitor top",
    definition: "floor plane to screen top; also checked as B2 + B4",
    truthM: 1.284,
    mode: "top_above_floor",
    suggestedFrame: 219,
    maskInstruction: "Paint the screen top and a visible floor patch; a connecting stroke is fine.",
  },
] as const;

export interface MaskRecord {
  width: number;
  height: number;
  data: Uint8Array;
  revision: number;
  source: MaskSource;
  segmentation?: SegmentationProvenance;
}

/**
 * The mask exactly as it stood when a trial was recorded.
 *
 * Trials are frozen evidence, so they cannot point at `state.masks` — the next stroke
 * would mutate the record retroactively. The RLE runs are copied in, and `digest`
 * identifies them so two trials can be told apart (or proven identical) without
 * comparing pixels.
 */
export interface MaskSnapshot {
  width: number;
  height: number;
  revision: number;
  paintedPixels: number;
  digest: string;
  runs: number[];
  source: MaskSource;
  segmentation?: SegmentationProvenance;
}

export interface MeasurementObservation {
  id: string;
  objectId: string;
  setting: FixtureSetting;
  /** 1-based, counted within (objectId, setting). Repeat trials are kept, never replaced. */
  trialIndex: number;
  canonicalFrame: number;
  npzFrame: number;
  rawM: number;
  internalSpreadM: number;
  pointCount: number;
  confidenceThreshold: number;
  floorRmseM: number;
  floorSupportFraction?: number;
  floorTiltDeg: number;
  floorBelowFraction: number;
  gravityCoherence: number;
  capturedAt: string;
  /**
   * Which sitting produced this trial. Constant for one page load.
   *
   * Repeats taken back-to-back bound almost nothing: P0 measured 1–6 mm within a sitting while
   * the same objects moved 21–133 mm between sittings. Only trials with DIFFERENT sitting ids
   * can support a claim about operator repeatability.
   */
  sittingId: string;
  /** Frozen at Record time. Absent on rows migrated from schema 0.1.0, which predate snapshots. */
  mask?: MaskSnapshot;
  /** First stroke after the last clear/record → Record. Absent when the mask was not painted this session. */
  paintDurationMs?: number;
}

/**
 * Operator repeatability across the trials of one (object, setting).
 *
 * This is a different quantity from `MeasurementObservation.internalSpreadM`, which is the
 * roughness of a single patch of points. `rangeM`/`nmadM` here measure how far the *answer*
 * moves when the same operator measures the same object again on the same reconstruction —
 * the term that moved the door between 1.887 m and ~2.0 m with no model change.
 */
export interface TrialStats {
  n: number;
  meanM: number;
  medianM: number;
  minM: number;
  maxM: number;
  /** max − min over ALL trials, whatever sitting they came from. */
  rangeM: number;
  /** Robust dispersion; only meaningful from n≥3, NaN below that. */
  nmadM: number;
  medianPaintMs: number;
  /** How many distinct sittings contributed. One sitting cannot bound the operator. */
  sittingCount: number;
  /** Worst max−min inside a single sitting. NaN when no sitting has two trials. */
  withinSittingRangeM: number;
  /**
   * Range of the per-sitting means — **the only figure here that may be called an operator
   * bound**. NaN below two sittings, because there is nothing to compare.
   */
  betweenSittingRangeM: number;
}

/** Below this, a spread number describes one accident rather than a tendency. */
export const MIN_TRIALS_FOR_SPREAD = 3;

export interface MeasurementUiState {
  /**
   * Hide every reading in the Objects pane.
   *
   * A repeat trial painted while the previous answer is on screen is not independent — the
   * operator converges on it. This is the mechanism that makes a second sitting worth taking.
   */
  blind: boolean;
  activeObjectId: string;
  canonicalFrame: number;
  brushSize: number;
  erasing: boolean;
  overlayOpacity: number;
  confidencePercentile: number;
  zoom: number;
  masks: Record<string, MaskRecord>;
  observations: MeasurementObservation[];
  segmentationAttempts: SegmentationAttempt[];
}

export const SESSION_SCHEMA_VERSION = "verge.measurement-session/0.4.0";
const STORAGE_KEY = "verge.m3c.measurement-session/0.4.0";
/**
 * Older keys, newest first. 0.3.0 added sittings; 0.2.0 added repeat trials and frozen masks;
 * 0.1.0 kept one row per (object, setting, frame) and destroyed repeat trials on record.
 */
const LEGACY_STORAGE_KEYS = [
  "verge.m3b.measurement-session/0.3.0",
  "verge.m3b.measurement-session/0.2.0",
  "verge.m3b.measurement-session/0.1.0",
];

/**
 * Every trial recorded before sittings were tracked came from the single 2026-08-04 study —
 * nine trials, one afternoon, one operator. Tagging them with one shared id is accurate, and it
 * is what makes them count as ONE sitting rather than nine independent ones.
 */
export const LEGACY_SITTING_ID = "legacy-2026-08-04";

/**
 * This page load's sitting. Not persisted: reloading the app IS the separation that makes a
 * second sitting meaningful, so a sitting id that survived a reload would defeat its purpose.
 */
const SITTING_ID = `sitting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function currentSittingId(): string {
  return SITTING_ID;
}

const first = MEASUREMENT_OBJECTS[0];

function encodeMask(mask: MaskRecord): number[] {
  const runs: number[] = [];
  for (let index = 0; index < mask.data.length; ) {
    if (!mask.data[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < mask.data.length && mask.data[index]) index += 1;
    runs.push(start, index - start);
  }
  return runs;
}

interface EncodedMask {
  width: number;
  height: number;
  revision: number;
  runs: number[];
  source?: MaskSource;
  segmentation?: SegmentationProvenance;
}

function decodeMask(value: EncodedMask): MaskRecord {
  const data = new Uint8Array(value.width * value.height);
  for (let i = 0; i + 1 < value.runs.length; i += 2) {
    data.fill(1, value.runs[i], value.runs[i] + value.runs[i + 1]);
  }
  return {
    width: value.width,
    height: value.height,
    revision: value.revision,
    data,
    source: value.source ?? "brush",
    segmentation: value.segmentation,
  };
}

/**
 * Give every restored row a trial index and a stable id.
 *
 * A 0.1.0 row has neither, and it also has no mask snapshot — the mask it was measured from
 * lives under a working key that has almost certainly been repainted since. Those rows are
 * carried forward as trial 1 with `mask` absent, which is the truthful state: the number
 * survives, the evidence behind it does not.
 *
 * A pre-0.3.0 row has no sitting either. It gets `LEGACY_SITTING_ID`, not this page load's id:
 * claiming an old trial for the current sitting would manufacture a between-sitting comparison
 * out of nothing, which is the exact number this schema exists to make trustworthy.
 */
export function migrateObservations(rows: readonly MeasurementObservation[]): MeasurementObservation[] {
  const counters = new Map<string, number>();
  return rows.map((row) => {
    const group = `${row.objectId}:${row.setting}`;
    const trialIndex = (counters.get(group) ?? 0) + 1;
    counters.set(group, trialIndex);
    return {
      ...row,
      trialIndex,
      id: `${group}#${trialIndex}`,
      sittingId: row.sittingId ?? LEGACY_SITTING_ID,
      mask: row.mask
        ? { ...row.mask, source: row.mask.source ?? "brush", segmentation: row.mask.segmentation }
        : undefined,
    };
  });
}

function restoreSession(): Partial<MeasurementUiState> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
    if (!raw) return {};
    const saved = JSON.parse(raw) as {
      blind?: boolean;
      activeObjectId?: string;
      canonicalFrame?: number;
      confidencePercentile?: number;
      masks?: Record<string, EncodedMask>;
      observations?: MeasurementObservation[];
      segmentationAttempts?: SegmentationAttempt[];
    };
    return {
      blind: saved.blind ?? false,
      activeObjectId: saved.activeObjectId,
      canonicalFrame: saved.canonicalFrame,
      confidencePercentile: saved.confidencePercentile,
      masks: Object.fromEntries(
        Object.entries(saved.masks ?? {}).map(([key, mask]) => [key, decodeMask(mask)]),
      ),
      observations: migrateObservations(saved.observations ?? []),
      segmentationAttempts: saved.segmentationAttempts ?? [],
    };
  } catch {
    return {};
  }
}

const restored = restoreSession();
const state: MeasurementUiState = {
  blind: false,
  activeObjectId: first.id,
  canonicalFrame: first.suggestedFrame,
  brushSize: 28,
  erasing: false,
  overlayOpacity: 0.55,
  confidencePercentile: 20,
  zoom: 1,
  masks: {},
  observations: [],
  segmentationAttempts: [],
  ...restored,
};

const listeners = new Set<() => void>();
let snapshot: MeasurementUiState = { ...state };
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Time-to-measure, per working mask.
 *
 * The clock starts on the first stroke after the mask was last cleared or recorded and is
 * read at Record. It lives in the store rather than the pane so no paint call site can forget
 * to start it, and it is deliberately wall-clock: the quantity of interest is operator effort,
 * which includes the seconds spent studying the 3D highlight before committing a stroke.
 *
 * It is not persisted. A clock that survived a reload would report the length of a coffee break.
 */
const paintClocks = new Map<string, number>();

function startPaintClock(key: string): void {
  if (!paintClocks.has(key)) paintClocks.set(key, Date.now());
}

/** Elapsed paint time on the working mask, or undefined before the first stroke. */
export function paintElapsedMs(objectId?: string, frame?: number): number | undefined {
  const startedAt = paintClocks.get(maskKey(objectId, frame));
  return startedAt === undefined ? undefined : Date.now() - startedAt;
}

function persistSession(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const masks = Object.fromEntries(
    Object.entries(state.masks).map(([key, mask]) => [
      key,
      {
        width: mask.width,
        height: mask.height,
        revision: mask.revision,
        source: mask.source,
        segmentation: mask.segmentation,
        runs: encodeMask(mask),
      },
    ]),
  );
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      blind: state.blind,
      activeObjectId: state.activeObjectId,
      canonicalFrame: state.canonicalFrame,
      confidencePercentile: state.confidencePercentile,
      masks,
      observations: state.observations,
      segmentationAttempts: state.segmentationAttempts,
    }),
  );
}

function commit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSession, 350);
}

export function useMeasurementUi(): MeasurementUiState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

export function getMeasurementUi(): MeasurementUiState {
  return state;
}

export function activeMeasurementObject(): MeasurementObject {
  return MEASUREMENT_OBJECTS.find((item) => item.id === state.activeObjectId) ?? first;
}

export function setActiveMeasurementObject(objectId: string): void {
  const object = MEASUREMENT_OBJECTS.find((item) => item.id === objectId);
  if (!object) return;
  state.activeObjectId = object.id;
  state.canonicalFrame = object.suggestedFrame;
  commit();
}

export function setBlind(blind: boolean): void {
  state.blind = blind;
  commit();
}

export function setMeasurementFrame(canonicalFrame: number): void {
  state.canonicalFrame = Math.max(1, Math.round(canonicalFrame));
  commit();
}

export function setBrushSize(size: number): void {
  state.brushSize = Math.max(2, Math.min(120, Math.round(size)));
  commit();
}

export function setErasing(erasing: boolean): void {
  state.erasing = erasing;
  commit();
}

export function setOverlayOpacity(opacity: number): void {
  state.overlayOpacity = Math.max(0.05, Math.min(1, opacity));
  commit();
}

export function setConfidencePercentile(value: number): void {
  state.confidencePercentile = Math.max(0, Math.min(95, value));
  commit();
}

export function setMeasurementZoom(value: number): void {
  state.zoom = Math.max(1, Math.min(4, value));
  commit();
}

function maskKey(objectId = state.activeObjectId, frame = state.canonicalFrame): string {
  const object = MEASUREMENT_OBJECTS.find((item) => item.id === objectId);
  return `${object?.maskOwnerId ?? objectId}:${frame}`;
}

export function getMask(objectId = state.activeObjectId, frame = state.canonicalFrame): MaskRecord | undefined {
  return state.masks[maskKey(objectId, frame)];
}

export function ensureMask(width: number, height: number): MaskRecord {
  const key = maskKey();
  const existing = state.masks[key];
  if (existing && existing.width === width && existing.height === height) return existing;
  const created: MaskRecord = {
    width,
    height,
    data: new Uint8Array(width * height),
    revision: 0,
    source: "brush",
  };
  state.masks = { ...state.masks, [key]: created };
  commit();
  return created;
}

export function paintMask(x: number, y: number, radius: number, erase: boolean): MaskRecord {
  const current = getMask();
  if (!current) throw new Error("mask canvas has not been initialised");
  startPaintClock(maskKey());
  const data = current.data.slice();
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(current.width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(current.height - 1, Math.ceil(y + radius));
  const radiusSq = radius * radius;
  for (let py = top; py <= bottom; py++) {
    for (let px = left; px <= right; px++) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radiusSq) {
        data[py * current.width + px] = erase ? 0 : 1;
      }
    }
  }
  const next: MaskRecord = {
    ...current,
    data,
    revision: current.revision + 1,
    source: current.segmentation ? "model+brush" : "brush",
    segmentation: current.segmentation ? { ...current.segmentation, accepted: false } : undefined,
  };
  state.masks = { ...state.masks, [maskKey()]: next };
  commit();
  return next;
}

export function paintMaskStroke(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  erase: boolean,
): MaskRecord {
  const current = getMask();
  if (!current) throw new Error("mask canvas has not been initialised");
  startPaintClock(maskKey());
  const data = current.data.slice();
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.45)));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const left = Math.max(0, Math.floor(x - radius));
    const right = Math.min(current.width - 1, Math.ceil(x + radius));
    const top = Math.max(0, Math.floor(y - radius));
    const bottom = Math.min(current.height - 1, Math.ceil(y + radius));
    const radiusSq = radius * radius;
    for (let py = top; py <= bottom; py++) {
      for (let px = left; px <= right; px++) {
        if ((px - x) ** 2 + (py - y) ** 2 <= radiusSq) {
          data[py * current.width + px] = erase ? 0 : 1;
        }
      }
    }
  }
  const next: MaskRecord = {
    ...current,
    data,
    revision: current.revision + 1,
    source: current.segmentation ? "model+brush" : "brush",
    segmentation: current.segmentation ? { ...current.segmentation, accepted: false } : undefined,
  };
  state.masks = { ...state.masks, [maskKey()]: next };
  commit();
  return next;
}

export function clearActiveMask(): void {
  const current = getMask();
  if (!current) return;
  paintClocks.delete(maskKey());
  state.masks = {
    ...state.masks,
    [maskKey()]: {
      ...current,
      data: new Uint8Array(current.data.length),
      revision: current.revision + 1,
      source: "brush",
      segmentation: undefined,
    },
  };
  commit();
}

/** Count one pointer-down edit, rather than every interpolated point in the stroke. */
export function beginMaskCorrection(): void {
  const current = getMask();
  if (!current?.segmentation) return;
  startPaintClock(maskKey());
  state.masks = {
    ...state.masks,
    [maskKey()]: {
      ...current,
      source: "model+brush",
      segmentation: {
        ...current.segmentation,
        accepted: false,
        correctionStrokes: current.segmentation.correctionStrokes + 1,
      },
    },
  };
  commit();
}

export interface SetMaskMetadata {
  source?: MaskSource;
  segmentation?: SegmentationProvenance;
}

export function setMaskData(
  objectId: string,
  canonicalFrame: number,
  width: number,
  height: number,
  data: Uint8Array,
  metadata: SetMaskMetadata = {},
): void {
  if (data.length !== width * height) throw new Error("mask dimensions do not match its data");
  const key = maskKey(objectId, canonicalFrame);
  // A mask set programmatically is not operator paint time. Any correction strokes that
  // follow start a fresh clock, which is exactly what M3c needs to measure.
  paintClocks.delete(key);
  const revision = (state.masks[key]?.revision ?? 0) + 1;
  state.masks = {
    ...state.masks,
    [key]: {
      width,
      height,
      data: data.slice(),
      revision,
      source: metadata.source ?? "brush",
      segmentation: metadata.segmentation,
    },
  };
  commit();
}

export const MIN_MODEL_MASK_SCORE = 0.7;
export const MIN_MODEL_MASK_MARGIN = 0.015;
export const MAX_MODEL_BOUNDARY_FRACTION = 0.04;

/** A cheap 2D review gate. The 3D endpoint-support gate runs after backprojection. */
export function automaticMaskReviewIssue(mask: MaskRecord | undefined): string | undefined {
  const evidence = mask?.segmentation;
  if (!evidence) return undefined;
  if (!evidence.prompts.some((prompt) => prompt.label === 1)) return "Add a positive click on the object.";
  // A brush-corrected proposal is being accepted on the operator's review, not on the
  // model's score. The original score stays in provenance; it must not impersonate a
  // calibrated score for pixels the operator has since changed.
  if (mask?.source === "model+brush") return undefined;
  if (evidence.score < MIN_MODEL_MASK_SCORE) {
    return `Low mask confidence (${evidence.score.toFixed(2)}). Add positive/negative clicks or use the brush.`;
  }
  if (evidence.scoreMargin < MIN_MODEL_MASK_MARGIN) {
    return "The model has two nearly equal masks. Add another click to disambiguate them.";
  }
  if (evidence.boundaryFraction > MAX_MODEL_BOUNDARY_FRACTION) {
    return "The mask reaches too much of the image boundary. Exclude the background with negative clicks.";
  }
  return undefined;
}

/** Accept a reviewed model mask; height remains withheld until this explicit action. */
export function acceptActiveModelMask(selectionDurationMs: number): MaskRecord {
  const key = maskKey();
  const current = state.masks[key];
  if (!current?.segmentation) throw new Error("There is no automatic mask to accept.");
  const issue = automaticMaskReviewIssue(current);
  if (issue) throw new Error(issue);
  const next: MaskRecord = {
    ...current,
    revision: current.revision + 1,
    segmentation: {
      ...current.segmentation,
      accepted: true,
      selectionDurationMs: Math.max(0, selectionDurationMs),
    },
  };
  state.masks = { ...state.masks, [key]: next };
  commit();
  return next;
}

export function recordSegmentationAttempt(
  attempt: Omit<SegmentationAttempt, "updatedAt">,
): SegmentationAttempt {
  const record: SegmentationAttempt = { ...attempt, updatedAt: new Date().toISOString() };
  const existing = state.segmentationAttempts.findIndex((item) => item.id === record.id);
  state.segmentationAttempts = existing < 0
    ? [...state.segmentationAttempts, record]
    : state.segmentationAttempts.map((item, index) => (index === existing ? record : item));
  commit();
  return record;
}

export function segmentationAttemptStats(
  attempts: readonly SegmentationAttempt[] = state.segmentationAttempts,
): SegmentationAttemptStats {
  return attempts.reduce<SegmentationAttemptStats>(
    (stats, attempt) => ({ ...stats, [attempt.outcome]: stats[attempt.outcome] + 1, total: stats.total + 1 }),
    { total: 0, proposed: 0, accepted: 0, abstained: 0, failed: 0 },
  );
}

function snapshotMask(objectId: string, canonicalFrame: number): MaskSnapshot | undefined {
  const mask = getMask(objectId, canonicalFrame);
  if (!mask) return undefined;
  const runs = encodeMask(mask);
  return {
    width: mask.width,
    height: mask.height,
    revision: mask.revision,
    paintedPixels: mask.data.reduce((sum, value) => sum + value, 0),
    // Over the RLE rather than the raw bytes: same information, and it stays comparable
    // with the exported JSON, which is what a later run would be diffed against.
    digest: sha256Hex(`${mask.width}x${mask.height}:${runs.join(",")}`).slice(0, 16),
    runs,
    source: mask.source,
    segmentation: mask.segmentation ? { ...mask.segmentation, prompts: [...mask.segmentation.prompts] } : undefined,
  };
}

/**
 * Record one trial. Trials accumulate; recording again never replaces an earlier row.
 *
 * Until 2026-08-04 this filtered out any prior row for the same (object, setting, frame)
 * before appending, so a second measurement silently destroyed the first. That made repeat
 * measurement impossible to study and left every frozen number in `MEASUREMENTS.md` a single
 * unrepeated sample. Operator endpoint placement is a large part of this project's error
 * budget, so the spread across trials is evidence, not clutter.
 */
export function addObservation(
  observation: Omit<
    MeasurementObservation,
    "id" | "capturedAt" | "trialIndex" | "mask" | "paintDurationMs" | "sittingId"
  >,
): MeasurementObservation {
  const group = `${observation.objectId}:${observation.setting}`;
  const trialIndex =
    state.observations.filter(
      (item) => item.objectId === observation.objectId && item.setting === observation.setting,
    ).length + 1;
  const key = maskKey(observation.objectId, observation.canonicalFrame);
  const startedAt = paintClocks.get(key);
  const record: MeasurementObservation = {
    ...observation,
    id: `${group}#${trialIndex}`,
    trialIndex,
    sittingId: SITTING_ID,
    capturedAt: new Date().toISOString(),
    mask: snapshotMask(observation.objectId, observation.canonicalFrame),
    paintDurationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
  };
  paintClocks.delete(key);
  state.observations = [...state.observations, record];
  commit();
  return record;
}

/** Drop one trial by id — a misclick or an abandoned attempt, not a whole study. */
export function removeObservation(id: string): void {
  state.observations = state.observations.filter((item) => item.id !== id);
  commit();
}

export function clearObservations(): void {
  state.observations = [];
  state.segmentationAttempts = [];
  paintClocks.clear();
  commit();
}

export function trialsFor(
  observations: readonly MeasurementObservation[],
  objectId: string,
  setting?: FixtureSetting,
): MeasurementObservation[] {
  return observations
    .filter((item) => item.objectId === objectId && (!setting || item.setting === setting))
    .sort((a, b) => a.trialIndex - b.trialIndex);
}

/**
 * Trials whose mask is byte-identical to an earlier trial in the same group.
 *
 * Pressing Record twice without repainting yields two rows, zero spread, and the appearance
 * of perfect repeatability — when it is one measurement counted twice. An independent trial
 * means clearing the mask and placing the endpoints again. These ids are surfaced rather than
 * dropped, because the operator may have meant to record a deliberate control.
 */
export function duplicateMaskTrialIds(
  observations: readonly MeasurementObservation[],
  objectId: string,
  setting?: FixtureSetting,
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const trial of trialsFor(observations, objectId, setting)) {
    const digest = trial.mask?.digest;
    if (!digest) continue;
    if (seen.has(digest)) duplicates.add(trial.id);
    else seen.add(digest);
  }
  return duplicates;
}

const EMPTY_STATS: TrialStats = {
  n: 0,
  meanM: NaN,
  medianM: NaN,
  minM: NaN,
  maxM: NaN,
  rangeM: NaN,
  nmadM: NaN,
  medianPaintMs: NaN,
  sittingCount: 0,
  withinSittingRangeM: NaN,
  betweenSittingRangeM: NaN,
};

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function trialStats(
  observations: readonly MeasurementObservation[],
  objectId: string,
  setting?: FixtureSetting,
): TrialStats {
  const rows = trialsFor(observations, objectId, setting).filter((item) =>
    Number.isFinite(item.rawM),
  );
  if (!rows.length) return EMPTY_STATS;
  const values = rows.map((item) => item.rawM);
  const durations = rows
    .map((item) => item.paintDurationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  // Split by sitting. Back-to-back repeats and repeats a week apart are different evidence:
  // P0 measured 1–6 mm within a sitting and 21–133 mm between, so pooling them would report
  // the smaller number and call it the operator bound.
  const bySitting = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.sittingId ?? LEGACY_SITTING_ID;
    bySitting.set(key, [...(bySitting.get(key) ?? []), row.rawM]);
  }
  const repeatedSittings = [...bySitting.values()].filter((group) => group.length >= 2);
  const sittingMeans = [...bySitting.values()].map(mean);

  return {
    n: values.length,
    meanM: mean(values),
    medianM: median(values),
    minM: Math.min(...values),
    maxM: Math.max(...values),
    rangeM: Math.max(...values) - Math.min(...values),
    // NMAD of two points is just their half-separation dressed up as robust statistics.
    nmadM: values.length >= MIN_TRIALS_FOR_SPREAD ? nmad(values) : NaN,
    medianPaintMs: durations.length ? median(durations) : NaN,
    sittingCount: bySitting.size,
    withinSittingRangeM: repeatedSittings.length
      ? Math.max(...repeatedSittings.map((group) => Math.max(...group) - Math.min(...group)))
      : NaN,
    betweenSittingRangeM:
      bySitting.size >= 2 ? Math.max(...sittingMeans) - Math.min(...sittingMeans) : NaN,
  };
}

export function exportMeasurementSession(): string {
  const workingMasks = Object.fromEntries(
    Object.entries(state.masks).map(([key, mask]) => [
      key,
      {
        width: mask.width,
        height: mask.height,
        revision: mask.revision,
        source: mask.source,
        segmentation: mask.segmentation,
        paintedPixels: mask.data.reduce((a, b) => a + b, 0),
        runs: encodeMask(mask),
      },
    ]),
  );
  const settings = [...new Set(state.observations.map((item) => item.setting))];
  const repeatability = MEASUREMENT_OBJECTS.flatMap((object) =>
    settings
      .map((setting) => ({ objectId: object.id, code: object.code, setting, ...trialStats(state.observations, object.id, setting) }))
      .filter((row) => row.n > 0),
  );
  return JSON.stringify(
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBySitting: SITTING_ID,
      // Which sittings the trials came from, so a reader can tell a repeatability claim from
      // three measurements taken in the same five minutes.
      sittings: [...new Set(state.observations.map((item) => item.sittingId ?? LEGACY_SITTING_ID))],
      definitions: MEASUREMENT_OBJECTS,
      // Every trial, each carrying the mask it was measured from. This is the evidence.
      observations: state.observations,
      segmentationAttempts: state.segmentationAttempts,
      repeatability,
      // The live selection state, kept for convenience. It is NOT evidence: it moves as you edit.
      workingMasks,
    },
    null,
    2,
  );
}
