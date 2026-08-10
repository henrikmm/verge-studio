# Registry — what exists and why

The record of this project: what works, what was decided, where the proof is, and what is still
unknown. Everything here has been observed, not merely written.

There are no tasks in this file. Work still to be done lives in `TASK.md`.

---

## 1. What the system does today

Drop a video into the app and the following happens, all of it verified in a browser:

1. **The clip is read locally.** Frames are extracted by ffmpeg on this Mac, sampled evenly
   across the whole clip at a chosen rate, and shrunk to 1024 pixels on their long edge.
2. **The frames are sent to a GPU service** — and only when the user presses Run. This is the one
   paid step. The service runs Depth Anything 3, which returns a depth value for every pixel of
   every frame, plus where the camera was for each one.
3. **The results come back as a 3D scene** the user can orbit, alongside a colour-coded depth
   image per frame.
4. **A ground plane is fitted** to the scene, and its quality is reported rather than assumed.
5. **The user marks an object** — by painting on a frame, or by clicking once and letting a
   segmentation model propose the shape — and the app measures its height, states an uncertainty,
   and grades it against a tape measurement if one has been recorded.

Around that spine:

- **Runs are temporary until saved.** A finished run is selectable immediately but nothing large
  is written to disk until the user presses Save, which copies it to `~/verge-runs`, outside the
  repository. Runs can be deleted from the same pane.
- **Results outlive the machine that produced them.** Artifacts go to a private bucket and reach
  the browser through signed links that expire in twelve hours, so deleting the service destroys
  nothing and the browser never touches the instance to read a result. The objects themselves are
  deleted after three days by a rule GCS enforces. Saving is still the only way to keep a run.
- **The fitted floor can be looked at, on demand.** Viewport 3D carries a LAYERS row of five
  independent switches, **all off by default and Advanced-only**, so the cloud is seen unaltered
  until the floor is asked for. Turning them on is how a fit gets checked by eye, which catches
  what the numbers
  cannot: support, tilt and RMSE all say how well the plane fits the points it chose, and none of
  them says whether it chose the right points. A visibly wrong floor once hid behind a 2 cm fit
  error. Every layer is geometry in the scene, not marks on the glass — confirmed by orbiting and
  watching them turn with it.
  - **Floor grid** — the fitted ground as a metric grid on a faint fill, clipped to the evidence
    supporting it, its square size named in the readout. A grid rather than a plain disc because
    straight lines converge in perspective and a flat wash does not, and perspective is the cue a
    person judges *level* by. Squares of a known size make it a ruler for the scene's scale too.
  - **Floor points** — the cloud points the plane rests on, so its evidence has a location.
  - **Up axes** — the floor's own normal and the camera-derived vertical, same origin and same
    length, so the tilt the readout states in degrees is also a shape on screen.
  - **Below plane** — every point more than 5 cm under the floor, the same test the reported
    percentage uses. This is decision 3 drawn directly, and it is the sharpest instrument here:
    a fit reporting a respectable 6.2% support and 5.7 cm RMSE was exposed as junk in one glance
    by the amber mass floating mid-room. (`app/src/panes/floor-overlay.ts`, 13 tests — grid
    vertices land on the plane for tilted floors as well as level ones, the grid is clipped to
    its circle, an origin off the plane is dropped onto it, and below-ness is measured along the
    normal rather than world down.)
- **The measurement is the headline; the fit diagnostics are behind the mode switch.** Viewport
  3D's reserved result strip states the target, the reading, the tape truth, the error in
  centimetres and the error as a percentage — measured 2026-08-09 on the door fixture as
  `B1 Door leaf · VERTICAL EXTENT 1.526 m · tape 2.100 m · error −57.4 cm · off by −27.3%`,
  agreeing digit for digit with the Objects pane. It is a row of chrome, never a layer over the
  canvas, so it cannot sit in front of the thing being measured. With no tape truth it says so and
  quotes no error; over a failed or stale ground fit it refuses instead of quoting a number
  (`app/src/panes/result-strip.ts`, 9 tests).
- **The floor readout leads with the number that decides the question**, in Advanced:
  `FLOOR 14.6% SUPPORT · 0.0% BELOW · 11.8° TILT · 1.2 cm RMSE`, then the camera-up coherence that
  qualifies the tilt. `belowFraction` had been computed on every fit since the ground rule was
  written and displayed in no pane at all — it reached the export file and nothing else.
- **The viewport says which of three things is true about the floor**: a current fit and its
  numbers, `◐ FLOOR STALE` for a held fit whose inputs have moved, or `▲ NO FLOOR` carrying the
  fit's own refusal message. All three used to render identically — as an unchanged viewport — so
  a refusal was indistinguishable from success. A stale plane is reported but deliberately not
  drawn, because held evidence must never read as a current measurement.
  (`app/src/panes/floor-state.ts`, 7 tests covering all four states.)
- **You can walk through the cloud with the keyboard.** W A S D move, E and Q rise and fall, the
  arrow keys look, Shift is four times faster and Alt a fifth, and F frames everything again when
  you are lost. The keys move the whole rig — camera and orbit pivot together — so dragging still
  orbits exactly as before, now around whatever you walked up to. Walk keeps W level with the
  ground; a Fly chip follows the view instead. Keys act while the pointer is over the pane, never
  while typing in a field. Motion is per second of real elapsed time, clamped to 100 ms a frame so
  a backgrounded tab cannot resume by teleporting.
  - **Which way is up is measured, not assumed** — the fitted floor's normal, else the vertical
    from the camera path, else the scene's +Y with the readout saying `UNMEASURED`. This is not a
    nicety: DA3's scene is aligned to the *first camera*, so its +Y sits 33.2° from true up on the
    room fixture, and walking along it would climb a third of a right angle while the horizon
    looked level. (`app/src/panes/viewport-nav.ts`, 27 tests.)
- **The scene can turn by itself.** A third VIEW mode, **Cinematic**, orbits the cloud's centre at
  6°/s — a minute to the revolution — riding 18° above the fitted ground with a slow ±8% dolly. A
  still point cloud reads as speckle; what makes it read as a place is parallax, and parallax needs
  motion. Two properties are held by test rather than by eye: a full turn returns to its starting
  pose exactly, because the dolly is a function of the orbit angle and not of a second clock, and
  the elevation is raised as far as it takes to keep the camera above the fitted plane — the centre
  of a bounding box is halfway up the room, and in a bad reconstruction it can sit under the floor.
  A drag, the wheel or A/D/W/S steers the shot; the turn holds for 1.2 s afterwards and then eases
  back over 0.9 s. (`app/src/panes/cinematic.ts`, 13 tests.)
- **The viewport can stand where the camera stood.** A VIEW row switches between **Free** — the
  orbit camera, as before — and **Fixed**, which places the viewer at the recording camera's
  position, orientation and field of view for whichever frame the slider is on. You can turn to
  look around, but not walk: translating would destroy the mode's only claim. Depth 2D and
  Viewport 3D therefore show the same viewpoint at the same index, which turns this pane from
  something you orbit into something you can check.
  - **The video can be ghosted over it**, off by default, with an opacity control and a border
    marking exactly where the recorded frame ends — the pane is never the shape of the clip, so
    the fitted field of view contains the frame rather than cropping it. Bear in mind the cloud
    was reconstructed from these same frames, so agreement is partly guaranteed by construction;
    what the comparison catches is drift, scale error and collapsed geometry.
  - **Camera path** joins the LAYERS row: the route walked, with the current frame marked and
    aimed, drawn through the cloud so it stays visible when the camera is behind something.
- **The app shows as much of itself as you ask for.** A `Standard | Advanced` switch in the status
  bar, remembered across reloads, default Standard. Measured 2026-08-09 at 1280×800: Viewport 3D
  goes from 6 control rows and 19 buttons to **2 rows and 4 buttons** — Free, Fixed, Cinematic and
  Cameras — with zero overlay elements inside the canvas; Objects drops the uncertainty budget, the
  trial ledger, the error model and the resolution table. Advanced restores every one of them.
  Three rules hold it together and all three are graded (DESIGN.md items 20–22):
  - **Advanced is a strict superset.** Nothing exists only in Standard.
  - **Standard never strands an effect.** Entering it clears Viewport 3D's layer set rather than
    hiding the chips — verified by turning Below plane on, switching to Standard and back, and
    finding it off. Hiding the switch for something still being drawn would be a state with no way
    out.
  - **A warning is not an explanation and is never hidden by the mode.** The capped frame plan, the
    extrapolated VRAM figure, the mock badge and the idle-billing meter render in both.
- **An explanation costs one glyph.** Feature prose moved out of the pane bodies into a `?` that
  opens instantly on hover *and* on keyboard focus, closes on Escape, is linked by
  `aria-describedby`, and is portalled to the document so no pane's hidden overflow can clip it —
  measured staying fully inside the window with its pane squeezed to 180 px. The native `title`
  tooltip stays for short chip labels; it is the wrong tool for a paragraph, most of all because it
  never appears for a keyboard. (`app/src/panes/help.tsx`.)
- **A clip is loaded from the Inspector, and the Graph is closed by default.** The Graph took 38%
  of the window, filtered the Frame Source card out of its own default view, and was nonetheless
  the only way to load a video. The Inspector's **Clip** section is the front door now — drop or
  browse, see the frame plan and the VRAM it will need, then press Run — and Depth 2D and Viewport
  3D get the height back. Both entry points write `frame-source` through `lib/load-clip.ts`, so the
  node card still works and the two cannot disagree. One click on the view bar reopens the Graph
  with its wiring intact.
- **Measurement starts in Free mode.** The frame slider, brush, eraser, clear action and both
  extent definitions work without choosing an object. Free masks are deliberately absent from
  browser persistence and evidence exports. Choosing a named row in Objects enters Object mode;
  that is the only place Record exists.
