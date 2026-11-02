# Static Analysis & Dependency Audit (`contracts/scrip`)

Measured on **2026-10-30** against `contracts/scrip` (`scrip v0.1.0`, `near-sdk = "=5.30.0"`). No dependencies were upgraded or modified during this audit so that the contract source and lockfile remain consistent with the verified testnet build.

## Toolchain & Availability

| Tool | Version / Status | Executed |
|---|---|---|
| `rustc` | `1.99.1 (58cf8f9c3 2026-10-13)` | Yes |
| `cargo` | `1.99.1 (5f94df478 2026-08-27)` | Yes |
| `cargo clippy` | `0.1.99 (58cf8f9c35 2026-10-13)` | Yes |
| `cargo audit` | `cargo-audit 0.22.2` (1,386 RustSec advisories; 450 crates in `Cargo.lock`) | Yes |
| `cargo deny` | Not installed in environment | No (documented below) |
| `cargo llvm-cov` | Not installed in environment | No (documented below) |

---

## Summary of Results

| Check | Command | Exit Code | Actual Result |
|---|---|---|---|
| Clippy (all targets: lib, unit/proptest, integration) | `cargo clippy --all-targets -- -D warnings` | `0` | **0 warnings, 0 errors** (`src/lib.rs` needed no edits) |
| Clippy (deployed Wasm target) | `cargo clippy --target wasm32-unknown-unknown -- -D warnings` | `0` | **0 warnings, 0 errors** |
| Contract unit & property tests | `cargo test --lib` | `0` | **112 passed, 0 failed, 2 ignored** |
| RustSec advisory audit | `cargo audit` | `1` | **0 runtime Wasm vulnerabilities**; **4 dev/test-only vulnerabilities**; **13 warnings** (1 runtime `unmaintained`, 12 dev/test-only) |
| License / ban / source check | `cargo deny check` | n/a | Not executed (`cargo-deny` not installed) |
| Line / branch coverage | `cargo llvm-cov --lib` | n/a | Not executed (`cargo-llvm-cov` not installed) |

### Note on Lint Attributes in `src/lib.rs`

`contracts/scrip/src/lib.rs` compiles cleanly under `-D warnings` without modification. It contains one intentional lint allow attribute:
- `#[allow(clippy::too_many_arguments)]` on `Scrip::create_mandate` (`src/lib.rs:373`), which accepts the 8 flat JSON parameters defined by the public contract ABI.

---

## `cargo audit` Triage: Runtime Contract vs. Dev/Test Dependencies

`Cargo.lock` unifies normal runtime dependencies (`[dependencies]`) and test-only dependencies (`[dev-dependencies]`). Reachability into the deployed `scrip.wasm` binary was verified with:

```bash
cargo tree --target wasm32-unknown-unknown --edges normal -i <crate>
cargo tree --edges all -i <crate>
```

### 1. Deployed Contract Runtime (`wasm32-unknown-unknown`, `--edges normal`)

**0 vulnerabilities (`error`)** affect the compiled Wasm contract. Only **1 informational warning** appears in the `wasm32-unknown-unknown` dependency graph:

| Advisory ID | Crate & Version | Kind | Dependency Path | Assessment & Deferral |
|---|---|---|---|---|
| `RUSTSEC-2022-0054` | `wee_alloc 0.4.5` | Warning (`unmaintained`) | `scrip -> near-sdk 5.30.0 -> wee_alloc 0.4.5` | Default Wasm allocator enabled by `near-sdk 5.30.0`. NEAR executes each contract call in an isolated short-lived Wasm VM instance whose linear memory is discarded after the receipt finishes, so long-lived heap fragmentation/leak issues do not persist across transactions. Deferred while `near-sdk = "=5.30.0"` is pinned (re-evaluate on next `near-sdk` upgrade). |

### 2. Dev/Test-Only Vulnerabilities (`[dev-dependencies]` — NOT in `scrip.wasm`)

All **4 vulnerabilities** reported by `cargo audit` return `nothing to print` under `cargo tree --target wasm32-unknown-unknown --edges normal -i <crate>`. They are pulled in solely by host-side test harnesses (`near-sdk` `unit-testing` VM runner and `near-workspaces 0.24.0`):

| Advisory ID | Crate & Version | Title (Published) | Upstream Fix | Dev/Test Dependency Path | Runtime Wasm? |
|---|---|---|---|---|---|
| `RUSTSEC-2026-0387` | `crypto-bigint 0.5.5` | Multiple timing variability issues in operations intended to be constant-time (2026-10-23) | `>= 0.7.6` | `near-sdk[unit-testing] -> near-vm-runner 0.38.0 -> p256 0.13.2 / ecdsa 0.16.9 -> elliptic-curve 0.13.8 -> crypto-bigint 0.5.5` | **No** (dev/test only; contract uses NEAR host `env::sha256_array`) |
| `RUSTSEC-2026-0391` | `zstd 0.13.3` | Data from an abandoned stream leaks into the next stream on a reused context (2026-10-16) | `>= 0.14.3` | `near-sdk[unit-testing]` & `near-workspaces 0.24.0 -> near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0398` | `zstd-safe 7.3.0` | `Seekable::decompress` sets a `Vec` length beyond its capacity for offsets past the end (2026-10-16) | `>= 8.2.0` | `near-primitives 0.38.0 -> zstd 0.13.3 -> zstd-safe 7.3.0` | **No** (dev/test only) |
| `RUSTSEC-2026-0403` | `zstd-safe 7.3.0` | Uninitialized memory exposed when streaming decompression of a legacy frame fails (2026-10-16) | `>= 8.2.0` | `near-primitives 0.38.0 -> zstd 0.13.3 -> zstd-safe 7.3.0` | **No** (dev/test only) |

