import { useEffect } from "react";
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import { Depth2D } from "./panes/depth-2d";
import { GraphPane } from "./panes/graph-pane";
import { Inspector } from "./panes/inspector";
import { ObjectsPane } from "./panes/objects";
import { Viewport3D } from "./panes/viewport-3d";
import { formatBytes, type InferManifest } from "./lib/contract";
import { useSession } from "./lib/session-store";
import { runAuto } from "./graph/graph-store";

const components = {
  "depth-2d": (_props: IDockviewPanelProps) => <Depth2D />,
  "viewport-3d": (_props: IDockviewPanelProps) => <Viewport3D />,
  graph: (_props: IDockviewPanelProps) => <GraphPane />,
  inspector: (_props: IDockviewPanelProps) => <Inspector />,
  objects: (_props: IDockviewPanelProps) => <ObjectsPane />,
};

function onReady(event: DockviewReadyEvent) {
  const api = event.api;
  api.addPanel({ id: "depth", component: "depth-2d", title: "Depth 2D" });
  api.addPanel({
    id: "viewport",
    component: "viewport-3d",
    title: "Viewport 3D",
    position: { referencePanel: "depth", direction: "right" },
  });
  const graph = api.addPanel({
    id: "graph",
    component: "graph",
    title: "Graph",
    position: { direction: "below" },
  });
  const inspector = api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { direction: "right" },
  });
  api.addPanel({
    id: "objects",
    component: "objects",
    title: "Objects",
    position: { referencePanel: "inspector" },
  });
  graph.api.setSize({ height: Math.round(window.innerHeight * 0.38) });
  inspector.api.setSize({ width: 280 });
  api.getPanel("viewport")?.api.setActive();
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

  return (
    <div className="app-shell">
      <div className="app-dock">
        <DockviewReact className="dockview-theme-dark" components={components} onReady={onReady} />
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
        <span className="cost" title={COST_NOTE}>{costLabel(lastRun)}</span>
      </div>
    </div>
  );
}
