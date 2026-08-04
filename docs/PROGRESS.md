# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-08-04 (second session) · **Backlog audit + honesty fixes.** Every unchecked
box in this file was graded against the code. Three were already done and never ticked, one
whole block was decorative history, and the rest are now either fixed, verified, or written
down below as a real task. The headline code change: the app no longer displays patch roughness
as if it were the measurement uncertainty — bias and random error are now reported separately.

Earlier that day · P0 done: the repeatability store shipped and nine trials were painted
and analysed. **The result overturned its own premise** — operator endpoint placement repeats to
1–6 mm within a sitting, so it is not the missing noise term; the residual error is systematic
bias, and DA3's raw scale on clip B is ~3% low rather than the ~11% the frozen n=1 door row
implied. 504px/112f remains the operating point. B4 remains ungraded (occluded endpoint).

### Two standing constraints — read before touching anything

1. **`server/` is frozen unless you intend to pay for a rebuild.** The deployed image is correct
   as it stands. `deploy.sh` tags by a hash of `server/`, so *any* edit under it — even a
   comment — forces a ~20 min rebuild on the next deploy. Two known one-line improvements
   (`scene.jpg` collection, removing the dead `infer_gs` field) are deliberately NOT applied for
   this reason. Batch them with the next real server change.
2. **Gaussian splats are not a deliverable and never will be.** The one historical `infer_gs`
   failure was a missing `gsplat` dependency; it does not matter, because no measurement node
   consumes splats. Do not add the dependency, do not schedule a run, do not rebuild the image
   for it. The app-side checkbox, contract field and port type were removed on 2026-08-04.

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2a — Node graph, local only | **done** |
| M2b — One warm cloud session | **done** (fixture home, service deleted) |
| M3.0 — Door-clip fixture (one warm session) | **done** (3 fixtures local, service deleted) |
| M3a — Geometry core (offline) | **done** (89 geometry/fixture tests) |
| M3b — Mask → measurement → grading | **done on clip B** |
| P0 — Repeatability study | **done**; spread 1–6 mm, premise refuted, see findings below |
| P0.1 — Honesty fixes + backlog audit | **done 2026-08-04**; uncertainty split, sittings, blind mode |
| M3c — Automatic evidence selection on the door | **next** — judged on ease of use, not precision |
| M3d — Field/raster regime (vegetation) | planned after M3c proves out on the door |
| P1 — Floor challenge set | **queued after M3 completes** — see its own section below |
| M4 — Productization + evidence hardening | not started; splats dropped from roadmap |

---

## Current assessment and recommended next sequence — 2026-08-03

### What we now have working

- A real DA3 video fixture flows through 2D evidence, frame-specific depth/camera pose,
  registered 3D points, floor direction, robust endpoint measurement and tape-truth grading.
- Sparse evidence works better than expected. For an extent, compact lower and upper endpoint
  patches can be enough; the 3D line is the measured ruler between robust endpoint height bands,
  not a hallucinated filled object.
- The corrected floor is supported by visible scene points and carries support, tilt and RMSE
  diagnostics. The previous diagonal-floor regression is covered by real-fixture tests.
- On the 504px run, the frozen table and PC tower are 0.046 m and 0.043 m from truth. The user's
  refined door mask returned about 2.0 m, roughly 0.10 m from its 2.10 m truth. This is a strong
  proof of usefulness on this clip, not yet a universal accuracy claim.

The largest newly exposed uncertainty is **operator endpoint placement**. The old 1.887 m door
and the refined ~2.0 m door came from the same reconstruction and floor. Their difference is
measurement evidence, not noise to hide: automatic selection is valuable if it makes endpoints
more repeatable, even before it produces a beautiful full-object mask.

### Recommended sequence

**Re-ordered 2026-08-04 (user decision):** M3c comes next and must prove itself **on the door**
before any grass work. The floor challenge set (P1) is queued for after M3 completes, not before.

1. ~~**P0 — Freeze repeatability before adding another model.**~~ **Done 2026-08-04**: the store
   ships, nine trials are painted and analysed, and the premise was refuted. The remaining
   painting work (B5, the 356/252px doors, separated sittings) is listed under "P0 follow-ups".
