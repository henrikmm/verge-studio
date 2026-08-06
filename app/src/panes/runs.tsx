/**
 * Runs pane — what evidence exists, what it costs on disk, and how to get rid of it.
 *
 * The storage policy in CLAUDE.md is "transient by default, persist only on explicit Save".
 * Before this pane the second half was unimplemented: there was no Save, no Delete, and no way
 * to see what a run had consumed. `scripts/save-run.sh` was the whole story, run by hand
 * during the exact window when a GPU instance is billing.
 */

import { useState } from "react";
import { refreshRuns, useRuns } from "../lib/runs-store";
import { deleteRun, estimateSaveBytes, formatBytes, saveRun, type RunRecord } from "../lib/runs";
import { setNodeParam, runAuto, useGraph } from "../graph/graph-store";
import { FIXTURE_RUN_ID } from "../graph/nodes";
import { DEFAULT_RUN_ID } from "../graph/nodes/fixture-run";
import { PaneControls } from "./pane-chrome";

function RunRow({
  run,
  active,
  busy,
  onSelect,
  onSave,
  onDelete,
}: {
  run: RunRecord;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const estimate = estimateSaveBytes(run);
  /**
   * Where an unsaved run's bytes actually are, which changed on 2026-08-06 and used to be
   * one answer for everybody: "on the instance, dies with it".
   *
   * Saving is still the only way to KEEP a run. What differs now is the consequence of not
   * saving yet, and a "degraded" run is the case that must not look like the healthy one —
   * it carries exactly the old urgency while sitting in a list where nothing else does.
   */
  const publishMode = run.manifest?.diagnostics?.publishMode;
  const degraded = !run.persisted && publishMode === "degraded";
  const saveHint = run.persisted
    ? ""
    : degraded
      ? `Download this run's artifacts to disk — about ${formatBytes(estimate)}. Publishing to durable storage FAILED for this run, so they exist only on the cloud instance and die with it. Save before teardown.`
      : publishMode === "gcs"
        ? `Download this run's artifacts to disk — about ${formatBytes(estimate)}. They are in durable storage and survive teardown, but only until the bucket expires them in ${run.manifest?.expiresAfterDays ?? 3} days.`
        : `Download this run's artifacts to disk — about ${formatBytes(estimate)}. Until then they exist only on the cloud instance and die with it.`;
  return (
    <div className={`run-row${active ? " active" : ""}`}>
      <button className="run-pick" onClick={onSelect} disabled={!run.persisted || !run.available}>
        <span className="run-label">
          <b>{run.label}</b>
          <small>
            {run.clipName || "—"}
            {run.frameCount ? ` · ${run.frameCount}f` : ""}
            {run.processRes ? ` · ${run.processRes} px` : ""}
          </small>
        </span>
        <span className="run-state mono">
          {run.builtin
            ? "built-in"
            : run.persisted
              ? run.available
                ? formatBytes(run.sizeBytes)
                : "payload missing"
              : degraded
                ? "▲ transient"
                : "transient"}
        </span>
      </button>
      <span className="run-actions">
        {!run.persisted && (
          <button
            className="pane-btn"
            disabled={busy}
            title={saveHint}
            onClick={onSave}
          >
            Save {formatBytes(estimate)}
          </button>
        )}
        {!run.builtin && (
          <button className="pane-btn danger" disabled={busy} onClick={onDelete} title="Delete this run's bytes from disk">
            Delete
          </button>
        )}
      </span>
    </div>
  );
}

export function RunsPane() {
  const runs = useRuns();
  const graph = useGraph();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const fixture = graph.nodes.find((node) => node.id === FIXTURE_RUN_ID);
  const activeId = String(fixture?.params.runId ?? DEFAULT_RUN_ID);

  const savedBytes = runs.runs.reduce((total, run) => total + (run.sizeBytes || 0), 0);
  const transient = runs.runs.filter((run) => !run.persisted).length;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      await refreshRuns();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <PaneControls
        status={runs.loading ? "Loading" : "Idle"}
        elapsedMs={0}
        paused={false}
        paneId="runs"
        onPause={() => void refreshRuns()}
        extra={
          <span className="pane-note">
            {runs.runs.length} runs · {formatBytes(savedBytes)} on disk
            {transient > 0 ? ` · ${transient} transient` : ""}
          </span>
        }
      />
      <div className="pane-body runs-pane">
        <div className="runs-root mono" title="Runs live outside the repository so a 135 MB artifact can never be staged by accident.">
          {runs.root || "~/verge-runs"}
        </div>
        {runs.error && <div className="evidence-warning">{runs.error}</div>}
        {note && <div className="evidence-warning">{note}</div>}
        {runs.runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            active={run.id === activeId}
            busy={busy}
            onSelect={() => {
              setNodeParam(FIXTURE_RUN_ID, "runId", run.id);
              setNodeParam(FIXTURE_RUN_ID, "source", "recorded");
              void runAuto();
            }}
            onSave={() =>
              void act(async () => {
                const { output } = await saveRun(run.id);
                setNote(output.slice(-400));
              })
            }
            onDelete={() =>
              void act(async () => {
                if (
                  !window.confirm(
                    `Delete ${run.label}?\n\nThis removes its artifacts from disk permanently. Recorded measurements that reference it stay, but become unverifiable.`,
                  )
                ) {
                  return;
                }
                await deleteRun(run.id);
              })
            }
          />
        ))}
        <small className="honesty-note">
          Runs are transient by default. A completed cloud run is registered here as a manifest
          stub so it stays selectable, but nothing large is written until you press Save. A stub's
          artifacts sit in cloud storage and are deleted after three days — sooner if you delete
          the bucket. A stub marked ▲ failed to reach storage and dies with its instance instead,
          so save that one before teardown.
        </small>
      </div>
    </div>
  );
}
