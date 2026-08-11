/**
 * What must be true before a run, and what the run is doing while it runs.
 *
 * Two components, one subject: the gap between pressing a button and knowing what happened. It
 * used to be filled by the word "Running…" for up to two minutes, and before that by an HTTP
 * error for anyone who did not know a GPU had to be deployed first.
 *
 * The rule both of them obey is DESIGN.md honesty rule 1: nothing here advances on a timer. The
 * upload bar is the only proportion drawn anywhere, and it is real bytes over real bytes. Every
 * other phase shows elapsed time beside a figure explicitly labelled as measured, because a bar
 * that fills on a clock is a prediction wearing a measurement's clothes.
 */

import { useEffect, useState } from "react";
import { formatBytes } from "../lib/contract";
import {
  EXPECTED,
  PHASE_LABEL,
  phaseElapsedMs,
  totalElapsedMs,
  type RunPhaseState,
} from "../lib/run-phase";
import type { Precondition } from "../lib/run-inference";

/** Re-render once a second while something is happening. Local arithmetic; touches no network. */
function useTick(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

function seconds(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/**
 * The three facts that decide whether Run may be pressed.
 *
 * Shown as a list rather than enforced silently, because the ordering — clip, then frames, then
 * somewhere to send them — is the thing nobody knew. A disabled button that does not say what is
 * missing is the failure this replaces, not an improvement on it.
 */
export function PreconditionList({
  steps,
  onFix,
}: {
  steps: Precondition[];
  /** Offered beside a step that the app itself can satisfy — today, deploying a service. */
  onFix?: (step: Precondition) => React.ReactNode;
}) {
  return (
    <div className="precondition-list">
      {steps.map((step) => (
        <div key={step.id} className={`precondition${step.ok ? " ok" : ""}`}>
          {/* The glyph carries the state, not the colour — DESIGN.md acceptance item 2. A
              mock-backed step is satisfied and is emphatically not "current", so it takes the
              working glyph rather than the ok one. */}
          <span className="precondition-glyph" aria-hidden="true">
            {step.ok ? (step.mock ? "◐" : "●") : "○"}
          </span>
          <span className="k">{step.label}</span>
          <span className="v" title={step.detail}>
            {step.detail}
          </span>
          {!step.ok && step.fix && <span className="precondition-fix">{step.fix}</span>}
          {onFix?.(step)}
        </div>
      ))}
    </div>
  );
}

/**
 * The live phase readout.
 *
 * Every phase names itself, carries its own elapsed clock, and — where one exists — the measured
 * duration of that phase on a real L4, labelled as measured. A failure keeps the phase it died
 * in, which is the fact a bare stack trace loses: "failed while uploading" and "failed while
 * inferring" send an operator to completely different places.
 */
export function PhaseReadout({ phase }: { phase: RunPhaseState }) {
  const active = phase.kind !== "idle" && phase.kind !== "done" && phase.kind !== "failed";
  useTick(active);

  if (phase.kind === "idle") return null;

  const expected = EXPECTED[phase.kind];
  const elapsed = phaseElapsedMs(phase);
  const total = totalElapsedMs(phase);

  if (phase.kind === "failed") {
    return (
      <div className="phase-readout failed">
        <div className="phase-line">
          <span className="phase-glyph" aria-hidden="true">
            ▲
          </span>
          <span className="k">failed while {PHASE_LABEL[phase.failedIn ?? "idle"]}</span>
          <span className="v num">{seconds(phase.lastWallMs)}</span>
        </div>
        <div className="inspector-note error">{phase.message}</div>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="phase-readout done">
        <div className="phase-line">
          <span className="phase-glyph" aria-hidden="true">
            ●
          </span>
          <span className="k">run complete</span>
          <span className="v num">{seconds(phase.lastWallMs)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="phase-readout running">
      <div className="phase-line">
        <span className="phase-glyph busy" aria-hidden="true">
          ◐
        </span>
        <span className="k">{PHASE_LABEL[phase.kind]}</span>
        <span className="v num">{seconds(elapsed)}</span>
      </div>

      {phase.kind === "reading" && (
        <div className="phase-detail mono">
          {phase.read.done} / {phase.read.total} frames off local disk
        </div>
      )}

      {phase.kind === "uploading" && (
        <>
          {/* The one honest proportion in the whole chain: bytes acknowledged by the socket
              over bytes handed to it. Everything else below is elapsed against a measurement. */}
          <div className="phase-track">
            <div
              className="phase-fill"
              style={{
                width: `${
                  phase.upload.totalBytes > 0
                    ? Math.min(100, (phase.upload.sentBytes / phase.upload.totalBytes) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
          <div className="phase-detail mono">
            {formatBytes(phase.upload.sentBytes)} / {formatBytes(phase.upload.totalBytes)}
          </div>
        </>
      )}

      {expected && (
        <div className="phase-detail">
          {expected.note} — this clock is elapsed time, not progress
        </div>
      )}

      {phase.kind === "inferring" && phase.gpu && (
        <div className="phase-detail mono">
          VRAM {formatBytes(phase.vramFloorBytes ?? phase.gpu.currentBytes)} →{" "}
          {formatBytes(phase.gpu.currentBytes)}
        </div>
      )}

      {phase.kind === "waking" && !phase.gpu && (
        <div className="phase-detail">
          Nothing is answering yet. Cloud Run is starting the container; it has not lost the
          request.
        </div>
      )}

      {total !== null && total > 0 && (
        <div className="phase-detail mono">total {seconds(total)}</div>
      )}
    </div>
  );
}
