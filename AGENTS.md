# Verge Studio — how to work in this repository

Verge Studio measures real-world heights from ordinary video. You drop in a clip, a depth model
running on a cloud GPU reconstructs the scene in three dimensions, and the app measures things in
it against a fitted ground plane. The interface is a node graph: boxes wired together, each one
doing a step, so every stage is visible rather than hidden inside a single button.

This file is the working agreement. Read it, then read the two documents below.

## The two documents, and which one answers your question

| Question | Document |
|---|---|
| What already works, and what was decided and why? | `docs/REGISTRY.md` |
| What should I do next? | `docs/PROGRESS.md` |

`docs/REGISTRY.md` is the record of the project. It has no task list and no checkboxes.
`docs/PROGRESS.md` is the task list, and only the task list. When you finish a task, delete it
from Progress and add what it established to the Registry, in the same change. Git history is the
archive; do not keep a second copy of finished work.

Supporting documents: `README.md` (how to run it), `MEASUREMENTS.md` (tape-measure ground truth
and graded results), `docs/DESIGN.md` (what the interface must look like and do),
`docs/SOURCES.md` (external references worth trusting).

## How the work is done

**Everything that can run on this Mac, runs on this Mac.** Extracting frames from video,
geometry, tests and every viewer are local and free. The cloud does exactly one thing: the
forward pass of the depth model, which needs a GPU. Never send CPU-shaped work to the cloud.

**Video is the input, not photographs.** The model's accuracy comes from comparing many frames of
the same scene against each other. A single image never engages that mechanism and produces badly
wrong geometry. Sample frames by frames-per-second across the whole clip, never "N frames spread
across it", and never trim a clip to a window.

**Nothing is kept unless the user saves it.** Inference output is temporary by default. Saving is
an explicit action; never persist automatically.

**The model is for personal and research use only** (its licence is non-commercial). Never write
a commercial claim into this project.

## Paid work needs permission, every time

Running the GPU service costs real money for as long as it exists — not just while it computes.
You are billed for the machine's whole lifetime, including several minutes of startup and the
idle period afterwards. Two consequences follow:

- **Ask before you spend, and say what it will cost.** Deploying, running inference, or anything
  else that starts or wakes the service requires the user to agree first, in that conversation.
- **Delete the service when you are done.** This is a correctness requirement, not tidiness: the
  service is configured to keep one machine permanently alive, so it never stops billing on its
  own. Save any run you care about *before* deleting, because the results live on that machine
  and disappear with it.

Plan the whole batch of experiments before deploying, and run them back to back against one warm
machine. Four experiments in one session cost roughly one startup; four sessions cost four.

Checking costs nothing. The app's Inspector has a **Cloud control** panel that reports whether
you are signed in, whether the service exists, and whether the next deploy will be quick or slow.
Those are all read-only lookups and cannot wake anything.

## When the work needs the user

Some tasks cannot be finished by an agent alone: recording a video, holding a tape measure,
dragging something too small to hit reliably, confirming that a picture looks right. **A task
needing a person is still your task to drive.** Do not write "the user should test this" and
consider it delivered — that is how work goes stale here.

The protocol, every time:

1. Do everything that does not need them. Prepare the setup, open the right screen, write the
   checklist, get the app into the exact state where their one action is the only thing missing.
2. Ask for **one specific action**, described concretely, and say what you will do with the
   result. Not "please verify the UI" — "drag from the port on the right of Point Cloud to the
   input on the left of Viewer 3D, then tell me whether a wire appeared."
3. Wait. Do not guess the outcome or move on as if it happened.
4. Take the result, finish the task, verify it yourself, and update the Registry and Progress.

Tasks in Progress state whether they need this, under **Gate**. Flag it there so neither of you
is surprised.

## Finishing a unit of work

Every change ends in the loop that matches it:

| What changed | How you check it |
|---|---|
| Any code | `scripts/verify.sh` — types, unit tests, fixture smoke, documentation check |
| The interface | The design-review workflow in `.agents/skills/design-review/SKILL.md` |
| Viewer or geometry | Load a saved run and assert real numbers: point count, bounding box, depth range |
| The deployed service | `scripts/smoke-infer.sh` — one short run, never a loop of GPU runs |

Run `scripts/verify.sh` with a Python environment that has FastAPI installed, or the server check
silently skips and the green tick means less than it appears to. `README.md` gives the command.

**Record only what you observed.** A box ticked for code that was written but never run has cost
this project real money twice. If you built something and did not exercise it, say so plainly and
leave it as a task. An untested seam described as working is worse than one described as absent.

Commit at the end of each coherent unit. Subject line: short, imperative, 72 characters or fewer,
no long body. Never commit dependencies, model weights, secrets, or media over 5 MB.

## How to write here

These documents are read by people as well as agents, and the person reading them has to agree
with what they say. Write accordingly:

- **Say the outcome first**, then the mechanism. A reader should learn what happened before they
  learn how.
- **Explain a specialist term the first time it appears**, in a clause, not a footnote. Do not
  drop jargon to sound precise; precision is in the numbers.
- **Keep file names and function names in the evidence sections**, where someone is going to look
  something up. They do not belong in a sentence explaining why a decision was made.
- **Be specific about uncertainty.** "Measured 22.02 GiB on 2026-08-05" beats "high". If a number
  is a guess, say it is a guess and give the range.
- Everything in this repository is in English.

Code follows the same spirit: TypeScript in strict mode, file names in kebab-case, React
components in PascalCase, and comments that explain why rather than restate what.

## Boundaries

- `donor/` holds verbatim copies from an earlier project, kept for reference. Application code
  never imports from it. The original repository at `~/dev/Motiva_Challenge` is read-only.
- `server/` is frozen unless the user has agreed to pay for a rebuild. Any edit under it — even a
  comment — forces a rebuild of roughly twenty minutes on the next deploy. Batch small changes
  and apply them together with a real one.
- When you are unsure how the depth model, React Flow, Dockview or Three.js behaves, check
  `docs/SOURCES.md` before guessing.
