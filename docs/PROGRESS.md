# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-08-01 · M2b complete (one warm cloud session, torn down)

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2a — Node graph, local only | **done** (one carve-out: mock badge) |
| M2b — One warm cloud session | **done** (fixture home, service deleted) |
| M3 — Height measurement (the goal) | not started — **unblocked**, fixture is local |
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

- [x] ~~Isolate per-run VRAM peaks~~ — fixed in M2b, see `server/vram.py`.
- [x] ~~`result.npz` may clobber DA3's native npz~~ — measured in M2b: DA3 writes no npz at
      all, so there was nothing to clobber. Ours renamed to `verge-result.npz` defensively.
- [ ] **`infer_gs` is broken: `gsplat` is missing from the image.** One real run returned
      `name 'rasterization' is not defined`. Add `gsplat` to the pip install in
      `server/Dockerfile` (line 17) — costs a ~20 min rebuild, so bundle it with other server
      changes. Until then treat splats as unavailable, not merely untested. Blocks M4.
- [ ] **Cloud Run's 32 MiB response cap makes `/artifact` unusable for the npz.** A 108 MB
      npz returns **HTTP 500 with zero bytes**, direct and through the proxy alike; the 16 MB
      GLB is fine. `save-run.sh` works around it with 24 MiB Range chunks, but **the browser
      still cannot load the npz** — the Depth 2D pane showed "Failed to fetch" on the real
      cloud run while the 3D viewport (GLB) rendered fine. Real fixes, in preference order:
      (a) the GCS + signed-URL path that was always the plan, which sidesteps the cap entirely;
      (b) a `mini_npz` export or float16/subsampled depth, which would also cut 108 MB to
      something sane; (c) range-aware chunked fetching in `depth-2d.tsx`.
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

## M3 — Height measurement ⬜

**Unblocked.** Runs fully offline against `fixtures/room/` — three settings, already local.
Read the npz **from disk**, not over HTTP (see the 32 MiB cap follow-up above).

- [x] `MEASUREMENTS.md` seeded with the user's tape-measure truths (table 0.750 m, monitor
      0.534 m, derived composite 1.284 m). **Two caveats recorded there, both need the user:**
      (a) "table 75 cm" is *assumed* to be height — if it is width or depth, object 3 and the
      scale factor are both wrong; (b) no door was available, so the largest reference is
      0.750 m rather than ~2.03 m, making the calibration baseline proportionally noisier.
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

⚠️ **`verify.sh` silently skips the server-contract test unless a Python with `fastapi` is on
`PATH`.** It skipped for the whole of M0–M2a, so `server/` was never exercised by the green
checkmark. Always run it with a venv:

```bash
python3 -m venv /tmp/verge-venv && /tmp/verge-venv/bin/pip install fastapi pydantic \
  python-multipart httpx numpy
VERGE_PY=/tmp/verge-venv/bin/python ./scripts/verify.sh    # 97 tests + server contract
```

The service is **deleted** (0 Cloud Run services). The **image is kept** (9.8 GB, ~$1/month),
so the next deploy should **skip the build and start in ~1 min**.

```bash
./scripts/deploy.sh                  # builds only if server/ changed since the stored image
./scripts/teardown.sh                # deletes the service, KEEPS the image
PURGE_IMAGE=1 ./scripts/teardown.sh  # ...and deletes the image, when the project is done
FORCE_BUILD=1 ./scripts/deploy.sh    # rebuild even when the source hash matches
```

⚠️ **The build-skip logic is STILL UNVERIFIED.** M2b deployed exactly once, so only the
"no image for this source, building" branch ran (correctly — it created the registry, tagged
`src-d8977556a0573326`, built in 19m30s, deployed by digest). **The skip branch has never
executed.** The next deploy is the test: with `server/` unchanged it must print
*"image for this exact server/ source already in the registry, skipping build"* and start in
~1 min. If it rebuilds instead, that is a bug worth fixing before it costs 20 more minutes.
Note that any edit to `server/` changes the hash and *correctly* forces a rebuild — so test
the skip on an unmodified tree.

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
