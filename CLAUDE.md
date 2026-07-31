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
| `max_frames` | measured cap | Hard ceiling protecting the L4's 24 GiB. Never remove it. |
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
- Always tear down what you start. Leaving a service or a 12 GB image alive bills silently.

## Git hygiene

- Commit at the end of each coherent unit. Subject: short imperative, ≤72 chars. **No long bodies.**
- Never commit: `node_modules/`, weights, media >5 MB (existing `fixtures/` are whitelisted), secrets.
- Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Environment notes

- `ffmpeg` 8.1.2 installed via Homebrew. Node 22+/npm via Homebrew; python3 at `/usr/local/bin/python3`.
- Dev server: `cd app && npm run dev` (Vite, port 5173). Use the browser-pane preview to verify visually.
- GCP: project **`verge-lab`**, region `us-central1`, keyless ADC; identity tokens via `gcloud auth print-identity-token`. No `--immutable-tags` on Artifact Registry; push by digest; `objectCreator` + conditional prefix IAM; `if_generation_match=0` on uploads.
- VRAM budget: L4 = 24 GiB. Only one real measurement exists (4 frames @ 392 px = 8.53 GiB peak);
  DA3's own estimator under-predicts it ~4×, so the frame cap must come from a measured sweep.
