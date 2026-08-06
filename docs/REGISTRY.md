# Registry — what exists and why

The record of this project: what works, what was decided, where the proof is, and what is still
unknown. Everything here has been observed, not merely written.

There are no tasks in this file. Work still to be done lives in `PROGRESS.md`.

---

## 1. What the system does today

Drop a video into the app and the following happens, all of it verified in a browser:

1. **The clip is read locally.** Frames are extracted by ffmpeg on this Mac, sampled evenly
   across the whole clip at a chosen rate, and shrunk to 1024 pixels on their long edge.
2. **The frames are sent to a GPU service** — and only when the user presses Run. This is the one
   paid step. The service runs Depth Anything 3, which returns a depth value for every pixel of
   every frame, plus where the camera was for each one.
3. **The results come back as a 3D scene** the user can orbit, alongside a colour-coded depth
   image per frame.
4. **A ground plane is fitted** to the scene, and its quality is reported rather than assumed.
5. **The user marks an object** — by painting on a frame, or by clicking once and letting a
   segmentation model propose the shape — and the app measures its height, states an uncertainty,
   and grades it against a tape measurement if one has been recorded.

Around that spine:

- **Runs are temporary until saved.** A finished run is selectable immediately but nothing large
  is written to disk until the user presses Save, which copies it to `~/verge-runs`, outside the
  repository. Runs can be deleted from the same pane.
- **Results outlive the machine that produced them.** Artifacts go to a private bucket and reach
  the browser through signed links that expire in twelve hours, so deleting the service destroys
  nothing and the browser never touches the instance to read a result. The objects themselves are
  deleted after three days by a rule GCS enforces. Saving is still the only way to keep a run.
- **Measurement targets belong to a clip**, keyed by the video's content digest. A clip nobody has
  measured before starts with an empty set, never another clip's objects.
- **Repeat measurements accumulate.** Each recorded trial freezes the exact mask it was measured
  from, so any number in this project can be traced back to the evidence that produced it.
- **The whole app runs offline.** The dev server answers the inference request from a stored
  fixture, so the interface can be built and reviewed at zero cost. Anything produced that way is
  labelled as a mock on screen.
- **Scratch data ages out by itself.** Dropped videos and extracted frames are copied under the
  OS temp directory and were never cleaned up. They are now swept at dev-server startup and before
  each upload or extraction: only the two exact directories, only their immediate children, only
  entries older than a day, and never through a symbolic link. Anything that cannot be removed is
  reported and skipped. (`app/vite-plugins/temp-store.mjs`, 12 tests.)
- **Cloud state is visible before money is spent.** The Inspector reports whether gcloud is
  signed in, whether the service exists, and whether the next deploy is the quick path or the
  twenty-minute one. Deploy and Delete service both run from the app and stream their logs.

### Verified end to end on real hardware

On 2026-08-05 a clip that had never been through the pipeline (`da3Test.mp4`, 1920×1080, 13.55 s)
was deployed, run, displayed, saved and torn down entirely from the app: 112 frames at 8.27 fps,
36.9 seconds of GPU time, a 102 MiB result file fetched in five chunks and verified by checksum,
128 MB brought home to `~/verge-runs`, service deleted afterwards.

On 2026-08-06 the same path ran again with results in cloud storage rather than on the instance
(`test-demo-door.mp4`, 35.57 s, 81 frames at 504 px, 28.21 s of GPU time). The browser fetched
`scene.glb` and a **76.3 MB npz in one request each, straight from the bucket** — no ranged chunks,
because the 32 MiB cap belongs to Cloud Run and not to storage. Save brought 91.4 MB home through
`gs://` at 34.5 MiB/s, a page reload re-opened it with the cloud disconnected, and teardown left
no service and exactly one image. Whole session: **25 minutes of instance lifetime.**

---

## 2. How it is put together

| Area | Where | What it holds |
|---|---|---|
| Interface | `app/src/panes/` | One file per dockable pane: 3D viewport, depth image, graph, inspector, objects, runs |
| Node graph | `app/src/graph/` | The engine, the store, and one file per node type in `nodes/` |
| Dev server | `app/vite-plugins/` | Local file routes, the offline mock, the run registry, cloud control, the job runner |
| Geometry | `geometry/` | Only what the model does not provide: gravity, ground plane, back-projection, measurement, uncertainty, calibration |
| Service | `server/` | The FastAPI wrapper around the model, and its Docker image |
| Scripts | `scripts/` | Deploy, teardown, frame extraction, run download, verification |
| Instructions | `AGENTS.md`, `.agents/skills/` | Shared, tool-neutral working rules and workflows |

