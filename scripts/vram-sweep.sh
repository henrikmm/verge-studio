#!/usr/bin/env bash
# Measure peak VRAM vs frame count against ONE warm instance.
#
# Two batching disciplines, both learned the hard way:
#
# 1. CLOUD. Cloud Run GPU bills for instance lifetime, so N runs back-to-back on a warm
#    instance cost roughly one cold start; N separate sessions cost N. Warm up once,
#    sweep, tear down.
# 2. LOCAL. Frames for every rung come from ONE ffmpeg decode. Sampling by FPS spreads
#    frames across the clip, so ffmpeg decodes the entire 4K stream for ANY frame count
#    -- extracting per rung meant five full decodes and froze the Mac on 2026-08-01.
#    scripts/extract-frames.mjs --ladder decodes once and hardlinks strided subsets.
#
# Output: docs/vram-measurements.json, which keeps every sweep ever run rather than
# overwriting -- the 2026-07-31 numbers are allocator-contaminated and superseded, but
# throwing them away would erase the evidence of *why* they were wrong.
#
# Usage:
#   VERGE_URL=... ./scripts/vram-sweep.sh <video> [counts...]
#   VERGE_URL=... ./scripts/vram-sweep.sh --ladder-dir <root> [counts...]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${VERGE_URL:?set VERGE_URL to the deployed service URL (or the proxy)}"
VERGE_URL="${VERGE_URL%/}"
# Optional: going through `gcloud run services proxy` the proxy supplies auth itself,
# and a user-account identity token has the wrong audience for Cloud Run anyway.
VERGE_TOKEN="${VERGE_TOKEN:-}"

PROCESS_RES="${PROCESS_RES:-504}"
LABEL="${LABEL:-res${PROCESS_RES}}"
OUT="docs/vram-measurements.json"

if [[ "${1:-}" == "--ladder-dir" ]]; then
  LADDER_ROOT="${2:?--ladder-dir needs a path}"
  shift 2
else
  VIDEO="${1:?usage: vram-sweep.sh <video>|--ladder-dir <root> [counts...]}"
  shift || true
fi

