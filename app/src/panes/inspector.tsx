/**
 * Inspector — bound to graph selection. Click a node, its parameters appear.
 *
 * The rows are generated from the selected node's `controls` schema, so a new node
 * type brings its own inspector with it. The GPU and Last-run sections stay global:
 * they describe the machine, not the node.
 */

import { useEffect, useState } from "react";
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
        ) : (
          <div className="inspector-section">
            <h3>Inspector</h3>
            <Row k="—" v="select a node" />
          </div>
        )}

        <div className="inspector-section">
          <h3>Frame plan</h3>
          {durationS > 0 ? (
            <>
              <Row k="Frames" v={`${plan.count}`} />
              <Row k="Effective FPS" v={plan.effectiveFps.toFixed(2)} />
              <VramBar
                used={vram.bytes}
                total={L4_TOTAL_VRAM_BYTES}
                label={vram.measured ? "VRAM (measured)" : "VRAM (interpolated)"}
              />
              {plan.count > MAX_MEASURED_FRAMES && (
                <div className="inspector-note">
                  Beyond {MAX_MEASURED_FRAMES} frames is extrapolated — the sweep has not run
                  that high. Peak VRAM here is a projection, not a measurement.
                </div>
              )}
              {vram.bytes > L4_TOTAL_VRAM_BYTES && (
                <div className="inspector-note">
                  Projected over the L4's {formatBytes(L4_TOTAL_VRAM_BYTES)} — expect an OOM.
                  Lower the frame cap or the process resolution.
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
            </>
          ) : (
            <Row k="—" v="no clip loaded" />
          )}
        </div>

        {/*
          Cloud control: the state of the world before anything is spent.

          Every row here is a metadata read. The one that matters is Image — it evaluates
          deploy.sh's own build-skip predicate against the live registry, which is the
          difference between a ~1-3 min deploy and a 15-20 min rebuild. Until this existed the
          only way to learn that was to start the deploy and watch the log.
        */}
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
              <div className="inspector-note">
                Checking costs nothing: these read gcloud metadata and never touch the service,
                so they cannot wake an instance.
              </div>
            </>
          ) : (
            <Row k="—" v={statusError ? "unavailable" : "checking…"} />
          )}
          {statusError && <div className="inspector-note error">{statusError}</div>}
        </div>

        <div className="inspector-section">
          <h3>Cloud session</h3>
          {remote ? (
            <>
              <Row
                k="Service"
                v={cloud.serviceUrl ?? cloud.baseUrl ?? "—"}
                title={cloud.serviceUrl ?? cloud.baseUrl ?? ""}
              />
              {cloud.proxied && <Row k="Auth" v="signed by dev server · no token held" />}
              <Row
                k="Instance alive"
                v={cloud.firstContactAt === null ? "no contact yet" : ""}
                title={COST_BASIS}
              />
              {cloud.firstContactAt !== null && (
                <div className="inspector-row">
                  <span className="k">Billing since</span>
                  <span className="v num" title={COST_BASIS}>
                    <InstanceClock since={cloud.firstContactAt} />
                  </span>
                </div>
              )}
              <Row k="Requests" v={`${cloud.requestCount}`} />
              <Row k="Runs" v={`${cloud.runCount}`} />
              {/*
                Idle watchdog. Cloud Run bills the instance's lifetime, so an instance nobody is
                using costs exactly as much as one running inference. The app cannot delete it
                automatically — artifacts that have not been saved yet live only on that
                instance, and a surprise deletion would destroy paid-for work — so it says so
                loudly and leaves the decision where it belongs.
              */}
              {idleMinutes !== null && idleMinutes >= IDLE_WARN_MINUTES && (
                <div className="inspector-note error">
                  Idle {idleMinutes} min — still billing. Save any runs you want to keep, then
                  Delete service.
                </div>
              )}
              {/*
                No currency figure, on purpose (DESIGN.md honesty rule 1). The app has no
                billing data and the true lifetime started before our first contact, so the
                measured elapsed time plus the billing model in words is the honest maximum.
              */}
              <div className="inspector-note">{COST_BASIS}</div>
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
              <div className="inspector-note">
                Connecting starts nothing by itself, but the first request wakes an instance and
                Cloud Run then bills its whole lifetime. These two fields are the manual path,
                kept for a service this Mac's gcloud cannot see. Otherwise prefer{" "}
                <b>Connect (signed locally)</b> in Cloud control above: it finds the service
                itself and keeps the credential out of the browser entirely.
              </div>
              {cloud.deleted && (
                <div className="inspector-note">Service deleted this session. Meter stopped.</div>
              )}
            </>
          )}
          {teardownLog && <div className="inspector-note error">{teardownLog}</div>}
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
              <Row k="Device" v={gpu.deviceName} />
              <Row k="State" v={gpu.busy ? "busy" : gpu.modelLoaded ? "warm" : "cold"} />
            </>
          ) : (
            <Row k="State" v={remote ? "not polled — press Refresh" : "unreachable"} />
          )}
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
