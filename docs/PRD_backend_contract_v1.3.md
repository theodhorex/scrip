# Scrip: Backend and Contract PRD v1.3 (Oct 30, 2026)

Continuing PRD v1.2 (Obsidian: `Hackathon/NEAR/PRD Scrip v1.1 - spesifikasi, rencana, task.md`). This document contains only what CHANGED or REMAINS OPEN in contract, facilitator, client, testing, operations, and audit readiness, based on actual repo conditions and research (`reports/Riset backend dan kontrak Scrip.md`). Labels: **[proven]** directly tested/observed; **[research]** from sources in research report; **[decision]** PM decision.

## 1. Actual Status (Oct 30)
- [proven] Final contract deployed and tested on testnet: `results/gate.json` (2 valid payments, 5 rejected attacks, `OVER_BUDGET`, revoke, withdraw, 0 accounts remaining), `attack.json` (30 parallel requests: naive leaked 0.4, Scrip exact 1.0), `demo.json` (prompt injection). Nov 2 gate **passed**.
- [proven] `make contract-test` 101 passed; sandbox 18 tests; facilitator 59 tests (97.2% line coverage); client 75; demo 24.
- [proven] `request_payment` ceiling already `min(budget, deposited - withdrawn)` (`lib.rs` ~490).
- [research] NEAR x402 `exact` scheme rejects function-call keys (requires single `ft_transfer` with 1 yocto deposit). Scrip is NOT compatible with standard x402 clients. [decision] Termed "x402-style" (HTTP 402 + facilitator + endpoints `/verify` `/settle` `/supported`, custom verification rules), documented honestly in README; judges are not required to use a standard x402 client.
- Not yet present: `git init`, LICENSE, CI, static analysis, measured contract coverage, saved mutation score, `docs/PROPERTIES.md`, recovery script in this repo.

## 2. Goals of v1.3
1. Close remaining contract findings without modifying proven behavior.
2. Make facilitator restart-resilient and honest about final payment outcomes (not just "outer tx succeeded").
3. Add x402-style interface so demo and judges can verify a payment with a single HTTP 402 flow.
4. Prove invariants with real property tests and mutation testing with saved scripts.
5. Prepare repo for clean clone, audit, and submission (Nov 1-14).

## 3. Contract (`contracts/scrip`)
| ID | Change | Acceptance |
|---|---|---|
| K-A | `tighten` preserves invariant `budget >= cap >= threshold` (reject, or shrink cap/threshold automatically; CHOSEN: reject with explicit code) on `Budget` and `PerPaymentCap` | unit + property tests: invariant never violated after random sequence of operations |
| K-B | `create_mandate` rejects `owner == agent` (new code) and refunds excess NEAR deposit; same in `approve_intent` | unit test for each branch; contract NEAR balance does not increase from excess |
| K-C | Bound `approvals` growth (limit per mandate, code `TOO_MANY_APPROVALS`) or expire | boundary tests |
| K-D | Clean up stale documentation/comments (`withdrawn` ceiling, README Design notes section, REPORT.md) | grep no longer finds legacy claims |
| K-E | Decision K-11: contract **immutable** for hackathon (no `migrate`); stated in README (contract keys deleted after init on demo deploy) | README + `gate.mjs` leaves no full-access key when used |
| K-F | K-3 (shared token balance): design NOT changed; documented as acknowledged boundary + "one contract per owner" mitigation + proposed token allowlist as future work | README threat model includes K-3 |
Forbidden: do not alter reservation/callback/`resolve_stale` semantics; gas numbers stay fixed.

## 4. Contract Testing
| ID | Content | Acceptance |
|---|---|---|
| T-A | Replace custom PRNG in `property_tests.rs` with `proptest` + reference model (state machine) for 10 properties: P1 `spent+reserved<=budget`; P2 `budget<=deposited-withdrawn`; P3 token conservation (contract = mandate remainder + locked); P4 `tighten` does not loosen; P5 `loosen` does not exceed deposit; P6 `withdraw` only Revoked and only remainder; P7 approval only once; P8 intent hash deterministic; P9 pending never settles twice; P10 random order preserves P1-P3. Use shrinking and many test cases | `cargo test --lib` green; each property has one mutant that makes it fail |
| T-B | Sandbox: `assert_err_code` helper reading `SCRIP_ERR:<code\>` from logs; replace generic `is_failure()`; fix shallow generators (resolve_stale and revoke actually reached); mixed race (request vs revoke/tighten/withdraw), 40 parallel requests | `make contract-it` green, error codes verified |
| T-C | Mutation: install `cargo-mutants`; `scripts/mutants.sh` (`--file src/lib.rs --jobs 3 --timeout 120 -- --lib`); save summary in `contracts/scrip/MUTATION.md` (real numbers: killed/survived, survived list + reasons) | recorded score; relevant surviving mutants covered by tests |
| T-D | Static: `cargo clippy -- -D warnings`, `cargo audit`, `cargo deny` (if installed), coverage `cargo llvm-cov` if installed; results in `contracts/scrip/STATIC.md` | zero clippy warnings; results recorded honestly |
| T-E | Regressions for each finding in `AUDIT_1`/`AUDIT_2` lacking tests (especially N-L5 return >1024 bytes) | finding -> test name table in `docs/PROPERTIES.md` |

