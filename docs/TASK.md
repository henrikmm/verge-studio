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

### 8. Make a private clone safe and repeatable

**Why.** The repository is about to be shared with trusted friends, but a web page can currently
send commands to the local development server while it is open. One saved-run path can then attach
the operator's Google identity token to a caller-controlled address. A new clone also defaults to
the original Google project and bucket, assumes Homebrew and macOS in several places, and does not
explain what its first local run can prove. Private access narrows the audience; it does not make
those failures safe or make setup reproducible.

**Gate.** Every privileged local route rejects a foreign origin and a missing or wrong per-process
token before it starts a process, contacts a service or changes a file. A saved run can fetch only
from the configured Cloud Run service or its declared private bucket, and hostile service, artifact,
run-id and path cases are held by tests. A clone made from tracked files in a new sibling directory
installs from the lockfile, passes the complete local verification with the server contract enabled,
starts the app, and exercises the offline reconstruction path using only the README. The README
requires the reader's own Google project and states which operating systems were actually tested.

**Regression.** No test may contact or wake the cloud. The fixture-backed app stays usable at zero
cost, paid nodes still require a press, mock results keep their label, the tape-graded measurements
in `MEASUREMENTS.md` do not change, and the interface still passes the design review at 1280x800.

**Approval.** `none`. The user approved the local implementation, the standard fixtures and the
existing Git history on 2026-08-11. A real cloud deploy or inference remains separately gated as
paid work and is not part of this task.

**Start.** `app/vite-plugins/local-api.mjs`, `runs.mjs`, `cloud.mjs`; `scripts/deploy.sh`,
`create-bucket.sh`, `extract-frames.mjs`; `README.md`; REGISTRY sections 1, 6 and 7; this task's
2026-08-11 read-only security, portability and evidence audit in the conversation.

- [ ] Put a same-origin and per-process-token boundary around privileged local routes and prove
      hostile requests stop before side effects.
- [ ] Remove caller-controlled credential destinations; validate service URLs, artifact locations,
      run identifiers and paths at the boundary, with regression tests.
- [ ] Require a user-owned Google project and bucket, stop changing global gcloud configuration,
      use a dedicated runtime identity, and add a free preflight that names missing setup without
      deploying anything.
- [ ] Replace machine-specific language with `local computer` or an actual platform name. Keep
      macOS only where the behaviour or measurement is genuinely macOS-specific.
- [ ] Make the supported-platform and dependency contract executable: locked Node install,
      platform-neutral ffmpeg help, a complete Python verification environment, and CI for every
      platform claimed as verified.
- [ ] Rewrite the README around a zero-cost first run, current measured capability and limits,
      Google project creation and authentication, safe paid operation, data locations and recovery.
- [ ] Publish only user-approved fixture evidence, with the exact run/trial, model revision, commit,
      scope and limitation beside every screenshot or number. Do not turn one indoor clip into a
      general accuracy claim.
- [ ] Scan the current tree and all retained local history for secrets and non-English prose. Keep
      the approved history and report the author-email exposure rather than rewriting it.
- [ ] Clone the repository into a temporary sibling under `/Users/hmandrick/dev`, follow the README
      from scratch, run the full verification, start the app and exercise the offline pipeline.
- [ ] Run the design-review workflow after the visible wording changes. Record what was observed,
      move established facts to the Registry, delete this finished task and commit each coherent unit.

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
