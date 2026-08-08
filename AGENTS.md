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

## How the work is done

**Everything that can run on this Mac, runs on this Mac.** Extracting frames, geometry, tests and
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
  machine permanently alive, so it never stops billing on its own. Save any run you care about
  *before* deleting — results live on that machine and disappear with it.

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
silently skips and the green tick means less than it looks. `README.md` gives the command.

**Record only what you observed.** A ticked box for code that was written but never run has cost
this project real money twice. If you built something and did not exercise it, say so and leave
the box unticked. An untested seam described as working is worse than one described as absent.

Commit at the end of each coherent unit. Never commit dependencies, model weights, secrets, or
media over 5 MB.

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

## How to write here

Everything here is in English, and all of it is aimed at one reader. This applies to what you say
in the conversation too, not only to the files — the same person reads both.

**Picture the reader, because they are real.** They work in software and they read this code.
They started this project and know exactly what it is for. What they are still picking up is the
domain: depth models, plane fitting, the geometry. They are picking it up deliberately, and they
are not slow — but they will not stop to decode your vocabulary, and they should not have to.

So: never explain programming, they know what a function is. Always explain a domain term the
first time it appears, in a clause rather than a footnote. And never make them work to reach an
idea they would have understood immediately.

The subject here is genuinely hard, and that is the reason to keep the writing easy. Difficulty in
the sentence adds to difficulty in the material and the reader pays for both. A paragraph that is
hard to read does not deliver its idea, however correct the idea is.

The test is mechanical: **read the sentence aloud.** If you run out of breath, or have to go back
to find the subject, it is too long. Cut it in two.

- **One idea per sentence.** Two clauses joined by "which", "so that" or a semicolon are usually
  two sentences pretending to be one.
- **Numbers instead of adjectives.** "Moves the floor by 31.9 cm" tells the reader what to do
  next. "Significant drift" tells them nothing and cannot be checked. If a number is a guess, say
  it is a guess and give the range.
- **Outcome first, mechanism second.** What happened, then how. A reader who stops after the first
  sentence should still have learned the thing that mattered.
- **Say it plainly, then name it.** "An algorithm that guesses at random and keeps the best guess
  (RANSAC)" costs four words and loses nobody. Short words and ordinary grammar everywhere else:
  "use", not "utilise"; "because", not "due to the fact that".
- **Write to be disagreed with.** Give the file, the run, the date. A claim nobody can check is an
  opinion.
- **File and function names belong in the evidence lines**, where someone will look them up — not
  in the sentence explaining why a decision was made.

**The failure to avoid is writing that performs.** It reads as careful and costs the reader a
pass to unpack. It is the most common way work here goes unread:

> ✗ The exporter's adaptive percentile floor decimates the reconstruction's less-certain strata.
> ✓ The exporter throws away the least confident 40% of every pixel.

Same fact, nothing lost, one obstacle removed — and the second version can be checked, because it
has a number in it. If you catch yourself reaching for an unusual word, the plain one was almost
certainly right. Ornament is not a style choice here; it is a defect.

**`TASK.md` is the model — read it before writing anything else.** It is the plainest file in the
repository because someone is about to act on it, and it stays technical throughout: the register
to copy is *precise and ordinary*, not *simplified*. `REGISTRY.md` carries evidence and runs
denser, under exactly the same rules. Code comments explain **why**, and never restate **what**.

Code style: TypeScript in strict mode, file names in kebab-case, React components in PascalCase.

## Boundaries

- `donor/` holds verbatim copies from an earlier project, kept for reference. Application code
  never imports from it. The original repository at `~/dev/Motiva_Challenge` is read-only.
- `server/` is frozen unless the user has agreed to pay for a rebuild. Any edit under it — even a
  comment — forces a ~20 minute rebuild on the next deploy. Batch small changes with a real one.
- When you are unsure how the depth model, React Flow, Dockview or Three.js behaves, check
  `docs/SOURCES.md` before guessing.