## 5. Facilitator (`facilitator/`)
| ID | Change | Acceptance |
|---|---|---|
| F-A | Persistent delegate dedupe (`node:sqlite`, `.facilitator.db` file, in `.gitignore`) surviving restarts; `RELAY_PENDING` reconciliation: save tx hash before broadcast, `GET /status/:hash` checks chain | tests: restart does not permit replay; pending can be recovered |
| F-B | Honest final status: wait for `FINAL` (not optimistic) and read inner result (`Reserved` -> callback `Settled`/`Rejected`/`Refunded` via `EVENT_JSON`/`SCRIP_ERR` logs); response includes `inner_status` | tests with mock RPC for each status |
| F-C | Stricter verification: parse `request_payment` args; compare delegate nonce against on-chain key nonce (reject `<=`); block height from `final` finality; check minimum relayer balance (`RELAYER_MIN_BALANCE`, reject `RELAYER_LOW_BALANCE`) | tests for each rejection |
| F-D | Operational: explicit RPC timeout, graceful SIGTERM, `request_id`, structured JSON logs (no secrets), `/metrics` (counts per code), security headers, call `keyVerifier.evict` on revoked keys | unit tests; no keys/secrets in logs |
| F-E | x402-style endpoints: `GET /supported`, `POST /verify`, `POST /settle` (payload: base64 `PAYMENT-SIGNATURE` header containing delegate + `paymentRequirements` {payTo, amount, asset, mandate}); `/verify` = validation without broadcast + match recipient/amount against requirements; `/settle` = relay + wait for inner status; `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` headers in demo merchant (replaces `POST /paid {invoiceId,txHash}` as primary path, legacy path retained) | complete HTTP 402 demo: 402 -> client signs -> settle -> 200 |
Note: `/relay` remains. Multi-instance/Redis noted as an acknowledged boundary only.

## 6. Client and Demo (`client/`, `demo/`)
| ID | Change | Acceptance |
|---|---|---|
| C-A | `client`: `buildPaymentSignature(requirements)` and `parsePaymentResponse` functions; tests with fixed vectors | green tests |
| C-B | `demo/merchant.mjs`: x402-style 402 flow; `demo/agent.mjs`: client reading 402 and paying; malicious merchant retained | `node --test demo/test` green |

## 7. Operations and Repo
| ID | Content | Acceptance |
|---|---|---|
| O-A | `scripts/recover.mjs` (orphan account recovery from `.recovery-*.json`, safe, no key printing); `chmod 600` key files in `NEAR/` (reported, not modified without permission) | script + dry test |
| O-B | `.gitignore`: add `.throwaway-keys*`, `*.pem`, `.near-credentials/`, `*.db`; LICENSE: **MIT** [temporary decision; Theo may change] | clean secret scan |
| O-C | `Makefile`: targets `static`, `mutants`, `verify-links` (check `results/` explorer links via RPC `tx`), `ci`; `.github/workflows/ci.yml` (offline tests + clippy) | `make ci` green locally |
| O-D | Audit-ready docs: `docs/PROPERTIES.md` (invariants -> tests table), `docs/ARCHITECTURE.md` (sequence diagrams, glossary, trust boundaries), README: "verify in 60 seconds" block + claim -> evidence -> reproduction table + actual test count adjustments | each README claim matches code/`results/` |
| O-E | After all changes: rerun `scripts/gate.mjs` on testnet (keys from file, unprinted), save fresh results, ensure 0 accounts remaining | fresh `results/gate.json`, tx on explorer |

## 8. Sequencing and Gates
Wave 1 (parallel, separated file ownership): **Contract** (K-A..K-F, T-A..T-E) | **Facilitator + client + demo** (F-A..F-E, C-A, C-B) | **Operations + docs** (O-A..O-D). Wave 2: differential audit (`differential-review`, `solidity-auditor` not applicable) over changes, rerun `make test`, `make contract-it`, mutation, then O-E on testnet. Wave 3: sync README, hub, and Obsidian. Code freeze Nov 12; first repo commit on or after Nov 1 (hackathon rules).

## 9. Risks
- Modifying contract after testnet validation: every change must pass `make contract-it` and re-gate; do not touch reservation flow.
- Mutation run time (1.5-4 hours): run in background; sample if too long.
- `proptest-state-machine` might not fit near-sdk 5.30: fallback to standard `proptest` with manual model.
- Limited testnet funds: limit testnet rounds; keys from file only.