### 3. Dev/Test-Only Warnings (`[dev-dependencies]` — NOT in `scrip.wasm`)

The remaining **12 warnings** are likewise absent from `wasm32-unknown-unknown` normal dependencies and exist only in host test tooling:

| Advisory ID | Crate & Version | Kind | Title | Dev/Test Dependency Path | Runtime Wasm? |
|---|---|---|---|---|---|
| `RUSTSEC-2024-0449` | `unsafe-libyaml 0.2.11` | `unmaintained` | `unsafe-libyaml` is unmaintained | `near-sdk[unit-testing]` & `near-workspaces 0.24.0 -> near-parameters 0.38.0 -> serde_yaml 0.9.34` | **No** (dev/test only) |
| `RUSTSEC-2026-0386` | `tokio 1.52.3` | `unsound` | `AsyncFd::new` and related constructors violate I/O safety | `[dev-dependencies]` `tokio 1.52.3` & `near-workspaces 0.24.0` | **No** (dev/test only) |
| `RUSTSEC-2026-0395` | `zstd-safe 7.3.0` | `unsound` | Use-after-free with `CParameter::StableInBuffer` | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0396` | `zstd-safe 7.3.0` | `unsound` | `Seekable` reads a NULL or out-of-bounds seek table | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0397` | `zstd-safe 7.3.0` | `unsound` | `OutBuffer::around_pos` exposes uninitialized memory | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0399` | `zstd-safe 7.3.0` | `unsound` | Use-after-free through `init_using_cdict` and `init_using_ddict` | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0400` | `zstd-safe 7.3.0` | `unsound` | Use-after-free of a dictionary after a one-shot call on a context with an open stream | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0401` | `zstd-safe 7.3.0` | `unsound` | Out-of-bounds read in `train_from_buffer` when sample sizes overflow | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0402` | `zstd-safe 7.3.0` | `unsound` | Heap buffer overflow in `CCtx::try_clone` on a multithreaded context | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0404` | `zstd-safe 7.3.0` | `unsound` | Double free in `DCtx::try_clone` | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0405` | `zstd-safe 7.3.0` | `unsound` | Out-of-bounds read with an out-of-range `InBuffer::pos` | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |
| `RUSTSEC-2026-0406` | `zstd-safe 7.3.0` | `unsound` | Use-after-free when changing a multithreaded context with an unfinished frame | `near-primitives 0.38.0 -> zstd 0.13.3` | **No** (dev/test only) |

### Deferral Policy & CI Note

- **Why dependencies were not upgraded:** `near-sdk = "=5.30.0"` and `near-workspaces = "=0.24.0"` transitively pin `near-primitives 0.38.0` and `near-vm-runner 0.38.0` (`zstd 0.13.3` / `zstd-safe 7.3.0`, `crypto-bigint 0.5.5`), and none of the 4 vulnerability advisories enter `wasm32-unknown-unknown`. Forced semver-breaking overrides are avoided to preserve deterministic behavior with the deployed testnet contract. Review date / trigger: **2026-11-20** or upon upgrading `near-sdk` / `near-workspaces`.
- **Exit code note:** Because `cargo audit` inspects the entire `Cargo.lock` (including `[dev-dependencies]`), `cargo audit` exits with code `1` on these 4 dev-only advisories unless scoped or explicitly ignored in CI policy.

---

## Commands to Reproduce

Run from the repository root (`/home/theo/Documents/dev/hackathon/scrip`):

```bash
# 1. Clippy static analysis across all targets (lib, unit/property tests, integration tests)
cd contracts/scrip && cargo clippy --all-targets -- -D warnings

# 2. Clippy static analysis specifically for the production Wasm target
cd contracts/scrip && cargo clippy --target wasm32-unknown-unknown -- -D warnings

# 3. Verify unit & property test suite (expected: 112 passed, 0 failed, 2 ignored)
cd contracts/scrip && cargo test --lib

# 4. Dependency vulnerability audit against Cargo.lock
#    (returns exit code 1 due to the 4 dev-only advisories documented above)
cd contracts/scrip && cargo audit

# 5. Verify whether an advisory crate is present in the deployed Wasm dependency graph
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i crypto-bigint
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i zstd
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i zstd-safe
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i unsafe-libyaml
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i tokio
cd contracts/scrip && cargo tree --target wasm32-unknown-unknown --edges normal -i wee_alloc
```

### Optional Checks Not Run on This Host (Tools Not Installed)

If `cargo-deny` and `cargo-llvm-cov` are installed in a separate audit environment, run:

```bash
# Not run on verification host (cargo-deny not installed)
cd contracts/scrip && cargo deny check

# Not run on verification host (cargo-llvm-cov not installed)
cd contracts/scrip && cargo llvm-cov --lib
```
