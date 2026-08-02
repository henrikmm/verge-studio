# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-08-02 · M3b implemented, coordinate-checked and graded offline; 504px/112f
is the current raw clip-B operating point. B4 remains honestly ungraded because its lower
endpoint is occluded.

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2a — Node graph, local only | **done** (one carve-out: mock badge) |
| M2b — One warm cloud session | **done** (fixture home, service deleted) |
| M3.0 — Door-clip fixture (one warm session) | **done** (3 fixtures local, service deleted) |
| M3a — Geometry core (offline) | **done** (84 geometry tests, incl. real fixture) |
| M3b — Mask → measurement → grading | **done** (B4 unavailable in this clip) |
| M3c — Automatic segmentation | not started |
| M3d — Field/raster regime (vegetation) | deferred |
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

### The test videos — two clips, and B is the one that matters

Both are `.gitignore`d by `*.mp4`; **never commit either.** Ground truth for both lives in
`MEASUREMENTS.md`.

| | **Clip B — `test-demo-door.mp4`** (primary) | Clip A — `test_demo.mp4` |
|---|---|---|
| Duration | 35.57 s | 26.61 s |
| Stored resolution | 1920×1080 | 3840×2160 |
| **Displayed** resolution | **1080×1920 (portrait, `rotation=-90`)** | 3840×2160 (landscape) |
| Codec / frames | HEVC · 1067 @ 30 fps | HEVC · 1579 @ 59.37 fps |
| Size | 55.6 MB | 172 MB |
| References in frame | door **2.10 m**, table 0.750 m, PC tower 0.45 m, monitor 0.534 m | table, monitor only |

**Clip B supersedes clip A for grading.** Same room, but it contains the door — and because
metric scale does **not** transfer between clips (see the M3 section), every reference used to
judge a reconstruction has to be visible *in that same reconstruction*. Clip A's longest
reference is 0.750 m; clip B's is 2.10 m, ~2.8× less fractional error for the same absolute
endpoint-location error.

Clip A keeps one job: it already has three fixtures at different `process_res`
(`fixtures/room/`), so it can answer resolution-vs-frames offline at zero cloud cost.

- ⚠️ **Clip B is portrait via rotation metadata.** `ffprobe stream=width,height` reports the
  *stored* 1920×1080; ffmpeg autorotates on decode and hands the filter chain 1080×1920. Any
  code that plans a scale filter from the stored dimensions will squash the frame. This bit
  `scripts/extract-frames.mjs` — see "Bugs found and FIXED" below.
- Run clips **at full length**, never a trimmed window.
- Frames are downscaled to a 1024 px long edge before upload (done in M2b). Measured on clip A:
  native 4K **460 KB/frame** vs **56.6 KB/frame** scaled. Cloud Run's HTTP/1 request cap is
  32 MiB, and DA3 resizes to `process_res` internally anyway, so the bytes are pure waste.
- Camera translation is **confirmed for clip A** — camera centres span 1.26 × 1.28 × 1.69 m
  across the 112 frames, measured from the fixture's own extrinsics. DA3 needs translation, not
  rotation: a pan from a fixed point has no parallax and cross-view attention has nothing to
  work with. Re-check this for clip B once its fixture exists.
- Clip B's room is **white, textureless walls + a glossy dark monitor + a tiled floor seen at a
  grazing angle**. Those are the three canonical failure surfaces for every model in this
  family. Expect the wall geometry to be the softest part of the reconstruction, and gate
  geometry on DA3's confidence map rather than trusting all points equally.

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

- [x] ~~Isolate per-run VRAM peaks~~ — fixed in M2b, see `server/vram.py`.
- [x] ~~`result.npz` may clobber DA3's native npz~~ — measured in M2b: DA3 writes no npz at
      all, so there was nothing to clobber. Ours renamed to `verge-result.npz` defensively.
- [ ] **`infer_gs` is broken: `gsplat` is missing from the image.** One real run returned
      `name 'rasterization' is not defined`. ⚠️ **Corrected 2026-08-01: this is NOT a one-line
      pip addition.** The base image is `pytorch/pytorch:2.5.1-cuda12.1-cudnn9-**runtime**`,
      which has no `nvcc`; gsplat compiles CUDA extensions at install or JIT at first use, so it
      needs a `-devel` base (bigger image, longer build) or a prebuilt wheel matching torch
      2.5.1/cu121. Deliberately NOT bundled into the M3 rebuild: an unproven base-image swap
      would have risked the M3 session on an M4 feature. Treat splats as unavailable. Blocks M4.
