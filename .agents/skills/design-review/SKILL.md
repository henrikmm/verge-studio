---
name: design-review
description: Visual QA loop — drive the running app in a browser, screenshot it, and grade it against the acceptance checklist in docs/DESIGN.md and the reference captures in docs/reference/. Run after any change you can see on screen.
---

# Design review

The canonical workflow, shared by every tool. Tool-specific adapters point here.

1. **Start or reuse the dev server** on port 5173 (`npm run dev` in `app/`). If your tool has a
   preview mechanism, use it rather than a plain shell command.
2. **Set the viewport to 1280×800.** Every measurement in the checklist assumes it.
3. **Capture the whole window**, then one close-up per pane: Depth 2D, Viewport 3D, Graph,
   Inspector, Objects, Runs.
4. **Grade every numbered item** of the acceptance checklist in `docs/DESIGN.md` as PASS, FAIL or
   N/A, each with one line of evidence — a measured pixel value, a count, or "seen in screenshot".
   Measure rather than eyeball when it is close: read computed styles, element heights, scroll
   widths. Guessing at a threshold defeats the point of having one.
5. **Verify the interactions the checklist names**, not just the appearance:
   - Orbit: screenshot the 3D viewport, drag inside it, screenshot again — the two must differ.
   - Parameter refresh: change a control in the Inspector and confirm the graph catches up on its
     own, with no other interaction, and that no costly node starts.
   - Wire selection: click a wire, confirm it highlights, press Backspace, confirm only that wire
     disappeared.
6. **Squint test.** Read the reference captures in `docs/reference/` and compare darkness, density
   and contrast. Name concrete mismatches ("our headers are twice as tall"), not impressions.
7. **Report a fix-list ordered by severity**: checklist item → what is wrong → suggested fix.

**Do not fix anything inside this workflow.** Report, fix in the main loop, then re-run.

## When automation cannot do it

Some checks need a hand — a port handle is about 8 px, and an automated drag that misses pans the
canvas instead, which looks exactly like a rejected connection.

When you hit one, follow the human-gateway protocol in `AGENTS.md`: get the app into the exact
state where the user's single action is all that is missing, zoom in so the target is large, ask
for that one action in concrete terms, wait, then finish the verification yourself. Do not record
the item as passed, and do not leave the write-up to the user.

## Recording the result

Add a dated entry at the **top** of `docs/design-review-log.md` with the commit it refers to, the
viewport size, the grade for every item, and what was fixed during the pass. Anything found and
left unfixed becomes a task in `docs/PROGRESS.md` — the log records evidence, never a backlog.
