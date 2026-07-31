#!/usr/bin/env bash
# MVL-027 — provision the permanent Cloud Run Jobs worker.
#
# This script creates billable resources. It refuses to run until the owner has
# granted task-specific approval in plan.json and the enforced BRL 100.00 Cloud Run
# Spend Cap has been browser-verified on the same UTC day (CLOUD_SANDBOX.md 1, 12).
#
# It never executes the job: `--execute-now` is forbidden in the provisioning change
# (CLOUD_SANDBOX.md 9). Running the job is a separate, separately measured action.
set -euo pipefail

PROJECT_ID="${1:?Usage: deploy.sh PROJECT_ID}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN="${SCRIPT_DIR}/plan.json"

read -r APPROVAL_GRANTED SPEND_CAP_VERIFIED REGION JOB REPOSITORY IMAGE_NAME IMAGE_TAG \
  SERVICE_ACCOUNT_NAME BUCKET INPUT_PREFIX OUTPUT_PREFIX BUILD_STAGING_PREFIX \
  MAX_REPOSITORY_BYTES MAX_BUILD_BRL MAX_RUN_BRL BASELINE_MTD_BRL APPLICATION_CEILING_BRL \
  TASK_TIMEOUT CPU MEMORY_GIB <<<"$(node -e '
  const plan = require(process.argv[1]);
  process.stdout.write([
    plan.approval.granted,
    plan.approval.spend_cap_last_verified_utc,
    plan.provider.region,
    plan.job.name,
    plan.image.repository,
    plan.image.name,
    plan.image.tag,
    plan.identity.service_account,
    plan.storage.bucket,
    plan.storage.input_prefix,
    plan.storage.output_prefix,
    plan.storage.build_staging_prefix,
    plan.image.max_repository_bytes,
    plan.cost.maximum_build_brl,
    plan.cost.maximum_run_brl,
    plan.cost.verified_baseline_mtd_brl,
    plan.cost.application_monthly_ceiling_brl,
    plan.job.task_timeout_seconds,
    plan.job.cpu,
    plan.job.memory_gib,
  ].join(" "));
' "${PLAN}")"

SERVICE_ACCOUNT="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"

if [[ "${APPROVAL_GRANTED}" != "true" ]]; then
  echo "MVL-027 has no recorded owner approval; refusing to create billable resources" >&2
  exit 1
fi
if [[ "$(date -u +%F)" != "${SPEND_CAP_VERIFIED}" ]]; then
  echo "Cloud Run Spend Cap verification is stale; human browser verification is required" >&2
  exit 1
fi
if [[ "$("${GCLOUD_BIN}" config get-value project 2>/dev/null)" != "${PROJECT_ID}" ]]; then
  echo "Active gcloud project does not match the reviewed MVL-027 plan" >&2
  exit 1
fi
# Already-accrued spend counts against the ceiling; a per-task-only check would let
# the application ceiling drift upward once per task.
if ! awk "BEGIN { exit !((${BASELINE_MTD_BRL} + ${MAX_BUILD_BRL} + ${MAX_RUN_BRL}) <= ${APPLICATION_CEILING_BRL}) }"; then
  echo "MVL-027 financial preflight exceeds the BRL application ceiling" >&2
  exit 1
fi

"${GCLOUD_BIN}" services enable \
  run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  --quiet --project="${PROJECT_ID}"

# Newly enabled APIs are not immediately usable. Wait for propagation rather than
# letting the first real call fail as a spurious PERMISSION_DENIED.
API_READY=false
for attempt in {1..24}; do
  if "${GCLOUD_BIN}" artifacts repositories list \
      --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1 \
    && "${GCLOUD_BIN}" run jobs list \
      --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  if (( attempt < 24 )); then
    sleep 5
  fi
done
if [[ "${API_READY}" != "true" ]]; then
  echo "API propagation did not complete within 120 seconds" >&2
  exit 1
fi

if ! "${GCLOUD_BIN}" artifacts repositories describe "${REPOSITORY}" \
  --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  "${GCLOUD_BIN}" artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Motiva permanent Benchmark-0 worker images" \
    --immutable-tags \
    --labels="project=motiva-verge-lab,environment=dev,owner=motiva,managed-by=repository,cost-center=benchmark-0" \
    --quiet --project="${PROJECT_ID}"
fi

if ! "${GCLOUD_BIN}" iam service-accounts describe "${SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  "${GCLOUD_BIN}" iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
    --display-name="Motiva Benchmark-0 worker" \
    --description="Keyless identity for the permanent MVL-027 remote worker" \
    --quiet --project="${PROJECT_ID}"
