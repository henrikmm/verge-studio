/**
 * Shared run listing, so the Runs pane, the Objects pane and the Run Source node all agree
 * about which runs exist without each polling the middleware on its own.
 */

import { useEffect, useSyncExternalStore } from "react";
import { fetchRuns, type RunRecord, type RunsListing } from "./runs";

interface RunsState {
  runs: readonly RunRecord[];
  root: string;
  loading: boolean;
  error: string | null;
  loadedAt: number;
}

const state: RunsState = { runs: [], root: "", loading: false, error: null, loadedAt: 0 };
let snapshot: RunsState = { ...state };
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

let inflight: Promise<void> | null = null;

export async function refreshRuns(): Promise<void> {
  if (inflight) return inflight;
  state.loading = true;
  state.error = null;
  emit();
  inflight = (async () => {
    try {
      const listing: RunsListing = await fetchRuns();
      state.runs = listing.runs;
      state.root = listing.root;
      state.loadedAt = Date.now();
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.loading = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/** The node's path: guarantees a listing exists, then resolves one run. */
export async function getRun(id: string): Promise<RunRecord | undefined> {
  if (snapshot.loadedAt === 0) await refreshRuns();
  return snapshot.runs.find((run) => run.id === id);
}

export function getRunsSnapshot(): RunsState {
  return snapshot;
}

export function useRuns(): RunsState {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    if (value.loadedAt === 0 && !value.loading) void refreshRuns();
  }, [value.loadedAt, value.loading]);
  return value;
}
