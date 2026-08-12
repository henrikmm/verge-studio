#!/usr/bin/env bash
# Read-only readiness check for a bring-your-own Google Cloud project.
# It never deploys, starts, or contacts a Cloud Run service.
set -u -o pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh

failures=0

missing() {
  echo "MISSING: $1" >&2
  failures=$((failures + 1))
}

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "OK: ${label}"
  else
    missing "${label}"
  fi
}

if ! command -v gcloud >/dev/null 2>&1; then
  missing "gcloud is not on PATH; install the Google Cloud CLI"
  exit 1
fi

if ! require_cloud_config; then
  exit 1
fi

echo "== read-only cloud preflight =="
echo "project: ${PROJECT_ID}"
echo "region: ${REGION}"
echo "bucket: ${VERGE_OUTPUT_BUCKET}"
echo "runtime service account: ${RUNTIME_SA}"

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)"
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  missing "no active gcloud account; run gcloud auth login"
else
  echo "OK: active account ${ACTIVE_ACCOUNT}"
fi

check "project exists and is readable" gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)'
billing_enabled="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' 2>/dev/null || true)"
if [[ "${billing_enabled}" == "True" || "${billing_enabled}" == "true" ]]; then
  echo "OK: billing is enabled"
else
  missing "billing is not enabled or cannot be read"
fi

required_apis=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  storage.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  serviceusage.googleapis.com
  cloudresourcemanager.googleapis.com
  cloudbilling.googleapis.com
  compute.googleapis.com
)
enabled_apis="$(gcloud services list --enabled --project="${PROJECT_ID}" --format='value(config.name)' 2>/dev/null || true)"
if [[ -z "${enabled_apis}" ]]; then
  missing "enabled APIs could not be read (need Service Usage Viewer or equivalent)"
else
  for api in "${required_apis[@]}"; do
    if grep -Fxq "${api}" <<<"${enabled_apis}"; then
      echo "OK: API ${api}"
    else
      missing "API ${api} is not enabled"
    fi
  done
fi

check "Cloud Run metadata is readable" gcloud run services list --project="${PROJECT_ID}" --region="${REGION}" --limit=1
check "Artifact Registry metadata is readable" gcloud artifacts repositories list --project="${PROJECT_ID}" --location="${REGION}" --limit=1
check "runtime service account is readable" gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}"
check "output bucket is readable" gcloud storage buckets describe "gs://${VERGE_OUTPUT_BUCKET}" --project="${PROJECT_ID}"

if l4_quota="$(gcloud compute regions describe "${REGION}" --project="${PROJECT_ID}" \
    --format='value(quotas[metric=NVIDIA_L4_GPUS].limit)' 2>/dev/null)"; then
  if [[ -z "${l4_quota}" ]]; then
    missing "NVIDIA L4 GPU quota is absent or unreadable in ${REGION}"
  elif awk -v limit="${l4_quota}" 'BEGIN { exit !(limit > 0) }'; then
    echo "OK: NVIDIA L4 GPU quota in ${REGION} is ${l4_quota}"
  else
    missing "NVIDIA L4 GPU quota in ${REGION} is ${l4_quota}"
  fi
else
  missing "NVIDIA L4 GPU quota cannot be read in ${REGION}"
fi

cat <<'EOF'

Required deployment permissions cannot be proven safely by a read-only command. The active
account needs permission to create/update the Artifact Registry repository, submit Cloud Build,
deploy/delete the Cloud Run service, create/update the named bucket, and create/manage the
dedicated runtime service account and its bucket-scoped IAM bindings. It also needs Service
Account User on that runtime identity so Cloud Run may run as it. The runtime service account needs
Storage Object Creator and Storage Object Viewer on that bucket plus Token Creator on itself.
EOF

if [[ ${failures} -gt 0 ]]; then
  echo "preflight: ${failures} requirement(s) missing or unreadable; no cloud action was taken." >&2
  exit 1
fi

echo "preflight: metadata checks passed; this did not deploy or spend money."
