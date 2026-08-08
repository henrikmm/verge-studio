# Progress — what to do next

This file holds work that has not been done. Nothing else. What already works and why is in
[REGISTRY.md](REGISTRY.md); how to work here is in [../AGENTS.md](../AGENTS.md).

**When a task is finished, delete it from this file and add what it established to the Registry,
in the same change.** Git history is the archive. Do not keep a second copy of finished work here.

Every task states five things:

- **Outcome** — what is true afterwards that is not true now.
- **Owner** — always the agent. Tasks are never handed to the user to complete.
- **Gate** — `none`, `user confirmation`, or `cloud spend + user confirmation`. A gate is a point
  where you stop and ask; it is not permission to leave the task unfinished. See the
  human-gateway protocol in AGENTS.md.
- **Evidence / starting points** — where to begin reading.
- **Done when** — the condition that lets you delete this entry.

---

## Now

### 0. Make the ground fit reproducible, before anything is measured against it

**Outcome.** The same cloud fitted twice gives the same floor. Today it does not: changing only
the RANSAC seed — which carries no information about the scene — moves the plane by up to **31.9
cm** and its tilt by **14.55°**, and every one of those fits reports `ok`. Until this is fixed,
every height this system reports carries that spread on top of its stated error, and no outdoor
verdict means anything.

**Owner.** Agent.

**Gate.** None. Every measurement below is on this disk and costs nothing.

**Evidence / starting points.** Measured 2026-08-08 across all five reconstructions on this disk;
the table is REGISTRY section 3, "The ground fit is a coin flip". Reproduce with
`node scripts/inspect.mjs floor <id> --repeat 8`. The app hard-codes `seed: 7`
(`app/src/graph/nodes/measurement.ts:292`), so its answer is one arbitrary draw from that family.

Three candidates, in the order worth testing. **Too few iterations** — 1200 draws may simply not
converge, and raising them costs only local CPU. **The hypothesis choice is unstable** —
`fitGroundPlaneRobust` picks between proposal pools on `groundPlaneQuality`, and the outdoor
separations range 0.006–0.328 across seeds, so the winner changes. **The evidence is genuinely
ambiguous** — in which case the honest answer is refusal, and this hands task 2 its threshold.

A biased input makes it worse but is not the cause: rebuilding the outdoor cloud with no
confidence floor (`--cloud npz`) moves the plane 12.7 cm, inside the 31.9 cm the seed moves it
alone. Do not start there.

**Done when.** Refitting the same cloud with eight different seeds agrees to a stated tolerance on
every reconstruction on this disk, or reports a refusal — and the tolerance is written down with
the measurement behind it. `floor --repeat` is the check, and it runs in the test suite on at least
one fixture so this cannot silently return.

### 1. Take the system outdoors, guided, and find out what breaks

**Outcome.** We know whether the ground plane and the measurement hold up outside, on a surface
that is not a flat indoor floor. Either it works and we can say so with numbers, or it fails and
we know exactly how — both are a result.

**Owner.** Agent. The user records the clip and holds the tape measure; everything else is yours,
including preparing the capture checklist, running the pipeline and doing the analysis.

**Gate.** Cloud spend + user confirmation.

**Gated behind task 0.** An outdoor verdict computed on a floor that moves 32 cm with the seed is
not a result, it is a coin toss with a number attached.

**Evidence / starting points.** The ground rule is REGISTRY decision 3; its weak spots are in
REGISTRY section 7. Measurement targets are keyed by the clip's digest, so an outdoor clip starts
with an empty set. The camera must genuinely move through the scene.

**Half of this is already captured.** `~/verge-runs/20260806-193346-26d16e` (`testOutdoor.mp4`,
99 frames, a 29 m walk down a side passage) reconstructs and can be inspected at no cost. What it
lacks is usable tape truth: everything measured on that trip was vegetation, which is task 5's
problem — a plant has no single height to be right or wrong about, so it cannot grade a ground
plane. The second capture needs **rigid targets in the same clip**: a doorway, a step or kerb, a
post, a window reveal. Scale does not transfer between clips, so the reference must be visible in
the reconstruction being graded.

**Done when.** One outdoor clip has been captured, run and measured, with these recorded: how much
of the scene supports the fitted ground, its tilt, how much of the cloud sits below it, the fit
error, how well it agrees with the camera-derived vertical, the margin between the best two
candidate grounds, the measured dimensions and the tape truth. The evidence is saved, and the
result is stated plainly as either a pass or a named limitation.

---

## Next

