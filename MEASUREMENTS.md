# Ground truth — tape-measure values for `test_demo.mp4`

The only numbers in this project that do not come from the model. M3 grades `MeasureHeight`
against this table; without it there is nothing to be right or wrong about.

Source: the user, by tape measure, 2026-08-01. **Never overwrite these with predicted values** —
predictions belong in the results table at the bottom.

## Objects

| # | Object | Dimension | Truth | Where in clip | Notes |
|---|---|---|---|---|---|
| 1 | Table | height, floor → tabletop | **0.750 m** | 0:09 | Ground-plane-relative, so it exercises `GroundPlane` and `MeasureHeight` together. |
| 2 | Samsung G5 curved 165 Hz monitor | height, incl. stand | **0.534 m** | 0:09 | Stands on object 1. Base sits on the tabletop, not the floor. |
| 3 | Monitor top above floor | height, floor → top of monitor | **1.284 m** | 0:09 | *Derived*: 0.750 + 0.534. Not independently measured — it checks that two stacked estimates compose without drift. |

## Calibration reference for `ScaleCheck`

**Object 1, the table at 0.750 m.** Chosen because it is the only truth measured from the floor,
and `ScaleCheck` calibrates against the same ground plane `GroundPlane` fits — the monitor's base
sits on the tabletop, so using it would fold the table's own error into the scale factor.

⚠️ **Assumption to confirm with the user:** that "table 75 cm" is its *height*, not a width or
depth. Height is the natural reading in a measurement context and matches standard desk height
(0.73–0.75 m), but object 3 is wrong if this is a different dimension, and the scale factor with it.

⚠️ **Weak calibration baseline.** A door at ~2.03 m was the ideal reference; the largest truth here
is 0.750 m. A fixed absolute error in locating the endpoints is ~2.7× larger *as a fraction* of a
0.75 m reference than of a 2.03 m one, so the calibrated scale factor is proportionally noisier.
Read M3's error bars with that in mind, and prefer adding a taller floor-to-ceiling or door
measurement if one becomes available.

## Results — filled in by M3, not before

| # | Object | Truth | Predicted | Error | Settings (frames / process_res) |
|---|---|---|---|---|---|
| 1 | Table height | 0.750 m | — | — | — |
| 2 | Monitor height | 0.534 m | — | — | — |
| 3 | Monitor top above floor | 1.284 m | — | — | — |

M2b saves artifacts at more than one `process_res`, so this table can be filled once per setting
offline. Comparing the error columns across settings is what decides whether trading resolution
for frames was worth it — that verdict is M3's, and it needs no further cloud time.
