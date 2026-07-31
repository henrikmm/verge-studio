# Verge Studio — UI design specification

Visual north star: Spencer Sterling's **Sentinel** (screenshot in `docs/reference/`; if absent,
this document stands alone). Lineage: TouchDesigner / ComfyUI — dense, dark, professional,
everything observable.

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
| `splat` | `#c084fc` |
| `camera` | `#e879a0` |
| `scalar` | `#f59e0b` |

## Component specs

**Pane chrome** — tab strip ≤ 28px tall, 11px labels, close ✕ per tab. Below it a one-line
status row (12px mono): e.g. `175,616 pts · 60 fps` or `Running · 11.8 ms`. Hint text
(`--text-dim`, 10px) for controls: `Left-drag orbit · wheel zoom · F fly`.

**Node card** (M2+) — width ~180px: colored header (category hue at ~35% sat) with name +
status dot (green ok / amber stale / red error); port dots on left (in) and right (out) rows,
colored by type; param summary line; output thumbnail (16:9, fills card width); footer readout
in mono (`7.7 s GPU · $0.02`). Selected: 1px `--accent-run` outline.

**Inspector** — collapsible sections (▼ header rows), rows are `label — control — value`:
label 11px `--text-dim` left, numeric value right in mono, slider filling the middle with
`--slider` thumb. Section order mirrors node port/param order.

**Status bar** (bottom, 24px) — left: GPU instance chip (`GPU: cold` gray / `warming…` amber
pulse / `warm` green); right: session cost ticker in mono (`$0.14`).

**Buttons** — flat, 1px border, no gradients; destructive = `--accent-err` text, not filled.

## Acceptance checklist (design-review QA runs this)

1. App background ≤ `#151517`; no white surfaces; no default-blue links or focus rings.
2. Four panes present (Depth 2D, Viewport 3D, Graph, Inspector) with Dockview tabs; drag-resize works.
3. Pane tab strip ≤ 28px; labels 11–12px; density comparable to reference screenshot.
4. Viewport 3D renders the fixture point cloud; drag-orbit visibly changes the view; overlay shows point count; axis gizmo visible.
5. Depth 2D shows turbo-colormapped depth from fixture NPZ with min/max meters legend.
6. Every pane has a live status row (numbers, not just text).
7. No horizontal window scroll at 1280×800; gaps between panes ≤ 4px.
8. Fonts: UI text ≤ 12px, numeric readouts in mono; no font-size > 14px except empty-state hints.
9. Side-by-side squint test vs `docs/reference/` screenshot: comparable darkness, density, contrast (skip if reference absent).
