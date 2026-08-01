# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-07-31 · commit `5649284`

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2a — Node graph, local only | not started |
| M2b — One warm cloud session | not started (blocked on M2a) |
| M3 — Height measurement (the goal) | not started (blocked on M2b's fixture) |
| M4 — Splats + polish | not started |

---

## Agreed direction (2026-07-31) — read before planning anything

M2 was split in two, because the expensive thing about cloud work is the *session*, not the run.

- **M2a is entirely local.** Graph engine, node cards, inspector binding, panes reading from a
  manifest instead of a hardcoded fixture path. Verified on the mock + fixture at zero cloud cost.
  It stands alone: if M2b never happens, M2a is still a complete, committed unit.
- **M2b is exactly one warm cloud session**, batching every outstanding GPU-dependent item at
  once: the room video end-to-end through the browser, the two open bugs below, the frame-count
  ladder, and one `infer_gs=true` run. One cold start closes five items.
- **M3 is then fully offline** against the fixture M2b brings home.

Decisions made, do not relitigate without reason:

1. **Execution model: CPU nodes auto-run, the GPU node never does.** `DA3Depth` goes amber-stale
   and waits for an explicit Run, so dragging a slider can never bill. Per-node `A`/`P` badges
   override either way.
2. **Video input: drag-and-drop via a dev-only `POST /api/upload`** in the Vite middleware
   (writes to a temp dir, returns the path, localhost only, never part of the cloud service).
   ffmpeg needs a real path and browsers do not expose one.
3. **Session cost ticker: deferred to M2b**, where real billing exists. It stays `$0.00` and
   unlabelled until then rather than showing an invented number.
4. **Keep the image, delete the service.** See the Cloud discipline section of `CLAUDE.md` —
   the rule was reversed on 2026-07-31 after we noticed the old one optimised the cheap axis.

### The M3 test video

`teste_demo.mp4` in the repo root — the user's room, ~28 s, containing objects whose real
physical dimensions they know. Covered by `.gitignore`'s `*.mp4`; **never commit it.**

- Run it **at full length**, not a trimmed window.
- 28 s against the current 32-frame cap is only **1.14 effective fps** (DA3's own default is 10).
  Find the real ceiling with the frame ladder in M2b rather than accepting 1.14.
- Still needed from the user: the tape-measure truths (object, dimension, metres) and which
  object is the `ScaleCheck` calibration reference. That list becomes `MEASUREMENTS.md`.
- Clip quality caveat: DA3 needs **camera translation, not rotation**. If the clip is a pan from
  a fixed point there is no parallax, cross-view attention has nothing to work with, and the
  geometry will be poor no matter what the downstream code does. Check this before spending a
  session on it.

---

## M0 — Bootstrap + offline viewer ✅

- [x] Repo scaffold, `git init`, folder layout
- [x] Harness: `CLAUDE.md`, `docs/DESIGN.md`, `docs/SOURCES.md`, `design-review` skill, `scripts/verify.sh`
- [x] Donor assets copied (`donor/`, `fixtures/roadside/`)
- [x] Dockview shell, 4 panes, Sentinel-dark theme
- [x] Three.js viewport renders DA3-native `scene.glb` (351,232 pts) with orbit
- [x] Depth pane: turbo colormap from `result.npz`, metric legend
- [x] `verify.sh` green; design review recorded

## M1 — GPU service live ✅

- [x] L4 GPU quota confirmed on `verge-lab` (requires `--no-gpu-zonal-redundancy`)
- [x] Shared `/infer` contract: `server/contract.py` ↔ `app/src/lib/contract.ts`
- [x] Local ffmpeg frame extraction, FPS-based (`scripts/extract-frames.mjs`)
- [x] FastAPI service: `/health`, `/warmup`, `/infer`, `/gpu`, `/shutdown`
- [x] Dockerfile: Job → Service, ffmpeg/yt-dlp removed, build-time import check
- [x] Fixture-backed mock in the Vite dev server (offline UI, zero cost)
- [x] VRAM telemetry: live bar in inspector + status bar, driver-level sampling
- [x] Inference params exposed in UI (fps, clip length, process res, max frames, ref view, splats)
- [x] `deploy.sh` / `teardown.sh` / `smoke-infer.sh` / `vram-sweep.sh`
- [x] Deployed to Cloud Run, ran the batched VRAM sweep, recorded `docs/vram-measurements.json`
- [x] Frame cap set from measurement (32), device constants corrected from measurement
- [x] All cloud resources torn down (0 services, 0 repositories, staging bucket emptied)

### Deliberately NOT done in M1 — carry into M2

These were in the M1 plan but are not implemented. Do not assume they work.

- [ ] **Transient GCS storage + lifecycle rule.** `server/main.py::_publish` has the GCS branch
      written but `VERGE_OUTPUT_BUCKET` was never set, no bucket exists, and no ≤3-day lifecycle
      rule was created. Every run so far served artifacts from the container's local disk.
- [ ] **Explicit Save action.** The "persist only on Save" half of the storage policy is unbuilt.
- [ ] **Signed URLs for artifacts.** Untouched; the local-disk fallback was used throughout.
- [ ] **`infer_gs` / Gaussian splats never exercised on GPU.** The parameter is plumbed end to
      end but every real run used `infer_gs=false`. Assume it is untested, not working.
- [ ] **The app has never consumed a real cloud manifest.** The viewport still loads the fixture.
      The multipart upload path in `app/src/lib/infer-client.ts::infer()` has NOT been run against
      the deployed service — the sweep used `curl` from a shell script instead. That seam is
      unverified; expect bugs the first time the browser talks to a real service.

## Open follow-ups (bugs/limitations found, not yet fixed)

- [ ] **Isolate per-run VRAM peaks.** `server/vram.py::VramSampler` reads driver memory, which
      includes PyTorch's caching allocator holding blocks from *previous* runs. On a warm
      instance the sweep reports cumulative high-water marks — visible as 8 and 16 frames both
      reporting exactly 12.79 GiB, and 24 and 32 both 14.03 GiB. Fix: `empty_cache()` +
      `reset_peak_memory_stats()` before each run, and record `max_memory_allocated()` alongside
      the driver number. The current figures are safe **upper bounds**, fine for a frame cap, but
      they are not a cost model.
- [ ] **`result.npz` may clobber DA3's native npz.** `_run_inference` writes its own
      `result.npz` (keys matching the fixture and `npz.ts`) into the same `export_dir` DA3's
      `npz` exporter writes to. If DA3 emits the same filename, ours overwrites it and the
      embedded images are lost. Rename ours and confirm DA3's native key names from a real run.

## M2a — Node graph, local only ⬜

Zero cloud cost. Everything below is verifiable against the mock + `fixtures/roadside/`.

- [ ] `@xyflow/react` 12.x added (React Flow; React 19 compatible, MIT)
- [ ] `app/src/graph/cache-key.ts` — TS port of donor `content-hash.js`, with a **parity test
      producing byte-identical digests to the donor file** (the donor is the reference impl)
- [ ] `app/src/graph/types.ts` — `PortType` union bound to the DESIGN.md port colors; `NodeSpec`
- [ ] `app/src/graph/graph-store.ts` — nodes/edges/params/results, same `useSyncExternalStore`
      pattern as `session-store.ts` (no new state library)
- [ ] `app/src/graph/evaluate.ts` — topological walk; cache key = f(producer, version, params,
      upstream output hashes); changed key stales that node **and everything downstream only**
- [ ] Nodes: `FrameSource`, `DA3Depth`, `PointCloud`, `Viewer3D` / `Viewer2D`
- [ ] `POST /api/upload` in the Vite dev middleware (drag-drop → temp path for ffmpeg)
- [ ] Node cards per `docs/DESIGN.md` (colored header, A/P badges, labelled ports, thumbnail, ms footer)
- [ ] Inspector bound to node selection; stale nodes dim until re-run
- [ ] **Panes read from a manifest, not a hardcoded path.** `viewport-3d.tsx` currently hardcodes
      `loader.load("/roadside/scene.glb")`; it must load the GLB artifact URL its upstream node
      emits. The mock already returns fixture URLs, so this changes nothing visually while making
      the cloud seam real — pointing at the deployed service becomes a base-URL change.
- [ ] Mock-vs-real badge on `DA3Depth` (the mock already returns `mock: true`) — honesty rule 3
- [ ] Design-review fix-list from 2026-07-31 (pane control row with Remove/Pause, OUTPUT toggle
      chips, warm-toned graph canvas, graph banner) — see `docs/design-review-log.md`

Deliberately excluded from M2a: any real cloud run, the splat node, the cost ticker.

## M2b — One warm cloud session ⬜

Blocked on M2a. Plan the whole batch before deploying; do not deploy to do one of these.

- [ ] Fix `VramSampler` **first** (see open follow-ups) so the ladder below measures something real
- [ ] Frame-count ladder on the room clip: 32 → 48 → 64 → 96. Each run is seconds and an OOM costs
      only an error, so find the true ceiling instead of extrapolating from 32.
- [ ] Room video end-to-end **through the browser** — this is the first real exercise of
      `infer-client.ts::infer()`'s multipart path. Expect bugs.
- [ ] `scripts/save-run.sh` — download the manifest's artifacts **before teardown**. Artifacts live
      on the container's local disk (no GCS bucket exists) and **die with the instance**.
- [ ] Confirm DA3's native npz key names and fix the `result.npz` clobber (see open follow-ups)
- [ ] One `infer_gs=true` run to find out whether it works at all
- [ ] Session cost ticker, driven by instance lifetime (not inference seconds)
- [ ] `scripts/teardown.sh` (keeps the image now — that is intended)

Known consequence: a 64–96 frame run's GLB will be far over the 5 MB commit limit (the 4-frame
roadside GLB is already 5.6 MB). `fixtures/room/` will therefore be **local-only and gitignored**,
with only its `manifest.json` + checksums committed. It will not survive a fresh clone.

## M3 — Height measurement ⬜

Runs fully offline against `fixtures/room/` once M2b brings it home.

- [ ] `MEASUREMENTS.md` seeded with the user's tape-measure truths (needed *before* M2b films)
- [ ] `geometry/` is still an **empty directory** — nothing implemented
- [ ] `GroundPlane` (robust/RANSAC plane fit)
- [ ] `ScaleCheck` (known-object calibration, seeded from donor `scale.js`)
- [ ] `MeasureHeight` (height above ground ± uncertainty, 3D ruler overlay)
- [ ] `MEASUREMENTS.md` with 3+ objects, predicted vs tape-measure truth

## M4 — Splats + polish ⬜

- [ ] `infer_gs=True` path proven on GPU → `gs_ply` (+ optional `gs_video`)
- [ ] Splat viewer node via `@mkkellogg/gaussian-splats-3d`
- [ ] Per-node cost accounting

---

## Resuming work

```bash
cd app && npm install && npm run dev     # localhost:5173, fully offline (mock + real ffmpeg)
./scripts/verify.sh                      # 24 tests: typecheck, units, fixture smoke, server contract
```

`verify.sh` skips the server-contract test unless a Python with `fastapi` is on `PATH`;
pass `VERGE_PY=/path/to/venv/bin/python` to include it.

Cloud is **fully torn down**, including the image (the repository was deleted under the old
policy), so the *next* deploy still pays the full 15–20 min build once. Every deploy after that
should skip it.

```bash
./scripts/deploy.sh                  # builds only if server/ changed since the stored image
./scripts/teardown.sh                # deletes the service, KEEPS the image
PURGE_IMAGE=1 ./scripts/teardown.sh  # ...and deletes the image, when the project is done
FORCE_BUILD=1 ./scripts/deploy.sh    # rebuild even when the source hash matches
```

⚠️ **The build-skip logic is UNVERIFIED.** `deploy.sh` now tags the image `src-<hash of server/>`
and skips the build when that tag already exists in Artifact Registry. Locally the hash computes
(`73e73d76427701b9` at time of writing) and both scripts pass `bash -n`, but the registry
describe/skip branch has never run against real GCP. Watch it on the first two M2b deploys: the
first should build, the second should print "already in the registry, skipping build".

## Measured facts (do not re-derive)

- L4 usable VRAM: **22.03 GiB** (23,659,151,360 B) — not 24 GiB.
- Model resident after load: 6.57 GiB. Cold start **64 s**, model load 40 s.
- Peak VRAM @ 504 px: 4f=10.12 · 8f=12.79 · 16f=12.79 · 24f=14.03 · 32f=14.03 GiB. No OOM at 32.
- Inference: 2.2–6.4 s GPU for 4–32 frames.
- Upstream defaults: HF Space samples video at **10 fps with no frame cap**; `process_res=504`;
  use `ref_view_strategy="middle"` for ordered video.

## Gotchas that cost time (details in `docs/SOURCES.md`)

1. `/healthz` is swallowed by Cloud Run's frontend — use `/health`. Probe another path before
   concluding a container is dead.
2. `gcloud auth print-identity-token` has the wrong audience for Cloud Run → 404, not 403.
   Use `gcloud run services proxy`; don't make the GPU service public.
3. Dropping `ffmpeg` from the image drops OpenCV's libs, which DA3 needs (`libglib2.0-0`, `libgl1`).
4. Coordinate-based clicks in the Claude browser pane are mis-scaled (~7.8×). Use `ref`-based
   input, and verify canvas changes with a WebGL `readPixels` checksum, not screenshots.
