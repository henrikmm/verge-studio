# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-08-01 · M2a complete

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2a — Node graph, local only | **done** (one carve-out: mock badge) |
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

`test_demo.mp4` in the repo root — the user's room, a **walk-through with real camera
translation** (confirmed by the user, so cross-view attention has parallax to work with).
Covered by `.gitignore`'s `*.mp4`; **never commit it.**

Measured with ffprobe on 2026-08-01:

| | |
|---|---|
| Duration | 26.61 s |
| Resolution | 3840×2160 (4K) |
| Codec | HEVC |
| Native fps | 59.37 (1579 frames) |
| Size | 172 MB |

- Run it **at full length**, not a trimmed window.
- 26.61 s against the current 32-frame cap is only **1.20 effective fps** (DA3's own default is
  10). `max_frames=32` is a VRAM safety cap, NOT a quality decision, and NOT a measured ceiling —
  it is simply the largest count ever run. Find the real ceiling with the frame ladder in M2b.
  Note the cap never truncates the clip: `planFrames` lowers fps so the frames still span all
  26.61 s.
- ⚠️ **Frames must be downscaled before upload.** Measured JPEG sizes from this clip:
  native 4K ≈ **432 KB/frame** (32 frames ≈ 13 MB, 96 frames ≈ **40 MB**); scaled to 1024 px on
  the long edge ≈ **62 KB/frame** (96 frames ≈ 6 MB). Cloud Run's documented HTTP/1 request cap
  is 32 MiB, so the top of the frame ladder would likely fail on native frames — and the bytes
  are wasted regardless, because DA3 resizes to `process_res` (504) internally.
  `scripts/extract-frames.mjs` has **no scaling option**; add one before the cloud session.
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

## M2a — Node graph, local only ✅ (mostly)

Zero cloud cost. Ticked items were exercised in the browser, not merely written.

- [x] `@xyflow/react` 12.11.2 added (React Flow; React 19 compatible, MIT)
- [x] `app/src/graph/cache-key.ts` — TS port of donor `content-hash.js`, with a parity test
      against golden vectors generated **from the donor file** by
      `scripts/gen-cache-key-vectors.mjs`. App code never imports `donor/`.
- [x] `app/src/graph/types.ts` — `PortType` union bound to the DESIGN.md port colors; `NodeSpec`
      with a `controls` schema so the inspector is generic
- [x] `app/src/graph/graph-store.ts` — same `useSyncExternalStore` pattern as `session-store.ts`
- [x] `app/src/graph/evaluate.ts` — topological walk; changed key stales that node **and
      everything downstream only**. 21 unit tests, incl. the real pipeline's behaviour.
- [x] Nodes: `FrameSource`, `DA3Depth`, `PointCloud`, `Viewer3D` / `Viewer2D`
- [x] `POST /api/upload` + `GET /api/frame` in the Vite dev middleware (drag-drop → temp path
      for ffmpeg; frame serving has a path-traversal guard, verified 403 on `/etc/passwd`)
- [x] Node cards per `docs/DESIGN.md` (colored header, A/P badge, labelled ports, thumbnail, ms footer)
- [x] Inspector bound to node selection; stale nodes dim until re-run
- [x] **Panes read from a manifest, not a hardcoded path.** Verified: the viewport renders
      351,232 pts arriving through the graph. Pointing at the cloud is now a base-URL change.
- [x] Design-review fix-list from 2026-07-31 — all four items done, see `docs/design-review-log.md`
- [x] **The mock now parses real multipart**, so the browser's upload path is identical offline
      and in the cloud. `Last run · Frames 30` confirmed the server counted 30 uploaded JPEGs.
- [ ] **Mock-vs-real badge on `DA3Depth`.** NOT done — the mock returns `mock: true` but nothing
      surfaces it on the card. Honesty rule 3 is currently unmet for the node graph; a screenshot
      of a fixture-driven run is not distinguishable from a real one except via the status bar's
      `NVIDIA L4 (mock)`.

Deliberately excluded from M2a: any real cloud run, the splat node, the cost ticker.

### Verified behaviours (driven in-browser, 2026-08-01)

- Dropping a clip runs **only** Frame Source; DA3 Depth and everything downstream stay stale.
  A slider drag cannot bill. This is the central safety property of the execution model.
- An explicit Run walks the whole chain and leaves the graph reading `all current`.
- Changing a downstream CPU param does not restamp DA3 Depth (unit-tested on the real pipeline).

### NOT verified in M2a

