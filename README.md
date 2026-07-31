# Verge Studio

A Sentinel-style node-graph web app for cloud depth inference and 3D measurement.

Drop in a video or images → a Cloud Run L4 GPU runs Depth Anything 3 → depth maps,
point clouds, and Gaussian splats appear live in docked viewports → measure object
heights against a fitted ground plane.

- `app/` — local web app (React + TypeScript + Vite; Dockview panes, React Flow graph, Three.js viewport)
- `server/` — FastAPI + Docker DA3 inference service (Cloud Run, 1× NVIDIA L4, scale-to-zero)
- `geometry/` — measurement code DA3 doesn't provide (ground plane, scale check, height)
- `fixtures/` — real DA3 output used for offline development and tests
- `docs/` — [DESIGN.md](docs/DESIGN.md) (UI spec), [SOURCES.md](docs/SOURCES.md) (canon references)
- `donor/` — verbatim staging copies from the predecessor repo (read-only reference)

Conventions and agent workflow: see [CLAUDE.md](CLAUDE.md).

Personal/research project. Uses DA3NESTED-GIANT-LARGE-1.1 (CC-BY-NC-4.0) — no commercial use.
