# Design review log

## 2026-08-04 — uncertainty budget, sittings, blind mode (commit pending, from `ff62f1f`)

In-browser pass at 1280×800 after the honesty fixes. Browser console: **0 errors**. Storage was
seeded with a synthetic 0.2.0 session (the in-app browser has its own localStorage), which also
exercised the 0.2.0 → 0.3.0 migration end to end.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`; the only near-white fills are the
   `#d8d8d8` frames port dots, which are the DESIGN.md port palette).
2. Dockview panes — **PASS** (Depth 2D, Viewport 3D, Graph, Inspector + Objects).
3. Chrome density — **PASS** (tab strip 26px; labels 11px).
4. Cloud + orbit + count + gizmo — **PASS**. Orbit is now *measured*, not assumed: a
   `left_click_drag` inside the canvas visibly rotated the room between two screenshots, and the
   gizmo rotated with it. This closes the M2a "orbit not re-measured" item — the old `readPixels`
   checksum fails while the pane is hidden, but tool screenshots do capture the WebGL surface.
5. Turbo depth + legend — **PASS** (frame 1/256, mask registered in RGB).
6. Live status rows — **PASS** (10 nodes · 15 wires · 2 stale; 1,000,000 pts; 36,654 px selected).
7. No horizontal scroll — **PASS** (`scrollWidth === clientWidth === 1280`).
8. Type scale — **PASS** (zero elements inside `.pane` above 14px; readouts in JetBrains Mono).
9. Squint test vs `docs/reference/sentinel-scientific-organism.png` — **PASS**. Comparable
   darkness, density and contrast; the warm graph canvas, colored node headers, A/P badges and
   ms footers all read as the same family. Remaining differences are deliberate: Sentinel puts
   the numeric value inside the slider track and uses collapsible ▼ section headers, we put the
   value right-aligned in mono and use plain headings.
10. Inspector exposes every inference param — **PASS with a spec change**: process res, res
    method, ref view and max frames each show their value in mono on the right. **Splats are
    gone**, by the 2026-08-03 scope decision — the checklist item was edited to match rather
    than left describing a control we deliberately removed.
11. VRAM in inspector + status bar — **PARTIAL**: both are present (`0 B / 22.03 GiB`). "The live
    bar moves during a run" still needs a real cloud run and was not re-verified.
12. Unmeasured predictions as a labelled range — **NOT RE-VERIFIED** (needs a loaded clip; the
    frame-plan section reads "no clip loaded" against the recorded fixture).
13. Capped frame plan explains itself — **NOT RE-VERIFIED**, same reason.
14. Mock-backed readouts labelled — **PASS** (`NVIDIA L4 (mock)` in the inspector header).

Fixed during the pass:
- The blind-mode toggle was clipped out of view: `.pane-status` is `nowrap` + `overflow:hidden`,
  so a control on its right edge silently leaves the viewport in a narrow pane. Moved to the
  `.object-context` row and gave that row `flex-wrap` so it wraps instead of clipping.
- The uncertainty budget went blank whenever no mask was painted. It now falls back to the
  object's recorded trial mean and says which of the two it is showing.
- Viewport 3D's **Pause button did nothing** — `paused` was state that the rAF loop never read.
  The loop now skips its work while paused (via a ref, so pausing cannot tear down the context).

Found and NOT fixed — logged as PROGRESS follow-ups:
- **Edges can never be selected, so edge deletion is unreachable.** `rfEdges` never sets
  `selected` and `onEdgesChange` drops every non-`remove` change, so React Flow's selection is
  overwritten on each render and Backspace has nothing to delete. A real click was confirmed to
  land on `.react-flow__edge-interaction` with no selection resulting. Node deletion is fine
  (10 → 9 nodes, and its wire went with it).
- Rewiring by port drag remains **unverified**: handles are ~8px, and automated drags that miss
  pan the canvas instead. Needs a human hand or a zoomed-in graph.

## 2026-08-02 — M3b evidence workflow + coordinate review (commit pending)

