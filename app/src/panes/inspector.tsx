/**
 * Inspector — where a session starts, and where a selected node's parameters appear.
 *
 * Two jobs, and the first one is new. Until 2026-08-09 the only way to load a video was to drop it
 * on a node card in the Graph pane — a pane that opened taking 38% of the window, whose default
 * view filtered that very card out, and that earns its space only when you are rewiring the
 * pipeline or explaining it. The Graph is no longer in the default layout, so the **Clip** section
 * below is the front door: drop a file, see what it will cost in frames and VRAM, run it.
 *
 * It is a second VIEW of `frame-source`, not a second copy of its state — both write the node
 * through `lib/load-clip.ts`, so the node card keeps working and the two can never disagree.
 *
 * The rest is unchanged: rows are generated from the selected node's `controls` schema, so a new
 * node type brings its own inspector with it, and the GPU and Last-run sections stay global
 * because they describe the machine rather than the node.
 *
 * ## What Standard hides here, and what it may not
 *
 * Cloud control, Cloud session and GPU are Advanced: they are the plumbing, and a first-time
 * screen full of registry tags and service URLs says nothing about measuring anything. The
 * exception is money. An instance that has been woken keeps billing whether or not anybody is
 * looking at this pane, so the billing meter and the idle warning render in **both** modes —
 * DESIGN.md's rule that a mode switch may hide an explanation and never a live warning.
 */

import { useEffect, useRef, useState } from "react";
import {
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  MAX_MEASURED_FRAMES,
  planFrames,
  predictVram,
  type InferManifest,
} from "../lib/contract";
import {
  COST_BASIS,
  connectCloud,
  connectProxied,
  disconnectCloud,
  formatElapsed,
  markServiceDeleted,
  setCloudError,
  setCloudState,
  useCloud,
} from "../lib/cloud-store";
import {
  PROXY_BASE,
  fetchCloudStatus,
  runningJob,
  startDeploy,
  streamJob,
  type CloudStatus,
  type JobView,
} from "../lib/cloud-control";
import {
  ENV_INFER_BASE,
  ENV_INFER_TOKEN,
  deleteService,
  getGpu,
  releaseModel,
  warmup,
} from "../lib/infer-client";
import { update, useSession } from "../lib/session-store";
import { useAdvanced } from "../lib/ui-mode";
import { FRAME_SOURCE_ID, loadClip } from "../lib/load-clip";
import { HelpDot } from "./help";
import {
  isNodeStale,
  nodeById,
  runNode,
  setNodeAuto,
  setNodeParamAndRun,
  useGraph,
} from "../graph/graph-store";
import { REGISTRY } from "../graph/nodes";
import type { ControlSpec } from "../graph/types";
import type { DepthFieldValue } from "../measurement/depth-field";

/** How long an idle instance may sit before the pane says so. Cloud Run bills its whole
 *  lifetime, so ten quiet minutes cost the same as ten busy ones. */
const IDLE_WARN_MINUTES = 10;

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

/**
 * Fraction of the measured L4 budget. Neutral while there is headroom, amber past 75%,
 * red past 92% — the two thresholds that matter are the only ones that take a hue.
 */