- **Measurement targets belong to a clip**, keyed by the video's content digest. A clip nobody has
  measured before starts with an empty set, never another clip's objects.
- **Repeat measurements accumulate on disk.** Record freezes the frame, mask, confidence cut,
  rejected-pixel counts, selected-point count, fitted plane, ruler and reading into one atomic
  packet beside the saved run. Its identity includes the sitting, capture time and mask digest;
  the human label `trial #1` is not unique across browser sessions. `inspect measurements <run>`
  lists them, and `inspect measurement <run> <trial-or-mask-digest>` replays one packet and writes
  its 2D mask and 3D selection/ruler images. A newly recorded door trial replayed to **0.000 mm**,
  with **775 of 775** points projecting back inside the brush by one pixel. The older door packet
  displaced while reproducing the former trial-number collision returned from the original Safari
  profile after one reload. Its recovered identity is
  `door-leaf:door-504px-112f#1@sitting-msmd3iex-i6wswj@2026-08-09T22:20:07.102Z@987957e9e0732a02`.
  The inspector replayed its stored **2.021077 m** to **0.000 mm**, and all **561 of 561** usable
  points returned inside the recorded mask within one pixel. Recovery therefore depends on neither
  the display trial number nor one still-open page.
- **The whole app runs offline.** The dev server answers the inference request from a stored
  fixture, so the interface can be built and reviewed at zero cost. Anything produced that way is
  labelled as a mock on screen.
- **Scratch data ages out by itself.** Dropped videos and extracted frames are copied under the
  OS temp directory and were never cleaned up. They are now swept at dev-server startup and before
  each upload or extraction: only the two exact directories, only their immediate children, only
  entries older than a day, and never through a symbolic link. Anything that cannot be removed is
  reported and skipped. (`app/vite-plugins/temp-store.mjs`, 12 tests.)
- **Cloud state is visible before money is spent.** The Inspector reports whether gcloud is
  signed in, whether the service exists, and whether the next deploy is the quick path or the
  twenty-minute one. Deploy and Delete service both run from the app and stream their logs.
- **A reconstruction can be read without opening the app.** `scripts/inspect.mjs` reports a run's
  sampling and cost, its cloud, and its ground fit, and draws that cloud — in its own colours, by
  height above the fitted floor, by plane inlier, or with a selection picked out — from any of five
  fixed viewpoints. It also draws the source frames as one numbered sheet, one frame's depth, and,
  the check no number can stand in for, **a selection painted onto the photograph it came from**.
  No browser, no WebGL, no network. (Eleven commands, 22 tests, `scripts/inspect/`.)
- **The flat surfaces of a scene can be measured with no mask at all.** `inspect levels` reports
  every horizontal surface as a height above the fitted floor, with how thick and how wide it is.
  It is the project's only measurement that does not pass through an operator's brush, and its
  thickness column is its only reading of whether the floor is level with the room. See section 3.
- **What never reached the cloud can be seen on the photograph it came from.** `inspect coverage`
  reproduces DA3's export filter, paints the pixels it discarded and the pixels genuinely absent
  from the exported cloud onto the source frame, and reports per-frame survival. `--cloud npz`
  rebuilds the cloud from the depth maps with no confidence floor, at the exported cloud's own
  point count, so any command can be run on both and compared. `floor --repeat n` refits with
  nothing changed but the RANSAC seed and reports the spread. All three answer questions this
  project had been guessing at; see section 3.

### Verified end to end on real hardware

On 2026-08-05 a clip that had never been through the pipeline (`da3Test.mp4`, 1920×1080, 13.55 s)
was deployed, run, displayed, saved and torn down entirely from the app: 112 frames at 8.27 fps,
36.9 seconds of GPU time, a 102 MiB result file fetched in five chunks and verified by checksum,
128 MB brought home to `~/verge-runs`, service deleted afterwards.

On 2026-08-06 the same path ran again with results in cloud storage rather than on the instance
(`test-demo-door.mp4`, 35.57 s, 81 frames at 504 px, 28.21 s of GPU time). The browser fetched
`scene.glb` and a **76.3 MB npz in one request each, straight from the bucket** — no ranged chunks,
because the 32 MiB cap belongs to Cloud Run and not to storage. Save brought 91.4 MB home through
`gs://` at 34.5 MiB/s, a page reload re-opened it with the cloud disconnected, and teardown left
no service and exactly one image. Whole session: **25 minutes of instance lifetime.**

---

## 2. How it is put together

| Area | Where | What it holds |
|---|---|---|
| Interface | `app/src/panes/` | One file per dockable pane: 3D viewport, depth image, graph, inspector, objects, runs |
| Node graph | `app/src/graph/` | The engine, the store, and one file per node type in `nodes/` |
| Dev server | `app/vite-plugins/` | Local file routes, the offline mock, the run registry, cloud control, the job runner |
| Geometry | `geometry/` | Only what the model does not provide: gravity, ground plane, back-projection, measurement, uncertainty, calibration |
| Service | `server/` | The FastAPI wrapper around the model, and its Docker image |
| Scripts | `scripts/` | Deploy, teardown, frame extraction, run download, verification, run inspection |
| Instructions | `AGENTS.md`, `.agents/skills/` | Shared, tool-neutral working rules and workflows |

**The documentation is checked mechanically**, by `scripts/check-docs.mjs` inside `verify.sh`:
unfinished work may only appear in the task list, each task must answer all five of its required
questions with a recognised gate, relative links must resolve, the Claude instructions must import
the shared ones, and four files have line and byte budgets. The task list reached 1,635 lines once
because finished work was never removed; the budgets are what stop that happening again.

**The inspector cannot drift from the app, by construction.** `scripts/inspect/bridge.ts` is a
list of re-exports and nothing else; esbuild compiles it in memory on every run (~40 ms, no build
artefact to go stale). No geometry is written inside the inspector, so a change to `geometry/`
reaches it at once and a picture that disagrees with the pane beside it is not possible. Its
images are drawn into a flat RGB buffer and encoded by ffmpeg, which this project already requires
— no GPU, no headless browser, no new dependency, and identical bytes for identical input, which
is what makes two renders of one cloud worth comparing. The projection that puts a selected point
on a photograph is tested as a **round trip against `backprojectMask`**, because a camera
convention that had drifted would draw a wrong picture that looked entirely plausible.

**The graph is content-addressed.** Every node computes a key from its parameters and its
inputs' keys. Changing something restamps that node and everything downstream of it, and nothing
else — so adjusting a display setting never invalidates an expensive reconstruction.
(`app/src/graph/evaluate.ts`, `cache-key.ts`; 21 tests in `evaluate.test.ts`.)

**Free nodes run by themselves; costly ones never do.** The depth node is marked manual and goes
stale rather than running, so no amount of moving controls can start a paid run. The badge on a
node card overrides this in either direction when the user asks for it, but the automatic refresh
that follows a control edit bars costly nodes outright regardless of the badge — the Inspector is
where the sampling controls live, so that pass must not be a route to the GPU. Verified in the
browser on 2026-08-06 by badging the depth node auto and dragging its resolution slider: the value
applied, the graph refreshed, the node stayed blocked at 0 ms and no inference request was sent.
(`graph-store.ts` `runAutoFree`, `evaluate.ts` `deny`.)

**Editing a control brings the graph back up to date on its own**, after a short delay that folds
a slider drag into one pass. Before this, changing a value only marked work as out of date and
left it there: switching the run source stranded eight nodes with no visible way forward, and the
panes went on showing the previous scene. (`graph-store.ts` `setNodeParamAndRun`.)

**Wires can be selected and cut.** Clicking a wire highlights it and Backspace removes that one
wire. React Flow is fully controlled here, so it cannot hold a selection of its own — carrying the
selected flag on the edge is what makes deletion reachable at all. Node and wire selection are
mutually exclusive so Backspace always has one meaning. The connection rules — types must match,
and an input takes one wire so connecting replaces rather than stacks — live in
`app/src/graph/connect.ts` with 12 tests, and were driven by real mouse drags on 2026-08-06.

**Panes are tapped off wires, not driven by them.** A viewport reads whatever arrives on its
input port; it computes nothing. Objects are rows in a pane rather than nodes in the graph,
because hundreds of measurement cells would turn the canvas into confetti.

---

## 3. Measured facts — do not re-derive these

### The GPU's memory ceiling

The L4 card reports **22.03 GiB usable** (23,659,151,360 bytes), not the advertised 24 — that
figure is decimal and some is reserved. The model occupies 6.57 GiB once loaded. A cold start
takes about 64 seconds, of which 40 is loading the model.

Memory grows with the number of frames and the processing resolution, not with the length of the
clip. Measured on 2026-08-01, each run isolated (`docs/vram-measurements.json`):

| Frames | 504 px (driver / allocator) | 356 px | 252 px |
|---|---|---|---|
| 32 | 14.24 / 11.63 GiB · 12.2 s | | |
| 64 | 16.94 / 13.87 GiB · 15.2 s | | |
| 112 | 21.28 / 17.23 GiB · 30.2 s | | |
| 128 | 21.94 / 18.35 GiB · 37.7 s | | |
| 144 | 21.88 / 19.47 GiB · 42.1 s | | |
| 160 | **out of memory** | | |
| 192 | **out of memory** | 19.39 / 15.01 GiB · 24.6 s | |
| 256 | **out of memory** | 21.54 / 17.51 GiB · 35.2 s | 15.89 / 12.69 GiB · 16.1 s |

The allocator figure is the honest signal and fits **0.0700 GiB per frame plus 9.39 GiB**. The
driver figure flattens near the top because it saturates against the device limit — 144 frames
reads *lower* than 128, which is a plateau with scatter, not a curve.

**The frame limit is 112, not 144, deliberately.** Both 128 and 144 finished at roughly 99% of
the device, which is a coin flip rather than an operating point. 112 leaves about 15% headroom.

