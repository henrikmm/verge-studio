# Tasks — what to do next

Only unfinished work lives here. What already works and why is in [REGISTRY.md](REGISTRY.md); how
to work in this repository is in [../AGENTS.md](../AGENTS.md).

**When a task is done, delete it from this file and write what it established into the Registry,
in the same change.** Git history is the archive. Never keep a finished task here as a record.

Every task is owned by the agent. None of them is a request for the user to go and do something,
even when a step needs the user's hands or their permission.

## How a task is written

A task is a test with a plan attached. It states the pass condition **before** the work starts, so
finishing is a fact rather than an opinion. Five fields, then the steps:

- **Why** — the reason this task exists. What is wrong today, what it costs us, what breaks if we
  skip it. This is the most important field: a task whose Why is thin is a task nobody should
  start.
- **Gate** — the condition that decides whether the work succeeded. Written so it can be run,
  with the numbers it has to beat.
- **Regression** — what must not get worse. Nearly every change here can improve one number while
  quietly ruining another, so name the thing being protected and where to check it.
- **Approval** — `none`, `user confirmation`, or `cloud spend + user confirmation`. Where you stop
  and ask. It is not permission to leave the task half done.
- **Start** — the files and commands to read first.

Then a checklist of steps. Tick a box when that step is done and verified, not when the code is
written. Unticked boxes are allowed in this file and nowhere else in the repository.

---

## Now

### 9. Find out why one clip reads −7% and another +0.3%

**Why.** This is now the largest open question in the project. The door clip's three objects read
3.9–7.0% low, and five brushed targets on the two clips captured after 2026-08-11 read within 2%.
No code in the measurement path changed between them. Until the cause is known, **no clip's
accuracy can be stated before something in it is taped**, which is the single biggest limit on the
tool being useful to anyone who does not own a tape measure.

**Gate.** A named, measured mechanism that predicts the sign and rough size of the scale error on a
clip the prediction was not fitted to. "We looked and could not find one" is a real outcome and
must be written up as such rather than left open.

**Regression.** None to the measurement path; this is an investigation of it. Nothing here may
change a recorded number — `scripts/collect-evidence.mjs` must replay all 26 trials unchanged.

**Approval.** `none` for the analysis, which is entirely local. `cloud spend + user confirmation`
if it turns out to need new reconstructions.

**Start.** `.inspect/evidence/manifest.json` has all 26 trials with their floor diagnostics.
`inspect run <id>` reports sampling fps, duration and resolution for each; the door clip sampled
2.6 fps over 42.7 s where the outdoor clips sampled 5 fps over 13–19 s. REGISTRY section 3,
"The −5% scale error was the clip, not the pipeline".

- [ ] List what actually differs between the clips: sampling rate, duration, camera path length,
      depth range, scene scale, texture. Measure them rather than recalling them.
- [ ] Check the cheap hypothesis first — the door clip's floor has 10.7% support against 27–34%
      outdoors, and a plane fitted to less evidence can be tilted without looking wrong.
- [ ] Whatever the candidate, test it against a clip it was not derived from.

### 10. Grade the automatic mask, or stop reporting its numbers

**Why.** Two automatic-mask trials exist, one per target, and they are the two worst results in the
study (+5.6%, −7.3%). They are also measured by a different estimator than every other row: an
endpoint adapter supplies 7.4 cm of one 47.5 cm answer and 5.0 cm of a 46.4 cm one. Two trials
cannot separate the adapter's error from the reconstruction's, so these numbers are currently
quoted in `MEASUREMENTS.md` with a warning instead of being either trusted or withdrawn.

**Gate.** Three trials per target on at least two targets, with the full-mask control recorded
beside each reading, so the adapter's contribution can be stated as a measured quantity rather than
an observation from two points. Then either the automatic rows join the graded table or they leave
it.

**Regression.** The brush path must not change. `scripts/collect-evidence.mjs` must still replay
every trial to within its tolerance, brushed rows included.

**Approval.** `none` — the runs already exist on disk and re-masking is local and free.

**Start.** `app/src/graph/nodes/measurement.ts`, the `selection.segmentation` branch, is where the
adapter lives; `selectEndpointEvidence` in `geometry/measure.ts` is what it calls. The replay
prints the control automatically — `inspect measurement <run> <trial>` shows an "endpoint adapter"
line on any automatic trial. REGISTRY section 3, "The inspector was grading a different instrument
than the app".

- [ ] Repaint each automatic target three times from scratch, on `20260814-174520-eebd17`.
- [ ] Report the adapter's contribution as a distribution, not a single number.
- [ ] Decide whether a brushed and an automatic reading belong in the same table at all, given
      they are two estimators. If they do, the table must say which is which.

### 2. Let the app say "I cannot find the ground"

