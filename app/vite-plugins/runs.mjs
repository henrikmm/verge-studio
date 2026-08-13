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
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { cloudStatus } from "./cloud.mjs";
import { FRAME_ROOT } from "./temp-store.mjs";

const execFileAsync = promisify(execFile);

export const RUNS_ROOT = resolve(
  process.env.VERGE_RUNS_ROOT ?? join(homedir(), "verge-runs"),
);

const INDEX_PATH = join(RUNS_ROOT, "index.json");
const BUILTIN_MEASUREMENTS_ROOT = join(RUNS_ROOT, ".measurements");

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

/** A manifest alone is traceability, not a runnable fixture. */
export function builtinFixtureAvailable(setting, root = FIXTURE_DIR) {
  return [
    join(root, setting, "manifest.json"),
    join(root, setting, "verge-result.npz"),
    join(root, setting, "scene.glb"),
    join(root, "frames", "frame-0001.jpg"),
  ].every(existsSync);
}

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
    available: builtinFixtureAvailable(setting),
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
 * This is what keeps "transient by default" true: the run becomes selectable and measurable
 * immediately, but its bytes stay in the three-day bucket until someone presses Save. If bucket
 * publication degraded, those bytes remain on the Cloud Run instance and must be saved before
 * deletion.
 */
function safeRunId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function contained(root, value) {
  const resolved = resolve(value);
  return resolved.startsWith(resolve(root) + sep);
}

export function trustedArtifact(artifact, runId, bucket) {
  if (!artifact || typeof artifact.name !== "string" || artifact.name !== artifact.name.split("/").pop() || artifact.name.includes("..")) {
    return false;
  }
  const expectedGsUri = `gs://${bucket}/runs/transient/${runId}/${artifact.name}`;
  // save-run.sh deliberately prefers gs_uri. A valid local fallback URL cannot make
  // an untrusted durable address safe, because the script would choose that address.
  if (artifact.gsUri !== undefined && artifact.gsUri !== null) {
    return artifact.gsUri === expectedGsUri;
  }
  return artifact.url === `/artifact/${runId}/${artifact.name}`;
}

export function saveNeedsService(manifest, runId, bucket) {
  const artifacts = manifest?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return true;
  return !artifacts.every((artifact) => (
    trustedArtifact(artifact, runId, bucket) && typeof artifact.gsUri === "string"
  ));
}

async function requireTrustedRun(repoRoot, entry) {
  const id = String(entry?.id ?? "");
  if (!safeRunId(id)) throw new Error("run id is invalid");
  const status = await cloudStatus(repoRoot, { refresh: true });
  if (!status.service.url || entry.serviceUrl !== status.service.url) {
    throw new Error("run service is not this configured Cloud Run service");
  }
  if (!entry.manifest || !Array.isArray(entry.manifest.artifacts) || !entry.manifest.artifacts.every((a) => trustedArtifact(a, id, process.env.VERGE_OUTPUT_BUCKET ?? ""))) {
    throw new Error("run artifact destination is not approved");
  }
  if (!Array.isArray(entry.framePaths) || !entry.framePaths.every((path) => typeof path === "string" && contained(FRAME_ROOT, path))) {
    throw new Error("run frame path is outside the extracted-frame directory");
  }
  return id;
}

async function requireSaveableRun(repoRoot, run) {
  const id = String(run?.id ?? "");
  if (!safeRunId(id)) throw new Error("run id is invalid");
  const bucket = process.env.VERGE_OUTPUT_BUCKET ?? "";
  if (!run.manifest || !Array.isArray(run.manifest.artifacts) || !run.manifest.artifacts.every((a) => trustedArtifact(a, id, bucket))) {
    throw new Error("run artifact destination is not approved");
  }
  const needsService = saveNeedsService(run.manifest, id, bucket);
  if (!needsService) return false;

  const status = await cloudStatus(repoRoot, { refresh: true });
  if (!status.service.url || run.serviceUrl !== status.service.url) {
    throw new Error("a degraded run needs its configured Cloud Run service to save");
  }
  return true;
}

