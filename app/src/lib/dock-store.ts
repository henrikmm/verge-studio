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
  /**
   * Not in the default layout since 2026-08-09 — see `DEFAULT_PANES`. Still a pane in every other
   * sense: the view bar opens it, it comes back where it always was, and its wiring is untouched
   * while it is closed because node outputs live in the graph runtime rather than in the pane.
   */
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

/**
 * What a fresh app opens with — everything except the Graph.
 *
 * The Graph took 38% of the window by default and spent it on a pane that only earns the space
 * when you are rewiring the pipeline or explaining how it works. Meanwhile Depth 2D and Viewport
 * 3D, which are worth looking at continuously, were squeezed into the top half. It was also the
 * only way to load a video, which made a configuration surface into the front door; the
 * Inspector's Clip section is that now.
 *
 * Closed, not removed. One click on the view bar brings it back, with its wiring intact.
 */
const DEFAULT_PANES: readonly PaneDef[] = PANES.filter((pane) => pane.id !== "graph");

/**
 * Versioned: a layout referring to components this build no longer has must not be restored.
 *
 * Bumped 3 → 4 on 2026-08-09 with the Graph leaving the default arrangement, and 4 → 5 the same
 * day for the 40/40/20 split below. A version bump is how a new default reaches anybody who has
 * already used the app — without it, every existing profile would restore the old layout and the
 * change would only be visible on a fresh machine.
 */
const LAYOUT_KEY = "verge.dock-layout/5";

/**
 * The window is split 40% Depth 2D, 40% Viewport 3D, 20% for the Inspector group.
 *
 * The two panes you look at are equals, so they get equal width; the panel you read gets what is
 * left. What was written here before asked for a 300 px Inspector and never got it, because the
 * layout was built before the dock knew how wide it was: the sizes went to disk as `size: 100`
 * each against a container of width 0, and Dockview restored that as three equal thirds. So the
 * share is applied only once the host reports a real width — see `applyDefaultSplit`.
 */
const SIDE_PANEL_SHARE = 0.2;

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
/** A default layout is waiting for the host to report a width it can be split by. */
let splitPending = false;

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

/**
 * Persist the layout — but never the focused state.
 *
 * Focus is a transient view mode; the arrangement is the preference. Two reasons to strip
 * `maximizedNode` on the way out:
 *
 * 1. Restoring into a focused pane is wrong on its own terms — the app opens with one pane
 *    filling the window and no visible way back except a key you have to know.
 * 2. It measurably corrupts the grid. `fromJSON` restores the maximized node with its siblings
 *    hidden, and the `layout()` call that follows redistributes space among the VISIBLE views
 *    only; un-maximizing then returns the hidden ones at whatever share they were left with.
 *    Measured: a 853/427 split came back as 640/640 after focus → reload → restore.
 */
function saveLayout(): void {
  if (!api || rebuilding) return;
  // While a group is maximized its siblings are sized to nothing, and that is what gets
  // serialized — measured: an 853/427 split came back as 640/640 after focus → reload.
  // The arrangement underneath a focused pane is not a layout anyone chose, so it is not
  // saved. Exiting focus fires another layout change, which saves the real one.
  if (api.hasMaximizedGroup()) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const json = api?.toJSON();
      // Belt and braces: focus is a transient view mode, never a restored preference. Opening
      // the app with one pane filling the window and no visible way back is not a good default.
      if (json?.grid) delete (json.grid as { maximizedNode?: unknown }).maximizedNode;
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(json));
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

/**
 * Give the three columns their shares of the window. Returns false when the host has no width
 * yet, so the caller knows the split still has to happen.
 *
 * Order matters, because `setSize` takes what it needs from the columns to its RIGHT rather than
 * from everybody. Sizing the Inspector first only got it 13.4% of 1280 px — Depth 2D was set
 * after it and helped itself to 85 of its pixels. So the two viewers are set first, in order,
 * and the Inspector is whatever is left.
 */
function applyDefaultSplit(): boolean {
  if (!api) return false;
  // The GRID's width, not the host element's. The host is sized by CSS straight away while the
  // grid only learns its size from `layout()`, and a share of a grid that still believes it is
  // 0 wide is normalised back to equal columns without complaint.
  const width = api.width;
  if (width <= 0) return false;
  const viewer = Math.round((width * (1 - SIDE_PANEL_SHARE)) / 2);
  api.getPanel("depth")?.api.setSize({ width: viewer });
  api.getPanel("viewport")?.api.setSize({ width: viewer });
  return true;
}

function buildDefaultLayout(): void {
  if (!api) return;
  rebuilding = true;
  api.clear();
  for (const pane of DEFAULT_PANES) addPane(pane);
  splitPending = !applyDefaultSplit();
  // Inspector, not whichever tab was added last. Runs is added after it and would otherwise
  // win the group by accident, which is not a default anyone chose.
  api.getPanel("inspector")?.api.setActive();
  api.getPanel("viewport")?.api.setActive();
  rebuilding = false;
  saveLayout();
}

/**
 * Called once from the Dockview `onReady` handler. Restores the saved layout when it is
 * still coherent with this build, and rebuilds the default when it is not — a stale layout
 * naming a component we removed would otherwise throw on every boot with no way out.
 */
export function registerDock(next: DockviewApi, element: HTMLElement): void {
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
    if (element.clientWidth > 0 && element.clientHeight > 0) {
      next.layout(element.clientWidth, element.clientHeight);
      // The first honest width is also the first chance to split a default layout by it.
      if (splitPending && applyDefaultSplit()) {
        splitPending = false;
        saveLayout();
      }
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

  // Size the grid before building into it, so the split below has a real width to divide.
  if (!restored) {
    relayout();
    buildDefaultLayout();
  }

  // Belt and braces: the grid can never be left describing a container size that is gone.
  const observer = new ResizeObserver(relayout);
  observer.observe(element);

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
