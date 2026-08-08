# Measurements — ground truth and graded results

The only numbers in this project that do not come from a model are the tape measurements below.
Everything else is graded against them; without them there is nothing to be right or wrong about.

Tape measurements taken by the user, 2026-08-01. **Never overwrite them with predicted values.**

⚠️ **Scale does not transfer between clips.** Metric scale from this family of models drifts with
the scene, the depth range and the camera, so a correction factor derived from one clip is
meaningless in another. Each clip is graded on its own, against references visible in its own
reconstruction.

---

## Clip B — `test-demo-door.mp4`, the primary clip

35.57 s · 1067 frames · HEVC · **portrait** (stored as 1920×1080 with a rotation flag, displays as
1080×1920) · 55.6 MB. Covered by `.gitignore`; never commit it.

| # | Object | What is measured | Truth | Notes |
|---|---|---|---|---|
| B1 | Door leaf | bottom edge to top edge | **2.10 m** | The long reference. An extent, not a height above the floor. |
| B2 | Table | floor to tabletop | **0.750 m** | Confirmed as a height by the user, 2026-08-01. |
| B3 | Computer tower | its own height, from where it rests | **0.45 m** | Stands on the tabletop, so it is measured as an extent. |
| B4 | Curved monitor | stand contact to top of screen | **0.534 m** | Not gradable in this clip — the laptop hides the stand's contact point. |
| B5 | Monitor top above floor | floor to top of screen | **1.284 m** | *Derived* from B2 + B4. A composition check, not an independent measurement. |

**Why a set rather than one reference.** Four measurements spanning 0.45 m to 2.10 m — a factor of
4.7 — can define a calibration line rather than a single correction. Fitting
`predicted = a × truth + b` separates the two error types that matter: `a` away from 1 is a scale
bias, `b` away from 0 is an offset such as a ground plane sitting too low, and the leftover
scatter is the noise floor. Both biases are correctable; the scatter is not. That decomposition is
more useful than any single accuracy figure.

## Clip A — `test_demo.mp4`

26.61 s · 1579 frames · 3840×2160 HEVC, landscape · 172 MB. Same room, but it has no door, so its
longest reference is 0.750 m and its calibration baseline is correspondingly weak. It has been
superseded by clip B for grading and is kept only because three reconstructions at different
resolutions already exist for it.

| # | Object | What is measured | Truth |
|---|---|---|---|
| A1 | Table | floor to tabletop | **0.750 m** — same table as B2 |
| A2 | Curved monitor | including stand | **0.534 m** — same monitor as B4 |
| A3 | Monitor top above floor | floor to top | **1.284 m** — *derived* from A1 + A2 |

No objects on clip A have been graded. Its reconstructions exist to compare resolutions offline.

---

## Current results — clip B at 504 px, 112 frames

Collected 2026-08-04 under the trial protocol below: nine trials, three per object, each painted
from scratch with its own mask. Raw evidence: `docs/measurement-trials-2026-08-04.json`.

| Object | Truth | n | Mean | Median | Spread (max−min) | Median time | Error |
|---|---:|---:|---:|---:|---:|---:|---:|
| B1 door leaf | 2.100 | 3 | 2.0197 | 2.0184 | **0.0059** | 5 s | −0.080 (−3.8%) |
| B2 floor → table | 0.750 | 3 | 0.6983 | 0.6971 | **0.0041** | 10 s | −0.052 (−6.9%) |
| B3 tower extent | 0.450 | 3 | 0.4275 | 0.4276 | **0.0009** | 5 s | −0.023 (−5.0%) |

B4 is absent because its contact point is hidden. Inventing that endpoint would make the table
more complete and the evidence less honest. B5 has not been re-measured under this protocol.

### The error model on these three objects

| | Value | Meaning |
|---|---:|---|
| slope `a` | **0.969** | The model's raw scale on this clip is about 3% low |
| offset `b` | −0.018 m | A small fixed offset |
| residual scatter | 0.008 m | Consistency, **not** a noise floor — three points, two parameters |
| B1 scale factor | 1.040 | What door-based correction would multiply by |
| raw average error, B2 + B3 | **0.0371 m** | |
| corrected average error, B2 + B3 | **0.0147 m** | |

### Checked a second time, by an instrument with no operator in it

Added 2026-08-08. The table above rests entirely on hand-painted masks, so it could not rule out
the possibility that the masks themselves were the error. `inspect levels` measures the same table
with no mask, no segmentation model and no person: it takes every point's height above the fitted
floor and finds the surfaces as spikes in the distribution. Different evidence, different code
path, same physical quantity.

| Instrument | Floor → tabletop | Points used |
|---|---:|---:|
| Brush, three trials, one operator | 0.6983 m | ~600 |
| Height histogram, no mask | **0.6994 m** | 6,640 |
| A second reconstruction of the same clip (`20260806-173802`, 81 frames) | 0.7013 m | 6,454 |
| Tape | **0.750 m** | — |

**The two instruments agree to 1.1 mm, and two independent reconstructions agree to 1.9 mm.** So
the −5.1 cm against the tape is not the operator, not the brush and not the mask. It is in the
reconstruction. Painting is not the weak link, and the repeatability figures above are measuring
what they claim to.

The band was checked by eye as well as by number: painting 0.68–0.72 m onto frame 93 covers the
desk top and nothing else.

⚠️ **This checks B2 only.** The instrument finds surfaces, so it cannot reach B1 (a door leaf),
B3 (a tower) or B4 (a monitor). Those three remain graded on masks alone.

### Floor quality at this setting

The ground fit is part of the result, not decoration. A small fit error with little support is not
evidence of a floor.

