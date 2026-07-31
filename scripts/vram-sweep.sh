#!/usr/bin/env bash
# Measure peak VRAM vs frame count against ONE warm instance.
#
# This is the batching discipline from CLAUDE.md made concrete. Cloud Run GPU bills
# for instance lifetime, so N runs back-to-back on a warm instance cost roughly one
# cold start; N separate sessions cost N cold starts. Warm up once, sweep, tear down.
#
# Output: docs/vram-measurements.json — the numbers that replace the guessed bracket
# in app/src/lib/contract.ts and the DEFAULT_MAX_FRAMES caps.
#
# Usage: VERGE_URL=... VERGE_TOKEN=... ./scripts/vram-sweep.sh <video> [counts...]
set -euo pipefail
cd "$(dirname "$0")/.."

VIDEO="${1:?usage: vram-sweep.sh <video> [frame counts...]}"
shift || true
COUNTS=("${@:-}")
[[ -z "${COUNTS[0]:-}" ]] && COUNTS=(4 8 16 24 32)

: "${VERGE_URL:?set VERGE_URL to the deployed service URL}"
: "${VERGE_TOKEN:?set VERGE_TOKEN=\$(gcloud auth print-identity-token)}"

PROCESS_RES="${PROCESS_RES:-504}"
WORK="$(mktemp -d)"
OUT="docs/vram-measurements.json"
trap 'rm -rf "${WORK}"' EXIT

api() {
  curl -sS -f -H "Authorization: Bearer ${VERGE_TOKEN}" "$@"
}

echo "== warmup (one cold start for the whole sweep) =="
WARM_START=$(date +%s)
api -X POST "${VERGE_URL}/warmup" | tee "${WORK}/warmup.json"
echo
echo "cold start: $(( $(date +%s) - WARM_START ))s"

echo "[" > "${WORK}/results.json"
FIRST=1

for COUNT in "${COUNTS[@]}"; do
  echo
  echo "== ${COUNT} frames @ ${PROCESS_RES}px =="

  # Local ffmpeg. Ask for exactly COUNT frames spread across the whole clip by
  # setting the cap to COUNT and the fps high enough to be capped down to it.
  FRAME_DIR="${WORK}/frames-${COUNT}"
  node scripts/extract-frames.mjs "${VIDEO}" "${FRAME_DIR}" --fps 60 --max-frames "${COUNT}"

  ARGS=()
  for f in "${FRAME_DIR}"/*.jpg; do ARGS+=(-F "frames=@${f}"); done
  ARGS+=(-F "params={\"fps\":60,\"process_res\":${PROCESS_RES},\"ref_view_strategy\":\"middle\",\"max_frames\":${COUNT}}")

  # A failure here is a datapoint too: an OOM tells us the ceiling was crossed.
  if RESPONSE=$(api -X POST "${VERGE_URL}/infer" "${ARGS[@]}" 2>"${WORK}/err-${COUNT}.txt"); then
    PEAK=$(echo "${RESPONSE}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["vram"]["peak_bytes"])')
    SECS=$(echo "${RESPONSE}" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["timing"]["gpu_seconds"],2))')
    GIB=$(python3 -c "print(round(${PEAK}/1024**3, 2))")
    echo "  peak ${GIB} GiB · ${SECS}s GPU"
    ENTRY="{\"frames\":${COUNT},\"process_res\":${PROCESS_RES},\"peak_bytes\":${PEAK},\"peak_gib\":${GIB},\"gpu_seconds\":${SECS},\"ok\":true}"
  else
    echo "  FAILED (likely OOM) — see ${WORK}/err-${COUNT}.txt"
    ENTRY="{\"frames\":${COUNT},\"process_res\":${PROCESS_RES},\"ok\":false}"
  fi

  [[ ${FIRST} -eq 0 ]] && echo "," >> "${WORK}/results.json"
  echo "${ENTRY}" >> "${WORK}/results.json"
  FIRST=0
done

echo "]" >> "${WORK}/results.json"
python3 -m json.tool "${WORK}/results.json" > "${OUT}"

echo
echo "== releasing model =="
api -X POST "${VERGE_URL}/shutdown" || true
echo
echo "wrote ${OUT}"
echo "Now run scripts/teardown.sh — the instance is still warm and still billing."
