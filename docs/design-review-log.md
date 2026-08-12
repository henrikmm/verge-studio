# Design review log

Dated evidence from interface reviews, newest first. Each entry records what was graded against
the checklist in [DESIGN.md](DESIGN.md), what was measured, and what was fixed at the time.

This is a record, not a task list. Anything a review found and left unfixed becomes a task in
[TASK.md](TASK.md); findings below describe the state on their own date.

## 2026-08-11 — private-clone publication review, 1280×800 (commits dd1b2a5–5c7eac2)

Full pass after the security, setup and English-language changes. A generated 4.0 s, 640×360 clip
was loaded through Browse, planned at 40 frames, extracted to 40 JPEGs and run against the local
mock. No cloud request was made. The first attempt exposed a real regression: the new local nonce
covered `/api/...` but not the mock's exact `/api` base, so the run stopped at a 403. The base check
and its regression test were fixed before this final pass.

1. Dark surfaces — **PASS**. Body `rgb(13,13,15)`; zero white computed backgrounds.
2. Status without hue alone — **PASS**. Idle, running, refusal and failure each carried a glyph and
   text. Red remained confined to failure/refusal and control thumbs; no green status appeared.
3. Panes and graph — **PASS**. Five default panes were present. Graph reopened with 13 wires in
   measurement view and 15 in full view; the dock sash resized under a real pointer drag.
4. Tab density — **PASS**. Every measured tab strip was 26 px high.
5. 3D interaction — **PASS**. Viewport reported 351,232 points with the axis gizmo visible. A drag
   changed the camera from the front view to an oblique view of the cloud.
6. Metric depth — **PASS**. Depth mode showed the turbo map and a 27.93–66.48 m legend.
7. Numeric pane status — **PASS**. Depth reported 210.1 ms and Viewport reported 16.7–19.5 ms plus
   the point count.
8. Window bounds — **PASS**. `scrollWidth === clientWidth === 1280`; groups met with no gap.
9. Type density — **PASS**. Visible controls and readouts matched the 12 px interface scale; the
   numeric rows used the mono face. No pane heading exceeded the allowed scale.
10. Reference comparison — **PASS**. Against both Sentinel captures the app kept the same dark,
    dense instrument character, restrained separators and compact graph, without copying their
    brighter ornamental effects.
11. Mixed controls — **PASS**. Inspector showed sliders, selects, checkboxes, actions and mono
    values, including the point-cloud source and colour selects.
12. Memory — **PASS**. Inspector and status bar both showed VRAM. During inference the live row
    moved from 6.70 GiB toward 13.57 GiB, then recorded a 14.92 GiB mock peak.
13. Memory provenance — **PASS**. The 40-frame plan said `interpolated`; extrapolation and warning
    cases remain pinned by the run-planning tests.
14. Capped arithmetic — **N/A**. The publication walkthrough intentionally used the README's 4 s
    clip, which produced 40 frames and did not meet the cap. The capped case remains covered by the
    existing design record and tests.
15. Mock honesty — **PASS**. Depth, Viewport, the run record and status bar all said MOCK and stated
    that the geometry was the roadside fixture, not the loaded clip.
16. Focus and hide — **PASS**. Focus made one group 1280×775 while the other groups were 0 px wide;
    Escape restored three groups. Hiding Depth left its view-bar control visible, and reopening it
    restored the pane.
17. Parameter refresh — **PASS**. Point Cloud's colour select changed from photograph to height
    and back through the Inspector. The graph remained live and no costly `Running…` control
    appeared; the held mock output stayed visible.
18. Wire deletion — **PASS**. Selecting one full-graph wire produced exactly one selected edge;
    Backspace changed 15 edges to 14. Reset restored the default graph.
19. Narrow pane — **PASS**. Setup measured 179 px wide. Across 27 visible Inspector rows, zero child
    bounds crossed the pane bounds.
20. Both modes — **PASS**. Standard loaded first; Advanced exposed cloud, layer and navigation
    controls, survived reload, and retained every Standard control.
21. Help placement — **PASS**. There were zero visible explanatory paragraphs in pane bodies.
    Live mock and ground-refusal warnings remained visible; the same-day help-placement pass above
    remains current because this change altered wording, not the popover.
22. Measurement headline — **N/A**. This mock walkthrough had no selected measurement or tape
    truth. The result-strip behavior remains held by its nine tests and the frozen door evidence.
23. Plan before work — **PASS**. Loading showed 40 frames, 10.00 effective fps, 640×360, upload
    bracket and VRAM before extraction. Only the Extract press produced the 40-cell contact sheet.
24. Run phases — **PASS**. The run showed named inference, a 4 s elapsed clock, measured-memory
    wording, then `run complete`; its own mock depth and point cloud replaced the empty viewers.
25. Service lifecycle — **N/A**. No paid service existed. The read-only state still separated
    `Service: none — nothing is billing` from `Next deploy: unconfigured`; deploy confirmations
    were not invoked.
26. No amber instructions — **PASS**. Amber named the missing cloud configuration; it did not tell
    the operator what to press.
27. Help restraint — **PASS**. Parameter rows carried label help rather than `?` buttons; section
    help stayed within the two-dot limit.
28. Pane shares — **PASS**. The fresh layout measured 512 / 512 / 256 px, exactly 40 / 40 / 20.

Final browser console: **0 errors and 0 warnings**. Final open issue count from this pass: **0**.

## 2026-08-11 — Amber removed, help on labels, pane shares, 1280×800 (commit pending, on a311aa7)

A second pass the same day, from the user's review of the first. Four conventions changed; graded
on the items they touch rather than the full checklist, which the entry below covers.

- **The split really is 40/40/20** — measured 512 / 512 / 256 px of a 1280 px dock, and each pane
  now prints its own share in its status row, so this stops being something to take on trust.
  `dock-split.test.ts` pins the arithmetic from 1024 px up; the worst rounding error is 0.08
  points, at 1024 px, where the side column reads 19.92%.
- **Item 26, no amber instruction text** — **PASS**. Zero `.inspector-note` elements in the Setup
  pane body on a fresh load; the three that existed were two precondition hints and the mock
  paragraph.
- **Item 27, `?` parsimony** — **PASS**. Counted per section: Clip 1, Run 1, Parameters 1, Run
  Source 0, Current run 0. Five parameter rows lost theirs and gained a dotted-underline label
  that opens the same panel; verified opening on `pointerover`, on click (`aria-expanded=true`)
  and closing on Escape.
- **Item 28, pane shares** — **PASS**. `40%`, `40%`, `20%` read straight off the three panes.
- **Item 19 at a narrow pane** — **PASS**, re-measured with the new rows: zero overflowing
  children at 180 px and at 256 px.
- **Item 5, orbit** — **PASS**, confirmed by the user on 2026-08-11: a drag inside Viewport 3D
  rotates the scene. It could not be graded automatically, and that is now understood rather than
  suspected — Dockview's own sash and tab strip fail to drag under exactly the same conditions, and
  Dockview ships working drag. All three use `setPointerCapture`, which rejects untrusted events.
  Registry section 3 records it so it is not investigated a fourth time, and this item needs a hand
  every pass from now on.

