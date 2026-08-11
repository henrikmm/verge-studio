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

### 8. Key a mask to the clip it was painted on

**Why.** A selection painted on one clip stays selected on the next one and measures it. Mask keys
are `subject:frame` with no clip and no run in them (`maskKey`, `app/src/measurement/
measurement-store.ts`), so nothing separates two scenes that share a subject id. Observed
2026-08-11: 18,507 px painted on `RoomNewFixture.mp4` at frame 1 stayed on screen after switching
to `door-504px-112f` and reported 0.759 m, then 0.763 m — the same brush strokes measured against
a different room's point cloud, with no warning that the selection was not made there.

Ad hoc collides always, because its id is the constant `__free__`. Named targets collide when two
clips hold targets with the same name: `AddTargetForm` slugifies the name and de-duplicates within
the clip's own set, so `doorway` in two clips is one mask. Its comment already states the rule the
key breaks — "Ids key masks and trials, so a collision would merge two different objects'
evidence". Recorded trials are safe: they are keyed by `objectId:runId` and freeze their own mask
snapshot. It is the working mask that leaks.

**Gate.** Painting on clip A, switching to clip B and back leaves each clip's own selection intact
and shows neither on the other. The stale mask cannot reach a measurement: no number is produced
from a selection painted on a different clip.

**Regression.** A saved session must still restore its target masks — the persisted keys change
shape, so `SESSION_SCHEMA_VERSION` and `STORAGE_KEY` move together and old keys migrate rather
than being dropped. Recorded trials keep their frozen snapshots, which do not change at all.

**Approval.** `none`.

**Start.** `maskKey`, `restoreSession` and `persistSession` in `app/src/measurement/
measurement-store.ts`; `setActiveClip` is where a clip change is already noticed.

- [ ] Decide what the mask belongs to — the clip or the run — and say why in the Registry. A clip
      keeps a selection across resolutions of the same scene; a run does not.
- [ ] Put it in the key, bump the schema and migrate the stored masks.
- [ ] Cover both collisions in `measurement-store.test.ts`: Ad hoc across two clips, and two clips
      holding a target with the same slug.

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
The outdoor clip on disk (`20260806-193346-26d16e`) is useful scene evidence, but its current
1.150 m truth belongs to a large tree-like endpoint target. It is not grass truth and must not be
relabelled as one.

- [ ] Agree with the user what number we are claiming and how a person could check it.
- [ ] Lay a grid on the local ground; take a robust height statistic per cell.
- [ ] Gate each cell on coverage and confidence, and abstain where the evidence is thin. Do not
      try to find individual plants.
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
