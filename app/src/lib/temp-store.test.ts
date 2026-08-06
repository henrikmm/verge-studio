/**
 * Scratch-directory housekeeping.
 *
 * This is the only code in the project that deletes files the user did not ask it to delete, so
 * the tests are mostly about what it refuses to touch. The age rule is the easy half; the half
 * worth pinning is that a name cannot address anything outside the root, that a symbolic link is
 * never followed, and that an entry it cannot remove is reported rather than fatal.
 *
 * The roots are fixed constants under the OS temp dir, which is what makes them safe. That also
 * means these tests operate on the real ones, so every fixture they create is stamped into the
 * past explicitly and removed again afterwards — a test must never be able to delete a clip the
 * developer is actually working on.
 */

import { lstat, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FRAME_ROOT,
  TEMP_MAX_AGE_MS,
  UPLOAD_ROOT,
  describeSweep,
  maybePruneTempDirs,
  pruneTempDirs,
  pruneTempRoot,
  resetTempSweepThrottle,
  // @ts-expect-error - plain ESM module, no type declarations
} from "../../vite-plugins/temp-store.mjs";

const DAY = 24 * 60 * 60 * 1000;
const TAG = `vitest-${process.pid}-`;

/** Everything this file creates carries TAG, so cleanup can never reach anything else. */
async function cleanup(): Promise<void> {
  for (const root of [UPLOAD_ROOT, FRAME_ROOT]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(TAG)) await rm(join(root, name), { recursive: true, force: true });
    }
  }
}

async function ageTo(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

async function makeFile(root: string, name: string, ageMs: number): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, TAG + name);
  await writeFile(path, "x".repeat(64));
  await ageTo(path, ageMs);
  return path;
}

async function makeDir(root: string, name: string, ageMs: number): Promise<string> {
  const path = join(root, TAG + name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "frame-0001.jpg"), "x".repeat(128));
  await ageTo(path, ageMs);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(cleanup);

describe("pruneTempRoot", () => {
  it("removes entries older than a day and keeps the rest", async () => {
    const stale = await makeFile(UPLOAD_ROOT, "stale.mp4", 2 * DAY);
    const fresh = await makeFile(UPLOAD_ROOT, "fresh.mp4", 60_000);

    const summary = await pruneTempRoot(UPLOAD_ROOT);

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(summary.removed.map((r: { path: string }) => r.path)).toContain(stale);
    expect(summary.freedBytes).toBeGreaterThan(0);
  });

  it("removes a whole stale frame directory, not just its files", async () => {
    const dir = await makeDir(FRAME_ROOT, "frames", 3 * DAY);

    await pruneTempRoot(FRAME_ROOT);

    expect(await exists(dir)).toBe(false);
  });

  /**
   * The boundary is what a user notices. A clip dropped this morning and returned to after
   * lunch must still be there; the exact cutoff is asserted from both sides.
   */
  it("keeps an entry just under the age limit and removes one just over it", async () => {
    const young = await makeFile(UPLOAD_ROOT, "young.mp4", TEMP_MAX_AGE_MS - 60_000);
    const old = await makeFile(UPLOAD_ROOT, "old.mp4", TEMP_MAX_AGE_MS + 60_000);

    await pruneTempRoot(UPLOAD_ROOT);

    expect(await exists(young)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  it("refuses any directory that is not one of the two scratch roots", async () => {
    const outsider = join(UPLOAD_ROOT, `${TAG}nested`);
    await mkdir(outsider, { recursive: true });
    const victim = join(outsider, "keep.txt");
    await writeFile(victim, "keep");
    await ageTo(victim, 9 * DAY);

    const summary = await pruneTempRoot(outsider);

    expect(await exists(victim)).toBe(true);
    expect(summary.removed).toHaveLength(0);
    expect(summary.skipped[0].reason).toBe("not a scratch root");
  });

  /**
   * Nothing nested is examined at all. A stale JPEG inside a frame directory that is itself
   * recent must survive — otherwise the sweep would hollow out the extraction belonging to the
   * clip currently on screen.
   */
  it("never descends into a child", async () => {
    const dir = join(FRAME_ROOT, `${TAG}recent`);
    await mkdir(dir, { recursive: true });
    const oldFrame = join(dir, "frame-0001.jpg");
    await writeFile(oldFrame, "x");
    await ageTo(oldFrame, 30 * DAY);
    await ageTo(dir, 60_000);

    await pruneTempRoot(FRAME_ROOT);

    expect(await exists(oldFrame)).toBe(true);
  });

  it("skips a symbolic link instead of following it", async () => {
    const target = await makeFile(FRAME_ROOT, "link-target.txt", 9 * DAY);
    const link = join(UPLOAD_ROOT, `${TAG}link`);
    await mkdir(UPLOAD_ROOT, { recursive: true });
    await symlink(target, link);

    const summary = await pruneTempRoot(UPLOAD_ROOT);

    expect(await exists(target)).toBe(true);
    expect(summary.skipped.some((s: { reason: string }) => s.reason === "symbolic link")).toBe(true);
  });

  it("reports rather than throws when a root does not exist", async () => {
    const summary = await pruneTempRoot(UPLOAD_ROOT, { now: Date.now() });
    expect(Array.isArray(summary.removed)).toBe(true);
  });

  it("dryRun reports what it would remove and removes nothing", async () => {
    const stale = await makeFile(UPLOAD_ROOT, "dry.mp4", 5 * DAY);

    const summary = await pruneTempRoot(UPLOAD_ROOT, { dryRun: true });

    expect(await exists(stale)).toBe(true);
    expect(summary.removed.map((r: { path: string }) => r.path)).toContain(stale);
  });
});

describe("pruneTempDirs", () => {
  it("sweeps both roots in one pass", async () => {
    const upload = await makeFile(UPLOAD_ROOT, "both.mp4", 4 * DAY);
    const frames = await makeDir(FRAME_ROOT, "both", 4 * DAY);

    const sweep = await pruneTempDirs();

    expect(await exists(upload)).toBe(false);
    expect(await exists(frames)).toBe(false);
    expect(sweep.removedCount).toBeGreaterThanOrEqual(2);
    expect(describeSweep(sweep)).toContain("removed");
  });

  it("says nothing when there was nothing to do", () => {
    expect(describeSweep({ removedCount: 0, skippedCount: 0, freedBytes: 0, roots: [] })).toBeNull();
  });
});

describe("maybePruneTempDirs", () => {
  it("sweeps once, then throttles the next call", async () => {
    resetTempSweepThrottle();
    expect(await maybePruneTempDirs()).not.toBeNull();
    expect(await maybePruneTempDirs()).toBeNull();
    resetTempSweepThrottle();
  });
});