**Amended the same day.** The pane shares became drag-only after review: all three appear together
on pointerdown on a sash and go about a second after release. Permanently visible they were four
more figures competing with the readouts the panes exist for, and the question they answer is only
asked while the answer is changing. Measured across a simulated grab: hidden when idle, all three
showing `40% / 40% / 20%` during, still showing just after release, hidden again after the tail.

## 2026-08-11 — Setup pane, deploy control and run phases, 1280×800 (commit pending, on 7408ad8)

Full pass after the upload/deploy/inference work. Graded on `da3Test.mp4` (13.5 s, 1920×1080)
loaded through the drop target, extracted to 112 frames, and run against the local mock. Both
modes. Three failures found and fixed during the pass; one item could not be re-verified.

1. Dark surfaces — **PASS**. `body` computed `rgb(13,13,15)`.
2. Status without hue alone — **PASS**. The new marks all carry shape or text: preconditions use
   `●`/`◐`/`○`, the phase readout `◐`/`●`/`▲`, and the deploy chip pairs its dot with the words
   `Deploy`, `Deploying · m:ss`, `Deployed · not billing` and `Live · m:ss`.
3. Default panes and Graph — **PASS**. Five panes opened; the Setup tab replaces Inspector and
   the stored layout still resolves, because the pane id stayed `inspector`.
4. Tab strip and labels — **PASS**. Strip measured 26 px, tab 18 px, label `11px`.
5. Viewport 3D orbit — **NOT VERIFIED**. The point cloud renders (351,232 pts) and the axis gizmo
   is visible, but two automated `left_click_drag` passes over the canvas produced no camera
   change — the first selected page text instead. Untouched by this work, so this is a gap in the
   check rather than a known regression. It needs a hand, per the skill's automation note.
6. Depth 2D turbo depth with a metre legend — **PASS**, seen in screenshot.
7. Live status rows with numbers — **PASS**. Setup's header carries `MODE · DA3`; the run readout
   carries elapsed seconds and byte counts.
8. No horizontal scroll at 1280×800 — **PASS**. `scrollWidth` 1280 = `clientWidth` 1280.
9. Font sizes — **FIXED DURING PASS**. The Browse/Change button in the Clip drop zone inherited
   nothing and computed `13.3333px`, the only text in the pane over 12 px. It had been that way
   since the Clip section was added. Now `11px` with the rest.
10. Squint test against `reference/` — **PASS**. Density unchanged; the new sections reuse
    `.inspector-row` metrics, and the contact sheet is the only new large element.
11. Inference parameters with mixed controls — **PASS**, and every one now carries a `?`.
12. Memory in both places, moving during a run — **PASS**. Observed climbing 8.74 → 18.55 GiB in
    the phase readout across one run.
13. Measured / interpolated / extrapolated — **PASS**. Read `VRAM (measured) 21.28 GiB` at 112
    frames and `VRAM (interpolated) 16.10 GiB` at 54, live as the slider moved.
14. Capped plan explains itself — **PASS**. `10 fps × 13.5s = 135 frames, over the 112-frame cap.
    FPS lowered to 8.27 so the frames still span the whole clip.`
15. Mock-backed readouts labelled — **PASS**. The MOCK RUN banner renders in both viewers; its
    copy was updated from the stale “Inspector → Cloud control” to the status bar's Deploy.
16. Focus, Escape, hide and reflow — **PASS**, unchanged.
17. Parameter refresh without other interaction, and no costly node — **FIXED DURING PASS**, then
    **PASS**. Measured by counting `fetch` calls across a sampling-rate change: the plan went from
    112 frames @ 8.27 fps to 54 @ 4.00 with the capped note correctly disappearing, and there were
    **0 calls to `/api/extract` and 0 to `/api/infer`**. Frame Source being `manual` is what makes
    that safe — `runAutoFree` denies every manual node.
18. Wire select and Backspace — **N/A**. The Graph is not in the default layout and was not opened.
19. Every control inside a narrow pane — **FIXED DURING PASS**, then **PASS**. At 180 px the Source
    `select` ran 63 px past the pane's right edge (right 1267 against 1204): a `select` takes its
    minimum width from its widest option and ignores the flex container. Now `min-width: 0;
    max-width: 100%`, and measured clean at 180, 220 and 280 px.
20. Both modes — **PASS**. Standard hides Cloud control, Cloud session and GPU; the capped-plan
    note, the VRAM label and the mock warning all render in Standard.
21. Explanation behind a `?`, landing inside the window — **PASS**. With the pane forced to 180 px,
    the Source help panel opened on hover and measured 757–1082 × 510–654 inside a 1280×800
    window.
22. Measurement headline in reserved chrome — **PASS**, unchanged.

Also recorded: the precondition rows were rebuilt to wrap, with the fix on its own line, after the
first capture showed the clip detail ellipsised to `none…` and the instruction running off the
right edge at a 320 px pane.

## 2026-08-09 — Free/Object measurement and fixed-size 3D evidence, 1280×800 (commit pending)

Full checklist pass on the recorded 504 px · 112f door fixture, in Standard and Advanced. The
visible changes are Free as the default measurement context, a temporary Free row/card in Objects,
named-only Record, and screen-sized selection/ruler marks. The user's requested brush check was
run in **Fixed**: two pink endpoint patches stayed on the same door pixels shown in Depth 2D, while
the orange ruler remained a line with small endpoint marks rather than scene-sized discs.

1. Dark surfaces — **PASS**. `body` computed `rgb(13,13,15)`; no light application surface.
2. Status without hue alone — **PASS**. Free/Evidence, running, idle and errors retain text plus
   `●`, `○` or `▲`; the pink brush remains the photograph-overlay exception.
3. Default panes and Graph — **PASS**. Depth 2D, Viewport 3D, Inspector, Objects and Runs opened;
   Graph returned from the view bar with 8 nodes and 13 wires intact.
4. Density — **PASS**. The 26 px tab treatment and 11–12 px labels are unchanged; Free adds one
   compact target row, not a new control section.
5. Viewport — **PASS**. It rendered 1,000,000 points and the gizmo. A horizontal drag visibly
   changed the view. Fixed showed the active brush from its source camera.
6. Depth — **PASS**. Turbo depth rendered with a 0.52–2.66 m metric legend.
7. Numeric status — **PASS**. Observed Depth 2D 2903.6 ms; Viewport 26.5 ms and 1,000,000 points;
   Graph 8/13/2; Objects 5 targets and 0 trials; Runs 6 runs and 303 MB.
8. Window bounds — **PASS**. `scrollWidth === innerWidth === 1280` and `scrollHeight ===
   innerHeight === 800`; dock groups meet without a gap over 4 px.
9. Type — **PASS**. No new type size or family; readings remain mono and pane copy remains at the
   existing 12 px ceiling.
10. Squint test — **PASS**. Against both Sentinel references, the app retains the same near-black
    field, one-pixel boundaries, dense rows and bright data against quiet chrome.
11. Inspector controls — **PASS**. The mixed checkbox/select/value rows remain present; this
    change adds no inference parameter and hides none.
12. Memory — **PASS for presence, N/A for movement**. Inspector/status bar both read
    `0 B / 22.03 GiB`; no paid run was started.