**The documentation is checked mechanically**, by `scripts/check-docs.mjs` inside `verify.sh`:
unfinished work may only appear in the task list, each task must answer all five of its required
questions with a recognised gate, relative links must resolve, the Claude instructions must import
the shared ones, and four files have line and byte budgets. The task list reached 1,635 lines once
because finished work was never removed; the budgets are what stop that happening again.

**The graph is content-addressed.** Every node computes a key from its parameters and its
inputs' keys. Changing something restamps that node and everything downstream of it, and nothing
else — so adjusting a display setting never invalidates an expensive reconstruction.
(`app/src/graph/evaluate.ts`, `cache-key.ts`; 21 tests in `evaluate.test.ts`.)

**Free nodes run by themselves; costly ones never do.** The depth node is marked manual and goes
stale rather than running, so no amount of moving controls can start a paid run. The badge on a
node card overrides this in either direction when the user asks for it, but the automatic refresh
that follows a control edit bars costly nodes outright regardless of the badge — the Inspector is
where the sampling controls live, so that pass must not be a route to the GPU. Verified in the
browser on 2026-08-06 by badging the depth node auto and dragging its resolution slider: the value
applied, the graph refreshed, the node stayed blocked at 0 ms and no inference request was sent.
(`graph-store.ts` `runAutoFree`, `evaluate.ts` `deny`.)

**Editing a control brings the graph back up to date on its own**, after a short delay that folds
a slider drag into one pass. Before this, changing a value only marked work as out of date and
left it there: switching the run source stranded eight nodes with no visible way forward, and the
panes went on showing the previous scene. (`graph-store.ts` `setNodeParamAndRun`.)

**Wires can be selected and cut.** Clicking a wire highlights it and Backspace removes that one
wire. React Flow is fully controlled here, so it cannot hold a selection of its own — carrying the
selected flag on the edge is what makes deletion reachable at all. Node and wire selection are
mutually exclusive so Backspace always has one meaning. The connection rules — types must match,
and an input takes one wire so connecting replaces rather than stacks — live in
`app/src/graph/connect.ts` with 12 tests, and were driven by real mouse drags on 2026-08-06.

**Panes are tapped off wires, not driven by them.** A viewport reads whatever arrives on its
input port; it computes nothing. Objects are rows in a pane rather than nodes in the graph,
because hundreds of measurement cells would turn the canvas into confetti.

---

## 3. Measured facts — do not re-derive these

### The GPU's memory ceiling

The L4 card reports **22.03 GiB usable** (23,659,151,360 bytes), not the advertised 24 — that
figure is decimal and some is reserved. The model occupies 6.57 GiB once loaded. A cold start
takes about 64 seconds, of which 40 is loading the model.

Memory grows with the number of frames and the processing resolution, not with the length of the
clip. Measured on 2026-08-01, each run isolated (`docs/vram-measurements.json`):

| Frames | 504 px (driver / allocator) | 356 px | 252 px |
|---|---|---|---|
| 32 | 14.24 / 11.63 GiB · 12.2 s | | |
| 64 | 16.94 / 13.87 GiB · 15.2 s | | |
| 112 | 21.28 / 17.23 GiB · 30.2 s | | |
| 128 | 21.94 / 18.35 GiB · 37.7 s | | |
| 144 | 21.88 / 19.47 GiB · 42.1 s | | |
| 160 | **out of memory** | | |
| 192 | **out of memory** | 19.39 / 15.01 GiB · 24.6 s | |
| 256 | **out of memory** | 21.54 / 17.51 GiB · 35.2 s | 15.89 / 12.69 GiB · 16.1 s |

The allocator figure is the honest signal and fits **0.0700 GiB per frame plus 9.39 GiB**. The
driver figure flattens near the top because it saturates against the device limit — 144 frames
reads *lower* than 128, which is a plateau with scatter, not a curve.

**The frame limit is 112, not 144, deliberately.** Both 128 and 144 finished at roughly 99% of
the device, which is a coin flip rather than an operating point. 112 leaves about 15% headroom.

