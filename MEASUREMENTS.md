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

### M3b raw results — 2026-08-03

Each cell is `raw DA3 measurement (signed error) ± internal spread`, in metres. “Internal
spread” is the local patch roughness; it is **not** a claim that the total measurement is that
accurate. Every frozen error is much larger than that spread, which shows that reconstruction
bias, floor direction and operator endpoint placement dominate local point noise in this clip.

These values supersede both earlier M3b passes. The first mixed DA3's raw NPZ coordinates with
the transformed GLB coordinates, displacing the pink 3D evidence from its 2D source. The second
fixed that registration but let a thin tilted slice win as the floor: its 2 cm fit error looked
good even though only 0.7% of the 504px cloud supported it. The current pass keeps every point
in the GLB frame and compares floor hypotheses using support, tilt, below-floor mass and fit
error together. B2 and B5 are floor-to-top endpoint extents; B1 and B3 are object extents. For
all four, the plane supplies the vertical direction; the painted lower endpoint supplies the
measurement origin.

The floor diagnostics below are part of the result, not decoration. “Support” is the fraction
of the sampled scene close to the chosen plane. A small fit error without meaningful support is
not accepted as evidence of a floor.

| Setting | Floor support | Tilt from camera up | Plane RMSE | Chosen proposal |
|---|---:|---:|---:|---|
| **504px · 112f** | **14.6%** | 11.8° | **0.012 m** | whole cloud |
| 356px · 256f | 10.5% | 15.4° | 0.018 m | whole cloud |
| 252px · 256f | 2.7% | **9.1°** | 0.020 m | lower region |

### Why only the two endpoints can be enough

The current object measurements are vertical extents. The brush does not have to outline every
pixel of the object: it needs enough trustworthy 3D points near the intended lower and upper
endpoints. The measurement takes robust lower and upper height percentiles along the fitted
floor direction. The clean line shown in 3D is the resulting ruler between those height bands;
it is not invented geometry and it does not mean the pixels between the endpoints were inferred.

A connecting brush stroke is still useful when it stays on the object: it supplies more points,
makes accidental endpoint selection easier to see, and helps pass the minimum-density check. But
two compact endpoint patches can be sufficient. One painted video frame also can be sufficient:
that frame has its own predicted depth and camera pose, which place its selected pixels into the
same 3D coordinate system as the point cloud reconstructed from all frames.

| Object | Truth | 504px · 112f | 356px · 256f | 252px · 256f |
|---|---:|---:|---:|---:|
| B1 door-leaf extent | 2.100 | 1.887 (-0.213) ±0.037 | 1.557 (-0.543) ±0.032 | 1.243 (-0.857) ±0.027 |
| B2 floor → table | 0.750 | 0.704 (-0.046) ±0.003 | 0.583 (-0.167) ±0.007 | 0.551 (-0.199) ±0.021 |
| B3 tower extent | 0.450 | 0.407 (-0.043) ±0.026 | 0.355 (-0.095) ±0.027 | 0.301 (-0.149) ±0.020 |
| B4 monitor + stand extent | 0.534 | unavailable | unavailable | unavailable |
| B5 floor → monitor top | 1.284 | 1.190 (-0.094) ±0.017 | 0.967 (-0.317) ±0.016 | 0.950 (-0.334) ±0.029 |

B4 is deliberately absent: its stand/table contact is hidden by the laptop. Guessing that
endpoint would make the table more complete and the evidence less honest.

⚠️ **Every cell above is n=1** — one painting of one mask, kept because the app until
2026-08-04 discarded the previous row whenever a new one was recorded. The ± is patch
roughness, not repeatability.

**The 504px column is superseded** by the three-trial means in the next section: B1 **2.020**,
B2 **0.698**, B3 **0.427**. The B1 row above (1.887 m) is the largest single distortion in this
file — it made DA3's scale error look ~11% when three trials put it near 3%. The historical rows
are kept because the resolution verdict below was computed from them, not because they are the
best estimate. B5 has not been re-measured under the trial protocol and its 356/252px columns
are still n=1 throughout.

**Operator refinement on 2026-08-03:** the user repainted the 504px door endpoints and the app
reported approximately **2.0 m**, about **0.10 m / 4.8%** below the 2.10 m truth. This is the
best observed door result, but it is intentionally not substituted into the table yet: the
exact value and exported mask were not captured in this repository. The change from 1.887 m to
about 2.0 m proves that endpoint placement is now a material part of the remaining error budget.
The 504px table and tower results above are already within 0.046 m and 0.043 m of truth.

### Repeatability — the trial protocol (2026-08-04)

Two numbers from the same reconstruction, the same floor and the same operator: the door read
**1.887 m** on one painting and **≈2.0 m** on another. Nothing about the model changed. That
~0.11 m gap is operator endpoint placement, and it is larger than the 0.061 m raw holdout MAE
the 504px run is credited with — so it is currently the least-understood term in the error
budget, and the app has been displaying a ±0.037 m patch roughness beside it.

