/**
 * Setup — where a session starts: choose a clip, see what it will cost, run it, watch it land.
 *
 * Renamed from Inspector on 2026-08-11. It had two jobs and was named for the smaller one. The
 * front door is the **Clip** section: drop a file, read the plan, extract, look at the frames,
 * press Run. Selecting a node still fills in a parameters section below, which is the job the old
 * name described.
 *
 * It is a second VIEW of `frame-source`, not a second copy of its state — both write the node
 * through `lib/load-clip.ts`, so the node card keeps working and the two can never disagree.
 *
 * ## The ordering this pane exists to make visible
 *
 * Load → extract → run, with somewhere for the frames to go. Every one of those steps was
 * implicit, and two of them were wrong:
 *
 * - Dropping a clip used to start ffmpeg immediately and show the plan afterwards, so the plan
 *   described work already done. Now the plan comes first and Extract is a press.
 * - Pressing Run with no GPU service produced an HTTP error from deep in the client. Now the
 *   preconditions are a list, and the button is disabled until they are met.
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
  MODEL_REPOSITORY_ID,
  MODEL_REVISION,
  estimateUploadBytes,
  formatBytes,
  L4_TOTAL_VRAM_BYTES,
  MAX_MEASURED_FRAMES,
  planFrames,
  planScale,
  predictVram,
  type InferManifest,
} from "../lib/contract";
import {
  COST_BASIS,
  connectCloud,
  connectProxied,
  disconnectCloud,
  formatElapsed,
  setCloudError,
  setCloudState,
  useCloud,
} from "../lib/cloud-store";
import { PROXY_BASE } from "../lib/cloud-control";
// Deleting the service lives on the status bar's control, which owns the whole lifecycle. A
// second delete button here would be a second place to get the confirmation wording wrong.
import { deploy, lifecycle, loadStatus, useDeploy } from "../lib/deploy-store";
import {
  ENV_INFER_BASE,
  ENV_INFER_TOKEN,
  getGpu,
  releaseModel,
  warmup,
} from "../lib/infer-client";
import { update, useSession } from "../lib/session-store";
import { useAdvanced } from "../lib/ui-mode";
import { FRAME_SOURCE_ID, extractClipFrames, loadClip } from "../lib/load-clip";
import { isRunActive, useRunPhase } from "../lib/run-phase";
import { setMockTargetAllowed, useMockTargetAllowed } from "../lib/dev-target";
import { clearRunReadout, preconditions, runInference } from "../lib/run-inference";
import { HelpDot, HelpTerm } from "./help";
import { ContactSheet } from "./contact-sheet";
import { PhaseReadout, PreconditionList } from "./run-readout";
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
import type { FramesValue } from "../graph/nodes/frame-source";
import type { DepthFieldValue } from "../measurement/depth-field";
import { PaneShare } from "./pane-chrome";

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

/**
 * Bare `**bold**` in a help string, because these are written as prose next to the control they
 * explain and a nested React tree there would bury the sentence in markup.
 */
function HelpText({ text }: { text: string }) {
  return (
    <p>
      {text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
        index % 2 === 1 ? <b key={index}>{part}</b> : <span key={index}>{part}</span>,
      )}
    </p>
  );
}

/**
 * The label explains its own control. No `?` per row — hovering the name is the affordance, and
 * the dotted underline is the only mark it leaves. See `help.tsx` for why not a native `title`.
 */