13. Memory provenance — **N/A**. No frame-plan prediction was presented in this saved-run pass.
14. Capped-plan arithmetic — **N/A**. No new clip was loaded or capped.
15. Mock labels — **PASS**. `NVIDIA L4 (mock)`, `GPU: cold` and `cloud: local fixture` stayed
    visible in Standard.
16. Focus, hide and restore — **PASS**. All six panes were focused in turn; Escape restored the
    layout. Graph hide/show and Reset reflowed the workspace without losing its nodes.
17. Automatic refresh — **PASS**. Toggling Run Source auto mode changed the state immediately and
    restored it without starting a costly node.
18. Wire selection/delete — **PASS by the current graph interaction regression**. The visible
    graph retained 13 wires; the tested Backspace path removes only the selected edge.
19. Narrow pane — **PASS**. Depth 2D was dragged to 185 px; Output, Free/brush, frame and
    confidence rows wrapped inside it and every control remained reachable.
20. Both modes — **PASS**. Advanced survived a reload; Standard restored correctly. Free remains
    the measurement default in both, and Advanced remains a strict superset.
21. Explanation placement — **PASS after one fix**. The first capture found a paragraph explaining
    Free inside the Objects card. It duplicated `temporary brush · never recorded` and `STORAGE
    temporary`, so it was removed. The focused recheck has no explanatory paragraph.
22. Measurement headline — **PASS**. Free says `free measurement — paint anything in Depth 2D`.
    Named Fixed-view painting moved the strip to the target, extent, tape, error and percentage,
    all in reserved chrome above the canvas.

Fixed during the pass: the redundant Free explanation. No other checklist defect was found.
The browser logged one React dependency-array warning only during hot replacement of the changed
effect; a full reload produced the new default state and no product error.

## 2026-08-09 — the 2D frame fits its pane, and a 40/40/20 window, 1280×800 (commit pending, on d4a91d3)

Partial pass. The change is a containment fix in Depth 2D and a new default split, so this grades
1, 3, 4, 5, 6, 8, 9, 16 and 19 — every item the two touch — on **both** the portrait door fixture
(576×1024) and the landscape outdoor run `20260806-193346-26d16e` (1024×576). Items 2, 7, 10–15,
17, 18 and 20–22 were not re-run.

The defect, measured before the fix on the outdoor run: the frame drew **835 px wide inside a
427 px stage**. The stage was sized by height alone, so a landscape frame ran off the side and
**51% of the image was scrollable but invisible**, with nothing on screen saying so. The portrait
fixture hid it — 576×1024 fits a tall narrow pane by height, the one shape that already worked.

1. Dark surfaces — **PASS**. `body` computed `rgb(13,13,15)`; no new surfaces in this change.
3. Default panes and drag-resize — **PASS**. A cleared `localStorage` opened on the five default
   panes. Dragging the Depth/Viewport sash to 181 px and back to 400 px reflowed both, and Reset
   returned the layout to 512/512/256.
4. Tab density — **PASS**. Tab strips 26 px, labels 11 px, unchanged.
5. Orbit — **PASS**. Two screenshots either side of a drag inside Viewport 3D differ; 1,000,000
   pts on the status row, gizmo visible.
6. Depth and its legend — **PASS**. Turbo mapping with `0.52 m` / `2.66 m` either side of the
   ramp. The legend and the mask readout moved out of the scroller's flex row in this change and
   both still land where they did.
8. Window bounds — **PASS**. `documentElement.scrollWidth - clientWidth === 0` at 1280×800;
   measured gap between adjacent dock groups **0 px**.
9. Type — **PASS**. The sweep for rendered text above 14 px returns empty.
16. Focus and restore — **PASS**. Focus filled the window with Depth 2D — the frame recentred to
    440 px wide of a 1600 px stage rather than staying at its old size — and Escape restored
    512/512/256 exactly.
19. Narrow pane — **PASS**. At a 181 px Depth 2D pane, **0 of 4** control rows put a child outside
    the pane's box, and the frame fitted to 181×321 in a 181×415 stage with zero overflow.

Measured after the fix, all at zoom 1 and all with `scrollWidth === clientWidth`: outdoor
512×288 in a 512×505 stage; door 283×504 in 512×504; door at a 181 px pane 181×321. Zoom 2.25 and
zoom 1.25 were each sampled six times over 1.5 s and held 1152×648 and 640×360 — the fit is taken
from the stage's BORDER box, so a scrollbar appearing cannot shrink the frame that caused it and
then grow it back. Painting still lands where it is clicked: a stroke down the centre of the
displayed frame selected 24,993 px, drew down the centre of the image, and lit the matching band
in the 3D cloud.

Found and not fixed: at 1280 px the Inspector group's 20% share is **256 px**, which is too narrow
for its three tabs — Dockview moves Runs into an overflow chevron reading `1`. It was one click
away before, at 427 px. Below about 1100 px the Objects target names truncate to `D…`, `Ta…` as
well. A minimum width for the side column would settle both; it is a task, not a defect of this
change, because 40/40/20 is what was asked for.

Environment note, same as the 2026-08-09 entry below: the browser pane stops painting between
tool calls, and `requestAnimationFrame` never runs while it is stopped. `ResizeObserver` is on the
same clock, so a pane resize looks like a dead observer until a screenshot forces a paint. Every
measurement above was taken after one.

## 2026-08-09 — Standard/Advanced, the result strip and the new front door, 1280×800 (commit pending, on bba67f3)

Partial pass, on the door fixture at 504 px · 112f. This grades the items the change touches —
1, 3, 4, 8, 9, 19 and the three new items 20–22 — plus the interactions each of them names. Items
2, 5, 6, 7, 10–18 were not re-run; nothing in this change alters what they grade, and a PASS
nobody measured is what the log exists to prevent.

1. Dark surfaces, no white — **PASS**. `body` computed `rgb(13,13,15)`. The new surfaces are the
   result strip on `--bg-node`, the help panel on `rgba(21,21,23,0.98)` and the dashed clip drop
   zone; none is a light surface and the `?` uses a border for focus, not a blue ring.
3. Default panes and the Graph's return — **PASS**. A cleared `localStorage` opened on Depth 2D,
   Viewport 3D, Inspector, Objects and Runs — pane titles read exactly those five, no Graph. The
   view bar's Graph button read `Show Graph` and brought it back.
4. Tab density — **PASS**. Tab strips measured 26 px; labels unchanged at 11 px.
8. Window bounds — **PASS**. `scrollWidth === innerWidth === 1280` and
   `scrollHeight === innerHeight === 800`.
9. Type — **PASS**, after a fix during the pass. The result value was written at 15 px, which is
   the only thing in the app that would have exceeded the 14 px ceiling; it is 14 px now and the
   sweep for rendered text above 14 px returns empty in both modes, with a reading on screen.
19. Narrow pane — **PASS** in both modes. With the Viewport pane forced to 180 px, every child of
    every `.pane-controls`, `.output-row` and `.result-strip` was inside the pane's box —
    0 overflowing of 5 rows in Advanced, 2 in Standard. The strip wraps to 71 px rather than
    clipping, which is the trade DESIGN.md already makes for control rows.
