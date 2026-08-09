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

### 3. Take the system outdoors, with something rigid to measure

**Why.** Everything we know about this system's accuracy comes from one room, one operator and one
camera path. Outdoors the ground is not a flat indoor floor, and we do not know whether the fit
survives it. Either it works and we can say so with numbers, or it fails and we know exactly how.

**Gate.** One outdoor clip captured, run and measured, recording: support for the fitted ground,
its tilt, how much of the cloud sits below it, the fit error, agreement with the camera-derived
vertical, the gap to the runner-up, the measured dimensions and the tape truth. The result is
stated plainly as a pass or as a named limitation.

**Regression.** None — this adds evidence rather than changing code. If it forces a change, that
change is a new task with its own gate.

**Approval.** `cloud spend + user confirmation`. The floor is reproducible as of 2026-08-08, so an
outdoor verdict is now worth computing; before that it was a coin toss with a number attached.
Bring something rigid, because the clip already on disk has none — see the third step.

**Start.** REGISTRY decision 3 (the ground rule) and section 7 (its weak spots). Targets are keyed
by the clip's content digest, so a new clip starts with an empty set.

- [ ] Write the capture checklist before asking for anything: the camera must move through the
      scene, not turn on the spot.
- [ ] Ask the user for **rigid** targets in the same clip — a doorway, a step or kerb, a post, a
      window reveal. Anything with two hard edges a tape can span. The clip we already have
      (`~/verge-runs/20260806-193346-26d16e`, 99 frames, a 29 m walk) is unusable for this because
      everything measured on that trip was vegetation, and a plant has no single height to be
      right or wrong about.
- [ ] Run the pipeline, save the run before deleting the service, and do the analysis.
- [ ] Record the verdict as a pass or a named limitation. Both are results.

---

## Later

### 4. Decide what measuring grass means, then build it

**Why.** Vegetation is the goal this project is aimed at, and we cannot currently measure it. A
plant is not a door repeated many times: it has no single height to be right or wrong about, so
the question has to be redefined before any code is written.

**Gate.** The definition and the physical reference protocol are agreed with the user first. Then
the raster is built and checked against a real reference, reporting its error, how much of the
area had enough evidence, and how often it abstained.

**Regression.** The existing object measurement path must keep working. This adds a second way to
measure, and must not disturb the one that is already graded against tape.

**Approval.** `user confirmation` of what is being measured and how it will be checked, before any
code. This is a definition problem before it is an engineering one.

**Start.** `donor/` has a worked version of the cell-and-percentile approach and is the template.
The outdoor clip on disk (`20260806-193346-26d16e`) has vegetation tape truth taken on the day, so
this task already has a subject waiting.

- [ ] Agree with the user what number we are claiming and how a person could check it.
- [ ] Lay a grid on the local ground; take a robust height statistic per cell.
- [ ] Gate each cell on coverage and confidence, and abstain where the evidence is thin. Do not
      try to find individual plants.
- [ ] Output a heat map, not a list of objects.
- [ ] Check it against the physical reference and report error, coverage and abstention rate.

### 5. Close the 112-frame memory question

**Why.** One run used 22.02 GiB where the measured table predicted 21.28 — 99.96% of the card,
with no headroom left. Until it is explained we cap ourselves at 81 frames instead of 112, which
costs us a third of the frames on every clip.

**Gate.** One inference at 112 frames and 504 px on `da3Test.mp4` records its allocator peak. If
it lands near the door clip's 17.23 GiB, the excess is the driver's own reporting near the ceiling
and the question closes. `docs/vram-measurements.json` carries pixels per frame, the clip and the
frame shape for every rung, and the app's estimate is checked against that run.

**Regression.** The frame cap must not be raised on the strength of one run. Whatever this
explains, 112 stays the ceiling until a second measurement agrees.

**Approval.** `cloud spend + user confirmation`. Deferred on 2026-08-08 as out of scope for that
session, not decided against. It stays here because closing it needs the GPU: nothing on this disk
carries an allocator peak for 112 frames of that clip.

**Start.** REGISTRY section 3 "The GPU's memory ceiling", `docs/vram-measurements.json`,
`MEASURED_DRIVER_PEAKS` in `app/src/lib/contract.ts`.

- [ ] Add pixels per frame, the clip and the frame shape to every rung already recorded.
- [ ] Batch this with any other GPU work rather than paying for a startup on its own.
- [ ] Run it, record the allocator peak, tear down, and write the answer into the Registry.

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
