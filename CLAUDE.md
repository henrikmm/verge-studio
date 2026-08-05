# Verge Studio — agent conventions

Sentinel-style node-graph web app: local frontend, cloud DA3 GPU inference, 3D measurement.
The approved plan lives at `~/.claude/plans/hi-fable-im-considering-transient-kurzweil.md`.
Predecessor repo `~/dev/Motiva_Challenge` is a **read-only parts donor** — never modify it.

## Layout

- `app/` — Vite + React + TS. `src/graph/` (engine + React Flow UI, one node type per file in `src/graph/nodes/`), `src/panes/` (Dockview panes), `src/three/` (scene, loaders, controls).
- `server/` — FastAPI + Docker DA3 service (Cloud Run, L4, scale-to-zero).
- `geometry/` — only what DA3 lacks: ground plane, known-object scale check, height. With tests.
- `fixtures/` — real DA3 output (GLB/PLY/NPZ + manifest). Offline dev + tests run on this, not the cloud.
- `donor/` — verbatim copies from the predecessor repo, reference only, never imported by app code.
- `docs/PROGRESS.md` — **read this first.** What is done, what is not, open bugs, handoff notes.
- `docs/DESIGN.md` — UI spec + acceptance checklist. `docs/SOURCES.md` — canon references.

## Hard rules