| Setting | Support | Tilt vs camera-derived vertical | Fit error | Hypothesis chosen |
|---|---:|---:|---:|---|
| **504 px · 112f** | **14.6%** | 11.8° | **0.012 m** | whole cloud |
| 356 px · 256f | 10.5% | 15.4° | 0.018 m | whole cloud |
| 252 px · 256f | 2.7% | **9.1°** | 0.020 m | lower region |

All nine trials reported byte-identical floor diagnostics (support 0.145536, tilt 11.84694728°,
fit error 0.01231087 m, camera agreement 0.94942707). Determinism was asserted by a unit test and
is now confirmed end to end by independent user-driven recordings.

**Those diagnostics survived the 2026-08-08 selection-rule fix unchanged**, to six decimal places
and the same 9096 inliers. The rule that decides which candidate plane wins was rewritten and this
fixture's floor did not move at all, so every graded number above still stands on the plane it was
taken against. The 356 px and 252 px rows below did move, and their floors were wrong before.

---

## Resolution and frame count — the verdict

Raw error is averaged over the holdout objects, excluding whichever object supplies the
correction. "Corrected" multiplies every predicted length by the door's truth-over-raw factor,
which is mathematically consistent because extents are lengths.

| Setting | GPU time | Raw average error | Corrected average error |
|---|---:|---:|---:|
| **504 px · 112f** | 31.3 s | **0.061 m** | **0.026 m** |
| 356 px · 256f | 40.8 s | 0.193 m | 0.029 m |
| 252 px · 256f | 16.5 s | 0.227 m | 0.187 m |

**Use 504 px with 112 frames.** It wins on raw error and on corrected error, costs less GPU time
than the 356 px alternative, and preserves small objects. At the same frame count, 252 px loses
too much spatial detail.

⚠️ **The corrected column uses an earlier, worse door measurement** (1.887 m rather than 2.020 m),
because only the 504 px setting has been re-measured under the trial protocol. The ranking is
unaffected — 504 px already won on raw error, which needs no correction at all — but the corrected
figures for all three rows are stale. Recomputing them honestly needs the 356 px and 252 px doors
re-measured, which is another nine trials nobody has painted.

---

## What the trials established

**Repeatability within one sitting is excellent, and the study's own premise was wrong.** It was
designed on the assumption that the door's 1.887 m → ≈2.0 m swing was operator jitter of order
0.1 m. It is not: the same person reproduces an endpoint to **1 to 6 mm**, which is 15 to 90 times
*smaller* than the error against the tape measure. Endpoint placement is one of the most
repeatable parts of this pipeline, not the least.

**What is left is bias, and bias is correctable.** All three errors are negative and of similar
relative size (−3.8%, −6.9%, −5.0%). With scatter that small, the residual is dominated by
systematic scale — exactly the error the calibration line removes. With the door correctly at
2.020 m, the model's raw scale on this clip is about 3% low, not the ~11% a single earlier
measurement implied. That one measurement was carrying most of the apparent scale error.

**The earlier figures came from a worse operator, and the cause is known.** Compared against the
frozen single measurements from 2026-08-03, B1 moved +0.133 m and B3 +0.021 m — 23 and 24 times
their within-sitting spread. Those masks were painted in an earlier agent session, and the door
mask's lower edge never reached the bottom of the leaf (user-confirmed, 2026-08-04). That is one
identifiable mistake, not scatter, and it does not belong in an uncertainty budget.

**The dangerous case is a wrong answer that looks healthy.** The 1.887 m result arrived with a
±0.037 m local spread, a supported floor, a 2 cm fit error and a plausible number. Nothing in the
reported statistics distinguished it from the correct 2.020 m — only looking at where the mask sat
did. This is why the app highlights the selected points live in 3D while painting, and why an
automatic mask must be able to abstain rather than quietly return a confident short answer.

⚠️ **Do not quote 1–6 mm as the measurement uncertainty.** It bounds one sitting of one operator
who knows this scene, and it is by construction blind to a mask placed in the wrong place — which
is the failure that actually happened here.

### The trial protocol

For each object, at one setting:

1. Clear the mask completely. Reusing the previous one measures the code, not the operator; the
   app detects an unchanged mask and flags the trial rather than counting it.
2. Repaint from scratch, without first reading the previous trial's number.
3. Record. The trial keeps its own mask, painted-pixel count, selected-point count, floor
   diagnostics and time taken.
4. Three trials minimum. Below three, the spread is shown greyed out — two points have a
   separation, not a dispersion.

Report `max − min` as the operator spread; at three to five trials that is the honest statement.

---

## What is established, and what is not

**Established on clip B.** The pipeline takes sparse two-dimensional endpoint evidence, places it
correctly on the reconstruction, recovers a supported ground direction, measures extents, and
audits the result against tape measurements. At 504 px the best observed errors are roughly 0.08 m
on the 2.10 m door and 0.02–0.05 m on the table and tower. Short-term repeatability is 1–6 mm.

**Not established.** Any accuracy figure across new rooms, phones, camera paths, floor visibility
or outdoor terrain. The benchmark is one clip, one room and one operator.

**The largest open risk** is between-sitting repeatability. The 23–24× shifts show that variation
across sittings exists and that back-to-back trials cannot measure it. A second capture with a
different camera orientation and path remains untested.

**Two endpoint measurements can be enough**, and this is deliberate. The brush does not need to
outline every pixel: it needs trustworthy 3D points near the intended lower and upper endpoints.
The measurement takes robust height percentiles along the fitted ground direction, and the line
drawn in 3D is the ruler between those bands — not invented geometry, and not a claim that the
pixels between them were inferred. A connecting stroke still helps when it stays on the object,
because it supplies more points and makes an accidental endpoint easier to see.