2. **M3c — automatic evidence selection, on clip B's door first.** One canonical frame,
   click-prompted endpoint/object selection, brush correction retained. Grade by measurement
   difference from the frozen manual trials, failure/abstention rate, correction clicks and
   operator time — not mask IoU. Multi-frame propagation only if one frame cannot supply
   reliable endpoints. **Its precision case is gone** (see the P0 findings): at 1–6 mm spread and
   a 5–10 s median paint there is no headroom, so it must win on ease of use and on scenes where
   a brush is impractical.
3. **M3d — transfer the proven geometry to grass**, once the door proves out. Grass is not a
   door repeated many times: use a local ground raster and per-cell vegetation height
   percentiles, with point-count and confidence gates. Track tape/reference error, valid-area
   coverage, abstention rate, cell size and sensitivity to ground slope. Use semantic vegetation
   masking to exclude non-vegetation; do not require instance segmentation of individual blades.
4. **P1 — Challenge the floor on new captures.** Queued for after M3 completes. Full task
   definition in its own section below.
5. **M4 — Productize the evidence path.** Compact `mini_npz` or transient object storage with
   signed URLs, verify a live cloud manifest in the browser, make recorded evidence
   reproducible, and implement honest per-session cost reporting.

### Floor generalization risk

Yes, a wrong floor can return on another video or camera configuration. The current fix removes
the specific self-referential failure and makes weak floors easier to see; it does not prove that
every scene contains one recoverable global plane. Sparse/occluded floors, dominant tabletops,
stairs, sloped terrain, poor depth and an inaccurate camera-up prior can still produce the wrong
candidate. The present 1% support threshold is a last-resort rejection gate, not a certificate.
The next gain is therefore an ambiguity/rejection policy and cross-video challenge set, not more
fine-tuning on this one room. Outdoor grass will need local ground, not this single-plane model.

### Gaussian splat decision

**Drop Gaussian splats from the product roadmap.** They improve appearance and novel-view
rendering, but no measurement node consumes them: the metric depth, camera poses and point cloud
already provide the geometry this product needs. Repairing `gsplat` would require a larger CUDA
build path, extra GPU work, another viewer and more output formats without improving the current
measurement evidence. Keep DA3's upstream capability out of scope and later remove our checkbox,
contract branches and unused splat port/type as cleanup. Do not spend another cloud session
proving `infer_gs`.

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

Superseding decision, 2026-08-03: Gaussian splats are no longer a deliverable. Historical M1/M2
notes below preserve what was attempted, but `infer_gs` should not be repaired or scheduled.

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
- [x] ~~**`infer_gs` / Gaussian splats never exercised on GPU.**~~ **Closed by scope decision**,
      2026-08-03, and the app-side plumbing was removed 2026-08-04. It was never exercised and
      never will be. `server/contract.py` still declares the field with a `False` default; that
      is deliberate, see the standing constraints at the top of this file.
- [ ] **The app has never consumed a real cloud manifest.** The viewport still loads the fixture.
      The multipart upload path in `app/src/lib/infer-client.ts::infer()` has NOT been run against
      the deployed service — the sweep used `curl` from a shell script instead. That seam is
      unverified; expect bugs the first time the browser talks to a real service.

## Open follow-ups (bugs/limitations found, not yet fixed)

- [x] ~~Isolate per-run VRAM peaks~~ — fixed in M2b, see `server/vram.py`.
- [x] ~~`result.npz` may clobber DA3's native npz~~ — measured in M2b: DA3 writes no npz at
      all, so there was nothing to clobber. Ours renamed to `verge-result.npz` defensively.
- [x] ~~Repair `infer_gs` / add `gsplat`.~~ Closed by scope decision on 2026-08-03. Splats do
      not feed measurement, while repairing them requires a larger CUDA build and more GPU work.
      Removing the dormant checkbox/contract/output branches is cleanup under the reframed M4.
- [ ] **Cloud Run's 32 MiB response cap makes a one-shot `/artifact` fetch unusable for the npz.** A 108 MB
      npz returns **HTTP 500 with zero bytes**, direct and through the proxy alike; the 16 MB
      GLB is fine. M3b added the same 24 MiB range-aware retrieval to the browser and it is
      covered by unit tests, but that path has not been exercised against a live Cloud Run
      instance since implementation. Durable fixes, in preference order:
      (a) the GCS + signed-URL path that was always the plan, which sidesteps the cap entirely;
      (b) a `mini_npz` export or float16/subsampled depth, which would also cut 108 MB to
      something sane. Treat live-cloud browser verification as the remaining part of this item.
      **This is the main reason M3 should read the fixture from disk, not over HTTP.**
