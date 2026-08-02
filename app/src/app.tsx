import { useEffect } from "react";
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import { Depth2D } from "./panes/depth-2d";
import { GraphPane } from "./panes/graph-pane";
import { Inspector } from "./panes/inspector";
import { ObjectsPane } from "./panes/objects";
import { Viewport3D } from "./panes/viewport-3d";
import { formatBytes } from "./lib/contract";
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
        <span className="cost">$0.00</span>
      </div>
    </div>
  );
}
