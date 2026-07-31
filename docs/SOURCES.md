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
  - `da3_streaming/` — sliding-window long-video mode (<12 GB VRAM), future option
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

## Measured facts from the predecessor (trust these, don't re-measure)

- L4, 4 frames @ 392 px: 7.67 s inference, 8.53 GiB peak VRAM, ~180 s cold start on a 12.4 GB image.
- YouTube blocks datacenter resolvers — never fetch video URLs from the cloud; upload frames from the Mac.
