import { useSyncExternalStore } from "react";
import { median, nmad, type Vec3 } from "../../../geometry";
import { sha256Hex } from "../graph/cache-key";
import type { RunId } from "../lib/runs";

export type MeasurementMode = "top_above_floor" | "vertical_extent";
export type MeasurementContext = "free" | "object";
export type MaskSource = "brush" | "model" | "model+brush";

export const FREE_MEASUREMENT_ID = "__free__";
export const FREE_MEASUREMENT: MeasurementObject = {
  id: FREE_MEASUREMENT_ID,
  code: "FREE",
  name: "Ad hoc",
  definition: "temporary measurement that is not recorded",
  truthM: null,
  mode: "vertical_extent",
  suggestedFrame: 1,
  maskInstruction: "Paint any two endpoints or a continuous subject. This mask stays temporary.",
  builtin: true,
};

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
  /**
   * Tape truth, or null when there is none.
   *
   * Nullable since 2026-08-04. Targets used to be a hardcoded list of five door-clip objects
   * whose truths were all known, so "measure something without a reference" was unrepresentable
   * — which meant a new clip inherited the door's 2.100 m and graded against it. A target with
   * no truth is measurable but ungradable, and every aggregate below has to say so rather than
   * quietly treating null as zero.
   */
  truthM: number | null;
  mode: MeasurementMode;
  suggestedFrame: number;
  maskInstruction: string;
  availabilityNote?: string;
  maskOwnerId?: string;
  /** Built-in targets ship with the app and cannot be edited or deleted. */
  builtin?: boolean;
}

/**
 * Targets belong to a CLIP, not to the app.
 *
 * Metric scale does not transfer between clips (REGISTRY decision 6), so a truth
 * measured in one video is meaningless in another. Sets are keyed by the source clip's content
 * digest; `BUILTIN_DOOR_CLIP` is the key the built-in run records carry.
 */
export const BUILTIN_DOOR_CLIP = "builtin-door";

