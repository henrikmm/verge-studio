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

echo "verify: OK"