- [ ] **`scene.jpg` is produced but never collected** — no `.jpg` in `_collect_artifacts`
      (`server/main.py:206`). Verified safe to add on 2026-08-04: `export_dir` and `frame_dir`
      are separate, so a `.jpg` entry cannot sweep up the 112 input frames. **Deliberately not
      applied** — it is a one-line change to a frozen directory; batch it with the next real
      server change. Decide then whether it deserves a `kind` at all.
- [x] ~~**`predictVram` interpolation table stops at 128.**~~ **Fixed 2026-08-04.** 144 is in
      the table, derived from the recovered 21.88 GiB (its byte value was genuinely lost to the
      sweep-merge bug and is not back-computed). Note what the fix exposed: the 144 driver peak
      is *lower* than 128's 21.94 GiB, because the driver figure saturates against the 22.03 GiB
      device limit — it is a plateau with scatter, not a curve. The table is therefore forced
      non-decreasing, with the allocator series named in-code as the real model.

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
- [x] **Mock-vs-real badge on `DA3Depth`.** Closed in M2b and re-verified 2026-08-04:
      `app/src/graph/nodes/da3-depth.ts` appends `· MOCK` to the card summary. This box sat
      unticked here for three days after the work was done — the audit found it, not a rerun.

Deliberately excluded from M2a: any real cloud run, the splat node, the cost ticker.

### Verified behaviours (driven in-browser, 2026-08-01)

- Dropping a clip runs **only** Frame Source; DA3 Depth and everything downstream stay stale.
  A slider drag cannot bill. This is the central safety property of the execution model.
- An explicit Run walks the whole chain and leaves the graph reading `all current`.
- Changing a downstream CPU param does not restamp DA3 Depth (unit-tested on the real pipeline).

### NOT verified in M2a — **worked through on 2026-08-04**

- [x] ~~Orbit/pan was not re-measured.~~ **Verified.** The `readPixels` checksum genuinely cannot
  run (rAF is paused while the browser pane is hidden, which is exactly when the JS tool runs),
  but tool *screenshots* do capture the WebGL surface: a drag inside the canvas visibly rotated
  the room and the gizmo turned with it. The technique, not the code, was the blocker.
- [x] ~~Node deletion never exercised.~~ **Verified**: selecting a node and pressing Backspace
  took the graph 10 → 9 nodes and removed its wire with it.
- [ ] **Edge deletion is broken, not merely unverified** — see bug 1 in "Bugs found during the
  2026-08-04 audit". Edges can never be selected, so Backspace has nothing to act on.
- [ ] **Rewiring by drag is still unverified** — see bug 2. Automated drags cannot reliably hit
  an 8 px handle; this one needs a human.
- [ ] `PaneControls` supports a `Remove` button that is not wired (Dockview owns pane lifecycle).
- [x] ~~Pausing a pane does not stop the 3D render loop.~~ **Fixed** — see bug 3.
- [x] ~~The `docs/DESIGN.md` checklist has not been re-graded.~~ **Re-graded 2026-08-04**, full
  pass recorded in `docs/design-review-log.md`. Items 1–10 and 14 pass; 11 is partial and 12–13
  need a loaded clip, all noted there rather than claimed.

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

- [x] ~~Repair `infer_gs`.~~ One historical 32-frame run failed because `gsplat` was absent.
      Closed by the 2026-08-03 scope decision: splats do not feed measurement, so the project
      will remove the dormant path instead of paying for a larger CUDA build and viewer.
- [x] ~~**Session cost ticker shows `$0.00`.**~~ **Made honest 2026-08-04.** It was defensible
      while no cloud session had run; after three warm sessions it was a fabricated number on
      screen. It now reads `cloud: none` / `cloud: fixture` / `cloud: 1 run · billing not
      instrumented` from the manifest. Real per-session accounting is still unbuilt — see M4.
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
<summary>Original M2b plan — historical note, NOT a checklist</summary>

**Do not read the list that used to live here as outstanding work.** It held eight `[ ]` boxes
inside a section whose own header said everything was resolved, and the 2026-08-04 audit found
it was the single largest source of phantom backlog in this file. Every item was delivered and
is recorded above with its measurement; the two that were not (`infer_gs`, the cost ticker) are
tracked in their own right — `infer_gs` is closed by scope decision, the cost ticker by M4.

