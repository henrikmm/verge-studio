import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import { Depth2D } from "./panes/depth-2d";
import { GraphPane } from "./panes/graph-pane";
import { Inspector } from "./panes/inspector";
import { Viewport3D } from "./panes/viewport-3d";

const components = {
  "depth-2d": (_props: IDockviewPanelProps) => <Depth2D />,
  "viewport-3d": (_props: IDockviewPanelProps) => <Viewport3D />,
  graph: (_props: IDockviewPanelProps) => <GraphPane />,
  inspector: (_props: IDockviewPanelProps) => <Inspector />,
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
  graph.api.setSize({ height: Math.round(window.innerHeight * 0.38) });
  inspector.api.setSize({ width: 280 });
  api.getPanel("viewport")?.api.setActive();
}

export function App() {
  return (
    <div className="app-shell">
      <div className="app-dock">
        <DockviewReact className="dockview-theme-dark" components={components} onReady={onReady} />
      </div>
      <div className="status-bar">
        <span className="chip">
          <span className="dot" /> GPU: cold
        </span>
        <span className="chip">fixture mode</span>
        <span className="cost">$0.00</span>
      </div>
    </div>
  );
}