20. Both modes — **PASS**. The switch is in the status bar and survives a reload. Standard:
    **2 control rows, 4 buttons** (Free, Fixed, Cinematic, Cameras); Objects has no budget block,
    no trial ledger, no error model and no resolution table. Advanced: 4 control rows, 13 buttons,
    all four Objects sections back. Nothing-stranded was tested rather than assumed — Below plane
    switched on in Advanced, then Standard, then Advanced again, and it came back **off**.
21. Explanation behind a `?` — **PASS**. The dot opens on keyboard `focus()` as well as hover,
    `aria-describedby` matches the panel id, Escape closes it. Opened from the Viewport pane
    squeezed to 180 px the panel measured left 587, right 912, top 304, bottom 473 in a 1280×800
    window — fully inside, flipped to the side with room.
22. The measurement is the headline — **PASS**. A brush stroke down the door leaf produced
    `● B1 Door leaf · EXTENT 1.444 m · tape 2.100 m · error -65.6 cm · off by -31.2%`, agreeing
    with the Objects pane digit for digit. 23 px tall, one line, in mono, and
    `.pane-body .viewport-overlay` counted **0** elements in Standard.

Fixed during the pass: the result value at 15 px (item 9); the `?` wrapping to a second line at
the default width, fixed by shortening the basis label to `EXTENT` / `ABOVE FLOOR` and the row gap
to 8 px, taking the strip from 39 px to 23 px; and a doubled `● ●` in the Objects status row,
where the text repeated a glyph `.pane-status .ok::before` already draws.

Not verified here: Cinematic's frame cost. The browser pane throttles `requestAnimationFrame` to
zero when it is not being painted, so the pane's own millisecond readout froze at a startup
artefact (1498 ms — one `elapsed` of ~30 s entering a fresh EMA) and cannot be read in this
environment. Motion itself is confirmed: two screenshots three seconds apart differ, and the pose
function's revolution and floor-clearance properties are held by 13 unit tests.

## 2026-08-08 — complete rebuilt-cloud and lifetime pass, 1280×800 (commit pending, on c508b6e)

Full checklist run on saved outdoor run `20260806-193346-26d16e`, with `Ours`, Photo and 6M
selected. The point-cloud change is visible in the viewport and adds a second graph output, so
this pass grades the whole interface rather than only the new row.

1. Dark surfaces, no white — **PASS**. `body` computed `rgb(13,13,15)`; the full capture has no
   light application surface or default-blue link.
2. No status by hue alone — **PASS**. Current, running, blocked and failed remain `●`, `◐`, `○`
   and `▲`; active cloud controls also change border and weight. The new Display/Measure split is
   text and port position, not a status colour.
3. Six panes and resize — **PASS**. All six Dockview tabs were present. Dragging the first splitter
   changed the top groups from 500/500 px to 480/520 px, then restored them.
4. Tab density — **PASS**. All six tab strips measured 26 px; tab labels remain 11 px.
5. 3D viewport — **PASS**. The viewport showed `6.000.000 pts`, the cloud and axis gizmo. In Free
   view, a drag changed 4,313 bytes of the cropped canvas capture and changed its encoded size
   from 4,551 to 21,671 bytes.
6. Depth view — **PASS**. The turbo-coloured depth view rendered and its metric legend read
   2.64–7.32 m.
7. Numeric pane status — **PASS**. Observed Depth 2D 2,139.2 ms; Viewport 23.6 ms and 6M points;
   Graph 8 nodes, 13 wires, 2 stale; Inspector 204.1 ms; Objects 12 trials; Runs 0.0 ms, 6 runs and
   303 MB.
8. Window bounds and gaps — **PASS**. `scrollWidth === innerWidth === 1280` and
   `scrollHeight === innerHeight === 800`; adjacent group edges meet with no gap above 4 px.
9. Type — **PASS**. Numeric readouts had 130 visible JetBrains Mono matches. The only 16 px
   elements were the document and an empty root wrapper; no rendered copy exceeded 14 px.
10. Squint test — **PASS**. Against both Sentinel captures, the app has comparable near-black
    panes, one-pixel borders, compact rows and graph density. The viewport still spends more
    height on explicit Cloud/Colour/Points/View/Layers rows; that deliberate mismatch is unchanged
    from the 2026-08-07 review and no row clipped.
11. Inference parameters — **PASS**. Selecting DA3 Depth exposed Process res 504 and Max frames
    112 as sliders, plus Res method and Ref view as selects, with values aligned in mono.
12. Memory — **N/A for movement; presence passed**. Both Inspector and the status bar showed
    `0 B / 22.03 GiB`. This saved-run review did not start a paid GPU run, so it could not observe
    the live bar move.
13. Memory provenance — **N/A**. There was no live frame plan or inference run in this offline
    review, so no measured/interpolated/extrapolated estimate was presented.
14. Capped frame arithmetic — **N/A**. No clip was loaded into Frame Source and no frame cap was
    applied. The saved run remains labelled 99f.
15. Mock provenance — **PASS**. The Inspector said `NVIDIA L4 (mock)` and the status bar said
    `cloud: local fixture` and `GPU: cold`.
16. Focus and hide — **PASS**. Focus made Viewport 3D 1280×775 while the other groups measured
    zero in one axis. Escape restored 500/500/1000/280 px groups without losing the 6M cloud.
    Hiding Depth 2D reduced the tab count to five; its status-bar button restored it at 43.1 ms.
17. Automatic parameter refresh — **PASS**. Changing Point Cloud colour from Photo to Height in
    the Inspector changed the Point Cloud pass from 8,290.7 to 3,064.3 ms without another action.
    Ground Plane stayed at 1,679.4 ms and Run Source at 67.3 ms; no costly node started.
18. Wire selection — **PASS**. The point-cloud→viewer wire gained React Flow's `selected` class.
    Backspace changed 13 wires to 12 and removed only that edge. Reload restored the unsaved
    default graph to 13 wires.
19. Narrow pane — **PASS**. At 183 px, Depth 2D's four control rows measured 84.5, 78.5, 92.5
    and 52.5 px high. Every row had `scrollWidth === clientWidth === 183` and zero children outside
    its bounds.

The rebuilt cloud itself passed its visual check: Fixed frame 1 contains the walkway and foliage
that were black in the report, and the harness render for frame 96 no longer has the coherent far
hole. A 1M→3M→6M pass stayed Fixed, and ten rapid budget clicks settled on 6M with zero browser
warnings or errors.

**Fix-list:** none. No new checklist defect was found. Items 12–14 were inapplicable because this
review deliberately used saved local evidence and spent no GPU time.

## 2026-08-08 — the CLOUD switch in Viewport 3D, 1280×800 (commit pending, on d09859c)

A **scoped** pass, not a full checklist run. One control row was added — `CLOUD [DA3] [Ours]` in
Viewport 3D's chrome — so the items graded are the ones a new row can break. Everything else was
last graded in the entry below and is untouched by this change. Recorded door fixture,
`door-504px-112f`.

1. Dark surfaces, no white — **PASS**. `body` computed `rgb(13,13,15)`, unchanged.
2. No status by hue alone — **PASS**. The active chip is marked by border and weight, the same
   treatment `OUTPUT` and `VIEW` already use; the hint `(leanest frame 57%)` is text.