What the plan got wrong, worth keeping: it predicted the frame ceiling at ~110 from the
contaminated 0.14 GiB/frame slope. The real slope is 0.0700 and the ceiling landed in (144, 160).
It also assumed the GLB would be the large artifact; the npz is 108 MB and the GLB only 16 MB,
which is what made Cloud Run's 32 MiB response cap a problem at all.

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
   frames AGREE, not that they are right. This initially suggested re-deriving up from the first
   floor and fitting again. M3b visual review disproved that strategy: a first fit must not be
   allowed to become its own reference. Competing independently scored hypotheses are safer.
3. **Plane RMSE was 17 mm on all three initial fits.** M3b showed why RMSE cannot stand alone:
   a thin, tilted slice can also have a small residual. Support, tilt and below-floor mass must
   travel with RMSE as floor evidence.

### M3a — Geometry core (offline, no UI) ✅

Pure functions in `geometry/`, plain arrays in and numbers out, no Three.js. **84 tests**, run
by the app's vitest (its glob includes `../geometry`) and typechecked by the app's tsc.

- [x] `gravity.ts` — up axis + coherence, camera centres, trajectory span (parallax check)
- [x] `plane.ts` — deterministic gravity-gated RANSAC, confidence-weighted competing whole-cloud
      and lower-region proposals, support/tilt/below-mass quality scoring, height-field
      least-squares refinement, `fitPlaneFromSeeds()` fallback
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

- [x] **Retire the self-referential two-pass floor fit.** User review exposed that the
      lower-slice → re-fit → low-quantile-anchor chain could manufacture a precise-looking but
      strongly tilted floor. On 504px it had only 0.7% support and 27.9° tilt despite a 2 cm
      RMSE. The replacement compares whole-cloud and lower-region hypotheses, and scores
      support, tilt, below-floor mass and RMSE together. The selected 504px floor has 14.6%
      support, 11.8° tilt and 1.2 cm RMSE.
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
- [x] B2/B5 are explicitly labelled floor-to-top endpoint measurements; B1/B3 are object
      extents. The floor fit supplies direction, while the painted lower endpoint supplies the
      origin. The 3D ruler follows endpoint bands instead of projecting to an invented point.
- [x] **Honest floor display.** Yellow markers show the points that actually support the fit,
      and the translucent plane is clipped to their observed footprint and centred on them.
      The former large origin-centred square amplified even modest tilt into a false-looking
      ground projection.
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
| **504px · 112f** | **0.061 m** | **0.026 m** | **default; best raw and corrected result** |
| 356px · 256f | 0.193 m | 0.029 m | close after calibration, but slower and weaker raw |
| 252px · 256f | 0.227 m | 0.187 m | spatial detail loss is too large |

The door is measured as the user defined it: physical leaf bottom edge → top edge, an extent.
The door-derived factor is secondary and, when shown, consistently multiplies every length.
Raw DA3 remains the primary evidence. See `MEASUREMENTS.md` for the object-level table, internal
spreads and current-run regressions.

**What to understand:** the 504px run is best with or without the door correction. The floor fix
cut its raw holdout MAE from 0.113 m to 0.061 m and moved the door from 1.522 m to 1.887 m without
changing its painted mask. This is strong evidence that floor validation was the dominant M3b
bug, not 2D→3D registration. The 356px fit's 0.004 m residual is still not a noise floor: it comes
from only four painted values and B5 has a derived truth.

The user's later endpoint refinement moved the same 504px door result to approximately 2.0 m.
That does not invalidate the geometry result; it reveals that endpoint placement is now a large
part of the error budget. The exact value and mask must be exported before the frozen table and
door-derived correction are recalculated.

**What “Recompute from source” actually does:** it does not rerun DA3, reload the video or bill
the GPU. It discards cached results beginning at `GroundPlane` and `BrushSelection`, then reruns
the local CPU measurement branch: floor, current mask→3D points, extent, scale check and 3D
overlay. Painting, changing object or changing source already invalidates the necessary nodes
automatically, so unchanged input should produce the same deterministic result. Keep this only
as a recovery/debug action; rename it to **Rebuild measurement** with “local only—DA3 is not
run”, or remove it from the normal evidence workflow.

Final local gate: production build green; `verify.sh` green with **207 unit/fixture tests** plus
the fixture smoke. The optional server-contract check reported its explicit no-FastAPI skip in
this shell; no server code changed in M3b. No cloud resource was created or billed.

