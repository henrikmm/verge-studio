// Local dev API: real ffmpeg extraction + a fixture-backed mock of the DA3 service.
//
// Serves the exact /infer contract the cloud service serves, so the whole frontend
// can be built and reviewed offline at zero cost. Swapping to the real service is a
// base-URL change, nothing more.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFrames, probeVideo } from "../../scripts/extract-frames.mjs";
import { cloudStatus, invalidateCloudStatus, proxyToService } from "./cloud.mjs";
import { getJob, getRunningJob, killAllJobs, startJob, subscribeJob } from "./jobs.mjs";
import {
  RUNS_ROOT,
  deleteRun,
  listRuns,
  registerRun,
  resolveRunArtifact,
  saveRun,
} from "./runs.mjs";
import {
  FRAME_ROOT,
  UPLOAD_ROOT,
  describeSweep,
  maybePruneTempDirs,
  pruneTempDirs,
} from "./temp-store.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MIME = {
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
  ".npz": "application/octet-stream",
  ".ply": "application/octet-stream",
};

const FIXTURE_DIR = new URL("../../fixtures/roadside/", import.meta.url);

/**
 * How many frames the roadside fixture's npz actually contains — `depth` is (4, 224, 392).
 * The mock must never claim more than this; see the note on `frames` in POST /api/infer.
 */
const FIXTURE_FRAME_COUNT = 4;

// Dropped videos and extracted frames both live under the OS temp dir (UPLOAD_ROOT and
// FRAME_ROOT, defined in temp-store.mjs, which also ages them out). Nothing here is ever
// uploaded anywhere by this middleware -- the cloud only ever receives the JPEG frames, and
// only when the user runs the DA3 node.

/**
 * Measured on a real L4 by scripts/vram-sweep.sh (2026-08-01), per-run isolated with
 * empty_cache(); raw data in docs/vram-measurements.json. Ceiling is between 144 frames
 * (ran, 21.88 GiB) and 160 (OOM). Keep in sync with app/src/lib/contract.ts.
 */
const VRAM_BASE_BYTES = 7_050_625_024; // resident after model load
const TOTAL_VRAM_BYTES = 23_659_151_360; // 22.03 GiB usable, not 24
const MEASUREMENTS = [
  [32, 15_294_529_536],
  [64, 18_186_502_144],
  [112, 22_848_471_040],
  [128, 23_561_502_720],
];

