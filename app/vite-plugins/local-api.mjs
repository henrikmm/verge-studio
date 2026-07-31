// Local dev API: real ffmpeg extraction + a fixture-backed mock of the DA3 service.
//
// Serves the exact /infer contract the cloud service serves, so the whole frontend
// can be built and reviewed offline at zero cost. Swapping to the real service is a
// base-URL change, nothing more.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFrames, probeVideo } from "../../scripts/extract-frames.mjs";

const FIXTURE_DIR = new URL("../../fixtures/roadside/", import.meta.url);

/**
 * PLACEHOLDER VRAM MODEL — fitted to a single real datapoint (4 frames @ 392 px =
 * 8.53 GiB on an L4) and therefore not trustworthy for capacity planning. It exists
 * so the UI has something to render offline and so the cap warnings are exercised.
 * scripts/vram-sweep.sh replaces these constants with measured values.
 *
 * Keep in sync with the same constants in app/src/lib/contract.ts.
 */
const VRAM_BASE_BYTES = 6.0 * 1024 ** 3;
const VRAM_PER_FRAME_AT_504 = 1.045 * 1024 ** 3;
const TOTAL_VRAM_BYTES = 24 * 1024 ** 3;

export function estimateVramBytes(frameCount, processRes) {
  const resScale = (processRes / 504) ** 2;
  return VRAM_BASE_BYTES + frameCount * resScale * VRAM_PER_FRAME_AT_504;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
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
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();

        try {
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

            // Real ffmpeg, running locally — this part is not mocked.
            case "POST /api/probe": {
              const { path } = await readJsonBody(req);
              return json(res, 200, await probeVideo(path));
            }

            case "POST /api/extract": {
              const { path, fps = 10, maxFrames = 32 } = await readJsonBody(req);
              const outDir = join(tmpdir(), "verge-frames", randomUUID().slice(0, 8));
              const { frames, plan, probe } = await extractFrames(path, outDir, { fps, maxFrames });
              return json(res, 200, { frames, plan, probe, outDir });
            }

            case "POST /api/infer": {
              const { frameCount = 4, processRes = 504, fps = 10 } = await readJsonBody(req);
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
                  process_res: processRes,
                  process_res_method: "upper_bound_resize",
                  ref_view_strategy: "middle",
                  infer_gs: false,
                  max_frames: 32,
                },
                frames: {
                  count: frameCount,
                  requested_count: frameCount,
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
