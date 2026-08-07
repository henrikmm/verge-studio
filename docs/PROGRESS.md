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

### 1. Take the system outdoors, guided, and find out what breaks

**Outcome.** We know whether the ground plane and the measurement hold up outside, on a surface
that is not a flat indoor floor. Either it works and we can say so with numbers, or it fails and
we know exactly how — both are a result.

**Owner.** Agent. The user records the clip and holds the tape measure; everything else is yours,
including preparing the capture checklist, running the pipeline and doing the analysis.

**Gate.** Cloud spend + user confirmation.

**Evidence / starting points.** The ground rule and why it works is REGISTRY decision 3; its known
weak spots are in REGISTRY section 7. Per-clip measurement targets already exist and are keyed by
the clip's digest, so an outdoor clip starts with an empty set — this task is the first real use
of that flow. The camera must genuinely move through the scene: turning on the spot gives the
model nothing to work with.

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

**Evidence / starting points.** `geometry/plane.ts` already scores competing hypotheses; the
margin between them is computed and discarded. A seeded fit (`fitPlaneFromSeeds`) exists and has
never been reachable from the interface — add that route only if task 1 shows the automatic
evidence genuinely is not enough. Abstention must propagate: a measurement resting on an
untrustworthy ground should refuse, not guess.

A live example is already on disk and costs nothing to look at: the door run saved on 2026-08-06
(`~/verge-runs/20260806-173802-d354a2`) fits a floor with **3.1% support**, against the 24.6% of
the run beside it. Whatever the threshold turns out to be, that run is the kind of case it has to
judge, and it needs no cloud session to study.

The **display** half of this already landed on 2026-08-07: a refusal now reaches the viewport as
`▲ NO FLOOR` carrying the fit's own message (`app/src/panes/floor-state.ts`). What remains is the
harder half — deciding *when* to refuse. Today the app only refuses on the gates already inside
`fitGroundPlaneRobust`; a fit that squeaks past them at 4.7% support is drawn exactly like one at
14.6%, with nothing on screen marking it as thin. The margin between hypotheses is still computed
and discarded, and `belowFraction` — the statistic the whole ground rule rests on — is written
into exported evidence and shown in no pane at all.

**Done when.** Outdoor evidence from task 1 has been used to set the thresholds, "ground cannot be
established" is a first-class result that downstream steps respect, and the user has agreed the
warning reads correctly.

---

## Later

### 3. The tilt gate does not bound the tilt that gets reported

**Outcome.** The tilt limit either means what it says, or the control says what it means. Right
now a fit can be reported at a tilt its own gate should have excluded.

**Owner.** Agent.

**Gate.** User confirmation — this changes fit behaviour, and therefore possibly measured numbers.

**Evidence / starting points.** Measured on 2026-08-07 against `door-504px-112f`: with
`maxTiltDeg` set to **10°**, the fit returned a plane reported at **11.3°**. The gate rejects a
candidate at `geometry/plane.ts:385`, but the least-squares refinement that follows
(`plane.ts:418-426`) can rotate the plane past the limit, and the tilt finally reported
(`plane.ts:457`) is computed on the refined plane and never re-checked. `fitGroundPlaneRobust`
then only penalises tilt softly, so such a plane can still win its hypothesis contest.

Two candidate fixes, and the choice is a real one: re-check tilt after refinement and reject,
which makes the gate honest but may reject floors that are currently accepted; or keep the
behaviour and relabel the control as a limit on the *proposal*, which is free but leaves a number
that can exceed its own bound. Decide this after task 1 — an outdoor clip is exactly the case
that would expose which behaviour is wanted, and guessing now would be guessing.

**Done when.** The reported tilt cannot exceed the configured gate, or the control and its
documentation say plainly that the gate applies to the proposal only, with the outdoor evidence
behind whichever was chosen.

### 4. The OUTPUT row pushes its last chip out of a narrow pane

**Outcome.** No pane control can leave the viewport, whatever the pane is resized to.

**Owner.** Agent.

**Gate.** None.

**Evidence / starting points.** DESIGN.md's pane-chrome section warns that the `nowrap` control
row silently pushes right-hand controls out of a narrow pane. On 2026-08-07 that was measured
rather than assumed: forced to 180 px, Depth 2D's OUTPUT row keeps its height and puts the
`Confidence` chip **outside** the row's box, unreachable. The LAYERS row added the same day wraps
to two lines under the same test and keeps both of its chips inside, so `.layer-row` in
`app/src/theme.css` is the shape of the fix — the question is only whether `.output-row` should
wrap too, or whether OUTPUT's one-of-N chips want different treatment from LAYERS' toggles.

**Done when.** Every chip in every pane control row stays inside its row at 180 px, measured, and
the checklist item that covers it is graded against a narrow pane rather than only 1280×800.

### 5. Decide what measuring grass actually means, then build it

**Outcome.** The system can report vegetation height over an area, with an honest statement of
where it has enough evidence and where it does not.

**Owner.** Agent.

**Gate.** User confirmation of what is being measured and how it will be checked, before any code
is written. This is a definition problem before it is an engineering one.

**Evidence / starting points.** Grass is not a door repeated many times. The intended direction is
a grid laid on the local ground, with a robust height statistic per cell, a coverage and
confidence gate per cell, abstention where evidence is thin, and a heat map as the output rather
than a list of objects. Do not try to segment individual plants. The donor code in `donor/` has a
worked version of this cell-and-percentile approach and is the template. The unproven automatic
mask benchmark (REGISTRY section 7) only applies here if automatic object masks later become part
of this workflow — the raster approach does not use them.

**Done when.** The measurement definition and the physical reference protocol are agreed with the
user, the raster is implemented, and it has been checked against a physical reference with its
error, valid-area coverage and abstention rate all reported.

### 6. Explain the 112-frame landscape excess, now that orientation is ruled out

**Outcome.** The 22.02 GiB reading that broke the memory ladder has a named cause, and the app's
estimate matches what a real run does at the top of the range.

**Owner.** Agent.

**Gate.** Cloud spend + user confirmation.

**Evidence / starting points.** This task got smaller on 2026-08-06 and its question changed.
Orientation is no longer a suspect: two 81-frame runs at 504 px, one landscape and one portrait,
returned **byte-identical** driver and allocator peaks (REGISTRY section 3). Shape is free at equal
pixel count, so "landscape costs more" cannot be the explanation.

Two candidates remain, and they are cheap to tell apart. Either the aspect ratio changed the
**pixels per frame** — `upper_bound_resize` fixes the long edge at 504 and lets the short edge
follow, so a 4:3 clip carries ~35% more pixels than a 16:9 one at the same setting — or the driver
figure simply **saturated**, which REGISTRY section 3 already observes near the ceiling (144 frames
reads lower than 128). The allocator peak does not saturate and is the number to trust.

The stored ladder does not record pixels per frame, which is why this is still open. Record it.

**Done when.** The excess is attributed to pixel count or to driver saturation with a measurement
behind it, `docs/vram-measurements.json` carries pixels per frame for each rung, and the app's
estimate is checked against one real run near the top of the range.
