/**
 * What an inference run is doing, right now.
 *
 * Inference is one blocking multipart POST. Against a cold service that is 64 s of cold start,
 * 40 s of model load and ~31 s of the forward pass — over two minutes in which the app said
 * "Running…" and nothing else. An operator could not tell a working run from a hung one, and the
 * 9.9 MB of frames going up the wire (measured, 111 frames of a 4K clip) were invisible.
 *
 * ## Where each phase comes from, and why none of them is a timer
 *
 * DESIGN.md honesty rule 1 forbids dressing a prediction as a measurement, so nothing here
 * advances on a clock:
 *
 * - `reading` and `uploading` are counted locally. Upload is the ONLY true percentage in the
 *   chain — bytes sent over bytes total, from `XMLHttpRequest.upload`, which is why `infer()`
 *   is not written with `fetch` (it cannot report upload progress at all).
 * - `waking`, `loadingModel` and `inferring` are read off the GPU's own telemetry. `/gpu` is
 *   already polled during a run; the observations that separate the three are whether anything
 *   answers, whether `modelLoaded` is set, and whether `busy` is set. That is a measurement of
 *   the machine, not a guess about it.
 * - `EXPECTED` below is shown *beside* the elapsed time and labelled as measured. It never
 *   drives a bar.
 *
 * ## Why the poll lives here and not in a pane
 *
 * It used to run inside the Inspector, so hiding that pane stopped the readout — and the pane is
 * hidden by exactly the operator who has filled the window with the viewport to watch a run land.
 * Polling stays demand-driven, which is a cost control rather than a preference: Cloud Run bills
 * instance lifetime, so an idle poll is not cheap, it is the whole cost. This one runs only while
 * a request is genuinely in flight.
 */

import { useSyncExternalStore } from "react";
import type { GpuSnapshot } from "./contract";
import { getCloud } from "./cloud-store";

export type PhaseKind =
  | "idle"
  | "reading"
  | "uploading"
  | "waking"
  | "loadingModel"
  | "inferring"
  | "fetching"
  | "done"
  | "failed";

/**
 * Measured durations, for display beside an elapsed clock. Every one of these is an observation
 * from a real L4, recorded in REGISTRY section 3 — not a target and not a timeout.
 */
export const EXPECTED: Partial<Record<PhaseKind, { seconds: number; note: string }>> = {
  waking: { seconds: 64, note: "measured cold start 64 s" },
  loadingModel: { seconds: 40, note: "measured model load 40 s" },
  inferring: { seconds: 31, note: "measured ~31 s at 112 frames, 504 px" },
};

export const PHASE_LABEL: Record<PhaseKind, string> = {
  idle: "idle",
  reading: "reading frames",
  uploading: "uploading frames",
  waking: "waking instance",
  loadingModel: "loading model",
  inferring: "inferring",
  fetching: "fetching artifacts",
  done: "done",
  failed: "failed",
};

export interface RunPhaseState {
  kind: PhaseKind;
  /** Start of the whole attempt, for the total elapsed. */
  startedAt: number | null;
  /** Start of the current phase. */
  phaseStartedAt: number | null;
  read: { done: number; total: number };
  upload: { sentBytes: number; totalBytes: number };
  /** Live telemetry while the request is open. Null when nothing has answered yet. */
  gpu: GpuSnapshot | null;
  /** VRAM when inference began, so the climb has a baseline to be read against. */
  vramFloorBytes: number | null;
  /** The phase a failure happened in — the fact a bare stack trace loses. */
  failedIn: PhaseKind | null;
  message: string | null;
  /** Wall milliseconds of the last completed attempt. */
  lastWallMs: number | null;
}

const initial: RunPhaseState = {
  kind: "idle",
  startedAt: null,
  phaseStartedAt: null,
  read: { done: 0, total: 0 },
  upload: { sentBytes: 0, totalBytes: 0 },
  gpu: null,
  vramFloorBytes: null,
  failedIn: null,
  message: null,
  lastWallMs: null,
};

const state: RunPhaseState = { ...initial };
let snapshot: RunPhaseState = { ...state };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRunPhase(): RunPhaseState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function getRunPhase(): RunPhaseState {
  return snapshot;
}

