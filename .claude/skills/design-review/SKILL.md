---
name: design-review
description: Visual QA loop — screenshot the running app in the browser pane and grade it against the acceptance checklist in docs/DESIGN.md and this app's own reference captures in docs/reference/. Run after any UI change.
---

# Design review

**Follow `.agents/skills/design-review/SKILL.md`.** That file is the canonical workflow and is
shared with other tools; this one exists only so Claude Code discovers it. Read it now and do
what it says.

Claude Code specifics:

- Start the dev server with `preview_start` using the `app` config in `.claude/launch.json`, never
  with a shell command. Resize to desktop (1280×800) with `resize_window`.
- Prefer `read_page` and `javascript_tool` for measurements — computed styles, `offsetHeight`,
  `scrollWidth` — and screenshots for appearance. Screenshots do capture the 3D canvas, so an
  orbit can be verified by comparing two of them.
- Coordinate-based clicks land correctly (measured 2026-08-04); the older note about them being
  mis-scaled is obsolete.
