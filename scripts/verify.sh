#!/usr/bin/env bash
# Run every check CI runs, in the same order, stopping on the first failure.
# This is the single entrypoint — no need to also run `npm test` separately.
#
# Usage:
#   npm run verify                                       # skips Godot integration tests
#   GODOT_PATH=D:/Godot/latest/godot.exe npm run verify  # also runs Godot integration tests

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "typecheck"
npm run typecheck

step "lint"
npm run lint

step "format:check"
npm run format:check

if [ "${GODOT_PATH:-}" != "" ]; then
  step "test (Godot integration enabled: $GODOT_PATH)"
else
  step "test (Godot integration tests will skip — set GODOT_PATH to enable)"
fi
npm test

step "build"
npm run build

printf '\n\033[1;32mAll checks passed.\033[0m\n'
