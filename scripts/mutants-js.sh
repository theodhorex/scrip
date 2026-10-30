#!/usr/bin/env bash
# Full JS mutation-testing run for the facilitator (StrykerJS).
#
# - runs at the lowest CPU priority (`nice -n 19`) so it never starves tests/dev servers
# - fixed at 2 workers (`--concurrency 2`)
# - all artefacts (JSON report, sandbox temp dir) go to facilitator/.stryker-out/
# - optional first argument limits the run to one file or glob, e.g.
#       scripts/mutants-js.sh src/policy.mjs
#   anything after that is passed straight to `stryker run` (e.g. --reporters clear-text).
#
# Full runs are slow by nature (the `command` runner re-runs the whole suite for every
# mutant), so this is meant to be started by hand, not on every commit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FACILITATOR_DIR="${REPO_ROOT}/facilitator"
OUT_DIR="${FACILITATOR_DIR}/.stryker-out"

cd "${FACILITATOR_DIR}"
mkdir -p "${OUT_DIR}"

# Optional leading file/glob argument -> --mutate <target> (replaces the config's mutate list).
MUTATE_ARGS=()
if [[ $# -gt 0 && "$1" != -* ]]; then
  MUTATE_ARGS=(--mutate "$1")
  shift
fi

exec nice -n 19 npx --no-install stryker run \
  --concurrency 2 \
  "${MUTATE_ARGS[@]}" \
  "$@"
