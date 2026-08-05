/**
 * Runs, client side.
 *
 * A run is one DA3 inference with an identity: which clip, which settings, which artifacts.
 * Before this existed the app could only ever address three hardcoded door fixture
 * directories, which is why a live run could be measured but never recorded — there was
 * nothing stable to key a measurement to.
 *
 * Runs are TRANSIENT by default. A completed cloud run registers a stub (manifest only) and
 * stays selectable, but nothing large is written until Save. See `vite-plugins/runs.mjs`.
 */

import type { InferManifest } from "./contract";

/** Opaque, stable identity for a run. Measurements are keyed by this. */
export type RunId = string;

export interface RunRecord {
  id: RunId;
  label: string;
  clipName: string;
  /** Content digest of the source clip. Metric scale does not transfer between clips, so
   *  this is what decides which measurement targets a run may be graded against. */
  clipSha256: string;
  createdAt: string;
  source: "cloud" | "fixture";
  /** Built-ins are the recorded door fixtures: read-only and not deletable. */
  builtin: boolean;
  /**
   * True when this run's RGB frames come from a SHARED canonical 256-frame extraction (the door
   * fixtures) rather than its own contiguous 1..N set. It decides how an NPZ index maps to a
   * JPEG filename, and getting it wrong desynchronises RGB from depth without erroring — see
   * `measurement/depth-field.ts`. Optional: records written before 2026-08-05 fall back to
   * `builtin`.
   */
  canonicalFrames?: boolean;
  /** True once the artifacts are on this disk rather than only on a cloud instance. */
  persisted: boolean;
  /** False when a stub's instance is gone, or a fixture payload was never regenerated. */
  available: boolean;
  frameCount?: number;
  processRes?: number;
  gpuSeconds?: number;
  sizeBytes: number;
  serviceUrl?: string;
  manifest?: InferManifest | null;
  /** URL prefix for this run's artifacts, or null while the run is still transient. */
  artifactBase: string | null;
  framesBase: string | null;
}

export interface RunsListing {
  root: string;
  runs: RunRecord[];
}

const BASE = "/api";

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchRuns(): Promise<RunsListing> {
  return (await expectOk(await fetch(`${BASE}/runs`))) as RunsListing;
}

export async function registerRun(entry: {
  id: string;
  label: string;
  clipName: string;
  clipSha256: string;
  frameCount: number;
  processRes: number;
  gpuSeconds: number;
  serviceUrl: string;
  manifest: InferManifest;
  framePaths: string[];
}): Promise<RunRecord> {
  return (await expectOk(
    await fetch(`${BASE}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }),
  )) as RunRecord;
}

export async function saveRun(id: RunId): Promise<{ run: RunRecord; output: string }> {
  return (await expectOk(
    await fetch(`${BASE}/runs/${encodeURIComponent(id)}/save`, { method: "POST" }),
  )) as { run: RunRecord; output: string };
}

export async function deleteRun(id: RunId): Promise<void> {
  await expectOk(await fetch(`${BASE}/runs/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/**
 * Rough disk cost of saving a run, so the Save button can say what it will consume before
 * it consumes it. Measured on the real fixtures: ~108 MB npz + ~16 MB GLB at 112f/504px,
 * plus ~11 MB of source frames at 1024 px.
 */
export function estimateSaveBytes(run: RunRecord): number {
  const fromManifest = (run.manifest?.artifacts ?? []).reduce(
    (total, artifact) => total + (artifact.sizeBytes || 0),
    0,
  );
  const frames = (run.frameCount ?? 0) * 100_000;
  return fromManifest + frames;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
