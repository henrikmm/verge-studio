#!/usr/bin/env bash
# Fast local verification loop: typecheck + unit tests + fixture smoke.
# Zero cloud cost. Run after every coherent unit of work.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== fixture smoke =="
node scripts/check-fixtures.mjs

if [ -f app/package.json ]; then
  echo "== typecheck =="
  (cd app && npx tsc --noEmit)
  echo "== unit tests =="
  (cd app && npm test --silent)
fi

if [ -d geometry ] && ls geometry/*.test.* >/dev/null 2>&1; then
  echo "== geometry tests =="
  (cd geometry && node --test)
fi

# Server contract smoke. Needs fastapi but NOT torch/DA3, so it runs on this Mac
# whenever a venv with fastapi is on PATH (set VERGE_PY to point at one).
VERGE_PY="${VERGE_PY:-python3}"
if "${VERGE_PY}" -c "import fastapi" >/dev/null 2>&1; then
  echo "== server contract =="
  "${VERGE_PY}" server/test_contract.py
else
  echo "== server contract == (skipped: no fastapi; set VERGE_PY to a venv python)"
fi

echo "verify: OK"
