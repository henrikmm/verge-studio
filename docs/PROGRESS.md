# Progress & handoff

Single source of truth for what is done and what is next. **Update this at the end of every
working session** — the agent task list is ephemeral and does not survive the session.

Milestone definitions live in the approved plan at
`~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md` (outside this repo).

Last updated: 2026-07-31 · commit `bc7f73b`

---

## Status at a glance

| Milestone | State |
|---|---|
| M0 — Bootstrap + offline viewer | **done** |
| M1 — GPU service live | **done** (with carve-outs below) |
| M2 — Node graph wired to cloud | not started |
| M3 — Height measurement (the goal) | not started |
| M4 — Splats + polish | not started |

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

## M2 — Node graph wired to cloud ⬜

- [ ] React Flow graph + typed colored wires on a content-addressed cache-key engine
- [ ] Node cards per `docs/DESIGN.md` (colored header, A/P badges, labelled ports, thumbnail, ms footer)
- [ ] Nodes: `FrameSource`, `DA3Depth`, `PointCloud`, `Viewer3D` / `Viewer2D`
- [ ] Inspector bound to node selection; stale nodes dim until re-run
- [ ] Wire the viewport to cloud artifacts instead of the fixture
- [ ] Session cost ticker (currently hardcoded `$0.00`)
- [ ] Design-review fix-list from 2026-07-31 (pane control row with Remove/Pause, OUTPUT toggle
      chips, warm-toned graph canvas, graph banner) — see `docs/design-review-log.md`

## M3 — Height measurement ⬜

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

Cloud is **fully torn down**. To bring it back: `./scripts/deploy.sh` (~15–18 min build),
then `./scripts/teardown.sh` when finished — the image bills for storage while it exists.

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
