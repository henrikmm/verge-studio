#!/usr/bin/env bash
# TEST-CLOUD-002 — deployed worker control conformance.
#
# Asserts that the permanent Cloud Run job matches infra/gcp/worker/plan.json:
# digest-pinned image, reviewed service identity, one task, one L4, zero retries,
# the 600-second task timeout, scale-to-zero, required labels, and no user-managed
# service-account key. It creates nothing and executes nothing.
set -euo pipefail

PROJECT_ID="${1:?Usage: verify-deployment.sh PROJECT_ID}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

PLAN="${SCRIPT_DIR}/plan.json"
REGION="$(node -e 'process.stdout.write(require(process.argv[1]).provider.region)' "${PLAN}")"
JOB="$(node -e 'process.stdout.write(require(process.argv[1]).job.name)' "${PLAN}")"
SERVICE_ACCOUNT_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).identity.service_account)' "${PLAN}")"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

JOB_JSON="${TEMP_DIR}/job.json"
KEYS_JSON="${TEMP_DIR}/keys.json"
EXECUTIONS_JSON="${TEMP_DIR}/executions.json"

"${GCLOUD_BIN}" run jobs describe "${JOB}" \
  --region="${REGION}" --project="${PROJECT_ID}" --format=json >"${JOB_JSON}"
"${GCLOUD_BIN}" iam service-accounts keys list \
  --iam-account="${SERVICE_ACCOUNT}" --managed-by=user \
  --project="${PROJECT_ID}" --format=json >"${KEYS_JSON}"
"${GCLOUD_BIN}" run jobs executions list --job="${JOB}" \
  --region="${REGION}" --project="${PROJECT_ID}" --format=json >"${EXECUTIONS_JSON}"

node - "${PLAN}" "${JOB_JSON}" "${KEYS_JSON}" "${EXECUTIONS_JSON}" "${SERVICE_ACCOUNT}" <<'NODE'
const fs = require("node:fs");
const [planPath, jobPath, keysPath, executionsPath, serviceAccount] =
  process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const keys = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const executions = JSON.parse(fs.readFileSync(executionsPath, "utf8"));

const assert = (value, message) => {
  if (!value) throw new Error(message);
};

const template =
  job.spec?.template?.spec?.template?.spec ?? job.template?.template ?? {};
const container = (template.containers ?? [])[0] ?? {};
const resources = container.resources?.limits ?? {};
const labels = job.metadata?.labels ?? job.labels ?? {};

assert(
  /@sha256:[0-9a-f]{64}$/.test(container.image ?? ""),
  "job image is not pinned to an immutable sha256 digest",
);
assert(
  (container.image ?? "").includes(`/${plan.image.repository}/${plan.image.name}`),
  "job image does not come from the reviewed repository",
);
assert(
  template.serviceAccountName === serviceAccount,
  `job does not run as ${serviceAccount}`,
);
assert(Number(template.maxRetries ?? 0) === 0, "job permits automatic retries");
assert(
  Number(String(template.timeoutSeconds ?? template.timeout ?? "").replace(/s$/, "")) ===
    plan.job.task_timeout_seconds,
  "job task timeout does not match the reviewed plan",
);
assert(Number(resources["nvidia.com/gpu"] ?? 0) === plan.provider.gpu_count, "job GPU count");
assert(
  (container.nodeSelector?.["run.googleapis.com/accelerator"] ??
    template.nodeSelector?.["run.googleapis.com/accelerator"]) === plan.provider.accelerator,
  "job accelerator is not the reviewed nvidia-l4",
);

const taskCount = Number(
  job.spec?.template?.spec?.taskCount ?? job.template?.taskCount ?? 1,
);
const parallelism = Number(
  job.spec?.template?.spec?.parallelism ?? job.template?.parallelism ?? 1,
);
assert(taskCount === plan.job.tasks, "job task count is not 1");
assert(parallelism === plan.job.parallelism, "job parallelism is not 1");

// Scale-to-zero: a Cloud Run job holds no instance between executions, so a
// min-instances annotation would contradict the acceptance claim.
const annotations = job.metadata?.annotations ?? {};
const minInstances = Number(annotations["run.googleapis.com/minScale"] ?? 0);
assert(minInstances === 0, "job declares a non-zero minimum instance count");
const running = executions.filter(
  (execution) => Number(execution.status?.runningCount ?? 0) > 0,
);
assert(running.length === 0, "an execution is still running; the job is not idle");

for (const [key, value] of Object.entries({
  project: "motiva-verge-lab",
  environment: "dev",
  owner: "motiva",
  "managed-by": "repository",
  "cost-center": "benchmark-0",
})) {
  assert(labels[key] === value, `job label ${key} is missing or wrong`);
}

assert(keys.length === 0, "mvl-worker has a user-managed service account key");

process.stdout.write(
  `Worker deployment conformance passed: image=digest-pinned tasks=${taskCount} ` +
    `parallelism=${parallelism} retries=0 timeout=${plan.job.task_timeout_seconds}s ` +
    `accelerator=${plan.provider.accelerator} min_instances=0 idle=true user_keys=0\n`,
);
NODE
