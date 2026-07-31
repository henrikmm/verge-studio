#!/usr/bin/env bash
# Delete everything the deploy created. Run this at the end of every cloud session.
#
# The Cloud Run service bills only while an instance is alive, but the ~12 GB image in
# Artifact Registry bills for storage continuously whether or not you use it. That
# standing charge is the main reason this script exists.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-verge-lab}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-verge-da3}"
REPOSITORY="${REPOSITORY:-verge}"
KEEP_IMAGE="${KEEP_IMAGE:-0}"

echo "== deleting service =="
if gcloud run services describe "${SERVICE}" --region="${REGION}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud run services delete "${SERVICE}" --region="${REGION}" \
    --quiet --project="${PROJECT_ID}"
else
  echo "  (no service ${SERVICE})"
fi

if [[ "${KEEP_IMAGE}" == "1" ]]; then
  echo "== keeping image (KEEP_IMAGE=1) — it continues to bill for storage =="
else
  echo "== deleting image repository =="
  if gcloud artifacts repositories describe "${REPOSITORY}" \
       --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud artifacts repositories delete "${REPOSITORY}" \
      --location="${REGION}" --quiet --project="${PROJECT_ID}"
  else
    echo "  (no repository ${REPOSITORY})"
  fi
fi

echo
echo "remaining Cloud Run services:"
gcloud run services list --region="${REGION}" --project="${PROJECT_ID}" 2>&1 | tail -3
echo "remaining artifact repositories:"
gcloud artifacts repositories list --location="${REGION}" --project="${PROJECT_ID}" 2>&1 | tail -3