**Ten frames per second is reachable, just not at full resolution.** Resolution buys frames as its
square: 256 frames run comfortably at 252 px and fit at 356 px.

**Orientation is free. Measured, not assumed.** Two runs at 81 frames and 504 px — one landscape
(504×280) and one portrait (280×504), different clips, different content, different GPU seconds —
returned **byte-identical** peaks: 20,489,175,040 driver and 16,165,363,712 allocator. Same pixels
per frame (141,120), same memory. A transposed tensor reserves the same blocks, so "landscape costs
more" is not a mechanism. (`~/verge-runs/20260805-151526-a99a78` and `.../20260806-173802-d354a2`.)

That 81-frame run is also the ladder's cleanest confirmation: the fit predicts
0.0700 × 81 + 9.39 = **15.06 GiB** allocator and both runs measured **15.055 GiB**.

⚠️ **The 112-frame landscape excess is still unexplained — but shape is no longer the suspect.**
A 1920×1080 clip measured **22.02 GiB at 112 frames and 504 px on 2026-08-05, 0.74 GiB above the
table and 99.96% of the device.** With orientation ruled out, the live candidates are a different
**pixel count per frame** (`upper_bound_resize` fixes only the long edge, so aspect ratio moves the
short one) or **driver saturation**, which this table already shows near the ceiling. The ladder
does not record pixels per frame, which is what leaves the question open. Until it is settled,
**81 frames at 504 px** remains the verified conservative setting near the top of the range.

⚠️ **Coded dimensions are not the shape the model sees.** `test-demo-door.mp4` is coded 1920×1080
with `rotation=-90` in its side data, so it displays — and extracts — as 1080×1920 portrait. ffprobe's
`stream=width,height` reports the coded pair and reads as landscape. Anything characterising frame
shape must read the rotation metadata, or it will label its own clips wrongly. Found 2026-08-06,
after this run was planned as a landscape test and turned out to be a portrait one.

### Inference settings, and why each one

| Setting | Value | Reason |
|---|---|---|
| Frame sampling rate | 10 per second | The model's own public demo defaults to this |
| Frame limit | 112 | Measured above; never remove it |
| Processing resolution | 504 | The default in the model's API, command line and demo alike |
| Resize method | upper bound | The demo's own default |
| Reference view | middle | The model's documentation recommends this for video, where frames are in time order |
| Gaussian splats | off | Nothing in this project consumes them — see decision 7 |

When the requested rate would exceed the frame limit, the app lowers the effective rate, shows
the arithmetic and says so. It never silently shortens the clip.

### Other measured numbers

- Building the 12 GB service image takes **19 min 30 s**. One stored image is 9.8 GB and costs
  roughly $1 a month to keep, which is why it is kept rather than rebuilt. That price is **per
  image**, and images used to accumulate — see the standing-cost audit below.
- Result files are large: **108 MB at 112 frames and 504 px**. The 3D scene file is only ~16 MB.
- The model writes no result file of its own; ours is the only one. This was measured, not assumed.

### What a run actually weighs, in both directions

Measured 2026-08-06 from the saved door run at 112 frames and 504 px
(`fixtures/door/504px-112f/manifest.json`):

| | Content | Size |
|---|---|---|
| Sent up | 112 JPEG frames | **4.7 MB**, ~39 KB per frame |
| Came back | `scene.glb` | 16.1 MB |
| Came back | `verge-result.npz` | 105.5 MB |
| | **total returned** | **121.6 MB — about 26× what was sent** |

The output is **not** "depth images". The depth preview PNG is a ~10 KB thumbnail; the 105.5 MB is
four float arrays — depth, confidence, extrinsics, intrinsics — across every frame. That asymmetry
is why the 32 MiB response cap matters and why saving a run is chunked.

That run's diagnostics also confirm the model wrote **no npz of its own**: `native_npz` was empty
and the export directory held only `scene.glb`, `scene.jpg` and our `verge-result.npz`.

### Standing cloud cost, audited 2026-08-06

Nothing was reaping container images, and the documented cost was roughly a third of the real one.

| Where | Held | Reported size |
|---|---|---|
| `verge-lab` → `verge` | **two** `da3-service` images, one per `server/` source hash | 16.68 GB |
| `motiva-verge-lab-dev` → `mvl-worker` | a third copy, from the retired donor project | 11.80 GB |
| `motiva-verge-lab-dev-fdcfc626` | donor run outputs under `runs/**` | 29.69 MB |

