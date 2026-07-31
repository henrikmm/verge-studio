# Canon sources — consult before guessing

## Depth Anything 3 (pinned upstream commit `3d835ec1a5802d64a8b8b15f817a1ab54809bfe4`)

- Repo: https://github.com/ByteDance-Seed/Depth-Anything-3
  - `README.md` — model zoo table, FAQ (metric depth: nested-giant output is already meters)
  - `docs/API.md` — full `inference()` parameter reference
  - `docs/CLI.md` — `da3` CLI flags (`--fps` default 1.0, `--process-res` default 504)
  - `src/depth_anything_3/api.py` — `DepthAnything3` class
  - `src/depth_anything_3/utils/geometry.py` — `unproject_depth()` and backprojection primitives; use these, don't rewrite
  - `src/depth_anything_3/utils/export/` — exporters + format enum: `glb`, `npz`, `mini_npz`, `gs_ply`, `gs_video`, `colmap`, `depth_vis`, `feat_vis`
  - `src/depth_anything_3/app/` — official gradio demo (identical to the HF Space); UI parameter defaults live here
    - `modules/file_handlers.py` → `FileHandler._process_video` — the canonical video→frames logic
    - `modules/ui_components.py` — the Space's slider defaults (sampling FPS, `process_res_method`)
  - `src/depth_anything_3/model/reference_view_selector.py` — `ref_view_strategy` implementations
  - `docs/funcs/ref_view_strategy.md` — recommends `middle` for temporally-ordered video
  - `da3_streaming/` — sliding-window long-video mode, future option. Its own README benchmark
    table measures **11.5–28.3 GB** peak VRAM depending on chunk size/resolution. The "<12 GB"
    figure in the main README's news blurb is best-case marketing — do not plan against it.
- Paper: https://arxiv.org/abs/2511.10647 · Project page: https://depth-anything-3.github.io
- HF Space (live demo): https://huggingface.co/spaces/depth-anything/Depth-Anything-3
- Model card: https://huggingface.co/depth-anything/DA3NESTED-GIANT-LARGE-1.1 (rev `b2359bdf`, CC-BY-NC-4.0)

Key facts already verified (do not re-research): nested-giant outputs metric meters and supports
the 3DGS head (`infer_gs=True` → `gs_ply`/`gs_video`); `mini_npz` = depth/conf/extrinsics/intrinsics
(no image), `npz` adds image; extrinsics are 3×4 w2c, intrinsics 3×3; glb contains a colored
conf-filtered point cloud + optional camera frustums (no mesh).

## Frontend libraries

- React Flow (graph): https://reactflow.dev/learn — package `@xyflow/react`
- Dockview (panes): https://dockview.dev
- Three.js: https://threejs.org/docs — PLYLoader/GLTFLoader from `three/examples/jsm/loaders/`
- Gaussian splat viewer: https://github.com/mkkellogg/GaussianSplats3D

## Cloud

- Cloud Run GPU services: https://cloud.google.com/run/docs/configuring/services/gpu
- Donor repo deploy patterns (read-only): `~/dev/Motiva_Challenge/infra/gcp/worker/{deploy,verify-deployment,teardown}.sh`

## Video ingestion — verified against the pinned commit (2026-07-31)

- The HF Space samples video by **FPS, not a fixed frame count**, and applies **no cap** on the
  resulting frame count: `frame_interval = max(1, int(video_fps / sampling_fps))`
  (`app/modules/file_handlers.py::FileHandler._process_video`).
- The Space's sampling-FPS slider defaults to **10** (range 0.1–60). The CLI's `--fps` defaults
  to **1.0**. These are the only two upstream precedents; a 10 s clip at 10 FPS ≈ 100 frames.
- `process_res` defaults to **504** in the API, CLI, and the Space alike. The Space never overrides
  it — it exposes only `process_res_method` (`low_res` = `upper_bound_resize`, the default).
  The `1024` seen in `docs/CLI.md` is an illustrative override, not the Space's behavior.
- `ref_view_strategy` defaults to `saddle_balanced` (best for unordered photo sets) but DA3's own
  docs recommend **`middle` for temporally-ordered video**. It only engages at ≥3 views.
- Multi-view mechanism: early layers run per-image self-attention; later layers alternate
  within-view and **cross-view** attention over all frames jointly. `DA3NESTED-GIANT-LARGE` pairs
  that any-view branch with a separate monocular metric model for absolute scale. Single-image
  inference never engages the cross-view path — this is why one image gives badly flawed geometry.
- DA3's in-repo `estimate_memory_requirement()` (`utils/memory.py`) under-predicts our one real
  measurement by ~4×. **Never plan VRAM from it** — measure on the real L4 instead.

## Measured facts from the predecessor (trust these, don't re-measure)

- L4, 4 frames @ 392 px: 7.67 s inference, 8.53 GiB peak VRAM, ~180 s cold start on a 12.4 GB image.
- YouTube blocks datacenter resolvers — never fetch video URLs from the cloud; upload frames from the Mac.
- Cloud Run on `verge-lab` has **no L4 quota with zonal redundancy**; `--no-gpu-zonal-redundancy`
  is mandatory on every deploy (verified by probe 2026-07-31).
- **DA3 imports `cv2` at module load** (`utils/export/gs.py` → `model/utils/gs_renderer.py` →
  `utils/camera_trj_helpers.py`), so the image needs OpenCV's shared libraries even though we
  never decode video server-side: `libglib2.0-0` (provides `libgthread-2.0.so.0`) and `libgl1`.
  The donor image got these transitively from `ffmpeg`; dropping ffmpeg drops them too, and the
  failure only appears at the first `/warmup` after a full build+deploy. The Dockerfile now runs
  an import check at build time so this class of error fails in the build instead.
