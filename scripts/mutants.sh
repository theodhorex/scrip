#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}/contracts/scrip"

# Run cargo-mutants targeting src/lib.rs with a 120s timeout per mutant and 3 parallel jobs.
# Extra arguments (e.g. --shard 1/20 or --json) can be passed to this script.
exec cargo mutants --file src/lib.rs --jobs 3 --timeout 120 "$@" -- --lib