- [ ] **Cloud Run's 32 MiB response cap makes a one-shot `/artifact` fetch unusable for the npz.** A 108 MB
      npz returns **HTTP 500 with zero bytes**, direct and through the proxy alike; the 16 MB
      GLB is fine. M3b added the same 24 MiB range-aware retrieval to the browser and it is
      covered by unit tests, but that path has not been exercised against a live Cloud Run
      instance since implementation. Durable fixes, in preference order:
      (a) the GCS + signed-URL path that was always the plan, which sidesteps the cap entirely;
      (b) a `mini_npz` export or float16/subsampled depth, which would also cut 108 MB to
      something sane. Treat live-cloud browser verification as the remaining part of this item.
      **This is the main reason M3 should read the fixture from disk, not over HTTP.**
- [ ] **`scene.jpg` is produced but never collected** — no `.jpg` in `_collect_artifacts`.
- [ ] **`predictVram` interpolation table stops at 128** while the measured envelope reaches
      144. `MAX_MEASURED_FRAMES` says 144, so 129–144 is flagged as extrapolation even though
      it was measured. Cosmetic, but it makes the UI slightly more pessimistic than the data.

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

## M2b — One warm cloud session ✅

**One session, 2026-08-01.** Build 19m30s (registry had been deleted under the old policy),
service warm ~50 min, **deleted at the end — 0 Cloud Run services remain**. Image kept
(9.8 GB, ~$1/month) so the next deploy skips the build.

- [x] **Frame downscaling** in `scripts/extract-frames.mjs` (1024 px long edge, default on).
      Measured on the real clip: native 4K **460 KB/frame** vs **56.6 KB/frame** scaled.
      128 frames would have been 57.5 MB — over Cloud Run's 32 MiB request cap. Now 14.5 MB
      at 256 frames.
- [x] **`VramSampler` isolates per-run peaks** — `synchronize()` + `empty_cache()` +
      `reset_peak_memory_stats()` at entry; records driver peak, allocator peak and the
      pre-run baseline. The manifest carries all three (`VramStats.torch_peak_bytes`,
      `baseline_bytes`). Proven by the ladder: readings now track frame count instead of
      quantising to allocator growth steps.
- [x] **Frame ladder to actual OOM**, then bisected. See "Measured facts" below.
- [x] **Second ladder at reduced `process_res`** (356 and 252 px). 10 fps IS reachable.
- [x] **Room video end-to-end through the browser, against the real service.** All five
      nodes green; `mock:false`, device `NVIDIA L4`, card reads `112f · 30.5s GPU` with no
      MOCK suffix. The 3D viewport rendered 1,000,000 points of the actual room.
- [x] **`scripts/save-run.sh`** — three fixtures downloaded, sha256-verified, before teardown.
- [x] **DA3 npz question answered** (see below — there was no clobber).
- [x] **`scripts/teardown.sh`** — service deleted, image kept, staging cleared.
- [x] Mock-vs-real badge on `DA3Depth` (carried over from M2a; now closed).

### The fixture — LOCAL ONLY, not in git

`fixtures/room/` holds three settings, **346 MB total**, gitignored except `manifest.json`
and `SHA256SUMS`. **A fresh clone will not have the payloads** — regenerate with a cloud run
plus `save-run.sh`. All three verified to parse with numpy: `depth`, `confidence`,
`extrinsics` (N,3,4), `intrinsics` (N,3,3), all float32 and finite.

| Directory | Frames | process_res | Depth output | Depth range | GPU |
|---|---|---|---|---|---|
| `504px-112f` | 112 @ 4.21 fps | 504 | 504×280 | 0.28–4.16 m | 30.2 s |
| `356px-256f` | 256 @ 9.62 fps | 356 | 350×196 | 0.24–3.61 m | 35.2 s |
| `252px-256f` | 256 @ 9.62 fps | 252 | 252×140 | 0.22–2.63 m | 16.2 s |

M3 compares these offline. **No further cloud session is needed to decide the
resolution-vs-frames trade** — that was the point of saving more than one.

### NOT done in M2b, with reasons

