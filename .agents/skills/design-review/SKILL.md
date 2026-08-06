---
name: design-review
description: Visual QA loop — screenshot the running app in the browser pane and grade it against docs/DESIGN.md's acceptance checklist and the docs/reference/ screenshot. Run after any UI change.
---

# Design review

1. Start/reuse the dev server: `preview_start` with the `app` launch config (port 5173). If
   `.claude/launch.json` is missing, create it with `npm run dev` in `app/`.
2. Resize the browser pane to desktop (1280×800).
3. Take a full screenshot, then one zoomed screenshot per pane (Depth 2D, Viewport 3D, Graph, Inspector).
4. To verify interactivity (checklist item 4): screenshot the 3D viewport, drag inside it
   (`left_click_drag` across the pane), screenshot again — the two must differ visibly.
5. Grade EVERY numbered item of the acceptance checklist in `docs/DESIGN.md` as PASS / FAIL /
   N/A-M0 with one-line evidence each (measured pixel values, counts, or "seen in screenshot").
   Use `read_page`/`javascript_tool` to measure computed styles when eyeballing is not enough
   (e.g. `getComputedStyle(document.body).backgroundColor`, tab strip `offsetHeight`).
6. If `docs/reference/` contains a screenshot, Read it and do the squint test (item 9):
   compare darkness, density, contrast — note concrete mismatches (e.g. "our pane headers are
   ~2× taller", "background too blue").
7. Output: a fix-list ordered by severity (checklist item → what's wrong → suggested fix).
   If everything passes, say so and record the pass (date + commit) in `docs/design-review-log.md`.

Do not fix things inside this skill — report, then fix in the main loop and re-run.
