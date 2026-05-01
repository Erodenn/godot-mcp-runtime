#!/usr/bin/env bash
# Run the same checks CI runs, in the same order. Stops on first failure.
# Usage: ./scripts/verify.sh   (or: npm run verify)

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "typecheck"
npm run typecheck

step "lint"
npm run lint

step "format:check"
npm run format:check

step "test"
npm test

step "build"
npm run build

printf '\n\033[1;32mAll checks passed.\033[0m\n'
