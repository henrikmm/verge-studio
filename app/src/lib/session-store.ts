/**
 * Session state shared across panes: inference params, GPU telemetry, last run.
 *
 * Deliberately tiny — useSyncExternalStore over a mutable object. The node graph
 * (M2) will own param state per-node; this is the single-pipeline stand-in until then.
 */

import { useSyncExternalStore } from "react";
import { DEFAULT_PARAMS, type GpuSnapshot, type InferManifest, type InferParams } from "./contract";

export interface SessionState {
  params: InferParams;
  gpu: GpuSnapshot | null;
  lastRun: InferManifest | null;
  /** Duration of the clip the user picked, so the frame plan can be computed. */
  clipDurationS: number;
  status: string;
  error: string | null;
  running: boolean;
}

const state: SessionState = {
  params: { ...DEFAULT_PARAMS },
  gpu: null,
  lastRun: null,
  clipDurationS: 10,
  status: "fixture mode",
  error: null,
  running: false,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// useSyncExternalStore requires a stable snapshot reference between changes.
let snapshot: SessionState = { ...state };

function getSnapshot(): SessionState {
  return snapshot;
}

export function update(patch: Partial<SessionState>) {
  Object.assign(state, patch);
  snapshot = { ...state };
  emit();
}

export function setParam<K extends keyof InferParams>(key: K, value: InferParams[K]) {
  update({ params: { ...state.params, [key]: value } });
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getState(): SessionState {
  return state;
}