/** True while a request is genuinely in flight. The Setup pane suppresses its own poll on this. */
export function isRunActive(): boolean {
  return snapshot.kind !== "idle" && snapshot.kind !== "done" && snapshot.kind !== "failed";
}

function setPhase(kind: PhaseKind): void {
  if (state.kind === kind) return;
  state.kind = kind;
  state.phaseStartedAt = Date.now();
  emit();
}

export function beginRun(): void {
  Object.assign(state, initial);
  state.startedAt = Date.now();
  state.phaseStartedAt = Date.now();
  state.kind = "reading";
  emit();
}

export function noteFramesRead(done: number, total: number): void {
  state.read = { done, total };
  if (state.kind !== "reading") setPhase("reading");
  else emit();
}

export function beginUpload(totalBytes: number): void {
  state.upload = { sentBytes: 0, totalBytes };
  setPhase("uploading");
}

export function noteUploadProgress(sentBytes: number, totalBytes: number): void {
  state.upload = { sentBytes, totalBytes };
  emit();
}

/**
 * Upload finished; the request is open and the server has it.
 *
 * `waking` rather than `inferring` because at this moment we genuinely do not know which — an
 * instance may not exist yet. The poll below replaces this with an observation within one tick.
 */
export function beginServerWait(): void {
  setPhase("waking");
  startPolling();
}

export function beginFetching(): void {
  stopPolling();
  setPhase("fetching");
}

export function finishRun(): void {
  stopPolling();
  state.lastWallMs = state.startedAt === null ? null : Date.now() - state.startedAt;
  setPhase("done");
}

export function failRun(message: string): void {
  stopPolling();
  // The phase is captured before it is overwritten: "failed while uploading" and "failed while
  // inferring" send an operator to completely different places.
  state.failedIn = state.kind;
  state.message = message;
  state.lastWallMs = state.startedAt === null ? null : Date.now() - state.startedAt;
  setPhase("failed");
}

export function resetRun(): void {
  stopPolling();
  Object.assign(state, initial);
  emit();
}

/**
 * Fold one telemetry reading into the phase.
 *
 * Exported for the tests, which drive the machine through a whole run without a network.
 */
export function applyGpu(gpu: GpuSnapshot | null): void {
  state.gpu = gpu;
  if (state.kind !== "waking" && state.kind !== "loadingModel" && state.kind !== "inferring") {
    emit();
    return;
  }
  if (!gpu || !gpu.available) {
    // Nothing is answering. That is the definition of still waking.
    setPhase("waking");
    return;
  }
  if (!gpu.modelLoaded) {
    setPhase("loadingModel");
    return;
  }
  if (state.kind !== "inferring") {
    state.vramFloorBytes = gpu.currentBytes;
    setPhase("inferring");
    return;
  }
  emit();
}

let timer: number | null = null;

/**
 * Poll cadence. 250 ms is a local-mock rate and free. Against Cloud Run it would be four
 * requests a second on a service capped at one instance — pure autoscaler pressure for a bar
 * nobody reads that often — so a real service is sampled every 2 s.
 */
function pollInterval(): number {
  return getCloud().baseUrl === null ? 250 : 2000;
}

/** Injected, so tests drive the machine without a network and without importing the client. */
let readGpu: (() => Promise<GpuSnapshot>) | null = null;

export function setGpuReader(reader: (() => Promise<GpuSnapshot>) | null): void {
  readGpu = reader;
}

function startPolling(): void {
  if (timer !== null || !readGpu) return;
  const tick = async () => {
    if (!isRunActive() || !readGpu) return stopPolling();
    try {
      applyGpu(await readGpu());
    } catch {
      // A failed telemetry read is itself the observation: nothing is answering yet.
      applyGpu(null);
    }
    if (isRunActive()) timer = window.setTimeout(tick, pollInterval());
  };
  timer = window.setTimeout(tick, 0);
}

function stopPolling(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

/** Seconds elapsed in the current phase, or null when idle. */
export function phaseElapsedMs(s: RunPhaseState, now = Date.now()): number | null {
  return s.phaseStartedAt === null ? null : now - s.phaseStartedAt;
}

export function totalElapsedMs(s: RunPhaseState, now = Date.now()): number | null {
  return s.startedAt === null ? null : now - s.startedAt;
}
