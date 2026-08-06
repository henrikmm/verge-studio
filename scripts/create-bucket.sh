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

PROJECT_ID="${PROJECT_ID:-verge-lab}"
REGION="${REGION:-us-central1}"
BUCKET="${VERGE_OUTPUT_BUCKET:-verge-lab-runs}"
# Must agree with VERGE_OUTPUT_PREFIX in server/main.py and with scripts/bucket-lifecycle.json.
PREFIX="${VERGE_OUTPUT_PREFIX:-runs/transient}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
# deploy.sh passes no --service-account, so Cloud Run uses the default compute identity.
# If that ever changes, change it here too or the grants land on the wrong principal.
RUNTIME_SA="${RUNTIME_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

echo "== bucket =="
if gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  gs://${BUCKET} already exists"
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
gcloud storage buckets update "gs://${BUCKET}" \
  --cors-file=scripts/bucket-cors.json --project="${PROJECT_ID}" >/dev/null
echo "  applied scripts/bucket-cors.json (http://localhost:5173)"

echo "== iam =="
# Scoped to this bucket, not the project. objectAdmin rather than objectCreator because a V4
# signed URL carries the SIGNER's authority: the service must be able to read what it signs
# for, or every link it mints returns 403.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectAdmin \
  --project="${PROJECT_ID}" >/dev/null
echo "  ${RUNTIME_SA} -> roles/storage.objectAdmin on gs://${BUCKET}"

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
gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT_ID}" \
  --format=json > /tmp/verge-bucket-check.json
python3 - "${PREFIX}" <<'PY'
import json, sys

prefix = sys.argv[1].strip("/") + "/"
data = json.load(open("/tmp/verge-bucket-check.json"))
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
rm -f /tmp/verge-bucket-check.json

echo
echo "bucket ready: gs://${BUCKET}/${PREFIX}/"
echo "deploy with VERGE_OUTPUT_BUCKET=${BUCKET}"
