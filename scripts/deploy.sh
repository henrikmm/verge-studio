#!/usr/bin/env bash
# Build the DA3 image with Cloud Build and deploy it as a Cloud Run Service.
#
# --no-gpu-zonal-redundancy is MANDATORY: this project has zero L4 quota with zonal
# redundancy (verified 2026-07-31). Without the flag the deploy fails outright.
#
# Concurrency is deliberately > 1. Only one inference runs at a time (the service
# holds a lock), but the extra slots keep /gpu answerable during a run, which is what
# feeds the app's live VRAM bar.
#
# --min-instances=1 is NOT an optimisation, it is a correctness requirement, and it was
# added on 2026-08-05 after it cost a real GPU session. Artifacts are written to the
# CONTAINER'S LOCAL DISK (server/main.py: RUN_ROOT = tempfile.gettempdir()), so an
# /artifact URL is only valid on the instance that produced it. With min-instances=0,
# Cloud Run had already scheduled a replacement while inference was still running: the
# instance was drained 86 ms after its /infer response, and the browser's GLB fetch
# 120 ms later was answered by a different instance that had never seen the file.
#
# The cost of this flag is real and must be respected: the instance NEVER scales to zero
# while the service exists, so it bills continuously from deploy to teardown. That is
# already the operating assumption of a warm batched session -- but it makes
# scripts/teardown.sh non-optional rather than merely good hygiene.
#
# The durable fix is the GCS + signed-URL path that _publish() already half-implements;
# until VERGE_OUTPUT_BUCKET exists, this flag is what keeps artifacts reachable.
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

# Content-addressed image tag. The ~12 GB build takes 15-20 min and is the single
# largest cost of a cloud session -- in wall-clock time, not dollars (Cloud Build's
# free tier usually covers it). Keeping the image in Artifact Registry instead costs
# ~$0.10/GB/month, so ~$1/month PER IMAGE. So we rebuild ONLY when server/ actually
# changes, and reuse the stored image every other time, turning a 15-20 min session
# start into ~1 min.
#
# The per-source tag means a changed server/ leaves the OLD image behind as well. Nothing
# here deletes it -- reaping belongs at teardown, once the new image has served a real run
# and earned promotion. See "One image in the repository, ever" in AGENTS.md. If you are
# reading this because the registry looks bigger than it should: that is the reason, and
# scripts/teardown.sh is the fix.
#
# Hashing the source rather than trusting a mutable tag means a stale image can never
# be silently deployed: different source, different tag, no match, rebuild.
SRC_TAG="src-$(find server -type f -not -path '*/__pycache__/*' \
  | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)"
echo "== source tag: ${SRC_TAG} =="

if [[ "${FORCE_BUILD:-0}" == "1" ]]; then
  echo "== FORCE_BUILD=1, rebuilding =="
  NEED_BUILD=1
elif gcloud artifacts docker images describe "${IMAGE_URI}:${SRC_TAG}" \
       --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "== image for this exact server/ source already in the registry, skipping build =="
  NEED_BUILD=0
else
  echo "== no image for this source, building (~12 GB, expect 15-20 min) =="
  NEED_BUILD=1
fi

if [[ "${NEED_BUILD}" == "1" ]]; then
  gcloud builds submit server \
    --tag "${IMAGE_URI}:${SRC_TAG}" \
    --timeout=3600s \
    --quiet --project="${PROJECT_ID}"
fi

# Deploy by digest, never by mutable tag.
DIGEST="$(gcloud artifacts docker images describe "${IMAGE_URI}:${SRC_TAG}" \
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
  --min-instances=1 \
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

teardown.sh deletes the service but KEEPS the image, so the next deploy skips the
build and starts in ~1 min. Run it with PURGE_IMAGE=1 when the project is finished
to stop the ~\$1/month Artifact Registry storage charge.

  export VERGE_URL="${URL}"
  export VERGE_TOKEN="\$(gcloud auth print-identity-token)"
  ./scripts/smoke-infer.sh
EOF
