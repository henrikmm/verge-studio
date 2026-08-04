# Verge Studio — UI design specification

Visual north star: Spencer Sterling's **Sentinel**. Reference captures in `docs/reference/`:

- `sentinel-streamdiff-brush-canvas.png` — 3 viewport panes + properties + terminal + graph
- `sentinel-scientific-organism.png` — many-tab pane groups, denser inspector, graph banner

Lineage: TouchDesigner / ComfyUI — dense, dark, professional, everything observable.

## Design principles

1. **Everything observable** — every node shows a thumbnail of its output; every pane shows a
   status/cost readout. No black boxes, no spinners without numbers.
2. **The graph is the program** — viewports are taps on wires; users rewire instead of re-running.
3. **Inspector bound to selection** — click a node → its parameters appear as compact rows.
4. **Density over whitespace** — this is a tool, not a landing page. Small type, tight rows,
   thin borders, minimal padding.
5. **Dark always** — no light theme. No pure white, no pure black.

## Layout map (M0)

Dockview, gaps ≤ 4px, panes fill the window edge-to-edge:

```
+--------------------+--------------------------------+-------------+
| Depth 2D           | Viewport 3D                    | Inspector   |
| (colormapped depth)| (point cloud, orbit/fly)       | (params)    |
+--------------------+--------------------------------+             |
| Graph (React Flow, full width)                      |             |
+-----------------------------------------------------+-------------+
```

All panes draggable/resizable/closable via Dockview. Graph row ~40% height; Inspector ~280px.

## Design tokens (CSS variables, defined once in `app/src/theme.css`)

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#0d0d0f` | window background |
| `--bg-pane` | `#151517` | pane body |
| `--bg-header` | `#1a1a1d` | pane tab bars, node headers base |
| `--bg-node` | `#1e1e21` | node card body, inspector rows |
| `--border` | `#2a2a2e` | 1px borders everywhere |
| `--text` | `#d4d4d8` | primary text |
| `--text-dim` | `#8a8a90` | labels, hints, units |
| `--accent-run` | `#4ade80` | running/ok status, cost readouts |
| `--accent-busy` | `#f59e0b` | pending/stale/warm-up states |
| `--accent-err` | `#ef4444` | errors, destructive buttons |
| `--slider` | `#e05252` | slider thumbs/filled tracks (Sentinel red) |
| `--font-ui` | `"Inter", system-ui` | labels, 11–12px |
| `--font-mono` | `"JetBrains Mono", ui-monospace` | numbers, readouts, terminal |

Port/wire colors (typed ports — wire inherits source port color):

| Port type | Color |
|---|---|
| `frames` | `#d8d8d8` |
| `depth_field` | `#5aa0e8` |
| `point_cloud` | `#4ade80` |
| `plane` | `#f3c969` |
| `selection` | `#fb7185` |
| `measurement` | `#e8a95b` |
| `splat` | `#c084fc` |
| `camera` | `#e879a0` |
| `scalar` | `#f59e0b` |

## Component specs

**Pane chrome** — tab strip ≤ 28px tall, 11px labels, close ✕ per tab. Pane groups hold many
tabs side by side (reference shows 8+ in one group), overflowing horizontally rather than
shrinking. Directly below the tab strip, a **control row**:

- left: `Running` in `--accent-run` + elapsed in mono (`11.8 ms`, `0.0 ms`)
- right: `Remove` and `Pause` buttons — every pane is individually pausable

Below that, an **OUTPUT row**: the literal label `OUTPUT`, then toggle chips selecting which
output is displayed (`Color`|`Depth`, `Out`|`Edge Map`, `Pattern Canvas`|`Accumulated Depth`) —
active chip filled, inactive chip dim. Then dim hint text in parentheses describing the
controls: `(Left-drag=orbit, wheel=zoom, X=feedback)` or a prose note about the output.

**Node card** (M2+) — width ~180px:

- Colored header, category hue, ~35% sat (purple = source/generator, teal = analysis,
  magenta/red = compositing in the reference). Name left, small `A` / `P` badges right.
- Named port rows: label + dot, inputs left-aligned, outputs right-aligned, dot colored by type.
  Ports are labelled text rows (`Video Input`, `Spawn Points`, `Detections`), not bare dots.
