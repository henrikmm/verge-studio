# Verge Studio — how to work in this repository

Verge Studio measures real-world heights from ordinary video. Drop in a clip, a depth model on a
cloud GPU reconstructs the scene in three dimensions, and the app measures things in it against a
fitted ground plane. The interface is a node graph: boxes wired together, each doing a step, so
every stage is visible rather than hidden inside a single button. This file is the working
agreement. Read it, then the two documents below.

## The two documents, and which one answers your question

| Question | Document |
|---|---|
| What already works, and what was decided and why? | `docs/REGISTRY.md` |
| What should I do next? | `docs/TASK.md` |

`docs/REGISTRY.md` is the record of the project — no task list, no checkboxes. `docs/TASK.md` is
the task list and only the task list. When you finish a task, delete it from TASK and add what it
established to the Registry, in the same change. Git history is the archive; never keep a second
copy of finished work.

Each task there is a test: **Why** it exists, the **Gate** deciding whether it worked, the
**Regression** it must not cause, the **Approval** needed to start, where to **Start** reading,
and a checklist of steps. Write the Gate before the work — a pass condition invented once the
code runs is a description, not a test.

Supporting documents: `README.md` (how to run it), `MEASUREMENTS.md` (tape truth and graded
results), `docs/DESIGN.md` (what the interface must look like and do), `docs/SOURCES.md`
(external references worth trusting).

**A new fact goes to exactly one of them.** Writing it twice is how two records disagree:

| What you have | Where it goes |
|---|---|
| A reading graded against a tape measure | `MEASUREMENTS.md` |
| Any other measured number, or a decision and its reason | `docs/REGISTRY.md` |
| A rule the interface must obey from now on | `docs/DESIGN.md` |
| What one review graded, on one date | `docs/design-review-log.md` |
| Work not yet done | `docs/TASK.md` |

## Where things are

| Directory | What it holds |
|---|---|
| `app/` | React, TypeScript, Vite — the panes, the node graph, the 3D viewport |
| `geometry/` | Ground fitting, back-projection, scale checks, measurement. No browser code |
| `server/` | The FastAPI wrapper around DA3, and its GPU container image |
| `scripts/` | Verification, inspection, frame extraction, cloud lifecycle |
| `fixtures/` | Recorded runs used as input by tests and by the app |
| `donor/` | Verbatim copies from an earlier project, for reference only |

Four places hold run data, and confusing them is how a session loses work:

- **`fixtures/`** is the durable evidence. `manifest.json` and `SHA256SUMS` are committed; the
  npz and GLB payloads are gitignored, so **a fresh clone cannot load a fixture run** and cannot
  redraw the design captures. Rebuild one with a cloud run plus `scripts/save-run.sh`.
- **`.runs/`** holds manifests from a warm cloud session. They stop meaning anything the moment
  the service is torn down. Never committed.
- **`.inspect/`** holds pictures drawn by `scripts/inspect.mjs`. Evidence for the session that
  made them, cheap to redraw, never committed.
- **`~/verge-runs`** is where Save puts a run — outside the repository on purpose, so a 135 MB
  artifact can never be staged by accident.

## How the work is done

**Everything that can run on the local computer, runs there.** Extracting frames, geometry, tests and
every viewer are local and free. The cloud does exactly one thing: the forward pass of the depth
model, which needs a GPU. Never send CPU-shaped work to the cloud.

**Video is the input, not photographs.** Accuracy comes from comparing many frames of one scene
against each other; a single image never engages that mechanism and produces badly wrong geometry.
Sample by frames-per-second across the whole clip, never "N frames spread across it", and never
trim a clip to a window.

**Nothing is kept unless the user saves it.** Inference output is temporary; saving is an explicit
action. Never persist automatically.

**The model is for personal and research use only** (non-commercial licence). Never write a
commercial claim into this project.

## Paid work needs permission, every time

Running the GPU service costs real money for as long as it exists — not just while it computes.
You are billed for the machine's whole lifetime, including several minutes of startup and the
idle period afterwards. Two consequences follow:

- **Ask before you spend, and say what it will cost.** Deploying, running inference, or anything
  else that starts or wakes the service requires the user to agree first, in that conversation.
- **Delete the service when you are done.** A correctness requirement, not tidiness: it keeps one
  machine permanently alive, so it never stops billing on its own. Bucket-backed results survive
  teardown for three days, but Save is still the only way to keep one. A degraded run whose bucket
  publish failed must be saved before deletion because that result exists only on the instance.