**Why this has to be frozen before M3c.** Automatic selection is worth having only if it makes
endpoints *more repeatable*. Judging a click-prompted mask against a benchmark whose own spread
is unknown proves nothing: if manual spread is ±0.03 m then matching it is a win, and if manual
spread is ±0.12 m then matching it is noise.

**Protocol.** For each object, at one setting:

1. Clear the mask completely. Reusing the previous mask measures the code, not the operator —
   the app detects an unchanged mask digest and flags the trial rather than counting it.
2. Repaint the endpoints from scratch, without first reading the previous trial's number.
3. Record. The trial keeps its own mask (RLE + digest), painted-pixel count, selected-point
   count, floor diagnostics and time-to-measure.
4. Three trials minimum per object. Below three, the app shows the spread greyed out and NMAD
   is withheld — two points have a separation, not a dispersion.

Report `max − min` as the operator spread. At n=3–5 it is the honest statement; NMAD is
carried alongside for continuity with the geometry code but is thin at these counts.

**Scope:** B1, B2 and B3 at **504px · 112f**, which is the decided default. B4 stays
ungraded (occluded stand contact) and B5's truth is derived from B2 + B4, so neither is an
independent trial subject. A small number of 356px door trials are worth adding as a check that
spread is not itself resolution-dependent.

**Collected 2026-08-04**, 504px · 112f, nine trials, three per object, each with its own mask
(nine distinct digests — no trial reused an earlier mask). Source:
`verge-m3b-measurements-2.json`, schema 0.2.0.

| Object | Truth | n | Mean | Median | Spread (max−min) | NMAD | Median time | Error |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| B1 door-leaf extent | 2.100 | 3 | 2.0197 | 2.0184 | **0.0059** | 0.0013 | 5 s | −0.080 (−3.8%) |
| B2 floor → table | 0.750 | 3 | 0.6983 | 0.6971 | **0.0041** | 0.0005 | 10 s | −0.052 (−6.9%) |
| B3 tower extent | 0.450 | 3 | 0.4275 | 0.4276 | **0.0009** | 0.0005 | 5 s | −0.023 (−5.0%) |

#### Finding 1 — operator placement is not the noise term. The hypothesis was wrong.

The premise for this study was that the 1.887 m → ≈2.0 m door swing was operator jitter of order
0.1 m. It is not. Within a sitting, the same operator reproduces an endpoint to **1–6 mm**, which
is 15–90× *smaller* than the residual error against truth. Endpoint placement is one of the most
repeatable parts of this pipeline, not the least.

#### Finding 2 — the frozen rows were a different, worse operator, and the error is identified

Comparing the three-trial means against the frozen n=1 rows from 2026-08-03, same setting:

| Object | Frozen (n=1) | Trial mean | Shift | Within-session spread | Ratio |
|---|---:|---:|---:|---:|---:|
| B1 | 1.887 | 2.020 | **+0.133** | 0.0059 | **23×** |
| B2 | 0.704 | 0.698 | −0.006 | 0.0041 | 1× |
| B3 | 0.407 | 0.427 | **+0.021** | 0.0009 | **24×** |

**The cause is known, and it is not operator variance.** The frozen rows were painted in an
earlier *agent* session, and on B1 that mask's lower endpoint never reached the bottom of the
door leaf — confirmed by the user, 2026-08-04. A short mask measures a short door. The +0.133 m
is one identifiable placement mistake, not scatter, and it does not belong in an uncertainty
budget. Two operators were being compared, and one of them was wrong.

**The dangerous part is that the wrong answer looked healthy.** 1.887 m arrived with a ±0.037 m
patch roughness, a supported floor, a 2 cm plane RMSE and a plausible-looking number. Nothing in
the reported statistics distinguished it from the correct 2.020 m. Only looking at where the mask
sat did. This is the case for the live 3D highlight, and the argument that an automatic mask must
be able to *abstain* rather than quietly return a confident, short answer.

⚠️ Still do not quote the 1–6 mm spreads as the measurement uncertainty. They bound one sitting
of one operator who knows this scene. They say nothing about a mask placed wrongly — which is the
failure that actually occurred here, and which repeatability by construction cannot detect.

#### Finding 3 — what is left is bias, and bias is correctable

All three errors are negative and of similar relative size (−3.8%, −6.9%, −5.0%). With the noise
this small, the residual is dominated by systematic scale, which is exactly the error type the
error model is built to remove:

| | Frozen 2026-08-03 (n=1) | Trial means 2026-08-04 |
|---|---:|---:|
| slope `a` | 0.893 | **0.969** |
| offset `b` | +0.024 m | −0.018 m |
| residual RMS | 0.016 m | 0.008 m |
| B1 scale factor | 1.113 | **1.040** |
| raw MAE, B2+B3 only | 0.0445 m | **0.0371 m** |
| door-scaled MAE, B2+B3 | — | **0.0147 m** |

The slope moving 0.893 → 0.969 is the substantive change: with the door measured as an extent
at 2.020 m rather than 1.887 m, **DA3's raw metric scale on this clip is ~3% low, not ~11% low.**
The frozen door row was carrying most of the apparent scale error.

The residual RMS of 0.008 m is **not** a noise floor: three points fitted with two parameters
leaves one degree of freedom. It is a consistency statement, nothing more.