fi

USER_KEY_COUNT="$("${GCLOUD_BIN}" iam service-accounts keys list \
  --iam-account="${SERVICE_ACCOUNT}" --managed-by=user \
  --format='value(name)' --project="${PROJECT_ID}" | wc -l | tr -d ' ')"
if [[ "${USER_KEY_COUNT}" != "0" ]]; then
  echo "${SERVICE_ACCOUNT} has a user-managed key; refusing to continue" >&2
  exit 1
fi

# Least privilege: read exactly the approved input prefix, create exactly into the
# run output prefix, and nothing else. No overwrite, no bucket administration.
"${GCLOUD_BIN}" storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer" \
  --condition="expression=resource.name.startsWith('projects/_/buckets/${BUCKET}/objects/${INPUT_PREFIX}'),title=mvl027_input_read,description=MVL-027_exact_input_prefix" \
  --quiet --project="${PROJECT_ID}"
"${GCLOUD_BIN}" storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectCreator" \
  --condition="expression=resource.name.startsWith('projects/_/buckets/${BUCKET}/objects/${OUTPUT_PREFIX}'),title=mvl027_output_create_only,description=MVL-027_exact_output_prefix" \
  --quiet --project="${PROJECT_ID}"

if ! IMAGE_DIGEST="$("${GCLOUD_BIN}" artifacts docker images describe \
  "${IMAGE_URI}:${IMAGE_TAG}" --format='value(image_summary.digest)' \
  --project="${PROJECT_ID}" 2>/dev/null)"; then
  "${GCLOUD_BIN}" builds submit "${SCRIPT_DIR}" \
    --config="${SCRIPT_DIR}/cloudbuild.yaml" \
    --region="${REGION}" \
    --gcs-source-staging-dir="gs://${BUCKET}/${BUILD_STAGING_PREFIX}" \
    --substitutions="_IMAGE_URI=${IMAGE_URI},_IMAGE_TAG=${IMAGE_TAG}" \
    --quiet --project="${PROJECT_ID}"
  IMAGE_DIGEST="$("${GCLOUD_BIN}" artifacts docker images describe \
    "${IMAGE_URI}:${IMAGE_TAG}" --format='value(image_summary.digest)' \
    --project="${PROJECT_ID}")"
fi
if [[ ! "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Cloud Build did not produce a deployable sha256 image digest" >&2
  exit 1
fi

IMAGE_SIZE_BYTES="$("${GCLOUD_BIN}" artifacts docker images list "${IMAGE_URI}" \
  --format='value(metadata.imageSizeBytes)' --project="${PROJECT_ID}" |
  awk '{ total += $1 } END { print total + 0 }')"
if (( IMAGE_SIZE_BYTES > MAX_REPOSITORY_BYTES )); then
  echo "Artifact Registry inventory exceeds the reviewed repository ceiling" >&2
  exit 1
fi

if "${GCLOUD_BIN}" run jobs describe "${JOB}" \
  --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  # An existing job must be repointed at the reviewed digest rather than silently
  # keeping a predecessor image.
  "${GCLOUD_BIN}" run jobs update "${JOB}" \
    --image="${IMAGE_URI}@${IMAGE_DIGEST}" \
    --region="${REGION}" \
    --quiet --project="${PROJECT_ID}"
else
  "${GCLOUD_BIN}" run jobs create "${JOB}" \
    --image="${IMAGE_URI}@${IMAGE_DIGEST}" \
    --region="${REGION}" \
    --cpu="${CPU}" \
    --memory="${MEMORY_GIB}Gi" \
    --gpu=1 \
    --gpu-type=nvidia-l4 \
    --no-gpu-zonal-redundancy \
    --tasks=1 \
    --parallelism=1 \
    --max-retries=0 \
    --task-timeout="${TASK_TIMEOUT}s" \
    --service-account="${SERVICE_ACCOUNT}" \
    --set-env-vars="MVL_OUTPUT_BUCKET=${BUCKET},MVL_OUTPUT_PREFIX=${OUTPUT_PREFIX},MVL_IMAGE_DIGEST=${IMAGE_DIGEST}" \
    --labels="project=motiva-verge-lab,environment=dev,owner=motiva,managed-by=repository,cost-center=benchmark-0" \
    --quiet --project="${PROJECT_ID}"
fi

printf '%s %s\n' "${IMAGE_URI}@${IMAGE_DIGEST}" "${IMAGE_SIZE_BYTES}"
