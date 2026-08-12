#!/usr/bin/env bash
# Create and configure the durable output bucket. Idempotent, free, and touches no service.
#
# WHY THIS EXISTS AS A SCRIPT: a retention policy that lives only in somebody's shell history
# is a wish. The manifest has advertised expires_after_days: 3 since the contract was written
# and nothing enforced it; the donor bucket carried five lifecycle rules and none of them
# matched the prefix its output actually went to. Both looked like a policy from the outside.
# This script is the executable version, and it VERIFIES the prefix it just set rather than
# trusting that the write succeeded.
#
# Run it before the first deploy that sets VERGE_OUTPUT_BUCKET. Re-running is safe.
#
# Nothing here starts, wakes or bills a GPU. Bucket storage is the only charge and a run's
# 121 MB for three days is well under a cent.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh

require_command gcloud
require_command python3
require_cloud_config
BUCKET="${VERGE_OUTPUT_BUCKET}"
PREFIX="${OUTPUT_PREFIX}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

echo "== runtime service account =="
if gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  ${RUNTIME_SA} already exists"
else
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="Verge Studio runtime"
  echo "  created ${RUNTIME_SA}"
fi

echo "== bucket =="
if BUCKET_PROJECT_NUMBER="$(gcloud storage buckets describe "gs://${BUCKET}" \
    --project="${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null)"; then
  if [[ "${BUCKET_PROJECT_NUMBER}" != "${PROJECT_NUMBER}" ]]; then
    echo "REFUSING: gs://${BUCKET} belongs to project number ${BUCKET_PROJECT_NUMBER}, not ${PROJECT_NUMBER}." >&2
    echo "Choose a globally unique VERGE_OUTPUT_BUCKET that belongs to PROJECT_ID." >&2
    exit 1
  fi
  echo "  gs://${BUCKET} already exists in ${PROJECT_ID}"
else
  # Same region as the service: the upload from Cloud Run is then free and fast, and a
  # cross-region bucket would add egress to every one of a run's 121 MB.
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --default-storage-class=STANDARD
fi

echo "== lifecycle =="
gcloud storage buckets update "gs://${BUCKET}" \
  --lifecycle-file=scripts/bucket-lifecycle.json --project="${PROJECT_ID}" >/dev/null
echo "  applied scripts/bucket-lifecycle.json"

echo "== cors =="
# Without this the browser cannot fetch a signed link at all -- which is the entire point of
# the signed link. Fails as an opaque network error, so it is worth setting deliberately.
LOCAL_PORT="${PORT:-5173}"
CORS_ORIGINS="${VERGE_CORS_ORIGINS:-http://localhost:${LOCAL_PORT},http://127.0.0.1:${LOCAL_PORT}}"
CORS_FILE="$(mktemp "${TMPDIR:-/tmp}/verge-bucket-cors.XXXXXX")"
trap 'rm -f "${CORS_FILE}" "${BUCKET_CHECK_FILE:-}"' EXIT
python3 - "${CORS_FILE}" "${CORS_ORIGINS}" <<'PY'
import json, sys

origins = [origin.strip() for origin in sys.argv[2].split(",") if origin.strip()]
if not origins or any(not origin.startswith(("http://", "https://")) for origin in origins):
    raise SystemExit("VERGE_CORS_ORIGINS must be a comma-separated list of http(s) origins")
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump([{
        "origin": origins,
        "method": ["GET", "HEAD"],
        "responseHeader": ["Content-Type", "Content-Range", "Accept-Ranges", "Content-Length"],
        "maxAgeSeconds": 3600,
    }], output)
PY
gcloud storage buckets update "gs://${BUCKET}" \
  --cors-file="${CORS_FILE}" --project="${PROJECT_ID}" >/dev/null
echo "  applied CORS for ${CORS_ORIGINS}"

echo "== iam =="
# Scoped to this bucket, not the project. Signed GET links carry the signer's authority,
# so the runtime needs both a writer and a reader role. It never needs bucket administration.
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectAdmin \
  --project="${PROJECT_ID}" >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectCreator \
  --project="${PROJECT_ID}" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectViewer \
  --project="${PROJECT_ID}" >/dev/null
echo "  ${RUNTIME_SA} -> objectCreator + objectViewer on gs://${BUCKET}"

# The one grant that is not obvious. Inside Cloud Run there is no private key to sign with,
# so generate_signed_url has to go through the IAM signBlob API -- and the runtime account
# needs Token Creator ON ITSELF to call it. Without this, signing fails at RUN TIME, after
# the GPU has already been paid for. It is granted here, before any spend, and proved by
# /publish-check before any GPU run.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/iam.serviceAccountTokenCreator \
  --project="${PROJECT_ID}" >/dev/null
echo "  ${RUNTIME_SA} -> roles/iam.serviceAccountTokenCreator on itself"

echo
echo "== verifying the prefix that actually receives data =="
# Read the rule BACK and assert it. Setting a rule and reporting success from the exit code
# is exactly the mistake the donor bucket embodies.
BUCKET_CHECK_FILE="$(mktemp "${TMPDIR:-/tmp}/verge-bucket-check.XXXXXX")"
gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT_ID}" \
  --format=json > "${BUCKET_CHECK_FILE}"
python3 - "${PREFIX}" "${BUCKET_CHECK_FILE}" <<'PY'
import json, sys

prefix = sys.argv[1].strip("/") + "/"
data = json.load(open(sys.argv[2]))
rules = (data.get("lifecycle_config") or data.get("lifecycleConfig") or {}).get("rule", [])

matching = [
    r for r in rules
    if r.get("action", {}).get("type") == "Delete"
    and prefix in (r.get("condition", {}).get("matchesPrefix") or [])
]
if not matching:
    print(f"  FAIL: no Delete rule matches {prefix!r}")
    print(f"  rules present: {json.dumps(rules)}")
    sys.exit(1)

age = matching[0]["condition"].get("age")
if age is None or age > 3:
    print(f"  FAIL: rule matches {prefix!r} but age={age}, which is not 3 days or fewer")
    sys.exit(1)

print(f"  OK: Delete at age={age} days matches prefix {prefix!r}")
print(f"  uniform access: {data.get('uniform_bucket_level_access') or data.get('iamConfiguration')}")
PY

echo
echo "bucket ready: gs://${BUCKET}/${PREFIX}/"
echo "deploy with VERGE_OUTPUT_BUCKET=${BUCKET}"
