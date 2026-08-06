#!/usr/bin/env bash
# Stop the billing that actually accrues. Run this at the end of every cloud session.
#
# The Cloud Run service bills for INSTANCE LIFETIME while an instance is alive, so
# deleting it is what stops the meter -- that is the default and always happens.
#
# ONE ~12 GB image in Artifact Registry is deliberately KEPT. Its storage charge is
# ~$0.10/GB/month, whereas rebuilding it costs 15-20 minutes of wall clock at the start of
# every session. Keeping it is the cheaper trade by a wide margin for an active project.
# Pass PURGE_IMAGE=1 when the project is finished for good.
#
# "One" is the whole point, and it did not used to be enforced. deploy.sh tags each build
# with a hash of server/, so every change to that directory leaves another ~12 GB image
# behind. On 2026-08-06 the repository held two, at 16.68 GB, against docs claiming ~12 GB.
# So teardown now reaps: after the service is gone, every image except the one matching the
# CURRENT server/ source is deleted. The tag is recomputed here exactly as deploy.sh
# computes it -- if the two ever drift, this script would delete the image deploy.sh is
# about to look for, so they must be changed together.
#
# If this session's runs FAILED, set REAP_OLD_IMAGES=0. The older image is then your way
# back, and a rollback is worth far more than a dollar of storage.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-verge-lab}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-verge-da3}"
REPOSITORY="${REPOSITORY:-verge}"
IMAGE_NAME="${IMAGE_NAME:-da3-service}"
PURGE_IMAGE="${PURGE_IMAGE:-0}"
REAP_OLD_IMAGES="${REAP_OLD_IMAGES:-1}"

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
elif [[ "${REAP_OLD_IMAGES}" != "1" ]]; then
  echo "== keeping ALL images (REAP_OLD_IMAGES=0) =="
  echo "   use this only when this session's runs failed and you may need to roll back."
else
  echo "== keeping the current image, reaping older ones (PURGE_IMAGE=1 to delete all) =="
  IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"
  # Identical to deploy.sh's SRC_TAG. Keep the two in step.
  KEEP_TAG="src-$(find server -type f -not -path '*/__pycache__/*' \
    | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)"

  # Promotion needs something to promote. If server/ has been edited since the last build,
  # no stored image carries KEEP_TAG -- and reaping "everything that is not the current
  # source" would then delete the only image there is, turning the next deploy into a
  # 20-minute rebuild with no way back. Nothing is reaped until the current source has
  # actually been built and, per AGENTS.md, has served a run.
  if ! gcloud artifacts docker images describe "${IMAGE_URI}:${KEEP_TAG}" \
        --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "   no image for the current server/ source — nothing to promote, keeping all."
    echo "   (server/ was edited since the last build; reap once the next deploy proves out.)"
  else
    echo "   keeping ${KEEP_TAG} (matches server/ as it stands)"
    REAPED=0
    while read -r DIGEST TAGS; do
      [[ -z "${DIGEST}" ]] && continue
      # Comma-fenced so a tag can never match a longer tag it is a prefix of.
      [[ ",${TAGS}," == *",${KEEP_TAG},"* ]] && continue
      echo "   deleting ${TAGS:-<untagged>} (${DIGEST:0:19}...)"
      if gcloud artifacts docker images delete "${IMAGE_URI}@${DIGEST}" \
           --delete-tags --quiet --project="${PROJECT_ID}" >/dev/null 2>&1; then
        REAPED=$((REAPED + 1))
      else
        echo "   !! could not delete ${DIGEST:0:19} — check it by hand" >&2
      fi
    done < <(gcloud artifacts docker images list "${IMAGE_URI}" --include-tags \
               --format='value(version,tags)' --project="${PROJECT_ID}" 2>/dev/null)

    if [[ ${REAPED} -gt 0 ]]; then
      echo "   reaped ${REAPED} old image(s). Artifact Registry reclaims shared layers"
      echo "   asynchronously, so the reported repository size lags this by some hours."
    else
      echo "   nothing to reap — one image, as it should be."
    fi
  fi
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
