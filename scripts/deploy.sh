#!/usr/bin/env bash
# Build the DA3 image with Cloud Build and deploy it as a Cloud Run Service.
#
# --no-gpu-zonal-redundancy is MANDATORY: this project has zero L4 quota with zonal
# redundancy (verified 2026-07-31). Without the flag the deploy fails outright.
#
# Concurrency is deliberately > 1. Only one inference runs at a time (the service
# holds a lock), but the extra slots keep /gpu answerable during a run, which is what
# feeds the app's live VRAM bar.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-verge-lab}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-verge-da3}"
REPOSITORY="${REPOSITORY:-verge}"
IMAGE_NAME="${IMAGE_NAME:-da3-service}"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"

echo "== project =="
gcloud config set project "${PROJECT_ID}" --quiet

# No --immutable-tags: it makes images undeletable, which the predecessor learned the
# expensive way.
if ! gcloud artifacts repositories describe "${REPOSITORY}" \
      --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "== creating artifact registry =="
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Verge Studio images" \
    --quiet --project="${PROJECT_ID}"
fi

echo "== build (~12 GB image, expect 20-40 min on first build) =="
gcloud builds submit server \
  --tag "${IMAGE_URI}" \
  --timeout=3600s \
  --quiet --project="${PROJECT_ID}"

# Push by digest, never by mutable tag.
DIGEST="$(gcloud artifacts docker images describe "${IMAGE_URI}:latest" \
  --format='value(image_summary.digest)' --project="${PROJECT_ID}")"
echo "image digest: ${DIGEST}"

echo "== deploy =="
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE_URI}@${DIGEST}" \
  --region="${REGION}" \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --no-gpu-zonal-redundancy \
  --cpu=8 \
  --memory=32Gi \
  --no-cpu-throttling \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=4 \
  --timeout=900 \
  --no-allow-unauthenticated \
  --quiet --project="${PROJECT_ID}"

URL="$(gcloud run services describe "${SERVICE}" --region="${REGION}" \
  --format='value(status.url)' --project="${PROJECT_ID}")"

cat <<EOF

deployed: ${URL}

Billing note: this service bills for the INSTANCE LIFETIME while warm, not for
inference seconds. Batch your experiments, then run scripts/teardown.sh.

  export VERGE_URL="${URL}"
  export VERGE_TOKEN="\$(gcloud auth print-identity-token)"
  ./scripts/smoke-infer.sh
EOF
