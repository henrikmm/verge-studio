#!/usr/bin/env bash
# Bring a run's artifacts home -- the durable local copy in ~/verge-runs.
#
# The urgency here changed when durable artifact publishing was added. Artifacts now go to the
# configured output bucket, so
# tearing the service down no longer destroys them: they survive until the bucket's
# lifecycle rule deletes them three days later. Saving is still the only way to KEEP a run
# ("nothing is kept unless the user saves it"), it is simply no longer a race against
# teardown.
#
# One case keeps the old urgency in full, and the manifest names it: when
# diagnostics.publish_mode is "degraded", publishing failed and the artifacts exist only on
# the instance. Then this script must run before scripts/teardown.sh or the run is gone.
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
# One fixture directory per source clip: scale does not transfer between clips, so runs
# from different videos must never be compared as though they shared a calibration.
FIXTURE_ROOT="${FIXTURE_ROOT:-fixtures/room}"
DEST="${FIXTURE_ROOT}/${LABEL}"

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
#
# gs_uri WINS over url when both are present, and that ordering is the whole point of
# having two fields. `url` is a signed link with a ~12 hour life; `gs_uri` is the object's
# permanent address, resolved below with the operator's own credentials. A run saved the
# morning after it was computed, or after the service was torn down, comes home through
# gs_uri and would fail through url.
python3 - "${MANIFEST}" > "${DEST}/.artifacts.tsv" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
for a in manifest["artifacts"]:
    address = a.get("gs_uri") or a["url"]
    print(f"{a['name']}\t{a['sha256']}\t{address}\t{a['kind']}\t{a['size_bytes']}", flush=True)
PY

FAILED=0
COUNT=0
while IFS=$'\t' read -r NAME SHA URL KIND SIZE; do
  [[ -z "${NAME}" ]] && continue
  COUNT=$((COUNT + 1))
  OUT="${DEST}/${NAME}"

  case "${URL}" in
    gs://*)
      # The durable path, and now the normal one. No signature, no 32 MiB cap, no
      # dependency on the service still existing -- gcloud authenticates as the operator.
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
