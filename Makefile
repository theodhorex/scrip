.PHONY: setup test contract-test contract-build demo-test static mutants verify-links script-test ci
# Fresh clone: install pinned JS deps from the lockfiles (needs network once).
setup:
	cd client && npm ci
	cd facilitator && npm ci
	cd scripts && npm ci

# Grows as components land. Each target must run offline unless noted.
test: contract-test demo-test script-test
	cd client && node --test test/
	cd facilitator && node --test test/

contract-test:
	cd contracts/scrip && cargo test --lib

demo-test:
	node --test demo/test/

contract-build:
	cd contracts/scrip && cargo build --release --target wasm32-unknown-unknown

# Sandbox integration tests. NOT part of `make test` (needs network for the
# sandbox binary download + builds the ft_mock wasm and the real scrip.wasm).
.PHONY: contract-it
contract-it:
	cd contracts/scrip && cargo build --release --target wasm32-unknown-unknown
	cd contracts/scrip/tests/ft_mock && cargo build --release --target wasm32-unknown-unknown
	cd contracts/scrip && cargo test --test integration -- --test-threads=1

script-test:
	cd scripts && node --test test/

# Static analysis: clippy with warnings denied; cargo audit/deny only if installed.
static:
	cd contracts/scrip && cargo clippy --target wasm32-unknown-unknown -- -D warnings
	@if command -v cargo-audit >/dev/null 2>&1; then cd contracts/scrip && (cargo audit || echo "cargo audit reported advisories: dev/test-only ones are triaged in contracts/scrip/STATIC.md; review any new runtime advisory"); else echo "cargo-audit not installed: skipped"; fi
	@if command -v cargo-deny >/dev/null 2>&1; then cd contracts/scrip && cargo deny check; else echo "cargo-deny not installed: skipped"; fi

# Mutation check, only if the script exists in the repo.
mutants:
	@if [ -x scripts/mutants.sh ]; then scripts/mutants.sh; else echo "scripts/mutants.sh not present: skipped"; fi

# Read-only: checks every tx hash in results/*.json against the public testnet RPC (needs network).
verify-links:
	cd scripts && node verify-links.mjs

# What CI runs: offline tests + static analysis + wasm build.
ci: test static contract-build
