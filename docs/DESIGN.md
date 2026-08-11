# Interface design — the contract

What the interface must look like and do. The acceptance checklist at the end is what the
design-review workflow grades against.

Visual reference: Spencer Sterling's **Sentinel**, captured in `reference/`:

- `sentinel-streamdiff-brush-canvas.png` — viewport panes, properties, terminal, graph
- `sentinel-scientific-organism.png` — many tabs per group, denser inspector, graph banner

Lineage: TouchDesigner and ComfyUI. Dense, dark, professional, everything observable.

## Principles

1. **Everything is observable.** Every node shows a thumbnail of its output; every pane shows a
   status readout with numbers in it. No black boxes, and no spinner without a figure beside it.
2. **The graph is the program.** Viewports are taps on wires. Users rewire rather than re-run.
3. **The inspector follows the selection.** Click a node, its parameters appear as compact rows.
4. **Density over whitespace.** This is a tool, not a landing page: small type, tight rows, thin
   borders, minimal padding.
5. **Dark always.** No light theme, no pure white, no pure black.

## Panes

Six panes in a Dockview layout, gaps of 4 px or less, filling the window edge to edge. **Five of
them open by default**; the Graph is closed and one click on the view bar brings it back.

```
+--------------------+--------------------------------+-------------+
| Depth 2D           | Viewport 3D                    | Inspector   |
| (colour-mapped     | (point cloud, orbit, turntable)| Objects     |
|  depth, mask brush)|                                | Runs        |
+--------------------+--------------------------------+-------------+
   Graph (React Flow) — closed by default, opens full width below
```

The Graph is a configuration and explanation surface, not a workspace: it earns the window when
you are rewiring the pipeline or showing somebody how it works, and it took 38% of the height
before either question was asked. It was also the only way to load a video, which made it the
front door by accident. **A clip is loaded in the Inspector's Clip section**, which writes the same
`frame-source` parameters the node card does — one node, two views.

Every pane is draggable, resizable, and carries two verbs on its tab:

- **Focus** (double-click the tab, or the button in the pane's own control row) fills the window
  with that pane. The others yield their space but stay mounted, so nothing is torn down and
  nothing is re-uploaded. Escape restores. Focus is a transient view mode and is deliberately
  **not saved** — reopening the app with one pane filling the screen and no visible way back is a
  bad default, and saving the layout while focused corrupts the stored sizes.
- **Hide** (the ✕ on the tab) closes the pane and gives its space to the rest. A view bar in the
  status bar brings it back. There is no non-destructive hide available in Dockview, so a hidden
  pane is genuinely unmounted and remounts when reopened.

Layout otherwise persists across reloads, with a Reset control.

**Pane chrome.** Tab strip 28 px or shorter, labels 11–12 px. Directly beneath it a status row
carrying live numbers, not just words — point counts, elapsed time, stale counts, selected pixels.

**Every control row wraps.** Since 2026-08-08 `.output-row`, `.pane-controls`, `.brush-toolbar`,
`.frame-toolbar` and `.segment-toolbar` all wrap onto a second line rather than clipping, and a
labelled slider may shrink below its own caption width. A taller row costs canvas; a clipped row
costs the control, and that is not a trade worth making.

⚠️ This was the opposite until then, and it cost five controls. Measured at a 180 px pane on
2026-08-08 before the change: Depth 2D put its `Confidence` chip and the whole mask hint outside
the pane, and both `.pane-controls` rows put `Focus`, `Hide` and `Pause` outside it — unreachable,
because `nowrap` with hidden overflow clips silently instead of scrolling. **Do not reintroduce
`white-space: nowrap` on a row that holds a control.**

## Two modes, and where explanation lives

The panes grew past being usable — Viewport 3D reached six control rows and nineteen buttons, and
Objects explained its whole method underneath every reading. Every one of those was worth adding.
Their sum was not. Two rules keep it from happening again.

**Standard and Advanced.** One switch in the status bar, read by every pane, remembered across
reloads, default Standard. Standard is the app doing its job: look at the reconstruction, mark a
thing, read what it measures and how far off the tape it is. Advanced adds what only earns its
space while debugging a fit. Three constraints hold it together:

1. **Advanced is a strict superset.** No control exists only in Standard.
2. **Standard never strands an effect.** A pane that hides the switch for something it is drawing
   turns that thing off. Viewport 3D clears its layer set on entering Standard for this reason.
3. **Warnings are not hidden by it.** A capped frame plan, an extrapolated VRAM figure, a
   mock-backed readout, an instance still billing — all four honesty rules below apply in both
   modes. Hiding one behind a mode is the same lie as not showing it.

**Help dot.** Text explaining what a control or a reading *is* goes behind a `?`; text describing
the state the app is in *right now* stays on the page. The `?` is a real button — instant on
hover, opens on keyboard focus too, Escape closes, dark palette, wrapped to about 60 characters a
line, portalled so no pane's hidden overflow can clip it. The native `title` tooltip stays for
short chip labels and is not acceptable for a paragraph: a second of delay, an OS-styled light box
and nothing at all for a keyboard.

## Colour

**Hue encodes the type of data, never status.** The port colours below are a legend and are
load-bearing: a wire's colour tells you what flows through it. Status rides a neutral brightness
ramp plus a glyph, so state survives desaturation, colour blindness and a greyscale screenshot.

| Glyph | Meaning |
|---|---|
| `●` | current / ok / warm / accepted |
| `◐` | working / stale / pending review |
| `○` | idle / paused / cold |
| `▲` | hard failure |

Two deliberate exceptions, both because the mark sits on a photograph where a neutral would
disappear: the **2D mask overlay** (amber unreviewed, teal accepted, pink brush) and the **port
hues** themselves. The primary clip's room is white walls — a white mask would vanish on the door.

### Tokens

Defined once in `app/src/theme.css`.

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#0d0d0f` | window background |
| `--bg-pane` | `#151517` | pane body |
| `--bg-header` | `#1a1a1d` | tab bars, node header base |
| `--bg-node` | `#1e1e21` | node card body, inspector rows |
| `--border` | `#2a2a2e` | every 1 px border |
| `--text` | `#d4d4d8` | primary text |
| `--text-dim` | `#8a8a90` | labels, hints, units |
| `--emph-hi` | `#f4f4f6` | the highlighted thing: ok, current, selected, accepted |
| `--emph` | `#c7c7cd` | secondary emphasis: truths, budget rule, memory fill |
| `--emph-dim` | `#8a8a90` | de-emphasised state |
| `--accent-busy` | `#f59e0b` | pending, stale, warming, experimental — the one state hue |
| `--accent-err` | `#b4574f` | hard failure only, and destructive buttons |
| `--slider` | `#e05252` | slider thumbs and filled tracks — marks *controls*, never state |
| `--font-ui` | `"Inter", system-ui` | labels, 11–12 px |
| `--font-mono` | `"JetBrains Mono", ui-monospace` | every number and readout |

Port and wire colours — a wire inherits its source port's colour:

| Port type | Colour |
|---|---|
| `frames` | `#d8d8d8` |
| `depth_field` | `#5aa0e8` |
| `point_cloud` | `#4ade80` |
| `plane` | `#f3c969` |
| `selection` | `#fb7185` |
| `measurement` | `#e8a95b` |
| `camera` | `#e879a0` |
| `scalar` | `#f59e0b` |

## Components

**Node card**, about 180 px wide: coloured header by category, name at the left with small `A`/`P`
badges at the right, labelled port rows with a type-coloured dot (inputs left, outputs right), an
output thumbnail filling the card width, and elapsed milliseconds in mono at the bottom left. A
selected card carries a 1 px `--emph-hi` outline.

**Graph canvas**: a warm dark surface distinct from the pane bodies, so the graph reads as its own
place. Dot grid. A banner across the top with the pipeline title in capitals and a one-line
description of the chain. Fit, view-scope and Focus controls at the top right.

**Wires** are long bezier curves passing *over* nodes, not behind. Clicking one selects it —
selection thickens the stroke and switches it to `--emph-hi`, so the highlight does not depend on
the port hue. Backspace deletes the selected wire. Node selection and wire selection are mutually
exclusive; clicking the empty canvas clears both. Dragging from a port rewires, and connecting to
an input that already has a wire replaces it rather than stacking a second one. Connections are
type-checked: ports of different types refuse to join.

**Inspector**: collapsible sections; rows are label, control, value — label 11 px `--text-dim` at
the left, numeric value right-aligned in mono, control filling the middle. Controls are mixed, not
sliders only: sliders with `--slider` thumbs, dropdowns, checkboxes. Sections are tightly stacked.
**Changing a control refreshes the graph by itself**, after a short delay that folds a slider drag
into one pass — and that refresh can never reach a costly node, whatever its badge says.

**Setup pane** (the tab formerly called Inspector; the pane id stays `inspector` so stored layouts
resolve). It had two jobs and was named for the smaller one. Its header states the depth **mode**
— `MODE · DA3` — not a device name, because where depth comes from is the axis that would change
for a LiDAR or stereo source; the device that ran a job belongs on the job.

**Three acts, in order, and each one is a press.** The ordering was implicit and two parts of it
were wrong, so it is now the pane's structure:

1. **Clip.** Drop or Browse. This probes the file and stops. Loading must not start ffmpeg — the
   plan below is what somebody is deciding about, and sampling a 4K clip takes 11.7 s measured.
2. **The plan, then Extract.** Frames, effective rate, the downscale target, the upload size as a
   bracket, and the VRAM bar — all arithmetic on the probe, so the sliders are free to drag.
   Extract is the ffmpeg press. Afterwards a **contact sheet** shows every sampled frame in one
   image with the reference view outlined, because "did it sample the whole clip?" is not a
   question a frame count can answer. Clicking a cell opens that frame in Depth 2D.
3. **Run.** Three preconditions as a visible checklist — clip, frames, somewhere to send them —
   each saying what would satisfy it, with Run disabled until all three are met. Then the live
   **phase readout**: reading frames, uploading, waking, loading model, inferring, fetching
   artifacts, each with its own elapsed clock. A finished run points the viewers at itself.

**Frame Source is a costly node**, in the same sense DA3 is. One spends GPU money and the other
spends up to 11.7 s of this Mac, and neither may start because a slider moved. Both are `manual`,
which is what makes item 17 below safe to keep: a parameter edit schedules `runAutoFree`, and that
pass denies every manual node.

**Service lifecycle control**, in the status bar beside the GPU chip, because that is where the
state is reported and the control that changes it should not be three clicks away in Advanced. Four
states, not two: `Deploy`, `Deploying · m:ss`, `Deployed · not billing`, `Live · m:ss`. **Only the
last one glows.** Creating a Cloud Run service is free; the meter starts when a request wakes an
instance. A control that lit up at "deployed" would teach the operator that deploying is the
expensive act and that a quiet deployed service is safe — both backwards, and the second is how a
machine gets left running overnight. Deploy and delete each confirm, every time.

Setup also carries **Cloud control** (Advanced): sign-in state, project and region, whether the
service exists, whether the stored image matches the current server source, and whether the next
deploy is the quick path or the twenty-minute one. Deploy and delete both stream their logs. Every
status read is free and cannot wake a machine. The **Instance** section — elapsed billed time and
the idle warning — is not Advanced, because an instance bills whether or not anybody is looking at
this pane.

**Viewport 3D result strip**: a reserved row between the control rows and the canvas carrying the
target, what it measured, the tape truth, the absolute error and the error percentage. Reserved
rather than floating: the readout it replaced sat over the top left of the scene, which is where
the subject of a shot usually is. In Advanced the fit diagnostics return as an overlay.

**Objects pane**: one row per measurement target — raw value, truth and error, internal spread,
selected-point count, and the current error model. Rows never mix incompatible reconstruction
settings. Targets belong to a clip, keyed by its content digest; an unknown clip starts empty.
A blind mode hides every reading except the tape truths, so a repeat measurement can be painted
without the previous answer on screen. In Standard it shows the target list, the active reading
and the actions; the uncertainty budget, the trial ledger, the error model and the resolution
comparison are Advanced — they are the repeatability study rather than the measurement.

**Runs pane**: one row per run, with its size on disk. Runs are temporary until an explicit Save,
which is shown with a byte estimate. Delete is available. The built-in fixtures are read-only.

**Provenance banner**: the panes that display geometry state where it came from — a mock, a
recorded fixture, or a live run. This exists because a mock result wears the new clip's picture
while carrying old geometry, which once read as a successful run on an unrelated video.

**Status bar** (24 px, bottom): the GPU instance chip with its state glyph, live memory use, the
last-run summary, the instance-alive meter, and the view bar for hidden panes.

**Memory readout**: a horizontal bar against the device's real 22.03 GiB — not the advertised 24.
It tracks live usage during a run and shows the last peak when idle. It uses the neutral ramp with
amber for pressure; there is no green.

**Buttons**: flat, 1 px border, no gradients. Destructive actions use `--accent-err` as text
colour, not as a fill.

## Honesty rules

Design constraints, not copy guidelines.

1. **Never present a prediction as though it were a measurement.** The memory readout says which
   it is: `VRAM (measured)` when the frame count sits on a rung of the real ladder,
   `VRAM (interpolated)` when it sits between rungs, and beyond the highest rung a note stating
   that the figure is a projection and the sweep never ran that high. A single number is
   permitted only because five real rungs now exist; before the sweep it was shown as a bracket,
   and it must go back to one if the model ever rests on fewer than three measurements again.
2. **Never silently change the user's settings.** When the frame limit forces a lower sampling
   rate, say so, show the arithmetic, and state that the frames still span the whole clip.
3. **Distinguish mock from real.** Anything backed by a fixture or the offline mock is labelled,
   so a screenshot can never be mistaken for a real run.
4. **No invented currency figures.** The app has no billing data and the machine's lifetime starts
   before our first contact, so it reports elapsed instance time rather than a made-up cost.
5. **A progress bar must be fed by something counted.** The only proportion drawn during a run is
   the upload, and it is bytes acknowledged over bytes handed to the socket. Every other phase
   shows an elapsed clock beside a figure labelled as measured — 64 s cold start, 40 s model load,
   ~31 s inference — and the phase itself advances on an observation of the GPU (whether anything
   answers, whether the model is resident, whether the device is busy), never on a timer. A bar
   that fills on a clock is a prediction wearing a measurement's clothes.
6. **Deployed is not billing.** The two are separate states everywhere they appear, because
   conflating them makes the cheap action look expensive and the expensive one look safe.

## Acceptance checklist

1. App background is `#151517` or darker; no white surfaces; no default-blue links or focus rings.
2. **No status is signalled by hue alone.** In greyscale, every state is still readable from its
   glyph, weight or position. Green is absent; red appears only on hard failure and slider thumbs.
3. The five default panes are present with Dockview tabs and drag-resize works; the Graph opens
   from the view bar and comes back with its wiring intact.
4. Tab strip is 28 px or shorter; labels 11–12 px; density comparable to the reference captures.
5. Viewport 3D renders the point cloud, drag-orbit visibly changes the view, the point count is
   shown, and the axis gizmo is visible.
6. Depth 2D shows turbo-colour-mapped depth with a legend in metres.
7. Every pane has a live status row containing numbers, not just text.
8. No horizontal window scroll at 1280×800; gaps between panes are 4 px or less.
9. Fonts: interface text 12 px or smaller, numeric readouts in mono, nothing above 14 px except
   empty-state hints.
10. Side-by-side squint test against `reference/`: comparable darkness, density and contrast.
11. The inspector exposes every inference parameter with mixed control types, each showing its
    current value in mono at the right.
12. Memory is visible in both the inspector and the status bar, and the bar moves during a run.
13. The memory figure says whether it is measured, interpolated or extrapolated, and a frame
    count beyond the measured ladder carries the projection warning.
14. A capped frame plan explains itself in place, showing the arithmetic.
15. Mock-backed readouts are labelled as mock, including in the panes that display geometry.
16. Focus fills the window without remounting, Escape restores, and hiding a pane reflows the
    rest with a way to bring it back.
17. Changing a parameter in the inspector refreshes the graph without any other interaction, and
    never starts a costly node.
18. A wire can be selected by clicking it and deleted with Backspace; only that wire is removed.
19. **Graded at a narrow pane, not only at 1280×800.** With a pane dragged to 180 px, every
    control in every row of that pane is still inside it — measure, do not eyeball, by comparing
    each row child's bounding box against the pane's. Items 8 and 10 stay at 1280×800; this one
    exists because the defect it catches is invisible at that width.
20. **Graded in both modes.** The status bar carries the Standard/Advanced switch and it survives
    a reload. In Standard, Viewport 3D has two control rows and Objects shows the target list and
    the active reading only. Every control present in Standard is also present in Advanced, and
    switching back to Standard leaves nothing drawn that has no switch.
21. **No paragraph of feature explanation sits in a pane body.** Explanation is behind a `?` that
    opens on hover and on keyboard focus, closes on Escape, and lands fully inside the window with
    the pane at 180 px. Live warnings — items 13, 14, 15 and the idle-billing note — are exempt
    and must be visible in both modes.
22. **The measurement is the headline.** Viewport 3D states what was measured, the tape truth, the
    absolute error and the error percentage in reserved chrome that never overlaps the canvas.
    With no tape truth it says so and quotes no error.
23. **Loading a clip starts no work, and the plan precedes the press.** Dropping a file shows
    frames, effective rate, downscale target, upload bracket and VRAM before ffmpeg runs; a
    sampling change makes zero calls to `/api/extract`. After extraction the contact sheet's cell
    count equals the plan's frame count, with the reference view outlined.
24. **A run says what it is doing.** Named phases in order, each with an elapsed clock; the upload
    the only proportion; a failure naming the phase it died in; and a success that puts its own
    geometry on screen rather than leaving the previous clip's there.
25. **The service lifecycle is one control with four states, and only `Live` glows.** Deploy and
    delete each confirm. A service left alive by an earlier session reads as `Deployed` on load,
    from a status call that cannot wake anything.
