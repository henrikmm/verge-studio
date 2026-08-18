# Measurements — ground truth and graded results

The only numbers in this project that do not come from a model are the tape measurements below.
Everything else is graded against them; without them there is nothing to be right or wrong about.

Tape measurements taken by the user. **Never overwrite them with predicted values.**

⚠️ **Scale does not transfer between clips.** Metric scale from this family of models drifts with
the scene, the depth range and the camera, so a correction factor derived from one clip is
meaningless in another. Each clip is graded on its own, against references visible in its own
reconstruction. The results below are the direct evidence for that rule: the same pipeline reads
3.9–7.0% low on one clip and within 2% on two others.

**Every graded result here is an object's own vertical extent** — its own bottom against its own
top — and not its height above the fitted ground. All 26 trials are `mode: vertical_extent` with
`rulerKind: extent`; none uses `top_above_floor`. The ground plane still matters, because it
supplies the *direction* the extent is measured along, but the floor's own position cancels out of
a difference between two heights above it. That is why both plants on raised beds measured
correctly: the bed's height is in both endpoints and therefore in neither result.

**Every number in this file is replayed, not transcribed.** `scripts/collect-evidence.mjs`
back-projects each recorded mask again, refits nothing, and measures a second time; a row is
published only if the replay reproduces the stored reading. As of 2026-08-15 all 26 trials
reproduce to within 0.0002 mm, and every selected point lands back inside its own mask pixel
(0 round-trip misses). Rebuild the whole study, images included, in about a minute:

```bash
node scripts/collect-evidence.mjs
```

---

## The clips, and what was taped in each

### `RoomNewFixture.mp4` — indoor, the current primary clip

Run `20260811-161356-d387ec` · 112 frames at 2.62 fps over 42.7 s · 280×504 px · 38.9 s GPU.

| # | Object | What is measured | Truth |
|---|---|---|---|
| T1 | PC tower | its own height, from where it rests | **0.440 m** |
| T2 | Table | floor to tabletop | **0.730 m** |
| T3 | Monitor | stand contact to top of screen | **0.430 m** |

### `Test_Grass2.mp4` — outdoor, garden bed against a wall

Run `20260814-174814-b245bc` · 94 frames at 5 fps over 18.8 s · 280×504 px · 31.5 s GPU.

| # | Object | What is measured | Truth |
|---|---|---|---|
| T1 | Grass-Exe1 | a clumping ornamental plant, base of the clump to leaf tips | **0.980 m** |
| T2 | Garden light | its own height, from the stone it stands on | **0.300 m** |

### `Test_Grass.mp4` — outdoor, raised planter beside a patio

Run `20260814-174520-eebd17` · 64 frames at 5 fps over 12.8 s · 280×504 px · 21.9 s GPU.

| # | Object | What is measured | Truth |
|---|---|---|---|
| T1 | Grass | a row of clumping plants, base of the clump to leaf tips | **0.450 m** |
| T2 | Plant | base to top | **0.500 m** |

⚠️ **Neither "Grass" target is a lawn.** Both are clumping ornamental plants with leaf tips a
person can put a tape against. Lawn height is a different problem — a mown surface has no single
top to tape, so the number being claimed has to be defined first, which is `docs/TASK.md` item 4.
Nothing below speaks to it.

**Both grass truths were taped from the base of the clump** (user-confirmed, 2026-08-15), which is
the same quantity the extent measurement reports. Both clumps sit on raised beds, so a tape from
the surrounding patio would have measured something else entirely and the two would not be
comparable.

### `test-demo-door.mp4` — the earlier indoor clip

35.57 s · 1067 frames · HEVC · portrait · 55.6 MB. Fixture `door-504px-112f`.