### P0 — Repeatability ✅ store built and study run, 2026-08-04

Raw evidence committed at `docs/measurement-trials-2026-08-04.json` (140 KB, nine trials with
their masks). It is the reproducibility anchor: any future claim about these numbers can be
checked against the exact masks that produced them.

The blocker in front of M3c was that the app **could not hold a repeat measurement**.
`addObservation` filtered out any prior row for the same (object, setting, frame) before
appending, so pressing Record a second time silently destroyed the first result — which is why
every row in `MEASUREMENTS.md` is n=1 and why the 1.887 m → ~2.0 m door change was never
captured as data.

- [x] **Trials accumulate.** `trialIndex` within (object, setting); recording never replaces.
      `removeObservation()` drops one bad row without clearing the study.
- [x] **Each trial freezes its own mask** — RLE, painted-pixel count and a 16-hex digest, copied
      at Record time so later strokes cannot rewrite recorded evidence. This is also the "tie
      every result to reproducible mask evidence" item from M4.
- [x] **Duplicate-mask guard.** Recording twice without repainting gives zero spread and looks
      like perfect repeatability. Trials sharing an earlier digest are flagged in the pane, not
      silently averaged in.
- [x] **Time-to-measure** — a wall clock from the first stroke after a clear/record to Record,
      held in the store so no paint call site can forget it, shown live in the frame pane and
      stored per trial. This is the operator-cost baseline M3c has to beat.
- [x] **Operator spread reported separately from patch roughness.** `trialStats` gives n, mean,
      median, min/max, `max − min` and NMAD. NMAD is withheld below three trials; the pane greys
      the spread and says how many more trials are needed.
- [x] **Schema 0.2.0 + migration.** 0.1.0 rows are carried forward as numbered trials with
      `mask` absent — the mask they were measured from has since been repainted, so claiming it
      would be a lie. Export carries every trial, its mask and a `repeatability[]` summary.
- [x] **The error model no longer double-counts trials.** It fits one point per object at its
      trial mean; feeding every trial in would let a thrice-measured door outvote a
      once-measured table and shrink the residual by repetition alone.
- [x] Verified in the browser on the real 504px fixture: four trials recorded with distinct
      digests, none destroyed, spread 0.077 m, a duplicate correctly flagged, a deleted trial
      correctly removed, an 18 s paint duration captured from a real stroke. `verify.sh` green
      with **213 tests**; production build green.

- [x] **Trials painted and analysed 2026-08-04** — nine trials, three each on B1/B2/B3 at
      504px · 112f, nine distinct mask digests, all with durations. Full analysis in
      `MEASUREMENTS.md`; source export `~/Downloads/verge-m3b-measurements-2.json`.

### What the trials found — the hypothesis behind P0 was wrong

**Operator placement is not the noise term.** Within a sitting the same operator reproduces an
endpoint to **1–6 mm** — 15–90× smaller than the residual error against truth. The premise that
the 1.887 → ≈2.0 door swing was ~0.1 m of operator jitter is refuted.

**The frozen rows were a different, worse operator.** Against them, B1 moved +0.133 m (23× its
within-session spread) and B3 +0.021 m (24×). The cause is identified: those masks were painted
in an earlier *agent* session, and the B1 mask's lower endpoint never reached the bottom of the
door leaf (user-confirmed 2026-08-04). That is one placement mistake, not scatter, and it does
not belong in an uncertainty budget.

**The wrong answer looked healthy — this is the load-bearing lesson.** 1.887 m came with a
±0.037 m patch roughness, a supported floor and a 2 cm plane RMSE. No reported statistic
separated it from the correct 2.020 m; only looking at where the mask sat did. Hence the live 3D
highlight, and hence M3c's automatic mask must be able to **abstain** rather than return a
confident short answer. Still do not quote the 1–6 mm spreads as measurement uncertainty: they
bound one sitting, and are by construction blind to a mask placed in the wrong place.

**What remains is bias, which is correctable.** All errors negative and similar in relative size
(−3.8%, −6.9%, −5.0%). The error model moved from slope 0.893 / offset +0.024 to **0.969 /
−0.018**, and the door factor from 1.113 to **1.040**: with the door correctly at 2.020 m,
**DA3's raw scale on this clip is ~3% low, not ~11%.** The frozen door row was carrying most of
the apparent scale error. Raw MAE on B2+B3 like-for-like: 0.0445 → 0.0371 m; door-scaled 0.0147 m.
The 0.008 m residual RMS is *not* a noise floor — three points, two parameters, one dof.

