import { useEffect, useState } from "react";
import {
  estimateVramRange,
  FPS_MAX,
  FPS_MIN,
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  planFrames,
  type RefViewStrategy,
} from "../lib/contract";
import { getGpu, infer, shutdown, warmup } from "../lib/infer-client";
import { setParam, update, useSession } from "../lib/session-store";

function Row({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="inspector-row">
      <span className="k">{k}</span>
      <span className="v" title={title ?? v}>
        {v}
      </span>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inspector-row control">
      <span className="k">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="v num">
        {value}
        {suffix}
      </span>
    </div>
  );
}

/** Fraction of the 24 GiB L4 budget, drawn as a bar that turns amber then red. */
function VramBar({ used, total, label }: { used: number; total: number; label: string }) {
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  const tone =
    fraction > 0.92 ? "var(--accent-err)" : fraction > 0.75 ? "var(--accent-busy)" : "var(--accent-run)";
  return (
    <div className="vram">
      <div className="vram-head">
        <span className="k">{label}</span>
        <span className="v num">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="vram-track">
        <div className="vram-fill" style={{ width: `${fraction * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

export function Inspector() {
  const session = useSession();
  const { params, gpu, lastRun, clipDurationS } = session;
  const [busy, setBusy] = useState(false);

  // Poll GPU telemetry. Fast while a run is in flight so the VRAM bar actually
  // moves; slow when idle so a warm cloud instance isn't kept busy for nothing.
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      try {
        const snapshot = await getGpu();
        if (!cancelled) update({ gpu: snapshot });
      } catch {
        if (!cancelled) update({ gpu: null });
      }
      if (!cancelled) timer = window.setTimeout(tick, session.running ? 250 : 4000);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session.running]);

  const plan = planFrames(params.fps, clipDurationS, params.maxFrames);
  const vramRange = estimateVramRange(plan.count, params.processRes);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    update({ error: null });
    try {
      await fn();
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runInference = () =>
    act(async () => {
      update({ running: true, status: "inferring…" });
      try {
        const manifest = await infer({ frameCount: plan.count }, params);
        update({ lastRun: manifest, status: `run ${manifest.runId}` });
      } finally {
        update({ running: false });
      }
    });

  return (
    <div className="pane">
      <div className="pane-status">
        <span className={gpu?.available ? "ok" : ""}>{gpu?.deviceName ?? "no GPU"}</span>
        <span className="hint">{session.status}</span>
      </div>
      <div className="pane-body inspector">
        <div className="inspector-section">
          <h3>Inference</h3>
          <SliderRow
            label="Sampling FPS"
            value={params.fps}
            min={FPS_MIN}
            max={FPS_MAX}
            onChange={(v) => setParam("fps", v)}
            suffix=""
          />
          <SliderRow
            label="Clip length"
            value={clipDurationS}
            min={1}
            max={60}
            suffix="s"
            onChange={(v) => update({ clipDurationS: v })}
          />
          <SliderRow
            label="Process res"
            value={params.processRes}
            min={252}
            max={1024}
            step={14}
            onChange={(v) => setParam("processRes", v)}
          />
          <SliderRow
            label="Max frames"
            value={params.maxFrames}
            min={2}
            max={64}
            onChange={(v) => setParam("maxFrames", v)}
          />
          <div className="inspector-row control">
            <span className="k">Ref view</span>
            <select
              value={params.refViewStrategy}
              onChange={(e) => setParam("refViewStrategy", e.target.value as RefViewStrategy)}
            >
              <option value="middle">middle</option>
              <option value="saddle_balanced">saddle_balanced</option>
              <option value="saddle_sim_range">saddle_sim_range</option>
              <option value="first">first</option>
            </select>
          </div>
          <div className="inspector-row control">
            <span className="k">Splats (infer_gs)</span>
            <input
              type="checkbox"
              checked={params.inferGs}
              onChange={(e) => setParam("inferGs", e.target.checked)}
            />
            <span className="v num">{params.inferGs ? "on" : "off"}</span>
          </div>
        </div>

        <div className="inspector-section">
          <h3>Frame plan</h3>
          <Row k="Frames" v={`${plan.count}`} />
          <Row k="Effective FPS" v={plan.effectiveFps.toFixed(2)} />
          <Row
            k="VRAM (unmeasured)"
            v={`${formatBytes(vramRange.lowBytes)} – ${formatBytes(vramRange.highBytes)}`}
            title="Bracketed from a single datapoint; run scripts/vram-sweep.sh to replace with measurements"
          />
          {vramRange.highBytes > L4_TOTAL_VRAM_BYTES && (
            <div className="inspector-note">
              Upper bracket exceeds the L4's 24 GiB, so this setting may OOM. We only have
              one real datapoint — the range is this wide because nothing has been measured
              yet, not because the run is known to be unsafe.
            </div>
          )}
          {plan.capped && (
            <div className="inspector-note">
              {params.fps} fps × {clipDurationS}s = {Math.floor(params.fps * clipDurationS)} frames,
              over the {params.maxFrames}-frame cap. FPS lowered to{" "}
              {plan.effectiveFps.toFixed(2)} so the frames still span the whole clip.
            </div>
          )}
        </div>

        <div className="inspector-section">
          <h3>GPU</h3>
          {gpu ? (
            <>
              <VramBar
                used={gpu.busy ? gpu.currentBytes : gpu.peakBytes}
                total={gpu.totalBytes}
                label={gpu.busy ? "VRAM live" : "VRAM peak"}
              />
              <Row k="State" v={gpu.busy ? "busy" : gpu.modelLoaded ? "warm" : "cold"} />
            </>
          ) : (
            <Row k="State" v="unreachable" />
          )}
          <div className="inspector-actions">
            <button disabled={busy} onClick={() => act(async () => void (await warmup()))}>
              Warm up
            </button>
            <button disabled={busy || session.running} onClick={runInference}>
              Run
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => act(async () => void (await shutdown()))}
            >
              Release
            </button>
          </div>
        </div>

        <div className="inspector-section">
          <h3>Last run</h3>
          {lastRun ? (
            <>
              <Row k="Frames" v={`${lastRun.frames.count}`} />
              <Row k="GPU time" v={`${lastRun.timing.gpuSeconds.toFixed(2)} s`} />
              <Row k="Wall" v={`${lastRun.timing.wallSeconds.toFixed(2)} s`} />
              <Row k="Peak VRAM" v={formatBytes(lastRun.vram.peakBytes)} />
              <Row k="Model" v={lastRun.modelRevision.slice(0, 8)} />
            </>
          ) : (
            <Row k="—" v="no run yet" />
          )}
        </div>

        {session.error && <div className="inspector-note error">{session.error}</div>}
      </div>
    </div>
  );
}