| # | Object | What is measured | Truth |
|---|---|---|---|
| B1 | Door leaf | bottom edge to top edge | **2.100 m** |
| B2 | Table | floor to tabletop | **0.750 m** |
| B3 | Computer tower | its own height, from where it rests | **0.450 m** |
| B4 | Curved monitor | stand contact to top of screen | **0.534 m** — not gradable, the stand's contact point is hidden |

`test_demo.mp4` (26.61 s, 3840×2160, same room) has three tape truths and no graded object. Its
reconstructions exist to compare resolutions offline.

---

## Current results

Median of three independently repainted trials per target, except where noted. Collected
2026-08-13 to 2026-08-15; the door rows are the 2026-08-04 study, replayed unchanged.

| Clip | Target | Mask | Truth | n | Median | Error | | Spread |
|---|---|---|---:|---:|---:|---:|---:|---:|
| RoomNewFixture | PC tower | brush | 0.440 | 3 | 0.4455 | +0.0055 | **+1.3%** | 6.2 mm |
| RoomNewFixture | Table | brush | 0.730 | 3 | 0.7324 | +0.0024 | **+0.3%** | 11.1 mm |
| RoomNewFixture | Monitor | brush | 0.430 | 3 | 0.4286 | −0.0014 | **−0.3%** | 3.1 mm |
| Test_Grass2 | Grass-Exe1 | brush | 0.980 | 3 | 0.9983 | +0.0183 | **+1.9%** | 15.5 mm |
| Test_Grass2 | Garden light | brush | 0.300 | 3 | 0.3005 | +0.0005 | **+0.2%** | 7.2 mm |
| Test_Grass | Grass | automatic | 0.450 | **1** | 0.4751 | +0.0251 | **+5.6%** | — |
| Test_Grass | Plant | automatic | 0.500 | **1** | 0.4635 | −0.0365 | **−7.3%** | — |
| door-504px-112f | Door leaf | brush | 2.100 | 3 | 2.0184 | −0.0816 | **−3.9%** | 5.9 mm |
| door-504px-112f | Table top | brush | 0.750 | 3 | 0.6971 | −0.0529 | **−7.0%** | 4.1 mm |
| door-504px-112f | PC tower | brush | 0.450 | 3 | 0.4276 | −0.0224 | **−5.0%** | 0.9 mm |

Spread is `max − min` within one sitting. It is operator repeatability, **not** measurement
uncertainty — see the warning at the end of the protocol section.

Full per-trial table, provenance and images: `.inspect/evidence/SUMMARY.md`, rebuilt by the
command at the top of this file.

### The headline: the −5% bias was the clip, not the pipeline

The door study found every object reading 3.9–7.0% low and concluded the model's raw scale on that
clip was a few percent short. That conclusion was right about the clip and wrong as a description
of the system. **On two later clips, five brushed targets read +0.2%, +0.3%, −0.3%, +1.3% and
+1.9%.** The largest absolute error among them is 18.3 mm on a 0.98 m plant; three of the five are
under 6 mm.

Nothing in the measurement path changed between the two studies to explain this. What changed was
the capture, and the honest statement is that **this pipeline's accuracy is a property of the clip
and not a constant of the system.** A per-clip scale correction remains the right mental model;
what is new is that a well-captured clip may need no correction at all.

⚠️ **Do not read this as "the pipeline is now accurate to 2%."** Five targets on two clips, both
recorded by one person who had already learned what makes a good capture, is what it is. The
mechanism that makes one clip land at +0.3% and another at −7.0% is not identified, which means it
is also not yet controlled.

### The automatic mask is the weak row, and it measures differently

The two automatic-mask trials are the worst results in the new study (+5.6%, −7.3%) and each is a
single trial, so neither has a spread and neither should be quoted as a rate.

They are also not the same instrument as the rows above them. When the mask comes from the
browser-local segmentation model, `Measure Height` keeps only the top and bottom tenth of the
masked points by height and takes its percentiles within those tails; a brushed mask gets no such
treatment. Measured on these two trials:

| Target | Truth | Full mask, no adapter | Adapter supplies | Reported |
|---|---:|---:|---:|---:|
| Grass | 0.450 | 0.4010 (−10.9%) | +7.4 cm | 0.4751 (+5.6%) |
| Plant | 0.500 | 0.4133 (−17.3%) | +5.0 cm | 0.4635 (−7.3%) |

The adapter is doing most of the work and it is doing it in the right direction — a dense mask's
2nd and 98th percentiles genuinely do sit inside the real ends. But **5–7 cm of a 45–50 cm answer
is arriving from a correction rather than from the reconstruction**, and on this evidence it
overshoots on one target and undershoots on the other. Two trials cannot separate the adapter's
error from the reconstruction's.

### The choice of vertical matters far more outdoors

Every trial is also measured against the gravity estimate instead of the fitted floor normal, as a
control. The two never agree exactly; how much they disagree is the interesting part.

| Target class | Reading minus gravity control |
|---|---:|
| Indoor rigid objects (9 trials, both indoor clips) | 0.6 to 4.0 cm |
| Garden light — outdoor, rigid (3 trials) | 0.9 to 1.7 cm |
| Grass-Exe1 — outdoor, clumping plant (3 trials) | 7.3 to 8.2 cm |
| Grass — outdoor, clumping plant, automatic mask (1 trial) | **24.3 cm** |

A rigid object is a rigid object whichever direction you call up: outdoors and indoors it moves by
a couple of centimetres. A sprawling plant is not. Its points spread sideways as well as upward, so
tilting the measurement axis by a few degrees sweeps a different part of the clump into the top and
bottom bands. **The 24.3 cm row is the warning in this table**: that target's answer depends on
which vertical you choose almost as much as on the reconstruction.

### Floor quality on the new clips

The ground fit is part of the result, not decoration. Eight fits per clip differing only in the
RANSAC seed (`inspect floor <id> --repeat 8`, 2026-08-15):

| Clip | Support | Tilt vs camera-derived vertical | Height spread over 8 seeds | Below plane |
|---|---:|---:|---:|---:|
| RoomNewFixture | 10.7% | 17.4° | **0.4 mm** | 0.0% |
| Test_Grass (patio) | 34.2% | 22.5° | 6.9 mm | 0.0% |
| Test_Grass2 (lawn) | 27.8% | 23.5° | 6.5 mm | 0.4–0.5% |

Support and tilt are the default seed's, which is the one the app uses; the spread column is the
range across all eight.

The outdoor clips have three times the floor support of the indoor one, which is what a large
uninterrupted lawn or patio should give. None of the three refused, none put a meaningful fraction
of the cloud below the plane, and all are stable under reseeding.

The two clumping-plant targets sit on **raised beds**, so their lower endpoint lands 10–17 cm above
the fitted floor while the indoor table's lands at 0.000 m. That is not an error: an extent is a
difference of two heights above the same plane, so a raised bed cancels out of it. It is visible
in the framed elevation images — the fitted floor is drawn across each one, and the ruler's lower
end sits clearly above it.

---

## The trial protocol

For each object, at one setting:

1. Clear the mask completely. Reusing the previous one measures the code, not the operator; the
   app detects an unchanged mask and flags the trial rather than counting it.
2. Repaint from scratch, without first reading the previous trial's number.
3. Record. The trial keeps its own mask, painted-pixel count, selected-point count, floor
   diagnostics and time taken.
4. Three trials minimum. Below three, the spread is shown greyed out — two points have a
   separation, not a dispersion.

Report `max − min` as the operator spread; at three to five trials that is the honest statement.

⚠️ **Do not quote the spread as measurement uncertainty.** It bounds one sitting of one operator
who knows the scene, and it is by construction blind to a mask placed in the wrong place. On the
door clip that exact failure produced a 1.887 m reading with a healthy ±0.037 m spread, a supported
floor and a plausible number; nothing in the reported statistics distinguished it from the correct
2.020 m, and only looking at where the mask sat did. This is why the app highlights selected points
live in 3D while painting.