**Why.** When the evidence for a floor is weak, the app picks a winner anyway and draws it exactly
like a good one. A thin fit and a solid fit are indistinguishable on screen, so the operator has
no way to know which they are looking at. Refusing is a real answer and the app cannot give it.

**Gate.** A fit the evidence does not support is reported as a refusal that downstream steps
respect — a measurement resting on an untrusted floor refuses too, rather than quoting a number.
The thresholds come from measured cases, not from taste, and the user has agreed the wording.

**Regression.** The door fixture at 504 px must still produce a floor. A rule strict enough to
refuse the one scene we have tape truth for is too strict, whatever it does for the others.

**Approval.** `user confirmation`, for the final wording and behaviour of the warning.

**Start.** `geometry/plane.ts` returns every hypothesis it scored; `inspect floor` reports the gap
between the best two. REGISTRY section 3 has four measured cases. The display half already exists
(`app/src/panes/floor-state.ts`).

- [ ] **Do not use `separation` as the signal.** It measured something real when the two proposal
      pools disagreed; now that they find the same plane it reads ~0.000 on a good fit, so a low
      separation means agreement rather than a coin flip. Its meaning inverted on 2026-08-08.
- [ ] Set the thresholds from the measured cases. Two known cases where the app returns junk and
      calls it a floor: the 6.2%-support fit (door fixture at `inlierDistance 0.1, maxTiltDeg 45,
      stride 32, iterations 250`), and the confidence-veto case in `plane.test.ts`, where the app's
      own gates return a plane with 1.12% support. `minInlierFraction` is 0.01 and sits just below
      it. `belowFraction` is the cleaner discriminator: good fits now read 0.00–0.89%, the junk
      reads 7.66–14.87%.
- [ ] `room-252px-256f` is the one reconstruction the reproducibility fix did not rescue — 35.7 cm
      of seed spread with 1.3–2.7% support. It is the natural first case to refuse.
- [ ] Make refusal travel: a height measured against a refused floor must refuse as well.
- [ ] Agree the wording with the user before it ships.

### 7. Watch a real cold start, once

**Why.** `waking` is the one phase never seen against hardware. Two attempts have failed for two
different reasons, and the second one is the useful finding: **deploying leaves an instance
running.** Cloud Run's startup probe keeps a container alive after a deploy and only scales to zero
after roughly fifteen minutes idle, so a run started minutes later never meets a cold container —
`/gpu` answers at once and the readout goes straight to loading the model. That is what happened on
2026-08-11 even with the app pointed at the service and provably not having contacted it.

The phase logic itself is exercised: the mock rehearses it against a real 503, and a failed
telemetry read is what the code treats as "still waking". What is unverified is the duration and
that a real container produces the same shape.

**Gate.** One run against a service that has demonstrably scaled to zero, with `waking` visible and
its elapsed clock running. The measured duration goes in the Registry beside the quoted 64 s.

**Regression.** None to the run path; this is an observation of it.

**Approval.** `cloud spend + user confirmation`, and it is worth stating the bill plainly: reaching
a scaled-to-zero service costs about fifteen minutes of idle L4 on top of the run. Do not pay that
on its own — batch it behind any other GPU work, deploy, do the other work, then leave the service
idle while doing something else and come back.

**Start.** `lib/run-phase.ts` `applyGpu`; REGISTRY section 3 "Deploying leaves the instance warm".

- [ ] Confirm scale-to-zero before running — `gcloud run services describe` reporting no active
      revision instance, rather than assuming the fifteen minutes elapsed.
- [ ] Record the real cold-start duration against the quoted 64 s.

### 8. Grade the orbit without asking the user

**Why.** Acceptance item 5 wants proof that dragging inside Viewport 3D changes the camera, and
until 2026-08-12 that needed the user's hand: every drag rests on `setPointerCapture`, which
refuses events the page synthesised. What was wrong was the scope of that conclusion. Chrome's
DevTools protocol injects at the browser level, its events are trusted, and a ten-step drag over
the canvas orbits the camera — measured 2026-08-12, two screenshots either side showing the room
from a different angle with both elapsed clocks unchanged. So the one review step that reliably
interrupts a person is automatable, and is still being handed to them.

**Gate.** A design review grades item 5 from a script, with the two screenshots as its evidence
and no request to the user. The check fails when the camera does not move — proven by running it
against a build with orbit disabled, not by watching it pass.

**Regression.** `scripts/capture-reference.mjs` must keep producing the same five captures. This
shares its CDP plumbing, and a refactor that makes the captures drift silently costs more than
the manual orbit check ever did.

**Approval.** `none`.

**Start.** `scripts/capture-reference.mjs` has the whole mechanism — `dragSash` is the same shape
the orbit needs. REGISTRY section 3, "Drag can be automated, but not from inside the page", has
the measurement and the reason. The browser pane still cannot do this; do not retry it there.