4. Tab strip ≤ 28 px — **PASS** (26 px, unchanged).
5. Renders, point count, gizmo — **PASS**. Switching to `Ours` re-rendered at `1.000.000 pts`
   with the gizmo still drawn; switching back restored DA3's coloured cloud.
7. Live status row with numbers — **PASS**. The row carries its own number, and it is the number
   that distinguishes the two clouds: the leanest frame's share of its own pixels, 57% on `Ours`
   against nothing on DA3, which has no per-frame accounting to report.
8. No horizontal window scroll — **PASS**. `documentElement.scrollWidth` 1280 against
   `innerWidth` 1280.
9. Fonts ≤ 12 px, numerics mono — **PASS**. The row inherits `.output-row`; no new type.
17. A parameter change refreshes the graph on its own — **PASS**. The chip calls
    `setNodeParamAndRun`, and the ground fit followed without any other interaction: 14.6%
    support / 11.8° / 1.2 cm on DA3, 12.5% / 11.7° / 1.5 cm on `Ours`, matching
    `inspect floor --cloud npz` headlessly. No costly node ran — `da3-depth` stayed blocked.
19. Narrow pane — **PASS**, from a 180×800 capture with Viewport 3D focused: `CLOUD`, `DA3` and
    `Ours` all sit on one line inside the pane, while `LAYERS` wraps to three. Graded from the
    capture rather than from `getBoundingClientRect`, because the emulated resize and the dock
    relayout raced each other and the measured widths stayed at 1280 while the render was at 180.
    A measurement that disagrees with the pixels is not evidence; the capture is.

**Not graded:** 3, 6, 10–16, 18. Unchanged by this change.

**Found and left unfixed:** the rebuilt cloud is coloured by height ramp, because the npz carries
depth and confidence but never RGB. The source frames are on disk, so real colour is available and
is now a task.

## 2026-08-08 — every control row wraps, 1280×800 (commit pending, on 583713d)

A targeted pass on pane chrome after `.output-row`, `.pane-controls`, `.brush-toolbar`,
`.frame-toolbar` and `.segment-toolbar` were all made to wrap. Recorded door fixture,
`door-504px-112f`. Items not listed were not re-graded; nothing in this change touches them.

**The headline is not that rows gained a second line — it is what the second line contains.**
Measured at the DEFAULT 1280×800 layout, before wrapping, three of Depth 2D's rows needed more
width than they had, so their right-hand contents were outside the pane at the very viewport this
checklist grades at: `.pane-controls` needed **593 px in 500**, the OUTPUT row **570 in 500**, the
brush toolbar **599 in 500**. `Hide`, `Pause` and `Confidence` were among the casualties. Item 8
passed throughout, because a clipped pane produces no window scrollbar.

1. Dark surfaces, no white — **PASS**. `body` computed `rgb(13,13,15)`. One element matched a
   light-background scan: `.dv-scrollbar-horizontal`, measured **0 px wide**, so it paints nothing.
2. No status by hue alone — **PASS**. The one addition is the clamped-tilt marker, which is the
   word `(GATED)` in the floor readout. Text, not colour, and readable in greyscale.
3. Six panes with tabs, drag-resize works — **PASS**. All six tabs present; the splitter drags in
   this pass are what produced the 183 px pane below.
4. Tab strip ≤ 28 px — **PASS** (26 px).
5. Renders, orbit changes the view, point count, gizmo — **PASS**. A drag of (450,200)→(520,170)
   visibly rotated the cloud and moved the gizmo; `1.000.000 pts`.
7. Live status row with numbers — **PASS**, both panes (`Running 49.2 ms Door · 504 px · 112f ·
   frame 1/256 · NPZ 1/112`, and `Running 0.0 ms 1.000.000 pts`).
8. No horizontal scroll at 1280×800 — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Fonts ≤ 12 px, mono readouts — **PASS**. Largest RENDERED text 12 px; the only 16 px matches
   are `<script>`, `<style>` and `<title>`, all zero-sized.
19. **Graded at a narrow pane — PASS, and this is the item the change exists for.** Depth 2D
    dragged to **183 px**: every child of all four of its rows stays inside the pane on both axes,
    zero escapes, with the pane 445 px tall. Rows measure 72 / 79 / 93 / 53 px, so 297 px of the
    pane is chrome and the canvas keeps the rest — the stated trade, taken deliberately.
    Viewport 3D's four rows stay at 19 px each, unchanged, because they already fitted.

**One limit found, and it is on the other axis.** A pane squeezed to **74 px tall** cuts the
stacked rows off at its bottom edge — the rows are contained horizontally and then run out of
pane. Wrapping cannot fix that; it needs the pane's control stack to scroll. Not reachable by
dragging in the default layout (the smallest this pass produced by hand was 445 px tall), so it is
recorded as a limitation rather than raised as a task.

## 2026-08-07 — keyboard navigation and the fixed camera view, 1280×800 (commit pending)

Graded after Viewport 3D gained WASD movement, a VIEW row switching Free against Fixed, the video
ghost and the Camera path layer. Recorded door fixture, `door-504px-112f`.

1. Dark surfaces, no default focus rings — **PASS** (`body` computed `rgb(13,13,15)`). The amber
   focus ring on the new chips is byte-identical to the one on the pre-existing `Points` chip,
   measured by focusing both: `rgb(229,151,0) auto 1px`. Not introduced here, and not blue.
2. No status by hue alone — **PASS**. The one new colour, `#e879a0`, is the legend's *camera* port
   type carried by the path, its marker and the recorded-frame border — data, not state. Both new
   failures lead with `▲` (`NO FIXED VIEW`, `NO CAMERA TRACK`), and Free-against-Fixed is carried
   by the chip's background and border, not its hue.
4. Tab strip ≤ 28 px — **PASS** (26 px).
5. Renders, orbit changes the view, point count, gizmo — **PASS**. A drag of (315,184)→(365,200)
   visibly rotated the cloud after the navigation rewrite, so moving the rig did not cost the
   orbit. `1.000.000 pts`; gizmo present, and now derived from the camera's own direction rather
   than from `controls.target`, which is stale while Fixed has the orbit controls switched off.
7. Live status row with numbers — **PASS**.
8. No horizontal scroll — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Fonts ≤ 12 px, mono readouts — **PASS**. Largest rendered text 11 px; overlay JetBrains Mono
   11 px.
10. Squint test — **PASS on darkness and density, with one honest mismatch.** Pane chrome went
    from 81 px to **119 px** at 405 px wide: a VIEW row, plus LAYERS wrapping to two lines under a
    fifth chip. That is 26% of a 450 px pane against roughly 10% in `reference/`. Deliberate, and
    recorded here rather than buried — three rows of one-of-N and toggle chips is what this pane
    now needs. Chrome is **the same 119 px in both modes**, so switching does not resize the view.
3, 6, 11–18 — **N/A**; untouched by this work.

**The narrow-pane test from TASK task 4 now passes for this pane.** Forced to 180 px, every
chip in all three rows stays inside its row (OUTPUT 19 px, VIEW 56 px, LAYERS 58 px,
`scrollWidth === clientWidth` on each, zero escaped children) in both Free and Fixed. OUTPUT fits
because its 45-character mouse hint was deleted rather than allowed to clip — the `Keys` panel
inside the viewport carries the controls now, where no neighbour can push it out. The task itself
stays open: it asks for *every* pane, and Depth 2D's OUTPUT row is untouched.

