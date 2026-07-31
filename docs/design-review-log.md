# Design review log

## 2026-07-31 — inference controls + VRAM telemetry (commit c1d3765)

Graded against the revised checklist in docs/DESIGN.md, in-browser at 1280×800.

1. Dark surfaces — PASS (`body` computed `rgb(13,13,15)`; no white surfaces; no default focus rings).
2. Four Dockview panes — PASS (`document.querySelectorAll('.pane').length === 4`, tabs + sashes present).
3. Chrome density — PASS (tab strip `offsetHeight` 26px; labels 11px).
4. Fixture cloud + orbit + count + gizmo — PASS (351,232 pts; WebGL framebuffer checksum changed
   3965271619 → 3709733399 across a drag, and the rotation is visible in the screenshot; gizmo bottom-right).
5. Turbo depth with metric legend — PASS (392×224, frame 1/4, 27.9–66.5 m).
6. Live status rows — PASS (all four panes; viewport also reports 16.7 ms frame time).
7. No horizontal scroll, gaps ≤4px — PASS (`scrollWidth === clientWidth === 1280`).
8. Type scale — PASS (all measured chrome at 11px; body 12px; nothing >14px).
9. Squint test vs `docs/reference/` — PARTIAL (see fix-list).
10. Inspector exposes every inference param with mixed controls — PASS (fps, clip length, process res,
    max frames as sliders; ref view as dropdown; splats as checkbox; values in mono right-aligned).
11. VRAM visible in inspector + status bar, live during a run — PASS (mock run tracked to 21.07 GiB
    with the bar animating and the status chip pulsing amber).
12. Unmeasured prediction rendered as a labelled range — PASS (`VRAM (unmeasured) 11.50 GiB – 33.95 GiB`).
13. Capped frame plan explains itself — PASS ("10 fps × 10s = 100 frames, over the 16-frame cap.
    FPS lowered to 1.60 so the frames still span the whole clip.").
14. Mock labelled as mock — PASS (`NVIDIA L4 (mock)`).

### Fix-list (all M2 scope, none blocking)

1. **Item 9 — pane chrome is missing the reference's control row.** Sentinel shows
   `Running 11.8 ms` on the left and `Remove` / `Pause` buttons on the right, plus a separate
   `OUTPUT` row with toggle chips. We have a single merged status line and no per-pane pause.
2. **Item 9 — graph canvas tone.** Reference uses a warm brown-grey graph surface distinct from
   the pane bodies; ours is the same neutral dark, so the graph doesn't read as its own surface.
3. **Item 9 — no node cards yet.** Graph is a placeholder until React Flow lands, so node anatomy
   (colored header, A/P badges, labelled ports, thumbnail, ms footer) is unverifiable.
4. Graph banner (caps title + prose pipeline description) not implemented.

### Harness note (not an app defect)

Coordinate-based `computer` clicks in the browser pane are mis-mapped — a click at (688, 257)
arrived at `clientX 5368, clientY 1999`, a ~7.8× scale-up, so it lands outside the window and no
element receives it. Ref-based clicks (`ref_N` from `read_page`) work correctly. **Verify canvas
interaction via ref-based input or synthetic pointer events dispatched on the canvas** (stubbing
`setPointerCapture`, which three's OrbitControls calls), and confirm with a WebGL `readPixels`
checksum rather than by eyeballing screenshots — identical-looking screenshots here were a
measurement artifact, not a broken control.

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