About 28.5 GB, roughly $2.85 a month, against scripts that claimed ~$1. The stale `verge` image and
the entire donor repository were deleted the same day; only the current image remains. **Artifact
Registry reclaims shared layers asynchronously**, so the repository still reported 16,679 MB
immediately after the deletion — the figure lags the delete and was not re-checked here.

The donor bucket shows what happens when a rule misses: its lifecycle rules cover `temporary/`,
`incoming/`, `source-archives/` and `viewer/` — **but not `runs/`, which is where its output
actually went**. Those objects have no expiry at all.

**`gs://verge-lab-runs` was created on 2026-08-06** and is the first output bucket this project has
had. Its rule was applied and re-read *before the first object was written*: `Delete` at `age: 3`
matching `runs/transient/`. Checked again after the session's runs, by listing every object rather
than by trusting the rule's existence — **10 of 10 objects under the matched prefix, no orphans.**
It held 113.6 MiB at teardown, about 1.1 cents a month, and empties itself in three days.
(`scripts/create-bucket.sh`, `scripts/bucket-lifecycle.json`.)
- Extracting a whole ladder of frame counts takes **13 seconds** in one pass. Doing it one rung
  at a time took 435 seconds and once locked up the machine — see the lessons section.

---

## 4. Decisions that hold

1. **Selection happens on a 2D image, not in the 3D cloud.** Clicking individual points in a
   rotating cloud is miserable and does not scale. Each frame has its own depth and camera
   position, so a mask painted on the picture maps exactly onto 3D points. This is also why
   selection reads the raw result file rather than the 3D scene file: the scene file is a
   thinned sample with no record of which pixel each point came from.

2. **Never take the highest point as the top of an object; take a high percentile.** Mask edges
   produce points that are a blend of the object and whatever is behind it, and those land
   exactly at the top edge. Two separate fields — computer vision and forestry canopy
   measurement — arrived at the same fix. The pipeline shrinks the mask slightly, filters by the
   model's own confidence, removes statistical outliers, then takes the percentile.

3. **The ground is the surface with almost nothing beneath it.** Standard plane-fitting finds
   walls: on a real fixture it returned three tilted planes with more support than the floor had.
   Ranking by how many points support a plane puts it mid-scene, because a floor seen while
   walking is one of the *sparsest* surfaces. Ranking by how densely it fills its own footprint
   is worse and backwards. What works is the definition itself — 4.3% of the cloud below the real
   floor versus 60.6% below the wrong mid-scene plane is a clean separation from one cheap pass.

4. **Which way is up comes from the camera path, and it is cross-checked, not trusted.** There is
   no motion sensor in a video-only pipeline, but averaging the camera's own downward axis across
   frames works — measured 0.925 to 0.953 agreement across fixtures. The fitted floor's own
   normal is compared against it and the disagreement is reported rather than silently resolved.

5. **A first fit must never become its own reference.** An earlier design fitted a floor, took a
   slice near it, and re-fitted — which could manufacture a precise-looking but strongly tilted
   floor: 0.7% support and 27.9° of tilt behind a healthy-looking 2 cm fit error. The replacement
   scores independent competing hypotheses on support, tilt, mass below the plane and fit error
   together. No single one of those numbers is allowed to stand alone.

6. **Scale is per-clip, and the known object grades rather than corrects.** Metric scale from this
   family of models drifts between scenes, so a factor calibrated in one clip does not transfer to
   another. The model's raw output stays the primary answer; a tape-measured object in the same
   clip is a quality check. Any corrected number is labelled as corrected.

7. **Gaussian splats are not a deliverable.** They improve appearance and novel views, but no
   measurement step consumes them — depth, camera positions and the point cloud already carry the
   geometry. Repairing them would need a larger build, more GPU time and another viewer for no
   measurement benefit. The app-side controls were removed on 2026-08-04.

8. **Uncertainty is split by kind, never averaged into one number.** Random scatter and known bias
   are reported separately, because a bias stated as a plus-or-minus reads as noise. This is not
   theoretical: a wrong measurement of 1.887 m once sat beside a ±0.037 m figure that covered none
   of its 0.213 m error. (`geometry/uncertainty.ts`, six tests pin that bias cannot migrate into
   the random term.)

