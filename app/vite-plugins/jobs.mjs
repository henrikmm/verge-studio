// Long-running local scripts, watchable from the browser.
//
// `POST /api/teardown` used to be a blocking execFile with a 180 s cap. That is fine for a
// 30 s delete and impossible for a deploy: the build branch runs 15-20 minutes, and even the
// build-skip branch (~1-3 min) is long enough that a browser refresh mid-request orphans the
// child with no way to reattach. So a job is a first-class object here: it outlives the
// request that started it, buffers its own output, and any number of clients can attach.
//
// Three properties are load-bearing, in this order:
//
// 1. **Single-flight per kind.** Two concurrent `gcloud run deploy`s would race over one
//    service. A second start attaches to the running job instead of spawning.
// 2. **Nothing from the browser reaches the child's argv or env.** The routes pass fixed
//    scripts and fixed environments. FORCE_BUILD and PURGE_IMAGE are the two variables that
//    could cost 20 minutes or destroy the cached image, and neither is settable from a click.
// 3. **Output is redacted before it leaves this process.** gcloud is not expected to print a
//    credential, but a log streamed to a browser is the wrong place to find out otherwise.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Keep the tail of a chatty build rather than the whole thing. */
const MAX_LINES = 2000;

/** id -> job */
const jobs = new Map();
/** kind -> id of the job currently running for that kind */
const running = new Map();

/**
 * Strip anything credential-shaped.
 *
 * `deploy.sh` ends by printing a literal `export VERGE_TOKEN="$(gcloud auth ...)"` line —
 * that is shell source text, not a token, and it survives untouched. An actual OAuth token
 * or JWT does not. Defense in depth: the proxy already keeps tokens out of the browser, and
 * this keeps them out of the log that describes it.
 */
export function redact(line) {
  return line
    .replace(/ya29\.[A-Za-z0-9._-]{10,}/g, "«redacted-token»")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "«redacted-jwt»");
}

function publicView(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    error: job.error,
    droppedLines: job.droppedLines,
    lines: job.lines,
  };
}

function append(job, text) {
  job.pending += text;
  const parts = job.pending.split("\n");
  job.pending = parts.pop() ?? "";
  for (const part of parts) {
    const line = redact(part.replace(/\r/g, ""));
    job.lines.push(line);
    if (job.lines.length > MAX_LINES) {
      job.lines.shift();
      job.droppedLines += 1;
    }
    for (const listener of job.listeners) listener({ type: "line", line });
  }
}

function finish(job, status, exitCode, error) {
  if (job.status !== "running") return;
  if (job.pending) append(job, "\n");
  job.status = status;
  job.exitCode = exitCode;
  job.error = error ?? null;
  job.endedAt = Date.now();
  if (job.timer) clearTimeout(job.timer);
  if (running.get(job.kind) === job.id) running.delete(job.kind);
  for (const listener of job.listeners) listener({ type: "end", status, exitCode, error: job.error });
  job.listeners.clear();
}

/**
 * Start a job, or attach to the one already running for this kind.
 *
 * `attached: true` in the result means no new process was spawned — the caller is watching
 * something that was already in flight, which is exactly what a double-clicked button must do.
 */
export function startJob({ kind, command, args = [], cwd, env = {}, timeoutMs = 45 * 60_000 }) {
  const current = running.get(kind);
  if (current) {
    const existing = jobs.get(current);
    if (existing && existing.status === "running") {
      return { job: publicView(existing), attached: true };
    }
  }

  const job = {
    id: `${kind}-${randomUUID().slice(0, 8)}`,
    kind,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    error: null,
    lines: [],
    droppedLines: 0,
    pending: "",
    listeners: new Set(),
    child: null,
    timer: null,
  };
  jobs.set(job.id, job);
  running.set(kind, job.id);

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      // A fixed environment plus a fixed allowlist. Nothing from a request body lands here.
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    finish(job, "failed", null, err instanceof Error ? err.message : String(err));
    return { job: publicView(job), attached: false };
  }

  job.child = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append(job, chunk));
  child.stderr.on("data", (chunk) => append(job, chunk));
  child.on("error", (err) => finish(job, "failed", null, err.message));
  child.on("close", (code, signal) => {
    if (job.status !== "running") return;
    if (code === 0) return finish(job, "succeeded", 0, null);
    finish(job, "failed", code, signal ? `killed by ${signal}` : `exit ${code}`);
  });

  job.timer = setTimeout(() => {
    if (job.status !== "running") return;
    append(job, `\n== job exceeded ${Math.round(timeoutMs / 60_000)} min, killing ==\n`);
    child.kill("SIGTERM");
    finish(job, "failed", null, "timed out");
  }, timeoutMs);
  // The timer must never hold the dev server open by itself.
  if (typeof job.timer.unref === "function") job.timer.unref();

  return { job: publicView(job), attached: false };
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicView(job) : null;
}

/** The job currently running for a kind, if any. Lets a reloaded page find its deploy again. */
export function getRunningJob(kind) {
  const id = running.get(kind);
  if (!id) return null;
  const job = jobs.get(id);
  return job && job.status === "running" ? publicView(job) : null;
}

/**
 * Attach a listener. Returns an unsubscribe, and replays nothing — callers read the buffered
 * lines from `getJob` first, so a late attach still sees the whole log.
 */
export function subscribeJob(id, listener) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status !== "running") {
    listener({ type: "end", status: job.status, exitCode: job.exitCode, error: job.error });
    return () => {};
  }
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

/** Kill every running child. Bound to dev-server shutdown so no gcloud outlives Vite. */
export function killAllJobs() {
  for (const job of jobs.values()) {
    if (job.status === "running" && job.child) {
      job.child.kill("SIGTERM");
      finish(job, "failed", null, "dev server stopped");
    }
  }
}

/** Test seam: forget every job. Never called by the server. */
export function resetJobs() {
  for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
  jobs.clear();
  running.clear();
}
