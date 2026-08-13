import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_DOOR_CLIP,
  DOOR_TARGETS,
  acceptActiveModelMask,
  addTarget,
  mergeObservations,
  migrateMaskKeys,
  setActiveClip,
  activeMeasurementObject,
  activeMeasurementSubject,
  addObservation,
  automaticMaskReviewIssue,
  beginMaskCorrection,
  clearActiveMask,
  clearObservations,
  currentSittingId,
  duplicateMaskTrialIds,
  LEGACY_SITTING_ID,
  MEASUREMENT_OBJECTS,
  ensureMask,
  exportMeasurementSession,
  getMask,
  getMeasurementUi,
  migrateObservations,
  paintElapsedMs,
  paintMask,
  paintMaskStroke,
  removeObservation,
  recordSegmentationAttempt,
  segmentationAttemptStats,
  setActiveMeasurementObject,
  setFocusedTrial,
  setFreeMeasurement,
  setFreeMeasurementMode,
  setShowEvidence,
  setMaskData,
  setMeasurementFrame,
  trialIdentity,
  trialStats,
  type MeasurementObservation,
} from "./measurement-store";

const BASE = {
  objectId: "door-leaf",
  runId: "door-356px-256f" as const,
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

describe("measurement store", () => {
  beforeEach(() => {
    clearObservations();
    // The store is module state, so a test that changes clip would otherwise hand the next one
    // a target set with no door-leaf in it.
    setActiveClip(BUILTIN_DOOR_CLIP);
    setActiveMeasurementObject("door-leaf");
    setMeasurementFrame(1);
    setMaskData("door-leaf", 1, 24, 20, new Uint8Array(24 * 20));
  });

  it("uses the fitted floor directly for floor-referenced automatic targets", () => {
    expect(MEASUREMENT_OBJECTS.find((item) => item.id === "table-top")?.mode).toBe(
      "top_above_floor",
    );
    expect(MEASUREMENT_OBJECTS.find((item) => item.id === "monitor-top")?.mode).toBe(
      "top_above_floor",
    );
    expect(MEASUREMENT_OBJECTS.find((item) => item.id === "pc-tower")?.mode).toBe(
      "vertical_extent",
    );
  });

  it("keeps free measurement temporary and separate from named-object evidence", () => {
    setFreeMeasurement();
    setFreeMeasurementMode("top_above_floor");
    expect(activeMeasurementObject()).toBeUndefined();
    expect(activeMeasurementSubject()).toMatchObject({ id: "__free__", mode: "top_above_floor" });

    ensureMask(4, 3);
    paintMask(1, 1, 1, false);
    expect(getMask()?.data.some(Boolean)).toBe(true);

    setActiveMeasurementObject("door-leaf");
    expect(getMask("door-leaf", 1)?.data.some(Boolean)).toBe(false);

    const exported = JSON.parse(exportMeasurementSession([BASE.runId])) as {
      workingMasks: Record<string, unknown>;
      observations: MeasurementObservation[];
    };
    expect(Object.keys(exported.workingMasks)).not.toContain(`${BUILTIN_DOOR_CLIP}/__free__:1`);
    expect(exported.observations).toHaveLength(0);
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

  /**
   * The brush died on any subject switch that left the frame alone — Ad hoc ⇄ a named target,
   * most often. Masks are keyed `subject:frame` and the pane only created one when the RGB
   * image loaded, which a same-frame switch never triggers. `paintMaskStroke` then threw from
   * inside a pointer handler, so the stroke vanished with no visible error.
   *
   * The pane now calls `ensureMask` on the mask's identity and again at paint time. This holds
   * the store side of that: a switch really does leave the new key empty, and ensuring it is
   * cheap enough to sit on the paint path.
   */
  it("gives each subject its own mask key, and ensures one without churning the store", () => {
    setFreeMeasurement();
    setMeasurementFrame(93);
    ensureMask(24, 20);

    setActiveMeasurementObject("door-leaf");
    setMeasurementFrame(93); // the switch the pane makes without reloading the frame
    expect(getMask()).toBeUndefined();

    const created = ensureMask(24, 20);
    // Same record back, not a fresh allocation: paintAt calls this on every pointer event, and
    // a new Uint8Array per stroke would throw the operator's paint away.
    expect(ensureMask(24, 20)).toBe(created);
    expect(() => paintMaskStroke({ x: 5, y: 5 }, { x: 12, y: 12 }, 3, false)).not.toThrow();
    expect(getMask()?.data.some(Boolean)).toBe(true);

    // Back to Ad hoc at the same frame: its own mask, none of the target's paint.
    setFreeMeasurement();
    expect(ensureMask(24, 20).data.some(Boolean)).toBe(false);
  });

  /**
   * A selection painted on one clip used to stay selected on the next and measure it. Observed
   * 2026-08-11: 18,507 px painted on `RoomNewFixture.mp4` reported 0.759 m against the door's
   * point cloud after a run switch.
   */
  it("keeps each clip's masks to itself, including Ad hoc", () => {
    setActiveClip(BUILTIN_DOOR_CLIP);
    setFreeMeasurement();
    setMeasurementFrame(1);
    ensureMask(24, 20);
    paintMask(5, 5, 3, false);
    const doorPixels = getMask()?.data.reduce((sum, value) => sum + value, 0) ?? 0;
    expect(doorPixels).toBeGreaterThan(0);

    setActiveClip("clip-b-sha");
    expect(getMask()).toBeUndefined();
    expect(ensureMask(24, 20).data.some(Boolean)).toBe(false);

    setActiveClip(BUILTIN_DOOR_CLIP);
    setFreeMeasurement();
    expect(getMask()?.data.reduce((sum, value) => sum + value, 0)).toBe(doorPixels);
  });

  /**
   * Two clips may hold a target with the same name: `AddTargetForm` slugifies the name and only
   * de-duplicates within one clip's set, so `doorway` can exist twice. Before the clip went into
   * the mask key that was one mask serving two scenes.
   */
  it("separates same-named targets that belong to different clips", () => {
    const doorway = {
      id: "doorway",
      code: "T1",
      name: "Doorway",
      definition: "floor to lintel",
      truthM: 2.0,
      mode: "vertical_extent" as const,
      suggestedFrame: 4,
      maskInstruction: "paint it",
    };
    setActiveClip("clip-one");
    addTarget(doorway);
    setActiveMeasurementObject("doorway");
    setMeasurementFrame(4);
    ensureMask(10, 10);
    paintMask(5, 5, 2, false);
    const painted = getMask()?.data.reduce((sum, value) => sum + value, 0) ?? 0;

    setActiveClip("clip-two");
    addTarget(doorway);
    setActiveMeasurementObject("doorway");
    setMeasurementFrame(4);
    expect(getMask()).toBeUndefined();

    setActiveClip("clip-one");
    setActiveMeasurementObject("doorway");
    expect(getMask()?.data.reduce((sum, value) => sum + value, 0)).toBe(painted);
  });

  it("gives a 0.5.0 mask key its clip from the target that owns it", () => {
    const migrated = migrateMaskKeys(
      { "door-leaf:1": "a", "doorway:4": "b", "clip-one/doorway:4": "c" },
      "saved-clip",
      { [BUILTIN_DOOR_CLIP]: DOOR_TARGETS, "clip-one": [], "clip-two": [] },
    );
    expect(Object.keys(migrated).sort()).toEqual([
      "clip-one/doorway:4",
      "builtin-door/door-leaf:1",
      "saved-clip/doorway:4",
    ].sort());
  });

  it("retains repeat trials instead of destroying the previous one, and keeps runs separate", () => {
    addObservation({ ...BASE, rawM: 1.4 });
    addObservation({ ...BASE, rawM: 1.41 });
    addObservation({ ...BASE, runId: "door-504px-112f", rawM: 1.65 });

    const observations = getMeasurementUi().observations;
    expect(observations).toHaveLength(3);
    expect(observations.map((item) => item.rawM)).toEqual([1.4, 1.41, 1.65]);
    // Trials are numbered within (object, run), so a different run restarts at 1.
    expect(observations.map((item) => item.trialIndex)).toEqual([1, 2, 1]);
    expect(new Set(observations.map((item) => item.id)).size).toBe(3);
    expect(trialStats(observations, "door-leaf", "door-356px-256f").n).toBe(2);
    expect(trialStats(observations, "door-leaf", "door-504px-112f").n).toBe(1);
  });

  /**
   * Evidence written to disk was never read back, so a cleared cache hid every recorded trial
   * while its packets survived on disk. Merging has to add what is missing and touch nothing else.
   */
  it("takes in trials from disk without duplicating or overwriting the local ones", () => {
    const local = addObservation({ ...BASE, rawM: 1.4 });
    const fromDisk: MeasurementObservation[] = [
      // The same trial, as the disk copy of it: same id, same instant.
      { ...local, rawM: 9.99 },
      // A trial this browser has never seen.
      {
        ...BASE,
        id: "door-leaf:door-356px-256f#7",
        trialIndex: 7,
        rawM: 2.01,
        sittingId: "sitting-elsewhere",
        capturedAt: "2026-08-04T10:00:00.000Z",
        mask: { width: 4, height: 4, revision: 2, paintedPixels: 4, digest: "abcd", runs: [5, 4], source: "brush" },
      },
    ];

    // The same packet twice, as the door archive really holds it: one file per evidence schema
    // it was written under. Two files, one trial.
    const recovered = mergeObservations([...fromDisk, { ...fromDisk[1] }]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe("door-leaf:door-356px-256f#7");

    const rows = getMeasurementUi().observations;
    expect(rows).toHaveLength(2);
    // The local row is untouched: the disk copy must not overwrite the row being worked on.
    expect(rows.find((item) => item.id === local.id)?.rawM).toBe(1.4);
    // Its number and sitting survive, so a recovered trial still says which sitting it came from.
    expect(rows.find((item) => item.id === "door-leaf:door-356px-256f#7")).toMatchObject({
      trialIndex: 7,
      sittingId: "sitting-elsewhere",
    });
    expect(trialStats(rows, "door-leaf", "door-356px-256f").n).toBe(2);

    // Reading the same run twice adds nothing.
    expect(mergeObservations(fromDisk)).toHaveLength(0);
    expect(getMeasurementUi().observations).toHaveLength(2);

    // A recovered trial keeps its number, so the next recording cannot collide with it.
    expect(addObservation({ ...BASE, rawM: 1.5 }).trialIndex).toBe(8);
  });

  /**
   * Trial numbers are part of a trial's identity: the evidence file on disk is named after the
   * id, so reusing or renaming one loses the link to it.
   */
  it("never reuses a discarded trial's number, and keeps its number across a reload", () => {
    const first = addObservation({ ...BASE, rawM: 1.4 });
    const second = addObservation({ ...BASE, rawM: 1.41 });
    const third = addObservation({ ...BASE, rawM: 1.42 });
    expect([first, second, third].map((item) => item.trialIndex)).toEqual([1, 2, 3]);

    removeObservation(second);
    const fourth = addObservation({ ...BASE, rawM: 1.43 });
    // Counting the survivors would have numbered this 3 and collided with the trial above.
    expect(fourth.trialIndex).toBe(4);
    expect(fourth.id).not.toBe(third.id);

    const reloaded = migrateObservations(getMeasurementUi().observations);
    expect(reloaded.map((item) => item.trialIndex)).toEqual([1, 3, 4]);
    expect(reloaded.map((item) => item.id)).toEqual([first.id, third.id, fourth.id]);
  });

  it("reports operator spread across trials, and withholds NMAD below three of them", () => {
    addObservation({ ...BASE, rawM: 1.887 });
    addObservation({ ...BASE, rawM: 2.003 });
    expect(trialStats(getMeasurementUi().observations, "door-leaf", "door-356px-256f").nmadM).toBeNaN();

    addObservation({ ...BASE, rawM: 1.95 });
    const stats = trialStats(getMeasurementUi().observations, "door-leaf", "door-356px-256f");
    expect(stats.n).toBe(3);
    expect(stats.medianM).toBeCloseTo(1.95, 6);
    expect(stats.meanM).toBeCloseTo((1.887 + 2.003 + 1.95) / 3, 6);
    expect(stats.rangeM).toBeCloseTo(0.116, 6);
    expect(stats.nmadM).toBeGreaterThan(0);
  });

  it("freezes the mask into the trial so later painting cannot rewrite recorded evidence", () => {
    const painted = new Uint8Array(24 * 20);
    painted.fill(1, 40, 60);
    setMaskData("door-leaf", 1, 24, 20, painted);

    const first = addObservation({ ...BASE, runId: "door-504px-112f", rawM: 2.0 });
    expect(first.mask?.paintedPixels).toBe(20);
    const frozenDigest = first.mask?.digest;
    expect(frozenDigest).toMatch(/^[0-9a-f]{16}$/);

    paintMaskStroke({ x: 2, y: 2 }, { x: 20, y: 2 }, 3, false);
    const second = addObservation({ ...BASE, runId: "door-504px-112f", rawM: 2.08 });

    const [recorded] = getMeasurementUi().observations;
    expect(recorded.mask?.paintedPixels).toBe(20);
    expect(recorded.mask?.digest).toBe(frozenDigest);
    // A different mask must be distinguishable from the first without comparing pixels.
    expect(second.mask?.digest).not.toBe(frozenDigest);
    expect(second.mask!.paintedPixels).toBeGreaterThan(20);
  });

  it("times painting from the first stroke to the record, and resets for the next trial", () => {
    expect(paintElapsedMs()).toBeUndefined();
    paintMaskStroke({ x: 5, y: 10 }, { x: 18, y: 10 }, 3, false);
    expect(paintElapsedMs()).toBeGreaterThanOrEqual(0);

    const trial = addObservation({ ...BASE, rawM: 1.4 });
    expect(trial.paintDurationMs).toBeGreaterThanOrEqual(0);
    // Recording closes the clock; the next trial must not inherit this one's elapsed time.
    expect(paintElapsedMs()).toBeUndefined();
  });

  it("migrates 0.1.0 rows to numbered trials without inventing mask evidence for them", () => {
    const legacy = [
      { id: "door-leaf:504px-112f:1", objectId: "door-leaf", runId: "door-504px-112f", rawM: 1.887 },
      { id: "door-leaf:504px-112f:1", objectId: "door-leaf", runId: "door-504px-112f", rawM: 2.003 },
      { id: "table-top:504px-112f:231", objectId: "table-top", runId: "door-504px-112f", rawM: 0.71 },
    ] as unknown as MeasurementObservation[];

    const migrated = migrateObservations(legacy);
    expect(migrated.map((item) => item.trialIndex)).toEqual([1, 2, 1]);
    expect(new Set(migrated.map((item) => item.id)).size).toBe(3);
    // The mask a 0.1.0 row was measured from has since been repainted. Say so rather than
    // attaching whatever happens to be on the canvas now.
    expect(migrated.every((item) => item.mask === undefined)).toBe(true);
  });

  it("migrates 0.4.0 fixture settings onto built-in run ids without losing a trial", () => {
    // 0.4.0 keyed trials by one of three fixture directory names. Those three ARE the built-in
    // door runs, so the mapping is exact — but getting it wrong would silently split the nine
    // P0 trials into orphan groups and quietly destroy the repeatability study.
    const legacy = [
      { id: "a", objectId: "door-leaf", setting: "504px-112f", rawM: 2.02 },
      { id: "b", objectId: "door-leaf", setting: "504px-112f", rawM: 2.018 },
      { id: "c", objectId: "table-top", setting: "356px-256f", rawM: 0.71 },
    ] as unknown as MeasurementObservation[];

    const migrated = migrateObservations(legacy);
    expect(migrated.map((item) => item.runId)).toEqual([
      "door-504px-112f",
      "door-504px-112f",
      "door-356px-256f",
    ]);
    // Still one group of two and one of one — the study survives the re-key intact.
    expect(migrated.map((item) => item.trialIndex)).toEqual([1, 2, 1]);
    expect(trialStats(migrated, "door-leaf", "door-504px-112f").n).toBe(2);
  });

  it("leaves an already-migrated 0.5.0 row's run id alone", () => {
    const rows = [
      { id: "a", objectId: "door-leaf", runId: "20260804-1612-ab12", rawM: 2.0 },
    ] as unknown as MeasurementObservation[];
    // A saved cloud run's id must not acquire a "door-" prefix on every reload.
    expect(migrateObservations(rows)[0].runId).toBe("20260804-1612-ab12");
  });

  it("exports portable RLE masks and the clarified physical measurement definitions", () => {
    const data = new Uint8Array(12);
    data.fill(1, 2, 5);
    data.fill(1, 8, 10);
    setMaskData("door-leaf", 1, 4, 3, data);

    addObservation({ ...BASE, rawM: 1.9 });
    addObservation({ ...BASE, rawM: 2.0 });

    const exported = JSON.parse(exportMeasurementSession([BASE.runId])) as {
      schemaVersion: string;
      definitions: Array<{ id: string; mode: string; definition: string }>;
      observations: MeasurementObservation[];
      repeatability: Array<{ objectId: string; setting: string; n: number; rangeM: number }>;
      workingMasks: Record<string, { paintedPixels: number; runs: number[] }>;
    };
    expect(exported.schemaVersion).toBe("verge.measurement-session/0.6.0");
    expect(exported.definitions.find((item) => item.id === "door-leaf")).toMatchObject({
      mode: "vertical_extent",
      definition: "physical leaf, bottom edge to top edge",
    });
    expect(exported.definitions.find((item) => item.id === "table-top")).toMatchObject({
      mode: "top_above_floor",
    });
    // Exported keys carry the clip, so a reader can tell which scene a mask was painted on.
    expect(exported.workingMasks["builtin-door/door-leaf:1"]).toMatchObject({
      paintedPixels: 5,
      runs: [2, 3, 8, 2],
    });
    // Both trials survive the round trip, each carrying the mask it was measured from.
    expect(exported.observations).toHaveLength(2);
    expect(exported.observations.map((item) => item.mask?.runs)).toEqual([
      [2, 3, 8, 2],
      [2, 3, 8, 2],
    ]);
    expect(exported.repeatability).toContainEqual(
      expect.objectContaining({ objectId: "door-leaf", runId: "door-356px-256f", n: 2 }),
    );
  });

  it("flags trials that reuse an earlier trial's mask instead of crediting them as repeats", () => {
    const painted = new Uint8Array(24 * 20);
    painted.fill(1, 40, 60);
    setMaskData("door-leaf", 1, 24, 20, painted);

    const first = addObservation({ ...BASE, rawM: 2.0 });
    const unrepainted = addObservation({ ...BASE, rawM: 2.0 });
    paintMaskStroke({ x: 2, y: 2 }, { x: 20, y: 2 }, 3, false);
    const repainted = addObservation({ ...BASE, rawM: 1.96 });

    const flagged = duplicateMaskTrialIds(getMeasurementUi().observations, "door-leaf", "door-356px-256f");
    // Identities, not ids: an id does not pick out one row in a pre-2026-08-11 archive.
    expect(flagged.has(trialIdentity(unrepainted))).toBe(true);
    expect(flagged.has(trialIdentity(first))).toBe(false);
    expect(flagged.has(trialIdentity(repainted))).toBe(false);
  });

  it("withholds model evidence until review and preserves corrections in provenance", () => {
    const data = new Uint8Array(24 * 20);
    data.fill(1, 50, 300);
    setMaskData("door-leaf", 1, 24, 20, data, {
      source: "model",
      segmentation: {
        attemptId: "attempt-good",
        modelId: "Xenova/slimsam-77-uniform",
        modelRevision: "pinned",
        runtime: "transformers.js",
        device: "webgpu",
        prompts: [{ x: 0.5, y: 0.5, label: 1 }],
        candidateScores: [0.96, 0.81, 0.2],
        selectedCandidate: 0,
        score: 0.96,
        scoreMargin: 0.15,
        boundaryFraction: 0,
        modelLoadMs: 800,
        frameEncodeMs: 5000,
        lastDecodeMs: 700,
        correctionStrokes: 0,
        accepted: false,
      },
    });

    expect(automaticMaskReviewIssue(getMask())).toBeUndefined();
    expect(getMask()?.segmentation?.accepted).toBe(false);
    acceptActiveModelMask(7200);
    expect(getMask()?.segmentation).toMatchObject({ accepted: true, selectionDurationMs: 7200 });

    beginMaskCorrection();
    paintMaskStroke({ x: 2, y: 2 }, { x: 20, y: 2 }, 3, false);
    expect(getMask()).toMatchObject({ source: "model+brush" });
    expect(getMask()?.segmentation).toMatchObject({ accepted: false, correctionStrokes: 1 });

    acceptActiveModelMask(9100);
    const trial = addObservation({ ...BASE, rawM: 2.03 });
    expect(trial.mask).toMatchObject({ source: "model+brush" });
    expect(trial.mask?.segmentation).toMatchObject({
      accepted: true,
      correctionStrokes: 1,
      selectionDurationMs: 9100,
    });
  });

  it("refuses to accept an ambiguous untouched model proposal", () => {
    setMaskData("door-leaf", 1, 24, 20, new Uint8Array(24 * 20).fill(1), {
      source: "model",
      segmentation: {
        attemptId: "attempt-ambiguous",
        modelId: "test",
        modelRevision: "test",
        runtime: "test",
        device: "webgpu",
        prompts: [{ x: 0.5, y: 0.5, label: 1 }],
        candidateScores: [0.91, 0.9, 0.1],
        selectedCandidate: 0,
        score: 0.91,
        scoreMargin: 0.01,
        boundaryFraction: 0,
        modelLoadMs: 1,
        frameEncodeMs: 1,
        lastDecodeMs: 1,
        correctionStrokes: 0,
        accepted: false,
      },
    });
    expect(() => acceptActiveModelMask(10)).toThrow(/nearly equal masks/);
  });

  it("keeps abstained and failed automatic attempts in the exported evidence", () => {
    const common = {
      objectId: "door-leaf",
      canonicalFrame: 1,
      modelId: "test",
      modelRevision: "pinned",
      promptCount: 1,
      positivePrompts: 1,
      correctionStrokes: 0,
    };
    recordSegmentationAttempt({ ...common, id: "a", outcome: "abstained", reason: "ambiguous" });
    recordSegmentationAttempt({ ...common, id: "b", outcome: "failed", reason: "WebGPU unavailable" });
    recordSegmentationAttempt({ ...common, id: "a", outcome: "accepted" });

    expect(segmentationAttemptStats()).toEqual({
      total: 2,
      proposed: 0,
      accepted: 1,
      abstained: 0,
      failed: 1,
    });
    const exported = JSON.parse(exportMeasurementSession([BASE.runId])) as { segmentationAttempts: unknown[] };
    expect(exported.segmentationAttempts).toHaveLength(2);
  });

  it("stamps new trials with this page load's sitting", () => {
    const trial = addObservation({ ...BASE, rawM: 2.0 });
    expect(trial.sittingId).toBe(currentSittingId());
    expect(trial.sittingId).not.toBe(LEGACY_SITTING_ID);
  });

  it("hands pre-0.3.0 rows to the legacy sitting, never to this one", () => {
    // Claiming an old trial for the current page load would manufacture a between-sitting
    // comparison out of a single afternoon's work.
    const migrated = migrateObservations([
      { ...BASE, rawM: 2.0, capturedAt: "2026-08-04T12:00:00Z" } as MeasurementObservation,
    ]);
    expect(migrated[0].sittingId).toBe(LEGACY_SITTING_ID);
    expect(migrated[0].sittingId).not.toBe(currentSittingId());
  });

  it("separates within-sitting repeats from between-sitting movement", () => {
    // The real P0 shape: tight back-to-back trials, a much larger shift on returning later.
    const rows = [
      { ...BASE, id: "a1", trialIndex: 1, sittingId: "s1", rawM: 2.02, capturedAt: "" },
      { ...BASE, id: "a2", trialIndex: 2, sittingId: "s1", rawM: 2.024, capturedAt: "" },
      { ...BASE, id: "b1", trialIndex: 3, sittingId: "s2", rawM: 1.89, capturedAt: "" },
      { ...BASE, id: "b2", trialIndex: 4, sittingId: "s2", rawM: 1.894, capturedAt: "" },
    ] as MeasurementObservation[];

    const stats = trialStats(rows, "door-leaf", "door-356px-256f");
    expect(stats.sittingCount).toBe(2);
    expect(stats.withinSittingRangeM).toBeCloseTo(0.004, 6);
    // Between-sitting movement is ~32× the within-sitting spread and must not be averaged away.
    expect(stats.betweenSittingRangeM).toBeCloseTo(0.13, 6);
  });

  it("withholds the between-sitting figure until a second sitting exists", () => {
    addObservation({ ...BASE, rawM: 2.0 });
    addObservation({ ...BASE, rawM: 2.01 });
    const stats = trialStats(getMeasurementUi().observations, "door-leaf", "door-356px-256f");
    expect(stats.sittingCount).toBe(1);
    expect(stats.betweenSittingRangeM).toBeNaN();
    expect(stats.withinSittingRangeM).toBeCloseTo(0.01, 6);
  });

  it("drops a single mistaken trial without disturbing the rest", () => {
    addObservation({ ...BASE, rawM: 1.9 });
    const mistake = addObservation({ ...BASE, rawM: 0.02 });
    addObservation({ ...BASE, rawM: 1.95 });

    removeObservation(mistake);
    const remaining = getMeasurementUi().observations;
    expect(remaining.map((item) => item.rawM)).toEqual([1.9, 1.95]);
    expect(trialStats(remaining, "door-leaf", "door-356px-256f").n).toBe(2);
  });

  it("freezes the ruler into the trial, so the endpoints survive a reload with the reading", () => {
    const trial = addObservation({
      ...BASE,
      rawM: 2.02,
      ruler: { bottom: [0, 0, 0], top: [0, 2.02, 0] },
      rulerKind: "extent",
    });

    expect(trial.ruler?.top).toEqual([0, 2.02, 0]);
    // What `localStorage` and the disk packet both carry is the observation itself.
    expect(getMeasurementUi().observations[0].ruler?.top).toEqual([0, 2.02, 0]);
    expect(getMeasurementUi().observations[0].rulerKind).toBe("extent");
  });

  it("shows recorded evidence by default and forgets a highlight when its trial goes", () => {
    expect(getMeasurementUi().showEvidence).toBe(true);
    expect(getMeasurementUi().focusedTrialId).toBeNull();

    const trial = addObservation({ ...BASE, rawM: 2.02, ruler: { bottom: [0, 0, 0], top: [0, 2, 0] } });
    setFocusedTrial(trialIdentity(trial));
    expect(getMeasurementUi().focusedTrialId).toBe(trialIdentity(trial));

    removeObservation(trial);
    expect(getMeasurementUi().focusedTrialId).toBeNull();
  });

  it("drops a highlight when the context leaves the object it belonged to", () => {
    const trial = addObservation({ ...BASE, rawM: 2.02, ruler: { bottom: [0, 0, 0], top: [0, 2, 0] } });

    setFocusedTrial(trialIdentity(trial));
    setFreeMeasurement();
    expect(getMeasurementUi().focusedTrialId).toBeNull();

    setActiveMeasurementObject("door-leaf");
    setFocusedTrial(trialIdentity(trial));
    setActiveMeasurementObject("table-top");
    expect(getMeasurementUi().focusedTrialId).toBeNull();
  });

  // Where the evidence switch is is a fact about this screen, not about the evidence. It stays
  // out of the export for the same reason it stays out of `persistSession`'s payload: a shared
  // session file describing which chips were lit would be describing the operator, not the run.
  it("keeps the evidence switch out of the exported session", () => {
    setShowEvidence(false);
    expect(getMeasurementUi().showEvidence).toBe(false);

    const exported = JSON.parse(exportMeasurementSession([BASE.runId])) as Record<string, unknown>;
    expect(exported).not.toHaveProperty("showEvidence");
    expect(exported).not.toHaveProperty("focusedTrialId");

    setShowEvidence(true);
  });
});