9. **Abstaining is a real answer.** Below a minimum point count, or with a low segmentation score,
   or with two nearly tied candidate shapes, the app refuses to report rather than guessing.

10. **Colour carries meaning, not status.** The eight port colours are a type legend — a wire's
    colour tells you what flows through it. State rides a neutral brightness ramp plus a shape
    (`●` current, `◐` working, `○` idle, `▲` failed), so it survives a greyscale screenshot and
    colour blindness. Two exceptions are deliberate, both because the mark sits on a photograph:
    the mask overlay and the port colours themselves.

11. **The plane fit must be deterministic.** The app caches by content, so a step returning a
    different answer for identical input would quietly corrupt that model. Ours is explicitly
    seeded. Confirmed on real data: nine independent user recordings produced byte-identical floor
    diagnostics.

12. **Keep the built image, delete the service — but keep exactly one.** Storage is about a dollar
    a month; rebuilding costs twenty minutes of every session. The deploy script tags the image
    with a digest of the `server/` directory and skips the build when that exact source is already
    stored, so a stale image can never be deployed by accident. This was reversed on 2026-07-31 —
    the previous rule optimised the cheap axis.

    The per-image tag has a cost the original rule missed: every change to `server/` leaves another
    ~12 GB image beside the last one, and nothing deleted it. By 2026-08-06 that was two images and
    three times the assumed charge. So a new image is now **promoted** rather than added — it is on
    trial until it has served a real run, and the previous one is deleted in that same session.
    `scripts/teardown.sh` does this, and refuses to when no image matches the current `server/`
    source, because reaping "everything that is not current" would otherwise delete the only image
    there is. `REAP_OLD_IMAGES=0` keeps both when a session's runs failed and rollback matters more
    than a dollar.

13. **Transience is enforced by the service, not by the instance dying.** "Nothing is kept unless
    the user saves it" was, until 2026-08-06, an accident of scheduling: nothing deleted a
    successful run, and only the machine shutting down reclaimed anything. With `--min-instances=1`
    holding a machine alive for a whole session, every run's frames and exports stayed resident the
    entire time. The service now discards uploaded frames the moment inference returns — they are
    input, nothing reads them again — and sweeps run directories past `VERGE_RUN_TTL_SECONDS`
    (six hours) at the top of each `/infer`. The window is deliberately generous: a batched session
    saves its runs at the end, and deleting one early would destroy something already paid for.

    **The sweep was watched working on a deployed instance on 2026-08-06**, which is what this
    entry was missing — the code had shipped without ever running. With the TTL temporarily set to
    60 s, run A's `/artifact` went **404** after it expired while run B's stayed **200**, and run
    A's copies in the bucket were untouched. That is the whole design in one observation: the
    instance reclaims its disk, the result survives anyway.

    The frame discard is honestly *not* independently verified. It runs unconditionally on the
    `/infer` success path, so it executed in all four deployed runs, and unit tests pin its
    behaviour — but it has no signal through the API, so nothing was observed. Said plainly rather
    than counted as proven.

14. **Artifacts live in a bucket, reached by signed link; the durable address travels beside it.**
    Writing results to the container's own disk made a result address meaningful only on the
    instance that produced it, which is what forced `--min-instances=1` and made teardown a
    correctness requirement rather than hygiene. Objects have no such affinity, so the service now
    scales to zero and the two settings move together — `deploy.sh` refuses to deploy at
    `--min-instances=0` if the bucket is missing, because splitting them is how 2026-08-05 happened.

    **Each artifact carries two addresses, and the pair is the point.** `url` is a signed HTTPS
    link the browser fetches directly — no dev-server hop, no Cloud Run in the path, and therefore
    no 32 MiB response cap, so a 76 MB npz arrives in one request instead of five ranged chunks.
    `gs_uri` is the permanent address, and it is what Save resolves. Collapsing them would break
    saving: a signed link expires in twelve hours, while `save-run.sh` copies the manifest into the
    run directory as that run's archive record. A run saved the next morning comes home through
    `gs_uri` and would have failed through `url`.

    **Publishing may never fail a run.** It happens after `model.inference` has returned, so the
    GPU is already paid for; a storage permission slip that raised would throw away a finished run
    to report a problem that costs nothing to route around. `_publish` falls back to the local
    `/artifact` path and records why, surfacing as `diagnostics.publish_mode: "degraded"`. That
    mode is reported on screen, because a degraded run is otherwise indistinguishable from a
    durable one right up to the moment teardown destroys it.

    Signing inside Cloud Run has no private key, so it goes through the IAM `signBlob` API and the
    runtime account needs Token Creator **on itself** — the failure that would otherwise be
    discovered after a GPU run. `/publish-check` proves the whole chain for one HTTP request.