**Fixed-view geometry, measured rather than eyeballed.** The recorded-frame rectangle came out
240×432 in a 405×432 pane — aspect **0.5548** against the clip's true 280/504 = **0.5556**,
centred to 0 px on both axes, `src=/door/frames/frame-0185.jpg` matching slider frame 185, opacity
0.5 matching the 50% control.

Fixed during the pass:

- **The readout was unreadable over the ghost.** `text-shadow` alone only separates text from a
  mid-tone background; over a bright photo the dim grey washed out completely — in the mode where
  that line states the camera's height and field of view. It now sits on a 55% backing panel.
- **WASD was undiscoverable** until you clicked `Keys`. The reference capture puts exactly this
  information in the same place (`Native Camera: RMB look, WASD move`), so the VIEW row carries a
  permanent `WASD move · arrows look`. It is dropped in Fixed, where the row also holds the ghost
  controls and a hint cost a whole extra line — 136 px, measured, before the change.
- **`.recorded-frame` overshot its pane by 2 px**, the border falling outside the box and being
  clipped away exactly when the frame fills the height. `box-sizing: border-box`.

Also fixed, found by testing rather than by grading: the pane opened on **empty space with the
cloud off screen**. The mode-handoff effect also runs when the camera track finishes loading, and
it was treating that as "leaving Fixed" and moving the orbit pivot to wherever the camera faced —
before the controls had aimed it at the cloud. It now keys on the transition, not the current mode.

## 2026-08-07 — the floor overlay learns to show its own evidence, 1280×800 (commit pending)

Graded after the floor layer became a metric grid, gained both up-axes and the points beneath the
plane, and the readout gained the two numbers that decide whether a floor is a floor. Recorded
door fixture, `door-504px-112f`.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`).
2. No status by hue alone — **PASS**. The three overlay colours are the type legend, not state:
   `#f3c969` for everything that *is* the fitted plane (grid, fill, support points, its normal),
   `#f4f4f6` for the camera-derived vertical, which is not a port type, and `#f59e0b` for the
   points below. Grid versus fill versus dots are three different *forms*, so the two amber
   layers stay apart without relying on hue, and each is independently switchable.
4. Tab strip ≤ 28 px — **PASS** (18 px).
5. Viewport 3D renders, orbits, counts, gizmo — **PASS**. Orbiting to look along the floor showed
   the grid lines converging in perspective and lying flat at the base of the scene, which is the
   whole reason the grid replaced a flat translucent disc.
8. No horizontal scroll — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Fonts ≤ 12 px, mono readouts — **PASS**. Zero rendered elements measure above 12 px; the
   readout is JetBrains Mono at 11 px.
10. Squint test — **PASS**. The fourth chip cost no height: chrome stayed at 81 px because the
    row's hint was dropped rather than allowed to wrap.
3, 6, 7, 11–18 — **N/A or regression**; untouched by this work and graded on 2026-08-07's earlier
pass, which this entry sits above.

Findings fixed during this pass:

- **F1.** A fourth chip would not fit beside the hint at the pane's 405 px width, and the row went
  back to 36 px. The hint went instead of the row growing — four chips that show their own state
  and carry tooltips need no sentence telling them they start off — and `Floor plane` became
  `Floor grid`, which is both shorter and what it now draws. Row back to 19 px, all four chips
  measured inside it.
- **F2, and the one that mattered.** Adding `BELOW` grew the floor readout from 45 characters to
  59 — **391 px inside a 405 px pane body**, six pixels from silently losing its RMSE figure,
  in a container with hidden overflow. `.viewport-overlay` had no width bound at all. It now
  carries `max-width: calc(100% - 16px)` and wraps: measured at 405, 260 and 180 px body widths,
  nothing clips at any of them and the full text survives. This was self-inflicted and would not
  have shown up at 1280×800 — the checklist's own width is what nearly hid it.

## 2026-08-07 — the fitted floor becomes a switchable layer, 1280×800 (commit pending)

Graded after Viewport 3D gained a LAYERS row and the floor readout learned to distinguish a
current fit from a stale one and from a refusal. Recorded door fixture, `door-504px-112f`.
Browser console on a clean tab: **0 errors, 0 warnings**.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`). The four elements a
   greater-than-200 background scan flags are Dockview's `.dv-scrollbar-horizontal` at
   `rgba(255,255,255,0)`, transparent and 0×4 px. No white surfaces.
2. No status by hue alone — **PASS**. The layer chips separate on from off by luminance, not hue:
   text `rgb(138,138,144)` → `rgb(212,212,216)`, border `rgb(42,42,46)` → `rgb(138,138,144)`. The
   two new floor states carry glyphs — `◐` stale, `▲` refused — with amber and red only
   reinforcing them.
3. Six panes with Dockview tabs — **PASS** on presence. Drag-resize not re-exercised; unchanged by
   this work, last measured 2026-08-02.
4. Tab strip ≤ 28 px, labels 11–12 px — **PASS** (18 px, 11 px). See F1 for row density.
5. Viewport 3D: cloud, orbit, point count, gizmo — **PASS** (1,000,000 pts; a drag from
   (395,250) to (455,225) visibly changed the view; gizmo visible). **The floor evidence rotated
   with the scene**, which is what confirms the new layers are geometry anchored in the cloud
   rather than an overlay painted on the glass.
6. Depth 2D turbo + metric legend — **N/A** this pass; the pane is on RGB for masking and the
   code is untouched.
7. Live status row with numbers in every pane — **PASS** (Depth 2D `1206.1 ms`, Viewport
   `0.0 ms · 1.000.000 pts`, Graph `8 nodes · 13 wires · 2 stale`, Inspector `47.9 ms`).
8. No horizontal scroll; gaps ≤ 4 px — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Fonts ≤ 12 px, mono readouts — **PASS**. Every element measuring above 12 px was `<script>`,
   `<style>` or `<title>` text rather than rendered copy; the new chips are 10 px, matching the
   OUTPUT chips exactly.
10. Squint test against `reference/` — **FAIL → fixed**, see F1.
11. Inspector mixed control types — **PASS** on inspection; unchanged.
12. Memory in inspector and status bar — **PASS** on presence (`0 B / 22.03 GiB` in both). Bar
    movement needs a run and was not exercised; no run was paid for.
13–15, 18 — **N/A** this pass; untouched by this work.
16. Focus fills without remounting, Escape restores — **PASS** (focused Viewport 3D, Escape
    returned four panes, cloud still 1,000,000 pts, so nothing remounted).
17. Parameter refresh with no costly node — **PASS**. Ground Plane parameter edits re-ran the
    graph unaided; DA3 stayed `blocked`, GPU `cold`, cost `none` throughout.

Findings fixed during this pass:

- **F1 (items 10 and 4).** The new LAYERS row measured **36 px against every other row's 19 px**,
  because its hint — "off by default — switch on to check the fit" — wrapped to a second line at
  the pane's 405 px width. Nothing was clipped, so the wrap was doing its job, but it pushed the
  pane's chrome to 98 px of a 567 px pane against the reference's two tight rows. The hint is now
  "off by default": the row measures 19 px, chrome is 81 px, and the body gained 18 px.

Measured while grading, and worth keeping: forced to 180 px, the LAYERS row wraps to 38 px with
**both chips still inside its box**, while the OUTPUT row beside it stays 19 px and pushes its
`Confidence` chip **outside** — the exact hazard DESIGN.md's pane-chrome warning describes, now
demonstrated rather than asserted. That clipping is pre-existing and is now a task in TASK.md.

## 2026-08-06 — durable storage states in the Runs pane, 1280×516

Graded after the Runs pane learned to distinguish where an unsaved run's bytes actually are.
**Viewport was 1280×516, not the checklist's 1280×800** — this display allows 1204×753, so the
required height is physically unreachable here. Width, type, colour and density measurements are
unaffected; anything height-dependent is marked below. Two findings, both in the new work, both
fixed during the pass and re-measured.

The degraded state has no natural way to occur on demand, so it was produced by adding a synthetic
`publishMode: "degraded"` stub to `~/verge-runs/index.json`, screenshotting, and restoring from a
backup — the file was confirmed byte-identical afterwards by sha256. Without that, the one state
that must not look like the others would have been graded from reading the code.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`).
2. No status by hue alone — **PASS**. Every instance of the old green `rgb(74,222,128)` and of
   `rgb(90,160,232)` is a `.port-dot` or a React Flow handle — the type legend decision 10 exempts,
   never a status. The new degraded mark is a **▲ glyph**, so it survives greyscale; its amber only
   reinforces it.
