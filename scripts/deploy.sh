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
# --min-instances=0 is correct again as of 2026-08-06, and the reason is worth keeping.
#
# It was forced to 1 on 2026-08-05 after it cost a real GPU session: artifacts were written
# to the CONTAINER'S LOCAL DISK, so an /artifact URL was only valid on the instance that
# produced it. Cloud Run drained that instance 86 ms after its /infer response, and the
# browser's GLB fetch 120 ms later was answered by a different instance that had never seen
# the file. Pinning one machine alive was the only available workaround.
#
# It is no longer needed, because the artifacts no longer live on the machine. VERGE_OUTPUT_BUCKET
# sends them to GCS, where an object has no instance affinity at all -- so a replacement,
# a scale-down or a teardown costs nothing. Scaling to zero is what stops the meter between
# runs; teardown remains the thing that stops it for good.
#
# If you ever unset VERGE_OUTPUT_BUCKET, put --min-instances=1 back in the same edit. The
# two settings are one decision, and splitting them is how 2026-08-05 happened.
# The service reports which path a run actually took as diagnostics.publish_mode.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh

require_command gcloud
require_cloud_config
# Durable artifact storage. Create it with scripts/create-bucket.sh, which also sets the
# lifecycle rule that bounds retention -- the bucket is a precondition of this deploy, not
# a side effect of it, because _publish has no deletion path of its own.
echo "== project =="
echo "  ${PROJECT_ID} (passed to every gcloud command; global gcloud config is unchanged)"

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
SRC_TAG="$(source_tag)"
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

# Scaling to zero is only safe because artifacts leave the instance. If the bucket is
# missing, this deploy would recreate the exact 2026-08-05 failure -- results on a disk that
# Cloud Run may reclaim mid-session -- so refuse rather than deploy something that looks
# fine until it silently eats a paid run.
echo "== output bucket =="
if gcloud storage buckets describe "gs://${VERGE_OUTPUT_BUCKET}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  gs://${VERGE_OUTPUT_BUCKET}/${OUTPUT_PREFIX}/ ready"
else
  cat >&2 <<EOF

REFUSING TO DEPLOY: gs://${VERGE_OUTPUT_BUCKET} does not exist.

This deploy sets --min-instances=0, which is only safe when artifacts are written to a
bucket rather than to the instance's own disk. Without it, Cloud Run can replace the
instance mid-session and a finished, paid-for run becomes unreachable.

  ./scripts/create-bucket.sh

creates it and applies the lifecycle rule that bounds retention.
EOF
  exit 1
fi

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
  --service-account="${RUNTIME_SA}" \
  --set-env-vars="VERGE_OUTPUT_BUCKET=${VERGE_OUTPUT_BUCKET},VERGE_OUTPUT_PREFIX=${OUTPUT_PREFIX}" \
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
