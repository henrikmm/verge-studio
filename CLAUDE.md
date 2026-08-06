# Verge Studio — Claude Code

@AGENTS.md

The shared instructions above are the whole agreement; this file only adds what is specific to
Claude Code.

- **The design-review workflow lives at `.agents/skills/design-review/SKILL.md`.** The skill at
  `.claude/skills/design-review/` is a pointer to it, so both tools grade the interface against
  the same checklist. Run it after any change you can see on screen.
- **Verify in the browser pane rather than asking the user to look.** `.claude/launch.json`
  already defines the dev server; start it with the preview tool, never with a shell command.
- Coordinate-based clicks in the browser pane land correctly (measured 2026-08-04) — the older
  note about them being mis-scaled is obsolete. Screenshots do capture the 3D canvas, so a drag
  can be verified by comparing two of them.
