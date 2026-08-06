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

Six panes in a Dockview layout, gaps of 4 px or less, filling the window edge to edge:

```
+--------------------+--------------------------------+-------------+
| Depth 2D           | Viewport 3D                    | Inspector   |
| (colour-mapped     | (point cloud, orbit)           | Objects     |
|  depth, mask brush)|                                | Runs        |
+--------------------+--------------------------------+             |
| Graph (React Flow, full width)                      |             |
+-----------------------------------------------------+-------------+
```

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

⚠️ That status row is `nowrap` with hidden overflow, so **a control placed at its right edge
silently leaves the viewport** in a narrow pane. Put controls in a wrapping row instead.

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

The inspector also carries **Cloud control**: sign-in state, project and region, whether the
service exists, whether the stored image matches the current server source, and whether the next
deploy is the quick path or the twenty-minute one. Deploy and Delete service both stream their
logs. Every status read is free and cannot wake a machine.

**Objects pane**: one row per measurement target — raw value, truth and error, internal spread,
selected-point count, and the current error model. Rows never mix incompatible reconstruction
settings. Targets belong to a clip, keyed by its content digest; an unknown clip starts empty.
A blind mode hides every reading except the tape truths, so a repeat measurement can be painted
without the previous answer on screen.

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

## Acceptance checklist

1. App background is `#151517` or darker; no white surfaces; no default-blue links or focus rings.
2. **No status is signalled by hue alone.** In greyscale, every state is still readable from its
   glyph, weight or position. Green is absent; red appears only on hard failure and slider thumbs.
3. All six panes are present with Dockview tabs, and drag-resize works.
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
