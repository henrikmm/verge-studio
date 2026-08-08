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

### 1. Make the ground fit give the same answer twice

**Why.** The floor is found by an algorithm that guesses at random and keeps the best guess. We
never checked that it lands in the same place on two runs of the same data. It does not: changing
only the random seed — which knows nothing about the scene — moves the floor by up to **31.9 cm**
and tips it by up to **14.55°**, on every reconstruction we have. All of those fits report
success; not one refuses. Every height this system produces is measured up from that floor, so
every number we have ever published carries that spread on top of its stated error. Until this is
fixed, no other measurement is worth taking, and no outdoor result means anything.

**Gate.** Fit the same cloud eight times, changing only the seed, on all five reconstructions on
this disk. Every one must either land within a tolerance we write down, or refuse. The tolerance
is a number in the Registry with the measurement behind it — not a feeling. `inspect floor <id>
--repeat 8` is the check, and it runs in the test suite on at least one fixture so this cannot
come back unnoticed.

**Regression.** The door fixture at 504 px is the reference, because it is the only scene with
tape truth. Its fit today is **14.6% support, 11.8° tilt, 1.2 cm RMSE, elevation −1.0667 m**. A
more stable fit that moves the door's graded height further from 2.100 m is not an improvement.

**Approval.** `none`. Everything here is on this disk and costs nothing.

**Start.** `geometry/plane.ts` (`fitGroundPlaneRobust`), REGISTRY section 3 "The ground fit is a
coin flip", and `node scripts/inspect.mjs floor <id> --repeat 8`.

- [ ] Raise the iteration count until the spread closes, and record where it closes. Cheapest
      possible cause, so rule it in or out first.
- [ ] Check whether the winner changes between the two proposal pools. Their quality scores sit
      within 0.006 of each other on the outdoor run, which would explain a coin flip.
- [ ] If the spread will not close, make disagreement between seeds a refusal — and hand that
      criterion to task 3 rather than inventing a second one.
- [ ] Write the tolerance into the Registry, and add the repeat check to the test suite.

### 2. Build our own point cloud from the depth maps

**Why.** The cloud we measure is not the reconstruction the model produced. DA3's exporter throws
away the least confident 40% of every pixel, using a single threshold pooled across all frames at
once, and then keeps a random million of whatever survives. Because confidence only ranks pixels
*within* one image — it has no fixed meaning between images — a pooled threshold compares numbers
that are not comparable, and deletes whole frames rather than thinning each one. Five frames of
the outdoor run contribute under 2% of their pixels; the camera keeps walking for metres after the
cloud stops.

We already have the full-resolution depth and confidence for every frame saved on disk, so fixing
this costs nothing in cloud time. It also connects something already built and never used: the
plane fitter accepts a per-point weight, documented as "DA3's confidence map", and nothing has
ever passed it — because the export discards confidence before the cloud reaches us.

**Gate.** The cloud must contain the geometry that is plainly visible in the frames, unless we
chose to drop it and can say why. Check with `inspect coverage` on the outdoor run and the door
fixture: **no frame may contribute under 20% of its pixels**, and on any frame the geometry
missing from the cloud must be explained by a threshold this project set deliberately — not by one
borrowed from a different frame. Today five frames contribute under 2%, and 18.3% of frame 85 is
absent with nobody having asked for it.

**Regression.** This changes the input to every measurement we make, so it can improve the
picture and ruin the numbers. **The door fixture at 504 px decides it.** Its floor fit (14.6%
support, 11.8° tilt, 1.2 cm RMSE) and its graded door height against the 2.100 m tape truth must
be as good or better afterwards. If they get worse, the change is not worth having and comes out,
however much better the cloud looks — a fuller cloud that measures worse is a step backwards.

**Approval.** `none`. The depth maps are already on this disk; nothing here wakes the service.
Changing DA3's own export instead would mean editing `server/`, which forces a twenty-minute
rebuild — do not do that for this.

**Start.** `geometry/backproject.ts` (`backprojectFrame`), `npzCloud` in `scripts/inspect.mjs`,
`app/src/graph/nodes/point-cloud.ts`, and `weights` in `geometry/plane.ts:64`. REGISTRY section 3
"The cloud the app measures is 7% of the reconstruction". `donor/runner.py:143` already does the
per-frame version and is the template.

- [ ] Take the confidence threshold per frame instead of once for the whole run.
- [ ] Carry each point's confidence into the cloud, rather than dropping it at the door.
- [ ] Feed that confidence to the plane fit as weights, and measure whether it helps.
- [ ] Decide what the app loads: keep DA3's file for the picture, measure on ours.
- [ ] Compare the door fixture's measurements before and after. Stop if they got worse.

---

## Next

### 3. Let the app say "I cannot find the ground"

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

- [ ] Wait for task 1. Every separation on record is one seed's answer: across eight seeds the
      outdoor run ranges 0.006 to 0.328 and the door fixture 0.021 to 0.417, with no refusals
      anywhere. A threshold set on something that unstable would fire at random.
- [ ] Set the thresholds from the measured cases, including the 6.2%-support fit that passes as
      `ok` today (door fixture at `inlierDistance 0.1, maxTiltDeg 45, stride 32, iterations 250`).
- [ ] Make refusal travel: a height measured against a refused floor must refuse as well.
- [ ] Agree the wording with the user before it ships.

### 4. Take the system outdoors, with something rigid to measure

**Why.** Everything we know about this system's accuracy comes from one room, one operator and one
camera path. Outdoors the ground is not a flat indoor floor, and we do not know whether the fit
survives it. Either it works and we can say so with numbers, or it fails and we know exactly how.

**Gate.** One outdoor clip captured, run and measured, recording: support for the fitted ground,
its tilt, how much of the cloud sits below it, the fit error, agreement with the camera-derived
vertical, the gap to the runner-up, the measured dimensions and the tape truth. The result is
stated plainly as a pass or as a named limitation.

**Regression.** None — this adds evidence rather than changing code. If it forces a change, that
change is a new task with its own gate.

**Approval.** `cloud spend + user confirmation`. Do task 1 first: an outdoor verdict computed on a
floor that moves 32 cm with the seed is a coin toss with a number attached.

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

### 5. Decide what measuring grass means, then build it

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

### 6. Close the 112-frame memory question

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