### 2. Let the app say "I cannot find the ground"

**Outcome.** When the evidence for a ground plane is weak or ambiguous, the app says so instead of
picking a winner. The margin between competing candidates is exposed — a narrow margin means the
fit is a coin flip, and nothing currently reports it.

**Owner.** Agent.

**Gate.** User confirmation, for the final wording and behaviour of the warning.

**Evidence / starting points.** `geometry/plane.ts` returns every hypothesis it scores and
`inspect floor` reports the separation between the best two; four cases are in REGISTRY section 3,
and every thin fit is a narrow win. Abstention must propagate: a measurement resting on an
untrustworthy ground should refuse, not guess. A seeded fit (`fitPlaneFromSeeds`) exists and has
never been reachable from the interface — add that route only if the automatic evidence proves
insufficient.

The **display** half landed on 2026-08-07 (REGISTRY section 1). What remains is the harder half —
making the app judge a fit *itself*. Today it refuses only on the loose gates inside
`fitGroundPlaneRobust`: a fit at **6.2% support, 18° tilt, 6.6% below** passes as `ok`,
reproducible on the door fixture at `inlierDistance 0.1, maxTiltDeg 45, stride 32,
iterations 250`.

⚠️ **No separation on record is a threshold candidate yet, because each is one seed's answer.**
Across eight seeds the outdoor run's separation ranges 0.006–0.328 and the door fixture's
0.021–0.417, with **zero refusals anywhere**. A threshold set on something that unstable fires at
random. Task 0 comes first, and may hand this task its criterion for free: a fit whose answer
moves with the seed is exactly a fit the app cannot establish.

**Done when.** Outdoor evidence from task 1 has been used to set the thresholds, "ground cannot be
established" is a first-class result that downstream steps respect, and the user has agreed the
warning reads correctly.

---

## Later

### 5. Decide what measuring grass actually means, then build it

**Outcome.** The system can report vegetation height over an area, with an honest statement of
where it has enough evidence and where it does not.

**Owner.** Agent.

**Gate.** User confirmation of what is being measured and how it will be checked, before any code
is written. This is a definition problem before it is an engineering one.

**Evidence / starting points.** Grass is not a door repeated many times. The intended direction is
a grid laid on the local ground, with a robust height statistic per cell, a coverage and
confidence gate per cell, abstention where evidence is thin, and a heat map as the output rather
than a list of objects. Do not try to segment individual plants; `donor/` has a worked version of
this cell-and-percentile approach and is the template. The unproven automatic mask benchmark
(REGISTRY section 7) does not apply — the raster approach uses no object masks.

The outdoor clip already on disk (`20260806-193346-26d16e`) is a vegetation case with tape truth
taken on the day, so this task has a first subject waiting. It is also why task 1 still needs a
second capture: those measurements grade *this*, not a ground plane.

**Done when.** The measurement definition and the physical reference protocol are agreed with the
user, the raster is implemented, and it has been checked against a physical reference with its
error, valid-area coverage and abstention rate all reported.

### 6. Explain the 112-frame landscape excess, now that orientation is ruled out

**Outcome.** The 22.02 GiB reading that broke the memory ladder has a named cause, and the app's
estimate matches what a real run does at the top of the range.

**Owner.** Agent.

**Gate.** Cloud spend + user confirmation.

**Evidence / starting points.** Both original suspects are dead, at no cost. Orientation went on
2026-08-06 (two 81-frame runs, landscape and portrait, byte-identical peaks). **Pixel count went
on 2026-08-08**: the 22.02 GiB run was `da3Test.mp4`, 1920×1080 unrotated, which
`upper_bound_resize` takes to 504×280 = **141,120 px/frame** — identical to the door clip's
280×504 — and the 81-frame run of *that same clip*
(`~/verge-runs/20260805-151526-a99a78`) matched the door clip byte for byte. The excess appears
only at 112.

**One candidate is left: the driver figure near the ceiling**, which REGISTRY section 3 already
observes (144 frames reads lower than 128). The allocator peak is the clean signal and was never
recorded for that run — that missing number is now the whole task.

Deferred on 2026-08-08 as out of scope for that session, not decided against.

**Done when.** One inference at 112 frames and 504 px on `da3Test.mp4` records its allocator peak
— if it lands near the door clip's 17.23 GiB, the excess is driver-side and this closes.
`docs/vram-measurements.json` carries pixels per frame, the clip and the frame shape for every
rung, and the app's `MEASURED_DRIVER_PEAKS` estimate is checked against that run.
