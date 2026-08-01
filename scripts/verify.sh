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

# geometry/ is TypeScript and is covered by the app's vitest run above (its test glob
# includes ../geometry) and by the app's tsc (its tsconfig includes ../geometry). It used
# to be run separately with `node --test`, which would now try to execute .ts files.
# Keeping one runner also means geometry and the app can never drift apart on types.

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