#### Finding 4 — the floor fit is deterministic on real data

All nine trials report byte-identical floor diagnostics (support 0.145536, tilt 11.84694728°,
RMSE 0.01231087 m, below-floor 0, gravity coherence 0.94942707). M3a asserted determinism with a
unit test; nine independent user-driven recordings confirm it end to end. `confidenceThreshold`
varies per object (2.13 / 4.57 / 3.84) and is constant across each object's three trials, as
expected for a percentile taken over the selected pixels.

#### Consequence for M3c

Automatic selection was going to be justified by making endpoints more repeatable. At 1–6 mm and
a 5–10 s median paint, there is almost no headroom on either axis. The case for M3c has to be
made on ease and on scenes where a brush is impractical, not on precision — and the measured
baseline it must beat is in the table above.

### Resolution/frame-count verdict

Raw MAE is over the three observable holdouts B2, B3 and direct B5. “Door-scaled” multiplies
every predicted length by the B1 truth/raw factor. That is the mathematically consistent use
of a scale correction: translation-independent extents are still lengths. The correction
remains secondary evidence—raw DA3 is still the primary output.

⚠️ **The door-scaled columns below still use the frozen 1.887 m door observation**, which the
2026-08-04 trials superseded with 2.020 m. The 504px scale factor is really **1.040**, not 1.113.
The three-run *ranking* is unaffected — only 504px has been re-measured under the trial protocol,
and it was already the winner on both raw and corrected error — but the 504px door-scaled figure
below is stale. Recomputing the 356/252px rows honestly needs their doors re-measured too, which
is another nine trials nobody has painted yet.

| Setting | GPU | B1 scale factor | Raw holdout MAE | Door-scaled MAE |
|---|---:|---:|---:|---:|
| **504px · 112f** | 31.27 s | 1.113 | **0.061 m** | **0.026 m** |
| 356px · 256f | 40.83 s | 1.349 | 0.193 m | 0.029 m |
| 252px · 256f | 16.47 s | 1.689 | 0.227 m | 0.187 m |

**Decision:** use **504px · 112 frames** as the default on this clip. It now wins both raw and
door-scaled holdout error, costs less GPU time than 356px, and preserves the PC tower well. The
356px run still responds consistently to the door correction, but it is slower and much worse
before calibration. At the same 256-frame coverage, 252px loses too much spatial detail.
Door scaling remains a diagnostic rather than silently replacing raw DA3.

### Current-run raw error models

The fit uses observable B1, B2, B3 and direct B5. B5's truth is derived, so treat these as
diagnostic fits rather than a four-independent-object laboratory calibration.

| Setting | slope `a` | offset `b` | residual RMS | mean AbsRel | max raw error |
|---|---:|---:|---:|---:|---:|
| 504px · 112f | 0.893 | +0.024 m | 0.016 m | **8.3%** | **0.213 m** |
| 356px · 256f | 0.727 | +0.033 m | **0.004 m** | 23.5% | 0.543 m |
| 252px · 256f | 0.566 | +0.112 m | 0.071 m | 31.6% | 0.857 m |

The 356px run is internally close to a single affine calibration, but **0.004 m is not yet a
noise-floor estimate**: there are only four painted values, and B5's truth is derived from B2
and B4. The useful result is narrower: calibration looks worth testing on a second clip, while
the much better raw 504px result shows why the app must continue showing raw and corrected
values side by side.

### What M3b now establishes — and what it does not

**Established on clip B:** the pipeline can take sparse 2D endpoint evidence, place it on the
correct 3D reconstruction, recover a supported floor direction, measure extents, and audit the
result against tape measurements. At 504px, the best observed errors are roughly 0.10 m on the
2.10 m door and 0.04–0.05 m on the table and PC tower. This is good enough to justify automating
the evidence selection rather than replacing the geometry pipeline.

**Not established yet:** a universal accuracy figure across new rooms, phones, camera motion,
floor visibility, or outdoor terrain. The benchmark contains one primary clip and one operator.

**Updated 2026-08-04 by the trial study:** short-term repeatability *is* now established, and it
is excellent (1–6 mm). What is still not established is between-sitting repeatability — the
B1/B3 shifts of 23–24× the within-sitting spread show that variation exists and that back-to-back
trials cannot measure it. A second capture with changed camera orientation and path remains
untested, and remains the larger risk.

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
- [ ] Record and export the exact user-refined ~2.0 m B1 observation; do not recalculate the
      door-derived scale factor from the rounded recollection.
- [ ] Draw B1/B2/B3 independently at least three times and retain every result instead of
      replacing the previous observation. Report endpoint/operator spread separately from the
      point-cloud internal spread.
- [ ] Freeze the benchmark masks with a mask revision or digest tied to every recorded row.
      B4 remains ungraded until another view exposes the stand contact.
- [ ] Repeat the primary measurements on a second full video with a different camera path and
      orientation before stating cross-video accuracy.
- [ ] A taller-than-2.10 m reference (floor to ceiling) would extend the calibration curve
      further and tighten the fitted slope. Optional.