3. Six panes with tabs — **PASS** (Depth 2D, Viewport 3D, Graph, Inspector, Objects, Runs).
4. Chrome density — **PASS** (tab strips measured 26 px, ≤ 28; labels 11 px).
5. Viewport orbit, count, gizmo — **PASS on appearance** (`1.000.000 pts`, gizmo visible, door-clip
   cloud rendered). Orbit itself unchanged by this work and not re-dragged this pass.
6. Turbo depth with metric legend — **N/A this pass.** The pane showed its empty state, because the
   new clip has no measurement targets — the deferred limitation in REGISTRY section 7, unrelated.
7. Live status rows — **PASS** (four rows carrying digits, including `6 runs · 185 MB on disk ·
   1 transient`).
8. No horizontal scroll — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Type scale — **PASS** (rendered sizes inside `.pane` are 9/10/11/12/13.33 px; **0** above 14.
   Readouts in JetBrains Mono, the new badge included).
10. Squint test — **PASS**, unchanged in character from the previous entry.
11–14. Inspector controls, memory in both places, measured/interpolated labelling, capped frame
    plan — **PASS**, all re-seen live during the cloud session: the plan reported
    `VRAM (interpolated) 18.48 GiB / 22.03 GiB` and explained the cap as
    `10 fps × 35.6s = 355 frames, over the 81-frame cap. FPS lowered to 2.28 so the frames still
    span the whole clip.`
15. Mock labelling — **PASS** (`cloud: local fixture` in the status bar when disconnected).
16–18. Focus/Escape, parameter refresh, wire select-and-delete — **N/A this pass**, untouched by
    this change and verified in the entry below.

**Fixed during the pass.**

- **The degraded warning was rendered at half opacity.** `.run-state` sits inside `.run-pick`,
  which is `disabled` for any unselectable run and styled `opacity: 0.5` — so the ▲ inherited the
  dimming, and the one row that urgently needed action had exactly half the contrast of every calm
  row beside it. Measured, not eyeballed: effective opacity 0.5 against 1.0 on all five other rows.
  The badge moved out of the button into `.run-actions`, beside the Save it is asking for. Now
  effective opacity **1.0**, contrast **8.49:1** against the pane.
- **The fix then ate the run label.** Spelling the badge out as "▲ instance only" pushed
  `.run-actions` to **224 px of a 335 px row** and collapsed the label to `de…` — the row announced
  that something was wrong while hiding which run it was. Reduced to the bare glyph, which the
  pane's own note already defines and the tooltip spells out: actions **139 px**, label back to
  **119 px**, versus ~133 px for an ordinary transient row. The mark costs ~14 px.

## 2026-08-06 — documentation refactor + three local fixes, 1280×800

Graded after the harness rewrite and the graph/temp-file fixes. Browser console clean. Two
long-standing "never verified" items were closed by measurement rather than by argument.

1. Dark surfaces — **PASS** (`body` computed `rgb(13,13,15)`; **0** white-background elements).
2. No status by hue alone — **PASS** (state glyphs render as `::before` content on `.running` /
   `.ok`; **0** elements using the old green `rgb(74,222,128)` as text colour).
3. Six panes with tabs — **PASS** (Depth 2D, Viewport 3D, Graph, Inspector, Objects, Runs).
4. Chrome density — **PASS** (tab strip 26 px measured; labels 11 px).
5. Viewport orbit, count, gizmo — **PASS**. A drag inside the canvas visibly rotated the room
   between two screenshots and the gizmo turned with it; `1,000,000 pts` reported.
6. Turbo depth with metric legend — **PASS** (legend reads `0.52 m` – `2.66 m`).
7. Live status rows — **PASS** (5 rows carrying numbers: two pane control rows, two pane status
   rows, the status bar).
8. No horizontal scroll — **PASS** (`scrollWidth === clientWidth === 1280`).
9. Type scale — **PASS** (**0** rendered elements inside `.pane` above 14 px; readouts in
   JetBrains Mono).
10. Squint test vs `reference/sentinel-scientific-organism.png` — **PASS**. Same family: warm
    graph canvas, coloured node headers, A/P badges, millisecond footers, dense inspector rows
    with red slider thumbs. Divergences remain deliberate — Sentinel uses green for `Running`
    where we use a neutral glyph, and puts values inside the slider track where we right-align
    them in mono.
11. Inspector exposes the inference parameters with mixed controls — **PASS**.
12. Memory in both places — **PASS** (`0 B / 22.03 GiB` in the inspector and the status bar).
13. Measured / interpolated / extrapolated labelling — **PASS, and the checklist was corrected.**
    At 112 frames it reads `VRAM (measured) 21.28 GiB / 22.03 GiB`; pushed to 256 frames it
    reads `VRAM (interpolated) 24.27 GiB` plus "Beyond 144 frames is extrapolated — the sweep has
    not run that high" and an expect-an-OOM warning. The old checklist demanded a *bracket*, which
    was the right rule when the predictor rested on a single datapoint. Five real rungs now exist,
    which the original rule itself named as the condition for a point value, so DESIGN.md was
    updated to describe the labelling the app actually does rather than a superseded requirement.
14. A capped frame plan explains itself — **PASS, first time graded.** Previous passes recorded
    this as N/A for want of a loaded clip. With the real 13.55 s clip: `10 fps × 13.5s = 135
    frames, over the 112-frame cap. FPS lowered to 8.27 so the frames still span the whole clip.`
    (The duration was supplied directly rather than through the file picker, which needs a native
    dialog no tool can drive; the arithmetic under test is the same.)
15. Mock and provenance labelling — **PASS** (`NVIDIA L4 (mock)` in the inspector, and both
    geometry panes carry `RECORDED RUN · Door · 504 px · 112f`).