- English-only artifacts. TypeScript strict. Kebab-case files, PascalCase components.
- **Local-first**: everything CPU runs on this Mac (ffmpeg extraction, geometry, tests, viewers). Cloud is the DA3 forward pass only. Never add a cloud round-trip for CPU-shaped work.
- **Video-first**: video is the standard input, not single images. DA3's quality comes from
  cross-view attention — a single image never engages it and produces badly flawed geometry.
  Sample frames by **FPS** (like DA3's own `_process_video`), never "N frames across the clip".
- **Storage**: inference outputs are transient (GCS lifecycle ≤3 days); persist/download only on explicit user Save. Never auto-persist.
- Model: `DA3NESTED-GIANT-LARGE-1.1` @ HF rev `b2359bdf`, upstream repo pinned @ `3d835ec1`. CC-BY-NC-4.0 — personal/research only; never add commercial claims.
- When in doubt about DA3, React Flow, Dockview, or Three.js behavior: consult `docs/SOURCES.md` before guessing. Prefer DA3-native geometry (`utils/geometry.py`, `utils/export/glb.py`) over writing new backprojection code.

## Feedback loops — every unit of work ends in one

| Change kind | Loop |
|---|---|
| any code | `scripts/verify.sh` (typecheck + unit tests + fixture smoke) |
| UI | `/design-review` skill: browser-pane screenshots vs `docs/DESIGN.md` checklist + `docs/reference/` |
| viewer/geometry | load `fixtures/`, assert stats (point count, bbox, depth range) in-browser or in tests |
| server deploy (M1+) | `scripts/smoke-infer.sh` — one short run; never loop GPU runs |

## Inference defaults (verified upstream — see `docs/SOURCES.md`)

| Param | Default | Range / notes |
|---|---|---|
| `fps` (frame sampling) | `10` | 1–50 in the UI. Matches the HF Space's own slider default. |
| `max_frames` | `112` | Measured 2026-08-01: 144 ran (21.88 GiB), 160 OOMed. 112 keeps ~15% headroom **on a portrait clip**. Never remove it. |
| `process_res` | `504` | API/CLI/Space default alike. |
| `process_res_method` | `upper_bound_resize` | The Space's `low_res` option. |
| `ref_view_strategy` | `middle` | DA3 docs recommend this for temporally-ordered video. |
| `infer_gs` | `false` | Gaussian splats cost extra GPU time; opt in. |

`fps × duration` can exceed `max_frames` — when it does, reduce the effective FPS and **tell the
user the effective value**, never silently truncate the clip.

## Cloud discipline

Cloud Run GPU requires CPU-always-allocated, which means **instance-based billing**: you pay for
the instance's whole lifetime, including cold start (~3 min) and the idle tail before scale-down —
not just the seconds of actual inference.

- **Batch GPU work.** Stack every experiment you need and run them back-to-back against one warm
  instance. Four runs in one warm session cost roughly one cold start; four separate sessions cost
  four. Plan the whole sweep before deploying.
- Always deploy with `--no-gpu-zonal-redundancy` (there is no zonal-redundant L4 quota on this project).
- **Always delete the service** at the end of a session — the instance is the real meter. Since
  2026-08-05 `deploy.sh` sets `--min-instances=1`, because artifacts live on the container's
  local disk and a recycled instance 404s them (see PROGRESS P4, bug 1). That means the instance
  **never scales to zero**: teardown is now a correctness requirement, not just hygiene.
- **Save runs BEFORE teardown.** `/artifact` URLs are only valid on the instance that produced
  them; deleting the service destroys any run not yet saved.
- **Check before you spend.** The app has a local control plane at `/api/cloud/*` (dev middleware
  only): Inspector → **Cloud control** reports gcloud auth, whether the service exists, and
  whether Artifact Registry already holds an image for the current `server/` hash — i.e. whether
  the next deploy is ~1-3 min or ~15-20 min. All metadata reads; they never touch the service and
  cannot wake an instance. `Connect (signed locally)` routes GPU calls through the dev server,
  which signs them from ADC, so no token ever reaches the browser. **Deploying is still a
  terminal action** (`scripts/deploy.sh`) — the route exists but no button reaches it yet.
- **Keep the image.** Artifact Registry storage is ~$0.10/GB/month (~$1/month for our 12 GB);
  rebuilding costs 15–20 min of wall clock every session. `deploy.sh` tags the image with a hash
  of `server/` and skips the build when that exact source is already in the registry, so a stale
  image can never be deployed silently. `teardown.sh` keeps it by default; `PURGE_IMAGE=1` deletes
  it when the project is finished for good. (Reversed 2026-07-31 — the old rule optimised the
  cheap axis.)

## Handoff — non-negotiable

Your task list dies with your session; `docs/PROGRESS.md` is the only thing that survives.

- **Read `docs/PROGRESS.md` before starting work**, and update it before you finish.
- Tick `[x]` only for what you *verified*, not what you wrote. Anything built but unexercised
  goes in a "NOT done" list with the reason — an untested seam marked done is worse than absent.
- Every bug or limitation you find and don't fix becomes an unchecked follow-up item there,
  with enough context to act on without this conversation.

## Git hygiene

- Commit at the end of each coherent unit. Subject: short imperative, ≤72 chars. **No long bodies.**
- Never commit: `node_modules/`, weights, media >5 MB (existing `fixtures/` are whitelisted), secrets.


## Environment notes

- `ffmpeg` 8.1.2 installed via Homebrew. Node 22+/npm via Homebrew; python3 at `/usr/local/bin/python3`.
- Dev server: `cd app && npm run dev` (Vite, port 5173). Use the browser-pane preview to verify visually.
- GCP: project **`verge-lab`**, region `us-central1`, keyless ADC; identity tokens via `gcloud auth print-identity-token`. No `--immutable-tags` on Artifact Registry; push by digest; `objectCreator` + conditional prefix IAM; `if_generation_match=0` on uploads.
- ⚠️ **Aspect ratio is a VRAM variable and the measured table does not model it.** The ladder in
  `docs/vram-measurements.json` was built on the portrait door clip. A landscape 1920×1080 clip
  measured **22.02 GiB at 112f/504px on 2026-08-05 — 0.74 GiB above the table's 21.28, and
  99.96% of the device.** It did not OOM; there was simply nothing left. For landscape input,
  lower frames or resolution rather than trusting the table.
- VRAM budget: L4 reports **22.03 GiB usable** (23,659,151,360 B) — not 24 GiB; the advertised
  figure is decimal and some is reserved. Model resident 6.57 GiB; cold start 64 s, model load 40 s.
  Measured ladder (2026-08-01, per-run isolated with `empty_cache()`) in
  `docs/vram-measurements.json` — @ 504 px: 32f=14.24 · 64f=16.94 · 112f=21.28 · 128f=21.94 ·
  144f=21.88 GiB driver peak; **160f, 192f and 256f OOM**. The allocator peak is the clean
  signal and fits **0.0700 GiB/frame + 9.39 GiB** — half the slope the older contaminated
  readings implied. Resolution buys frames as res²: 256f runs at 356 px (17.51 GiB allocator)
  and comfortably at 252 px (12.69 GiB), so **10 fps sampling is reachable below 504 px**.
- ⚠️ **Cloud Run caps HTTP/1 RESPONSES at 32 MiB too, not just requests.** A 108 MB npz returns
  500 with zero bytes; a 16 MB GLB is fine. `save-run.sh` pulls anything larger in 24 MiB
  Range chunks (the service does honour Range — verified 206 with exact byte counts).