Full in-browser pass at 1280×800 against `docs/DESIGN.md` and both Sentinel references. The
recorded door fixture was driven through RGB/depth masks, 3D selection, all three resolution
settings, object grading and export. Browser console: **0 warnings, 0 errors**.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`; no white surfaces or default-blue links).
2. Dockview panes + resize — **PASS** (four required panes plus the Objects tab; CUA sash drag
   changed the top widths 500/500 → 548/452 px and was restored).
3. Chrome density — **PASS** (tab strip 26px; labels 11px).
4. Fixture cloud + orbit + count + gizmo — **PASS** (1,000,000 points; before/after drag visibly
   changed the view; selected points, translucent floor, ruler and axis gizmo remained visible).
5. Turbo depth + metric legend — **PASS** (356px run, frame 1/256, 0.91–2.49 m legend; pink mask
   remained registered when toggling RGB → Depth).
6. Live pane status — **PASS** (Depth/3D elapsed time and 1,000,000-point count shown; Graph's
   focused measurement view has 8 nodes / 13 wires, while Full graph has 10 / 15; Objects shows
   recorded views and the fixture's measured GPU time).
7. No horizontal scroll / tight gaps — **PASS** (`scrollWidth === clientWidth === 1280`; Dockview
   panes meet on 0–2px borders).
8. Type scale — **PASS** (tabs 11px, body 12px, numeric readouts mono; native range inputs are
   13.33px internally but render no text).
9. Squint test vs `docs/reference/` — **PASS** (comparable darkness, dense chrome, warm graph
   canvas, coloured node headers and typed wires; no landing-page whitespace).
10. Inference controls — **PASS** (Frame Source exposes Sampling FPS / Max frames; DA3 exposes
    Process res / method / Ref view / Max frames / Splats with slider, dropdown and checkbox mix).
11. VRAM in inspector + status — **PASS** (both visible in this pass; live mock movement was
    exercised in the 2026-07-31 acceptance run and its telemetry path is unchanged).
12. Unmeasured range honesty — **PASS** (regression from the 2026-07-31 measured pass; prediction
    logic unchanged by M3b and still renders a labelled range).
13. Capped-frame explanation — **PASS** (regression from the 2026-07-31 measured pass; frame-plan
    code unchanged, and frame identity is now additionally explicit in M3b).
14. Mock labelling — **PASS** (`NVIDIA L4 (mock)` in the current inspector snapshot; fixture nodes
    say `OFFLINE FIXTURE`).

Findings fixed during this pass:

- Object rows had averaged measurements across incompatible resolution settings. They now show
  only the selected run; the error model is likewise per-run and includes residual RMS.
- B1 still used floor→top even though the truth is physical door-leaf bottom→top. It now uses the
  translation-independent extent mode, and all three B1 observations/verdicts were re-recorded.
- The 2D selection was back-projected in raw NPZ coordinates but compared with DA3's transformed
  GLB. Applying `hf_alignment` to selected points and camera up made the pink 2D/3D evidence
  coincide and made the ground fit operate in one coordinate system.
- B2/B5 are endpoint measurements, not whole-object semantic masks. The UI now asks for the
  floor patch and upper edge explicitly, matching the user's confirmed vertical stroke.
- “Recompute” reused cached nodes. It now invalidates ground/selection and their descendants,
  and a browser check confirmed new elapsed times after the click.
- DA3 looked disconnected because recorded evidence was a separate graph branch. `Run Source`
  now switches between recorded evidence and manual live DA3 output; the focused view hides the
  two live-only nodes while Full graph shows the complete connection.
- The correction is now labelled “Door-scaled” and consistently applies the multiplicative
  factor to every length while raw DA3 remains the primary result.
- User visual review caught a floor that was mathematically low-error but physically implausible:
  only 0.7% of the 504px cloud supported it and it was tilted 27.9° from camera-derived up. The
  self-referential two-pass/anchor chain was removed. Competing whole-cloud/lower-region fits now
  expose support, tilt and RMSE; the selected 504px floor is 14.6% supported and tilted 11.8°.
- The old floor square was centred at the world origin and much larger than its evidence, making
  tilt look like a plane projected outside the cloud. It is now centred and clipped to the actual
  yellow floor-support points. Extent rulers are anchored to the selected endpoint bands and are
  labelled separately from “height above floor”.

Remaining review item: direct 3D add/remove painting is a useful future correction tool for
occlusion and sparse per-frame evidence, but it is not needed to repair registration. B4 remains
ungraded because its stand/table contact is occluded; no endpoint was invented.

## 2026-08-01 — M2a node graph (commit pending)

In-browser at the default dock layout, mock-backed, driven end to end (drop → Run).

- **Fix-list item 1 (pane control row) — DONE.** All panes now carry `Running`/`Paused` +
  elapsed ms on the left and a `Pause` button on the right, plus a separate `OUTPUT` row with
  toggle chips (`Depth`|`Confidence`, `Points`|`+ Cameras`) and a dim parenthesised hint.
- **Fix-list item 2 (graph canvas tone) — DONE.** Canvas is `#171512`, warm against the neutral
  `#151517` pane bodies.
- **Fix-list item 3 (node cards) — DONE.** Colored category header, `A`/`P` badge, labelled
  port rows with type-colored dots, thumbnail, mono ms footer. Verified live: Frame Source
  showed the extracted first frame, Point Cloud reported `351,232 pts`.
- **Fix-list item 4 (graph banner) — DONE.** `VERGE STUDIO / METRIC DEPTH PIPELINE` plus a
  one-line prose description, with `Fit` top-right.

Measured this pass:

- Drop → Frame Source ran alone (76.6 ms, `30f · 10.00 fps` from a 3 s clip) and **every
  downstream node stayed stale** — the GPU node did not auto-fire. This is the cost guard working.
- Explicit Run → DA3 Depth 6066 ms (mock) → Point Cloud 122 ms → both viewers, all reading
  `all current` afterwards.
- `Last run · Frames 30` proves the browser sent 30 real JPEGs as **multipart** and the
  middleware parsed them — the seam PROGRESS listed as never exercised.
- Viewport renders the cloud through the graph rather than a hardcoded fixture path.

Not measured this pass:

- **Orbit interaction was not re-verified.** `readPixels` returns a cleared buffer outside the
  render frame, and rAF is paused whenever the browser pane is hidden — which it is while the
  JS tool runs — so the M0 checksum technique could not be repeated here. The OrbitControls code
  is unchanged from the pass where it *was* measured; only the data source changed.
- Full acceptance-checklist re-grade (items 1–14) has not been redone since the layout changed.

### New fix-list

1. Panes have no `Remove` button — `PaneControls` supports one but Dockview owns pane lifecycle,
   so it is not wired.
2. `Pause` on a pane stops the depth pane re-fetching but does not stop the 3D render loop.
3. React Flow logs a `nodeTypes` recreation warning under HMR; harmless, but check it is absent
   on a cold load before treating the console as clean.

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
