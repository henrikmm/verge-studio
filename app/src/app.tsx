import { useEffect } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { Depth2D } from "./panes/depth-2d";
import { GraphPane } from "./panes/graph-pane";
import { Inspector } from "./panes/inspector";
import { ObjectsPane } from "./panes/objects";
import { Viewport3D } from "./panes/viewport-3d";
import { formatBytes, type InferManifest } from "./lib/contract";
import {
  PANES,
  exitFocus,
  hidePane,
  registerDock,
  resetLayout,
  toggleFocus,
  togglePane,
  useDock,
} from "./lib/dock-store";
import { useSession } from "./lib/session-store";
import { runAuto } from "./graph/graph-store";

const components = {
  "depth-2d": (_props: IDockviewPanelProps) => <Depth2D />,
  "viewport-3d": (_props: IDockviewPanelProps) => <Viewport3D />,
  graph: (_props: IDockviewPanelProps) => <GraphPane />,
  inspector: (_props: IDockviewPanelProps) => <Inspector />,
  objects: (_props: IDockviewPanelProps) => <ObjectsPane />,
};

/**
 * Custom tab, so every pane carries both verbs — including Graph, Inspector and Objects,
 * which have no control row. It cannot live in `.pane-status`: that row is nowrap +
 * overflow:hidden and silently eats controls on its right edge in a narrow pane.
 *
 * Double-click toggles focus, matching the convention every tiling editor already uses.
 */
function PaneTab(props: IDockviewPanelHeaderProps) {
  const id = props.api.id;
  const dock = useDock();
  return (
    <div
      className={`pane-tab${dock.focusedId === id ? " focused" : ""}`}
      onDoubleClick={() => toggleFocus(id)}
      title="Double-click to focus this pane"
    >
      <span className="pane-tab-title">{props.api.title ?? id}</span>
      <button
        className="pane-tab-hide"
        title="Hide this pane; the rest take its space. Reopen it from the view bar."
        onClick={(event) => {
          event.stopPropagation();
          hidePane(id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Layout construction, restoration and persistence all live in the dock store — the panes
 * are data there, so adding one does not mean editing this file and a hidden pane has a
 * described place to come back to.
 */
function onReady(event: DockviewReadyEvent) {
  const host = document.querySelector<HTMLElement>(".app-dock");
  if (host) registerDock(event.api, host);
}

/**
 * The view bar. A hidden pane is unmounted, so without this row it is unreachable short of
 * a reload — which is what closing a tab used to mean.
 */
function ViewBar() {
  const dock = useDock();
  return (
    <span className="view-bar">
      {PANES.map((pane) => {
        const visible = dock.visible.includes(pane.id);
        const focused = dock.focusedId === pane.id;
        return (
          <button
            key={pane.id}
            className={`chip-toggle${visible ? " on" : ""}${focused ? " focused" : ""}`}
            title={
              visible
                ? `Hide ${pane.title} — the others take its space. Reopening remounts it.`
                : `Show ${pane.title}`
            }
            onClick={() => togglePane(pane.id)}
          >
            {pane.title}
          </button>
        );
      })}
      <button className="chip-toggle" title="Rebuild the default arrangement" onClick={resetLayout}>
        Reset
      </button>
    </span>
  );
}

/**
 * The status bar's cost slot.
 *
 * It read a hardcoded `$0.00` from M0 until 2026-08-04. That was defensible while no cloud
 * session had ever run; after three warm sessions it was a fabricated number on screen. There is
 * still nothing local that knows what anything cost — Cloud Run bills the whole instance
 * lifetime, cold start and idle tail included, and the app never sees a bill. So the slot states
 * what it actually knows and no more. Real per-session accounting is an M4 item.
 */
const COST_NOTE =
  "Cloud Run bills the instance lifetime, not inference seconds — cold start and idle tail included. The app has no billing data, so it reports none.";

function costLabel(lastRun: InferManifest | null): string {
  if (!lastRun) return "cloud: none";
  return lastRun.mock ? "cloud: fixture" : "cloud: 1 run · billing not instrumented";
}

let initialFixtureStarted = false;

export function App() {
  const { gpu, lastRun, running } = useSession();

  const gpuState = !gpu?.available
    ? "cold"
    : running || gpu.busy
      ? "busy"
      : gpu.modelLoaded
        ? "warm"
      : "cold";

  useEffect(() => {
    if (initialFixtureStarted) return;
    initialFixtureStarted = true;
    void runAuto();
  }, []);

  // Escape leaves a focused pane. Focus hides the rest of the app, so it needs an exit
  // that does not require finding the control that started it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <div className="app-dock">
        <DockviewReact
          className="dockview-theme-dark"
          components={components}
          defaultTabComponent={PaneTab}
          onReady={onReady}
        />
      </div>
      <div className="status-bar">
        <span className={`chip ${gpuState}`}>
          <span className="dot" /> GPU: {gpuState}
        </span>
        {gpu?.available && (
          <span className="chip">
            VRAM {formatBytes(gpu.busy ? gpu.currentBytes : gpu.peakBytes)} /{" "}
            {formatBytes(gpu.totalBytes)}
          </span>
        )}
        {lastRun && (
          <span className="chip">
            {lastRun.frames.count}f · {lastRun.timing.gpuSeconds.toFixed(1)}s GPU
          </span>
        )}
        <ViewBar />
        <span className="cost" title={COST_NOTE}>{costLabel(lastRun)}</span>
      </div>
    </div>
  );
}
