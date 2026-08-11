/**
 * The GPU service's whole life, as one control in the status bar, beside the chip that reports it.
 *
 * It used to live three clicks deep in Advanced → Cloud control, so a first-time operator could
 * not start a GPU at all: pressing Run produced an HTTP error from inside the client, and the fix
 * was somewhere they had no reason to look.
 *
 * ## Four states, because "deployed" cannot carry two facts
 *
 * | State | Reads | Costs | Click |
 * |---|---|---|---|
 * | `absent` | `Deploy` | nothing | confirm, then build and deploy |
 * | `deploying` | `Deploying · m:ss` | nothing | disabled |
 * | `deployed` | `● Deployed · not billing` | nothing | confirm, then delete |
 * | `live` | `◐ Live · m:ss` **glow** | the instance's whole lifetime | confirm, then delete |
 *
 * The glow is on `live` and not on `deployed`, and that is the whole design. Creating a Cloud
 * Run service is free; the meter starts when a request wakes an instance, and Cloud Run then
 * bills that instance's entire lifetime. A control that lit up at "deployed" would teach an
 * operator that deploying is the expensive act and that a quiet deployed service is safe — both
 * backwards, and the second one is how a machine gets left running overnight.
 *
 * The state survives a reload: `lifecycle` reads the free status call, so a service left alive by
 * an earlier session reads as Deployed on load rather than inviting a second one beside it.
 */

import { useEffect, useState } from "react";
import { useCloud } from "../lib/cloud-store";
import { deploy, lifecycle, loadStatus, reattach, teardown, useDeploy } from "../lib/deploy-store";
import { DEPLOY_CONFIRM, TEARDOWN_CONFIRM } from "./setup";

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function DeployControl() {
  const deployState = useDeploy();
  const cloud = useCloud();
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

  // Free on mount: gcloud metadata only, and it cannot wake an instance. This is what makes it
  // possible to answer "is something of mine still running?" without starting anything.
  useEffect(() => {
    void loadStatus();
    void reattach();
  }, []);

  const state = lifecycle(deployState, cloud);
  const ticking = state === "deploying" || state === "deleting" || state === "live";
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // The store keeps the message and both surfaces render it. Throwing out of a click
      // handler would only reach the console.
    } finally {
      setBusy(false);
    }
  };

  const startDeploy = () =>
    act(async () => {
      const name = deployState.status?.service.name ?? "the service";
      const estimate = deployState.status?.deploy.estimate ?? "Duration unknown";
      if (!window.confirm(DEPLOY_CONFIRM(name, estimate))) return;
      await deploy();
    });

  const startTeardown = () =>
    act(async () => {
      if (!window.confirm(TEARDOWN_CONFIRM)) return;
      await teardown();
    });

  if (state === "unknown") {
    return (
      <span className="chip deploy-chip" title="Asking gcloud whether a service exists. This read is free and cannot wake anything.">
        <span className="dot" /> service: checking…
      </span>
    );
  }

  if (state === "unavailable") {
    const hint = deployState.status?.auth.hint ?? deployState.status?.gcloud.error ?? "";
    return (
      <span
        className="chip deploy-chip"
        title={`${hint} — signing in needs a browser consent screen, so no button here can do it for you.`}
      >
        <span className="dot" /> service: gcloud not ready
      </span>
    );
  }

  if (state === "deploying" || state === "deleting") {
    const elapsed = deployState.jobStartedAt === null ? 0 : Date.now() - deployState.jobStartedAt;
    const estimate = deployState.status?.deploy.estimate ?? "";
    return (
      <span
        className="chip deploy-chip busy"
        title={
          state === "deploying"
            ? `${estimate}. The log is in Setup → Cloud control (Advanced).`
            : "Deleting the service. This is what stops the meter."
        }
      >
        <span className="dot" /> {state === "deploying" ? "Deploying" : "Deleting"} ·{" "}
        <span className="mono">{clock(elapsed)}</span>
      </span>
    );
  }

  if (state === "absent") {
    return (
      <button
        className="chip deploy-chip action"
        disabled={busy}
        title="Build if needed, deploy a Cloud Run service with an L4, and point this app at it. Deploying itself does not bill — the first request is what wakes an instance and starts the meter."
        onClick={() => void startDeploy()}
      >
        <span className="dot" /> Deploy
      </button>
    );
  }

  if (state === "deployed") {
    return (
      <button
        className="chip deploy-chip ready"
        disabled={busy}
        title="The service exists and nothing has woken an instance yet, so nothing is billing. Click to delete it. The ~12 GB image is kept, so redeploying takes about a minute."
        onClick={() => void startTeardown()}
      >
        <span className="dot" /> Deployed · not billing
      </button>
    );
  }

  const since = cloud.firstContactAt;
  return (
    <button
      className="chip deploy-chip live"
      disabled={busy}
      title="An instance is awake and Cloud Run is billing its whole lifetime, whatever this app is doing. Click to delete the service — the only action that stops the meter."
      onClick={() => void startTeardown()}
    >
      <span className="dot" /> Live ·{" "}
      <span className="mono">{since === null ? "0:00" : clock(Date.now() - since)}</span>
    </button>
  );
}
