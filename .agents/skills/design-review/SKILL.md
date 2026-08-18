---
name: design-review
description: Visual QA loop — drive the running app in a browser, screenshot it, and grade it against the acceptance checklist in docs/DESIGN.md and this app's own reference captures in docs/reference/. Run after any change you can see on screen.
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
6. **Compare against `docs/reference/`.** Those captures are this app, not a target to grow into,
   so read the one showing the *same state* as your screenshot and name concrete mismatches
   ("our headers are twice as tall"), never impressions. A mismatch is a finding in one of two
   directions: usually the app has drifted, occasionally the capture is stale. Say which you
   think it is. Redrawing them is `node scripts/capture-reference.mjs`, and it needs the user's
   agreement first — see the head of `docs/DESIGN.md` for why.
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

Grade every item. **Write down the ones that carry information.**

Add a dated entry at the **top** of `docs/design-review-log.md`: the commit, the viewport size,
what changed in this pass, then

- every item that **failed**, with what you measured;
- every item whose grade **changed** since the last pass, in either direction;
- every item you measured **for the first time**, with the number;
- one line collapsing the rest — *"Items 1–9, 11–14, 16–20, 22–28: PASS, unchanged from
  2026-08-09"*;
- what you fixed during the pass, and anything surprising that happened while grading.

An entry written out in full runs about fifty lines, of which roughly eight are new: the rest is
`N/A` for a pane the change never touched, and `PASS, unchanged` for one nobody looked at. Both
are true and neither is evidence. Grading every item is what makes a regression visible; writing
every item down is what makes the useful lines hard to find.

Anything found and left unfixed becomes a task in `docs/TASK.md` — the log records evidence,
never a backlog.
