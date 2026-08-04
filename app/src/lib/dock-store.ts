/**
 * Pane visibility, focus and layout persistence.
 *
 * Two verbs, because Dockview gives us two genuinely different mechanisms and collapsing
 * them into one control would mean paying the expensive one's cost every time:
 *
 * - FOCUS is `panel.api.maximize()`. Internally that is `hideAllViewsBut`, which flips grid
 *   child visibility — the other panes yield their space but stay MOUNTED. No WebGL teardown,
 *   no re-uploading a million points. It also round-trips through toJSON/fromJSON, so it
 *   composes with the layout we persist below. This is the cheap, everyday verb.
 *
 * - HIDE is `panel.api.close()`, which unmounts. Dockview deliberately omits `setVisible`
 *   from `DockviewPanelApi` (see its `Omit<GridviewPanelApi, 'setVisible'>` declaration), so
 *   there is no supported way to hide one pane while others stay visible without destroying
 *   it. Reaching into the private gridview would work today and break on the next upgrade.
 *   Panel state survives regardless — masks live in the measurement store and node outputs in
 *   the graph runtime, never in component state — but the work to rebuild is real.
 *
 * Dockview already reflows the survivors on close. What it has no opinion about is getting a
 * pane back, which is what the view bar and this store are for.
 */

import { useSyncExternalStore } from "react";
import type { AddPanelPositionOptions, DockviewApi } from "dockview";

type PaneDirection = "left" | "right" | "above" | "below" | "within";

export interface PaneDef {
  id: string;
  component: string;
  title: string;
  /**
   * Where the pane goes when first created or restored after a hide, most-preferred first.
   * Anchors naming an absent panel are skipped, so restoring into a half-dismantled layout
   * degrades to "somewhere sensible" instead of throwing.
   */
  anchors: PaneAnchor[];
}

export interface PaneAnchor {
  referencePanel?: string;
  direction?: PaneDirection;
}

/**
 * Dockview's position option is a union — `referencePanel` and a bare `direction` are
 * different shapes, and `within` is only legal with a reference. Narrowing here keeps the
 * anchor table above readable as data.
 */
function positionFor(anchor: PaneAnchor | undefined): AddPanelPositionOptions | undefined {
  if (!anchor) return undefined;
  if (anchor.referencePanel) {
    return anchor.direction
      ? { referencePanel: anchor.referencePanel, direction: anchor.direction }
      : { referencePanel: anchor.referencePanel };
  }
  if (anchor.direction && anchor.direction !== "within") return { direction: anchor.direction };
  return undefined;
}

/**
 * Inspector and Objects share one group on purpose — they are companion panels, and the
 * Sentinel reference groups many tabs per view. Note the consequence: `maximize()` is
 * group-level, so focusing either one focuses the pair with that tab active.
 */
export const PANES: readonly PaneDef[] = [
  { id: "depth", component: "depth-2d", title: "Depth 2D", anchors: [{}] },
  {
    id: "viewport",
    component: "viewport-3d",
    title: "Viewport 3D",
    anchors: [{ referencePanel: "depth", direction: "right" }, { direction: "right" }],
  },
  { id: "graph", component: "graph", title: "Graph", anchors: [{ direction: "below" }] },
  { id: "inspector", component: "inspector", title: "Inspector", anchors: [{ direction: "right" }] },
  {
    id: "objects",
    component: "objects",
    title: "Objects",
    anchors: [{ referencePanel: "inspector", direction: "within" }, { direction: "right" }],
  },
  {
    id: "runs",
    component: "runs",
    title: "Runs",
    anchors: [{ referencePanel: "inspector", direction: "within" }, { direction: "right" }],
  },
] as const;

const PANE_BY_ID = new Map(PANES.map((pane) => [pane.id, pane]));

/** Versioned: a layout referring to components this build no longer has must not be restored. */
const LAYOUT_KEY = "verge.dock-layout/2";

export interface DockState {
  /** Panel ids currently mounted in the dock. */
  visible: readonly string[];
  /** Id of the focused (maximized) panel, or null. */
  focusedId: string | null;
  ready: boolean;
}

const state: DockState = { visible: [], focusedId: null, ready: false };
let snapshot: DockState = { ...state };
let api: DockviewApi | null = null;
let saveTimer: number | undefined;
/** Suppresses layout saves while we are the ones rebuilding the layout. */
let rebuilding = false;

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

