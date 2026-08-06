// Housekeeping for the two scratch directories the dev server writes to.
//
// Dropping a video copies it under the OS temp dir because ffmpeg needs a real path and a
// browser never hands one out; extracting frames writes a directory of JPEGs beside it. Neither
// was ever cleaned up, so a machine that had run a few clips was carrying hundreds of megabytes
// of videos and frames it would never read again.
//
// The rule is deliberately narrow, because this code deletes things:
//
//   * only the two exact directories below, never a path derived from a request;
//   * only their immediate children, so nothing nested is walked looking for victims;
//   * only entries older than a day, so a clip loaded in the open tab is never pulled away;
//   * never through a symbolic link, which is the one way an immediate child could still
//     stand for a file somewhere else entirely.
//
// Anything that cannot be inspected or removed — already gone, held open, not ours to touch —
// is reported and skipped. Housekeeping must never be the reason the dev server fails to start.

import { lstat, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Videos copied out of the browser by `POST /api/upload`. */
export const UPLOAD_ROOT = join(tmpdir(), "verge-uploads");
/** One directory of extracted JPEGs per `POST /api/extract`. */
export const FRAME_ROOT = join(tmpdir(), "verge-frames");

export const TEMP_ROOTS = [UPLOAD_ROOT, FRAME_ROOT];

/**
 * How long scratch data is kept.
 *
 * A day is long enough that a session spanning an afternoon, a break and an evening never loses
 * the clip it is working on, and short enough that yesterday's experiments do not accumulate.
 * Frames belonging to a saved run are not at risk either way: Save copies them into
 * `~/verge-runs`, which this code has no knowledge of and never touches.
 */
export const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bytes under a path, following nothing. Reporting only — never used to decide a deletion. */
async function sizeOf(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return 0;
  }
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let entries;
  try {
    entries = await readdir(path);
  } catch {
    return 0;
  }
  for (const name of entries) total += await sizeOf(join(path, name));
  return total;
}

/**
 * Delete stale immediate children of one root.
 *
 * Returns what happened rather than throwing: a locked file is a fact to report, not a reason
 * to abandon the rest of the sweep.
 */
export async function pruneTempRoot(root, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? TEMP_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const resolvedRoot = resolve(root);
  const summary = { root: resolvedRoot, removed: [], freedBytes: 0, kept: 0, skipped: [] };

  // Only the two known roots, and never a path derived from a request. `resolve` is variadic,
  // so it has to be wrapped — passing it to `map` directly hands it the index and the array too.
  if (!TEMP_ROOTS.map((root) => resolve(root)).includes(resolvedRoot)) {
    summary.skipped.push({ path: resolvedRoot, reason: "not a scratch root" });
    return summary;
  }

  let entries;
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    return summary;
  }

  for (const entry of entries) {
    const path = join(resolvedRoot, entry.name);
    const resolved = resolve(path);

    // The containment check that makes the rest safe. `dirname` of an immediate child is the
    // root itself, so a name carrying separators or `..` cannot address anything else.
    if (dirname(resolved) !== resolvedRoot) {
      summary.skipped.push({ path: resolved, reason: "not an immediate child" });
      continue;
    }

    let info;
    try {
      info = await lstat(resolved);
    } catch {
      // Vanished between the listing and now. Nothing to do, and nothing wrong.
      continue;
    }

    // `lstat` does not follow the link, so this is the link itself, not its target. Removing it
    // would be safe; refusing is simpler to reason about and we never create one.
    if (info.isSymbolicLink()) {
      summary.skipped.push({ path: resolved, reason: "symbolic link" });
      continue;
    }

    const ageMs = now - info.mtimeMs;
    if (ageMs < maxAgeMs) {
      summary.kept += 1;
      continue;
    }

    const bytes = await sizeOf(resolved);
    if (dryRun) {
      summary.removed.push({ path: resolved, bytes, ageMs });
      summary.freedBytes += bytes;
      continue;
    }
    try {
      await rm(resolved, { recursive: true, force: true });
      summary.removed.push({ path: resolved, bytes, ageMs });
      summary.freedBytes += bytes;
    } catch (err) {
      summary.skipped.push({ path: resolved, reason: err?.code ?? "remove failed" });
    }
  }

  return summary;
}

/** Sweep both scratch roots. */
export async function pruneTempDirs(options = {}) {
  const summaries = [];
  for (const root of TEMP_ROOTS) summaries.push(await pruneTempRoot(root, options));
  return {
    roots: summaries,
    removedCount: summaries.reduce((n, s) => n + s.removed.length, 0),
    freedBytes: summaries.reduce((n, s) => n + s.freedBytes, 0),
    skippedCount: summaries.reduce((n, s) => n + s.skipped.length, 0),
  };
}

/**
 * Sweep, but not more than once a minute.
 *
 * Called before each upload and extraction so scratch data is cleared by the work that creates
 * more of it. Two uploads in a row do not need two sweeps, and the throttle keeps this off the
 * critical path of a drop.
 */
let lastSweepAt = 0;

export async function maybePruneTempDirs(options = {}) {
  const now = options.now ?? Date.now();
  if (now - lastSweepAt < 60_000) return null;
  lastSweepAt = now;
  return pruneTempDirs(options);
}

/** Tests: forget the throttle so a sweep is not suppressed by an earlier one. */
export function resetTempSweepThrottle() {
  lastSweepAt = 0;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Report a sweep on the dev-server console, and stay quiet when there was nothing to do. */
export function describeSweep(sweep) {
  if (!sweep || (sweep.removedCount === 0 && sweep.skippedCount === 0)) return null;
  const parts = [];
  if (sweep.removedCount > 0) {
    parts.push(`removed ${sweep.removedCount} stale item(s), ${formatBytes(sweep.freedBytes)}`);
  }
  if (sweep.skippedCount > 0) parts.push(`skipped ${sweep.skippedCount}`);
  return `verge temp: ${parts.join(" · ")}`;
}

/** What is sitting in the scratch roots right now, stale or not. Reporting only. */
export async function inspectTempDirs(options = {}) {
  const now = options.now ?? Date.now();
  const roots = [];
  for (const root of TEMP_ROOTS) {
    const resolvedRoot = resolve(root);
    const entries = [];
    let listing;
    try {
      listing = await readdir(resolvedRoot, { withFileTypes: true });
    } catch {
      roots.push({ root: resolvedRoot, exists: false, entries, totalBytes: 0 });
      continue;
    }
    for (const entry of listing) {
      const path = join(resolvedRoot, entry.name);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      entries.push({
        path,
        bytes: await sizeOf(path),
        ageMs: now - info.mtimeMs,
        directory: info.isDirectory(),
      });
    }
    roots.push({
      root: resolvedRoot,
      exists: true,
      entries,
      totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    });
  }
  return { roots, totalBytes: roots.reduce((n, r) => n + r.totalBytes, 0) };
}