- **Orbit/pan interaction was not re-measured.** `readPixels` returns a cleared buffer outside
  the render frame, and rAF is paused while the browser pane is hidden — which it is whenever
  the JS tool runs — so the M0 checksum technique could not be repeated. The OrbitControls code
  is unchanged; only its data source changed. Re-measure before claiming the viewport is good.
- Node deletion, edge deletion and rewiring by drag are implemented but were never exercised.
- `PaneControls` supports a `Remove` button that is not wired (Dockview owns pane lifecycle).
- Pausing a pane stops the depth pane re-fetching but not the 3D render loop.
- The acceptance checklist in `docs/DESIGN.md` has not been re-graded end to end since the
  layout gained the control/OUTPUT rows.

## M2b — One warm cloud session ⬜

Blocked on M2a. Plan the whole batch before deploying; do not deploy to do one of these.

- [ ] **Add frame downscaling to `scripts/extract-frames.mjs` BEFORE deploying** (long edge
      ~1024 px). This is now a hard prerequisite for the ladder below, not a nicety: at native
      4K (432 KB/frame) a 128-frame run is ~55 MB and a 256-frame run ~110 MB, both far over
      Cloud Run's documented 32 MiB HTTP/1 request cap. At 1024 px (62 KB/frame) even 256 frames
      is ~16 MB and fits. The bytes are wasted regardless — DA3 resizes to `process_res` (504)
      internally. Local-only change, verifiable with `verify.sh`; do not spend a warm instance
      discovering this.
- [ ] Fix `VramSampler` **first** (see open follow-ups) so the ladder below measures something real
- [ ] **Frame-count ladder — double until it breaks: 32 → 64 → 128 → 192 → 256.** Each run is
      seconds and an OOM costs only an error message, so push to actual failure rather than
      stopping at a comfortable number. Then bisect the last good interval.

      Why this matters: `max_frames=32` is a *hardware* cap, not a quality choice, and it is
      only "the highest count anyone has measured", not a known ceiling. At 26.61 s it forces
      **1.20 effective fps** against DA3's own 10 fps default. The clip is still fully spanned
      (`planFrames` lowers fps rather than truncating), but the sampling is sparse.

      What the measured slope predicts: activations grow ≈0.14 GiB/frame (3.55 GiB at 4 frames
      → 7.46 GiB at 32), so `(22.03 − 6.57) / 0.14 ≈ **110 frames** at 504 px` ≈ 4.1 fps.
      260 frames would need ≈46 GiB and will certainly OOM. Treat both numbers as linear
      extrapolation across an 8× gap from allocator-contaminated readings — the ladder is what
      replaces them with fact.

- [ ] **Second ladder at reduced `process_res`, if 10 fps is wanted.** VRAM scales ≈ res², so
      resolution is the lever that buys frames: 504→356 roughly doubles the frame budget
      (~220 frames), 504→252 roughly quadruples it (~440), at which point the 266 frames a
      10 fps sampling of this clip wants would fit. Whether that trade is worth it is a
      MEASUREMENT-ACCURACY question, not a VRAM one — defer the verdict to M3's tape-measure
      comparison, and save artifacts from more than one setting so M3 can compare offline
      without another cloud session.
- [ ] Room video end-to-end **through the browser**. The multipart path is no longer untested —
      M2a exercised it against the dev middleware, which parses the same body FastAPI does — but
      it has still never crossed a network to the real service (auth headers, CORS, request size
      limits, timeouts are all unexercised).
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
5. ⚠️ **Never extract a frame ladder one rung at a time — it froze the Mac (2026-08-01).**
   Sampling by FPS spreads frames across the clip, so ffmpeg decodes the **entire** video for
   *any* frame count: 1579 frames of 3840×2160 HEVC whether you asked for 32 or 256. Running
   five rungs meant five full 4K decodes. This machine has **6 cores, only 2 of them
   performance**, and software HEVC decode saturated all of them until the system locked up and
   needed a restart. The tell was in the numbers: 32 frames took 116 s and 64 frames took 319 s
   despite decoding *identical* work — that 2.75× gap was thermal/contention degradation, not
   frame count.
   Fixed three ways in `scripts/extract-frames.mjs`, all verified:
   - `--ladder 32,64,128,192,256` decodes **once** at the largest rung and hardlinks the
     smaller ones as strided subsets (`pickEvenly`). Every rung still spans the whole clip.
   - `-hwaccel videotoolbox` on darwin (measured 2.7× faster: 4.8 s → 1.8 s on a 3 s window),
     with automatic fallback to software if hardware decode refuses the codec.
   - `-threads 2`, so a long pass leaves the machine usable.
   Result: **the whole ladder now takes 13 s**, versus 435 s for two rungs before.
   Do not "optimise" this back into a per-rung loop.
