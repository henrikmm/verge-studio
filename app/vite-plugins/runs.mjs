// The run registry: what inference runs exist, which ones are on this disk, and how to
// delete them.
//
// Storage policy (CLAUDE.md): inference outputs are TRANSIENT. A completed cloud run is
// registered here as a stub — the manifest only, a few KB — and nothing large touches the
// disk until the operator explicitly saves it. A 112f/504px run is ~135 MB (108 MB npz +
// 16 MB GLB + ~11 MB frames), so auto-persisting would quietly fill a laptop.
//
// Runs live OUTSIDE the repository, under ~/verge-runs, so a 135 MB artifact can never be
// staged by accident. The three door fixtures under fixtures/ are exposed as read-only
// built-in runs so the recorded evidence M3 was graded on stays selectable and undeletable.

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNS_ROOT = resolve(
  process.env.VERGE_RUNS_ROOT ?? join(homedir(), "verge-runs"),
);

const INDEX_PATH = join(RUNS_ROOT, "index.json");

/**
 * The recorded door fixtures, as read-only runs.
 *
 * Their payloads are gitignored and local-only, so a fresh clone sees them listed but
 * unavailable rather than silently missing — `available` says which.
 */
const BUILTIN_SETTINGS = [
  { setting: "504px-112f", label: "Door · 504 px · 112f", gpuSeconds: 31.27 },
  { setting: "356px-256f", label: "Door · 356 px · 256f", gpuSeconds: 40.83 },
  { setting: "252px-256f", label: "Door · 252 px · 256f", gpuSeconds: 16.47 },
];

const FIXTURE_DIR = resolve(new URL("../../fixtures/door", import.meta.url).pathname);

function builtinRuns() {
  return BUILTIN_SETTINGS.map(({ setting, label, gpuSeconds }) => ({
    id: `door-${setting}`,
    label,
    clipName: "test-demo-door.mp4",
    // The door clip's identity. Every built-in run is the SAME clip at different settings,
    // which is exactly why they share a measurement target set.
    clipSha256: "builtin-door",
    createdAt: "2026-08-01T00:00:00.000Z",
    source: "fixture",
    builtin: true,
    persisted: true,
    available: existsSync(join(FIXTURE_DIR, setting, "manifest.json")),
    gpuSeconds,
    // Served by Vite's publicDir, which points at fixtures/.
    artifactBase: `/door/${setting}/`,
    framesBase: "/door/frames/",
    /**
     * These three settings SHARE one canonical 256-frame extraction, so an NPZ index has to be
     * mapped through `canonicalFrameMap` to find its JPEG. Saved cloud runs carry their own
     * contiguous frames and must not use that map — see the note in `depth-field.ts`.
     */
    canonicalFrames: true,
    sizeBytes: 0,
  }));
}

async function readIndex() {
  try {
    const raw = await readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    // No index yet is the normal first-run state, not an error.
    return [];
  }
}

