# Verge Studio

Measure real-world heights from ordinary video.

Drop in a clip, a GPU in the cloud reconstructs the scene in three dimensions, and you measure
things in it against a fitted ground plane — with an honest uncertainty attached, and graded
against a tape measure when one is available. The interface is a node graph: boxes wired
together, each doing one step, so nothing happens inside a black box.

**Video is the input, not photographs.** The depth model's accuracy comes from comparing many
frames of the same scene against each other. A single image never engages that and produces badly
wrong geometry. Frames are sampled by rate across the whole clip and extracted locally — the
cloud only ever sees the frames, never the video.

## Running it

```bash
cd app && npm install && npm run dev
```

That serves the app at http://localhost:5173. It works completely offline: the dev server answers
the inference request from a stored reconstruction and runs the real local ffmpeg, so the whole
interface can be used at zero cost. Anything produced that way is labelled as a mock on screen.

To check your work:

```bash
./scripts/verify.sh
```

That runs the type check, the unit tests, a fixture smoke test and the documentation check. One
part of it — the server contract test — needs Python with FastAPI, and **silently skips without
it**, so run it properly at least once per session:

```bash
python3 -m venv /tmp/verge-venv && /tmp/verge-venv/bin/pip install fastapi pydantic python-multipart httpx numpy && VERGE_PY=/tmp/verge-venv/bin/python ./scripts/verify.sh
```

## Using the GPU

The cloud service is not running by default, and starting it costs money.

```bash
./scripts/create-bucket.sh # once: output bucket, retention rule, permissions (free)
./scripts/deploy.sh        # start the service (builds only if server/ changed)
./scripts/smoke-infer.sh   # one short real run
./scripts/teardown.sh      # ALWAYS run when done
```

`create-bucket.sh` is a precondition of `deploy.sh`, which refuses to start without the bucket.
It is idempotent, costs nothing, and re-reads the retention rule it sets rather than assuming it
took.

Deploying, connecting and deleting the service can also be done from the app: open the Inspector
and find **Cloud control**. It reports whether you are signed in, whether the service exists, and
whether the next deploy takes about two minutes or about twenty. Those checks are free and cannot
wake anything.

**You pay for the machine's whole lifetime, not the seconds of computation** — including roughly
three minutes of startup and the idle time afterwards. So delete the service when you finish; it
scales to zero between runs but only teardown ends the charge for good.

Deleting it no longer destroys anything. Results are written to a private bucket rather than to the
machine, and the app reads them through links that expire after twelve hours. **Save any run you
want to keep** — the bucket deletes its contents after three days, and Save is what puts a copy in
`~/verge-runs`. One case still has the old urgency, and the Runs pane marks it ▲: if publishing to
the bucket failed, that run exists only on the instance and must be saved before teardown.

`teardown.sh` keeps the built image, which costs about a dollar a month and saves twenty minutes
of rebuilding every session. `PURGE_IMAGE=1 ./scripts/teardown.sh` removes it too, when the
project is finished for good.

## Where things are

| Directory | What it holds |
|---|---|
| `app/` | The local web app — React, TypeScript, Vite; docked panes, a node graph, a 3D viewport |
| `server/` | The FastAPI service wrapping the depth model, and its Docker image |
| `geometry/` | Measurement code the model does not provide: ground plane, scale check, height |
| `fixtures/` | Real reconstructions used for offline development and tests |
| `scripts/` | Deploy, teardown, frame extraction, run download, verification |
| `donor/` | Read-only reference copies from an earlier project; never imported |

## Where to read next

| Question | Document |
|---|---|
| How do I work in this repository? | [AGENTS.md](AGENTS.md) |
| What already works, and why was it built that way? | [docs/REGISTRY.md](docs/REGISTRY.md) |
| What should be done next? | [docs/TASK.md](docs/TASK.md) |
| How accurate is it, measured against what? | [MEASUREMENTS.md](MEASUREMENTS.md) |
| What must the interface look like and do? | [docs/DESIGN.md](docs/DESIGN.md) |
| Where do the external facts come from? | [docs/SOURCES.md](docs/SOURCES.md) |

Personal and research project. It uses DA3NESTED-GIANT-LARGE-1.1, whose licence is
non-commercial — no commercial use.