**Floor determinism confirmed on real data.** All nine trials report byte-identical floor
diagnostics (support 0.145536, tilt 11.84694728°, RMSE 0.01231087 m, coherence 0.94942707).
M3a asserted this with a unit test; nine user-driven recordings confirm it end to end.

**Consequence for M3c:** automation was to be justified by better repeatability. At 1–6 mm and a
5–10 s median paint there is almost no headroom on either axis. The case for M3c must now rest on
ease of use and on scenes where a brush is impractical — not on precision.

### P0 follow-ups still open

- [x] ~~**The displayed ± is wrong.**~~ **Fixed 2026-08-04.** `geometry/uncertainty.ts` composes
      a budget that keeps the two error kinds apart, because a known bias stated as a ± reads as
      random scatter and is the exact mistake that let 1.887 m sit beside a ±0.037 m covering
      none of its 0.213 m error. The Objects pane now shows raw value → clip scale bias (%) →
      calibrated value ± total, with random and systematic broken out and the limitation printed
      beneath. `scaleVerdict` no longer receives patch roughness as if it were a total
      uncertainty; its verdict now answers "noise or bias?", which is the useful question.
      Six unit tests pin that the bias can never migrate into the random term.

- [x] ~~**Nothing in the app can tell a separated repeat from a back-to-back one.**~~ **Tooling
      built 2026-08-04** — the measuring itself is still yours to do, see below. Schema 0.3.0
      stamps every trial with a `sittingId` fixed for the page load; `trialStats` reports
      `withinSittingRangeM` and `betweenSittingRangeM` separately, and **only the between-sitting
      figure may be called an operator bound** — it stays NaN below two sittings. The nine P0
      rows migrate to one shared `legacy-2026-08-04` id, because they were one afternoon.
      **Blind mode** (Objects pane, next to SOURCE/RUN) hides every reading until you turn it
      off; verified in-browser that nothing but the tape truths survives it.

**Still yours to paint — I cannot do these, and pretending otherwise is the exact failure P0 found:**

- [ ] **Separated repeats.** Reload the app on a different day, turn **Blind** on, repaint B1/B2/B3
      from scratch, record, and only then reveal. Two sittings is the minimum for the
      cross-sitting number to appear at all. B1 and B3 already show 23–24× more between-sitting
      movement than within, and that gap — not the 1–6 mm — is the real operator term.
- [ ] Re-measure **B5** under the trial protocol; it is still n=1.
- [ ] **356/252px doors** are still n=1 at 1.408 / 1.125 m, so their door-scaled MAE columns are
      stale. The 504px ranking is unaffected — it won on raw error, which needs no door.
- [ ] Recompute the resolution verdict table once those exist. The Objects pane table and the
      error model both recompute themselves from the store, so this is a consequence of the
      painting above rather than separate work; what remains is folding it into `MEASUREMENTS.md`.

### P0.1 — Honesty fixes and backlog audit ✅ 2026-08-04

A second session spent entirely on the gap between what this file claimed and what the code did.
No cloud resource created, no file under `server/` touched (`git status` clean there).

- [x] **`geometry/uncertainty.ts`** — the uncertainty budget. Random terms (patch roughness ⊕
      half the trial range) in quadrature; the known scale bias stated and corrected, never
      folded into a ±. Degrades honestly: no trials means no operator term rather than a zero,
      and fewer than two graded objects means no calibration rather than a factor of 1.0.
- [x] **Sittings (schema 0.3.0) and blind mode** — see the P0 follow-ups above.
- [x] **Three stale checkboxes closed** that were already done: the M2a mock badge, M3c's
      "freeze the benchmark first", and M4's mask-evidence item.
- [x] **The M2b `<details>` block de-fanged** — eight unchecked boxes inside a section whose own
      header said everything was resolved. It was the largest source of phantom backlog here.
- [x] Cost ticker, Recompute rename, `predictVram` 144, app-side splat removal — all above.
- [x] `docs/DESIGN.md` checklist item 10 no longer requires a splats control we removed.
- [x] Full gate: `verify.sh` green with **226 tests** (213 → 226) including the server contract
      check under a venv, production build green, design review re-graded.