**Ten frames per second is reachable, just not at full resolution.** Resolution buys frames as its
square: 256 frames run comfortably at 252 px and fit at 356 px.

**Orientation is free. Measured, not assumed.** Two runs at 81 frames and 504 px — one landscape
(504×280) and one portrait (280×504), different clips, different content, different GPU seconds —
returned **byte-identical** peaks: 20,489,175,040 driver and 16,165,363,712 allocator. Same pixels
per frame (141,120), same memory. A transposed tensor reserves the same blocks, so "landscape costs
more" is not a mechanism. (`~/verge-runs/20260805-151526-a99a78` and `.../20260806-173802-d354a2`.)

That 81-frame run is also the ladder's cleanest confirmation: the fit predicts
0.0700 × 81 + 9.39 = **15.06 GiB** allocator and both runs measured **15.055 GiB**.

⚠️ **The 112-frame landscape excess is still unexplained, and only one suspect is left.**
A 1920×1080 clip measured **22.02 GiB at 112 frames and 504 px on 2026-08-05, 0.74 GiB above the
table and 99.96% of the device.**

Pixel count was the leading candidate — `upper_bound_resize` fixes only the long edge, so aspect
ratio moves the short one. **It is dead, established 2026-08-08 at no cost.** That run was
`da3Test.mp4`, 1920×1080 with no rotation, which at 504 px is 504×280 = **141,120 pixels per
frame** — identical to the portrait door clip's 280×504. Better still, the 81-frame run of *that
very clip* (`~/verge-runs/20260805-151526-a99a78`) returned peaks byte-identical to the door
clip's. Same clip, same pixels, same memory at 81 frames; the 0.74 GiB appears only at 112.

What remains is the **driver figure's own behaviour near the ceiling**, which this table already
shows (144 frames reads lower than 128). The allocator peak is the one that models cleanly, and it
was never recorded for that run — which is the measurement task 6 still needs. Until then,
**81 frames at 504 px** remains the verified conservative setting near the top of the range.

⚠️ **Coded dimensions are not the shape the model sees.** `test-demo-door.mp4` is coded 1920×1080
with `rotation=-90` in its side data, so it displays — and extracts — as 1080×1920 portrait. ffprobe's
`stream=width,height` reports the coded pair and reads as landscape. Anything characterising frame
shape must read the rotation metadata, or it will label its own clips wrongly. Found 2026-08-06,
after this run was planned as a landscape test and turned out to be a portrait one.

### The tilt gate bounds the tilt it reports

Fixed 2026-08-08. `maxTiltDeg` used to gate the RANSAC *candidate* and then let least-squares
refinement rotate the winner freely, with nothing re-checking the result: set to **10°**, the door
fixture returned a plane reported at **11.3°**.

Refinement is now declined when it would carry the plane out of the gate, and the last plane that
satisfied it is kept. Refusing the refinement rather than the whole fit is the point — refinement
is an improvement step, not the evidence, so no floor accepted before this change is rejected by
it. The result carries `tiltClamped`, and both the viewport (`(GATED)` beside the tilt) and
`inspect floor` say when it fired, because a silently unrefined plane is its own kind of lie.
The same gate at 10° now returns 9.93°. A sweep over 8/10/12/15/20/30° is in
`geometry/door-fixture.test.ts`; one value passing is how the original defect survived.

The seeded fit (`fitPlaneFromSeeds`) reports `tiltClamped: false` and is not gated — the operator
picked those three points, and a limit meant for random candidates would defeat that path.

### Every pane control row wraps

Fixed 2026-08-08. `.output-row`, `.pane-controls`, `.brush-toolbar`, `.frame-toolbar` and
`.segment-toolbar` were `nowrap` with hidden overflow, which clips silently rather than scrolling.
Measured at a 180 px pane before the change: Depth 2D put its `Confidence` chip and the whole mask
hint outside the pane, and both `.pane-controls` rows put `Focus`, `Hide` and `Pause` outside it —
five controls that could not be clicked.

It was not only a narrow-pane problem. **At the default 1280×800 layout** three of Depth 2D's rows
needed more width than they had — 593, 570 and 599 px in a 500 px pane — so those controls were
already outside the pane at the width the acceptance checklist grades at. Nothing caught it,
because a clipped pane produces no window scrollbar and checklist item 8 kept passing.

Wrapping is now the default rather than something each row opts into: the `wrap` prop and the
`layer-row` class that carried it are gone, because the two rows that most needed them had not
taken them. A labelled slider may also shrink below its caption width, or it overflows its own
line whatever the row does. Verified at 183 px by dragging: zero escaped children across all eight
rows, on both axes. One limit remains, on the other axis — a pane squeezed to ~74 px TALL cuts the
stacked rows off at its bottom edge, which needs a scrolling control stack rather than wrapping.

### The 2D frame fits its pane, and the window splits 40/40/20

Fixed 2026-08-09. Depth 2D sized its frame by height alone — `height: zoom * 100%` plus an
`aspect-ratio` — so the width fell out of the shape of the image and a landscape frame ran off the
side. Measured on the outdoor run `20260806-193346-26d16e`: a 1024×576 frame drew **835 px wide in
a 427 px stage**, leaving 51% of the image scrollable but invisible with nothing on screen saying
so. The door fixture never showed it, because 576×1024 fits a tall narrow pane by height. That is
the whole reason it survived this long: **the one fixture in daily use was the one shape that
already worked.**

Zoom 1 now means the whole frame, whatever its shape, and every zoom above it scales that fit, so
the slider is the only thing that produces a scrollbar. The fit is computed in `frameSize`
(`app/src/panes/depth-2d.tsx`) from a `ResizeObserver` on the scroller's **border** box, floored.
Both details are load-bearing:

- The border box does not change when a scrollbar appears. Watching the content box feeds the
  scrollbar back into the fit — it appears, takes 15 px, the frame shrinks to fit, the scrollbar
  goes, the frame grows. Verified stable by sampling zoom 1.25 and 2.25 six times over 1.5 s each,
  the case where the frame overflows one axis only.
- Flooring matters because the stage is 505.33 px tall on the door fixture, and a frame fitted to
  the third of a pixel the client box rounds away is a scrollbar on an image that fits.

The stage stopped being the scroll container in the same change. `.depth-scroll` scrolls inside it,
so the legend and the mask readout overlay the image instead of being laid out beside it — as flex
items of the scroller they added their own width to the row, and the frame ended up pushed 5 px
right of centre by a scrollbar it had caused itself. The `margin-left: -150px` on `.mask-readout`
that used to hide that contribution is gone.

**The window is 40% Depth 2D, 40% Viewport 3D, 20% Inspector.** The two panes you look at are
equals; the panel you read gets what is left. What the code asked for before was a 300 px
Inspector, and it never got it: the layout was built before Dockview knew how wide it was, the
sizes went to disk as `size: 100` each against a container of width 0, and they were restored as
three equal thirds. So `applyDefaultSplit` runs off `api.width` — the grid's own width, not the
host element's, which CSS fills in immediately and misleadingly — and `relayout()` is called before
the default layout is built. Two consequences worth knowing:

- **`setSize` takes from the columns to its right, not from everybody.** Sizing the Inspector first
  got it 13.4% of 1280 px, because Depth 2D was set afterwards and helped itself to 85 of its
  pixels. The two viewers are set first, in order, and the Inspector is the remainder.
- The share is a share, not a size. At 1280 px it is 256 px, too narrow for the Inspector group's
  three tabs — Runs sits behind an overflow chevron. TASK 6 carries the minimum width.

### Inference settings, and why each one

| Setting | Value | Reason |
|---|---|---|
| Frame sampling rate | 10 per second | The model's own public demo defaults to this |
| Frame limit | 112 | Measured above; never remove it |
| Processing resolution | 504 | The default in the model's API, command line and demo alike |
| Resize method | upper bound | The demo's own default |
| Reference view | middle | The model's documentation recommends this for video, where frames are in time order |
| Gaussian splats | off | Nothing in this project consumes them — see decision 7 |

When the requested rate would exceed the frame limit, the app lowers the effective rate, shows
the arithmetic and says so. It never silently shortens the clip.

### The recorded camera can be put back in the scene, exactly

Measured 2026-08-07. The poses in the result file are **not** in the coordinates of the cloud on
screen: DA3 exports its GLB into a display frame aligned to the first camera and records the
transform between the two as `scene.extras.hf_alignment`, which the app already reads as
`worldFromDa3`. Cross the boundary and the camera lands where it really was; skip it and the
camera lands somewhere entirely plausible and wrong.

There are two independent routes to the answer, so they can be compared. Route A computes the
camera centre from the extrinsics (`-Rᵀt`) and applies the alignment. Route B reads the camera
frustums DA3 draws into the GLB itself, which are already in display space — one per frame, in
frame order.

| Dataset | Frames | Position | Direction |
|---|---|---|---|
| `door/504px-112f` | 112 | 0.001 mm | 0.16° |
| `room/504px-112f` | 112 | 0.001 mm | 0.16° |
| `door/356px-256f` | 256 | 0.000 mm | 0.27° |
| saved run `20260806-193346` | 99 | 0.004 mm | 0.10° |

The alignment is **rigid** — its columns are unit length and mutually perpendicular to eight
decimal places — so metres stay metres across the boundary and a camera height read off the fitted
floor is a real height. The door fixture's frame-1 camera sits **1.54 m** above its floor and
frame-185's **1.39 m**, which is a person lowering a phone.

That comparison runs at load time, not only in the test suite. `worldFromDa3` falls back to the
identity for a GLB carrying no alignment — harmless everywhere else, silently catastrophic here —
so Fixed refuses and says why when the two routes disagree, and distinguishes a wrong transform
from a wrong frame ORDER, which would place the viewer at a real camera pose belonging to a
different moment and look entirely reasonable. (`app/src/panes/camera-track.ts`, 32 tests,
including the table above run against the door fixture.)

