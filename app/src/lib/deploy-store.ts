/**
 * The GPU service's lifecycle, in one place: does it exist, is it being built, is it billing.
 *
 * This used to be four `useState` hooks inside `panes/inspector.tsx`. That had two costs. A
 * deploy started there was lost the moment the pane was hidden — the pane unmounts, and with it
 * the only handle on a twenty-minute job. And the status bar could not show the service at all,
 * so the control that starts a GPU lived three clicks deep in Advanced while the chip that
 * reports one sat in the status bar.
 *
 * ## The distinction the rest of the app depends on
 *
 * **Deployed is not billing.** Creating a Cloud Run service costs nothing. The meter starts when
 * a request wakes an instance, and Cloud Run then bills that instance's whole lifetime — cold
 * start and idle tail included. One word cannot carry both facts, so `lifecycle()` returns them
 * as two states, `deployed` and `live`, and only the second one is allowed to glow.
 *
 * Everything here except `deploy` and `teardown` is free. The status read asks gcloud about the
 * service and the registry; it never touches the service, so it cannot wake an instance or extend
 * a billed lifetime. That is what makes it safe to answer "what would this cost me?" on mount.
 */

import { useSyncExternalStore } from "react";
import {
  PROXY_BASE,
  fetchCloudStatus,
  runningJob,
  startDeploy,
  startTeardown,
  streamJob,
  type CloudStatus,
  type JobView,
} from "./cloud-control";
import {
  connectProxied,
  getCloud,
  isBilling,
  markServiceDeleted,
  setCloudState,
  type CloudSession,
} from "./cloud-store";

/**
 * What the operator is looking at, as one word.
 *
 * `unknown` is deliberately distinct from `absent`: before the first status read we do not know
 * whether a service is alive, and a control that reads "Deploy" in that moment would invite a
 * second service beside one already billing.
 */
export type Lifecycle =
  | "unknown"
  | "unavailable"
  | "absent"
  | "deploying"
  | "deployed"
  | "live"
  | "deleting";

export interface DeployState {
  status: CloudStatus | null;
  statusError: string | null;
  statusBusy: boolean;
  /** The running or last-finished job, whichever is more recent. */
  job: JobView | null;
  jobKind: "deploy" | "teardown" | null;
  log: string[];
  /** Local wall time the current job started, for the elapsed readout. */
  jobStartedAt: number | null;
  error: string | null;
}

const state: DeployState = {
  status: null,
  statusError: null,
  statusBusy: false,
  job: null,
  jobKind: null,
  log: [],
  jobStartedAt: null,
  error: null,
};

let snapshot: DeployState = { ...state };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDeploy(): DeployState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function getDeploy(): DeployState {
  return snapshot;
}

/**
 * One word for the whole lifecycle, from the service's existence and the session's billing flag.
 *
 * `cloud` is passed in rather than read from the module so a component re-renders on either
 * store changing. `isBilling` is deliberately pessimistic — it stays true after the app is
 * pointed back at the mock, because that is exactly when somebody is most likely to walk away
 * from a live instance.
 */
export function lifecycle(deploy: DeployState, cloud: CloudSession): Lifecycle {
  if (deploy.job?.status === "running") {
    return deploy.jobKind === "teardown" ? "deleting" : "deploying";
  }
  if (isBilling(cloud)) return "live";
  if (!deploy.status) return "unknown";
  if (!deploy.status.gcloud.available || !deploy.status.auth.active) return "unavailable";
  return deploy.status.service.exists ? "deployed" : "absent";
}

export function unavailableServiceText(status: CloudStatus | null): string {
  return status?.configured === false
    ? "service: cloud not configured"
    : "service: gcloud not ready";
}

export function unavailableServiceHint(status: CloudStatus | null): string {
  if (status?.configured === false) {
    return "Copy .env.local.example to .env.local, set PROJECT_ID and VERGE_OUTPUT_BUCKET, then restart the app.";
  }
  const hint = status?.auth.hint ?? status?.gcloud.error ?? "gcloud is not ready";
  return `${hint} — signing in needs a browser consent screen, so no button here can do it for you.`;
}

/** Free: gcloud metadata only. Safe on mount, and cannot wake anything. */
export async function loadStatus(refresh = false): Promise<void> {
  state.statusBusy = true;
  emit();
  try {
    state.status = await fetchCloudStatus(refresh);
    state.statusError = null;
  } catch (e) {
    state.statusError = e instanceof Error ? e.message : String(e);
  } finally {
    state.statusBusy = false;
    emit();
  }
}