- [ ] **`infer_gs` DOES NOT WORK.** One run at 32 frames failed with
      `name 'rasterization' is not defined`. Root cause: `server/Dockerfile` line 17 installs
      xformers, google-cloud-storage, fastapi, uvicorn, python-multipart and DA3 — but **not
      `gsplat`**, which provides `rasterization` for DA3's splat path. Fix is to add `gsplat`
      to that pip install, which costs a full ~20 min rebuild. Deferred to M4, where the splat
      viewer work makes the rebuild worth paying for. The parameter is plumbed correctly end
      to end; only the image dependency is missing.
- [ ] **Session cost ticker** — still `$0.00` and unlabelled. Not built. The instance-lifetime
      data now exists to drive it (build 19m30s, warm ~50 min) but nothing consumes it.
- [ ] **Transient GCS storage, signed URLs, explicit Save.** Untouched, as in M1. Artifacts
      still come off the container's local disk. `save-run.sh` is the manual stand-in.
- [ ] **`scene.jpg`** appears in the export dir but is not collected as an artifact (no `.jpg`
      in `_collect_artifacts`' suffix map). Harmless, but it means one DA3 output is never
      served or saved. Decide whether it is worth a `kind`.

### Bugs found and FIXED during M2b

1. **`max_frames` wire cap was 200**, so the 256-frame rung would have been rejected by
   pydantic before reaching the GPU — losing the OOM datapoint the ladder exists to collect.
   Raised to 512 (a sanity bound; the safety rail is `max_frames` itself).
2. **One base URL served two different services.** Setting `VITE_INFER_BASE` sent the local
   ffmpeg routes (`/probe`, `/upload`, `/extract`, `/frame`) to Cloud Run, where they 404.
   The first browser-to-cloud run would have died before inference. Split into `LOCAL_BASE`
   and `INFER_BASE` in `app/src/lib/infer-client.ts`.
3. **Artifact URLs were never rebased.** Manifest URLs are relative to the *service*; fetched
   as-is they resolved against the Vite origin. Every GLB and npz would have 404'd *after* the
   GPU was paid for. Added `artifactUrl()`, used by `point-cloud.ts`, `depth-2d.tsx`,
   `da3-depth.ts`. 7 tests.
4. **The server contract test had been silently skipping** for want of fastapi, so
   `verify.sh` was green while never exercising `server/`. It now runs (pass
   `VERGE_PY=<venv python>`) and caught bugs 1 and 5.
5. **`result.npz` name collision** — our npz is now `verge-result.npz` and any DA3-written npz
   gets `kind: "npz_native"`, so a client looking up `kind === "npz"` can never be handed the
   wrong file. A test proves `result.npz` sorts first and *would* have shadowed ours.
6. **Sweep merge erased its own data.** Re-running with the same `LABEL` replaced the whole
   sweep, so the 144f and 160f bisect rungs were overwritten by the next run. Now merges per
   `(frames, process_res)`. Those two rungs are restored in the JSON from console output and
   flagged `"recovered": true` with null `*_bytes` — the GiB figures are exact, byte-level
   precision was genuinely lost and is not back-computed.
7. **Local extraction froze the Mac** — see Gotcha 5. Fixed to one decode + hwaccel + strided
   subsets: 435 s → 13 s.

<details>
<summary>Original M2b plan (kept for context — all items resolved above)</summary>

- [x] **Add frame downscaling to `scripts/extract-frames.mjs` BEFORE deploying** (long edge
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

*(Confirmed: the 112-frame GLB is 16.1 MB and its npz 108 MB.)*

</details>

## M3 — Height measurement ⬜ (re-planned 2026-08-01)

M3 was originally "fit a plane, click a point, report a height". A literature/repo survey plus
direct measurement on the existing fixture changed the shape of it. **Read this whole section
before touching `geometry/`** — three of the decisions below overturn the obvious approach.

### The two regimes (this is why the donor code looked wrong-shaped)

There are **two different measurement problems**, sharing one foundation:

- **Instance regime** — "how tall is that door?" A discrete object, a mask, a height above the
  local floor, one number ± uncertainty. Doors, tables, monitors, signs, poles.
- **Field regime** — "how tall is the vegetation along this corridor?" There are no objects and
  nobody can interact per-blade-of-grass. The standard method is to grid the ground and report a
  height *distribution* per cell (H50/H90/H95), i.e. a raster, not a list.

The donor's `ground.js`/`height.js` (cells, segments, H50/H90/H95, per-cell validity) is the
**field regime**, correctly implemented. It is not aerial-specific and it is not wrong — it
answers a question M3 had not separated out. Both regimes share gravity, ground plane,
backprojection and uncertainty; they differ only in the final step.

### Decisions taken, with evidence — do not relitigate

1. **Selection happens in 2D, not 3D.** Clicking individual points in a rotating cloud is
   miserable UX and does not scale. DA3 gives per-frame depth + intrinsics + extrinsics, so a
   mask painted on a *frame image* backprojects to an exact 3D point set. The depth map is the
   bridge; selection is an image problem.
   - Consequence: mask-driven selection must read the **npz**, not the GLB. The GLB's 1,000,000
     points are a subsample with no pixel provenance, so a mask cannot be mapped onto them.
     Backprojection also gives full-resolution points for the object instead of a thinned sample.
   - Consequence: the **extracted frames are now a fixture artifact**. `save-run.sh` collects
     GLB + npz only; without the frames there is nothing to paint on. ~6 MB at 1024 px.
2. **Never use `max()` for the top of an object. Use a high percentile (P95–P99).** Two
   independent literatures agree: mask silhouettes produce "flying pixels" (mixed
   foreground/background depth) exactly at the top edge, and forestry canopy-height pipelines
   moved to per-cell P95 for the same outlier-fragility reason. Pipeline before the percentile:
   **erode the mask a few px → filter by DA3 confidence → statistical outlier removal**.
3. **Plain RANSAC does not find the floor — it finds walls.** Measured on
   `fixtures/room/504px-112f`: sequential RANSAC returns three tilted planes (17.1%, 20.8%,
   9.6% inliers) whose normals sit 60°/34° off vertical. There is no widely-adopted
   "ground-from-unstructured-SfM-cloud" library; everyone rolls RANSAC + an orientation prior +
   a lowest-plane heuristic. So: **gate candidates by orientation against a gravity estimate
   first, then break ties by lowest elevation, not by inlier count.**
4. **Gravity comes from the camera extrinsics.** No IMU exists in a video-only pipeline, but
   averaging the per-frame camera down-axis works: measured **0.925 coherence** across the 112
   frames of the existing fixture. Cross-check it against the fitted plane's own normal and
   report the disagreement rather than silently picking a winner.
5. **The plane fit must be deterministic.** Open3D's `segment_plane` has shipped genuinely
   non-deterministic results across versions. We write our own, so we do not inherit that bug —
   but this app **caches by content hash**, and a node returning a different plane for identical
   inputs would corrupt the cache model quietly. Explicit seed, plus a test asserting two runs
   on the same fixture agree.
6. **Scale is per-clip. `ScaleCheck` reports, it does not correct.** Metric scale from monocular
   models drifts with scene, depth range and camera parameters (the classical "scale drift"
   problem); a factor calibrated in one clip does not transfer to another. So DA3's metric output
   is the primary estimate and the known object is a **per-clip QA gate** ("does the door read
   2.10 m?"). Applying a correction stays opt-in and any corrected number is labelled.
   Calibrating *within* a clip is legitimate and is standard photogrammetry practice — that is
   what a scale bar in the scene is for.
7. **Uncertainty is not decoration.** Report height ± NMAD (MAD × 1.4826) of the sampled patch,
   plus a point-density gate that refuses to report at all below a minimum count. This follows
   the M3C2 convention (local roughness + point density + registration error → a stated
   confidence interval), which is the field standard for point-cloud measurement.
8. **DA3's confidence map is currently used for nothing.** It is in the npz and ignored
   downstream. The surfaces where DA3 is least confident — glossy screens, textureless walls,
   grazing-angle floors — are precisely our failure surfaces, and clip B has all three. Gate
   both the ground fit and the top-surface percentile on it.

### What "good" looks like — set expectations before measuring

DA3's own paper reports **AbsRel ≈ 0.104** for the metric variant on ETH3D. Naively that is
±21 cm on a 2.10 m door. Three reasons the measurement error should be smaller than the
per-pixel benchmark error, and one reason it might not be:

- A height is a **difference** (top − ground). Error common to both endpoints partially cancels;
  AbsRel counts the full absolute error including the part that cancels.
- AbsRel averages over *every* pixel including the worst; we use a confidence-filtered patch of
  thousands of selected points, and random error averages down ≈ √N.
- The two endpoints of a vegetation height are at nearly the same range from the camera, so the
  *relative* geometry is far better constrained than the absolute range is.
- **But**: whatever is left after averaging is systematic, and only calibration removes that.

So the real deliverable is not "the door measured 2.05 m" — it is the **error model**. Five
truths spanning 0.45 → 2.10 m in one clip is enough to fit `predicted = a·truth + b`:
`a` is scale bias (correctable), `b` is offset, e.g. a mis-placed ground plane (correctable),
and the residual scatter is the noise floor (not correctable — this is the number that decides
whether fine-grained vegetation work is viable). Table is in `MEASUREMENTS.md`.

---

### M3.0 — Door-clip fixture · ONE warm cloud session ✅

**One session, 2026-08-01.** Build 20 min (the M2b image was stale — see below), instance warm
~10 min for all three runs, **deleted at the end — 0 Cloud Run services remain.** Image kept.

- [x] Fixed rotation handling in `scripts/extract-frames.mjs` before deploying (see M3 bugs)
- [x] Extracted clip B in ONE decode, ladder-strided to 256 and 112, 1024 px long edge — 2.7 s
- [x] `verify.sh` green (176 tests) before spending anything
- [x] Deployed. ⚠️ It **rebuilt**: the M2b image predates commit `2020ec9`, so the source hash
      no longer matched. The skip branch remains unverified.
- [x] Three runs back to back on the one warm instance
- [x] `save-run.sh` all three, sha256-verified. Frames kept at `fixtures/door/frames/`
- [x] `teardown.sh` — service deleted, image kept

### The door fixture — LOCAL ONLY, not in git

`fixtures/door/`, 342 MB of payloads plus 11 MB of source frames, gitignored except
`manifest.json` and `SHA256SUMS`. All three parse with `depth`, `confidence`, `extrinsics`,
`intrinsics`.

| Directory | Frames | process_res | Depth output | VRAM (driver / allocator) | GPU |
|---|---|---|---|---|---|
| `356px-256f` | 256 @ 7.19 fps | 356 | — | 21.33 / 17.51 GiB | 40.8 s |
| `504px-112f` | 112 @ 3.15 fps | 504 | — | 21.20 / 17.23 GiB | 31.3 s |
| `252px-256f` | 256 @ 7.19 fps | 252 | — | 16.37 / 12.69 GiB | 16.5 s |

**VRAM depends on frame count and resolution, not clip length.** The 356/256 and 504/112 rungs
reproduced M2b's allocator peaks (17.51 and 17.23 GiB) to the megabyte on a 34% longer clip.
That was an assumption; it is now measured.

### First geometry results on clip B (offline, no cloud)

Run with `estimateGravity` → `fitGroundPlane`, `inlierDistance` 0.03, stride 4:

| Fixture | Gravity coherence | Camera span (m) | Floor tilt vs gravity | Below floor | Plane RMSE | p99.9 above floor |
|---|---|---|---|---|---|---|
| `356px-256f` | 0.948 | 2.22 × 0.44 × 1.77 | 22.4° | 7.2% | 0.017 m | **2.36 m** |
| `504px-112f` | 0.949 | 2.36 × 0.46 × 1.89 | 18.4° | 4.6% | 0.017 m | **2.06 m** |
| `252px-256f` | 0.953 | 2.15 × 0.43 × 1.73 | 27.6° | 10.0% | 0.017 m | **2.05 m** |

Three things worth knowing, none of them yet a measurement of an object:

1. **The scale looks plausible.** The reconstruction spans 2.0–2.4 m above the fitted floor,
   which is a real room. Clip A spanned only 1.9 m in total and raised a scale worry; clip B
   does not reproduce it. Nothing is graded until masks exist, but the gross sanity check passes.
2. **The camera-derived up is 18–28° off the fitted floor normal.** Coherence ~0.95 says the
   frames AGREE, not that they are right — the phone was held tilted the whole way, exactly the
   documented failure of this prior. The floor's own normal is the better up axis. **The 252 px
   run at 27.6° nearly hit the 30° gate**, so a follow-up should re-derive up from the fitted
   plane and re-fit rather than widening the gate further.
3. **Plane RMSE is 17 mm on all three.** That is the floor's own roughness, and it propagates
   into every height's error bar — a ±17 mm floor on a 2.10 m door is 0.8%.

### M3a — Geometry core (offline, no UI) ✅

Pure functions in `geometry/`, plain arrays in and numbers out, no Three.js. **84 tests**, run
by the app's vitest (its glob includes `../geometry`) and typechecked by the app's tsc.

- [x] `gravity.ts` — up axis + coherence, camera centres, trajectory span (parallax check)
- [x] `plane.ts` — deterministic gravity-gated RANSAC, confidence-weighted, lowest-elevation
      selection, height-field least-squares refinement, `fitPlaneFromSeeds()` fallback
- [x] `backproject.ts` — mask → world points, with erosion, confidence threshold and
      depth-discontinuity rejection
- [x] `measure.ts` — percentile height, NMAD uncertainty, density gate, point-to-point distance
- [x] `calibrate.ts` — the error model (`slope`, `intercept`, residual RMS, scale factor)
- [x] Synthetic tests: adversarial room (walls denser than the floor, horizontal ceiling),
      rotated world frame, noise, flying pixels, determinism, honest failures
- [x] **`fixture.test.ts` — the same code against real DA3 output**, skipped when the
      gitignored payloads are absent

**The selection rule changed twice under measurement, and both dead ends are worth knowing:**

- Ranking horizontal candidates by *support* puts the plane mid-scene (46% of the cloud below
  it) because a walkthrough's floor is one of the SPARSEST surfaces, not the densest.
- Ranking by *footprint density* is worse and backwards: the real floor fills only 9.6% of its
  own bounding box, while the wrong mid-scene plane fills 26%. It penalises exactly the surface
  we want. This idea looked principled and cost a rewrite; do not re-derive it.
- What works is the definition of ground itself: **the surface with (almost) nothing beneath
  it.** Floor 4.3% below vs mid-scene 60.6% — clean separation, one cheap pass.

### M3b — Mask → measurement → grading ✅

- [x] **Re-derive `up` from the fitted floor and re-fit.** Measured on clip B: the
      camera-derived up is 18–28° off the floor's own normal, and the 252 px run came within
      2.4° of the 30° orientation gate. The prior only needs to get the fit into the right
      neighbourhood; the floor then defines up far better than the cameras do. Widening the
      gate instead would let genuinely tilted surfaces in — do the two-pass fit.
- [x] Brush on the frame pane: RGB/depth/confidence outputs, frame scrubber, brush/erase/size,
      clear, mask opacity, zoom and confidence-percentile control. Masks persist as RLE.
- [x] **Live 3D highlight of the selected points while painting**, so mask spill onto the wall
      behind the object is visible immediately instead of silently inflating the height
- [x] **NPZ ↔ GLB registration fixed.** DA3's exported GLB applies `hf_alignment`; selected
      pixels and camera-derived up now receive the same transform before 3D display, floor fit
      or measurement. This removed the detached pink cloud reported in review.
- [x] `GroundPlane` / `BrushSelection` / `MeasureHeight` / `ScaleCheck` nodes (all CPU, all
      `auto` — they can never bill), with typed plane/selection/measurement wires documented
      in `docs/DESIGN.md`.
- [x] Objects pane: one row per object — current-run raw height, truth/error, internal spread,
      selected-point count, resolution verdict and current-run error model. Rows never average
      incompatible reconstruction settings; each is audited beside its registered RGB/depth
      crop and live 3D highlight.
- [x] Frame identity is explicit: canonical source frame and matching NPZ index are shown and
      recorded. `Run Source` selects recorded evidence or the latest manually-run live DA3
      output, so the paid node is connected without auto-running or being mistaken for evidence.
- [x] **Recompute from source** invalidates ground/selection and every descendant, then actually
      reruns them. The old button reused cached results and only looked active.
- [x] B2/B5 use explicit endpoint evidence (floor patch ↔ top edge). The fitted plane supplies
      the vertical direction, but its offset cannot silently decide these two heights.
- [x] Range-aware NPZ loading (24 MiB chunks) and canonical-frame mapping for both fixture and
      future real-run manifests.
- [x] **Objects are rows in a pane, never nodes in the graph** — the graph is the pipeline, and
      hundreds of vegetation cells would turn the canvas into confetti.
- [x] Fill `MEASUREMENTS.md` for every observable clip-B endpoint, per setting. B4 is explicitly
      unavailable because the laptop hides the stand/table contact; fabricating it was rejected.
- [x] Fit the error model (`a`, `b`, residual RMS) per run and record the
      resolution-vs-frames verdict.

**Measured verdict (raw holdout MAE / door-scaled diagnostic):**

| Setting | Raw | Door-scaled | Decision |
|---|---:|---:|---|
| **504px · 112f** | **0.113 m** | 0.314 m | **raw default; fastest non-degraded result** |
| 356px · 256f | 0.182 m | **0.051 m** | best calibrated candidate; validate on another clip |
| 252px · 256f | 0.257 m | 0.141 m | spatial detail loss is too large |

The door is measured as the user defined it: physical leaf bottom edge → top edge, an extent.
The door-derived factor is secondary and, when shown, consistently multiplies every length.
Raw DA3 remains the primary evidence. See `MEASUREMENTS.md` for the object-level table, internal
spreads and current-run regressions.

**What to understand:** the 504px run is best without calibration; the 356px run becomes best
after the door factor. Because that same correction harms 504px, there is no evidence yet for a
universal one-factor correction. The 356px fit's 0.030 m residual is promising but is not a noise
floor: it comes from only four painted values and B5 has a derived truth.

Final local gate: production build green; `verify.sh` green with **202 unit/fixture tests** plus
the fixture smoke. The optional server-contract check reported its explicit no-FastAPI skip in
this shell; no server code changed in M3b. No cloud resource was created or billed.

### M3c — Automatic segmentation (mask source swap only)

Nothing downstream changes: a brush mask and a model mask are the same bytes. **No cloud cost —
this runs in the browser.**

- [ ] MobileSAM or EfficientSAM (both Apache-2.0, ~10 MB ONNX) via ONNX Runtime Web /
      transformers.js: encode the frame once, decode a mask per click (~200 ms)
- [ ] SAM 2 (Apache-2.0) mask propagation across frames — **but** its memory bank is documented
      as uncorrectable once wrong: one bad mask poisons everything after it and quality degrades
      with depth into the clip. Verify per clip; `SAM2Long`-style hypothesis search is the known
      fix if drift shows up.
- [ ] Licence trap to avoid: Ultralytics YOLO is AGPL-3.0 and YOLO-World is GPL-3.0. Grounded
      SAM (Grounding DINO + SAM) is Apache-2.0 throughout and gives the same open-vocabulary
      capability. Mask2Former's *weights* are CC-BY-NC-4.0 — same licence as DA3, no new
      constraint.

### M3d — Field/raster regime (deferred, for the roadside case)

- [ ] Ground raster → per-cell height percentiles above the local ground, point-count QA gate
- [ ] Output is a heat map, not a list; the donor's cell/segment code is the template
- [ ] Do **not** try to instance-segment vegetation; reserve segmentation for large discrete
      plants where identity actually matters

### Bugs found during M3

1. ⚠️ **`extract-frames.mjs` squashed rotated video.** `probeVideo` reads
   `stream=width,height`, which is the **stored** size — 1920×1080 for clip B. ffmpeg
   autorotates on decode (`rotation=-90`) and hands the filter chain 1080×1920, but `planScale`
   had already computed `scale=1024:576` from the stored landscape dimensions, stretching a
   portrait frame into landscape. Every frame would have reached the GPU with a wrong aspect
   ratio, and the resulting intrinsics/geometry would have been silently wrong. Found by
   `ffprobe`-ing the clip *before* deploying, which is exactly what the local-prerequisites rule
   is for. Fix: parse `side_data` rotation and swap the planning dimensions when |rotation| is
   90 or 270.

## M4 — Splats + polish ⬜

- [ ] `infer_gs=True` path proven on GPU → `gs_ply` (+ optional `gs_video`)
- [ ] Splat viewer node via `@mkkellogg/gaussian-splats-3d`
- [ ] Per-node cost accounting

---

## Resuming work

```bash
cd app && npm install && npm run dev     # localhost:5173, fully offline (mock + real ffmpeg)
./scripts/verify.sh                      # typecheck, units, fixture smoke, optional server contract
```

⚠️ **`verify.sh` silently skips the server-contract test unless a Python with `fastapi` is on
`PATH`.** It skipped for the whole of M0–M2a, so `server/` was never exercised by the green
checkmark. Always run it with a venv:

```bash
python3 -m venv /tmp/verge-venv && /tmp/verge-venv/bin/pip install fastapi pydantic \
  python-multipart httpx numpy
VERGE_PY=/tmp/verge-venv/bin/python ./scripts/verify.sh    # full suite + server contract
```

The service is **deleted** (0 Cloud Run services). The **image is kept** (9.8 GB, ~$1/month),
so the next deploy should **skip the build and start in ~1 min**.

```bash
./scripts/deploy.sh                  # builds only if server/ changed since the stored image
./scripts/teardown.sh                # deletes the service, KEEPS the image
PURGE_IMAGE=1 ./scripts/teardown.sh  # ...and deletes the image, when the project is done
FORCE_BUILD=1 ./scripts/deploy.sh    # rebuild even when the source hash matches
```

⚠️ **The build-skip branch has still never executed, and the M2b image is already stale.**
Checked 2026-08-01 before the M3 deploy: the registry holds `src-d8977556a0573326`, but a clean
tree now hashes to `src-3038078518c96bb0`. `server/` was edited *after* that image was built —
commit `2020ec9` set the frame cap to 112 in `server/contract.py`. So the M2b claim that "the
next deploy should skip the build and start in ~1 min" was **wrong**, and M3.0 paid a full
rebuild.

The hashing logic itself is behaving correctly (different source → different tag → rebuild);
what was wrong was the assumption that the tree had not changed. **Before predicting a fast
deploy, actually compare the tags:**

```bash
find server -type f -not -path '*/__pycache__/*' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16
```

Compare that against `gcloud artifacts docker tags list us-central1-docker.pkg.dev/verge-lab/verge/da3-service`.
The skip branch is *still* unverified — the next deploy after M3.0, on an unmodified tree, is
the real test.

## Measured facts (do not re-derive)

- L4 usable VRAM: **22.03 GiB** (23,659,151,360 B) — not 24 GiB.
- Model resident after load: 6.57 GiB. Cold start **64 s**, model load **40.5 s**.
- Upstream defaults: HF Space samples video at **10 fps with no frame cap**; `process_res=504`;
  use `ref_view_strategy="middle"` for ordered video.
- Full 12 GB image build: **19 min 30 s**. Artifact Registry holds 9.8 GB.

### The frame ladder (2026-08-01, per-run isolated — supersedes the 2026-07-31 numbers)

| Frames | 504 px driver / allocator | 356 px | 252 px |
|---|---|---|---|
| 32 | 14.24 / 11.63 GiB · 12.2 s | | |
| 64 | 16.94 / 13.87 GiB · 15.2 s | | |
| 112 | 21.28 / 17.23 GiB · 30.2 s ← **the cap** | | |
| 128 | 21.94 / 18.35 GiB · 37.7 s | | |
| 144 | 21.88 / 19.47 GiB · 42.1 s ← **last good** | | |
| 160 | **OOM** ← ceiling is in (144, 160) | | |
| 192 | **OOM** | 19.39 / 15.01 GiB · 24.6 s | |
| 256 | **OOM** | 21.54 / 17.51 GiB · 35.2 s | 15.89 / 12.69 GiB · 16.1 s |

- **Allocator peak fits `0.0700 GiB/frame + 9.39 GiB`** across 32/64/128/144. That slope is
  **half** what the old contaminated readings implied (0.14), which is why the true ceiling
  landed at ~144 rather than the extrapolated ~110. Use the allocator number for modelling;
  the driver number saturates near the device limit because it includes CUDA context and
  allocator reserve.
- **`max_frames` is 112, not 144, on purpose.** Both 128 and 144 completed at ~99% of the
  device — that is a coin flip, not an operating point. 112 leaves ~15% headroom and its
  predicted peak matched the measurement to within 0.25 GiB.
- **10 fps sampling IS reachable** — just not at 504 px. 256 frames (9.62 fps on this clip)
  runs at 356 px, and comfortably at 252 px. Whether the accuracy trade is worth it is M3's
  call, and all three fixtures are already local so it costs no cloud time.
- **DA3 writes NO npz of its own.** Export dir after a `npz-glb` run contained only
  `scene.glb`, `scene.jpg` and our `verge-result.npz`; `diagnostics.native_npz` was `{}`.
  The feared `result.npz` clobber **never actually happened** — the rename is defensive, and
  this is now measured rather than assumed.
- Our npz is large: **108 MB at 112f/504 px**, 114 MB at 256f/356 px. The GLB is ~16 MB.

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