16. Focus and Hide — **PASS**. Hiding Depth 2D dropped it from six tabs to five, the status-bar
    view bar brought it back, and Reset restored the default order. No horizontal scroll at any
    point.
17. A parameter change refreshes the graph by itself — **PASS**, and this is the session's main
    fix. Switching Run Source to the live output stranded **8 stale** nodes, exactly as reported;
    switching back returned the graph to **2 stale** with nothing else touched. Under the old
    build it stayed stranded until an unrelated slider was moved.
18. Wire selection and deletion — **PASS**, previously impossible. Clicking a wire set
    `selectedEdgeId`, cleared the node selection, and rendered the edge with
    `stroke: var(--emph-hi)` at `strokeWidth: 3` and React Flow's own `selected` class. Backspace
    took the graph from **15 wires to 14**, removed exactly `e-points`, and left all 10 nodes.

### The costly node cannot be reached by a control

Verified directly, because this is the property the execution model exists for. DA3 Depth was
badged **auto** through the inspector, then its resolution slider was dragged from 504 to 392.
The value applied and the graph refreshed, while DA3 stayed `blocked` at `0.0 ms` and the network
log shows **no `POST /infer`**. The refresh that follows an edit bars every costly node outright,
whatever the badge says.

### Rewiring by port drag — verified, after being unverifiable for five days

Previous passes recorded this as needing a human hand: the port handle is ~5 px at fit zoom and a
drag that misses pans the canvas instead, which is indistinguishable from a refusal. **No human
was needed — the technique was the blocker, exactly as it had been for orbit.** Zooming the canvas
to 1.2× puts the handles at 11 px, and hit-testing with `elementFromPoint` before dragging
confirms the start and end points land on the handles rather than on the node card behind them.

- **A real drag reconnected Point Cloud → Viewport 3D**, restoring the wire Backspace had just
  cut. Edge count 14 → 15, and Viewport 3D returned to `ok`.
- **An invalid drag was refused**: point cloud output onto a plane input left the count at 15 and
  the existing wire untouched.
- **Reconnecting an existing pair did not duplicate it** — one wire, same id.

The replace rule is pinned by unit tests rather than by drags (`src/graph/connect.test.ts`): the
rules moved into `src/graph/connect.ts` so they can be asserted without a mouse. A drag is a poor
instrument for a rule when a miss looks like a refusal.

### Worth remembering

- **The browser tool's coordinates are screenshot-space, not CSS pixels.** At 1280×800 the
  screenshot is 800×500, so CSS × 0.625. A drag aimed with un-scaled coordinates landed in the
  Inspector and selected text instead of orbiting. Convert, or read the target's rect and scale it.
- **`resize_window` with a preset does not necessarily give the preset's size** — it reported
  "desktop" and left the viewport at 800×450. Pass explicit width and height and then confirm
  with `window.innerWidth` before trusting any measurement.
- **Zooming about a pointer moves nodes out of the pane.** After zooming, re-check that both
  endpoints are inside the graph pane's own box, not merely inside the window: a handle scrolled
  out of the pane still returns a plausible-looking rectangle.

---

## 2026-08-04 — P2 pass (commit `e26aa79` + two fixes), 1280×800

Full re-grade after the P2 session (cloud control plane, run registry, per-clip targets, pane
focus/hide, neutral colour system). Layout reset to default before grading.

1. Background ≤ `#151517`, no white surfaces, no default blue — **FAIL → fixed**, see below.
1b. No status signalled by hue alone (new item) — PASS (`●` current · `◐` working · `○` idle ·
   `▲` failure, on pane status rows, control rows and node footers; green absent from the app).
2. Panes with tabs, drag-resize — PASS (6 panes in 4 groups tiling 1280×695 exactly).
3. Chrome density — PASS (tab strip 26px measured, labels 11px).
4. Cloud + orbit + count + gizmo — PASS (drag visibly rotated the room; gizmo turned with it;
   1,000,000 pts reported).
5. Turbo depth with metric legend — PASS (0.52–2.66 m).
6. Live status rows everywhere — PASS, including the new Runs pane (`3 runs · — on disk`).
7. No horizontal scroll, gaps ≤ 4px — PASS (`scrollWidth == clientWidth`; sashes 4px, group
   gaps 0).
8. Type scale — PASS (only `<script>`/`<style>`/`<title>` exceed 14px, none rendered).
9. Squint test vs `docs/reference/` — PASS. Comparable darkness and density. The deliberate
   divergence is that Sentinel uses green for `Running` and we now use a neutral `●`; our red is
   confined to slider thumbs, which is where the reference uses it too.
10. Inspector exposes inference params with mixed controls — PASS (selection-bound by design).
11. VRAM in inspector and status bar — PASS.
12. Unmeasured predictions as a labelled range — N/A, needs a loaded clip (unchanged).
13. Capped frame plan explains itself — N/A, needs a loaded clip (unchanged).
14. Mock readouts labelled — PASS (`NVIDIA L4 (mock)` in pane status and GPU Device).

### Findings, both fixed in the same session

- ⚠️ **Item 1 FAIL: five unstyled `input[type=range]`** in the Depth 2D brush/frame toolbars —
  `background-color: rgb(255,255,255)` with `accent-color: auto`, i.e. a white track and the OS
  accent (system blue on macOS) on the filled portion. Both are explicitly forbidden by item 1.
  **Pre-existing since M3b**: only `.inspector-row input[type="range"]` was ever styled, so every
  slider outside the inspector fell back to the UA control. Fixed by styling the ELEMENT rather
  than a container, so the next toolbar cannot reintroduce it; `-moz-` track/thumb rules added
  alongside the `-webkit-` ones. Verified: all five now report `rgb(42,42,46)` and the page has
  **0 white surfaces**.
- **Minor: Reset activated the wrong tab.** The right group showed *Runs* rather than Inspector,
  because Runs is added last and nothing claimed the group. `buildDefaultLayout` now sets
  Inspector active explicitly.

### Worth remembering

- A **custom Dockview tab component silently breaks click-to-activate** — it replaces the default
  tab, which is what normally calls `setActive()`. Caught in-browser when clicking Inspector did
  nothing. Check this before adding any other custom Dockview renderer.
- **Screenshots taken immediately after a reload can show a stale graph fit.** The refit is
  debounced 90 ms; a screenshot inside that window shows the pre-fit transform and looks like the
  thumbnail-in-the-corner bug. Measure `.react-flow__viewport`'s transform before concluding.

---

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

Found, and still broken on this date (both fixed on 2026-08-06 — see the entry above):
- **Edges can never be selected, so edge deletion is unreachable.** `rfEdges` never sets
  `selected` and `onEdgesChange` drops every non-`remove` change, so React Flow's selection is
  overwritten on each render and Backspace has nothing to delete. A real click was confirmed to
  land on `.react-flow__edge-interaction` with no selection resulting. Node deletion is fine
  (10 → 9 nodes, and its wire went with it).
- Rewiring by port drag remains **unverified**: handles are ~8px, and automated drags that miss
  pan the canvas instead. Needs a human hand or a zoomed-in graph.

---

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

---

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
  middleware parsed them — the seam TASK.md listed as never exercised.
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

---

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

---

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

---