function VramBar({ used, total, label }: { used: number; total: number; label: string }) {
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  const tone =
    fraction > 0.92
      ? "var(--accent-err)"
      : fraction > 0.75
        ? "var(--accent-busy)"
        : "var(--emph)";
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

function Control({
  spec,
  value,
  onChange,
}: {
  spec: ControlSpec;
  value: unknown;
  onChange: (v: string | number | boolean) => void;
}) {
  if (spec.kind === "readout") {
    const text =
      typeof value === "number" ? value.toFixed(2) : String(value || "").split("/").pop() || "—";
    return <Row k={spec.label} v={text} title={String(value ?? "")} />;
  }

  if (spec.kind === "select") {
    return (
      <div className="inspector-row control">
        <span className="k">{spec.label}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.kind === "checkbox") {
    return (
      <div className="inspector-row control">
        <span className="k">{spec.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="v num">{value ? "on" : "off"}</span>
      </div>
    );
  }

  return (
    <div className="inspector-row control">
      <span className="k">{spec.label}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        value={Number(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="v num">
        {Number(value)}
        {spec.suffix ?? ""}
      </span>
    </div>
  );
}

/**
 * The front door: choose a clip, see what it will cost, run it.
 *
 * Drop and Browse both go through `loadClip`, which writes `frame-source` — the same node the
 * Graph's card writes. Running DA3 is deliberately a separate, explicit press: loading a clip is
 * free and the forward pass is the one paid step in this project, so the two must never be one
 * button. `runNode` is used rather than `runAuto` for the same reason.
 */
function ClipSection({
  clipName,
  durationS,
  fps,
  maxFrames,
  running,
}: {
  clipName: string;
  durationS: number;
  fps: number;
  maxFrames: number;
  running: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      await loadClip(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setDropping(false);
    }
  };

  return (
    <div className="inspector-section">
      <h3>
        Clip
        <HelpDot label="What happens to a clip you load">
          <p>
            The file is copied to a temporary directory so ffmpeg has a real path — browsers never
            expose one — and frames are sampled evenly across the <b>whole</b> clip on this Mac.
            Nothing is uploaded anywhere and nothing is billed.
          </p>
          <p>
            Sampling rate and the frame cap decide how much the GPU will be asked to hold. Running
            DA3 is a separate press, and it is the only step that costs money.
          </p>
        </HelpDot>
      </h3>
      <div
        className={`clip-drop${dropping ? " dropping" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          void take(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(event) => {
            void take(event.target.files?.[0]);
            // Clearing lets the same file be picked again after a failure.
            event.target.value = "";
          }}
        />
        {clipName ? (
          <>
            <span className="clip-name mono" title={clipName}>
              {clipName}
            </span>
            <span className="clip-meta mono">{durationS.toFixed(1)} s</span>
          </>
        ) : (
          <span className="clip-empty">
            {loading ? "reading clip…" : "Drop a video here, or"}
          </span>
        )}
        <button disabled={loading} onClick={() => fileInput.current?.click()}>
          {loading ? "Reading…" : clipName ? "Change…" : "Browse…"}
        </button>
      </div>
      {error && <div className="inspector-note error">{error}</div>}
      {clipName && (
        <>
          <div className="inspector-row control">
            <span className="k">Sampling FPS</span>
            <input
              type="range"
              min={1}
              max={50}
              value={fps}
              onChange={(e) => setNodeParamAndRun(FRAME_SOURCE_ID, "fps", Number(e.target.value))}
            />
            <span className="v num">{fps}</span>
          </div>
          <div className="inspector-row control">
            <span className="k">Max frames</span>
            <input
              type="range"
              min={2}
              max={144}
              value={maxFrames}
              onChange={(e) =>
                setNodeParamAndRun(FRAME_SOURCE_ID, "maxFrames", Number(e.target.value))
              }
            />
            <span className="v num">{maxFrames}</span>
          </div>
          <div className="inspector-actions">
            <button
              disabled={running}
              title="Send the sampled frames to the depth model. This is the only control in the app that spends GPU time."
              onClick={() => void runNode("da3-depth")}
            >
              {running ? "Running…" : "Run DA3 Depth"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Live instance clock. Its own ticker rather than a poll: this counts local wall time since
 * first contact and touches the network never, so watching the meter cannot feed the meter.
 */
function InstanceClock({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{formatElapsed(Date.now() - since)}</>;
}

export function Inspector() {
  const advanced = useAdvanced();
  const session = useSession();
  const graph = useGraph();
  const cloud = useCloud();
  const [busy, setBusy] = useState(false);
  const [baseDraft, setBaseDraft] = useState(ENV_INFER_BASE);
  const [tokenDraft, setTokenDraft] = useState(ENV_INFER_TOKEN);
  const [teardownLog, setTeardownLog] = useState<string | null>(null);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [deployJob, setDeployJob] = useState<JobView | null>(null);
  const [deployLog, setDeployLog] = useState<string[]>([]);

  const selected = graph.selectedId ? nodeById(graph, graph.selectedId) : undefined;
  const spec = selected ? REGISTRY[selected.type] : undefined;
  const runtime = selected ? graph.runtime[selected.id] : undefined;
  const stale = selected ? isNodeStale(graph, selected.id) : false;

  // The frame plan belongs to the source node: it owns the clip and the sampling rate.
  const source = nodeById(graph, "frame-source");
  const durationS = Number(source?.params.durationS ?? 0);
  const plan = planFrames(
    Number(source?.params.fps ?? 10),
    durationS,
    Number(source?.params.maxFrames ?? 32),
  );
  const depthNode = nodeById(graph, "da3-depth");
  const vram = predictVram(plan.count, Number(depthNode?.params.processRes ?? 504));

  const lastField = (graph.runtime["da3-depth"]?.outputs?.depth?.value ?? null) as
    | DepthFieldValue
    | null;
  const lastRun: InferManifest | null = lastField?.manifest ?? null;

  const { gpu } = session;

  /**
   * GPU telemetry polling — demand-driven, and this is a cost control, not a preference.
   *
   * This used to tick every 4 seconds forever. Against a real service that is a request every
   * 4 s, and a Cloud Run instance with continuous traffic never scales to zero — so simply
   * leaving the tab open kept an L4 billing indefinitely. Cloud Run bills instance lifetime,
   * so an idle poll is not "cheap", it is the whole cost.
   *
   * Against the local mock there is nothing to bill, so the lively idle poll stays: it is what
   * makes the offline UI feel alive at zero cost.
   */
  const remote = cloud.baseUrl !== null;

  /**
   * Minutes since the last request to the service, or null when nothing is connected.
   *
   * `clockTick` exists only to re-render; the value is a local subtraction. Watching the idle
   * timer must never itself count as activity — that would be the polling cost bug again, in a
   * new costume.
   */
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!remote) return;
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [remote]);
  const idleMinutes =
    remote && cloud.lastRequestAt !== null
      ? Math.floor((Date.now() - cloud.lastRequestAt) / 60_000)
      : null;
  void clockTick;
  const shouldPoll = graph.running || cloud.state === "warming" || !remote;
  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: number;
    const tick = async () => {
      try {
        const snapshot = await getGpu();
        if (!cancelled) update({ gpu: snapshot });
      } catch {
        if (!cancelled) update({ gpu: null });
      }
      /**
       * 250 ms is a local-mock cadence. Against Cloud Run it is 4 requests per second, which
       * showed up in the 2026-08-05 logs as a wall of `GET /gpu 200` beside the inference — pure
       * autoscaler pressure on a service capped at one instance, for a VRAM bar nobody reads
       * four times a second. Remote runs sample every 2 s instead.
       */
      const interval = graph.running ? (remote ? 2000 : 250) : 4000;
      if (!cancelled) timer = window.setTimeout(tick, interval);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graph.running, shouldPoll]);

  /**
   * Cloud control status — free, and therefore safe to read on mount.
   *
   * Unlike /gpu, none of these calls reach the service: they ask gcloud about the service and
   * the registry, so they cannot wake an instance or extend a billed lifetime. That is what
   * makes it acceptable to answer "what would a deploy cost me right now?" before anything is
   * spent, rather than making the operator start one to find out.
   */
  const loadStatus = async (refresh = false) => {
    setStatusBusy(true);
    try {
      setStatus(await fetchCloudStatus(refresh));
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  };
  useEffect(() => {
    void loadStatus();
    // Mount only: refreshing is an explicit action, matching the no-idle-polling rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Deploy, watch it, and point the app at the result.
   *
   * Auto-connecting on success is a correctness measure, not a convenience: a deployed service
   * the app is NOT pointed at is precisely the state that produced the 2026-08-05 mock-run
   * misdiagnosis, where the mock answered /infer and returned an unrelated scene's geometry.
   */
  const runDeploy = async () => {
    setDeployLog([]);
    const { job } = await startDeploy();
    setDeployJob(job);
    const result = await streamJob(job.id, (line) => setDeployLog((prior) => [...prior, line]));
    setDeployJob((prior) => (prior ? { ...prior, status: result.status } : prior));
    if (result.status !== "succeeded") {
      throw new Error(`deploy failed (${result.error ?? `exit ${result.exitCode}`})`);
    }
    const fresh = await fetchCloudStatus(true);
    setStatus(fresh);
    if (fresh.service.url) {
      connectProxied(fresh.service.url, PROXY_BASE);
      // Deliberately NOT warming here. Deploying is free; the first request is what starts the
      // meter, and that should stay an act the operator chooses.
      setCloudState("cold");
    }
  };

  /** A deploy started before a page reload is still running. Reattach rather than offer to
   *  start a second one — the job runner is single-flight, but the UI should say so too. */
  useEffect(() => {
    void (async () => {
      const job = await runningJob("deploy").catch(() => null);
      if (!job) return;
      setDeployJob(job);
      setDeployLog(job.lines);
      const result = await streamJob(job.id, (line) => setDeployLog((prior) => [...prior, line]));
      setDeployJob((prior) => (prior ? { ...prior, status: result.status } : prior));
      if (result.status === "succeeded") await loadStatus(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One-shot telemetry read, for when a remote session is idle and not polling. */
  const refreshGpu = async () => {
    try {
      update({ gpu: await getGpu() });
      setCloudError(null);
    } catch (e) {
      update({ gpu: null });
      setCloudError(e instanceof Error ? e.message : String(e));
    }
  };

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

  return (
    <div className="pane">
      <div className="pane-status">
        <span className={gpu?.available ? "ok" : ""}>{gpu?.deviceName ?? "no GPU"}</span>
        <span className="hint">{selected ? spec?.label : "no selection"}</span>
      </div>
      <div className="pane-body inspector">
        <ClipSection
          clipName={String(source?.params.videoName ?? "")}
          durationS={durationS}
          fps={Number(source?.params.fps ?? 10)}
          maxFrames={Number(source?.params.maxFrames ?? 112)}
          running={graph.running}
        />

        {/*
          The frame plan is the consequence of the two sliders above, so it sits directly under
          them. Every note in it is a live warning about this plan rather than an explanation of
          the feature, which is why none of them moved behind a `?` and none is gated on a mode:
          honesty rules 1 and 2, and acceptance items 13 and 14.
        */}
        {durationS > 0 && (
          <div className="inspector-section">
            <h3>Frame plan</h3>
            <Row k="Frames" v={`${plan.count}`} />
            <Row k="Effective FPS" v={plan.effectiveFps.toFixed(2)} />
            <VramBar
              used={vram.bytes}
              total={L4_TOTAL_VRAM_BYTES}
              label={vram.measured ? "VRAM (measured)" : "VRAM (interpolated)"}
            />
            {plan.count > MAX_MEASURED_FRAMES && (
              <div className="inspector-note">
                Beyond {MAX_MEASURED_FRAMES} frames is extrapolated — the sweep has not run that
                high. Peak VRAM here is a projection, not a measurement.
              </div>
            )}
            {vram.bytes > L4_TOTAL_VRAM_BYTES && (
              <div className="inspector-note">
                Projected over the L4's {formatBytes(L4_TOTAL_VRAM_BYTES)} — expect an OOM. Lower
                the frame cap or the process resolution.
              </div>
            )}
            {plan.capped && (
              <div className="inspector-note">
                {Number(source?.params.fps)} fps × {durationS.toFixed(1)}s ={" "}
                {Math.floor(Number(source?.params.fps) * durationS)} frames, over the{" "}
                {Number(source?.params.maxFrames)}-frame cap. FPS lowered to{" "}
                {plan.effectiveFps.toFixed(2)} so the frames still span the whole clip.
              </div>
            )}
          </div>
        )}

        {selected && spec ? (
          <>
            <div className="inspector-section">
              <h3>{spec.label}</h3>
              <Row k="Status" v={stale ? "stale" : (runtime?.status ?? "idle")} />
              <Row k="Elapsed" v={`${(runtime?.elapsedMs ?? 0).toFixed(1)} ms`} />
              <Row
                k="Cache key"
                v={(graph.desiredKeys[selected.id] ?? "").slice(0, 12) || "—"}
                title={graph.desiredKeys[selected.id]}
              />
              <div className="inspector-row control">
                <span className="k">Mode</span>
                <input
                  type="checkbox"
                  checked={selected.auto}
                  onChange={(e) => setNodeAuto(selected.id, e.target.checked)}
                />
                <span className="v num">{selected.auto ? "auto" : "paused"}</span>
              </div>
              {runtime?.error && <div className="inspector-note error">{runtime.error}</div>}
            </div>

            {spec.controls && spec.controls.length > 0 && (
              <div className="inspector-section">
                <h3>Parameters</h3>
                {spec.controls.map((control) => (
                  <Control
                    key={control.key}
                    spec={control}
                    value={selected.params[control.key]}
                    onChange={(v) => setNodeParamAndRun(selected.id, control.key, v)}
                  />
                ))}
                {spec.execution === "manual" && (
                  <div className="inspector-actions">
                    <button
                      disabled={graph.running}
                      onClick={() => void runNode(selected.id)}
                      title="The only control that spends GPU time"
                    >
                      Run {spec.label}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}

        {/*
          The money guard, and the one part of the cloud plumbing that is not Advanced.

          Cloud Run bills an instance's whole lifetime — cold start and idle tail included — and it
          keeps doing so whether or not this pane is on screen or which mode it is in. So the
          elapsed meter and the idle warning render in both. This is DESIGN.md's rule that a mode
          may hide an explanation and never a live warning, applied to the most expensive state
          this app can be in.
        */}
        {remote && (
          <div className="inspector-section">
            <h3>
              Instance
              <HelpDot label="What you are being billed for">
                <p>{COST_BASIS}</p>
                <p>
                  Deleting the service is the only thing that stops the meter. Pointing the app at
                  the local fixture does not — the instance keeps running.
                </p>
              </HelpDot>
            </h3>
            {cloud.firstContactAt === null ? (
              <Row k="Billing" v="no contact yet" title={COST_BASIS} />
            ) : (
              <div className="inspector-row">
                <span className="k">Billing since</span>
                <span className="v num" title={COST_BASIS}>
                  <InstanceClock since={cloud.firstContactAt} />
                </span>
              </div>
            )}
            {idleMinutes !== null && idleMinutes >= IDLE_WARN_MINUTES && (
              <div className="inspector-note error">
                Idle {idleMinutes} min — still billing. Save any runs you want to keep, then Delete
                service.
              </div>
            )}
          </div>
        )}

        {/*
          Cloud control: the state of the world before anything is spent.

          Every row here is a metadata read. The one that matters is Image — it evaluates
          deploy.sh's own build-skip predicate against the live registry, which is the
          difference between a ~1-3 min deploy and a 15-20 min rebuild. Until this existed the
          only way to learn that was to start the deploy and watch the log.
        */}
        {advanced && (
        <div className="inspector-section">
          <h3>Cloud control</h3>
          {status ? (
            <>
              <Row
                k="gcloud"
                v={
                  !status.gcloud.available
                    ? "not available"
                    : status.auth.active
                      ? (status.auth.account ?? "authenticated")
                      : "not authenticated"
                }
                title={status.gcloud.error ?? status.auth.account ?? ""}
              />
              {status.gcloud.available && !status.auth.active && status.auth.hint && (
                <div className="inspector-note">
                  {status.auth.hint} — this is the one step no button can do for you, because it
                  needs a browser consent screen.
                </div>
              )}
              <Row k="Project" v={`${status.project} · ${status.region}`} />
              <Row
                k="Service"
                v={status.service.exists ? "deployed" : "none"}
                title={status.service.url ?? "no service — nothing is billing"}
              />
              <Row
                k="Image"
                v={status.image.present ? "in registry" : "not built"}
                title={`${status.image.uri}:${status.image.tag ?? "?"}`}
              />
              <Row
                k="Next deploy"
                v={status.deploy.estimate}
                title={status.deploy.detail ?? status.deploy.estimate}
              />
              {status.deploy.detail && (
                <div className="inspector-note">{status.deploy.detail}</div>
              )}
              <div className="inspector-actions">
                <button disabled={statusBusy} onClick={() => void loadStatus(true)}>
                  {statusBusy ? "Checking…" : "Refresh status"}
                </button>
                {/*
                  Deploy. The rails around it matter as much as the button:

                  - disabled while a service already exists, so it can never stack a second one
                  - disabled unless gcloud is authenticated, because the failure would be a
                    twenty-minute-shaped confusion otherwise
                  - a confirm dialog that states instance-lifetime billing in words and the
                    predicted duration, since this button removes the friction that has been
                    protecting this project from accidental spend
                  - auto-connects on success, because a deployed service the app is not pointed
                    at is the exact state that produced the mock-run misdiagnosis
                */}
                {!status.service.exists && status.auth.active && (
                  <button
                    disabled={busy || deployJob !== null}
                    title="Runs scripts/deploy.sh, then points the app at the result. Cloud Run bills the instance's whole lifetime once it wakes."
                    onClick={() =>
                      act(async () => {
                        if (
                          !window.confirm(
                            `Deploy ${status.service.name}?\n\n` +
                              `${status.deploy.estimate}.\n\n` +
                              "Deploying does not bill by itself, but the first request wakes an " +
                              "L4 instance and Cloud Run then bills its WHOLE LIFETIME — cold " +
                              "start and idle tail included, not inference seconds.\n\n" +
                              "Batch every run you need, save them, then Delete service.",
                          )
                        ) {
                          return;
                        }
                        await runDeploy();
                      })
                    }
                  >
                    Deploy &amp; connect
                  </button>
                )}
                {/*
                  Connect without typing a URL or holding a token. The service URL comes from
                  `gcloud run services describe`; requests are signed inside the dev server.
                  This does NOT deploy — it only points the app at a service that already
                  exists, and the first request is what wakes the instance.
                */}
                {status.service.exists && !remote && (
                  <button
                    disabled={busy || !status.service.url}
                    title="Route GPU calls through the dev server, which signs them from this Mac's gcloud credentials. No token is stored in the browser. The first request wakes the instance and starts the meter."
                    onClick={() =>
                      act(async () => {
                        connectProxied(status.service.url!, PROXY_BASE);
                        const snapshot = await getGpu();
                        update({ gpu: snapshot });
                        setCloudState(snapshot.modelLoaded ? "warm" : "cold");
                      })
                    }
                  >
                    Connect (signed locally)
                  </button>
                )}
              </div>
              {deployJob && (
                <>
                  <Row k="Deploy" v={deployJob.status} />
                  <pre className="job-log">{deployLog.slice(-14).join("\n") || "starting…"}</pre>
                </>
              )}
            </>
          ) : (
            <Row k="—" v={statusError ? "unavailable" : "checking…"} />
          )}
          {statusError && <div className="inspector-note error">{statusError}</div>}
        </div>
        )}

        {advanced && (
        <div className="inspector-section">
          <h3>
            Cloud session
            {/*
              Four paragraphs of billing prose used to sit inline here and in Cloud control. They
              are correct and they are read once; the meter and the idle warning, which are about
              the state right now, are up in the Instance section and show in both modes.
            */}
            <HelpDot label="What these actions cost">
              <p>{COST_BASIS}</p>
              <p>
                <b>Checking costs nothing.</b> The Cloud control rows read gcloud metadata and
                never touch the service, so they cannot wake an instance.
              </p>
              <p>
                <b>Warm up</b> loads the model into VRAM: measured 64 s cold start plus 40 s model
                load against ~31 s of inference, so warming before you need it usually pays.{" "}
                <b>Release model</b> frees VRAM but does not stop billing. <b>Delete service</b> is
                the only thing that does.
              </p>
            </HelpDot>
          </h3>
          {remote ? (
            <>
              <Row
                k="Service"
                v={cloud.serviceUrl ?? cloud.baseUrl ?? "—"}
                title={cloud.serviceUrl ?? cloud.baseUrl ?? ""}
              />
              {cloud.proxied && <Row k="Auth" v="signed by dev server · no token held" />}
              <Row k="Requests" v={`${cloud.requestCount}`} />
              <Row k="Runs" v={`${cloud.runCount}`} />
              <div className="inspector-actions">
                <button disabled={busy} onClick={() => act(refreshGpu)}>
                  Refresh
                </button>
                <button
                  disabled={busy}
                  title="Loads the model into VRAM. Measured cold start 64 s + model load 40 s ≈ 105 s, against ~31 s of inference — so warming before you need it is usually the right call."
                  onClick={() =>
                    act(async () => {
                      setCloudState("warming");
                      try {
                        update({ gpu: await warmup() });
                        setCloudState("warm");
                      } catch (e) {
                        setCloudState("cold");
                        throw e;
                      }
                    })
                  }
                >
                  Warm up
                </button>
              </div>
              <div className="inspector-actions">
                <button
                  disabled={busy}
                  title="Frees the model from VRAM so the instance CAN scale down. It does not delete the service and it does not stop billing."
                  onClick={() => act(async () => void (await releaseModel()))}
                >
                  Release model
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  title="Deletes the Cloud Run service. This is the only action that stops the meter. The ~12 GB image is kept, so the next deploy still skips the build."
                  onClick={() =>
                    act(async () => {
                      if (
                        !window.confirm(
                          "Delete the Cloud Run service?\n\nThis is the only thing that stops billing. Any run artifacts still only on the instance will be lost — save them first.\n\nThe image is kept, so the next deploy takes ~1 min, not 20.",
                        )
                      ) {
                        return;
                      }
                      // Streams now, rather than blocking on one request for the whole
                      // delete. The operator sees gcloud working instead of a frozen button.
                      setTeardownLog("deleting…");
                      const { output } = await deleteService((line) =>
                        setTeardownLog((prior) =>
                          `${prior === "deleting…" ? "" : (prior ?? "")}\n${line}`.trim().slice(-600),
                        ),
                      );
                      markServiceDeleted();
                      setTeardownLog(output.slice(-600));
                      await loadStatus(true);
                    })
                  }
                >
                  Delete service
                </button>
              </div>
              <div className="inspector-actions">
                <button disabled={busy} onClick={() => disconnectCloud()}>
                  Use local fixture
                </button>
              </div>
              {/* Not moved behind a `?`: it corrects a belief the button itself creates, at the
                  moment it is about to be clicked, about the one thing here that costs money. */}
              <div className="inspector-note">
                “Use local fixture” only points this app elsewhere — the instance keeps running
                and keeps billing until it is deleted.
              </div>
            </>
          ) : (
            <>
              <Row k="Target" v="local mock + fixtures" />
              <Row k="Cost" v="none" />
              <div className="inspector-row control">
                <span className="k">Service URL</span>
                <input
                  type="text"
                  value={baseDraft}
                  placeholder="http://localhost:8080"
                  onChange={(e) => setBaseDraft(e.target.value)}
                />
              </div>
              <div className="inspector-row control">
                <span className="k">Token</span>
                <input
                  type="password"
                  value={tokenDraft}
                  placeholder="optional"
                  onChange={(e) => setTokenDraft(e.target.value)}
                />
              </div>
              <div className="inspector-actions">
                <button
                  disabled={busy || baseDraft.trim() === ""}
                  onClick={() =>
                    act(async () => {
                      connectCloud(baseDraft.trim(), tokenDraft.trim());
                      const snapshot = await getGpu();
                      update({ gpu: snapshot });
                      setCloudState(snapshot.modelLoaded ? "warm" : "cold");
                    })
                  }
                >
                  Connect
                </button>
              </div>
              <span className="section-help">
                <HelpDot label="When to use these two fields">
                  <p>
                    Connecting starts nothing by itself, but the first request wakes an instance and
                    Cloud Run then bills its whole lifetime.
                  </p>
                  <p>
                    These two fields are the manual path, kept for a service this Mac's gcloud
                    cannot see. Otherwise prefer <b>Connect (signed locally)</b> in Cloud control
                    above: it finds the service itself and keeps the credential out of the browser
                    entirely.
                  </p>
                </HelpDot>
              </span>
              {cloud.deleted && (
                <div className="inspector-note">Service deleted this session. Meter stopped.</div>
              )}
            </>
          )}
          {teardownLog && <div className="inspector-note error">{teardownLog}</div>}
        </div>
        )}

        {advanced && (
        <div className="inspector-section">
          <h3>GPU</h3>
          {gpu ? (
            <>
              <VramBar
                used={gpu.busy ? gpu.currentBytes : gpu.peakBytes}
                total={gpu.totalBytes}
                label={gpu.busy ? "VRAM live" : "VRAM peak"}
              />
              <Row k="Device" v={gpu.deviceName} />
              <Row k="State" v={gpu.busy ? "busy" : gpu.modelLoaded ? "warm" : "cold"} />
            </>
          ) : (
            <Row k="State" v={remote ? "not polled — press Refresh" : "unreachable"} />
          )}
        </div>
        )}

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
