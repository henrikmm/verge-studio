#!/usr/bin/env bash
# Shared, non-mutating configuration checks for the optional Google Cloud path.

load_local_cloud_env() {
  local common_dir config raw key value
  common_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  config="${common_dir%/scripts}/.env.local"
  [[ -f "${config}" ]] || return 0

  while IFS= read -r raw || [[ -n "${raw}" ]]; do
    raw="${raw%$'\r'}"
    [[ "${raw}" =~ ^[[:space:]]*$ || "${raw}" =~ ^[[:space:]]*# ]] && continue
    [[ "${raw}" == export[[:space:]]* ]] && raw="${raw#export }"
    if [[ "${raw}" != *=* ]]; then
      echo "invalid .env.local line: expected NAME=value" >&2
      return 1
    fi

    key="${raw%%=*}"
    value="${raw#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    case "${key}" in
      PROJECT_ID)
        [[ -n "${PROJECT_ID+x}" ]] || export PROJECT_ID="${value}"
        ;;
      REGION)
        [[ -n "${REGION+x}" ]] || export REGION="${value}"
        ;;
      VERGE_OUTPUT_BUCKET)
        [[ -n "${VERGE_OUTPUT_BUCKET+x}" ]] || export VERGE_OUTPUT_BUCKET="${value}"
        ;;
    esac
  done < "${config}"
}

load_local_cloud_env

require_command() {
  local command="$1"
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "missing required command: ${command}" >&2
    exit 1
  fi
}

require_cloud_config() {
  : "${PROJECT_ID:?set PROJECT_ID to the Google Cloud project you own}"
  : "${REGION:?set REGION to the Cloud Run region to use}"
  : "${VERGE_OUTPUT_BUCKET:?set VERGE_OUTPUT_BUCKET to a globally unique bucket name you own}"

  if [[ ! "${PROJECT_ID}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    echo "PROJECT_ID is not a valid Google Cloud project ID: ${PROJECT_ID}" >&2
    exit 1
  fi
  if [[ ! "${VERGE_OUTPUT_BUCKET}" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]]; then
    echo "VERGE_OUTPUT_BUCKET is not a plausible globally unique bucket name: ${VERGE_OUTPUT_BUCKET}" >&2
    exit 1
  fi

  SERVICE="${SERVICE:-verge-da3}"
  REPOSITORY="${REPOSITORY:-verge}"
  IMAGE_NAME="${IMAGE_NAME:-da3-service}"
  OUTPUT_PREFIX="${VERGE_OUTPUT_PREFIX:-runs/transient}"
  RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-verge-runtime}"
  local expected_runtime_sa="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  if [[ -n "${RUNTIME_SA:-}" && "${RUNTIME_SA}" != "${expected_runtime_sa}" ]]; then
    echo "set RUNTIME_SA_NAME, not RUNTIME_SA; the runtime identity must be dedicated to PROJECT_ID" >&2
    exit 1
  fi
  RUNTIME_SA="${expected_runtime_sa}"
  IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else
    echo "need sha256sum (Linux) or shasum (macOS) on PATH" >&2
    return 1
  fi
}

source_tag() {
  local filename
  while IFS= read -r filename; do
    sha256_stream < "${filename}" | awk -v filename="${filename}" '{ print $1 "  " filename }'
  done < <(find server -type f -not -path '*/__pycache__/*' | LC_ALL=C sort) | sha256_stream | awk '{ print "src-" substr($1, 1, 16) }'
}
