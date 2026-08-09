/**
 * How much of itself the app shows.
 *
 * Two modes, one switch, read by every pane. **Standard** is the app doing its job: look at the
 * reconstruction, mark a thing, read what it measures and how wrong it is. **Advanced** adds the
 * controls and readouts that only earn their space while debugging a fit — layer overlays, cloud
 * rebuild parameters, the trial ledger, cloud plumbing.
 *
 * This exists because the panes grew past the point of being usable. Viewport 3D reached six
 * control rows and nineteen buttons, every one of which was worth adding on the day it was added.
 * A mode is the only structure that lets both facts stay true: the controls keep existing, and
 * they stop taxing the person who is not using them.
 *
 * ## The rule that makes it safe
 *
 * **Advanced is a strict superset.** Standard may hide a control; it may never be the only place
 * a control exists, and it may never leave one of Advanced's effects switched on with its switch
 * removed — that would be a state with no way out. Panes that own such an effect reset it when
 * Standard is entered; `viewport-3d.tsx` clears its layer set for exactly this reason.
 *
 * **A live warning is not an explanation.** Anything describing the state the app is in right now
 * — a capped frame plan, an extrapolated VRAM figure, a mock-backed readout, an instance that is
 * still billing — stays on screen in both modes. Those are DESIGN.md's honesty rules, and a mode
 * switch is not permission to break them. What Standard hides is explanation of the feature, and
 * that lives behind a `?` (see `panes/help.tsx`), never nowhere.
 */

import { useSyncExternalStore } from "react";

export type UiMode = "standard" | "advanced";

/** Versioned with the same reasoning as the dock layout: a stored value this build cannot read
 *  must fall back to the default rather than wedge the app. */
const STORAGE_KEY = "verge.ui-mode/1";

function load(): UiMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "advanced" ? "advanced" : "standard";
  } catch {
    // A disabled or full localStorage must never take the app down with it.
    return "standard";
  }
}

let mode: UiMode = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UiMode {
  return mode;
}

export function getUiMode(): UiMode {
  return mode;
}

export function setUiMode(next: UiMode): void {
  if (next === mode) return;
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The switch still works for this session; only the memory of it is lost.
  }
  for (const listener of listeners) listener();
}

export function useUiMode(): UiMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Sugar for the common test, so panes read as prose: `if (advanced) …`. */
export function useAdvanced(): boolean {
  return useUiMode() === "advanced";
}