export async function registerRun(repoRoot, entry) {
  const id = await requireTrustedRun(repoRoot, entry);
  const runs = await readIndex();
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
      // The durable address, and the reason a run can be saved after its signed links have
      // expired or its service has been deleted. Dropping it here would strand exactly the
      // runs this field exists to rescue, and — per bug 2 above — permanently, because this
      // object is copied into the run directory as its archive record.
      gs_uri: a.gsUri ?? null,
      kind: a.kind,
      size_bytes: a.sizeBytes,
    })),
    diagnostics: manifest.diagnostics
      ? {
          native_npz: manifest.diagnostics.nativeNpz ?? {},
          export_dir_listing: manifest.diagnostics.exportDirListing ?? [],
          publish_mode: manifest.diagnostics.publishMode ?? "local",
          publish_errors: manifest.diagnostics.publishErrors ?? [],
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
  if (!safeRunId(id)) throw new Error("run id is invalid");
  const runs = await readIndex();
  const run = runs.find((item) => item.id === id);
  if (!run) throw new Error(`no such run: ${id}`);
  if (!run.manifest) throw new Error(`run ${id} has no manifest to save from`);
  if (!run.serviceUrl) throw new Error(`run ${id} has no service URL — it may already be gone`);
  const needsServiceToken = await requireSaveableRun(repoRoot, run);

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
      // The token is minted in THIS process from the active gcloud login and handed to the child.
      // It never reaches the browser, and nothing has to be typed or pasted to save a run.
      VERGE_TOKEN: needsServiceToken ? run.token || (await serviceToken(run.serviceUrl)) : "",
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

/**
 * Delete a run's bytes and drop it from the registry. Built-ins are not deletable.
 *
 * The artifacts go for good — they are the 100+ MB this policy exists to control, and a cloud
 * run can be taken again. The recorded measurements do not: they are the only copy of what a
 * person painted, and they are kilobytes. So they are archived first, with the run's index
 * record beside them, and only then does the directory go.
 */
export async function deleteRun(id) {
  if (!safeRunId(id)) throw new Error("run id is invalid");
  if (id.startsWith("door-")) throw new Error("built-in fixture runs cannot be deleted");
  const runs = await readIndex();
  const archived = await archiveMeasurementEvidence(id, { reason: `run ${id} deleted` });
  await archiveRunRecord(runs.find((run) => run.id === id));
  await rm(join(RUNS_ROOT, id), { recursive: true, force: true });
  await writeIndex(runs.filter((run) => run.id !== id));
  return { deleted: id, archived: archived.length };
}

function measurementDirectory(id, builtin) {
  return builtin
    ? join(BUILTIN_MEASUREMENTS_ROOT, id)
    : join(RUNS_ROOT, id, "measurements");
}

function measurementFileName(evidenceId) {
  const digest = createHash("sha256").update(String(evidenceId)).digest("hex").slice(0, 20);
  return `measurement-${digest}.json`;
}

function measurementEvidenceId(packet) {
  const observation = packet?.observation ?? {};
  return [
    observation.id,
    observation.sittingId,
    observation.capturedAt,
    observation.mask?.digest ?? "no-mask",
  ].join("@");
}

async function recordedRun(id) {
  if (!safeRunId(id)) throw new Error("run id is invalid");
  const run = [...builtinRuns(), ...(await readIndex())].find((item) => item.id === id);
  if (!run) throw new Error(`no such run: ${id}`);
  if (!run.persisted) throw new Error(`run ${id} is transient — save it before recording evidence`);
  if (!run.builtin && !existsSync(join(RUNS_ROOT, id))) {
    throw new Error(`run ${id} is recorded but its artifacts are missing`);
  }
  return run;
}

/** Write one explicitly recorded trial atomically. Human trial numbers may repeat across sittings. */
export async function writeMeasurementEvidence(id, packet) {
  const run = await recordedRun(id);
  if (packet?.runId !== id || packet?.observation?.runId !== id) {
    throw new Error("measurement evidence run id does not match its route");
  }
  const observationId = String(packet?.observation?.id ?? "");
  if (!observationId) throw new Error("measurement evidence has no observation id");
  if (!packet?.observation?.mask?.runs) throw new Error("measurement evidence has no frozen mask");
  const evidenceId = measurementEvidenceId(packet);
  if (packet.evidenceId && packet.evidenceId !== evidenceId) {
    throw new Error("measurement evidence identity does not match its recorded trial");
  }

  const directory = measurementDirectory(id, run.builtin);
  await mkdir(directory, { recursive: true });
  const path = join(directory, measurementFileName(evidenceId));
  const temp = join(directory, `.${measurementFileName(evidenceId)}.${randomUUID()}.tmp`);
  const envelope = {
    ...packet,
    evidenceId,
    storedAt: new Date().toISOString(),
    storage: {
      runId: run.id,
      clipName: run.clipName,
      clipSha256: run.clipSha256,
      builtin: run.builtin,
    },
  };
  await writeFile(temp, JSON.stringify(envelope, null, 2));
  await rename(temp, path);
  return envelope;
}

export async function listMeasurementEvidence(id) {
  const run = await recordedRun(id);
  const directory = measurementDirectory(id, run.builtin);
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      const packet = JSON.parse(await readFile(join(directory, name), "utf8"));
      rows.push({ ...packet, evidenceId: measurementEvidenceId(packet) });
    } catch {
      // One broken packet must not hide the other recorded trials.
    }
  }
  return rows.sort((a, b) => String(a.observation?.capturedAt).localeCompare(String(b.observation?.capturedAt)));
}

