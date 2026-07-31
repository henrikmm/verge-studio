export function GraphPane() {
  return (
    <div className="pane">
      <div className="pane-status">
        <span>0 nodes · 0 wires</span>
        <span className="hint">React Flow graph lands in M2</span>
      </div>
      <div className="pane-body">
        <div className="graph-grid">
          <span>FrameSource → DA3 Depth → PointCloud → Viewer</span>
        </div>
      </div>
    </div>
  );
}