COUNTS=("$@")
[[ ${#COUNTS[@]} -eq 0 ]] && COUNTS=(32 64 128 192 256)

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Manifests MUST outlive this script. save-run.sh needs them to fetch artifacts, and the
# artifacts live on the container's local disk -- once the service is deleted they are
# gone for good. Writing these into a mktemp dir that the trap wipes would mean finishing
# a warm session with nothing to save from it.
MANIFEST_DIR="${MANIFEST_DIR:-.runs}"
mkdir -p "${MANIFEST_DIR}"

# One decode for the whole ladder.
if [[ -z "${LADDER_ROOT:-}" ]]; then
  echo "== extracting the ladder locally (ONE decode, hardlinked subsets) =="
  LADDER_ROOT="${WORK}/ladder"
  mkdir -p "${LADDER_ROOT}"
  node scripts/extract-frames.mjs "${VIDEO}" "${LADDER_ROOT}" \
    --fps 60 --ladder "$(IFS=,; echo "${COUNTS[*]}")"
fi

# Clip duration drives the effective fps and `source_duration_s` recorded in every
# manifest. With --ladder-dir there is no video to probe, and the old 26.61 fallback
# (clip A's length) would silently stamp clip B's fixtures with the wrong clip length
# and fps. DURATION_S is therefore REQUIRED when probing is impossible.
if [[ -n "${DURATION_S:-}" ]]; then
  DURATION="${DURATION_S}"
elif [[ -n "${VIDEO:-}" ]]; then
  DURATION="$(python3 -c "
import json,subprocess
o=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',
                  '${VIDEO}'],capture_output=True,text=True).stdout
print(json.loads(o)['format']['duration'])
")"
else
  echo "error: --ladder-dir has no video to probe; set DURATION_S to the clip length in seconds" >&2
  exit 2
fi
echo "clip duration: ${DURATION}s"

api() {
  if [[ -n "${VERGE_TOKEN}" ]]; then
    curl -sS -H "Authorization: Bearer ${VERGE_TOKEN}" "$@"
  else
    curl -sS "$@"
  fi
}

echo
echo "== warmup (one cold start for the whole sweep) =="
WARM_START=$(date +%s)
api -X POST "${VERGE_URL}/warmup" | tee "${WORK}/warmup.json"
COLD_S=$(( $(date +%s) - WARM_START ))
echo
echo "cold start + model load: ${COLD_S}s"

echo "[" > "${WORK}/results.json"
FIRST=1

for COUNT in "${COUNTS[@]}"; do
  FRAME_DIR="${LADDER_ROOT}/f-${COUNT}"
  if [[ ! -d "${FRAME_DIR}" ]]; then
    echo "  (no ${FRAME_DIR}, skipping ${COUNT})"
    continue
  fi
  echo
  echo "== ${COUNT} frames @ ${PROCESS_RES}px =="

  EFF_FPS="$(python3 -c "print(round(${COUNT}/${DURATION}, 4))")"
  ARGS=()
  for f in "${FRAME_DIR}"/*.jpg; do ARGS+=(-F "frames=@${f}"); done
  ARGS+=(-F "params={\"fps\":${EFF_FPS},\"source_duration_s\":${DURATION},\"process_res\":${PROCESS_RES},\"ref_view_strategy\":\"middle\",\"max_frames\":${COUNT}}")

  # A failure here is a datapoint, not an error: an OOM is what the ladder is hunting.
  # No -f, so the response body survives a 500 and the real CUDA message is recorded.
  RESP="${MANIFEST_DIR}/manifest-${LABEL}-${COUNT}f.json"
  START=$(date +%s)
  CODE=$(api -o "${RESP}" -w '%{http_code}' \
    -X POST "${VERGE_URL}/infer" "${ARGS[@]}" || echo "000")
  WALL=$(( $(date +%s) - START ))
  [[ "${CODE}" == "200" ]] && echo "  manifest: ${RESP}"

  ENTRY=$(python3 - "${RESP}" "${CODE}" "${COUNT}" "${PROCESS_RES}" "${WALL}" "${EFF_FPS}" <<'PY'
import json, sys
path, code, count, res, wall, eff = sys.argv[1:7]
out = {"frames": int(count), "process_res": int(res), "effective_fps": float(eff),
       "wall_seconds": int(wall), "http_code": int(code)}
try:
    body = json.load(open(path))
except Exception:
    body = {}
if code == "200" and "vram" in body:
    v, t = body["vram"], body["timing"]
    gib = lambda b: round(b / 1024 ** 3, 2)
    out.update(ok=True, run_id=body.get("run_id"),
               peak_bytes=v["peak_bytes"], peak_gib=gib(v["peak_bytes"]),
               torch_peak_bytes=v.get("torch_peak_bytes", 0),
               torch_peak_gib=gib(v.get("torch_peak_bytes", 0)),
               baseline_bytes=v.get("baseline_bytes", 0),
               baseline_gib=gib(v.get("baseline_bytes", 0)),
               activation_gib=gib(max(0, v["peak_bytes"] - v.get("baseline_bytes", 0))),
               total_gib=gib(v["total_bytes"]),
               gpu_seconds=round(t["gpu_seconds"], 2))
    d = body.get("diagnostics") or {}
    if d.get("native_npz"):
        out["native_npz"] = d["native_npz"]
    print(f"  peak {out['peak_gib']} GiB driver / {out['torch_peak_gib']} GiB allocator "
          f"· activation {out['activation_gib']} GiB · {out['gpu_seconds']}s GPU",
          file=sys.stderr)
else:
    detail = str(body.get("detail", ""))[:400] or f"HTTP {code}"
    out.update(ok=False, detail=detail)
    print(f"  FAILED ({code}): {detail[:160]}", file=sys.stderr)
print(json.dumps(out))
PY
)
  [[ ${FIRST} -eq 0 ]] && echo "," >> "${WORK}/results.json"
  echo "${ENTRY}" >> "${WORK}/results.json"
  FIRST=0
done

echo "]" >> "${WORK}/results.json"

# Merge into the historical record rather than clobbering it.
python3 - "${OUT}" "${WORK}/results.json" "${LABEL}" "${COLD_S}" <<'PY'
import json, os, sys, datetime
out_path, results_path, label, cold = sys.argv[1:5]
runs = json.load(open(results_path))

history = {"schema": "verge.vram-measurements/0.2.0", "sweeps": []}
if os.path.exists(out_path):
    try:
        existing = json.load(open(out_path))
    except Exception:
        existing = None
    if isinstance(existing, dict) and "sweeps" in existing:
        history = existing
    elif isinstance(existing, list):
        # Migrate the original flat 2026-07-31 array, preserving why it is untrustworthy.
        history["sweeps"].append({
            "label": "m1-initial", "date": "2026-07-31", "contaminated": True,
            "method": "driver mem_get_info peak only; warm instance, ascending order; "
                      "PyTorch allocator cache NOT cleared between runs",
            "caveat": "Cumulative high-water marks, not per-run costs. 8f and 16f both "
                      "report 12.79 GiB and 24f/32f both 14.03 GiB because the readings "
                      "quantise to allocator growth steps. Safe upper bounds only.",
            "runs": existing,
        })

# Merge at RUN level, not sweep level. Replacing the whole sweep meant a second
# invocation with the same label silently erased the first one's rungs -- which is
# exactly what a bisect does, one rung at a time. Key on (frames, process_res) so
# re-running a rung updates just that rung and every other result survives.
existing_sweep = next((s for s in history["sweeps"] if s.get("label") == label), None)
if existing_sweep is None:
    existing_sweep = {
        "label": label,
        "date": datetime.date.today().isoformat(),
        "contaminated": False,
        "method": "empty_cache() + reset_peak_memory_stats() before each run; driver peak "
                  "and torch.cuda.max_memory_allocated() both recorded, with the pre-run "
                  "baseline",
        "cold_start_seconds": int(cold),
        "runs": [],
    }
    history["sweeps"].append(existing_sweep)

merged = {(r["frames"], r["process_res"]): r for r in existing_sweep["runs"]}
for r in runs:
    merged[(r["frames"], r["process_res"])] = r
existing_sweep["runs"] = [merged[k] for k in sorted(merged)]
json.dump(history, open(out_path, "w"), indent=2)
print(f"\nwrote {out_path} ({len(history['sweeps'])} sweeps on record)")
PY

echo
echo "Instance is STILL WARM and STILL BILLING."
echo "Save artifacts with scripts/save-run.sh BEFORE scripts/teardown.sh — they live on"
echo "the container's local disk and die with it."