function beginJob(kind: "deploy" | "teardown", job: JobView): void {
  state.job = job;
  state.jobKind = kind;
  state.log = [...job.lines];
  state.jobStartedAt = Date.now();
  state.error = null;
  emit();
}

async function follow(id: string): Promise<{ ok: boolean; detail: string | null }> {
  const result = await streamJob(id, (line) => {
    state.log = [...state.log, line];
    emit();
  });
  state.job = state.job ? { ...state.job, status: result.status } : state.job;
  emit();
  return {
    ok: result.status === "succeeded",
    detail: result.error ?? (result.exitCode === null ? null : `exit ${result.exitCode}`),
  };
}

/**
 * Build and deploy, then point the app at the result.
 *
 * Auto-connecting is a correctness measure rather than a convenience: a deployed service the app
 * is NOT pointed at is precisely the state that produced the 2026-08-05 mock-run misdiagnosis,
 * where the mock answered /infer and returned an unrelated scene's geometry.
 *
 * It deliberately does NOT warm the instance. Deploying is free; the first request is what starts
 * the meter, and that stays an act the operator chooses.
 */
export async function deploy(): Promise<void> {
  const { job } = await startDeploy();
  beginJob("deploy", job);
  let failure: string | null = null;
  try {
    const { ok, detail } = await follow(job.id);
    if (!ok) failure = `deploy failed (${detail ?? "unknown"})`;
  } catch (e) {
    /**
     * The stream dropped, which says nothing about the deploy.
     *
     * Observed on the first real deploy, 2026-08-11: `gcloud run deploy` succeeded in 33 s and
     * the service was live, but the EventSource errored, `loadStatus` never ran, and the status
     * bar went back to reading `Deploy` — telling the operator there was no service while one
     * was deployed and one request away from billing. Inviting a second deployment beside a
     * forgotten first is the worst failure this control can have, so the status refresh below is
     * unconditional. The mock could never have shown this; its stream does not drop.
     */
    failure = `lost the deploy log (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    await loadStatus(true);
  }

  const url = state.status?.service.url;
  if (url) {
    connectProxied(url, PROXY_BASE);
    setCloudState("cold");
  }

  // A service that exists is the outcome that matters. A lost log beside a live service is a
  // reporting problem, not a deploy problem, and must not be reported as one.
  if (failure && !state.status?.service.exists) {
    state.error = failure;
    emit();
    throw new Error(failure);
  }
  if (failure) {
    state.error = `${failure} — but the service is up and reachable.`;
    emit();
  }
}

/**
 * Delete the service. The only action that stops the meter.
 *
 * The ~12 GB image is kept, so the next deploy still takes the build-skip branch. Anything still
 * only on the instance dies with it, which is why the caller confirms first.
 */
export async function teardown(): Promise<void> {
  const { job } = await startTeardown();
  beginJob("teardown", job);
  let failure: string | null = null;
  try {
    const { ok, detail } = await follow(job.id);
    if (!ok) failure = `teardown failed (${detail ?? "unknown"})`;
  } catch (e) {
    failure = `lost the teardown log (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    await loadStatus(true);
  }

  /**
   * The registry is the authority on whether the meter stopped, not the log.
   *
   * Erring the other way here would be the expensive mistake: claiming a deletion that did not
   * happen leaves an L4 billing with nothing on screen saying so.
   */
  if (state.status?.service.exists) {
    state.error = failure ?? "the service is still there — it was not deleted";
    emit();
    throw new Error(state.error);
  }
  markServiceDeleted();
  if (failure) {
    state.error = `${failure} — but the service is gone and the meter has stopped.`;
    emit();
  }
}

/**
 * Reattach to a job that outlived the page.
 *
 * A deploy takes up to twenty minutes and a reload during one is not unusual. The job runner is
 * single-flight, so the honest thing is to show the job that is already running rather than
 * offering to start a second.
 */
export async function reattach(): Promise<void> {
  for (const kind of ["deploy", "teardown"] as const) {
    const job = await runningJob(kind).catch(() => null);
    if (!job) continue;
    beginJob(kind, job);
    const { ok } = await follow(job.id);
    if (ok && kind === "teardown") markServiceDeleted();
    await loadStatus(true);
    return;
  }
}

/** True when a run may reach a GPU: the local mock, or a service this app is connected to. */
export function canInfer(cloud: CloudSession = getCloud()): boolean {
  return cloud.baseUrl === null || cloud.state !== "unreachable";
}
