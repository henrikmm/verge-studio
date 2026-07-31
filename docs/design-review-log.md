# Design review log

## 2026-07-31 — M0 shell (initial pass)

Graded against docs/DESIGN.md acceptance checklist, in-browser at 1280×800:

1. Dark surfaces — PASS (tokens: app `#0d0d0f`, pane `#151517`; no white surfaces in screenshots).
2. Four Dockview panes — PASS (Depth 2D, Viewport 3D, Graph, Inspector; tabs + separators present).
3. Chrome density — PASS (tab strip 26px, labels 11px).
4. Fixture cloud + orbit + count + gizmo — PASS (DA3-native scene.glb, 351,232 pts; drag-orbit
   changed the view between screenshots; axes gizmo bottom-right).
5. Turbo depth with metric legend — PASS (frame 1/4, 27.9–66.5 m).
6. Live status rows everywhere — PASS (viewport also reports ~16.7 ms frame time).
7. No horizontal scroll, gaps ≤4px — PASS (body overflow hidden; Dockview gaps ≤2px).
8. Type scale — PASS (UI ≤12px, numerics mono).
9. Squint test vs reference — N/A-M0 (docs/reference/ screenshot not yet provided).

Findings fixed during the pass:
- Donor `canonical-preview.ply` has ALL-BLACK vertex colors (old writer never wrote RGB) —
  switched viewport to DA3-native `scene.glb` (colored) per the plan's DA3-native policy;
  colorless clouds fall back to height-ramp coloring.
- `result.npz` entry is `confidence.npy`, not `conf.npy`.
- worker-report keys are `inference_gpu_seconds` / `peak_vram_bytes` / `wall_seconds`.
