# Donor staging

Verbatim copies from an earlier project (`~/dev/Motiva_Challenge`), kept here as reference while
porting ideas across.

**Rules:**

- Application code never imports anything from this directory. Ported code is rewritten in
  TypeScript under `app/` or `geometry/`, and pinned against the original by a test where the
  behaviour has to match exactly — see `app/src/graph/cache-key.test.ts`, which checks the ported
  content-hash against vectors generated from the donor file itself.
- The original repository is **read-only**. Never modify anything in it.
- Nothing here is authoritative about how this project works. `../docs/REGISTRY.md` is.

What remains genuinely useful: the cell-and-percentile approach to measuring height over an area,
which is the template for vegetation measurement (see the grass task in `../docs/PROGRESS.md`).