**Verified in-browser on the real 504px fixture**, with a synthetic 0.2.0 session seeded into the
in-app browser's own localStorage (which also exercised the 0.2.0 → 0.3.0 migration end to end):
budget renders raw → bias → calibrated ± with random/systematic split; blind mode leaves nothing
but the tape truths visible; a recorded trial carries this page load's `sittingId` and its own
mask digest while the nine migrated rows carry `legacy-2026-08-04`; a second sitting made the
cross-sitting figure appear and correctly flipped the budget's limiting term to "operator".

### M3c — Automatic evidence selection, **proven on the door first**

Nothing downstream changes: a brush mask and a model mask are the same bytes, and `setMaskData()`
in `measurement-store.ts` already exists as the seam — it writes a mask programmatically and
deliberately clears the paint clock, so a model mask cannot be credited with operator time.
**No cloud cost — this runs in the browser.** The first goal is repeatable measurement endpoints
on one canonical frame of clip B, not perfect outlines or propagation across the entire video.

**Scope decision, 2026-08-04 (user):** prove click-prompted selection on **the door** before any
grass work. And read the P0 findings first — the precision argument for this milestone is gone.
Manual endpoints repeat to 1–6 mm with a 5–10 s median paint, so automation cannot win on either
axis. What it must deliver instead is ease of use, scenes where a brush is impractical, and above
all the ability to **abstain**: the load-bearing P0 lesson is that a wrong mask produced a
confident, healthy-looking 1.887 m with no reported statistic distinguishing it from the correct
2.020 m. An automatic mask that returns a quiet wrong answer is worse than no automation.

- [x] ~~Freeze the manual-repeatability benchmark first.~~ **Done by P0 on 2026-08-04**: nine
      trials, three each on B1/B2/B3 at 504px, nine distinct mask digests, committed as
      `docs/measurement-trials-2026-08-04.json`. Automation now has a fixed target to beat.
- [ ] Prototype click-prompted selection with editable brush output. Accept it only if it reduces
      endpoint measurement variation or operator time without hiding failures.
- [ ] Report measurement delta, abstention/failure rate, correction clicks and latency. Mask IoU
      is diagnostic, not the product metric.

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

### P1 — Floor challenge set (queued: start after M3 completes)

The floor has only ever been challenged in one room. This is the largest *unknown* in the
project, as opposed to the known problems above — see "Floor generalization risk" near the top,
which this task exists to close. Deliberately scheduled after M3 by user decision on 2026-08-04.

- [ ] **Capture 5–10 short clips**, each spanning its scene with real camera translation (a pan
      from a fixed point has no parallax and DA3 has nothing to work with). Cover: portrait and
      landscape; noticeable phone roll and pitch; very little visible floor; a glossy or
      textureless floor; a room with a dominant tabletop competing with the floor; stairs or a
      split level; and one outdoor slope.
- [ ] **Track per clip**: support fraction, tilt vs gravity, below-floor mass, plane RMSE,
      gravity coherence, and — the new one — **the score margin between the best two floor
      hypotheses**. A narrow margin is the signal that the fit is a coin flip, and nothing
      currently reports it.
- [ ] **Add an explicit "cannot establish ground" result.** The present 1% support threshold is a
      last-resort rejection gate, not a certificate. Abstaining must be a first-class outcome
      that propagates: a measurement with no trustworthy floor should refuse, not guess.
- [ ] **Manual 3D floor seeds** for when the evidence is genuinely weak. `fitPlaneFromSeeds()`
      already exists in `geometry/plane.ts` and has never been reachable from the UI.
- [ ] Cost note: each clip needs a DA3 pass, so **batch the whole set into ONE warm cloud
      session** and `save-run.sh` them all before teardown. Plan the sweep before deploying.

### M3d — Field/raster regime (deferred, for the roadside case)

- [ ] Local ground raster → per-cell height percentiles above ground, point-count/confidence gate
- [ ] Output is a heat map, not a list; the donor's cell/segment code is the template
- [ ] Do **not** try to instance-segment vegetation; reserve segmentation for large discrete
      plants where identity actually matters
- [ ] Benchmark against physical patch references and report error plus valid-area/abstention
      coverage; a map that silently fills unsupported cells is not acceptable

### Bugs found during the 2026-08-04 audit