/**
 * Recorded evidence is archived, never deleted.
 *
 * Every packet here is a thing a person painted once and cannot repaint — the mask, the floor it
 * was measured against, and the instant. Re-recording it is not possible even with the same run on
 * disk, because the operator's endpoints were placed by hand. The bytes are trivial (the door
 * archive is 33 packets in 264 KB), so the only question this policy has to answer is whether a
 * deleted trial may come back and be counted again. It may not: the archive is outside every path
 * that reads evidence, so an archived trial is gone from the app exactly as if it had been erased.
 *
 * `.archive` sits beside the runs rather than inside one, so it survives the run's deletion.
 */
const ARCHIVE_ROOT = join(RUNS_ROOT, ".archive");

/** Keep the run's index record beside its archived trials: what they were measured on. */
async function archiveRunRecord(run) {
  if (!run) return;
  const directory = join(ARCHIVE_ROOT, run.id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "run.json"),
    JSON.stringify({ ...run, archivedAt: new Date().toISOString() }, null, 2),
  );
}

/**
 * Move a run's recorded trials into the archive, all of them or a named subset.
 *
 * `evidenceIds` picks out single trials (one discarded misclick); `objectIds` takes everything
 * recorded against a target being removed. With neither, the whole run is archived — what
 * deleting a run does before its directory goes.
 *
 * Returns the archived evidence ids, so a caller can say how many trials it just put away.
 */
export async function archiveMeasurementEvidence(id, { evidenceIds, objectIds, reason } = {}) {
  if (!safeRunId(id)) throw new Error("run id is invalid");
  const builtin = id.startsWith("door-");
  const source = measurementDirectory(id, builtin);
  let names;
  try {
    names = (await readdir(source)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const wanted = evidenceIds ? new Set(evidenceIds) : null;
  const targets = objectIds ? new Set(objectIds) : null;
  const everything = !wanted && !targets;
  const destination = join(ARCHIVE_ROOT, id);
  const archived = [];

  for (const name of names) {
    const path = join(source, name);
    let packet;
    try {
      packet = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // Unreadable, so it matches no filter. Under a filter it is left alone for explicit
      // repair; when the whole run is going it is moved as-is, because the alternative is the
      // caller's `rm -rf` destroying the one file nobody can reconstruct.
      if (everything) {
        await mkdir(destination, { recursive: true });
        await rename(path, await freeArchivePath(destination, name));
      }
      continue;
    }
    const evidenceId = measurementEvidenceId(packet);
    if (wanted && !wanted.has(evidenceId)) continue;
    if (targets && !targets.has(String(packet?.observation?.objectId ?? ""))) continue;

    await mkdir(destination, { recursive: true });
    const final = await freeArchivePath(destination, measurementFileName(evidenceId));
    const temp = `${final}.${randomUUID()}.tmp`;
    await writeFile(
      temp,
      JSON.stringify(
        { ...packet, evidenceId, archivedAt: new Date().toISOString(), archivedReason: reason ?? "unspecified" },
        null,
        2,
      ),
    );
    // Write the copy, publish it, and only then drop the original: a crash mid-way leaves the
    // trial in two places, which is recoverable. The other order loses it.
    await rename(temp, final);
    await rm(path, { force: true });
    archived.push(evidenceId);
  }
  return archived;
}

/** Never overwrite an archived trial: two archives of one evidence id are two separate events. */
async function freeArchivePath(directory, name) {
  const candidate = join(directory, name);
  if (!existsSync(candidate)) return candidate;
  const stem = name.replace(/\.json$/, "");
  for (let index = 2; ; index += 1) {
    const next = join(directory, `${stem}-${index}.json`);
    if (!existsSync(next)) return next;
  }
}

export async function removeMeasurementEvidence(id, evidenceId) {
  await recordedRun(id);
  return archiveMeasurementEvidence(id, { evidenceIds: [evidenceId], reason: "trial discarded" });
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