- [ ] Lift the CDP driving out of the capture script so both callers share it, without changing
      what the captures look like.
- [ ] Compare the two screenshots on pixels rather than byte length — a PNG can differ in size
      for reasons that are not the camera.
- [ ] Prove the check can fail before trusting it to pass.
- [ ] Update the design-review skill so item 5 names the script instead of the human gateway.

---

## Later

### 4. Decide what measuring turf means, then build it

**Why.** Vegetation is the goal this project is aimed at, and turf is the part still missing. A
lawn is not a door repeated many times: it has no single height to be right or wrong about, so the
question has to be redefined before any code is written.

**What is already answered, as of 2026-08-15.** *Individual plants* are not the open problem. Two
clumping ornamental plants have been graded against tape — 0.980 m read to +1.9% and 0.450 m to
+5.6% — because a clump has leaf tips a tape and a brush can both reach. Both stand on raised beds
and both measured correctly anyway, since an extent is a difference of two heights above one plane.
What remains unmeasured is the surface case: turf, ground cover, anything whose "top" is a
statistic rather than a point.

Two measured constraints the design has to respect:

- **The vertical matters much more here than for furniture.** Measured against the gravity estimate
  instead of the fitted floor normal, rigid objects move 0.6–4.0 cm and clumping plants move
  7.3–8.2 cm, with one automatic-mask trial at 24.3 cm. A few degrees of tilt sweeps different
  parts of a sprawling canopy into the top and bottom bands.
- **Outdoor ground is the easy half.** Both outdoor clips fitted a better floor than the indoor
  one — 34.2% and 27.8% support against 10.7%, all stable across eight seeds. The floor under a
  lawn is not what will make this hard.

**Gate.** The definition and the physical reference protocol are agreed with the user first. Then
the raster is built and checked against a real reference, reporting its error, how much of the
area had enough evidence, and how often it abstained.

**Regression.** The existing object measurement path must keep working. This adds a second way to
measure, and must not disturb the one that is already graded against tape — `node
scripts/collect-evidence.mjs` must still replay all 26 trials with no failures.

**Approval.** `user confirmation` of what is being measured and how it will be checked, before any
code. This is a definition problem before it is an engineering one.

**Start.** `donor/` has a worked version of the cell-and-percentile approach and is the template.
`Test_Grass2.mp4` (`20260814-174814-b245bc`) is the best scene evidence on disk: it has a mown lawn
in the foreground, a graded 0.300 m rigid object standing on that lawn, and a floor fitted to 27.8%
support. No turf truth has been taken in it.

- [ ] Agree with the user what number we are claiming and how a person could check it.
- [ ] Lay a grid on the local ground; take a robust height statistic per cell.
- [ ] Gate each cell on coverage and confidence, and abstain where the evidence is thin. Do not
      try to find individual plants.
- [ ] Decide which vertical the cell statistic is taken along, and justify it against the 7–24 cm
      sensitivity measured above. This is a decision, not a default.
- [ ] Output a heat map, not a list of objects.
- [ ] Check it against the physical reference and report error, coverage and abstention rate.

### 6. Give the side column a floor, so 20% cannot squeeze its own tabs out

**Why.** The window is split 40/40/20 as of 2026-08-09, and 20% is a share rather than a size. At
1280 px it is 256 px, which Dockview cannot fit three tabs into — Runs moves behind an overflow
chevron, one click deeper than it was at 427 px. Below about 1100 px the Objects target names
truncate to `D…` and `Ta…`, so the list stops naming what it lists. Nobody chose either; they are
what a pure percentage does at the small end.

**Gate.** At 1024×800 the Inspector group shows all three tabs with no overflow chevron, and every
target name in Objects renders without an ellipsis. At 1600×900 and above the split is still
40/40/20 to within a pixel — a minimum must not become the layout on a wide screen.

**Regression.** Depth 2D and Viewport 3D stay equal to each other at every width. A minimum that
takes from one viewer and not the other trades a squeezed panel for a lopsided window, which is
the asymmetry this split was introduced to remove.

**Approval.** `user confirmation`, for the minimum width itself. 280 px is a guess from the two
measured failures above, not a measurement.

**Start.** `applyDefaultSplit` and `SIDE_PANEL_SHARE` in `app/src/lib/dock-store.ts`; the
2026-08-09 entry in `docs/design-review-log.md` has the measurements.

- [ ] Find the width at which the three tabs stop fitting, by measuring rather than guessing.
- [ ] Clamp the side column to that, taking the difference from both viewers equally.
- [ ] Confirm the clamp is inactive at 1280 px and above, so the asked-for 40/40/20 is what a
      normal window gets.