---

## 5. What has been measured, and how well

Full tables, tape-measure truths and the error analysis live in `MEASUREMENTS.md`. The summary:

**On the primary clip, at 504 px and 112 frames**, the pipeline measures a 2.10 m door, a 0.75 m
table and a 0.45 m computer tower with a raw average error of about 0.037 m across the two
holdout objects. Fitting a line through predicted-against-true separates a scale error of about
3% from the remaining scatter of about 0.008 m.

**Repeatability within one sitting is excellent and was a surprise.** The same person repainting
the same endpoints reproduces them to **1 to 6 mm** — 15 to 90 times smaller than the error
against the tape measure. The study was designed on the assumption that operator placement was
the missing noise term. It is not; what remains is systematic bias, which is correctable.

**Between sittings is a different and larger number.** Two objects moved 23 and 24 times their
within-sitting spread when compared against masks painted in an earlier session. The cause was
identified — one mask's lower edge never reached the bottom of the door — so it is one mistake
rather than scatter. It still shows that back-to-back repeats cannot measure this.

**The dangerous case is a wrong answer that looks healthy.** The 1.887 m door came with a
plausible spread, a supported floor and a good fit error. No reported statistic distinguished it
from the correct 2.020 m; only looking at where the mask sat did. This is why the app highlights
selected points live in 3D while painting, and why automatic selection must be able to abstain.

**Resolution verdict: 504 px with 112 frames**, which wins on both raw and corrected error while
costing less GPU time than the 356 px alternative.

---

## 6. Where the evidence lives

**Tracked in git** — a fresh clone has these:

| Evidence | Path |
|---|---|
| Nine repeatability trials with their masks | `docs/measurement-trials-2026-08-04.json` |
| The measured memory ladder | `docs/vram-measurements.json` |
| Tape-measure truths and graded results | `MEASUREMENTS.md` |
| Interface review passes, newest first | `docs/design-review-log.md` |
| Fixture manifests and checksums | `fixtures/*/manifest.json`, `SHA256SUMS` |

**On this machine only** — a fresh clone will not have these, and they must be regenerated by a
cloud run followed by `scripts/save-run.sh`:

| Evidence | Path | Size |
|---|---|---|
| Door clip reconstructions at three settings | `fixtures/door/` | 342 MB + 11 MB of frames |
| Room clip reconstructions at three settings | `fixtures/room/` | 346 MB |
| Saved cloud runs | `~/verge-runs/` | varies |

The door fixture is the primary one: same room as the room fixture, but it contains the door,
which at 2.10 m is the long reference the calibration needs. Scale does not transfer between
clips, so every reference used to judge a reconstruction must be visible *in that reconstruction*.

**Representative commits**, if you need to see how something arrived:

- `5324e6d` content-addressed graph engine · `b9474f5` geometry core · `356c48e` the ground
  selection rule · `9fd036e` measurement evidence workflow · `a77b109` repeat trials with frozen
  masks · `5a0c9af` browser-local segmentation · `9d9e1aa` the run registry · `00410fe` in-app
  cloud control · `dee7443` deploy button and mock banners · `4e64b93` the frame-numbering fix.

---

## 7. Known limitations and gates

These are stated, not scheduled. Anything being actively worked on is in `PROGRESS.md`.

- **Automatic object selection is proven on one attempt, not benchmarked.** One click produced a
  1.941 m door against a 2.020 m manual mean and a 2.100 m truth. A ten-attempt study with
  deliberate bad clicks has not been run, so failure and abstention rates are unknown. **This
  gates trust in automatic masks only.** It does not block outdoor ground or vegetation work,
  which do not depend on it.
- **Accuracy across scenes is unverified.** One room, one operator, one camera path. A second
  capture with different orientation and motion remains the largest untested risk.
- **The top of the memory range is not modelled.** 81 frames at 504 px is the verified
  conservative setting; the 22.02 GiB reading at 112 frames is still unexplained, though
  orientation has been ruled out as its cause. See the warning in section 3.
