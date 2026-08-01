# Ground truth — tape-measure values

The only numbers in this project that do not come from the model. M3 grades `MeasureHeight`
against these tables; without them there is nothing to be right or wrong about.

Source: the user, by tape measure, 2026-08-01. **Never overwrite these with predicted values** —
predictions belong in the results tables at the bottom.

⚠️ **Scale is per-clip.** A scale factor derived in one clip does not transfer to another —
monocular metric scale drifts with scene, depth range and camera parameters (the classical
"scale drift" problem). So each clip below is graded on its own, against its own references.

---

## Clip B — `test-demo-door.mp4` (the primary M3 clip)

35.57 s · 1067 frames · HEVC · **portrait** (stored 1920×1080 with `rotation=-90`, displays
1080×1920) · 55.6 MB. Same room as clip A, and it contains **every reference object plus the
door**, which is why it supersedes clip A as the grading clip.

Covered by `.gitignore`'s `*.mp4`; **never commit it.**

| # | Object | Dimension | Truth | Where in clip | Notes |
|---|---|---|---|---|---|
| B1 | Door | height, floor → top of door | **2.10 m** | ~0:20, open, floor-to-top visible | The long baseline. ~2.8× less fractional error than calibrating on the table. |
| B2 | Table / desk | height, floor → tabletop | **0.750 m** | throughout | Confirmed by the user as *height* (2026-08-01). |
| B3 | PC tower | own height | **0.45 m** | ~0:26 | ⚠️ Assumed to stand **on the tabletop**, so top-above-floor would be 0.750 + 0.45 = 1.20 m. Confirm. |
| B4 | Samsung G5 curved monitor | height, incl. stand | **0.534 m** | ~0:14, 0:32 | Stands on B2. Glossy dark screen — the hardest surface in the scene for any depth model. |
| B5 | Monitor top above floor | floor → top of monitor | **1.284 m** | — | *Derived*: B2 + B4. Checks that stacked estimates compose without drift. |

### Why this set is better than a single calibration reference

Four independently measured heights spanning **0.45 → 2.10 m (a 4.7× range)** is not just four
test cases — it is a **calibration curve**. Fitting `predicted = a · truth + b` over them
separates the two error types that matter:

- **`a` ≠ 1** → a systematic *scale* bias. Correctable, per clip.
- **`b` ≠ 0** → a systematic *offset* (e.g. the ground plane sitting too low). Correctable.
- **residual scatter** → the irreducible *noise* floor. Not correctable; averaging helps.

That decomposition is the real deliverable of M3. "Is DA3 accurate?" is much less useful than
"how much of DA3's error is bias we can remove, and how much is noise we cannot?"

### Results — filled in by M3, not before

| # | Object | Truth | Predicted | Error | ± reported | Settings |
|---|---|---|---|---|---|---|
| B1 | Door | 2.10 m | — | — | — | — |
| B2 | Table | 0.750 m | — | — | — | — |
| B3 | PC tower | 0.45 m | — | — | — | — |
| B4 | Monitor | 0.534 m | — | — | — | — |
| B5 | Monitor top above floor | 1.284 m | — | — | — | — |

**Fitted error model** (fill in once the table above is complete):

| Term | Value | Meaning |
|---|---|---|
| scale `a` | — | 1.00 = DA3's metric claim holds |
| offset `b` | — | metres; non-zero suggests a ground-plane bias |
| residual RMS | — | the noise floor after bias removal |

---

## Clip A — `test_demo.mp4` (the original room walk-through)

26.61 s · 1579 frames · 3840×2160 HEVC, landscape · 172 MB. Three DA3 fixtures already exist
for it (`fixtures/room/`), so it stays useful for comparing `process_res` settings offline —
but it has **no door**, so its longest reference is 0.750 m and its calibration baseline is
correspondingly weak.

| # | Object | Dimension | Truth | Notes |
|---|---|---|---|---|
| A1 | Table | height, floor → tabletop | **0.750 m** | Same table as B2. |
| A2 | Samsung G5 curved monitor | height, incl. stand | **0.534 m** | Same monitor as B4. |
| A3 | Monitor top above floor | floor → top | **1.284 m** | *Derived*: A1 + A2. |

### Results — filled in by M3, not before

| # | Object | Truth | Predicted | Error | Settings (frames / process_res) |
|---|---|---|---|---|---|
| A1 | Table height | 0.750 m | — | — | — |
| A2 | Monitor height | 0.534 m | — | — | — |
| A3 | Monitor top above floor | 1.284 m | — | — | — |

Three fixtures at different `process_res` already exist for this clip, so the
resolution-vs-frames question can be answered offline here at zero cloud cost.

---

## Open questions for the user

- [ ] **B3**: is the PC tower standing on the tabletop, or on the floor? Changes its
      top-above-floor from 1.20 m to 0.45 m.
- [ ] A taller-than-2.10 m reference (floor to ceiling) would extend the calibration curve
      further and tighten the fitted slope. Optional.
