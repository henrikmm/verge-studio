/**
 * Whether the fixture-backed mock may stand in for a GPU.
 *
 * The mock has two jobs and only one of them is legitimate.
 *
 * **As a development fixture it is essential.** It answers the real `/infer` contract offline, at
 * zero cost, which is how the whole interface gets built and design-reviewed without deploying an
 * L4. Every pane in this app was made against it. Deleting it would mean a GPU for every button.
 *
 * **As a run target it is a trap.** It returns the roadside fixture whatever you send it, so a
 * "run" produces geometry belonging to a different scene while wearing the new clip's frames.
 * That is not hypothetical: on 2026-08-05 exactly that was mistaken for a real run on a new video,
 * and hours went into diagnosing a pipeline that was working. Nothing about it is evidence, and
 * anything worth looking at again is a saved run in the Runs pane.
 *
 * So the second job is off by default as of 2026-08-11. With no service deployed, Run is disabled
 * and says so rather than quietly producing a fixture. Turning this on is a deliberate act, it
 * lives in Advanced beside the other rehearsal switch, and it never persists a run.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "verge.dev.mock-target/1";

function load(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // A disabled or full localStorage must never take the app down with it.
    return false;
  }
}

let allowed: boolean = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mockTargetAllowed(): boolean {
  return allowed;
}

export function setMockTargetAllowed(next: boolean): void {
  if (next === allowed) return;
  allowed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // The switch still works for this session; only the memory of it is lost.
  }
  for (const listener of listeners) listener();
}

export function useMockTargetAllowed(): boolean {
  return useSyncExternalStore(subscribe, () => allowed, () => allowed);
}