- **A signed link outlives neither the day nor the bucket.** Links expire after twelve hours and
  objects after three days, so an unsaved run is recoverable for three days and no longer. The
  manifest's `gs_uri` is what makes a late Save work at all; nothing re-signs on demand.
- **One object cannot be graded** on the primary clip: the laptop hides the monitor stand's
  contact point. Inventing that endpoint was rejected.
- **Two open scientific questions**, recorded rather than scheduled: whether measurements repeat
  across separated sittings, and what should be shown when no ground can be established at all.
- **The dependency audit is not clean and must not be described as such.** Two high-severity
  advisories arrive through the segmentation library's Node-only image dependency. The browser
  build neither runs nor ships it, but the repository audit is non-zero.
- **The depth image pane requires a measurement target before it shows anything**, including the
  plain picture and depth view. The operator flagged this on a fresh clip and deferred the fix on
  2026-08-05. It is a live design question, not a settled decision.

---

## 8. Lessons that cost time or money

Kept because each one was paid for once.

- **A box ticked for code that was written but never run has cost real money twice.** Saving a run
  failed on the first live attempt because every previous save had been a built-in fixture that
  never reached the script. Exercise the seam, or say it is unexercised.
- **A test whose fake cannot fail the way the real thing fails proves nothing.** One stand-in
  lacked a method the real object has, so every proxied reply became an error the test read as a
  pass on everything it did not assert.
- **Test the round trip, not the fields.** A conversion was trimmed to the two fields one script
  read — and that object turned out to be the run's permanent record, so every saved run became
  unloadable. The field-by-field test passed against the broken version; a round-trip test would
  not have.
- **Two frame-numbering conventions existed and the wrong one was applied to saved runs.** The
  visible half was missing images; the silent half was a mask painted on one frame and
  back-projected with another frame's camera. Numbering is now recorded on the run, not inferred.
- **The service's health endpoint is `/health`, not `/healthz`** — the cloud platform intercepts
  the latter and answers its own 404 before the request arrives. Probe a second path before
  concluding a container is dead.
- **A user identity token has the wrong audience for this service** and produces a 404, not the
  403 you would expect. Route calls through the dev server, which signs them properly, rather
  than making the service public.
- **Responses are capped at 32 MiB, not just requests.** A 108 MB file returns an error with zero
  bytes. Anything larger is fetched in 24 MiB ranged chunks, with each chunk's byte count checked.
- **Never extract frames one rung at a time.** Sampling across a clip means the whole video is
  decoded regardless of how many frames you want, so five rungs meant five full decodes. This
  machine has six cores, only two of them fast, and it locked up hard enough to need a restart.
- **Dropping ffmpeg from the image also drops OpenCV's shared libraries**, which the model needs
  even though we never decode video on the server. The build now checks its own imports.
- **Saving the pane layout while one pane is maximised corrupts it** — the maximised state sizes
  its neighbours to nothing, and those sizes are what gets stored.
- **A cost written into a comment stops being true and nobody notices.** Two scripts described the
  standing charge as "~12 GB, about a dollar a month". It was 28.5 GB across three image copies in
  two projects, roughly $2.85 a month, and had been wrong for days — nothing checks a comment
  against the account. Cleanup that is documented but not executable is a wish. The rule now has a
  script behind it (`teardown.sh` reaps) and the audit is in section 3 with the date it was taken.
- **A retention field nobody reads is worse than none.** The manifest has advertised
  `expires_after_days: 3` since the contract was written; no code has ever honoured it, and the
  donor bucket's lifecycle rules missed the one prefix its output was actually written to. Both
  looked like a policy from the outside. Check the prefix that receives data, not the presence of
  a rule. Since 2026-08-06 the rule exists and is verified by listing objects, not by reading it.
- **Work that happens after the GPU must never be able to fail the run.** Uploading, signing and
  manifest-writing all run once inference has returned and the money is spent. Anything there that
  raises converts a finished result into a 500. Degrade, record why, and surface it.
- **`ffprobe`'s width and height are the coded pair, not the displayed one.** A phone clip carries
  `rotation=-90` in side data; ffmpeg auto-rotates on extraction, so the model sees the transpose
  of what a naive probe reports. A run planned as a landscape test on 2026-08-06 turned out to be
  portrait, and would have been recorded under the wrong label had the manifest's own frame
  dimensions not been checked against the probe.