export function estimateVramBytes(frameCount, processRes) {
  const resScale = (processRes / 504) ** 2;
  const last = MEASUREMENTS[MEASUREMENTS.length - 1];
  if (frameCount >= last[0]) {
    const prev = MEASUREMENTS[MEASUREMENTS.length - 3];
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    return (last[1] + slope * (frameCount - last[0])) * resScale;
  }
  for (let i = 0; i < MEASUREMENTS.length - 1; i++) {
    const [f0, b0] = MEASUREMENTS[i];
    const [f1, b1] = MEASUREMENTS[i + 1];
    if (frameCount >= f0 && frameCount <= f1) {
      const t = f1 === f0 ? 0 : (frameCount - f0) / (f1 - f0);
      return (b0 + t * (b1 - b0)) * resScale;
    }
  }
  return Math.max(VRAM_BASE_BYTES, MEASUREMENTS[0][1] * (frameCount / MEASUREMENTS[0][0])) * resScale;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readRawBody(req);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

/**
 * Identity of a source video: content digest, not path. A cache key built from the
 * path alone would wrongly hit when a file is replaced in place.
 */
async function videoIdentity(path) {
  const [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: stats.size,
  };
}

// Mock GPU state, so warmup/busy/idle transitions are visible in the UI offline.
const state = { modelLoaded: false, busy: false, runStartedAt: 0, runPeak: 0, runMs: 0 };

function mockSnapshot() {
  let current = state.modelLoaded ? VRAM_BASE_BYTES : 0;
  if (state.busy) {
    // Ramp toward the run's peak so the live bar visibly moves.
    const t = Math.min(1, (Date.now() - state.runStartedAt) / Math.max(state.runMs, 1));
    current = VRAM_BASE_BYTES + (state.runPeak - VRAM_BASE_BYTES) * t;
  }
  return {
    available: true,
    model_loaded: state.modelLoaded,
    busy: state.busy,
    device_name: "NVIDIA L4 (mock)",
    current_bytes: Math.round(current),
    peak_bytes: Math.round(Math.max(current, state.runPeak)),
    total_bytes: TOTAL_VRAM_BYTES,
  };
}

export function localApi() {
  return {
    name: "verge-local-api",
    configureServer(server) {
      // No gcloud child may outlive the dev server. A deploy orphaned by Ctrl-C would keep
      // rolling out a revision nobody is watching, and a half-applied deploy is worse than
      // none — the operator would have no log and no way to know it happened.
      server.httpServer?.on("close", killAllJobs);

      // Clear yesterday's scratch data once, at startup. Failing to tidy up is never a reason
      // for the dev server not to come up, so this deliberately swallows its own errors.
      void pruneTempDirs()
        .then((sweep) => {
          const line = describeSweep(sweep);
          if (line) server.config.logger.info(line);
        })
        .catch(() => {});
      process.once("exit", killAllJobs);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();

        try {
          /**
           * Everything under /api/cloud/svc/ is the deployed service, reached through this
           * process so the browser never holds a credential. The app addresses a same-origin
           * path; cloud.mjs attaches the bearer token and streams both directions.
           */
          if (url.pathname.startsWith("/api/cloud/svc/")) {
            const subPath = url.pathname.slice("/api/cloud/svc".length) + url.search;
            return await proxyToService(REPO_ROOT, req, res, subPath);
          }

          /**
           * Watch a job. SSE rather than polling: a deploy emits output for minutes, and a
           * reconnecting client replays the whole buffer first, so a page refresh mid-deploy
           * loses nothing.
           */
          const jobRoute = /^\/api\/cloud\/job\/([^/]+)$/.exec(url.pathname);
          if (jobRoute && req.method === "GET") {
            const job = getJob(decodeURIComponent(jobRoute[1]));
            if (!job) return json(res, 404, { detail: "no such job" });

            if (url.searchParams.get("stream") !== "1") return json(res, 200, job);

            res.statusCode = 200;
            res.setHeader("content-type", "text/event-stream");
            res.setHeader("cache-control", "no-store");
            res.setHeader("connection", "keep-alive");
            const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
            send({ type: "snapshot", job });
            const unsubscribe = subscribeJob(job.id, (event) => {
              send(event);
              if (event.type === "end") res.end();
            });
            if (unsubscribe) req.on("close", unsubscribe);
            return;
          }

          // "Is one already running?" — what a reloaded page asks before offering a button.
          const jobKind = /^\/api\/cloud\/job$/.test(url.pathname)
            ? url.searchParams.get("kind")
            : null;
          if (jobKind && req.method === "GET") {
            return json(res, 200, { job: getRunningJob(jobKind) });
          }

          // Per-run routes carry an id in the path, so they cannot be exact-matched below.
          const runRoute = /^\/api\/runs\/([^/]+)(\/save)?$/.exec(url.pathname);
          if (runRoute) {
            const id = decodeURIComponent(runRoute[1]);
            if (req.method === "POST" && runRoute[2] === "/save") {
              return json(res, 200, await saveRun(REPO_ROOT, id));
            }
            if (req.method === "DELETE" && !runRoute[2]) {
              await deleteRun(id);
              return json(res, 200, { deleted: id });
            }
          }

          switch (`${req.method} ${url.pathname}`) {
            case "GET /api/healthz":
              return json(res, 200, {
                status: "ok",
                model_loaded: state.modelLoaded,
                gpu_available: true,
                mock: true,
              });

            case "GET /api/gpu":
              return json(res, 200, mockSnapshot());

            case "POST /api/warmup": {
              await new Promise((r) => setTimeout(r, 400));
              state.modelLoaded = true;
              return json(res, 200, {
                model_loaded: true,
                model_load_seconds: 0.4,
                gpu: mockSnapshot(),
              });
            }

            case "POST /api/shutdown":
              state.modelLoaded = false;
              state.runPeak = 0;
              return json(res, 200, { status: "released" });

            /**
             * What the cloud looks like right now, without touching it.
             *
             * Every call here is a metadata read — `gcloud auth list`, `run services describe`,
             * `artifacts docker images describe`. None of them reach the service itself, so
             * none can wake an instance or extend a billed lifetime. Checking is free; that is
             * the whole reason this route can exist at all.
             */
            case "GET /api/cloud/status":
              return json(
                res,
                200,
                await cloudStatus(REPO_ROOT, { refresh: url.searchParams.get("refresh") === "1" }),
              );

            /**
             * Deploy. The build branch runs 15-20 minutes, so this returns a job id at once
             * and the log is streamed separately.
             *
             * The request body is ignored on purpose. FORCE_BUILD would turn a ~2 min deploy
             * into a ~20 min one and is the single most expensive thing a stray click could
             * do, so it is not plumbed — a rebuild is a deliberate act at a terminal.
             */
            case "POST /api/cloud/deploy": {
              const started = startJob({
                kind: "deploy",
                command: join(REPO_ROOT, "scripts/deploy.sh"),
                cwd: REPO_ROOT,
                timeoutMs: 45 * 60_000,
              });
              invalidateCloudStatus();
              return json(res, started.attached ? 200 : 202, started);
            }

            /**
             * Delete the Cloud Run service — the only action that actually stops the meter.
             *
             * Releasing the model frees VRAM but leaves the instance alive, and Cloud Run
             * bills instance lifetime, so without this the app could only ever *advise* the
             * operator to go and run a script. Dev middleware only: this route does not
             * exist on the deployed service and cannot be reached from anywhere but
             * localhost, and it runs the repo's own teardown.sh rather than composing a
             * gcloud command here, so the "keep the image" policy stays in one place.
             *
             * PURGE_IMAGE is pinned to "0" and never read from the request: deleting the
             * ~12 GB image would cost the next session a 15-20 min rebuild, and no UI
             * button should be able to.
             */
            case "POST /api/cloud/teardown": {
              const started = startJob({
                kind: "teardown",
                command: join(REPO_ROOT, "scripts/teardown.sh"),
                cwd: REPO_ROOT,
                env: { PURGE_IMAGE: "0" },
                timeoutMs: 10 * 60_000,
              });
              invalidateCloudStatus();
              return json(res, started.attached ? 200 : 202, started);
            }

            // Real ffmpeg, running locally — this part is not mocked.
            case "POST /api/probe": {
              const { path } = await readJsonBody(req);
              const [probe, identity] = await Promise.all([
                probeVideo(path),
                videoIdentity(path),
              ]);
              return json(res, 200, { ...probe, ...identity, path });
            }

            /**
             * Drag-and-drop target. Browsers never expose a real filesystem path and
             * ffmpeg needs one, so the file is written to a temp dir and the path is
             * handed back. Dev middleware only; the cloud service has no such route.
             */
            case "POST /api/upload": {
              const name = basename(String(req.headers["x-filename"] ?? "upload.mp4"));
              const body = await readRawBody(req);
              if (body.length === 0) return json(res, 400, { detail: "empty upload" });
              // Tidy up before adding to the pile, so the work that fills these directories
              // is also the work that empties them.
              await maybePruneTempDirs().catch(() => {});
              await mkdir(UPLOAD_ROOT, { recursive: true });
              const path = join(UPLOAD_ROOT, `${randomUUID().slice(0, 8)}-${name}`);
              await writeFile(path, body);
              const probe = await probeVideo(path);
              return json(res, 200, {
                path,
                name,
                sizeBytes: body.length,
                sha256: createHash("sha256").update(body).digest("hex"),
                ...probe,
              });
            }

            case "POST /api/extract": {
              const { path, fps = 10, maxFrames = 32, longEdge } = await readJsonBody(req);
              await maybePruneTempDirs().catch(() => {});
              const outDir = join(FRAME_ROOT, randomUUID().slice(0, 8));
              // longEdge is left undefined unless the caller asks, so extractFrames'
              // own 1024 px default applies -- the browser upload path must downscale
              // or a large frame count exceeds Cloud Run's 32 MiB request cap.
              const { frames, plan, probe, scale } = await extractFrames(path, outDir, {
                fps,
                maxFrames,
                ...(longEdge === undefined ? {} : { longEdge }),
              });
              return json(res, 200, { frames, plan, probe, scale, outDir });
            }

            /** Serves extracted frames back to the browser for node thumbnails. */
            case "GET /api/frame": {
              const requested = resolve(url.searchParams.get("path") ?? "");
              // Only ever serve frames this middleware extracted itself.
              if (!requested.startsWith(resolve(FRAME_ROOT) + sep)) {
                return json(res, 403, { detail: "path is outside the frame directory" });
              }
              const bytes = await readFile(requested);
              res.statusCode = 200;
              res.setHeader("content-type", "image/jpeg");
              res.setHeader("cache-control", "no-store");
              return res.end(bytes);
            }

            case "GET /api/runs":
              return json(res, 200, { root: RUNS_ROOT, runs: await listRuns() });

            case "POST /api/runs":
              return json(res, 200, await registerRun(await readJsonBody(req)));

            /**
             * Serve a saved run's bytes. Runs live outside the project (~/verge-runs) so
             * Vite's publicDir cannot reach them. Range is honoured because the npz is ~108 MB
             * and the browser fetches it in 24 MiB chunks.
             */
            case "GET /api/run-artifact": {
              const requested = resolveRunArtifact(url.searchParams.get("path") ?? "");
              if (!requested) return json(res, 403, { detail: "path is outside the runs root" });
              let bytes;
              try {
                bytes = await readFile(requested);
              } catch {
                return json(res, 404, { detail: "no such artifact" });
              }
              const ext = requested.slice(requested.lastIndexOf("."));
              res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
              res.setHeader("accept-ranges", "bytes");
              res.setHeader("cache-control", "no-store");

              const range = /^bytes=(\d+)-(\d+)?$/.exec(String(req.headers.range ?? ""));
              if (range) {
                const start = Number(range[1]);
                const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
                res.statusCode = 206;
                res.setHeader("content-range", `bytes ${start}-${end}/${bytes.length}`);
                return res.end(bytes.subarray(start, end + 1));
              }
              res.statusCode = 200;
              return res.end(bytes);
            }

            case "POST /api/infer": {
              // Two request shapes, both real. The browser sends multipart with the
              // actual JPEGs -- the same bytes the deployed FastAPI service receives --
              // so that path is exercised offline and swapping to the cloud is only a
              // base-URL change. The JSON shape stays for scripted/no-frame callers.
              const contentType = String(req.headers["content-type"] ?? "");
              let frameCount;
              let wireParams;
              if (contentType.startsWith("multipart/form-data")) {
                const form = await new Request("http://local/api/infer", {
                  method: "POST",
                  headers: { "content-type": contentType },
                  body: await readRawBody(req),
                }).formData();
                const files = form.getAll("frames");
                if (files.length === 0) return json(res, 400, { detail: "no frames uploaded" });
                frameCount = files.length;
                wireParams = JSON.parse(String(form.get("params") ?? "{}"));
              } else {
                const body = await readJsonBody(req);
                frameCount = body.frameCount ?? 4;
                wireParams = {
                  fps: body.fps ?? 10,
                  process_res: body.processRes ?? 504,
                };
              }

              const fps = wireParams.fps ?? 10;
              const processRes = wireParams.process_res ?? 504;
              const peak = estimateVramBytes(frameCount, processRes);
              // Rough: 7.67 GPU-seconds for 4 frames, scaled super-linearly.
              const gpuSeconds = 1.9 * frameCount ** 1.15 * (processRes / 504) ** 2;

              state.modelLoaded = true;
              state.busy = true;
              state.runStartedAt = Date.now();
              state.runPeak = peak;
              state.runMs = Math.min(gpuSeconds * 1000, 6000);
              await new Promise((r) => setTimeout(r, state.runMs));
              state.busy = false;

              const glb = await readFile(new URL("scene.glb", FIXTURE_DIR));
              const npz = await readFile(new URL("result.npz", FIXTURE_DIR));
              return json(res, 200, {
                schema_version: "verge.infer-manifest/0.1.0",
                run_id: `mock-${randomUUID().slice(0, 8)}`,
                model_repository_id: "depth-anything/DA3NESTED-GIANT-LARGE-1.1",
                model_revision: "b2359bdf726fb44ef62acca04d629dcf158053e7",
                depth_mode: "metric",
                linear_unit: "metre",
                params: {
                  fps,
                  source_duration_s: wireParams.source_duration_s ?? null,
                  process_res: processRes,
                  process_res_method: wireParams.process_res_method ?? "upper_bound_resize",
                  ref_view_strategy: wireParams.ref_view_strategy ?? "middle",
                  infer_gs: wireParams.infer_gs ?? false,
                  max_frames: wireParams.max_frames ?? 32,
                },
                /**
                 * `count` is the FIXTURE's frame count, not the upload's.
                 *
                 * It used to echo however many JPEGs arrived, which made the manifest describe
                 * data it did not have: the roadside npz holds 4 frames, so every frame index
                 * past 3 sliced off the end of the array. Combined with the fact that the app
                 * takes RGB from the local extraction and geometry from the manifest, a mock
                 * run wore the new clip's face while carrying an unrelated scene's geometry —
                 * which is exactly how a mock run got mistaken for a real one on 2026-08-05.
                 *
                 * `uploaded_count` keeps the "did the server really receive N JPEGs?" check
                 * that the multipart path is verified with.
                 */
                frames: {
                  count: FIXTURE_FRAME_COUNT,
                  requested_count: frameCount,
                  uploaded_count: frameCount,
                  width: 518,
                  height: 294,
                  capped: false,
                  effective_fps: fps,
                },
                timing: { gpu_seconds: gpuSeconds, wall_seconds: gpuSeconds + 1.2 },
                vram: {
                  peak_bytes: Math.round(peak),
                  current_bytes: Math.round(VRAM_BASE_BYTES),
                  total_bytes: TOTAL_VRAM_BYTES,
                  device_name: "NVIDIA L4 (mock)",
                  // The allocator peak excludes the CUDA context the driver number
                  // includes, so it is always the smaller of the two on real hardware.
                  torch_peak_bytes: Math.round(peak - 1.1 * 1024 ** 3),
                  baseline_bytes: Math.round(VRAM_BASE_BYTES),
                },
                artifacts: [
                  {
                    kind: "glb",
                    name: "scene.glb",
                    size_bytes: glb.length,
                    sha256: "fixture",
                    url: "/roadside/scene.glb",
                  },
                  {
                    kind: "npz",
                    name: "result.npz",
                    size_bytes: npz.length,
                    sha256: "fixture",
                    url: "/roadside/result.npz",
                  },
                ],
                // The fixture predates the split, so it has one npz under the "npz"
                // kind and no native export to sit beside it.
                diagnostics: {
                  native_npz: {},
                  export_dir_listing: ["scene.glb", "result.npz"],
                },
                transient: true,
                expires_after_days: 3,
                mock: true,
              });
            }

            default:
              return json(res, 404, { detail: `no mock route for ${req.method} ${url.pathname}` });
          }
        } catch (err) {
          return json(res, 500, { detail: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}
