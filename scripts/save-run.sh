#!/usr/bin/env bash
# Bring a run's artifacts home BEFORE the instance dies.
#
# THIS IS NOT OPTIONAL AND IT IS NOT REVERSIBLE. No GCS bucket exists
# (VERGE_OUTPUT_BUCKET was never set), so /infer serves artifacts from the container's
# LOCAL DISK via /artifact/{run_id}/{name}. Delete the Cloud Run service and every byte
# goes with it -- there is no copy anywhere else, and the only way back is another cold
# start plus another GPU run. Run this before scripts/teardown.sh, every time.
#
# Verifies each download against the sha256 in the manifest, because a silently
# truncated GLB looks exactly like a good one until M3 tries to fit a plane to it.
#
# Usage:
#   VERGE_URL=... [VERGE_TOKEN=...] ./scripts/save-run.sh <manifest.json> [label]
#
# <manifest.json> is the response body from POST /infer, saved locally.
# [label] names the subdirectory under fixtures/room/ (default: the run_id). Use it to
# keep runs from different settings side by side -- M3 compares them offline.
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="${1:?usage: save-run.sh <manifest.json> [label]}"
[[ -f "${MANIFEST}" ]] || { echo "no such manifest: ${MANIFEST}" >&2; exit 1; }

: "${VERGE_URL:?set VERGE_URL to the deployed service URL}"
VERGE_TOKEN="${VERGE_TOKEN:-}"
VERGE_URL="${VERGE_URL%/}"

RUN_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "${MANIFEST}")"
LABEL="${2:-${RUN_ID}}"
DEST="fixtures/room/${LABEL}"

fetch() {
  if [[ -n "${VERGE_TOKEN}" ]]; then
    curl -sS -f --retry 2 -H "Authorization: Bearer ${VERGE_TOKEN}" "$@"
  else
    curl -sS -f --retry 2 "$@"
  fi
}

# Cloud Run caps an HTTP/1 RESPONSE at 32 MiB, the same limit that applies to requests.
# Over it the service returns 500 with zero bytes -- measured 2026-08-01: a 16.1 MB GLB
# served fine, a 108.1 MB npz did not, both through the proxy and direct. Since a
# 112-frame run's npz is always ~108 MB, whole-file GET can never bring one home.
#
# The service does honour Range (verified: HTTP 206, exact byte counts), so anything
# large is pulled in sub-cap chunks and reassembled. 24 MiB leaves headroom under 32.
CHUNK_BYTES=$(( 24 * 1024 * 1024 ))

fetch_large() {
  local url="$1" out="$2" size="$3"
  local offset=0 end n=0
  : > "${out}"
  while (( offset < size )); do
    end=$(( offset + CHUNK_BYTES - 1 ))
    (( end >= size )) && end=$(( size - 1 ))
    if ! fetch -H "Range: bytes=${offset}-${end}" "${url}" >> "${out}"; then
      echo "   !! range ${offset}-${end} failed" >&2
      return 1
    fi
    n=$(( n + 1 ))
    printf "\r   chunk %d (%d/%d MiB)" "${n}" $(( (end + 1) / 1024 / 1024 )) $(( size / 1024 / 1024 ))
    offset=$(( end + 1 ))
  done
  printf "\r   %d chunks, %d MiB          \n" "${n}" $(( size / 1024 / 1024 ))
}

mkdir -p "${DEST}"
cp "${MANIFEST}" "${DEST}/manifest.json"

echo "== saving run ${RUN_ID} -> ${DEST} =="

# One line per artifact: name, sha256, url.
python3 - "${MANIFEST}" > "${DEST}/.artifacts.tsv" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
for a in manifest["artifacts"]:
    print(f"{a['name']}\t{a['sha256']}\t{a['url']}\t{a['kind']}\t{a['size_bytes']}", flush=True)
PY

FAILED=0
COUNT=0
while IFS=$'\t' read -r NAME SHA URL KIND SIZE; do
  [[ -z "${NAME}" ]] && continue
  COUNT=$((COUNT + 1))
  OUT="${DEST}/${NAME}"

  case "${URL}" in
    gs://*)
      # The GCS branch of _publish. Never exercised -- no bucket has ever been set --
      # but if one appears, this is the path that must work.
      echo "-- ${NAME} (${KIND}) from GCS"
      gcloud storage cp "${URL}" "${OUT}" --quiet
      ;;
    http://*|https://*)
      echo "-- ${NAME} (${KIND}) from absolute URL"
      fetch -o "${OUT}" "${URL}"
      ;;
    /*)
      if [[ -n "${SIZE}" ]] && (( SIZE > CHUNK_BYTES )); then
        echo "-- ${NAME} (${KIND}) $(( SIZE / 1024 / 1024 )) MiB — over Cloud Run's 32 MiB response cap, ranging"
        fetch_large "${VERGE_URL}${URL}" "${OUT}" "${SIZE}" || { FAILED=$((FAILED+1)); continue; }
      else
        echo "-- ${NAME} (${KIND}) from ${VERGE_URL}${URL}"
        fetch -o "${OUT}" "${VERGE_URL}${URL}"
      fi
      ;;
    *)
      echo "   !! unrecognised artifact url: ${URL}" >&2
      FAILED=$((FAILED + 1))
      continue
      ;;
  esac

  # Integrity, not just arrival. "fixture" is the mock's placeholder digest.
  if [[ "${SHA}" == "fixture" || -z "${SHA}" ]]; then
    echo "   (no digest in manifest, skipping verification)"
  else
    GOT="$(shasum -a 256 "${OUT}" | cut -d' ' -f1)"
    if [[ "${GOT}" != "${SHA}" ]]; then
      echo "   !! SHA256 MISMATCH for ${NAME}" >&2
      echo "      expected ${SHA}" >&2
      echo "      got      ${GOT}" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
  fi
  echo "   ok $(du -h "${OUT}" | cut -f1)"
done < "${DEST}/.artifacts.tsv"

rm -f "${DEST}/.artifacts.tsv"

# Checksums are committed even though the payloads are not, so a fresh clone can tell
# whether a locally regenerated fixture is the same one M3's numbers came from.
(cd "${DEST}" && shasum -a 256 ./* > SHA256SUMS 2>/dev/null || true)

echo
if [[ ${FAILED} -gt 0 ]]; then
  echo "!! ${FAILED} of ${COUNT} artifacts FAILED — do NOT tear down yet" >&2
  exit 1
fi

echo "saved ${COUNT} artifacts to ${DEST}"
du -sh "${DEST}"
echo
echo "Verify before teardown:"
echo "  node scripts/check-fixtures.mjs --dir ${DEST}"
