#!/usr/bin/env bash
# Stop the billing that actually accrues. Run this at the end of every cloud session.
#
# The Cloud Run service bills for INSTANCE LIFETIME while an instance is alive, so
# deleting it is what stops the meter -- that is the default and always happens.
#
# The ~12 GB image in Artifact Registry is deliberately KEPT. Its storage charge is
# ~$0.10/GB/month (~$1/month), whereas rebuilding it costs 15-20 minutes of wall clock
# at the start of every session. Keeping it is the cheaper trade by a wide margin for
# an active project. Pass PURGE_IMAGE=1 when the project is finished for good.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-verge-lab}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-verge-da3}"
REPOSITORY="${REPOSITORY:-verge}"
PURGE_IMAGE="${PURGE_IMAGE:-0}"

echo "== deleting service =="
if gcloud run services describe "${SERVICE}" --region="${REGION}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud run services delete "${SERVICE}" --region="${REGION}" \
    --quiet --project="${PROJECT_ID}"
else
  echo "  (no service ${SERVICE})"
fi

if [[ "${PURGE_IMAGE}" == "1" ]]; then
  echo "== deleting image repository (PURGE_IMAGE=1) — next deploy rebuilds, 15-20 min =="
  if gcloud artifacts repositories describe "${REPOSITORY}" \
       --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud artifacts repositories delete "${REPOSITORY}" \
      --location="${REGION}" --quiet --project="${PROJECT_ID}"
  else
    echo "  (no repository ${REPOSITORY})"
  fi
else
  echo "== keeping image so the next deploy skips the build (PURGE_IMAGE=1 to delete) =="
  echo "   standing cost ~\$0.10/GB/month; the service, which is the real meter, is gone."
fi

# Cloud Build stages a source tarball per build and never cleans up after itself.
# Tiny (~50 KB each) but it accumulates, and "tear down what you start" means all of it.
echo "== clearing Cloud Build source staging =="
gcloud storage rm -r "gs://${PROJECT_ID}_cloudbuild/source/**" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  (nothing staged)"

echo
echo "remaining Cloud Run services:"
gcloud run services list --region="${REGION}" --project="${PROJECT_ID}" 2>&1 | tail -3
echo "remaining artifact repositories:"
gcloud artifacts repositories list --location="${REGION}" --project="${PROJECT_ID}" 2>&1 | tail -3