async function writeIndex(runs) {
  await mkdir(RUNS_ROOT, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify({ version: 1, runs }, null, 2));
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else {
        try {
          total += (await stat(child)).size;
        } catch {
          /* raced with a delete; not worth failing a size report over */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/** Built-ins first, then saved runs, then transient stubs — newest of each first. */
export async function listRuns() {
  const stored = await readIndex();
  const withSizes = await Promise.all(
    stored.map(async (run) => ({
      ...run,
      available: run.persisted ? existsSync(join(RUNS_ROOT, run.id)) : true,
      sizeBytes: run.persisted ? await dirSize(join(RUNS_ROOT, run.id)) : 0,
    })),
  );
  withSizes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return [...builtinRuns(), ...withSizes];
}

/**
 * Register a completed run WITHOUT persisting its artifacts.
 *
 * This is what keeps "transient by default" true: the run becomes selectable and
 * measurable immediately, but its bytes still live only on the Cloud Run instance until
 * someone presses Save. If the instance is deleted first, the stub remains and honestly
 * reports itself as unavailable.
 */
export async function registerRun(entry) {
  const runs = await readIndex();
  const id = String(entry.id);
  const next = {
    id,
    label: entry.label ?? id,
    clipName: entry.clipName ?? "",
    clipSha256: entry.clipSha256 ?? "",
    createdAt: entry.createdAt ?? new Date().toISOString(),
    source: "cloud",
    builtin: false,
    persisted: false,
    frameCount: entry.frameCount ?? 0,
    processRes: entry.processRes ?? 0,
    gpuSeconds: entry.gpuSeconds ?? 0,
    serviceUrl: entry.serviceUrl ?? "",
    // saveRun renumbers this run's own frames 1..N, so NPZ index i is simply file i+1.
    canonicalFrames: false,
    manifest: entry.manifest ?? null,
    framePaths: entry.framePaths ?? [],
    artifactBase: null,
    framesBase: null,
  };
  await writeIndex([...runs.filter((run) => run.id !== id), next]);
  return next;
}

/**
 * Bring a run's artifacts home. Delegates to scripts/save-run.sh rather than reimplementing
 * the download: that script already does the range-chunked fetch Cloud Run's 32 MiB response
 * cap forces, plus sha256 verification, and having two implementations of that would mean one
 * of them is wrong.
 */
/**
 * Back to the wire shape — the COMPLETE inverse of `manifestFromWire`, not just the fields
 * `save-run.sh` happens to parse.
 *
 * Two bugs live here, and the second was caused by the fix for the first.
 *
 * 1. The registry stores the app's camelCase manifest while the script parses the service's
 *    snake_case JSON, so saving a real cloud run died on `KeyError: 'run_id'`. Every previous
 *    Save was a built-in fixture, which is already on disk and never reaches the script, so the
 *    seam had never been exercised.
 * 2. The first fix emitted only `run_id` and `artifacts` — enough for the script, and wrong,
 *    because `save-run.sh` *copies this file into the run directory as its permanent record*
 *    (`cp "${MANIFEST}" "${DEST}/manifest.json"`). `loadRunDepthField` reads it back through
 *    `manifestFromWire`, which dereferences `w.params.fps`, `w.frames.count`,
 *    `w.timing.gpu_seconds` and `w.vram.peak_bytes`. A 429-byte manifest made every saved run
 *    unloadable: selecting it threw inside Run Source, and the viewport silently kept showing
 *    the previous cloud.
 *
 * The lesson worth keeping: this object is not a function argument, it is the run's archive
 * record. Anything dropped here is dropped permanently, and the loss only shows up later.
 */
export function toWireManifest(manifest) {
  return {
    schema_version: manifest.schemaVersion,
    run_id: manifest.runId,
    model_repository_id: manifest.modelRepositoryId,
    model_revision: manifest.modelRevision,
    depth_mode: manifest.depthMode,
    linear_unit: manifest.linearUnit,
    params: {
      fps: manifest.params?.fps,
      source_duration_s: manifest.params?.sourceDurationS ?? null,
      process_res: manifest.params?.processRes,
      process_res_method: manifest.params?.processResMethod,
      ref_view_strategy: manifest.params?.refViewStrategy,
      max_frames: manifest.params?.maxFrames,
    },
    frames: {
      count: manifest.frames?.count,
      requested_count: manifest.frames?.requestedCount,
      width: manifest.frames?.width,
      height: manifest.frames?.height,
      capped: manifest.frames?.capped,
      effective_fps: manifest.frames?.effectiveFps ?? null,
    },
    timing: {
      gpu_seconds: manifest.timing?.gpuSeconds,
      wall_seconds: manifest.timing?.wallSeconds,
      model_load_seconds: manifest.timing?.modelLoadSeconds ?? null,
    },
    vram: {
      peak_bytes: manifest.vram?.peakBytes,
      current_bytes: manifest.vram?.currentBytes,
      total_bytes: manifest.vram?.totalBytes,
      device_name: manifest.vram?.deviceName,
      torch_peak_bytes: manifest.vram?.torchPeakBytes ?? 0,
      baseline_bytes: manifest.vram?.baselineBytes ?? 0,
    },
    artifacts: (manifest.artifacts ?? []).map((a) => ({
      name: a.name,
      sha256: a.sha256,
      url: a.url,
      kind: a.kind,
      size_bytes: a.sizeBytes,
    })),
    diagnostics: manifest.diagnostics
      ? {
          native_npz: manifest.diagnostics.nativeNpz ?? {},
          export_dir_listing: manifest.diagnostics.exportDirListing ?? [],
        }
      : undefined,
    transient: manifest.transient,
    expires_after_days: manifest.expiresAfterDays,
    mock: manifest.mock === true,
  };
}

/**
 * An identity token for a remote service, or "" for anything local.
 *
 * Import is lazy so this module keeps working in tests that never touch gcloud, and a failure
 * degrades to an empty token rather than blocking a save that might still succeed.
 */
async function serviceToken(serviceUrl) {
  if (!/^https:\/\//i.test(serviceUrl ?? "")) return "";
  try {
    const { identityToken } = await import("./cloud.mjs");
    return await identityToken();
  } catch {
    return "";
  }
}

export async function saveRun(repoRoot, id) {
  const runs = await readIndex();
  const run = runs.find((item) => item.id === id);
  if (!run) throw new Error(`no such run: ${id}`);
  if (!run.manifest) throw new Error(`run ${id} has no manifest to save from`);
  if (!run.serviceUrl) throw new Error(`run ${id} has no service URL — it may already be gone`);

  const manifestPath = join(tmpdir(), `verge-save-${id}.json`);
  await writeFile(manifestPath, JSON.stringify(toWireManifest(run.manifest)));

  const { stdout, stderr } = await execFileAsync(join(repoRoot, "scripts/save-run.sh"), [manifestPath, id], {
    cwd: repoRoot,
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      VERGE_URL: run.serviceUrl,
      // Saving happens in a shell, so the browser's credential-free proxy cannot help here.
      // The token is minted in THIS process from ADC and handed to the child — it never
      // reaches the browser, and nothing has to be typed or pasted to save a run.
      VERGE_TOKEN: run.token || (await serviceToken(run.serviceUrl)),
      FIXTURE_ROOT: RUNS_ROOT,
    },
  });

  // Masks are painted on frames, so from M3 on the frames ARE part of a saved run — without
  // them a saved run cannot be re-measured, only re-read.
  const dest = join(RUNS_ROOT, id, "frames");
  if (run.framePaths.length > 0) {
    await mkdir(dest, { recursive: true });
    for (const [index, source] of run.framePaths.entries()) {
      try {
        await writeFile(
          join(dest, `frame-${String(index + 1).padStart(4, "0")}.jpg`),
          await readFile(source),
        );
      } catch {
        // A missing temp frame is not worth failing the whole save for; the artifacts,
        // which are the expensive part, are already down.
      }
    }
  }

  const updated = {
    ...run,
    persisted: true,
    artifactBase: `/api/run-artifact?path=${encodeURIComponent(id)}%2F`,
    framesBase: `/api/run-artifact?path=${encodeURIComponent(id)}%2Fframes%2F`,
  };
  await writeIndex([...runs.filter((item) => item.id !== id), updated]);
  return { run: updated, output: `${stdout}${stderr}`.trim().slice(-2000) };
}

/** Delete a run's bytes and drop it from the registry. Built-ins are not deletable. */
export async function deleteRun(id) {
  if (id.startsWith("door-")) throw new Error("built-in fixture runs cannot be deleted");
  const runs = await readIndex();
  await rm(join(RUNS_ROOT, id), { recursive: true, force: true });
  await writeIndex(runs.filter((run) => run.id !== id));
}

/**
 * Serve a file from inside the runs root.
 *
 * Runs live outside the project, so Vite's publicDir cannot serve them. The guard is the
 * same prefix check `/api/frame` uses and which was verified to 403 on /etc/passwd — resolve
 * first, then require the runs root as a true path prefix.
 */
export function resolveRunArtifact(relative) {
  const requested = resolve(join(RUNS_ROOT, relative));
  if (requested !== RUNS_ROOT && !requested.startsWith(RUNS_ROOT + sep)) return null;
  return requested;
}