function ControlLabel({ spec }: { spec: ControlSpec }) {
  if (!spec.help) return <span className="k">{spec.label}</span>;
  return (
    <span className="k">
      <HelpTerm help={<HelpText text={spec.help} />}>{spec.label}</HelpTerm>
    </span>
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
    return (
      <div className="inspector-row">
        <ControlLabel spec={spec} />
        <span className="v" title={String(value ?? "")}>
          {text}
        </span>
      </div>
    );
  }

  if (spec.kind === "select") {
    return (
      <div className="inspector-row control">
        <ControlLabel spec={spec} />
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
        <ControlLabel spec={spec} />
        <input
          type="checkbox"
          // The label beside it is a `<span>`, not a `<label for>`, so a screen reader would
          // otherwise announce only "checkbox, on".
          aria-label={spec.label}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="v num">{value ? "on" : "off"}</span>
      </div>
    );
  }

  return (
    <div className="inspector-row control">
      <ControlLabel spec={spec} />
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
 * The front door: choose a clip, see exactly what will happen to it, then make it happen.
 *
 * Drop and Browse both go through `loadClip`, which writes `frame-source` — the same node the
 * Graph's card writes. Loading probes the file and stops there: the plan below is arithmetic on
 * the probe, so the sampling controls are free to drag. Extract is the press that spends 1.7 to
 * 11.7 seconds of this Mac, and Run is the separate press that spends the GPU.
 */
function ClipSection() {
  const graph = useGraph();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = nodeById(graph, FRAME_SOURCE_ID);
  const clipName = String(source?.params.videoName ?? "");
  const durationS = Number(source?.params.durationS ?? 0);
  const fps = Number(source?.params.fps ?? 10);
  const maxFrames = Number(source?.params.maxFrames ?? 112);
  const width = Number(source?.params.width ?? 0);
  const height = Number(source?.params.height ?? 0);

  const frames = graph.runtime[FRAME_SOURCE_ID]?.outputs?.frames?.value as FramesValue | undefined;
  const stale = isNodeStale(graph, FRAME_SOURCE_ID);
  const extracted = frames !== undefined && !stale;

  const plan = planFrames(fps, durationS, maxFrames);
  const scale = planScale(width, height);
  const upload = estimateUploadBytes(plan.count, scale);
  const depthNode = nodeById(graph, "da3-depth");
  const vram = predictVram(plan.count, Number(depthNode?.params.processRes ?? 504));

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      await loadClip(file);
      // A new clip invalidates the readout of the last run against the previous one.
      clearRunReadout();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setDropping(false);
    }
  };

  const extract = async () => {
    setError(null);
    setExtracting(true);
    try {
      await extractClipFrames();
      const failure = graph.runtime[FRAME_SOURCE_ID]?.error;
      if (failure) setError(failure);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="inspector-section">
      <h3>
        Clip
        <HelpDot label="What happens to a clip you load">
          <p>
            The file is copied to a temporary directory so ffmpeg has a real path — browsers never
            expose one — and probed. Nothing is uploaded anywhere and nothing is billed.
          </p>
          <p>
            <b>Extract</b> samples frames evenly across the <b>whole</b> clip on this Mac.
            Measured here: 1.7 s for a 13.5 s 1080p clip, 11.7 s for a 15.8 s 4K60 one. It is
            free and it is not instant, which is why it is a press rather than a side effect of
            dropping a file.
          </p>
          <p>
            Running DA3 is a further, separate press, and it is the only step that costs money.
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
            <span className="clip-meta mono">
              {durationS.toFixed(1)} s{width > 0 ? ` · ${width}×${height}` : ""}
            </span>
          </>
        ) : (
          <span className="clip-empty">{loading ? "reading clip…" : "Drop a video here, or"}</span>
        )}
        <button disabled={loading} onClick={() => fileInput.current?.click()}>
          {loading ? "Reading…" : clipName ? "Change…" : "Browse…"}
        </button>
      </div>
      {error && <div className="inspector-note error">{error}</div>}

      {clipName && durationS > 0 && (
        <>
          <div className="inspector-row control">
            <span className="k">
              <HelpTerm
                help={
                  <p>
                    How many frames a second to take. Frames are spread across the <b>whole</b>{" "}
                    clip at this rate — the video is never trimmed to a window, because accuracy
                    here comes from comparing many views of one scene.
                  </p>
                }
              >
                Sampling FPS
              </HelpTerm>
            </span>
            <input
              type="range"
              min={1}
              max={50}
              value={fps}
              /*
               * `…AndRun` is safe here even though ffmpeg is expensive, and that is the whole
               * point of Frame Source being `manual`: the pass it schedules is `runAutoFree`,
               * which denies every manual node. So the cache key restamps, the plan below
               * updates, the free nodes downstream catch up — acceptance item 17 — and no
               * ffmpeg runs until Extract is pressed. Held outputs survive, so the viewers keep
               * showing the last run rather than blanking mid-drag.
               */
              onChange={(e) => setNodeParamAndRun(FRAME_SOURCE_ID, "fps", Number(e.target.value))}
            />
            <span className="v num">{fps}</span>
          </div>
          <div className="inspector-row control">
            <span className="k">
              <HelpTerm
                help={
                  <p>
                    The ceiling on frames sent to the GPU. 112 is deliberately below the measured
                    ceiling: 144 frames ran at 21.88 GiB of the card's 22.03, and 160 ran out of
                    memory. 112 measured 17.23 GiB — about 15% headroom.
                  </p>
                }
              >
                Max frames
              </HelpTerm>
            </span>
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

          {/*
            The plan. Every note in it is a live warning about THIS plan rather than an
            explanation of the feature, which is why none of them moved behind a `?` and none is
            gated on a mode: honesty rules 1 and 2, acceptance items 13 and 14.
          */}
          <div className="frame-plan">
            <Row k="Frames" v={`${plan.count}`} />
            <Row k="Effective FPS" v={plan.effectiveFps.toFixed(2)} />
            {scale.width > 0 && (
              <Row
                k="Frame size"
                v={
                  scale.scaled
                    ? `${width}×${height} → ${scale.width}×${scale.height}`
                    : `${scale.width}×${scale.height} (not scaled)`
                }
                title={
                  scale.scaled
                    ? "Downscaled to a 1024 px long edge before upload. Cloud Run's request cap is 32 MiB, and DA3 resizes to the process resolution internally anyway."
                    : "Already under the 1024 px long edge, so the frames are sent as they are."
                }
              />
            )}
            {scale.width > 0 && (
              <Row
                k="Upload"
                v={`${formatBytes(upload.lowBytes)} – ${formatBytes(upload.highBytes)}`}
                title="A bracket, not a figure. JPEG size depends on content: two clips measured on 2026-08-11 differed by 1.9× at identical pixel counts. The exact total is known once the frames are read, and the progress bar during a run uses that."
              />
            )}
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
                {fps} fps × {durationS.toFixed(1)}s = {Math.floor(fps * durationS)} frames, over
                the {maxFrames}-frame cap. FPS lowered to {plan.effectiveFps.toFixed(2)} so the
                frames still span the whole clip.
              </div>
            )}
          </div>

          <div className="inspector-actions">
            <button
              disabled={extracting}
              className={extracted ? "" : "primary"}
              title="Runs ffmpeg on this Mac. Free, and not instant — measured 1.7 s for a 13.5 s 1080p clip and 11.7 s for a 15.8 s 4K60 one. Nothing is uploaded."
              onClick={() => void extract()}
            >
              {extracting
                ? "Extracting…"
                : extracted
                  ? "Re-extract"
                  : stale && frames
                    ? "Re-extract (settings changed)"
                    : "Extract frames"}
            </button>
          </div>

          {extracting && (
            <div className="inspector-note">
              ffmpeg decodes the whole clip whatever the frame count, so this takes about as long
              for 12 frames as for 112.
            </div>
          )}

          {frames && stale && !extracting && (
            <div className="inspector-note">
              These {frames.paths.length} frames were sampled with the previous settings. The plan
              above is what Re-extract would produce.
            </div>
          )}

          {frames && (
            <ContactSheet
              paths={frames.paths}
              // `middle` is the shipped default and the one the model's documentation
              // recommends for video. Marking it makes "which frame anchors the scene?" a thing
              // you can point at.
              referenceIndex={
                String(depthNode?.params.refViewStrategy ?? "middle") === "first"
                  ? 0
                  : Math.floor(frames.paths.length / 2)
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Run section: the three preconditions, the button, and what happened.
 *
 * Kept separate from Clip because it answers a different question. Clip is "what will be sent";
 * this is "where is it going, may I send it, and what is it doing now".
 */
function RunSection({ onDeploy }: { onDeploy: () => void }) {
  const graph = useGraph();
  const cloud = useCloud();
  const phase = useRunPhase();
  void graph;
  void cloud;

  const steps = preconditions();
  const ready = steps.every((step) => step.ok);
  const busy = isRunActive();

  return (
    <div className="inspector-section">
      <h3>
        Run
        <HelpDot label="What Run does, and what it costs">
          <p>
            The extracted frames are sent to the depth model, which returns a depth value for
            every pixel of every frame plus where the camera was for each one. This is the only
            control in the app that spends GPU time.
          </p>
          <p>
            Three things have to be true first, and the list above says which are. <b>Clip</b> —
            drop a video at the top of this pane, or press Browse. <b>Frames</b> — press Extract
            frames. <b>GPU service</b> — press Deploy in the status bar.
          </p>
          <p>
            Cloud Run bills an instance's <b>whole lifetime</b> once it wakes — cold start and
            idle tail included, not inference seconds. Batch the runs you need, save the ones you
            want to keep, then delete the service.
          </p>
        </HelpDot>
      </h3>

      <PreconditionList
        steps={steps}
        onFix={(step) =>
          step.id === "target" && !step.ok ? (
            <button className="precondition-action" onClick={onDeploy}>
              Deploy
            </button>
          ) : null
        }
      />

      {/*
        Not a paragraph in the pane body. The step above already reads "local mock · fixture
        geometry", the result carries MOCK on the run, on the card and across both viewers, and
        this state now requires a deliberate Advanced switch to reach at all.
      */}

      <div className="inspector-actions">
        <button
          className="primary"
          disabled={!ready || busy}
          title={
            ready
              ? "Send the extracted frames to the depth model. The only control here that spends GPU time."
              : "Every step above has to be satisfied first."
          }
          onClick={() => void runInference()}
        >
          {busy ? "Running…" : "Run DA3 Depth"}
        </button>
        {(phase.kind === "done" || phase.kind === "failed") && (
          <button onClick={clearRunReadout}>Clear</button>
        )}
      </div>

      <PhaseReadout phase={phase} />
    </div>
  );
}

/**
 * Rehearse a cold service against the local mock.
 *
 * The mock answers instantly, which is what makes this app buildable with no GPU and no spend.
 * The cost is that the two phases dominating a real cold run — 64 s of cold start and 40 s of
 * model load — never happen offline, so the readout for them would ship having been rendered
 * exactly zero times. AGENTS.md is explicit that an untested seam described as working is worse
 * than one described as absent; this is how that seam gets tested.
 *
 * Off by default, and only ever offered against the mock. It cannot make a real service slower.
 */
function MockDevSwitches() {
  const [enabled, setEnabled] = useState(false);
  const [known, setKnown] = useState(false);
  const asTarget = useMockTargetAllowed();

  useEffect(() => {
    void fetch("/api/mock/latency")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { enabled?: boolean } | null) => {
        if (!body) return;
        setEnabled(Boolean(body.enabled));
        setKnown(true);
      })
      .catch(() => {});
  }, []);

  if (!known) return null;

  return (
    <>
      <div className="inspector-row control">
        <span className="k">
          <HelpTerm
            help={
              <>
                <p>
                  Lets the offline mock satisfy the GPU-service step, so a run can be exercised
                  with no service deployed. <b>Off by default, and it should stay off.</b>
                </p>
                <p>
                  The mock answers with the roadside fixture whatever you send it, so the result
                  is a different scene wearing your clip's frames. That was mistaken for a real
                  run once already. It exists so this interface can be built without a GPU, not
                  so anything can be measured.
                </p>
              </>
            }
          >
            Mock as run target
          </HelpTerm>
        </span>
        <input
          type="checkbox"
          aria-label="Allow the local mock to satisfy the GPU service step"
          checked={asTarget}
          onChange={(event) => setMockTargetAllowed(event.target.checked)}
        />
        <span className="v num">{asTarget ? "on" : "off"}</span>
      </div>
      <div className="inspector-row control">
        <span className="k">
          <HelpTerm
            help={
              <>
                <p>
                  Makes the offline mock pretend to be a cold Cloud Run service: 6 s with nothing
                  answering, then 4 s of model load, before the usual run. About a tenth of the
                  measured 64 s and 40 s — long enough to watch each phase arrive, short enough to
                  iterate on.
                </p>
                <p>
                  It exists so the run readout can be built and reviewed without a GPU. It affects
                  the local mock only and can never slow a real service.
                </p>
              </>
            }
          >
            Rehearse cold start
          </HelpTerm>
        </span>
        <input
          type="checkbox"
          aria-label="Rehearse cold start on the local mock"
          checked={enabled}
          onChange={(event) => {
            const next = event.target.checked;
            setEnabled(next);
            void fetch("/api/mock/latency", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled: next }),
            }).catch(() => {});
          }}
        />
        <span className="v num">{enabled ? "on" : "off"}</span>
      </div>
    </>
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

export function SetupPane() {
  const advanced = useAdvanced();
  const session = useSession();
  const graph = useGraph();
  const cloud = useCloud();
  const deployState = useDeploy();
  const [busy, setBusy] = useState(false);
  const [baseDraft, setBaseDraft] = useState(ENV_INFER_BASE);
  const [tokenDraft, setTokenDraft] = useState(ENV_INFER_TOKEN);

  const selected = graph.selectedId ? nodeById(graph, graph.selectedId) : undefined;
  const spec = selected ? REGISTRY[selected.type] : undefined;
  const runtime = selected ? graph.runtime[selected.id] : undefined;
  const stale = selected ? isNodeStale(graph, selected.id) : false;

  const currentField = (graph.runtime["da3-depth"]?.outputs?.depth?.value ?? null) as
    | DepthFieldValue
    | null;
  const currentRun: InferManifest | null = currentField?.manifest ?? null;

  const { gpu } = session;
  const remote = cloud.baseUrl !== null;
  const status = deployState.status;
  const state = lifecycle(deployState, cloud);

  /**
   * GPU telemetry polling — demand-driven, and this is a cost control, not a preference.
   *
   * This used to tick every 4 seconds forever. Against a real service that is a request every
   * 4 s, and a Cloud Run instance with continuous traffic never scales to zero — so simply
   * leaving the tab open kept an L4 billing indefinitely. Cloud Run bills instance lifetime,
   * so an idle poll is not "cheap", it is the whole cost.
   *
   * Against the local mock there is nothing to bill, so the lively idle poll stays: it is what
   * makes the offline UI feel alive at zero cost. During a run this stands down entirely —
   * `run-phase` owns the poll then, so the readout survives this pane being hidden.
   */
  const runActive = isRunActive();
  const shouldPoll = !runActive && (cloud.state === "warming" || !remote);
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
      if (!cancelled) timer = window.setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shouldPoll]);

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
        {/*
          The depth MODE, not the device. This slot rendered `gpu.deviceName`, which offline is
          the mock's own string "NVIDIA L4 (mock)" — the least useful fact available in the most
          prominent place. What matters here is where depth comes from, because that is the axis
          that would change for a LiDAR or stereo source. The device that ran it belongs on the
          run, and is in Current run below.
        */}
        <span className="ok" title={`${MODEL_REPOSITORY_ID} @ ${MODEL_REVISION.slice(0, 8)}`}>
          MODE · DA3
        </span>
        <span className="hint">{selected ? spec?.label : "no selection"}</span>
        <PaneShare />
      </div>
      <div className="pane-body inspector">
        <ClipSection />

        <RunSection
          onDeploy={() =>
            void act(async () => {
              if (!window.confirm(DEPLOY_CONFIRM(status?.service.name ?? "the service", status?.deploy.estimate ?? "Duration unknown"))) return;
              await deploy();
            })
          }
        />

        {selected && spec ? (
          <>
            <div className="inspector-section">
              <h3>{spec.label}</h3>
              {/*
                "blocked" is the evaluator's word for "a required input has nothing on it", and
                on a fresh app that is the ordinary state of Run Source waiting for its first
                run. Reporting it as "stale" described a fault; it is a queue.
              */}
              <Row
                k="Status"
                v={
                  runtime?.status === "blocked"
                    ? "waiting for input"
                    : stale
                      ? "stale"
                      : (runtime?.status ?? "idle")
                }
              />
              <Row k="Elapsed" v={`${(runtime?.elapsedMs ?? 0).toFixed(1)} ms`} />
              <Row
                k="Cache key"
                v={(graph.desiredKeys[selected.id] ?? "").slice(0, 12) || "—"}
                title={graph.desiredKeys[selected.id]}
              />
              <div className="inspector-row control">
                <span className="k">
                  <HelpTerm
                    help={
                      <>
                        <p>
                          <b>auto</b> re-runs this node whenever its inputs change.{" "}
                          <b>paused</b> leaves it stale until you press Run.
                        </p>
                        <p>
                          DA3 Depth and Frame Source ship paused, for the same reason in two
                          currencies: one spends GPU money, the other spends up to 11.7 s of this
                          Mac decoding a 4K clip. Neither should start because a slider moved.
                        </p>
                      </>
                    }
                  >
                    Mode
                  </HelpTerm>
                </span>
                <input
                  type="checkbox"
                  // Not "Run {label} automatically" — for the node called Run Source that reads
                  // "Run Run Source automatically".
                  aria-label={`${spec.label}: run automatically when inputs change`}
                  checked={selected.auto}
                  onChange={(e) => setNodeAuto(selected.id, e.target.checked)}
                />
                <span className="v num">{selected.auto ? "auto" : "paused"}</span>
              </div>
              {runtime?.error && <div className="inspector-note error">{runtime.error}</div>}
            </div>

            {spec.controls && spec.controls.length > 0 && (
              <div className="inspector-section">
                <h3>
                  Parameters
                  <HelpDot label="What these are">
                    <p>
                      The settings of the selected node — {spec.label} right now. Click a
                      different node in the Graph and these change with it.
                    </p>
                    <p>Hover any underlined label to see what that setting does.</p>
                  </HelpDot>
                </h3>
                {spec.controls.map((control) => (
                  <Control
                    key={control.key}
                    spec={control}
                    value={selected.params[control.key]}
                    onChange={(v) => setNodeParamAndRun(selected.id, control.key, v)}
                  />
                ))}
                {/*
                  DA3 is driven from the Run section above, which carries the preconditions and
                  the phase readout. A second, unguarded Run button here would be a way to reach
                  the GPU past the checks.
                */}
                {spec.execution === "manual" && selected.id !== "da3-depth" && (
                  <div className="inspector-actions">
                    <button disabled={graph.running} onClick={() => void runNode(selected.id)}>
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
        {(remote || cloud.firstContactAt !== null) && (
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
                Idle {idleMinutes} min — still billing. Save any runs you want to keep, then delete
                the service.
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
                {status.deploy.detail && <div className="inspector-note">{status.deploy.detail}</div>}
                <div className="inspector-actions">
                  <button disabled={deployState.statusBusy} onClick={() => void loadStatus(true)}>
                    {deployState.statusBusy ? "Checking…" : "Refresh status"}
                  </button>
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
                {deployState.job && (
                  <>
                    <Row k={deployState.jobKind ?? "job"} v={deployState.job.status} />
                    <pre className="job-log">
                      {deployState.log.slice(-14).join("\n") || "starting…"}
                    </pre>
                  </>
                )}
              </>
            ) : (
              <Row k="—" v={deployState.statusError ? "unavailable" : "checking…"} />
            )}
            {deployState.statusError && (
              <div className="inspector-note error">{deployState.statusError}</div>
            )}
            {deployState.error && <div className="inspector-note error">{deployState.error}</div>}
          </div>
        )}

        {advanced && (
          <div className="inspector-section">
            <h3>
              Cloud session
              <HelpDot label="What these actions cost">
                <p>{COST_BASIS}</p>
                <p>
                  <b>Checking costs nothing.</b> The Cloud control rows read gcloud metadata and
                  never touch the service, so they cannot wake an instance.
                </p>
                <p>
                  <b>Warm up</b> loads the model into VRAM: measured 64 s cold start plus 40 s
                  model load against ~31 s of inference, so warming before you need it usually
                  pays. <b>Release model</b> frees VRAM but does not stop billing. Deleting the
                  service is the only thing that does, and that is the status bar's control.
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
                  <button disabled={busy} onClick={() => disconnectCloud()}>
                    Use local fixture
                  </button>
                </div>
                {/* Not moved behind a `?`: it corrects a belief the button itself creates, at the
                    moment it is about to be clicked, about the one thing here that costs money. */}
                <div className="inspector-note">
                  “Use local fixture” only points this app elsewhere — the instance keeps running
                  and keeps billing until the service is deleted from the status bar.
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
                      Connecting starts nothing by itself, but the first request wakes an instance
                      and Cloud Run then bills its whole lifetime.
                    </p>
                    <p>
                      These two fields are the manual path, kept for a service this Mac's gcloud
                      cannot see. Otherwise prefer the status bar's Deploy control, which finds the
                      service itself and keeps the credential out of the browser entirely.
                    </p>
                  </HelpDot>
                </span>
                {cloud.deleted && (
                  <div className="inspector-note">Service deleted this session. Meter stopped.</div>
                )}
              </>
            )}
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
                <Row k="Lifecycle" v={state} />
              </>
            ) : (
              <Row k="State" v={remote ? "not polled — press Refresh" : "unreachable"} />
            )}
            {!remote && <MockDevSwitches />}
          </div>
        )}

        {/*
          "Current run", not "Last run". It is the manifest the viewers are showing right now —
          Run Source points at the live branch by default — so calling it "last" described it as
          history when it is the subject.
        */}
        <div className="inspector-section">
          <h3>Current run</h3>
          {currentRun ? (
            <>
              <Row k="Frames" v={`${currentRun.frames.count}`} />
              <Row k="GPU time" v={`${currentRun.timing.gpuSeconds.toFixed(2)} s`} />
              <Row k="Wall" v={`${currentRun.timing.wallSeconds.toFixed(2)} s`} />
              <Row k="Peak VRAM" v={formatBytes(currentRun.vram.peakBytes)} />
              {/* Where the hardware name belongs: on the run that used it, not in the header. */}
              <Row k="GPU" v={currentRun.vram.deviceName || "—"} />
              <Row k="Model" v={currentRun.modelRevision.slice(0, 8)} title={MODEL_REPOSITORY_ID} />
              {currentRun.mock && (
                <div className="inspector-note">
                  MOCK — this is the roadside fixture, not a reconstruction of the loaded clip.
                </div>
              )}
              {advanced && currentField && (
                <Row
                  k="Camera track"
                  v={`${currentField.frames.length} poses`}
                  title="Position and orientation of the camera for every frame, recovered by the model alongside depth. A non-model depth source — LiDAR, stereo — would have to supply these too; depth on its own does not place a scene."
                />
              )}
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

/**
 * The words shown before money can start being spent.
 *
 * Deploying does not bill by itself, and saying so is the point — an operator who believes the
 * deploy is the expensive act will delete the service and redeploy repeatedly, which is the
 * worst pattern available. What costs is the instance, from its first request until it is
 * deleted.
 */
export function DEPLOY_CONFIRM(name: string, estimate: string): string {
  return (
    `Deploy ${name}?\n\n` +
    `${estimate}.\n\n` +
    "Deploying does not bill by itself. The first request wakes an L4 instance, and Cloud Run " +
    "then bills its WHOLE LIFETIME — cold start and idle tail included, not inference seconds.\n\n" +
    "Batch every run you need, save the ones you want to keep, then delete the service."
  );
}

export const TEARDOWN_CONFIRM =
  "Delete the Cloud Run service?\n\n" +
  "This is the only thing that stops billing. Any run artifacts still only on the instance " +
  "will be lost — save them first.\n\n" +
  "The ~12 GB image is kept, so the next deploy takes about a minute rather than twenty.";