Two further numbers shape how the fixed view behaves. Intrinsics **drift frame to frame** as DA3
re-estimates them (fy 253.5 → 257.6 across the door's 112 frames), so the field of view is read per
frame rather than pinned once. And consecutive frames are a median 5–31 cm and 0.7–3.7° apart, up
to 14° at worst, so scrubbing eases over 150 ms instead of cutting.

### How nearly the ground fit chose differently

`fitGroundPlaneRobust` has always returned every hypothesis it scored, and nothing has ever
compared them. Measured 2026-08-07 with `scripts/inspect.mjs floor`, which now does the
subtraction. **Separation** is the quality gap divided by the two scores' combined size, so 0 is a
dead heat and 1 is no contest; it is defined that way rather than as a percentage of the winner
because `groundPlaneQuality` is a penalty and its scores are usually negative.

| Case | Support | Tilt | Below | Separation |
|---|---|---|---|---|
| `door-504px-112f`, the app's own defaults | 14.6% | 11.8° | 0.0% | **0.417** |
| `door-504px-112f` at `inlier 0.1, tilt 45, stride 32, iterations 250` | 6.2% | 18.0° | 6.6% | **0.218** |
| Saved run `20260806-173802-d354a2`, the app's own defaults | 3.1% | 4.9° | 1.1% | **0.200** |
| `room-504px-112f`, the app's own defaults | 2.4% | 19.3° | 7.7% | **0.059** |

Four cases are not a threshold and must not be quoted as one. What they show is that every thin
fit is also a narrow win, and that 0.42 against 0.06 is not a subtle difference.

⚠️ **That table is superseded, and separation now means the OPPOSITE of what it meant there.**
Every figure in it is one seed's answer, from before the selection rule was fixed — the outdoor
run's separation ranged 0.006 to 0.328 across eight seeds. Since 2026-08-08 both proposal pools
find the same plane, so a good fit reads separation ≈ 0.000. A dead heat used to mean "a coin flip
between two different floors"; it now means "two searches agreed". Anything reaching for a refusal
threshold must not use it — see TASK.md task 2.

`room-504px-112f`, the worst row, is fixed: 6.1% support, 8.5° tilt, 0.00% below, on all eight
seeds. It had been a committed fixture that passed as `ok` while being the worst fit on this disk
on every measure.

### The cloud the app measures is 7% of the reconstruction, and not a random 7%

Measured 2026-08-08 with `scripts/inspect.mjs coverage`, on this disk, for nothing.

Every run's point cloud holds **exactly 1,000,000 points**. That number is DA3's, not ours:
`export_to_glb` takes `num_max_points: int = 1_000_000` and, when the survivors exceed it, keeps
that many by `np.random.choice` without replacement. A uniform random thinning cannot remove a
region, and nothing in this project caps anything.

**The line before it is the one that matters.** The exporter first applies a confidence floor of
`min(max(1.05, p40), p90)` — percentiles taken over the WHOLE prediction at once, every frame
together. The base 1.05 never binds in practice, so the rule reduces to *discard the least
confident 40% of every pixel in the run*, and a single global threshold meets frames whose
confidence distributions are nothing like each other:

| Run | Threshold | Pixels kept | Frames below 2% survival |
|---|---|---|---|
| `20260806-193346` outdoor, 99 frames | 6.882 | 60.0%, then 11.9% of those | **5** — frames 23, 25, 96, 97, 98 |
| `door-504px-112f` indoor, 112 frames | 3.687 | 60.0%, then 10.5% of those | **3** — frames 70, 71, 72 |

So it does not thin each frame a little. It deletes whichever frames the model was least sure
about, entirely, and the outdoor run's losses are concentrated at the END of the walk — the plan
view shows the camera track continuing for metres past where the cloud stops.

**The mechanism is confirmed, not inferred.** Back-projecting a frame's own pixels and testing
each against an 8 cm voxel of the exported cloud: on frame 85 of the outdoor run, 18.3% of the
frame lands in an empty voxel, and **100.0% of that is explained by the confidence floor**. Same
figure on the door fixture, a completely different scene. The cap is exonerated; the floor is the
whole story.

Two consequences worth keeping. Roughly 40% of a frame can be missing while the picture still
looks fully reconstructed, because neighbouring frames fill most of it in — 46.0% of frame 85 is
below the floor but only 18.3% is actually absent. And the fix costs no cloud money: the npz on
disk holds full-resolution depth and confidence for every frame, so a cloud can be rebuilt here.
`inspect --cloud npz` does exactly that, and reproduces the GLB's own fit to 0.3 mm on the door
fixture when given DA3's own threshold — which is what makes the comparison trustworthy.

### We build our own cloud now, and it changed less than expected — 2026-08-08

`geometry/cloud.ts` back-projects every frame from the npz and takes the confidence floor **per
frame**, using DA3's own formula `min(max(1.05, p40), p90)` where the numbers are comparable.
`inspect --cloud npz` and the app's Point Cloud node both use it. On the door fixture the leanest
frame's contribution goes from **0.8% to 57.4%** of its usable pixels, and the three wiped frames
come back. That is the Gate met.

**The cloud's geometry did not move.** Graded against ONE fixed floor, the maskless tabletop reads
699.4 mm on DA3's export, 699.2 on our reproduction of it, 699.5 with the per-frame floor, and
699.4 keeping every pixel — a 0.3 mm spread over clouds differing by 8.5 million points. Building
our own cloud is not a measurement change.

**What does move is the floor fit**, and that is a different question. Refitting on the fuller
cloud takes support from 14.6% to 12.5%, tilt from 11.85° to 11.72°, RMSE from 1.23 to 1.51 cm,
and the end-to-end graded tabletop from −5.06 to −5.41 cm. There is no ground truth for a floor,
so "different" is the strongest honest word. RMSE rising is expected when harder pixels are kept
and is not evidence the plane is wrong.

**This is why the gate grades over a fixed plane.** Grading each cloud against its own refit
conflates the two and answers the wrong one: it reported a 2–4 mm regression that was entirely
the plane moving. The gate's own noise is 0.1–1.7 mm, measured by varying only the RANSAC seed
(8 seeds) and only the cap seed (5 seeds), so it can resolve the difference it is asked to judge.
(`geometry/cloud-gate.test.ts`.)

**Three things measured and deliberately not adopted.** Confidence as a plane-fit weight — the
`weights` parameter that had never been fed — moves the fitted tilt by 0.05° and the graded
tabletop by 0.9 mm, in the wrong direction and inside the noise. It is implemented (`WeightRule`,
by within-frame percentile rank, because raw confidence is unbounded and means nothing across
frames) and defaults to off. Voxel downsampling at 1–2 cm makes the fit's sampling uniform in
space rather than in pixels, but destroys what `horizontalLevels` measures: the tabletop reads
−6.31 cm and the tower peak disappears. Off. And the discontinuity filter does **not** explain the
floor's movement — the hypothesis that DA3's pooled floor was incidentally removing flying pixels
was tested across `maxRelativeDepthStep` 0.02–0.08 and moved the tabletop non-monotonically by
under 2 mm. It stays on at 0.08 to match the measurement path, not because it rescued anything.

**A prediction from upstream that our data contradicts.** DA3 fills sky pixels with a constant
depth inside the model, before any export. If it had run on our clips, thousands of pixels per
frame would share one exact value. They do not: the most-repeated depth covers under 1% of pixels
in every frame of both the door fixture and the outdoor run, with ~140,000 distinct values among
141,120 pixels. `maxDepthM` exists as housekeeping, not as a rescue.

### The holes were our confidence cut, not missing DA3 depth — fixed 2026-08-08

The first repair changed DA3's pooled confidence floor into one floor per frame. That stopped
whole frames disappearing, but it kept the exporter's other decision: discard the least confident
40% of **each** frame. The 1M/3M/6M point budget ran afterwards. A larger budget could only keep
more of the remaining 60%; it could never restore the coherent region already deleted. This is
why 3M and 6M looked nearly identical in the reported outdoor frames.

DA3 did return depth for those regions. The saved depth arrays are finite at every pixel in UI
frames 1 and 96, and the missing pixels are overwhelmingly on the low side of that frame's
confidence rank. Confidence says the prediction is less trustworthy; it does not say there was
no prediction. This rules out missing DA3 inference as the cause of these black regions. It does
not prove that the newly visible geometry is accurate.

The coverage harness makes the distinction numerical. It compares each source-frame pixel with
the rebuilt cloud in 8 cm cells. On saved run `20260806-193346-26d16e`, at a 6M budget:

| UI frame | Per-frame 40% cut: empty cells | Every finite, non-edge point: empty cells |
|---|---:|---:|
| 1 | 22.50% | **0.66%** |
| 96 | 28.44% | **3.04%** |

The right column is the shipped display rule. The run contains 13,821,004 finite, non-edge
candidates, and the 6M cloud keeps 43.4% of them uniformly. The remaining 0.66–3.04% is therefore
the point budget plus the deliberate depth-edge check, not a confidence-shaped hole. Reproduce
the two figures with `inspect coverage 20260806-193346-26d16e --cloud npz --keep-all --points
6000000 --frame 0 --json` and the same command with `--frame 95`.

The visual check agrees. In the 1280×800 browser harness, Fixed frame 1 contains the walkway and
right-hand foliage that were black in the report. The harness render for frame 96 leaves only
sparse marks around depth boundaries and the far top edge; the large missing far region is gone.
The generated evidence is `coverage-0000.png` and `coverage-0095.png` under `.inspect/`.

**Display density no longer changes the measurement.** The rebuilt node now has two outputs. The
viewport receives the complete display candidates. Ground fitting and brush selection receive a
separate, exact 1M sample with the old per-frame confidence rule. Its cache key excludes colour,
display budget, stride and point size, so those controls do not refit the floor. The browser kept
the Ground Plane result at 20.8% support, 9.3° tilt and 1.7 cm RMSE through 1M → 3M → 6M. The
door fixture's maskless tabletop remains 0.69603 m, its established rebuilt-cloud baseline.

**The fuller display is bounded by its chosen size.** Reservoir sampling, which gives every
candidate the same chance while points stream past, allocates at most 1M, 3M or 6M loose point
slots. The previous builder first allocated all 13.8M candidates and then copied the selected
ones. The exact legacy measurement sample is cached on its depth field, so a display-only switch
does not repeat that older sampler's transient allocation. `BuiltCloud.allocatedPoints` makes the
bound testable.

**The crash paths now have owners.** Fetches receive the graph's cancellation signal. A late
result from an aborted pass is refused and disposed instead of replacing the newer choice. Every
retired Three.js subtree releases its geometry and materials after the viewport detaches it. A
partly loaded set of photographs falls back to the height ramp instead of painting the missing
frames black. Fixed view remains selected while the replacement cloud and camera check are in
flight, and only a completed camera refusal returns it to Free.

The browser switched 1M → 3M → 6M in Fixed view and then accepted ten rapid budget clicks. It
settled on one 6M cloud, stayed Fixed, kept the measurement result unchanged and logged zero
warnings or errors. The local tests cover the allocation bound, deterministic sampling, partial
colour, nested resource disposal, output-specific cache keys and aborted late results. The full
local verification passed all 467 tests and every server contract check.

**The rebuilt cloud still carries the photographs' colour.** The npz holds depth and confidence
but no RGB. The source frames are resampled onto the depth grid through one reused canvas. If all
frames load, the point cloud uses those colours; otherwise it says colour is unavailable by using
the height ramp. `COLOUR Photo | Height` keeps that choice visible.

### Where DA3's metric scale lives, and what cannot lose it — 2026-08-08

Settled from upstream source and confirmed against our own numbers, because a rebuild that
silently loses metres would be the worst possible outcome of the previous section.

DA3 fixes the scale **once per clip**, inside the model. A single least-squares scalar is applied
to `depth` and to the extrinsics' translation column **together**, so the two cannot drift apart.
Everything downstream is scale-free: the npz export writes the arrays through unchanged, and the
GLB's `hf_alignment` is a rotation composed with a rigid transform — already measured rigid to
eight decimal places in "The recorded camera can be put back in the scene, exactly".

The independent check: the outdoor clip's camera walk, computed from the extrinsics alone, comes
to **29.26 m**, against a walk recorded on the day as 29 m. Nothing told the extrinsics the scale.

**One call path would divide it back out.** `api.py` rescales depth when the caller supplies known
camera poses. `server/main.py:169` calls `model.inference()` with seven arguments and `extrinsics`
is not among them, so that branch never runs here. Anyone adding a parameter to that call should
check it again.

**Confidence carries no metric information.** Its activation is `exp(x)+1`, unbounded and floored
at 1 — measured on our own files at exactly 1.0000 minimum, reaching 15.27 indoors and 25.09
outdoors. It selects and weights; it must never multiply into a coordinate.

So the rebuild cannot lose metric scale unless we introduce the loss. The guard is a rule, not a
check: **no per-frame depth normalisation, no unit-sphere fit, no re-centring, and confidence
never touches a position.**

### The ground fit was a coin flip, and the cause was the selection rule — fixed 2026-08-08

The seed carries no information about the scene, so changing only the seed should change nothing.
It changed everything. Measured with `inspect floor --repeat 8`, before and after the fix, as the
spread of the plane's height under the cloud's centroid:

| Run | Before | After | Tilt before → after | Support after |
|---|---|---|---|---|
| `20260806-193346` outdoor | **39.6 cm** | **0.23 cm** | 14.55° → 0.04° | 2.5–8.8% → 20.7% |
| `20260805-151526` da3Test | 39.2 cm | 0.01 cm | 12.68° → 0.00° | 2.5–24.6% → 24.6% |
| `20260806-173802` door clip | 15.0 cm | 0.02 cm | 14.46° → 0.01° | 1.6–14.3% → 14.3% |
| `door-504px-112f` fixture | 10.1 cm | 0.06 cm | 5.15° → 0.07° | 2.1–14.6% → 14.6% |
| `room-504px-112f` fixture | 10.9 cm | 0.01 cm | 14.23° → 0.01° | 2.4–6.1% → 6.1% |

Both columns are the spread of the plane's height under the cloud's centroid, along the
camera-derived up. The old figures of 7–32 cm were differences of `offset`, which is each plane's
distance along **its own** normal — not a height, and an understatement: the outdoor run reads
31.9 cm that way and 39.6 cm measured properly. `--repeat` now fixes the reference point and the
axis for the whole study, because measuring each plane along its own normal is the same mistake
one level up.

**The tolerance is 1 cm and 0.5° across eight seeds**, and it is set from this project's own
measured operator repeatability of 1–6 mm (MEASUREMENTS.md): below that, the seed has stopped
being a term in the error budget. The worst of the five is 0.23 cm and 0.04°, a margin of about
40×. `door-fixture.test.ts` runs this gate on real data so it cannot come back unnoticed.

**The cause was not randomness, and it was not tuning.** `fitGroundPlane` kept the LOWEST
candidate that cleared a support bar, and `groundPlaneQuality` was applied one level up, to the
single plane each proposal pool returned. So the score never saw the candidates, and the decision
was a minimum over a random sample — an extreme value, which has no fixed point. RANSAC converges
because it takes the arg-max of a score over all the data; take a minimum and the guarantee is
gone.

**The prediction that follows is the proof: more iterations made it worse.** On the door fixture,
7 of 8 seeds found the good floor at 1200 iterations and **none** did at 19200, by which point the
mean elevation had sunk from −1.082 m to −1.156 m and support had fallen from 14.6% to 13.3%. The
outdoor run's spread ran 24.6 → 31.9 → 49.1 → 46.0 cm at 300, 1200, 4800 and 19200 iterations. So
raising the iteration count — the cheapest hypothesis, and the first one anybody would try — was
not merely useless but actively harmful.

**Ranking every candidate on `groundPlaneQuality` is the whole fix**, and it costs about 20% per
fit: the below-count and the squared residual are gathered in the pass that already counted
inliers. "Lowest, not largest" survives as the below-plane penalty, which is decision 3 expressed
as a score rather than a tiebreak, and can therefore be weighed against the evidence instead of
applied after it.

**Half the fix is the scale that penalty is measured on**, and this is the part that would be
missed by anyone repeating the work. Ranking by quality with the shipped settings puts the room
fixture on the **tabletop** — 22.7% support, 72 cm too high, 14.2% of the cloud below it — because
`maxBelowFraction` (0.2) is a *refusal* threshold being reused as a *scoring* scale. Sweeping the
new `belowScale` alone on that fixture: 0.02–0.10 lands on the floor on all 8 seeds, 0.15 is
bistable (6 seeds table, 2 floor), 0.20 lands on the tabletop on all 8. It is set to **0.05**,
mid-plateau, with a factor of two either side. The door fixture and the outdoor run do not move
anywhere in that sweep.

⚠️ **At 0.20 the tabletop fit is stable across seeds to 0.03 cm.** A gate that only checked seed
agreement would have passed it. Reproducibility is necessary and nowhere near sufficient; the
below-fraction and the picture are what say the plane is a floor.

**The door fixture at 504 px is bit-for-bit unchanged** — same normal to six decimals, same
offset, same 9096 inliers, same 1.2311 cm RMSE. The one scene with tape truth could not move, so
no graded measurement changed. Every reconstruction that moved was one that had been wrong.

**Not everything was fixed.** `room-252px-256f` still spreads 35.7 cm across seeds, on 1.3–2.7%
support. With the search no longer at fault, what is left there is a genuine shortage of floor
evidence, which is TASK.md task 2's problem rather than this one's.

The confidence filter above is a real defect and it was **not** the cause of this one. Rebuilding
the outdoor cloud from the npz with no confidence floor moved the plane 12.7 cm — well inside the
31.9 cm the seed moved it on its own.

### Measuring the room with nobody painting anything

Built 2026-08-08 (`geometry/levels.ts`, `inspect levels`, 10 tests). Every graded number in this
project came from a mask, so the operator was part of the instrument — a good instrument, but one
that cannot check itself. This is a second instrument sharing nothing with the first.

The idea is one sentence: **a horizontal surface puts all of its points at the same height.**
Count how many points land in each 5 mm band above the fitted floor and the flat surfaces appear
as spikes; a wall contributes evenly to every band and makes no spike at all. So the height of the
tabletop's spike *is* the floor-to-tabletop measurement, taken from thousands of points at once.

**On the door fixture it reads 0.6994 m for the table. The brush-based trials read 0.6983 m.**
Two instruments with nothing in common agree to **1.1 mm**. The 0.68–0.72 m band painted onto
frame 93 covers the desk top exactly and nothing else, so the number is what it claims to be.

That settles a live worry: the −5.1 cm error against the 0.750 m tape is **not** an artefact of
hand-painted masks or of the segmentation model. It is in the reconstruction. A second
reconstruction of the same clip (`20260806-173802`, 81 frames instead of 112) reads 0.7013 m,
agreeing with the fixture to 1.9 mm.

It also grades the FLOOR, which no existing number does. Support, tilt and RMSE all describe the
plane against the points it chose; none of them notices a plane that is level with nothing. A
surface a metre across, read against a floor whose normal is 1° out, comes back about 7 mm thick —
measured 2.0, 4.0 and 7.1 mm at 0.25°, 0.5° and 1°, against 1.7, 3.5 and 7.0 mm predicted by
`width × sin θ × 0.4`. Past about 2° the spike dissolves and the instrument reports nothing, which
is the right failure: forced to answer at 4° it returns a confident 1.7 cm error.

Two things it will not do. It finds surfaces, not objects, so it cannot measure a door leaf. And a
horizontal *line* of points — a shelf lip, a step nosing, the rows of a regular sampling lattice —
is excluded deliberately, by requiring width in both horizontal directions; the synthetic room's
wall grid produced exactly that false surface before the rule was added.

### What the maskless measurement says about the floor fix

Graded against the 0.750 m table, which is the same physical table in both clips (MEASUREMENTS.md
B2 and A1). No mask anywhere in this table:

| Reconstruction | Old floor | New floor | Truth |
|---|---|---|---|
| `door-504px-112f` | 0.6994 m | 0.6994 m *(unchanged by design)* | 0.750 |
| `door-356px-256f` | 0.5739 m | 0.5956 m | 0.750 |
| `room-504px-112f` | **no surface found** | **0.7211 m** | 0.750 |
| `20260806-173802` | **no surface found** | **0.7013 m** | 0.750 |
| `door-252px-256f`, `room-356px`, `room-252px` | no surface found | no surface found | 0.750 |

**Reconstructions in which a tape-measured surface can be found at all went from 1 of 7 to 4 of
7.** On the room fixture the old floor was tilted 19.3°, which smeared every flat surface until
none survived; the new one is 8.5° and recovers the table to within 2.9 cm — the best of any
reconstruction here. This is the practical gain, and it is larger than "the number stopped
wobbling": a floor that is level with the room is what makes anything else measurable.

### The outdoor brush is aligned; its 31–36 cm error is real — 2026-08-09

Saved run `20260806-193346-26d16e` contains three independent endpoint brushes on frame 30 for a
large tree-like target with **1.150 m** tape truth. It is an object-extent test. It is not a grass
height definition and no H50/H90/H95 or vegetation raster is involved.

| Trial | Reading | Error | Selected points | 3D endpoint centroids |
|---|---:|---:|---:|---:|
| 1 | 1.462 m | +0.312 m | 634 | 1.432 m apart, 0.196 m sideways |
| 2 | 1.508 m | +0.358 m | 588 | 1.480 m apart, 0.135 m sideways |
| 3 | 1.509 m | +0.359 m | 526 | 1.472 m apart, 0.097 m sideways |

The 2D-to-3D transform is not dropping or moving the brush. Every replayed point from all three
trials returned inside its recorded mask within one source pixel: **1,748 hits, zero misses**.
At a 5 cm voxel size, each top patch and each bottom patch is one connected 3D component. The
same round trip passes on the 2.100 m door and the 0.760 m `da3Test` table.

The fitted floor is not large enough to explain the error. Replacing its normal with the vertical
derived from the camera path lowers the three answers by only **1.7–3.7 cm**. The outdoor floor
itself has 20.7% support, 0.8% of the cloud below it, 1.63 cm RMSE and 9.11° tilt. Eight reseeds
move it by 0.23 cm and 0.04°. The runner-up score is 0.0346 behind the winner.

Shrinking the saved brush does not rescue the number either. On trial 2, eroding the mask from
2 to 4 to 6 depth pixels cut the selection from **588 to 343 to 163 points**, while the answer
stayed at **1.5085, 1.5116 and 1.5060 m** — a 5.6 mm range around a 35.8 cm error. The rigid
`da3Test` control moved 3.0 mm under the same test. A smaller brush therefore cannot account for
the outdoor bias.

One difference is visible in the evidence: the outdoor top patches span 17.3–34.7 cm from their
nearer to farther depth deciles, against 4.9 cm on the door and 7.9 cm on `da3Test`. Foliage has
depth, but this is not yet a safe refusal threshold: trial 2 is at the low end of that outdoor
range and is still 35.8 cm high. The rigid controls and foliage cases do not establish a boundary
that can be shipped honestly.

**Verdict:** there were two defects, not one. The giant endpoint discs were a display bug: their
world-space radius grew with the outdoor scene's 29.64 m diagonal. Selected points now render at
4 screen pixels and ruler endpoints at 10, so Fixed view shows the brush at the recording camera
without scene-scale inflation. The 31–36 cm measurement error remains. The recorded mask maps to
coherent reconstructed geometry that is 1.43–1.48 m tall; with only one outdoor truth, that leaves
local reconstruction scale/shape and target-endpoint identity as the two live explanations. A
second rigid tape truth visible in this same saved run can distinguish them without another cloud
run. No endpoint estimator or vegetation statistic was changed on this evidence.

### Other measured numbers

- Building the 12 GB service image takes **19 min 30 s**. One stored image is 9.8 GB and costs
  roughly $1 a month to keep, which is why it is kept rather than rebuilt. That price is **per
  image**, and images used to accumulate — see the standing-cost audit below.
- Result files are large: **108 MB at 112 frames and 504 px**. The 3D scene file is only ~16 MB.
- The model writes no result file of its own; ours is the only one. This was measured, not assumed.

### What a run actually weighs, in both directions

Measured 2026-08-06 from the saved door run at 112 frames and 504 px
(`fixtures/door/504px-112f/manifest.json`):

| | Content | Size |
|---|---|---|
| Sent up | 112 JPEG frames | **4.7 MB**, ~39 KB per frame |
| Came back | `scene.glb` | 16.1 MB |
| Came back | `verge-result.npz` | 105.5 MB |
| | **total returned** | **121.6 MB — about 26× what was sent** |

The output is **not** "depth images". The depth preview PNG is a ~10 KB thumbnail; the 105.5 MB is
four float arrays — depth, confidence, extrinsics, intrinsics — across every frame. That asymmetry
is why the 32 MiB response cap matters and why saving a run is chunked.

That run's diagnostics also confirm the model wrote **no npz of its own**: `native_npz` was empty
and the export directory held only `scene.glb`, `scene.jpg` and our `verge-result.npz`.

### Standing cloud cost, audited 2026-08-06

Nothing was reaping container images, and the documented cost was roughly a third of the real one.

| Where | Held | Reported size |
|---|---|---|
| `verge-lab` → `verge` | **two** `da3-service` images, one per `server/` source hash | 16.68 GB |
| `motiva-verge-lab-dev` → `mvl-worker` | a third copy, from the retired donor project | 11.80 GB |
| `motiva-verge-lab-dev-fdcfc626` | donor run outputs under `runs/**` | 29.69 MB |

About 28.5 GB, roughly $2.85 a month, against scripts that claimed ~$1. The stale `verge` image and
the entire donor repository were deleted the same day; only the current image remains. **Artifact
Registry reclaims shared layers asynchronously**, so the repository still reported 16,679 MB
immediately after the deletion — the figure lags the delete and was not re-checked here.

The donor bucket shows what happens when a rule misses: its lifecycle rules cover `temporary/`,
`incoming/`, `source-archives/` and `viewer/` — **but not `runs/`, which is where its output
actually went**. Those objects have no expiry at all.

**`gs://verge-lab-runs` was created on 2026-08-06** and is the first output bucket this project has
had. Its rule was applied and re-read *before the first object was written*: `Delete` at `age: 3`
matching `runs/transient/`. Checked again after the session's runs, by listing every object rather
than by trusting the rule's existence — **10 of 10 objects under the matched prefix, no orphans.**
It held 113.6 MiB at teardown, about 1.1 cents a month, and empties itself in three days.
(`scripts/create-bucket.sh`, `scripts/bucket-lifecycle.json`.)
- Extracting a whole ladder of frame counts takes **13 seconds** in one pass. Doing it one rung
  at a time took 435 seconds and once locked up the machine — see the lessons section.

---

## 4. Decisions that hold

1. **Selection happens on a 2D image, not in the 3D cloud.** Clicking individual points in a
   rotating cloud is miserable and does not scale. Each frame has its own depth and camera
   position, so a mask painted on the picture maps exactly onto 3D points. This is also why
   selection reads the raw result file rather than the 3D scene file: the scene file is a
   thinned sample with no record of which pixel each point came from.

2. **Never take the highest point as the top of an object; take a high percentile.** Mask edges
   produce points that are a blend of the object and whatever is behind it, and those land
   exactly at the top edge. Two separate fields — computer vision and forestry canopy
   measurement — arrived at the same fix. The pipeline shrinks the mask slightly, filters by the
   model's own confidence, removes statistical outliers, then takes the percentile.

3. **The ground is the surface with almost nothing beneath it.** Standard plane-fitting finds
   walls: on a real fixture it returned three tilted planes with more support than the floor had.
   Ranking by how many points support a plane puts it mid-scene, because a floor seen while
   walking is one of the *sparsest* surfaces. Ranking by how densely it fills its own footprint
   is worse and backwards. What works is the definition itself — 4.3% of the cloud below the real
   floor versus 60.6% below the wrong mid-scene plane is a clean separation from one cheap pass.

   **Since 2026-08-08 this is a score, not a tiebreak.** It used to be applied as "among the
   candidates with enough support, take the lowest", which is a minimum over a random sample and
   therefore had no fixed point — the floor moved up to 40 cm with the seed and sank further the
   longer the search ran. It is now the below-plane penalty inside `groundPlaneQuality`, weighed
   against the evidence rather than applied after it. The definition is unchanged; what changed is
   that it can now lose an argument to strong evidence instead of always winning one.

   **The scale it is judged on is a separate number from the threshold that refuses a fit**, and
   conflating them cost a session. `maxBelowFraction` (0.2) is generous so that an honest floor
   over rough ground survives; `belowScale` (0.05) is where a floor stops looking like a floor.
   Score on 0.2 and the room fixture picks its tabletop, stably and confidently.

4. **Which way is up comes from the camera path, and it is cross-checked, not trusted.** There is
   no motion sensor in a video-only pipeline, but averaging the camera's own downward axis across
   frames works — measured 0.925 to 0.953 agreement across fixtures. The fitted floor's own
   normal is compared against it and the disagreement is reported rather than silently resolved.

5. **A first fit must never become its own reference.** An earlier design fitted a floor, took a
   slice near it, and re-fitted — which could manufacture a precise-looking but strongly tilted
   floor: 0.7% support and 27.9° of tilt behind a healthy-looking 2 cm fit error. The replacement
   scores independent competing hypotheses on support, tilt, mass below the plane and fit error
   together. No single one of those numbers is allowed to stand alone.

6. **Scale is per-clip, and the known object grades rather than corrects.** Metric scale from this
   family of models drifts between scenes, so a factor calibrated in one clip does not transfer to
   another. The model's raw output stays the primary answer; a tape-measured object in the same
   clip is a quality check. Any corrected number is labelled as corrected.

7. **Gaussian splats are not a deliverable.** They improve appearance and novel views, but no
   measurement step consumes them — depth, camera positions and the point cloud already carry the
   geometry. Repairing them would need a larger build, more GPU time and another viewer for no
   measurement benefit. The app-side controls were removed on 2026-08-04.

8. **Uncertainty is split by kind, never averaged into one number.** Random scatter and known bias
   are reported separately, because a bias stated as a plus-or-minus reads as noise. This is not
   theoretical: a wrong measurement of 1.887 m once sat beside a ±0.037 m figure that covered none
   of its 0.213 m error. (`geometry/uncertainty.ts`, six tests pin that bias cannot migrate into
   the random term.)

9. **Abstaining is a real answer.** Below a minimum point count, or with a low segmentation score,
   or with two nearly tied candidate shapes, the app refuses to report rather than guessing.

10. **Colour carries meaning, not status.** The eight port colours are a type legend — a wire's
    colour tells you what flows through it. State rides a neutral brightness ramp plus a shape
    (`●` current, `◐` working, `○` idle, `▲` failed), so it survives a greyscale screenshot and
    colour blindness. Two exceptions are deliberate, both because the mark sits on a photograph:
    the mask overlay and the port colours themselves.

11. **The plane fit must be deterministic.** The app caches by content, so a step returning a
    different answer for identical input would quietly corrupt that model. Ours is explicitly
    seeded. Confirmed on real data: nine independent user recordings produced byte-identical floor
    diagnostics.

12. **Keep the built image, delete the service — but keep exactly one.** Storage is about a dollar
    a month; rebuilding costs twenty minutes of every session. The deploy script tags the image
    with a digest of the `server/` directory and skips the build when that exact source is already
    stored, so a stale image can never be deployed by accident. This was reversed on 2026-07-31 —
    the previous rule optimised the cheap axis.

    The per-image tag has a cost the original rule missed: every change to `server/` leaves another
    ~12 GB image beside the last one, and nothing deleted it. By 2026-08-06 that was two images and
    three times the assumed charge. So a new image is now **promoted** rather than added — it is on
    trial until it has served a real run, and the previous one is deleted in that same session.
    `scripts/teardown.sh` does this, and refuses to when no image matches the current `server/`
    source, because reaping "everything that is not current" would otherwise delete the only image
    there is. `REAP_OLD_IMAGES=0` keeps both when a session's runs failed and rollback matters more
    than a dollar.

13. **Transience is enforced by the service, not by the instance dying.** "Nothing is kept unless
    the user saves it" was, until 2026-08-06, an accident of scheduling: nothing deleted a
    successful run, and only the machine shutting down reclaimed anything. With `--min-instances=1`
    holding a machine alive for a whole session, every run's frames and exports stayed resident the
    entire time. The service now discards uploaded frames the moment inference returns — they are
    input, nothing reads them again — and sweeps run directories past `VERGE_RUN_TTL_SECONDS`
    (six hours) at the top of each `/infer`. The window is deliberately generous: a batched session
    saves its runs at the end, and deleting one early would destroy something already paid for.

    **The sweep was watched working on a deployed instance on 2026-08-06**, which is what this
    entry was missing — the code had shipped without ever running. With the TTL temporarily set to
    60 s, run A's `/artifact` went **404** after it expired while run B's stayed **200**, and run
    A's copies in the bucket were untouched. That is the whole design in one observation: the
    instance reclaims its disk, the result survives anyway.

    The frame discard is honestly *not* independently verified. It runs unconditionally on the
    `/infer` success path, so it executed in all four deployed runs, and unit tests pin its
    behaviour — but it has no signal through the API, so nothing was observed. Said plainly rather
    than counted as proven.

14. **Artifacts live in a bucket, reached by signed link; the durable address travels beside it.**
    Writing results to the container's own disk made a result address meaningful only on the
    instance that produced it, which is what forced `--min-instances=1` and made teardown a
    correctness requirement rather than hygiene. Objects have no such affinity, so the service now
    scales to zero and the two settings move together — `deploy.sh` refuses to deploy at
    `--min-instances=0` if the bucket is missing, because splitting them is how 2026-08-05 happened.

    **Each artifact carries two addresses, and the pair is the point.** `url` is a signed HTTPS
    link the browser fetches directly — no dev-server hop, no Cloud Run in the path, and therefore
    no 32 MiB response cap, so a 76 MB npz arrives in one request instead of five ranged chunks.
    `gs_uri` is the permanent address, and it is what Save resolves. Collapsing them would break
    saving: a signed link expires in twelve hours, while `save-run.sh` copies the manifest into the
    run directory as that run's archive record. A run saved the next morning comes home through
    `gs_uri` and would have failed through `url`.

    **Publishing may never fail a run.** It happens after `model.inference` has returned, so the
    GPU is already paid for; a storage permission slip that raised would throw away a finished run
    to report a problem that costs nothing to route around. `_publish` falls back to the local
    `/artifact` path and records why, surfacing as `diagnostics.publish_mode: "degraded"`. That
    mode is reported on screen, because a degraded run is otherwise indistinguishable from a
    durable one right up to the moment teardown destroys it.

    Signing inside Cloud Run has no private key, so it goes through the IAM `signBlob` API and the
    runtime account needs Token Creator **on itself** — the failure that would otherwise be
    discovered after a GPU run. `/publish-check` proves the whole chain for one HTTP request.

15. **Navigation moves the rig; it does not replace the orbit camera.** Keyboard movement
    translates the camera and its orbit pivot together, leaving the spherical offset between them
    untouched, so dragging still orbits — around whatever you have just walked up to. The
    alternative was a pointer-locked fly camera, which would have meant giving up orbit entirely,
    and orbiting an object is the right tool for looking at one. The same reasoning makes the
    arrow keys rotate that offset rather than the camera in place: they are the keyboard's version
    of a left-drag, which is exactly what a trackpad makes hard.

    **Movement keys read the key's POSITION, not the character it typed.** On macOS the precision
    modifier is Option, and Option+W reports `∑`. Keyed on the character, the press would register
    and its release would never match, leaving the operator gliding forever with nothing held
    down. The character is consulted only when a sender omits the position entirely.

16. **The fixed view rides the recorded pose and refuses rather than approximates.** Standing
    where the camera stood is only worth anything if it is exact, so the poses are checked against
    the scene file at load and the mode declines when the two disagree — including when the
    positions are right but their ORDER is not, which would look entirely convincing while
    disagreeing with the frame slider driving it. This is the same abstention rule as decision 9,
    applied to a viewpoint instead of a measurement.

    **Looking around is allowed; walking is not.** A fixed camera you can translate is not a fixed
    camera, and the mode's whole claim is that the viewpoint is the camera's own. Turning your
    head costs nothing and makes the mode usable, so yaw and pitch are applied on top of the pose
    — yaw about the measured vertical so a clip recorded with the phone rolled still turns level.

    **The video overlay is off by default.** It is the strongest thing this pane can show and the
    easiest to misread: the cloud was reconstructed from the same frames, so a degree of agreement
    is guaranteed by construction. It is a demonstration and a drift check, not evidence of
    accuracy, and it should be reached for deliberately.

---

## 5. What has been measured, and how well

Full tables, tape-measure truths and the error analysis live in `MEASUREMENTS.md`. The summary:

**On the primary clip, at 504 px and 112 frames**, the pipeline measures a 2.10 m door, a 0.75 m
table and a 0.45 m computer tower with a raw average error of about 0.037 m across the two
holdout objects. Fitting a line through predicted-against-true separates a scale error of about
3% from the remaining scatter of about 0.008 m.

**Repeatability within one sitting is excellent and was a surprise.** The same person repainting
the same endpoints reproduces them to **1 to 6 mm** — 15 to 90 times smaller than the error
against the tape measure. The study was designed on the assumption that operator placement was
the missing noise term. It is not; what remains is systematic bias, which is correctable.

**Between sittings is a different and larger number.** Two objects moved 23 and 24 times their
within-sitting spread when compared against masks painted in an earlier session. The cause was
identified — one mask's lower edge never reached the bottom of the door — so it is one mistake
rather than scatter. It still shows that back-to-back repeats cannot measure this.

**The dangerous case is a wrong answer that looks healthy.** The 1.887 m door came with a
plausible spread, a supported floor and a good fit error. No reported statistic distinguished it
from the correct 2.020 m; only looking at where the mask sat did. This is why the app highlights
selected points live in 3D while painting, and why automatic selection must be able to abstain.

**Resolution verdict: 504 px with 112 frames**, which wins on both raw and corrected error while
costing less GPU time than the 356 px alternative.

---

## 6. Where the evidence lives

**Tracked in git** — a fresh clone has these:

| Evidence | Path |
|---|---|
| Nine repeatability trials with their masks | `docs/measurement-trials-2026-08-04.json` |
| The measured memory ladder | `docs/vram-measurements.json` |
| Tape-measure truths and graded results | `MEASUREMENTS.md` |
| Interface review passes, newest first | `docs/design-review-log.md` |
| Fixture manifests and checksums | `fixtures/*/manifest.json`, `SHA256SUMS` |

**On this machine only** — a fresh clone will not have these, and they must be regenerated by a
cloud run followed by `scripts/save-run.sh`:

| Evidence | Path | Size |
|---|---|---|
| Door clip reconstructions at three settings | `fixtures/door/` | 342 MB + 11 MB of frames |
| Room clip reconstructions at three settings | `fixtures/room/` | 346 MB |
| Saved cloud runs | `~/verge-runs/` | varies |

The door fixture is the primary one: same room as the room fixture, but it contains the door,
which at 2.10 m is the long reference the calibration needs. Scale does not transfer between
clips, so every reference used to judge a reconstruction must be visible *in that reconstruction*.

**Representative commits**, if you need to see how something arrived:

- `5324e6d` content-addressed graph engine · `b9474f5` geometry core · `356c48e` the ground
  selection rule · `9fd036e` measurement evidence workflow · `a77b109` repeat trials with frozen
  masks · `5a0c9af` browser-local segmentation · `9d9e1aa` the run registry · `00410fe` in-app
  cloud control · `dee7443` deploy button and mock banners · `4e64b93` the frame-numbering fix.

---

## 7. Known limitations and gates

These are stated, not scheduled. Anything being actively worked on is in `TASK.md`.

- **Automatic object selection is proven on one attempt, not benchmarked.** One click produced a
  1.941 m door against a 2.020 m manual mean and a 2.100 m truth. A ten-attempt study with
  deliberate bad clicks has not been run, so failure and abstention rates are unknown. **This
  gates trust in automatic masks only.** It does not block outdoor ground or vegetation work,
  which do not depend on it.
- **The ground fit is reproducible to 0.23 cm and 0.04° across seeds** at the operating resolution
  (section 3), and everything measured against it inherits that instead of the old 7–32 cm. One
  reconstruction is still unstable: `room-252px-256f`, at 35.7 cm on 1.3–2.7% support. A stable fit
  is not the same as a correct one — see the tabletop warning in section 3.
- **The maskless measurement finds a surface in 4 of 7 reconstructions**, not all of them. Where it
  abstains, the reconstruction has no flat surface sharp enough to measure and the reason is
  usually resolution: nothing at 252 px yields one. It measures surfaces, never objects, so it
  cannot check the door leaf, the tower or the monitor — the three graded objects it cannot reach.
- **Accuracy does not transfer across scenes.** `da3Test` measures its 0.760 m table within 5–6 mm,
  while the saved outdoor run measures a 1.150 m tree-like target 31–36 cm high. The brush mapping,
  floor direction and brush width have been ruled out as the main cause; one outdoor truth cannot
  separate local reconstruction scale/shape from target-endpoint identity.
- **DA3's exported cloud remains a biased 7% sample of the reconstruction.** Its pooled confidence
  floor can remove whole frames. The app keeps that cloud as a named comparison, while the rebuilt
  display now uses every finite, non-edge depth candidate. Measurements deliberately use a fixed
  1M per-frame-confidence sample so changing the picture cannot move a recorded result (section 3).
- **A pane squeezed below about 100 px tall cuts its own control stack off at the bottom.** Rows
  wrap horizontally and then run out of pane vertically. Found 2026-08-08 while verifying the
  wrapping fix; it needs a scrolling control stack, and is not reachable by dragging in the
  default layout.
- **The top of the memory range is not modelled.** 81 frames at 504 px is the verified
  conservative setting; the 22.02 GiB reading at 112 frames is still unexplained, though
  orientation has been ruled out as its cause. See the warning in section 3.
- **A signed link outlives neither the day nor the bucket.** Links expire after twelve hours and
  objects after three days, so an unsaved run is recoverable for three days and no longer. The
  manifest's `gs_uri` is what makes a late Save work at all; nothing re-signs on demand.
- **One object cannot be graded** on the primary clip: the laptop hides the monitor stand's
  contact point. Inventing that endpoint was rejected.
- **Two open scientific questions**, recorded rather than scheduled: whether measurements repeat
  across separated sittings, and what should be shown when no ground can be established at all.
- **The dependency audit is not clean and must not be described as such.** Two high-severity
  advisories arrive through the segmentation library's Node-only image dependency. The browser
  build neither runs nor ships it, but the repository audit is non-zero.

---

## 8. Lessons that cost time or money

Kept because each one was paid for once.

- **A display trial number is not a storage identity.** Every browser sitting starts at trial #1.
  Keying disk packets by that label let a new sitting replace an older packet, and a background
  mask migration could race the richer Record write. Disk identity now includes sitting, capture
  time and mask digest, and Record marks its packet before the migration effect can run. The
  regression test creates two trial #1 rows and requires different evidence identities.
- **A box ticked for code that was written but never run has cost real money twice.** Saving a run
  failed on the first live attempt because every previous save had been a built-in fixture that
  never reached the script. Exercise the seam, or say it is unexercised.
- **A test whose fake cannot fail the way the real thing fails proves nothing.** One stand-in
  lacked a method the real object has, so every proxied reply became an error the test read as a
  pass on everything it did not assert.
- **A test that grants permission to be wrong will be taken up on it.** `plane.test.ts` asserted
  that two seeds "need not agree to the millimetre" and called agreeing on the surface the property
  that mattered. That sentence was the largest error in the system for months: on real clouds the
  permission bought a floor that moved up to 40 cm with the seed. A test states what the code is
  allowed to do, so a loose assertion is a design decision written in the quietest possible place.
- **Search failures and scoring failures look identical from the outside, and the fix is
  opposite.** The floor fit looked like a scoring problem for a long time — the score was fine, and
  had been fine all along; it was simply never consulted where the decision was made. What told
  them apart was raising the iteration count and watching the answer get *worse*. If more search
  hurts, the thing being optimised is not the thing being scored.
- **Reusing one constant for two jobs hides the second job.** `maxBelowFraction` was a refusal
  threshold, and the moment a score needed a "how much below is too much" scale it was reached for
  again. The two want different values by a factor of four, and the wrong one puts the floor on a
  table — stably, reproducibly, and with every reported statistic looking healthy.
- **Test the round trip, not the fields.** A conversion was trimmed to the two fields one script
  read — and that object turned out to be the run's permanent record, so every saved run became
  unloadable. The field-by-field test passed against the broken version; a round-trip test would
  not have.
- **Two frame-numbering conventions existed and the wrong one was applied to saved runs.** The
  visible half was missing images; the silent half was a mask painted on one frame and
  back-projected with another frame's camera. Numbering is now recorded on the run, not inferred.
- **The service's health endpoint is `/health`, not `/healthz`** — the cloud platform intercepts
  the latter and answers its own 404 before the request arrives. Probe a second path before
  concluding a container is dead.
- **A user identity token has the wrong audience for this service** and produces a 404, not the
  403 you would expect. Route calls through the dev server, which signs them properly, rather
  than making the service public.
- **Responses are capped at 32 MiB, not just requests.** A 108 MB file returns an error with zero
  bytes. Anything larger is fetched in 24 MiB ranged chunks, with each chunk's byte count checked.
- **Never extract frames one rung at a time.** Sampling across a clip means the whole video is
  decoded regardless of how many frames you want, so five rungs meant five full decodes. This
  machine has six cores, only two of them fast, and it locked up hard enough to need a restart.
- **Dropping ffmpeg from the image also drops OpenCV's shared libraries**, which the model needs
  even though we never decode video on the server. The build now checks its own imports.
- **Saving the pane layout while one pane is maximised corrupts it** — the maximised state sizes
  its neighbours to nothing, and those sizes are what gets stored.
- **A cost written into a comment stops being true and nobody notices.** Two scripts described the
  standing charge as "~12 GB, about a dollar a month". It was 28.5 GB across three image copies in
  two projects, roughly $2.85 a month, and had been wrong for days — nothing checks a comment
  against the account. Cleanup that is documented but not executable is a wish. The rule now has a
  script behind it (`teardown.sh` reaps) and the audit is in section 3 with the date it was taken.
- **A retention field nobody reads is worse than none.** The manifest has advertised
  `expires_after_days: 3` since the contract was written; no code has ever honoured it, and the
  donor bucket's lifecycle rules missed the one prefix its output was actually written to. Both
  looked like a policy from the outside. Check the prefix that receives data, not the presence of
  a rule. Since 2026-08-06 the rule exists and is verified by listing objects, not by reading it.
- **Work that happens after the GPU must never be able to fail the run.** Uploading, signing and
  manifest-writing all run once inference has returned and the money is spent. Anything there that
  raises converts a finished result into a 500. Degrade, record why, and surface it.
- **`ffprobe`'s width and height are the coded pair, not the displayed one.** A phone clip carries
  `rotation=-90` in side data; ffmpeg auto-rotates on extraction, so the model sees the transpose
  of what a naive probe reports. A run planned as a landscape test on 2026-08-06 turned out to be
  portrait, and would have been recorded under the wrong label had the manifest's own frame
  dimensions not been checked against the probe.
- **An interface accumulates truths that quietly expire, and a confident wrong readout costs more
  than a missing one.** Four were found on 2026-08-09 by reading the panes against the code that
  fed them. Objects rendered a "Resolution vs frame-count verdict" built from three recorded runs
  of the **door** clip for every clip: on `da3Test.mp4` it drew three rows of `—` under a heading
  promising a verdict, and closed with a sentence about a target that clip does not contain. Its
  holdout column was the literal `/3`. `AUTOMATIC REVIEW` suppressed the word "experimental" for
  `door-leaf` and applied it to everything else — backwards, since the door is the one target
  automatic selection has ever been tried on. The status row said `M3c evidence` while the export
  button wrote `verge-m3b-measurements.json`. And the Inspector's `Instance alive` row rendered a
  label with an empty value once contact had been made. None of the four was ever wrong when it was
  written; each stopped being true and nothing was watching. A blank in a comparison is not neutral
  — it reads as a claim the comparison ran and came back empty.
