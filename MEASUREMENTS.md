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
| B1 | Door leaf | physical leaf, bottom edge → top edge | **2.10 m** | start of clip, open leaf visible | The long scale reference. The measurement is an extent, not a floor-referenced top. |
| B2 | Table / desk | height, floor → tabletop | **0.750 m** | throughout | Confirmed by the user as *height* (2026-08-01). |
| B3 | PC tower | own height, tabletop contact → tower top | **0.45 m** | ~0:26 | Confirmed by the user to stand **on the tabletop** (2026-08-02). Measured as a translation-independent extent. |
| B4 | Samsung G5 curved monitor | stand/table contact → top of screen | **0.534 m** | ~0:14, 0:32 | The laptop occludes the stand contact in this clip, so M3b does not grade it. |
| B5 | Monitor top above floor | floor → top of screen | **1.284 m** | — | *Derived*: B2 + B4. A composition cross-check, not a fifth independent tape measurement. |

### Why this set is better than a single calibration reference

Four tape-measured dimensions spanning **0.45 → 2.10 m (a 4.7× range)** can define a
**calibration curve**. In this clip B4 is not visually observable, while B5 is the derived
B2+B4 composition check. Fitting `predicted = a · truth + b` over the observable rows
separates the two error types that matter:

- **`a` ≠ 1** → a systematic *scale* bias. Correctable, per clip.
- **`b` ≠ 0** → a systematic *offset* (e.g. the ground plane sitting too low). Correctable.
- **residual scatter** → the irreducible *noise* floor. Not correctable; averaging helps.

That decomposition is the real deliverable of M3. "Is DA3 accurate?" is much less useful than
"how much of DA3's error is bias we can remove, and how much is noise we cannot?"

### M3b raw results — 2026-08-02

Each cell is `raw DA3 measurement (signed error) ± internal spread`, in metres. “Internal
spread” is the local patch roughness; it is **not** a claim that the total measurement is that
accurate. Every error is much larger than that spread, which shows that systematic scale/floor
bias dominates local point noise in this clip.

These values supersede the first M3b pass. That pass back-projected the painted pixels in the
raw NPZ coordinate frame but displayed and fitted them against DA3's transformed GLB frame.
The pink 3D evidence was therefore displaced from its 2D source. The current pass applies the
GLB's recorded `hf_alignment` transform to both selected points and the camera-derived up
direction. B2 and B5 also use the user-confirmed endpoint stroke (floor patch ↔ upper edge), so
their height does not depend on the automatic plane's vertical offset.

| Object | Truth | 504px · 112f | 356px · 256f | 252px · 256f |
|---|---:|---:|---:|---:|
| B1 door-leaf extent | 2.100 | 1.522 (-0.578) ±0.035 | 1.542 (-0.558) ±0.034 | 1.237 (-0.863) ±0.025 |
| B2 floor → table | 0.750 | 0.629 (-0.121) ±0.024 | 0.576 (-0.174) ±0.004 | 0.540 (-0.210) ±0.017 |
| B3 tower extent | 0.450 | 0.401 (-0.049) ±0.030 | 0.340 (-0.110) ±0.028 | 0.282 (-0.168) ±0.016 |
| B4 monitor + stand extent | 0.534 | unavailable | unavailable | unavailable |
| B5 floor → monitor top | 1.284 | 1.453 (+0.169) ±0.039 | 1.021 (-0.263) ±0.026 | 0.890 (-0.394) ±0.018 |

B4 is deliberately absent: its stand/table contact is hidden by the laptop. Guessing that
endpoint would make the table more complete and the evidence less honest.

### Resolution/frame-count verdict

Raw MAE is over the three observable holdouts B2, B3 and direct B5. “Door-scaled” multiplies
every predicted length by the B1 truth/raw factor. That is the mathematically consistent use
of a scale correction: translation-independent extents are still lengths. The correction
remains secondary evidence—raw DA3 is still the primary output.

| Setting | GPU | B1 scale factor | Raw holdout MAE | Door-scaled MAE |
|---|---:|---:|---:|---:|
| **504px · 112f** | 31.27 s | 1.380 | **0.113 m** | 0.314 m |
| 356px · 256f | 40.83 s | 1.362 | 0.182 m | **0.051 m** |
| 252px · 256f | 16.47 s | 1.698 | 0.257 m | 0.141 m |

**Decision:** use **504px · 112 frames** as the default for an uncalibrated/raw workflow on this
clip: it has the lowest raw holdout error, costs less GPU time than 356px, and preserves the PC
tower particularly well. The 356px run is the better *calibrated candidate*—one door factor
reduces its holdout MAE to 0.051 m—but the same correction makes the 504px run worse. That
instability is exactly why door scaling stays a diagnostic rather than silently replacing the
raw result. At the same 256-frame coverage, 252px loses too much spatial detail.

### Current-run raw error models

The fit uses observable B1, B2, B3 and direct B5. B5's truth is derived, so treat these as
diagnostic fits rather than a four-independent-object laboratory calibration.

| Setting | slope `a` | offset `b` | residual RMS | mean AbsRel | max raw error |
|---|---:|---:|---:|---:|---:|
| 504px · 112f | 0.716 | +0.181 m | 0.206 m | 16.9% | 0.578 m |
| 356px · 256f | 0.731 | +0.033 m | **0.030 m** | 23.7% | 0.558 m |
| 252px · 256f | 0.569 | +0.086 m | 0.054 m | 34.3% | 0.863 m |

The 356px run is internally close to a single affine calibration, but **0.030 m is not yet a
noise-floor estimate**: there are only four painted values, and B5's truth is derived from B2
and B4. The useful result is narrower: calibration looks worth testing on a second clip, while
the inconsistent 504px correction proves that the app must continue showing raw and corrected
values side by side.

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

- [x] **B3** stands on the tabletop; measure its own 0.45 m extent.
- [x] Confirm B2's intended evidence: tabletop edge + visible floor patch; a connecting stroke
      is valid. This is an endpoint measurement, not semantic segmentation of the whole table.
- [ ] Refine/freeze the remaining pink operator masks before treating this as a repeatable
      benchmark. B4 remains ungraded until another view exposes the stand contact.
- [ ] A taller-than-2.10 m reference (floor to ceiling) would extend the calibration curve
      further and tighten the fitted slope. Optional.