1. ⚠️ **Edge selection is impossible, so edge deletion is unreachable through the UI.**
   `graph-pane.tsx`'s `rfEdges` never sets `selected`, and `onEdgesChange` drops every change
   that is not a `remove`. React Flow is fully controlled here, so its internal selection is
   overwritten on the next render — and Backspace only deletes *selected* elements. Confirmed
   in-browser: a real click lands on `.react-flow__edge-interaction` and nothing selects.
   **Node deletion works** (10 → 9 nodes, and the node's wire went with it), so the fix is to
   carry `selected` on edges the same way nodes already do.
2. ⚠️ **Rewiring by port drag is still unverified.** Port handles are ~8 px; automated drags that
   miss them pan the canvas instead, which is indistinguishable from a rejected connection.
   `onConnect` + `isValidConnection` + the one-wire-per-input replace rule are all written and
   typed, but none of it has been driven by a real drag. Needs a human hand or a zoomed graph.
3. **Viewport 3D's Pause button did nothing** — `paused` was React state that the rAF loop never
   read, so the loop rendered on regardless. **Fixed 2026-08-04** via a ref, so pausing skips the
   work without tearing down the WebGL context.
4. **A control on the right edge of `.pane-status` silently leaves the viewport** — that row is
   `white-space: nowrap` + `overflow: hidden`. The blind-mode toggle was invisible in a narrow
   Objects pane until it was moved to `.object-context`, which now wraps instead of clipping.
   Worth remembering before putting any future control in a status row.
5. **Gotcha 4 is out of date in the good direction.** Coordinate clicks in the browser pane are
   *no longer* mis-scaled ~7.8×: a click at screenshot-space (197, 328) was measured landing at
   viewport (315, 525), exactly the 1.6× the 800×500-vs-1280×800 ratio predicts. Orbit was
   verified this way (see `docs/design-review-log.md`), closing the M2a item that said the
   `readPixels` checksum could not be repeated — tool screenshots do capture the WebGL surface.

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

## M4 — Productization + evidence hardening ⬜

- [x] ~~Remove dormant `infer_gs`, splat export types, UI checkbox and unused splat port/type~~ —
      **app side done 2026-08-04** (`InferParams.inferGs`, the `gs_ply`/`gs_video` artifact kinds,
      the checkbox and the `splat` port type/colour are gone). `server/` keeps its `infer_gs`
      field on purpose; see the standing constraints at the top.
- [ ] Compact `mini_npz` and/or transient object storage + signed URLs; verify live browser fetch
- [x] ~~Tie every recorded result to reproducible mask evidence and retain repeat trials~~ —
      done by P0 on 2026-08-04; each trial carries its own RLE mask and digest.
- [x] ~~Rename/remove the misleading Recompute action~~ — **done 2026-08-04**: it is now
      **"Rebuild measurement"** with a tooltip stating that DA3 is not run and nothing is billed.
- [ ] Per-session/per-node cost accounting

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

The service is **deleted** (0 Cloud Run services). The **image is kept** (9.8 GB, ~$1/month) and
its tag matches the current tree (verified 2026-08-04, below), so the next deploy should **skip
the build and start in ~1 min** — the first time that claim has been made against a checked tag.

```bash
./scripts/deploy.sh                  # builds only if server/ changed since the stored image
./scripts/teardown.sh                # deletes the service, KEEPS the image
PURGE_IMAGE=1 ./scripts/teardown.sh  # ...and deletes the image, when the project is done
FORCE_BUILD=1 ./scripts/deploy.sh    # rebuild even when the source hash matches
```

✅ **The image now matches the tree — checked 2026-08-04, and this is why `server/` is frozen.**
A clean tree hashes to `src-3038078518c96bb0`, and the registry holds exactly that tag (plus the
older `src-d8977556a0573326` from M2b). So the next deploy **should** finally take the skip
branch — which has still never executed, and this will be its first real test.

This is not luck. It is the whole reason the two known one-line server improvements were left
unapplied on 2026-08-04: `deploy.sh` hashes every file under `server/`, so a single comment
would have thrown away a matching 12 GB image and cost the next session ~20 minutes.

History, so the lesson is not lost: M2b claimed "the next deploy should skip the build" while
`server/contract.py` had been edited after that image was built (commit `2020ec9`, frame cap
112). The claim was wrong and M3.0 paid a full rebuild. The hashing logic was behaving correctly
throughout — the assumption that the tree had not changed was what was wrong. **Before
predicting a fast deploy, actually compare the tags:**

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
