/**
 * Client for the local cloud control plane (`/api/cloud/*`, dev middleware only).
 *
 * The point of this module is that none of it costs anything and none of it holds a
 * credential. Status is metadata reads that never touch the service; jobs are local scripts;
 * the authenticated path to the service is a same-origin prefix that the dev server signs.
 */

import { localApiHeaders } from "./local-api";

/** Everything the app can know about the cloud without waking an instance. */
export interface CloudStatus {
  checkedAt: number;
  /** False when the repository-local resource identifiers have not been configured yet. */
  configured: boolean;
  gcloud: { available: boolean; error: string | null };
  auth: { active: boolean; account: string | null; hint?: string | null };
  project: string;
  region: string;
  service: { name: string; exists: boolean; url: string | null };
  /** `present` is deploy.sh's own build-skip predicate, evaluated against the live registry. */
  image: { uri: string; tag: string | null; present: boolean };
  deploy: { willSkipBuild: boolean; estimate: string; detail?: string };
}

export type JobStatus = "running" | "succeeded" | "failed";

export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: string | null;
  droppedLines: number;
  lines: string[];
}

/**
 * The base every GPU call takes when the app is pointed at a real service.
 *
 * It is a same-origin path, not an absolute URL, because the credential lives in the dev
 * server. `artifactUrl()` prefixes manifest-relative artifact paths with it exactly as it did
 * with an absolute base, so nothing downstream had to learn about the change.
 */
export const PROXY_BASE = "/api/cloud/svc";

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchCloudStatus(refresh = false): Promise<CloudStatus> {
  return (await expectOk(
    await fetch(`/api/cloud/status${refresh ? "?refresh=1" : ""}`),
  )) as CloudStatus;
}

async function startJob(path: string): Promise<{ job: JobView; attached: boolean }> {
  return (await expectOk(await fetch(path, { method: "POST", headers: localApiHeaders() }))) as {
    job: JobView;
    attached: boolean;
  };
}

/** Deploy. Returns as soon as the job exists — the build itself takes minutes. */
export function startDeploy(): Promise<{ job: JobView; attached: boolean }> {
  return startJob("/api/cloud/deploy");
}

/** Delete the service. The only action that stops the meter. */
export function startTeardown(): Promise<{ job: JobView; attached: boolean }> {
  return startJob("/api/cloud/teardown");
}

/** A job of this kind still running — what a page asks after a reload. */
export async function runningJob(kind: string): Promise<JobView | null> {
  const body = (await expectOk(await fetch(`/api/cloud/job?kind=${encodeURIComponent(kind)}`))) as {
    job: JobView | null;
  };
  return body.job;
}

/**
 * Follow a job to completion.
 *
 * The stream opens with a snapshot of every line buffered so far, so attaching late — after a
 * refresh, or from a second pane — shows the whole log rather than the tail.
 */
export function streamJob(
  id: string,
  onLine: (line: string) => void,
): Promise<{ status: JobStatus; exitCode: number | null; error: string | null }> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/cloud/job/${encodeURIComponent(id)}?stream=1`);
    let settled = false;

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: "snapshot"; job: JobView }
        | { type: "line"; line: string }
        | { type: "end"; status: JobStatus; exitCode: number | null; error: string | null };

      if (payload.type === "snapshot") {
        for (const line of payload.job.lines) onLine(line);
        return;
      }
      if (payload.type === "line") return onLine(payload.line);

      settled = true;
      source.close();
      resolve({ status: payload.status, exitCode: payload.exitCode, error: payload.error });
    };

    source.onerror = () => {
      if (settled) return;
      settled = true;
      source.close();
      reject(new Error("lost the job stream — the dev server may have restarted"));
    };
  });
}