- Output thumbnail filling the card width, below the ports.
- Footer readout in mono, bottom-left: elapsed ms (`15.3ms`, `0.0ms`).
- Selected: 1px `--accent-run` outline; the reference also shows a yellow selection frame on
  the *thumbnail* of the selected node.

**Graph canvas** — warm dark brown-grey, not neutral black (distinct from pane bodies so the
graph reads as its own surface). Dot grid. A **banner** across the top: pipeline title in caps
(`SCIENTIFIC ORGANISM / LIVE INSTRUMENT`) plus a one-line prose description of the chain
(`Authored source → native Features → temporal agents → …`). A `Fit` control sits top-right.

**Wires** — pale near-white by default with light-blue accents for active/typed connections,
drawn as long bezier curves. They pass *over* nodes, not behind.

**Inspector** — collapsible sections (▼ header rows), rows are `label — control — value`:
label 11px `--text-dim` left, numeric value right in mono, control filling the middle. Controls
are **mixed**, not sliders only: sliders with `--slider` thumbs, dropdowns (`Shi-Tomasi`, `Fast`,
`Off`), checkboxes, and inline row-level checkbox groups (`Tasks: ☑ Blob ☑ Corner ☑ Line`).
Sections are numerous and tightly stacked (reference shows 6+ visible at once). Section order
mirrors node port/param order. A `▾ Output Routing` section and a `Presets` section with
`+ Save New` sit at the bottom.

**Status bar** (bottom, 24px) — left: GPU instance chip (`GPU: cold` gray / `warming…`/`busy`
amber pulse / `warm` green), then live VRAM (`VRAM 8.53 GiB / 24.00 GiB`), then last-run summary
(`16f · 7.7s GPU`); right: session cost ticker in mono (`$0.14`). The reference's terminal pane
carries the same idea for the agent (`32% · $22.85`) — cost and capacity are always on screen.

**VRAM readout** — a horizontal budget bar against the L4's 24 GiB, green below 75%, amber to
92%, red above. During a run it tracks live usage; idle it shows the last peak. Predicted (not
yet measured) values are rendered as a **range**, never a single number, and labelled
`unmeasured` — see the VRAM-honesty rule below.

**Buttons** — flat, 1px border, no gradients; destructive = `--accent-err` text, not filled.

## Honesty rules

These are design constraints, not just copy guidelines:

1. **Never render an unmeasured quantity as a precise number.** The VRAM predictor is fitted to
   one datapoint against a two-unknown model — it is underdetermined, so the UI shows the
   bracket (`11.50 GiB – 33.95 GiB`) and says `unmeasured`. Replace with a point value only once
   `scripts/vram-sweep.sh` has ≥3 real measurements.
2. **Never silently alter the user's settings.** When the frame cap forces a lower sampling FPS,
   say so, show the arithmetic, and state that the frames still span the whole clip.
3. **Distinguish mock from real.** Fixture/mock-backed readouts are labelled (`NVIDIA L4 (mock)`)
   so a screenshot can never be mistaken for a real GPU run.

## Acceptance checklist (design-review QA runs this)

1. App background ≤ `#151517`; no white surfaces; no default-blue links or focus rings.
2. Four panes present (Depth 2D, Viewport 3D, Graph, Inspector) with Dockview tabs; drag-resize works.
3. Pane tab strip ≤ 28px; labels 11–12px; density comparable to reference screenshot.
4. Viewport 3D renders the fixture point cloud; drag-orbit visibly changes the view; overlay shows point count; axis gizmo visible.
5. Depth 2D shows turbo-colormapped depth from fixture NPZ with min/max meters legend.
6. Every pane has a live status row (numbers, not just text).
7. No horizontal window scroll at 1280×800; gaps between panes ≤ 4px.
8. Fonts: UI text ≤ 12px, numeric readouts in mono; no font-size > 14px except empty-state hints.
9. Side-by-side squint test vs `docs/reference/`: comparable darkness, density, contrast.
10. Inspector exposes every inference param (fps, process res, max frames, ref view) with
    mixed control types, and each shows its current value in mono on the right.
    *Splats were removed on 2026-08-04 — no measurement node consumes them (see PROGRESS.md).*
11. VRAM is visible in both the inspector and the status bar; during a run the live bar moves.
12. Unmeasured predictions render as a labelled range, never a bare number (honesty rule 1).
13. A capped frame plan explains itself in-place, showing the arithmetic (honesty rule 2).
14. Mock-backed readouts are labelled as mock (honesty rule 3).
