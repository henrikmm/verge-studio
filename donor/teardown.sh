#!/usr/bin/env bash
# MVL-027 — bounded teardown of the permanent worker.
#
# Destructive. CLOUD_SANDBOX.md section 10 makes the human owner the kill-switch
# owner, so this script requires MVL_TEARDOWN_APPROVED=yes and resolves every
# deletion target before deleting it. Retained evidence is never a target.
set -euo pipefail

PROJECT_ID="${1:?Usage: teardown.sh PROJECT_ID}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN="${SCRIPT_DIR}/plan.json"

if [[ "${MVL_TEARDOWN_APPROVED:-no}" != "yes" ]]; then
  echo "Teardown requires explicit owner approval (MVL_TEARDOWN_APPROVED=yes)" >&2
  exit 1
fi

read -r REGION JOB REPOSITORY IMAGE_NAME BUCKET OUTPUT_PREFIX BUILD_STAGING_PREFIX \
  RETAINED_PREFIX <<<"$(node -e '
  const plan = require(process.argv[1]);
  process.stdout.write([
    plan.provider.region,
    plan.job.name,
    plan.image.repository,
    plan.image.name,
    plan.storage.bucket,
    plan.storage.output_prefix,
    plan.storage.build_staging_prefix,
    plan.storage.retained_evidence_prefix,
  ].join(" "));
' "${PLAN}")"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"

RUNNING="$("${GCLOUD_BIN}" run jobs executions list --job="${JOB}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --filter='status.runningCount>0' --format='value(metadata.name)' 2>/dev/null || true)"
if [[ -n "${RUNNING}" ]]; then
  echo "Refusing teardown while an execution is still running: ${RUNNING}" >&2
  exit 1
fi

echo "Resolved deletion targets:"
echo "  Cloud Run job:      ${JOB} (${REGION})"
echo "  Image digests:      ${IMAGE_URI}"
echo "  Transient objects:  gs://${BUCKET}/${OUTPUT_PREFIX}"
echo "  Build staging:      gs://${BUCKET}/${BUILD_STAGING_PREFIX}"
echo "  Retained (kept):    gs://${BUCKET}/${RETAINED_PREFIX}"

if [[ "${OUTPUT_PREFIX}" == "${RETAINED_PREFIX}" || -z "${OUTPUT_PREFIX}" ]]; then
  echo "Refusing teardown: transient and retained prefixes are not distinct" >&2
  exit 1
fi

"${GCLOUD_BIN}" run jobs delete "${JOB}" --region="${REGION}" \
  --quiet --project="${PROJECT_ID}" || true

for DIGEST in $("${GCLOUD_BIN}" artifacts docker images list "${IMAGE_URI}" \
  --format='value(version)' --project="${PROJECT_ID}" 2>/dev/null || true); do
  "${GCLOUD_BIN}" artifacts docker images delete "${IMAGE_URI}@${DIGEST}" \
    --delete-tags --quiet --project="${PROJECT_ID}" || true
done

"${GCLOUD_BIN}" storage rm --recursive \
  "gs://${BUCKET}/${OUTPUT_PREFIX}**" --project="${PROJECT_ID}" || true
"${GCLOUD_BIN}" storage rm --recursive \
  "gs://${BUCKET}/${BUILD_STAGING_PREFIX}**" --project="${PROJECT_ID}" || true

printf 'Teardown complete; retained evidence under gs://%s/%s was not touched\n' \
  "${BUCKET}" "${RETAINED_PREFIX}"
