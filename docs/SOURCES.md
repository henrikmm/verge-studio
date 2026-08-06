# Sources — external references worth trusting

Where the facts about other people's software come from. Check here before guessing.

Everything measured *by this project* — memory ladders, accuracy, timings, the mistakes that cost
time — lives in [REGISTRY.md](REGISTRY.md) instead.

## Depth Anything 3

The depth model. Upstream repository pinned at commit `3d835ec1a5802d64a8b8b15f817a1ab54809bfe4`.
Weights: `DA3NESTED-GIANT-LARGE-1.1` at revision `b2359bdf`, licensed CC-BY-NC-4.0 — personal and
research use only.

- Repository: https://github.com/ByteDance-Seed/Depth-Anything-3
  - `README.md` — the model table, and the note that this variant's depth output is already in
    metres
  - `docs/API.md` — the full parameter reference for `inference()`
  - `docs/CLI.md` — command-line flags
  - `src/depth_anything_3/utils/geometry.py` — turning depth back into 3D points. **Use these
    rather than writing new projection code.**
  - `src/depth_anything_3/utils/export/glb.py` — builds the 3D scene file from all frames, and
    records the transform it applied. Any points selected from the raw result must receive that
    same transform before being compared against the scene file.
  - `src/depth_anything_3/app/modules/file_handlers.py` — `_process_video`, the reference
    implementation of turning a video into frames
  - `src/depth_anything_3/app/modules/ui_components.py` — the public demo's own defaults
  - `docs/funcs/ref_view_strategy.md` — recommends the `middle` reference view for video, where
    frames are in time order
  - `da3_streaming/` — a sliding-window mode for long video, a possible future option. Its own
    benchmark table reports 11.5–28.3 GB of memory depending on settings; the "under 12 GB" figure
    in the main README is a best case, not a plan.
- Paper: https://arxiv.org/abs/2511.10647 · Project page: https://depth-anything-3.github.io
- Public demo: https://huggingface.co/spaces/depth-anything/Depth-Anything-3
- Model card: https://huggingface.co/depth-anything/DA3NESTED-GIANT-LARGE-1.1

### What the upstream source says — verified 2026-07-31, do not re-research

- **The demo samples video by rate, not by a fixed number of frames**, and applies no limit to the
  resulting count. Its rate slider defaults to **10 per second**; the command line defaults to 1.
- **Processing resolution defaults to 504** in the API, the command line and the demo alike. The
  `1024` in the command-line documentation is an illustrative override, not the demo's behaviour.
- **The reference-view strategy defaults to a setting meant for unordered photo sets**, but the
  documentation recommends `middle` for video. It only engages at three or more views.
- **How the multi-view mechanism works**: early layers look at each image alone; later layers
  alternate between within-view and *across-view* attention over all frames jointly. This variant
  pairs that with a separate single-image model for absolute scale. A single image never engages
  the across-view path, which is why one photograph gives badly wrong geometry.
- **The output formats**: the compact result holds depth, confidence, and the camera's position
  and lens parameters; the full result adds the images. Camera positions are 3×4 world-to-camera,
  lens parameters 3×3. The 3D scene file holds a coloured, confidence-filtered point cloud and
  optional camera markers — no mesh.
- **The transform recorded in the scene file is not a floor correction.** It converts raw
  reconstruction coordinates into the first camera's axes and re-centres the scene. Estimating the
  ground remains this project's own separate step.
- **The model writes no result file of its own** in the export used here.
- **The repository's own memory estimator under-predicts reality by roughly four times.** Never
  plan memory from it; measure on the real device.
- **The model imports OpenCV at load time**, through its splat-rendering path, so the image needs
  OpenCV's shared libraries (`libglib2.0-0`, `libgl1`) even though video is never decoded on the
  server.

## Frontend libraries

- React Flow, the node graph: https://reactflow.dev/learn — package `@xyflow/react`
- Dockview, the pane system: https://dockview.dev
- Three.js: https://threejs.org/docs — loaders come from `three/examples/jsm/loaders/`
- Transformers.js, the browser-local segmentation runtime:
  https://huggingface.co/docs/transformers.js

### Licences to avoid when choosing a segmentation model

Ultralytics YOLO is AGPL-3.0 and YOLO-World is GPL-3.0 — both unsuitable here. Grounded SAM
(Grounding DINO plus SAM) is Apache-2.0 throughout and offers the same open-vocabulary capability.
Mask2Former's *weights* are CC-BY-NC-4.0, the same licence as the depth model, so they add no new
constraint. SAM 2 is Apache-2.0, but its cross-frame memory is documented as stateful and prone to
drift; a bad propagated state contaminates later frames.

## Cloud

- Cloud Run with GPUs: https://cloud.google.com/run/docs/configuring/services/gpu
- Cloud Storage signed links:
  https://docs.cloud.google.com/storage/docs/access-control/signed-urls
- Uniform bucket-level access:
  https://docs.cloud.google.com/storage/docs/using-uniform-bucket-level-access
- Object lifecycle rules: https://docs.cloud.google.com/storage/docs/lifecycle

Deployment patterns were adapted from the predecessor project at
`~/dev/Motiva_Challenge/infra/gcp/worker/` — read-only, never modified.

## This project's cloud environment

Project `verge-lab`, region `us-central1`, keyless application-default credentials. There is **no
GPU quota with zonal redundancy on this project**, so `--no-gpu-zonal-redundancy` is mandatory on
every deploy (verified by probe, 2026-07-31). Artifact Registry does not use immutable tags here;
images are pushed by digest.

Video hosting sites block datacenter networks, so a video URL can never be fetched from the cloud.
Frames are always uploaded from this Mac.

## Local environment

ffmpeg 8.1.2 via Homebrew. Node 22 or later and npm via Homebrew. Python 3 at
`/usr/local/bin/python3`. The dev server runs on port 5173.
