/**
 * The run readout is only worth having if it reports what actually happened. These drive the
 * machine through a whole run with no network, and pin the three claims it makes:
 *
 * 1. The phases arrive in order, and each one is entered by an OBSERVATION rather than a clock.
 * 2. A failure keeps the phase it died in — the fact a bare stack trace loses.
 * 3. The only proportion drawn anywhere is bytes over bytes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { GpuSnapshot } from "./contract";
import {
  EXPECTED,
  applyGpu,
  beginFetching,
  beginRun,
  beginServerWait,
  beginUpload,
  failRun,
  finishRun,
  getRunPhase,
  isRunActive,
  noteFramesRead,
  noteUploadProgress,
  resetRun,
  setGpuReader,
} from "./run-phase";

function gpu(patch: Partial<GpuSnapshot> = {}): GpuSnapshot {
  return {
    available: true,
    modelLoaded: false,
    busy: false,
    deviceName: "NVIDIA L4",
    currentBytes: 0,
    peakBytes: 0,
    totalBytes: 23_659_151_360,
    ...patch,
  };
}

beforeEach(() => {
  // No reader: the tests fold telemetry in by hand, so nothing schedules a timer.
  setGpuReader(null);
  resetRun();
});

describe("the run phase machine", () => {
  it("starts idle and reports nothing", () => {
    expect(getRunPhase().kind).toBe("idle");
    expect(isRunActive()).toBe(false);
  });

  it("walks a cold run through every phase in order", () => {
    const seen: string[] = [];
    const note = () => seen.push(getRunPhase().kind);

    beginRun();
    note();
    noteFramesRead(112, 112);

    beginUpload(9_900_000);
    note();
    noteUploadProgress(4_950_000, 9_900_000);

    beginServerWait();
    note();

    // Nothing answering: the instance does not exist yet. This is the observation, not a guess.
    applyGpu(null);
    note();
    // Container up, model not in VRAM.
    applyGpu(gpu({ available: true, modelLoaded: false }));
    note();
    // Model resident and the device busy.
    applyGpu(gpu({ modelLoaded: true, busy: true, currentBytes: 7_050_625_024 }));
    note();

    beginFetching();
    note();
    finishRun();
    note();

    expect(seen).toEqual([
      "reading",
      "uploading",
      "waking",
      "waking",
      "loadingModel",
      "inferring",
      "fetching",
      "done",
    ]);
    expect(isRunActive()).toBe(false);
  });

  it("treats a failed telemetry read as still waking, not as a failure", () => {
    beginRun();
    beginServerWait();
    applyGpu(gpu({ modelLoaded: true, busy: true }));
    expect(getRunPhase().kind).toBe("inferring");

    // An instance can stop answering mid-run — a restart, a dropped poll. That is a return to
    // waking, not a dead run: the request itself is still open.
    applyGpu(null);
    expect(getRunPhase().kind).toBe("waking");
    expect(getRunPhase().failedIn).toBeNull();
  });

  it("records the VRAM floor when inference begins, so the climb has a baseline", () => {
    beginRun();
    beginServerWait();
    applyGpu(gpu({ modelLoaded: true, busy: true, currentBytes: 7_050_625_024 }));
    expect(getRunPhase().vramFloorBytes).toBe(7_050_625_024);

    applyGpu(gpu({ modelLoaded: true, busy: true, currentBytes: 17_230_000_000 }));
    // The floor is the value at entry, not the latest reading — otherwise the climb it exists
    // to show would always measure zero.
    expect(getRunPhase().vramFloorBytes).toBe(7_050_625_024);
    expect(getRunPhase().gpu?.currentBytes).toBe(17_230_000_000);
  });

  it("keeps the phase a failure happened in", () => {
    beginRun();
    beginUpload(1000);
    failRun("network error while uploading frames");

    const state = getRunPhase();
    expect(state.kind).toBe("failed");
    expect(state.failedIn).toBe("uploading");
    expect(state.message).toBe("network error while uploading frames");
    expect(isRunActive()).toBe(false);
  });

  it("distinguishes a failure while inferring from one while uploading", () => {
    beginRun();
    beginServerWait();
    applyGpu(gpu({ modelLoaded: true, busy: true }));
    failRun("500: CUDA out of memory");
    expect(getRunPhase().failedIn).toBe("inferring");
  });

  it("does not let telemetry move the phase once a run has finished", () => {
    beginRun();
    beginServerWait();
    finishRun();
    applyGpu(gpu({ modelLoaded: true, busy: true }));
    expect(getRunPhase().kind).toBe("done");
  });

  it("carries exact upload bytes rather than a percentage", () => {
    beginRun();
    beginUpload(9_900_000);
    noteUploadProgress(1_234_567, 9_900_000);
    const { upload } = getRunPhase();
    // The component divides these. Storing a percentage here would be the point at which a
    // measured quantity turned into a rounded one.
    expect(upload.sentBytes).toBe(1_234_567);
    expect(upload.totalBytes).toBe(9_900_000);
  });

  it("resets everything between runs, so a second attempt shows no trace of the first", () => {
    beginRun();
    beginUpload(500);
    failRun("boom");
    beginRun();

    const state = getRunPhase();
    expect(state.kind).toBe("reading");
    expect(state.failedIn).toBeNull();
    expect(state.message).toBeNull();
    expect(state.upload).toEqual({ sentBytes: 0, totalBytes: 0 });
  });
});

describe("the measured expectations shown beside the clocks", () => {
  /**
   * These are observations from a real L4, recorded in REGISTRY section 3. They are displayed
   * beside an elapsed clock and never drive a bar — a phase that advanced on them would be a
   * prediction wearing a measurement's clothes, which DESIGN.md honesty rule 1 forbids.
   */
  it("has one for each phase whose duration was actually measured, and no others", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(["inferring", "loadingModel", "waking"]);
  });

  it("states the cold start and model load the registry recorded", () => {
    expect(EXPECTED.waking?.seconds).toBe(64);
    expect(EXPECTED.loadingModel?.seconds).toBe(40);
  });

  it("labels every figure as measured, so none can read as a target", () => {
    for (const entry of Object.values(EXPECTED)) {
      expect(entry?.note).toMatch(/measured/);
    }
  });
});