### Known bias in the operator, stated plainly

The person painting these masks can see the reading update as they paint, and knows the tape truth
for most targets. That is a route for the mask to be adjusted, consciously or not, until the number
looks right — and the results above cannot rule it out. Three things bound it, none of which
eliminate it:

- The garden light (+0.2%) and the monitor (−0.3%) are rigid objects with unambiguous ends, where
  there is little freedom to move a mask without obviously leaving the object.
- The mask-free control on the door clip found the same tabletop within 1.1 mm of the brushed
  result, so on that clip the brush was not where the error lived.
- Every mask is frozen and can be looked at. `.inspect/evidence/` draws all 26 of them on their
  source frames.

The clean way to close this is a mask painted by someone who has not seen the truth, or a
mask-free instrument for each target class. Neither exists yet for the new clips.

---

## Resolution and frame count — the verdict

Measured on the door clip only. Raw error is averaged over the holdout objects, excluding whichever
object supplies the correction.

| Setting | GPU time | Raw average error | Corrected average error |
|---|---:|---:|---:|
| **504 px · 112f** | 31.3 s | **0.061 m** | **0.026 m** |
| 356 px · 256f | 40.8 s | 0.193 m | 0.029 m |
| 252 px · 256f | 16.5 s | 0.227 m | 0.187 m |

**Use 504 px with 112 frames.** It wins on raw error and on corrected error, costs less GPU time
than the 356 px alternative, and preserves small objects. Every clip in the new study used it.

⚠️ **The corrected column uses an earlier, worse door measurement** (1.887 m rather than 2.020 m),
because only the 504 px setting was re-measured under the trial protocol. The ranking is unaffected
— 504 px already won on raw error, which needs no correction — but the corrected figures for all
three rows are stale.

---

## What is established, and what is not

**Established.** The pipeline takes sparse two-dimensional endpoint evidence, places it correctly
on the reconstruction, recovers a supported ground direction, measures a vertical extent, and
audits the result against tape. Across three clips and two scene types, **eight brushed targets
from 0.30 m to 2.10 m have been graded against tape**, and on the two clips captured after
2026-08-11 the error is within 2%. Short-term repeatability is 0.9–15.5 mm. Every recorded trial
replays exactly from its frozen mask.

**Established outdoors, specifically.** Outdoor scenes are not a failure mode. Both outdoor clips
produced better floor support than the indoor one, and a rigid outdoor object (the garden light)
was measured to +0.5 mm on a 0.300 m truth.

**Not established.**

- Turf, ground cover, or any surface without a single identifiable top. Nothing here measures it.
- Any accuracy figure across cameras, operators, or a scene nobody has taped. One person, one
  phone, one garden, one room.
- The automatic mask as a graded instrument. Two trials, no repeats, and 5–7 cm of each answer
  supplied by an adapter whose own error is not separable on this evidence.
- Why one clip lands at −7.0% and another at +0.3%. This is the largest open question in the
  project, and until it is answered a new clip's accuracy cannot be predicted before taping it.

**The largest open risk** remains between-sitting repeatability. All three trials of a target are
painted back to back, so they cannot see variation that arrives with a new sitting, a new mask
style or a new day. The Monitor target is the one partial exception — its three trials were
recorded on 2026-08-15, two days after the other two targets in the same run, and it produced the
smallest spread in that clip (3.1 mm).

**Two endpoint measurements can be enough**, and this is deliberate. The brush does not need to
outline every pixel: it needs trustworthy 3D points near the intended lower and upper endpoints.
The measurement takes robust height percentiles along the fitted ground direction, and the line
drawn in 3D is the ruler between those bands — not invented geometry. A connecting stroke still
helps when it stays on the object, because it supplies more points and makes an accidental endpoint
easier to see.
