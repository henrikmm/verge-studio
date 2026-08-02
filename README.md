# Verge Studio

A Sentinel-style node-graph web app for cloud depth inference and 3D measurement.

Drop in a video → a Cloud Run L4 GPU runs Depth Anything 3 → depth maps and point clouds
appear live in docked viewports → measure object heights against a fitted ground plane.
Gaussian-splat rendering remains a later milestone.

**Video is the standard input.** DA3's quality comes from cross-view attention over many
frames; a single image never engages it and produces badly flawed geometry. Frames are
sampled by FPS (the same way DA3's own demo does it) and extracted locally with ffmpeg —
the cloud only ever sees the frames, never the video.

## Running it

```bash
cd app && npm install && npm run dev     # http://localhost:5173
```

The dev server ships a fixture-backed mock of the inference service plus real local ffmpeg,
so the whole UI works offline at zero cloud cost. Point `VITE_INFER_BASE` at a deployed
service to use a real GPU.

M3b's Run Source defaults to saved, reproducible DA3 runs and can also accept the latest manual
live run. An operator paints endpoint evidence on a registered RGB/depth frame, sees those exact
points highlighted in 3D, and records raw measurements plus explicitly labelled door-scale
diagnostics. See [MEASUREMENTS.md](MEASUREMENTS.md) for the current grading tables and
resolution/frame-count verdict.

```bash
./scripts/verify.sh                      # typecheck + unit tests + fixture smoke
./scripts/deploy.sh                      # build + deploy to Cloud Run (L4)
./scripts/smoke-infer.sh                 # one short real run
./scripts/teardown.sh                    # ALWAYS run when done — the image bills while it exists
```

- `app/` — local web app (React + TypeScript + Vite; Dockview panes, React Flow graph, Three.js viewport)
- `server/` — FastAPI + Docker DA3 inference service (Cloud Run, 1× NVIDIA L4, scale-to-zero)
- `geometry/` — measurement code DA3 doesn't provide (ground plane, scale check, height)
- `fixtures/` — real DA3 output used for offline development and tests
- `docs/` — **[PROGRESS.md](docs/PROGRESS.md) (what's done, what's next — start here)**,
  [DESIGN.md](docs/DESIGN.md) (UI spec), [SOURCES.md](docs/SOURCES.md) (canon references)
- `donor/` — verbatim staging copies from the predecessor repo (read-only reference)

Conventions and agent workflow: see [CLAUDE.md](CLAUDE.md).

Personal/research project. Uses DA3NESTED-GIANT-LARGE-1.1 (CC-BY-NC-4.0) — no commercial use.