Plan the whole batch of experiments before deploying, and run them back to back against one warm
machine. Four experiments in one session cost roughly one startup; four sessions cost four.

Checking costs nothing: the Inspector's **Cloud control** panel reports whether you are signed in,
whether the service exists, and whether the next deploy is quick or slow. All read-only lookups —
they cannot wake anything.

### One image in the repository, ever

The built image is kept between sessions on purpose: storing it costs about ten cents per gigabyte
per month, rebuilding costs twenty minutes at the start of every session. That trade only holds
for **one** image. Copies accumulate silently, because `deploy.sh` tags each build with a hash of
`server/` — so every change there mints another ~12 GB image beside the last one, and nothing has
ever deleted the old one. That is not hypothetical; the audit is in REGISTRY section 8. So a new
image is **promoted**, never merely added:

1. **A freshly built image is on trial until it has served a real run.** Deploy it, run inference,
   confirm no errors. Until then the previous image is the only way back, so do not touch it.
2. **Once the new one has worked, the previous one goes, in the same session.** Not next time —
   the person who built it is the only one who knows it was good.
3. **Never end a session with two images in the repository.** Two means somebody stopped halfway,
   and whoever arrives next cannot tell which one is trusted.

`scripts/teardown.sh` does step 2 for you: after deleting the service it removes every image
except the one matching the current `server/` source. If this session's runs **failed**, pass
`REAP_OLD_IMAGES=0` to keep the older image so you can roll back to it. `PURGE_IMAGE=1` still
removes the repository outright when the project is finished for good.

The same rule applies to anything else the cloud accumulates without being asked: check what a
session left behind before you call it finished. Listing costs nothing.

## When the work needs the user

Some tasks cannot be finished by an agent alone: recording a video, holding a tape measure,
dragging something too small to hit reliably, confirming a picture looks right. **A task needing a
person is still your task to drive.** Do not write "the user should test this" and consider it
delivered — that is how work goes stale here. The protocol, every time:

1. Do everything that does not need them. Prepare the setup, open the right screen, write the
   checklist, get the app into the exact state where their one action is the only thing missing.
2. Ask for **one specific action**, concretely, and say what you will do with the result. Not
   "please verify the UI" — "drag from the port on the right of Point Cloud to the input on the
   left of Viewer 3D, then tell me whether a wire appeared."
3. Wait. Do not guess the outcome or move on as if it happened.
4. Take the result, finish the task, verify it yourself, update the Registry and TASK. Tasks say
   whether they need this, under **Approval**.

## Finishing a unit of work

Every change ends in the loop that matches it:

| What changed | How you check it |
|---|---|
| Any code | `scripts/verify.sh` — types, unit tests, fixture smoke, documentation check |
| The interface | The design-review workflow in `.agents/skills/design-review/SKILL.md` |
| Viewer or geometry | `scripts/inspect.mjs` — assert real numbers on a real run, and look at it |
| The deployed service | `scripts/smoke-infer.sh` — one short run, never a loop of GPU runs |

Run `scripts/verify.sh` with a Python environment that has FastAPI installed, or the server check
silently skips and the green tick means less than it looks:

```
VERGE_PY=.venv/bin/python ./scripts/verify.sh
```

`.nvmrc` pins the Node version. Install with `npm ci --prefix app`, never `npm install` — the
lockfile is the record of what the CI and the development machine both ran. Cloud resource names
come from `.env.local`, copied from `.env.local.example`; nothing in the app hard-codes them.

**How the tests are arranged.** They sit beside the code they cover, named `*.test.ts` — 41 files
and 547 tests as of 2026-08-12. There is one runner: `vitest`, from `app/`, and its glob reaches
`../geometry` and `../scripts` deliberately, so neither can drift from the app on types or on the
camera convention. File parallelism is off, because several fixture suites each rebuild the same
million-point cloud and running them together makes their wall-clock time a function of worker
contention rather than of anything real.

**There are no browser or component tests.** The interface is checked by the design-review
workflow instead, against this app's own captures in `docs/reference/`. Anything you can see on
screen is untested by `verify.sh`, whatever its green tick says.

