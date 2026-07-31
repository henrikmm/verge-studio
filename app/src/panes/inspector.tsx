import { useEffect, useState } from "react";

interface WorkerReport {
  model?: { key?: string; hf_repo_id?: string; hf_revision?: string };
  measurements?: Record<string, number>;
  frames?: unknown[];
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="inspector-row">
      <span className="k">{k}</span>
      <span className="v" title={v}>
        {v}
      </span>
    </div>
  );
}

export function Inspector() {
  const [report, setReport] = useState<WorkerReport>();

  useEffect(() => {
    fetch("/roadside/worker-report.json")
      .then((r) => (r.ok ? r.json() : undefined))
      .then(setReport)
      .catch(() => undefined);
  }, []);

  const m = report?.measurements ?? {};
  const gib = (b?: number) => (b ? `${(b / 1024 ** 3).toFixed(2)} GiB` : "—");
  const sec = (s?: number) => (s ? `${s.toFixed(2)} s` : "—");

  return (
    <div className="pane">
      <div className="pane-status">
        <span>fixture: roadside</span>
      </div>
      <div className="pane-body inspector">
        <div className="inspector-section">
          <h3>Module</h3>
          <Row k="Model" v={report?.model?.key ?? "da3_nested_giant_large_1_1"} />
          <Row k="Revision" v={(report?.model?.hf_revision ?? "b2359bdf").slice(0, 8)} />
          <Row k="License" v="CC-BY-NC-4.0" />
        </div>
        <div className="inspector-section">
          <h3>Run (recorded)</h3>
          <Row k="Frames" v={String(report?.frames?.length ?? 4)} />
          <Row k="Inference" v={sec(m.inference_seconds)} />
          <Row k="Peak VRAM" v={gib(m.peak_gpu_memory_bytes)} />
          <Row k="Wall" v={sec(m.total_wall_seconds)} />
        </div>
        <div className="inspector-section">
          <h3>Session</h3>
          <Row k="GPU" v="cold" />
          <Row k="Cost" v="$0.00" />
        </div>
      </div>
    </div>
  );
}