export const DOOR_TARGETS: readonly MeasurementObject[] = [
  {
    id: "door-leaf",
    code: "B1",
    name: "Door leaf",
    definition: "physical leaf, bottom edge to top edge",
    truthM: 2.1,
    mode: "vertical_extent",
    suggestedFrame: 1,
    maskInstruction: "Paint the door leaf continuously from its bottom edge to its top edge.",
    builtin: true,
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
    builtin: true,
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
    builtin: true,
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
    builtin: true,
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
    builtin: true,
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
  runId: RunId;
  /** 1-based, counted within (objectId, runId). Repeat trials are kept, never replaced. */
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
  /**
   * The two endpoints the reading was taken between, in the cloud's world frame — the 3D
   * evidence for `rawM`, frozen at Record beside the mask.
   *
   * Absent on every trial recorded before 2026-08-12, and it cannot be recovered for them.
   * Replaying a stored mask reproduces the ruler exactly (`inspect measurement`, 0.000 mm on the
   * door packet), but only against the plane the trial actually used, and that plane was first
   * written to disk on 2026-08-11. Of the 60 packets in `~/verge-runs`, 9 carry a plane and all
   * 9 already carry a ruler; the other 51 would have to be replayed against a re-fitted floor,
   * which is a different measurement wearing this trial's number.
   */
  ruler?: { bottom: Vec3; top: Vec3 };
  /** Which definition the ruler draws: floor-to-top, or the subject's own extent. */
  rulerKind?: "floor_height" | "extent";
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
  /** Free is the startup context. Only an explicit target click enters object evidence. */
  measurementContext: MeasurementContext;
  /**
   * Draw the recorded evidence for this run in the 3D viewport — today the frozen rulers of
   * every measured object, later whatever else a recording keeps.
   *
   * On by default, unlike the floor layers, and for the opposite reason. A fitted floor is a
   * claim ABOUT the scene, so you turn it on to ask a question. Recorded evidence is the answer
   * to a question already asked and already recorded: hiding it by default means the first
   * person to open a run sees numbers with nothing in the scene backing them.
   *
   * Not persisted. Its value IS the default, so there is nothing for a reload to restore.
   */
  showEvidence: boolean;
  /**
   * One recorded trial singled out, by `trialIdentity` — the row the operator clicked.
   *
   * Held here rather than in the Objects pane because the viewport is what draws it, and the
   * two panes have no other way to talk. Not persisted: a highlight is about the last click,
   * not about the session.
   */
  focusedTrialId: string | null;
  /** The operator may choose either existing measurement definition for an ad-hoc check. */
  freeMeasurementMode: MeasurementMode;
  activeObjectId: string;
  /** Clip whose target set is active. */
  clipKey: string;
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

export const SESSION_SCHEMA_VERSION = "verge.measurement-session/0.6.0";
const STORAGE_KEY = "verge.m3c.measurement-session/0.6.0";
/**
 * Older keys, newest first. 0.5.0 keyed masks `subject:frame`, so two clips shared one; 0.4.0
 * keyed trials by a three-value fixture `setting`; 0.3.0 added sittings; 0.2.0 added repeat
 * trials and frozen masks; 0.1.0 kept one row per (object, setting, frame) and destroyed repeat
 * trials on record.
 */
const LEGACY_STORAGE_KEYS = [
  "verge.m3c.measurement-session/0.5.0",
  "verge.m3c.measurement-session/0.4.0",
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

/**
 * Target sets, one per source clip.
 *
 * The built-in door set is seeded and cannot be edited; every other clip starts empty and is
 * filled in by the operator. Keeping them separate is not tidiness — a truth from another clip
 * applied here would silently produce a calibration factor that means nothing.
 */
const targetSets: Record<string, MeasurementObject[]> = {
  [BUILTIN_DOOR_CLIP]: DOOR_TARGETS.map((target) => ({ ...target })),
};

/**
 * Which clip's targets the panes are showing. Mirrored into `state.clipKey` so it is part of
 * the observable snapshot — a pane must re-render when the active run changes clip.
 */
let activeClip = BUILTIN_DOOR_CLIP;

export function measurementObjects(clip = activeClip): readonly MeasurementObject[] {
  return targetSets[clip] ?? [];
}

export function measurementObjectForClip(clip: string, objectId: string): MeasurementObject | undefined {
  return measurementObjects(clip).find((item) => item.id === objectId);
}

/** Kept for the built-in door set, which several tests and the resolution table refer to. */
export const MEASUREMENT_OBJECTS = DOOR_TARGETS;

export function activeClipKey(): string {
  return activeClip;
}

/**
 * Point the panes at a clip's targets. Creates an empty set for an unknown clip rather than
 * falling back to the door's — inheriting another clip's truths is the failure this exists to
 * prevent.
 */
export function setActiveClip(clip: string): void {
  const key = clip || BUILTIN_DOOR_CLIP;
  if (activeClip === key) return;
  activeClip = key;
  state.clipKey = key;
  state.measurementContext = "free";
  if (!targetSets[key]) targetSets[key] = [];
  const targets = targetSets[key];
  if (!targets.some((item) => item.id === state.activeObjectId)) {
    state.activeObjectId = targets[0]?.id ?? "";
    if (targets[0]) state.canonicalFrame = targets[0].suggestedFrame;
  }
  commit();
}

export function addTarget(target: Omit<MeasurementObject, "builtin">, clip = activeClip): void {
  const targets = targetSets[clip] ?? (targetSets[clip] = []);
  if (targets.some((item) => item.id === target.id)) return;
  targets.push({ ...target });
  state.activeObjectId = target.id;
  state.canonicalFrame = target.suggestedFrame;
  commit();
}

/**
 * An id for a new target, which its NAME does not determine.
 *
 * Ids were the slugified name, and that made a name into an identity. Two consequences, both
 * measured on 2026-08-13: removing "PC Tower" from `RoomNewFixture` and typing the name again
 * regenerated `pc-tower`, so three trials nobody could see re-attached to the new target and the
 * next recording was numbered 4; and the door's built-in `pc-tower` (truth 0.45 m) shared its id
 * with the room's (truth 0.44 m), two different physical objects under one key.
 *
 * The slug stays in front because it is what a person reads in an export or a file name. The four
 * random characters after it are the identity. A re-typed name is therefore a NEW object, which is
 * the honest reading: the trials of the deleted one were painted on a target that no longer exists.
 */
export function newTargetId(name: string, existing: readonly MeasurementObject[]): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stem = slug || "target";
  // Bounded, not `for(;;)`. A collision needs the same four characters out of ~1.7 million, so
  // the retry is already the unreachable branch — but an unbounded loop whose exit depends on a
  // generator staying random is a hang waiting for the one edit that makes it constant. It hung
  // this file's own test suite on 2026-08-13.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `${stem}-${Math.random().toString(36).slice(2, 6)}`;
    if (!existing.some((item) => item.id === id)) return id;
  }
  return `${stem}-${Date.now().toString(36)}`;
}

/**
 * The next free short code for a clip's targets.
 *
 * The code is the label a person actually reads — on the ruler drawn in the 3D scene, in the
 * Objects list, in the trial table. It was `T${existing.length + 1}`, which is a position rather
 * than a name: on 2026-08-13 the room clip held `T2 = Monitor` and `T2 = PC Tower` at once,
 * because removing an earlier target freed the number for the next one to take, and two rulers in
 * one scene were both labelled T2.
 *
 * Taking the highest code ever issued rather than counting rows means a deletion leaves a gap in
 * the sequence. That is the same choice `addObservation` makes about trial numbers, for the same
 * reason: a gap is the honest record of something removed, and reusing the number quietly makes
 * one label mean two things.
 */
export function nextTargetCode(existing: readonly MeasurementObject[]): string {
  const highest = existing.reduce((best, item) => {
    const match = /^T(\d+)$/.exec(item.code ?? "");
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `T${highest + 1}`;
}

/**
 * Take in target definitions recovered from disk evidence, without disturbing the live ones.
 *
 * A definition lived only in `localStorage`, while the trials recorded against it lived on disk as
 * well. Clearing the browser's storage therefore produced a clip with recorded trials and no rows
 * to show them in — the state that looked like lost work on `RoomNewFixture`, where 16 packets sat
 * on disk under five target names the app could no longer name.
 *
 * A definition already here WINS. The disk copy was serialised when the trial was recorded, so it
 * is the older one, and a truth corrected since must not be undone by reading an old packet.
 */
export function ensureTargets(clip: string, targets: readonly MeasurementObject[]): MeasurementObject[] {
  const set = targetSets[clip] ?? (targetSets[clip] = []);
  const added: MeasurementObject[] = [];
  for (const target of targets) {
    if (!target?.id || set.some((item) => item.id === target.id)) continue;
    // Only the door set ships with the app. A recovered definition is operator-authored by
    // construction, and marking it built-in would make it undeletable.
    const restored = { ...target, builtin: clip === BUILTIN_DOOR_CLIP ? target.builtin : false };
    set.push(restored);
    added.push(restored);
  }
  if (added.length) commit();
  return added;
}

/**
 * Remove a target and every trial recorded against it, on the runs named.
 *
 * Removing the definition alone was the whole of this operation until 2026-08-13, and it left the
 * trials in the store with nothing to display them: invisible, still counted by the export, and
 * ready to re-attach to any later target that happened to slugify to the same id.
 *
 * `runIds` is the caller's list of runs belonging to this clip — the store does not know about
 * runs. It is required rather than defaulted so that a caller which has not thought about scope
 * cannot silently take another clip's trials with it, which is a live risk for the ids minted
 * before `newTargetId`: the door and the room both hold a `pc-tower`.
 */
export function removeTarget(
  id: string,
  { runIds, clip = activeClip }: { runIds: readonly RunId[]; clip?: string },
): MeasurementObservation[] {
  const targets = targetSets[clip];
  if (!targets) return [];
  const target = targets.find((item) => item.id === id);
  if (!target || target.builtin) return [];
  targetSets[clip] = targets.filter((item) => item.id !== id);

  const scope = new Set(runIds);
  const removed = state.observations.filter((item) => item.objectId === id && scope.has(item.runId));
  const dropped = new Set(removed.map(trialIdentity));
  state.observations = state.observations.filter((item) => !dropped.has(trialIdentity(item)));
  if (state.focusedTrialId && dropped.has(state.focusedTrialId)) state.focusedTrialId = null;

  if (state.activeObjectId === id) {
    state.activeObjectId = "";
    state.measurementContext = "free";
  }
  commit();
  return removed;
}

/**
 * Drop every trial belonging to a deleted run.
 *
 * A run's rows outlived the run itself: nothing removed them, no run remained to select them
 * under, and `exportMeasurementSession` still counted them. Their disk packets are archived by the
 * delete, so this is the session catching up with what happened on disk, not a second deletion.
 */
export function removeObservationsForRun(runId: RunId): MeasurementObservation[] {
  const removed = state.observations.filter((item) => item.runId === runId);
  if (!removed.length) return [];
  const dropped = new Set(removed.map(trialIdentity));
  state.observations = state.observations.filter((item) => !dropped.has(trialIdentity(item)));
  if (state.focusedTrialId && dropped.has(state.focusedTrialId)) state.focusedTrialId = null;
  commit();
  return removed;
}

const first = DOOR_TARGETS[0];

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
 *
 * A row that already has an id KEEPS it. Renumbering by position rewrote history: delete trial 2
 * of 3 and reload, and the old trial 3 came back as trial 2 under a new id. Its evidence file on
 * disk is named after the id it was written with, so the renamed row no longer matched it — the
 * pane saw an unknown trial and wrote a second copy, leaving the first orphaned. A gap in the
 * numbering is the honest record of a deletion.
 */
export function migrateObservations(rows: readonly MeasurementObservation[]): MeasurementObservation[] {
  const counters = new Map<string, number>();
  return dedupeTrials(rows.map((raw) => {
    // 0.5.0 re-keyed trials from a three-value fixture `setting` to a run id, so a saved run
    // can hold measurements at all. The three old settings ARE the built-in door runs, so the
    // mapping is exact and no trial loses its group.
    const legacySetting = (raw as { setting?: string }).setting;
    const row: MeasurementObservation =
      raw.runId === undefined && legacySetting !== undefined
        ? { ...raw, runId: `door-${legacySetting}` }
        : raw;
    const group = `${row.objectId}:${row.runId}`;
    const nextIndex = (counters.get(group) ?? 0) + 1;
    const trialIndex = row.trialIndex ?? nextIndex;
    counters.set(group, Math.max(nextIndex, trialIndex));
    // A trial id carries its number after a `#`. A 0.1.0 id is a different shape and is not
    // even unique — two trials of one object shared it — so those are reissued.
    const keepsId = typeof row.id === "string" && row.id.includes("#");
    return {
      ...row,
      trialIndex,
      id: keepsId ? row.id : `${group}#${trialIndex}`,
      sittingId: row.sittingId ?? LEGACY_SITTING_ID,
      mask: row.mask
        ? { ...row.mask, source: row.mask.source ?? "brush", segmentation: row.mask.segmentation }
        : undefined,
    };
  }));
}

/**
 * Collapse rows that are one recording stored twice.
 *
 * The evidence directory holds a trial once per evidence schema it has been written under —
 * the door archive is 33 packets for 17 trials, each early one written again when the packet
 * format changed its file naming. Same id, same instant, same mask digest.
 *
 * A row with no `capturedAt` is never collapsed. Those are 0.1.0 rows, which share ids with each
 * other and carry no instant, so nothing here can prove two of them are the same measurement —
 * and dropping a real trial is far worse than showing one twice.
 */
function dedupeTrials(rows: readonly MeasurementObservation[]): MeasurementObservation[] {
  const seen = new Set<string>();
  const kept: MeasurementObservation[] = [];
  for (const row of rows) {
    if (!row.capturedAt) {
      kept.push(row);
      continue;
    }
    const identity = trialIdentity(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(row);
  }
  return kept;
}

/**
 * Give a stored mask key its clip, so 0.5.0 sessions survive the re-keying.
 *
 * A 0.5.0 key is `subject:frame` and does not say which clip it was painted on. The subject
 * usually does: a target id belongs to exactly one clip's set unless two clips happened to
 * choose the same name. Where the lookup is ambiguous or finds nothing, the session's own
 * active clip is the best available answer. A working mask is not evidence — recorded trials
 * carry their own frozen copy — so guessing here cannot corrupt a measurement.
 */
export function migrateMaskKeys<T>(
  masks: Record<string, T>,
  savedActiveClip: string,
  sets: Record<string, readonly MeasurementObject[]> = targetSets,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(masks).map(([key, mask]) => {
      if (key.includes("/")) return [key, mask];
      const subject = key.slice(0, key.lastIndexOf(":"));
      const owners = Object.entries(sets)
        .filter(([, targets]) => targets.some((target) => (target.maskOwnerId ?? target.id) === subject))
        .map(([clip]) => clip);
      return [`${owners.length === 1 ? owners[0] : savedActiveClip}/${key}`, mask];
    }),
  );
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
      activeClip?: string;
      targetSets?: Record<string, MeasurementObject[]>;
      canonicalFrame?: number;
      confidencePercentile?: number;
      masks?: Record<string, EncodedMask>;
      observations?: MeasurementObservation[];
      segmentationAttempts?: SegmentationAttempt[];
    };
    // Restore operator-authored sets, but never let a stored copy shadow the built-in door
    // definitions — those are code, and an old copy would silently freeze a stale truth.
    for (const [clip, targets] of Object.entries(saved.targetSets ?? {})) {
      if (clip === BUILTIN_DOOR_CLIP) continue;
      targetSets[clip] = targets.map((target) => ({ ...target, builtin: false }));
    }
    if (saved.activeClip && targetSets[saved.activeClip]) activeClip = saved.activeClip;

    return {
      blind: saved.blind ?? false,
      activeObjectId: saved.activeObjectId,
      canonicalFrame: saved.canonicalFrame,
      confidencePercentile: saved.confidencePercentile,
      masks: Object.fromEntries(
        Object.entries(migrateMaskKeys(saved.masks ?? {}, saved.activeClip ?? activeClip))
          .filter(([key]) => !isFreeMaskKey(key))
          .map(([key, mask]) => [key, decodeMask(mask)]),
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
  measurementContext: "free",
  showEvidence: true,
  focusedTrialId: null,
  freeMeasurementMode: "vertical_extent",
  activeObjectId: first.id,
  clipKey: activeClip,
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

/** Set when the last save failed, so a pane can say the work is not being kept. */
let persistError: string | undefined;

export function sessionPersistError(): string | undefined {
  return persistError;
}

function persistSession(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const masks = Object.fromEntries(
    Object.entries(state.masks).filter(([key]) => !isFreeMaskKey(key)).map(([key, mask]) => [
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
  const payload = JSON.stringify({
    blind: state.blind,
    activeObjectId: state.activeObjectId,
    activeClip,
    canonicalFrame: state.canonicalFrame,
    confidencePercentile: state.confidencePercentile,
    masks,
    observations: state.observations,
    segmentationAttempts: state.segmentationAttempts,
    // Operator-authored targets are evidence definitions, not preferences: losing them
    // orphans every trial recorded against them.
    targetSets,
  });
  try {
    window.localStorage.setItem(STORAGE_KEY, payload);
    persistError = undefined;
  } catch (reason) {
    // A quota failure threw out of the debounce timer, where nothing catches it: the session
    // stopped being saved and said so nowhere. Every trial carries its mask as run-length
    // pairs, so the payload grows with the work, and this is the state most worth reporting.
    persistError = `Session not saved (${Math.round(payload.length / 1024)} KB): ${
      reason instanceof Error ? reason.message : String(reason)
    }`;
    for (const listener of listeners) listener();
  }
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

/**
 * The active target, resolved within the ACTIVE CLIP's set.
 *
 * Returns undefined when a clip has no targets yet — a real state now that a new video starts
 * with an empty set, and one the panes must render as "add a target" rather than silently
 * falling back to the door's B1.
 */
export function activeMeasurementObject(): MeasurementObject | undefined {
  if (state.measurementContext !== "object") return undefined;
  const targets = measurementObjects();
  return targets.find((item) => item.id === state.activeObjectId);
}

/** The graph always has a subject. Free uses a temporary pseudo-target with no truth. */
export function activeMeasurementSubject(): MeasurementObject {
  const object = activeMeasurementObject();
  return object ?? { ...FREE_MEASUREMENT, mode: state.freeMeasurementMode };
}

export function setFreeMeasurement(): void {
  state.measurementContext = "free";
  // Free is an ad-hoc check against nothing recorded, so there is no trial to be looking at.
  // Leaving a stale focus here would put one run's ruler over an unrelated painting session.
  state.focusedTrialId = null;
  commit();
}

/** Draw the run's recorded evidence, or stop drawing it. */
export function setShowEvidence(showEvidence: boolean): void {
  state.showEvidence = showEvidence;
  commit();
}

/**
 * Single out one recorded trial, by `trialIdentity`, or clear the highlight with `null`.
 *
 * Focusing a trial does not hide the others: the point of the highlight is to say which of the
 * rulers on screen produced the number being read, and that is only answerable in company.
 */
export function setFocusedTrial(identity: string | null): void {
  state.focusedTrialId = identity;
  commit();
}

export function setFreeMeasurementMode(mode: MeasurementMode): void {
  state.freeMeasurementMode = mode;
  commit();
}

export function setActiveMeasurementObject(objectId: string): void {
  const object = measurementObjects().find((item) => item.id === objectId);
  if (!object) return;
  state.measurementContext = "object";
  state.activeObjectId = object.id;
  state.canonicalFrame = object.suggestedFrame;
  // The highlight belongs to a trial of the object being left behind.
  state.focusedTrialId = null;
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

/**
 * Which clip a mask belongs to, in the key itself.
 *
 * Keys were `subject:frame` with no clip in them, so two clips sharing a subject id shared one
 * mask. Ad hoc collided always — its id is the constant `__free__` — and named targets collided
 * whenever two clips held a target with the same name, because `AddTargetForm` slugifies the name
 * and only de-duplicates within one clip's set. Measured 2026-08-11: 18,507 px painted on
 * `RoomNewFixture.mp4` stayed selected after switching to the door run and reported 0.759 m
 * against the door's cloud — one scene's brush strokes measuring another scene.
 */
function maskKey(
  objectId = activeMeasurementSubject().id,
  frame = state.canonicalFrame,
  clip = activeClip,
): string {
  const object = measurementObjects(clip).find((item) => item.id === objectId);
  return `${clip}/${object?.maskOwnerId ?? objectId}:${frame}`;
}

/** Ad hoc masks are never persisted or exported: the measurement itself is temporary. */
function isFreeMaskKey(key: string): boolean {
  return key.slice(key.indexOf("/") + 1).startsWith(`${FREE_MEASUREMENT_ID}:`);
}

export function getMask(objectId = activeMeasurementSubject().id, frame = state.canonicalFrame): MaskRecord | undefined {
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
  const group = `${observation.objectId}:${observation.runId}`;
  // Counted from the highest index ever used in this group, not from how many rows survive.
  // Discarding trial 2 of 3 left two rows, so the next trial was numbered 3 and collided with
  // the existing trial 3 — same id, same evidence id, and the disk file of one overwritten by
  // the other.
  const trialIndex =
    state.observations
      .filter((item) => item.objectId === observation.objectId && item.runId === observation.runId)
      .reduce((highest, item) => Math.max(highest, item.trialIndex), 0) + 1;
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

/**
 * One trial's identity, for telling the disk copy from a different trial.
 *
 * `id` alone is not enough: it carries the trial number, and two sittings of the same object on
 * the same run legitimately both hold a trial 1. `capturedAt` is the instant it was frozen.
 */
export function trialIdentity(row: MeasurementObservation): string {
  return `${row.id}@${row.capturedAt}`;
}

/**
 * Take in trials recorded on disk, without disturbing the ones already here.
 *
 * Evidence was written to disk and never read back: `localStorage` was the only source of the
 * trial list, so clearing site data or opening the app in another profile hid every recorded
 * trial while its packets sat on disk. Measured 2026-08-11 — the Objects pane reported 0 trials
 * for `door-504px-112f` beside 33 stored packets.
 *
 * **A trial already held here wins.** The two copies are the same recording, and the local one is
 * the live row the operator is working with — it can be discarded, and a discard deletes the disk
 * packet with it. Letting the file overwrite the row would make the stale copy authoritative
 * during the window between the two, which is the one moment they ever disagree.
 *
 * The batch is de-duplicated against itself as well, because one trial can occupy more than one
 * file. Measured on the door archive: 33 packets, 17 trials — 16 of them written once under
 * evidence schema 0.1.0 and again under 0.2.0, which named its files differently. Same trial id,
 * same instant, same mask digest, two files.
 */
export function mergeObservations(
  rows: readonly MeasurementObservation[],
): MeasurementObservation[] {
  const known = new Set(state.observations.map(trialIdentity));
  const added: MeasurementObservation[] = [];
  for (const row of migrateObservations(rows)) {
    const identity = trialIdentity(row);
    if (known.has(identity)) continue;
    known.add(identity);
    added.push(row);
  }
  if (!added.length) return [];
  state.observations = [...state.observations, ...added];
  commit();
  return added;
}

/**
 * Drop ONE trial — a misclick or an abandoned attempt, not a whole study.
 *
 * Matched on identity rather than on `id` alone. Trial ids were reissued by position until
 * 2026-08-11, so an archive can hold two different recordings under one id, and filtering by id
 * would discard both when the operator asked to discard one.
 */
export function removeObservation(trial: MeasurementObservation): void {
  const identity = trialIdentity(trial);
  state.observations = state.observations.filter((item) => trialIdentity(item) !== identity);
  // Otherwise the viewport keeps a highlight pointing at a row that no longer exists.
  if (state.focusedTrialId === identity) state.focusedTrialId = null;
  commit();
}

export function clearObservations(): void {
  state.observations = [];
  state.segmentationAttempts = [];
  state.focusedTrialId = null;
  paintClocks.clear();
  commit();
}

export function trialsFor(
  observations: readonly MeasurementObservation[],
  objectId: string,
  runId?: RunId,
): MeasurementObservation[] {
  return observations
    .filter((item) => item.objectId === objectId && (!runId || item.runId === runId))
    .sort((a, b) => a.trialIndex - b.trialIndex);
}

/**
 * Trials whose mask is byte-identical to an earlier trial in the same group.
 *
 * Pressing Record twice without repainting yields two rows, zero spread, and the appearance
 * of perfect repeatability — when it is one measurement counted twice. An independent trial
 * means clearing the mask and placing the endpoints again. These are surfaced rather than
 * dropped, because the operator may have meant to record a deliberate control.
 *
 * Returns trial IDENTITIES, not ids: an id alone does not pick out one row in an archive
 * recorded before trial numbering became stable.
 */
export function duplicateMaskTrialIds(
  observations: readonly MeasurementObservation[],
  objectId: string,
  runId?: RunId,
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const trial of trialsFor(observations, objectId, runId)) {
    const digest = trial.mask?.digest;
    if (!digest) continue;
    if (seen.has(digest)) duplicates.add(trialIdentity(trial));
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
  runId?: RunId,
): TrialStats {
  const rows = trialsFor(observations, objectId, runId).filter((item) =>
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

/**
 * The session as a file, scoped to ONE clip's runs.
 *
 * `clipRunIds` is required because the repeatability block used to be built from the active clip's
 * targets crossed with every run id in the store. Where two clips held a target with the same id —
 * `pc-tower` existed in the door set and in `RoomNewFixture` until 2026-08-13 — that emitted the
 * door run's trials under the room's code and the room's truth. On-screen readings were never
 * affected; they have always been keyed by object AND run. The exported file was the one place two
 * clips could be read as one.
 */
export function exportMeasurementSession(clipRunIds: readonly RunId[]): string {
  const workingMasks = Object.fromEntries(
    Object.entries(state.masks)
      .filter(([key]) => !isFreeMaskKey(key) && key.startsWith(`${activeClip}/`))
      .map(([key, mask]) => [
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
  const scope = new Set(clipRunIds);
  const runIds = [...new Set(state.observations.map((item) => item.runId))].filter((runId) =>
    scope.has(runId),
  );
  const observations = state.observations.filter((item) => scope.has(item.runId));
  const repeatability = measurementObjects().flatMap((object) =>
    runIds
      .map((runId) => ({ objectId: object.id, code: object.code, runId, ...trialStats(observations, object.id, runId) }))
      .filter((row) => row.n > 0),
  );
  return JSON.stringify(
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBySitting: SITTING_ID,
      // The file states its own scope, so a reader never has to infer which clip it describes.
      clipKey: activeClip,
      runIds,
      // Which sittings the trials came from, so a reader can tell a repeatability claim from
      // three measurements taken in the same five minutes.
      sittings: [...new Set(observations.map((item) => item.sittingId ?? LEGACY_SITTING_ID))],
      definitions: measurementObjects(),
      // Every trial, each carrying the mask it was measured from. This is the evidence.
      observations,
      segmentationAttempts: state.segmentationAttempts,
      repeatability,
      // The live selection state, kept for convenience. It is NOT evidence: it moves as you edit.
      workingMasks,
    },
    null,
    2,
  );
}