**Record only what you observed.** A ticked box for code that was written but never run has cost
this project real money twice. If you built something and did not exercise it, say so and leave
the box unticked. An untested seam described as working is worse than one described as absent.

Commit at the end of each coherent unit. Never commit dependencies, model weights, secrets, or
media over 5 MB.

Work happens on a branch off `main`, and CI runs `verify.sh` on Linux on every push. There are two
remotes: **`origin`** (`henrikmm/verge-studio`) is the standalone repository and the copy that
matters; `greenv` carries one mirrored branch so a group can see the work. Push to `origin` unless
told otherwise. Branch protection is not available on this plan, so nothing but you stops a bad
push — see REGISTRY section 6.

**Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)**, as of
2026-08-08. `<type>(<scope>): <summary>`, then an optional body and footers, blank line between.

- **type** — `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore` `revert`.
- **scope** — optional, the area touched: `geometry` `inspect` `panes` `graph` `server` `docs`.
- **summary** — imperative, lower case, no full stop, 72 characters or fewer.
  `fix(geometry): bound reported tilt by its own gate`, not `Make the floor honest again`.
- **body** — why, not what; wrapped at 72. Required when the change alters a measured number or a
  file the harness reads. `BREAKING CHANGE:` goes in a footer if callers must change with it.

## Looking at a run without opening the app

Most questions here are about a reconstruction, not the interface. `scripts/inspect.mjs` answers
them from the app's own runs and geometry, over no network — it cannot disagree, or spend money.

| What you want to know | Command |
|---|---|
| Where did the floor land, and does it survive a reseed? | `inspect floor <id>` · `--repeat 8` |
| Is the floor under the furniture or through it? | `inspect view <id> --view floor --colour inlier` |
| What was the model given, and what never reached the cloud? | `inspect frames <id>` · `coverage <id>` |
| **Is what I selected really the thing I think it is?** | `inspect select <id> --band 0.02,0.6` |
| All of it, when the broken stage is not yet known | `inspect explain <id>` |

`node scripts/inspect.mjs` lists the rest; images land in `.inspect/`, path printed. **Open them.**
A height statistic over ground is only a measurement of grass if that ground is grass, and only the
selection drawn on the source frame can tell you whether it is.

## Claims, and what has to be attached to one

English throughout, in the files and in the conversation — the same person reads both. Two things
about vocabulary, then the part that actually matters.

**Never explain programming.** The reader writes software and started this project. **Explain a
domain term the first time it appears**, in a clause rather than a footnote — depth models, plane
fitting, the geometry are what they are deliberately picking up. Use the exact term rather than an
easier one that is slightly wrong; define it once, then use it freely. Do not simplify the
subject, and do not write around a word because it is long.

**Where this repository is strict is claims about the system**, because a claim is the one thing
the reader cannot check by looking at the code. It costs nothing to write that a fit improved, and
nothing to be wrong about it.

- **A claim carries its evidence** — the file, the run id, the date, the command. "Moves the floor
  by 31.9 cm" can be argued with; "significant drift" cannot. If a number is a guess, say so and
  give the range. Put the file and function names in the evidence line, where someone will look
  them up, not in the sentence explaining why the decision was made.
- **Outcome first, mechanism second.** A reader who stops after the first sentence should still
  have the thing that mattered.
- **Say what you observed, not what you expect.** Code that was written but never run is described
  as untested, not as working. That distinction has cost this project real money twice.

**This governs claims, not every sentence.** Most work here is ordinary engineering, and a comment
explaining why a function guards its input needs no measurement behind it. Writing that reads well
is welcome. Writing that sounds authoritative about something nobody checked is the failure, and
it is the only one this section is trying to prevent.

`TASK.md` is the register to copy: technical throughout, and plain because somebody is about to
act on it. `REGISTRY.md` runs denser under the same rules. Code comments explain **why** and never
restate **what**.

Code style: TypeScript in strict mode, file names in kebab-case, React components in PascalCase.

## Boundaries

- `donor/` holds verbatim copies from an earlier project, kept for reference. Application code
  never imports from it. The predecessor repository, when present, is read-only.
- `server/` is frozen unless the user has agreed to pay for a rebuild. Any edit under it — even a
  comment — forces a ~20 minute rebuild on the next deploy. Batch small changes with a real one.
- When you are unsure how the depth model, React Flow, Dockview or Three.js behaves, check
  `docs/SOURCES.md` before guessing.
