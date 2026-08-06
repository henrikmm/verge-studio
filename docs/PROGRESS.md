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

### 1. Make cloud results outlive the machine that produced them

**Outcome.** Results are written to private cloud storage instead of the service's own disk, and
reached through short-lived signed links. Deleting the service stops costing money without
destroying anything, so the machine no longer has to be kept permanently alive. Saving still
produces the durable local copy in `~/verge-runs`; nothing is kept unless the user saves it.

**Owner.** Agent.

**Gate.** Cloud spend + user confirmation. One deploy and one short run are needed to prove it.

**Evidence / starting points.** `server/main.py` already has a half-written storage branch
(`_publish`) that was never given a bucket to write to. The 32 MiB response cap and the chunked
download that works around it are described in REGISTRY section 8. Google's own guidance covers
[signed links](https://docs.cloud.google.com/storage/docs/access-control/signed-urls),
[uniform bucket access](https://docs.cloud.google.com/storage/docs/using-uniform-bucket-level-access)
and [lifecycle rules](https://docs.cloud.google.com/storage/docs/lifecycle). Editing `server/`
forces a ~20 minute rebuild, so batch every server change into this one deploy.

**`server/` changes are already staged for this deploy.** On 2026-08-06 the frame-discard and
run-sweep described in REGISTRY decision 13 were written and unit-tested but never built or run.
They ride along with this task's rebuild — do not deploy separately for them, and do exercise them
here, because no deployed instance has executed that code yet.

**The lifecycle rule is a precondition, not a step.** Set it when the bucket is created, before a
single run writes to it — `_publish` has no deletion path, and `expires_after_days` in the manifest
is a statement of intent that no code enforces. The rule must match **`runs/transient/`**, the
prefix `_publish` actually writes to. The donor bucket is the cautionary case: it carries five
carefully written lifecycle rules, none of which matches the `runs/` prefix its output went to, so
those objects never expire. Verify by prefix, not by the presence of rules.

**Done when.** In a single guided session: the browser loads a result through a signed link, Save
brings it home, a reload still finds it, the lifecycle rule is confirmed to match `runs/transient/`
at three days or fewer, a deployed run is observed discarding its frames and sweeping an expired
run, the minimum-machine setting is returned to zero, and a check confirms no service is left
running and exactly one image remains.

---

## Next

### 2. Take the system outdoors, guided, and find out what breaks

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

### 3. Let the app say "I cannot find the ground"

**Outcome.** When the evidence for a ground plane is weak or ambiguous, the app says so instead of
picking a winner. The margin between competing candidates is exposed — a narrow margin means the
fit is a coin flip, and nothing currently reports it.

**Owner.** Agent.

**Gate.** User confirmation, for the final wording and behaviour of the warning.

**Evidence / starting points.** `geometry/plane.ts` already scores competing hypotheses; the
margin between them is computed and discarded. A seeded fit (`fitPlaneFromSeeds`) exists and has
never been reachable from the interface — add that route only if task 2 shows the automatic
evidence genuinely is not enough. Abstention must propagate: a measurement resting on an
untrustworthy ground should refuse, not guess.

**Done when.** Outdoor evidence from task 2 has been used to set the thresholds, "ground cannot be
established" is a first-class result that downstream steps respect, and the user has agreed the
warning reads correctly.

---

## Later

### 4. Decide what measuring grass actually means, then build it

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

### 5. Find out how frame shape affects memory, or lower the limit for landscape

**Outcome.** The memory model accounts for the shape of the frame, or the frame limit drops for
landscape clips to a level that is safe by measurement rather than by hope.

**Owner.** Agent.

**Gate.** Cloud spend + user confirmation.

**Evidence / starting points.** REGISTRY section 3 has the measured ladder and the landscape
result that broke it: 22.02 GiB against a predicted 21.28, at 99.96% of the device. The ladder
was built entirely on a portrait clip. Until this is resolved, landscape input is limited to 81
frames at 504 px.

**Done when.** A short ladder has been measured on a landscape clip in one warm session, the
stored measurements include the frame shape, and the app's estimate matches what was observed.