function sync(): void {
  if (!api) return;
  state.visible = api.panels.map((panel) => panel.id);
  const maximized = api.panels.find((panel) => panel.api.isMaximized());
  state.focusedId = maximized?.id ?? null;
  emit();
}

function saveLayout(): void {
  if (!api || rebuilding) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(api?.toJSON()));
    } catch {
      // A full or disabled localStorage must never take the app down with it.
    }
  }, 250);
}

function resolveAnchor(pane: PaneDef): PaneAnchor | undefined {
  if (!api) return undefined;
  for (const anchor of pane.anchors) {
    if (anchor.referencePanel && !api.getPanel(anchor.referencePanel)) continue;
    return anchor;
  }
  return undefined;
}

function addPane(pane: PaneDef): void {
  if (!api || api.getPanel(pane.id)) return;
  const position = positionFor(resolveAnchor(pane));
  api.addPanel({
    id: pane.id,
    component: pane.component,
    title: pane.title,
    ...(position ? { position } : {}),
  });
}

function buildDefaultLayout(): void {
  if (!api) return;
  rebuilding = true;
  api.clear();
  for (const pane of PANES) addPane(pane);
  api.getPanel("graph")?.api.setSize({ height: Math.round(window.innerHeight * 0.38) });
  api.getPanel("inspector")?.api.setSize({ width: 280 });
  api.getPanel("viewport")?.api.setActive();
  rebuilding = false;
  saveLayout();
}

/**
 * Called once from the Dockview `onReady` handler. Restores the saved layout when it is
 * still coherent with this build, and rebuilds the default when it is not — a stale layout
 * naming a component we removed would otherwise throw on every boot with no way out.
 */
export function registerDock(next: DockviewApi, host: HTMLElement): void {
  api = next;

  /**
   * `fromJSON` restores the grid at the pixel dimensions it was SAVED at, and the
   * auto-resize observer only reacts to later changes — so a layout saved in a 1280×800
   * window stays 1280 wide in a 1400×850 one. Measured: the dock reported 1400×825 while
   * its groups still summed to 1280×695, which starved every pane inside it (and is what
   * left React Flow measuring a 500×55 box). Re-laying out against the real container after
   * any restore is what keeps the grid honest.
   */
  const relayout = () => {
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      next.layout(host.clientWidth, host.clientHeight);
    }
  };

  let restored = false;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      rebuilding = true;
      next.fromJSON(JSON.parse(raw));
      rebuilding = false;
      // A layout with no panels at all is a corrupt save, not a deliberate empty dock.
      restored = next.panels.length > 0;
      if (restored) relayout();
    }
  } catch {
    restored = false;
  } finally {
    rebuilding = false;
  }

  if (!restored) buildDefaultLayout();

  // Belt and braces: the grid can never be left describing a container size that is gone.
  const observer = new ResizeObserver(relayout);
  observer.observe(host);

  next.onDidLayoutChange(() => {
    sync();
    saveLayout();
  });
  next.onDidAddPanel(sync);
  next.onDidRemovePanel(sync);
  next.onDidMaximizedGroupChange(sync);

  state.ready = true;
  sync();
}

export function isPaneVisible(id: string): boolean {
  return snapshot.visible.includes(id);
}

export function showPane(id: string): void {
  const pane = PANE_BY_ID.get(id);
  if (!api || !pane || api.getPanel(id)) return;
  // Restoring into a focused layout would put the pane somewhere invisible.
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  addPane(pane);
  api.getPanel(id)?.api.setActive();
  sync();
}

export function hidePane(id: string): void {
  const panel = api?.getPanel(id);
  if (!panel) return;
  panel.api.close();
  sync();
}

export function togglePane(id: string): void {
  if (isPaneVisible(id)) hidePane(id);
  else showPane(id);
}

/** Focus = maximize. Non-destructive: every other pane stays mounted behind it. */
export function focusPane(id: string): void {
  const panel = api?.getPanel(id);
  if (!panel) return;
  panel.api.maximize();
  sync();
}

export function exitFocus(): void {
  if (api?.hasMaximizedGroup()) api.exitMaximizedGroup();
  sync();
}

export function toggleFocus(id: string): void {
  if (snapshot.focusedId === id) exitFocus();
  else focusPane(id);
}

export function resetLayout(): void {
  try {
    window.localStorage.removeItem(LAYOUT_KEY);
  } catch {
    // Ignored: the rebuild below is what the user actually asked for.
  }
  buildDefaultLayout();
  sync();
}

export function useDock(): DockState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
