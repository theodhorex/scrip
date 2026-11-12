# Scrip

[![CI](https://github.com/theodhorex/scrip/actions/workflows/ci.yml/badge.svg)](https://github.com/theodhorex/scrip/actions/workflows/ci.yml)
[Judges Verification Guide](JUDGES.md) | [Try It Guide](docs/TRY_IT.md)

**Disposable spending envelopes and on-chain payment mandates for autonomous AI agents.**

Scrip removes wallet custody from autonomous agents by enforcing spending policies directly on-chain on NEAR Protocol: immutable recipient allowlists, cumulative budget ceilings, per-payment caps, disposable single-task sub-account envelopes, and strict rejection of unprovable stale refunds. Security claims are backed by a 1,329-case offline attack catalog across 12 threat categories, repeated Layer E testnet executions settling real testnet USDC, 86% to 93% mutation testing scores on critical path modules, and full git history secret scanning with zero exposed credentials.

Autonomous AI agents given direct wallet custody or full-access keys lose their funds when prompt injection or compromised tools override their instructions. Defending against balance theft purely inside the model context is fragile because an adversary who controls the input context controls the agent's decisions. When an injected agent decides to transfer its entire wallet, a standard blockchain transaction executes immediately.

Scrip eliminates this vulnerability at the protocol layer. The agent never holds token balances, native NEAR, or master private keys. Instead, the funder creates a scoped spending mandate inside a NEAR smart contract and assigns the agent a restricted `FunctionCall` access key bound exclusively to `request_payment`. Every transfer is validated on-chain against an immutable recipient allowlist, a cumulative budget ceiling, and a per-payment cap. When an injected agent attempts to send funds to an unlisted recipient or drain the balance, the contract rejects the transaction.

Each task runs inside an isolated sub-account envelope funded with an exact budget. The agent signs standard off-chain NEP-366 delegate actions without holding native NEAR; an independent relayer validates permissions and sponsors network gas. When the task finishes, the owner revokes the mandate, withdraws unspent tokens, and deletes the sub-account, sweeping storage deposits back to the funder and leaving zero residual keys.

*Scrip* refers to currency issued for temporary, restricted circulation within a designated network.

| | |
|---|---|
| Network | NEAR testnet |
| Contract vault | [`amc*.envtest-theo-1747.testnet`](https://testnet.nearblocks.io/txns/Ap3xT6w2RimLu1UkcdsjeBTKpDXgX9Pxr6SmnbreTEWY) (NEAR testnet, ephemeral envelope) |
| Relayer / Facilitator | `relayer-theo-1747.testnet` (NEP-366 meta-transaction relayer on FastNEAR RPC) |
| Settlement token | Testnet USDC ([`3e2210e1184b...`](https://testnet.nearblocks.io/account/3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af)) |
| Repository | [`theodhorex/scrip`](https://github.com/theodhorex/scrip) |
| Verification | [JUDGES.md](JUDGES.md) (claims-to-evidence matrix), [docs/TRY_IT.md](docs/TRY_IT.md) (step-by-step walkthrough) |
| Test suite | 1,999 attack catalog cases executed (627 contract, 385 facilitator, 317 client, 160 sandbox, 510 live testnet): 1,894 PASS, 0 FAIL, 0 BREACH; the other 105 are SKIPPED (84 public testnet RPC rate limits or outages, 21 structurally unreachable on a live testnet), never counted as passes. Clean rerun, 10 to 12 Nov 2026. Plus 138 contract unit/property tests and script/web test suites |

## Try it in two minutes

Requirements: Node 22+, and Rust with `wasm32-unknown-unknown` only if rebuilding contracts. All commands run offline without network access.

### 1. Run scripts and verifier tests (~140 ms)

```sh
make script-test
```
<!-- source: Makefile:30, scripts/test/ -->

See: `38 passed` in ~140 ms. Tests CLI argument parsing, sub-account recovery sweeps, on-chain transaction verification, and link extraction.

### 2. Run client SDK test suite (~450 ms)

```sh
cd client && node --test test/
```
<!-- source: Makefile:10, client/test/ -->

See: `163 passed` in ~450 ms. Tests canonical intent hashing, guarded signing policies, and counterparty evaluation algorithms.

### 3. Run prompt injection demo suite (~460 ms)

```sh
make demo-test
```
<!-- source: Makefile:16, demo/test/ -->

See: `29 passed` in ~460 ms. Verifies honest payments settling, a prompt-injected agent attempting to pay an attacker and getting rejected on-chain (`RECIPIENT_NOT_ALLOWED`), an overcharge attempt blocked (`OVER_PER_PAYMENT_CAP`), and x402 payment settlement.

### 4. Run relayer and facilitator test suite (~1.7 s)

```sh
cd facilitator && node --test test/
```
<!-- source: Makefile:11, facilitator/test/ -->

See: `293 passed` in ~1.7 s. Tests access key permissions, 64-position bit-flip signature resilience, replay protection, token bucket rate limiting, and NEP-366 delegate validation.

### 5. Run offline attack catalog layers (~4 s)

```sh
node scripts/attack-catalog/run.mjs --layers C
node scripts/attack-catalog/run.mjs --layers B
```
<!-- source: scripts/attack-catalog/cases/c2_extra.mjs, scripts/attack-catalog/cases/b2_extra.mjs -->

See: `317 passed` on Layer C (client payload validation) and `385 passed` on Layer B (relayer checks), with 0 failures and 0 breaches across 12 attack categories.

### 6. Run smart contract unit and invariant test suite (~72 s)

```sh
make contract-test
```
<!-- source: Makefile:13, contracts/scrip/src/lib.rs -->

See: `138 passed` in ~3 min. Tests core accounting invariants (P1 through P10), fund conservation, state transitions, and all 627 Layer A attack catalog test cases.

## How mandates work

A spending mandate defines cryptographic rules that constrain agent spending. Funds are deposited into the Scrip contract, and payment execution follows an atomic two-phase lifecycle:

```
 [Agent] (FunctionCall Key)
    │
    │ 1. Signs off-chain NEP-366 DelegateAction (request_payment)
    ▼
 [Facilitator] (Relayer)
    │
    │ 2. Validates key permissions, rate limits, nonces; sponsors gas
    ▼
 [Scrip Contract Vault] (NEAR Smart Contract)
    │
    │ 3. Verifies recipient in allowlist, amount <= cap, spent + reserved <= budget
    │ 4. Places upfront reservation: reserved += amount
    ▼
 [NEP-141 Token Contract] ──5. ft_transfer──> [Merchant]
    │
    └──6. Callback on_payment_done (private):
          Success: settled (spent += amount, reserved -= amount)
          Failure: refunded (reserved -= amount)
```

1. **Parameters:** Each mandate specifies an owner, agent account, guardian account, NEP-141 token address, recipient allowlist (up to 16 accounts), cumulative budget ceiling, per-payment cap, approval threshold, and expiration timestamp.
2. **Two-phase reservation:** When `request_payment` runs, the contract verifies caller authorization and limits. If valid, funds are atomically reserved (`reserved += amount`) before dispatching an asynchronous `ft_transfer` promise.
3. **Private callback:** When `on_payment_done` executes, it checks the transfer receipt. If successful, the reservation settles (`spent += amount`, `reserved -= amount`). If the transfer fails or reverts, the reservation is released (`reserved -= amount`).
4. **Rule adjustments:** Mandate rules can only be tightened (never loosened) by the owner. Only the guardian can loosen rules within the deposited token balance.

## Why the agent cannot steal

Every attack vector evaluated across the catalog, the defense enforced by the protocol, and its verifying test:

| Category | Attack Vector | Protocol Defense | Verifying Test / Evidence |
|---|---|---|---|
| **01. Recipient Address** | Homoglyphs, uppercase, empty, or oversized recipient addresses (> 64 bytes) | Client regex validation and contract allowlist verification (`ACCOUNT_RE`, `RECIPIENT_NOT_ALLOWED`) | KAT-A-01, KAT-C-01, `test_recipient_validator` <!-- source: scripts/attack-catalog/cases/category_1.mjs --> |
| **02. Amount Manipulation** | Zero transfer, negative value, decimal point, or u128 integer overflow | Strict canonical decimal validator and contract non-zero / cap checks (`ZERO_AMOUNT`, `OVER_PER_PAYMENT_CAP`) | KAT-A-02, KAT-C-02, `positive_vector: max_u128_amount` <!-- source: scripts/attack-catalog/cases/category_2.mjs --> |
| **03. Intent Hash Collision** | Forging or altering intent parameters without invalidating signature | Domain-separated SHA-256 over length-prefixed parameters (`scrip/v1` domain tag) | Property test `p8_intent_hash_is_deterministic_and_field_sensitive`, `tools/vectors.json` <!-- source: contracts/scrip/src/property_tests.rs --> |
| **04. Nonce & Replay** | Resubmitting previously executed delegates or stale block heights | Facilitator deduplication store, on-chain nonce monotony, and block height expiry window | KAT-A-04, KAT-B-04, `test/nonce.test.mjs` <!-- source: scripts/attack-catalog/cases/category_4.mjs --> |
| **05. Authorization Hijack** | Calling owner or guardian methods (`tighten`, `loosen`, `withdraw`, `revoke`) as agent or stranger | Explicit caller authentication via `predecessor_account_id` and `#[private]` internal callbacks | KAT-A-05, KAT-B-05, `role_matrix_allowed_and_denied` <!-- source: contracts/scrip/src/tests.rs --> |
| **06. Access Key Abuse** | Presenting FullAccess keys, foreign receiver keys, or zero gas allowance | Facilitator pre-flight RPC access key inspection rejecting non-FunctionCall keys | KAT-B-06, KAT-E-06, `keycheck.mjs:10-22` <!-- source: facilitator/src/keycheck.mjs --> |
| **07. Parallel Burst** | Flooding concurrent payment requests to race past cumulative budget | Atomic upfront reservation (`reserved += amount`) before token transfer dispatch | `results/attack.json` (30 parallel txs), `f5_twenty_parallel_requests_never_exceed_budget` <!-- source: results/attack.json, contracts/scrip/tests/integration.rs --> |
| **08. Payload Tampering** | Manipulating serialized Borsh bytes or submitting payloads larger than 16 KB | Facilitator 16 KB payload cap and 64-position bit-flip testing on signature and delegate | KAT-B-08, KAT-C-08, `F9b Step 2` bit-flip property tests <!-- source: facilitator/test/f9b.test.mjs --> |
| **09. Upstream RPC Failures** | Handling lagging, hanging, or falsified RPC block height responses | Strict timeouts on all RPC calls and non-negative integer block height validation | KAT-B-09, `N3-M2` timeout tests <!-- source: facilitator/test/relay.test.mjs --> |
| **10. State Machine Violations** | Double revocation, premature stale claim (< 200 blocks), or withdrawing before revoke | Strict status checks (`Active` to `Revoked` only) and `STALE_BLOCKS` time lock | KAT-A-10, `f11_withdraw_before_revocation_fails_then_free_remainder_only` <!-- source: contracts/scrip/src/attack_tests2.rs --> |
| **11. Token Callbacks & Reentrancy** | Untrusted tokens failing to transfer, returning invalid amounts, or reentering | NEP-141 standard compliance check, transfer receipt verification, gas refund on failure | KAT-A-11, `f6_unregistered_receiver_transfers_fail_and_callback_refunds` <!-- source: contracts/scrip/tests/integration.rs --> |
| **12. Boundary Fuzzing** | Spoofing HTTP headers (`X-Forwarded-For`), path traversal, and invalid verbs | Strict last-hop IP extraction, rigid route matching, fail-closed rate limiters | KAT-B-12, `d2_spoof.mjs` (16 header spoofing cases passing) <!-- source: scripts/attack-catalog/cases/d2_spoof.mjs --> |

## Guardian approvals

Payments below `approval_threshold` settle automatically. Payments at or above the threshold require an explicit cryptographic approval from the guardian account.

```
 [Guardian] ──signs intent hash──> [Approval Hash] ──recorded on-chain──> [Payment Unlocked]
```

1. **Deterministic intent hashing:** The approval is bound to an exact intent hash computed from domain-separated parameters:
   ```
   intent_hash = sha256("scrip/v1" || mandate_id || nonce || recipient || amount || expires_at)
   ```
2. **On-chain recording:** The guardian calls `approve_intent(mandate_id, intent_hash, expires_at)`. The contract validates caller identity, verifies the expiration timestamp is in the future, and stores the hash in `approvals`.
3. **Single-use consumption:** When the agent calls `request_payment`, the contract verifies the approval exists and is unconsumed, then marks it used. An approval cannot be replayed.
4. **Expiry coupling:** Approvals cannot outlive the mandate. If the owner tightens mandate expiry to an earlier time, any pending approval with a later expiry is automatically invalidated.

## Sub-account envelopes

NEAR supports hierarchical sub-accounts (e.g. `task-12.funder.testnet`). Scrip uses ephemeral sub-accounts to isolate agent operations:

```
 [Funder Account]
    │
    ├── 1. Creates ephemeral sub-account: task-12.funder.testnet
    ├── 2. Deploys scrip.wasm and initializes mandate with exact budget
    ├── 3. Agent operates with restricted FunctionCall key and gasless relayer
    ├── 4. Funder calls revoke_mandate and withdraws unspent balance
    └── 5. Funder deletes sub-account -> sweeps storage staking NEAR back to parent
```

- **Blast radius containment:** Each task runs in its own contract instance. Compromise of one task cannot affect funds or permissions of another.
- **Clean exit:** After mandate revocation and withdrawal, deleting the sub-account sweeps remaining NEAR storage deposits back to the parent account. Recorded runs confirm zero leftover accounts (`leftoverAccounts: []`).

## Client-side signing guards

Before an agent signs a payment delegate or transaction, the client SDK runs an offline pre-flight evaluation across four risk signals:

```
 [Payment Request]
        │
        ▼
 [Signing Guard Pre-Flight]
   ├── 1. Account age & activity (RPC / indexer history)
   ├── 2. Contract code hash (detects bytecode modification)
   ├── 3. Prior interaction count (flags unseen counterparties)
   └── 4. Evidenced blocklist (requires txHash or https URL proof)
        │
        ├── allow ──> Signs delegate automatically
        ├── warn  ──> Requests human confirmation (askHuman)
        └── block ──> Halts execution immediately (GuardBlockedError)
```

- **Fail-closed:** If indexers or RPC nodes are unreachable, signals fail closed to `warn`.
- **No silent signing on block:** A `block` verdict throws immediately and never requests human override.
- **Evidence standard:** Blocklist entries without verifiable proof (e.g. unevidenced text notes) are demoted to `warn` rather than allowing unverified censorship.

## Measured on testnet

Claims are backed by deterministic test suites, offline attack catalogs, and execution artifacts on NEAR Testnet:

### 1. Test Suite & Catalog Matrix

| Component / Layer | Scope / Description | Verified Count | Result |
|---|---|---|---|
| **Layer A (Contract)** | Smart contract unit and invariant tests (`property_tests.rs`, `tests.rs`, `attack_tests*.rs`) | 627 cases across 12 categories | **627 PASS**, 0 FAIL, 0 BREACH* <!-- source: contracts/scrip/src/attack_tests*.rs --> |
| **Layer B (Facilitator)** | HTTP relayer policy, key validation, rate limits (`b2_extra.mjs`) | 385 cases | **385 PASS**, 0 FAIL, 0 BREACH* <!-- source: scripts/attack-catalog/cases/b2_extra.mjs --> |
| **Layer C (Client)** | Payload formatting, canonical hashing, counterparty guards (`c2_extra.mjs`) | 317 cases | **317 PASS**, 0 FAIL, 0 BREACH* <!-- source: scripts/attack-catalog/cases/c2_extra.mjs --> |
| **Layer D (Sandbox)** | near-workspaces integration against release wasm and mock NEP-141 | 160 cases | **160 PASS**, 0 FAIL, 0 BREACH* <!-- source: results/layer-d.json --> |
| **Layer E (Testnet Waves)** | Live testnet attack catalog via facilitator and testnet RPC | 510 cases in 9 waves (8 x 60, 1 x 30) | **W1: 41 PASS, 19 SKIPPED; W2: 39 PASS, 21 SKIPPED; W3: 37 PASS, 23 SKIPPED; W4: 58 PASS, 2 SKIPPED; W5: 50 PASS, 10 SKIPPED; W6: 58 PASS, 2 SKIPPED; W7: 44 PASS, 16 SKIPPED; W8: 49 PASS, 11 SKIPPED; W9: 29 PASS, 1 SKIPPED** (405 PASS, 105 SKIPPED); 0 FAIL, 0 BREACH <!-- source: results/attack-catalog.json -->  |
| **Prompt Injection Demo** | Deterministic scripted agent vs naive direct wallet under injection | 3 invoices (honest, injected, overcharge) | Naive paid 0.8 USDC to attacker; Scrip rejected attack (`RECIPIENT_NOT_ALLOWED`), attacker got 0 <!-- source: results/demo.json --> |
| **Parallel Burst Attack** | 30 concurrent payments of 0.1 USDC against 1.0 USDC budget | 30 parallel requests | Naive overspent by 0.4 USDC (1.4 USDC paid); Scrip paid exactly 1.0 USDC (0 overspend) <!-- source: results/attack.json --> |
| **End-to-End Gate** | 2 valid payments, 5 attacks refused, over-budget refused, clean exit | Full lifecycle | 2 payments settled (1.0 USDC total); 5 attacks rejected on-chain and at relayer; remainder withdrawn; 0 leftover accounts <!-- source: results/gate.json --> |

*\*0 breach claim is strictly bounded to the cataloged attacks tested, not a mathematical proof of total security.*

> **Layer D Classification Note:** The release contract wasm is compiled with `strip = true` and `opt-level = "z"`. Internal panics from `near-sdk` (such as non-payable method guards and JSON deserialization errors) trigger a WebAssembly unreachable trap without emitting utf8 panic strings. In Layer D, these are classified as `DESERIALIZATION` (5 cases: malformed JSON) and `METHOD_NOT_PAYABLE` (3 cases: non-payable methods receiving attached deposit) based on call arguments, with state invariance verified post-execution. <!-- source: results/layer-d.json -->

> **Layer E Skipped Note:** Cases marked `SKIPPED` in Layer E are not passes. Most are public testnet RPC outages (HTTP 502 or 429 rate limits) that a rerun can fix; a smaller set (21 in the latest run) are structurally unreachable from outside the contract on a live testnet (for example a Pending state that exists for 1-2 blocks, the 512-approval cap, or a zero amount the token rejects before the contract) and are covered by sandbox or contract tests instead. Full details are indexed in [JUDGES.md](JUDGES.md).

### 2. Mutation Testing Scores

Contract (cargo-mutants, `contracts/scrip/src/lib.rs`): **99.4%** caught (175 of 176 mutants), full report and the one survivor in [`contracts/scrip/MUTATION.md`](contracts/scrip/MUTATION.md).

Client and facilitator (Stryker) against test suites:
- **`client/src/counterparty.mjs`:** **93.55%** mutation score (492 killed, 1 timeout, 34 survived) <!-- source: results/mutation-scores.md:2 -->
- **`client/src/guarded-sign.mjs`:** **87.70%** mutation score (107 killed, 15 survived) <!-- source: results/mutation-scores.md:3 -->
- **`facilitator/src/validate.mjs`:** **86.83%** mutation score (677 killed, 22 timeout, 106 survived) <!-- source: results/mutation-scores.md:4 -->

### 3. Verified On-Chain Transaction Hashes

All recorded transactions exist on NEAR Testnet and can be inspected via explorer:

| Scenario / Action | Transaction Hash | Outcome |
|---|---|---|
| **Demo: Deploy Contract** | [`Ap3xT6w2…EWY`](https://testnet.nearblocks.io/txns/Ap3xT6w2RimLu1UkcdsjeBTKpDXgX9Pxr6SmnbreTEWY) | Initial vault contract deployment <!-- source: results/demo.json:82 --> |
| **Demo: Init Vault** | [`BqX68QF2…e6F`](https://testnet.nearblocks.io/txns/BqX68QF2vy6bU4kgoNp9rLW5suMQFGaWZEWqsnKwde6F) | Initialized vault contract <!-- source: results/demo.json:83 --> |
| **Demo: Create Mandate** | [`8LdGAcrn…A5tG`](https://testnet.nearblocks.io/txns/8LdGAcrnFs3kyjW7Eqhyj34gw4ebdyUcBaqgaaqcA5tG) | Mandate created for agent <!-- source: results/demo.json:84 --> |
| **Demo: Fund Mandate** | [`Ap31U5Fq…AX2C`](https://testnet.nearblocks.io/txns/Ap31U5FqjqB9HFjCM2te971GMQJuP7uziuUFxHcAHX2C) | 1.0 USDC deposited into mandate <!-- source: results/demo.json:86 --> |
| **Demo: Honest Payment (0.2 USDC)** | [`9UpU5SNw…3k78`](https://testnet.nearblocks.io/txns/9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78) | Settled on-chain <!-- source: results/demo.json:52 --> |
| **Demo: Prompt Injection Attack** | [`4dAYztmo…PHL5`](https://testnet.nearblocks.io/txns/4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5) | Rejected on-chain: `RECIPIENT_NOT_ALLOWED` <!-- source: results/demo.json:62 --> |
| **Demo: Overcharge Attack** | [`2y4YMUGc…AQy9`](https://testnet.nearblocks.io/txns/2y4YMUGcxcuqoP1aBw1mFgKtyyLoCR2bv38exo1EAQy9) | Rejected on-chain: `OVER_PER_PAYMENT_CAP` <!-- source: results/demo.json:72 --> |
| **Demo: Naive Injected Payment** | [`7FmibFsa…a4Lv`](https://testnet.nearblocks.io/txns/7FmibFsaMTCzaTDgK2jLviqTuNtKq3shxNomMn1oa4Lv) | Baseline direct wallet drained 0.8 USDC to attacker <!-- source: results/demo.json:25 --> |
| **Demo: Revoke Mandate** | [`6wEuGdEUreWk...`](https://testnet.nearblocks.io/txns/6wEuGdEUreWkhjXorYD6LSrVsPvCnC7NgtSEUwpLUWDL) | Mandate status marked Revoked <!-- source: results/demo.json:87 --> |
| **Demo: Withdraw Remainder** | [`GFAdLY14…aT1S`](https://testnet.nearblocks.io/txns/GFAdLY14WJ4iypuNT5cNgH5mpqNUBdWsYDRSER6raT1S) | 0.8 USDC unspent remainder returned to owner <!-- source: results/demo.json:88 --> |
| **Gate: Valid Payment 1 (0.5 USDC)** | [`HLaUwwti…SZ4kH`](https://testnet.nearblocks.io/txns/HLaUwwtihuG1zUpABeA1Xgo3tAseFBrAukWbGaxSZ4kH) | Settled on-chain <!-- source: results/gate.json:72 --> |
| **Gate: Refused Recipient Attack** | [`BvbcY9CV…uEZY`](https://testnet.nearblocks.io/txns/BvbcY9CVG8ubdUhF9aeAhHvz8za81b1beGWZQuaZuEZY) | Rejected on-chain: `RECIPIENT_NOT_ALLOWED` <!-- source: results/gate.json:23 --> |
| **Gate: Refused Cap Attack** | [`B6nZaNQv…RQQp`](https://testnet.nearblocks.io/txns/B6nZaNQvnLFXCxmCFSmhP32oB3TZ1BcUMXxorvRZrQQp) | Rejected on-chain: `OVER_PER_PAYMENT_CAP` <!-- source: results/gate.json:30 --> |
| **Gate: Valid Payment 2 (0.5 USDC)** | hash truncated in the recorded log, not independently checkable | Settled on-chain (spent reaches 1.0 USDC) <!-- source: results/gate.json:90 --> |
| **Gate: Refused Budget Attack** | hash truncated in the recorded log, not independently checkable | Rejected on-chain: `OVER_BUDGET` <!-- source: results/gate.json:91 --> |
| **Gate: Revoke Mandate** | [`ELpjaqsT…GP9FS`](https://testnet.nearblocks.io/txns/ELpjaqsTgkTtVgsrVKGA1SQaSc1izfBJBv5LNURGP9FS) | Mandate status marked Revoked <!-- source: results/gate.json:73 --> |
| **Gate: Withdraw Remainder** | [`EhFQpi33…ybvn`](https://testnet.nearblocks.io/txns/EhFQpi33PnqGZA65C1z5t2Jjcf8Z7Pxo9m1VPuvaybvn) | 0.25 USDC returned; contract USDC balance reaches 0 <!-- source: results/gate.json:74 --> |

## Limits, stated plainly

1. **What is trustless:**
   - Mandate enforcement: limits (budget ceiling, per-payment cap, approval threshold, recipient allowlist, expiration) are enforced by on-chain smart contract code. No off-chain participant or prompt manipulation can bypass them.
   - Race condition prevention: even under extreme parallel burst requests, the contract's atomic upfront reservation ensures total payments cannot exceed the allocated budget.
   - Agent confinement: agents provisioned with `FunctionCall` access keys cannot transfer native NEAR, cannot alter contract rules, and cannot register or delete account keys.
   - Owner custody recovery: the owner can revoke a mandate at any time and withdraw unspent funds.

2. **What is not trustless:**
   - Relayer liveness: the facilitator relayer sponsors NEAR gas fees and submits transactions to the network. If the relayer is offline or censors an agent, transactions stall (mitigation: owners can configure alternative relayers or submit directly).
   - External indexer reliance: counterparty risk guards rely on FastNEAR RPC and indexers to query account age and transaction counts. If indexers are unreachable or compromised, the guard fails closed (defaults to `warn`).
   - Local client state: contract code pins and interaction counters are stored in local JSON files per client instance, not across a decentralized gossip network.
   - Pooled contract token balance: in a multi-tenant deployment, multiple mandates share the same NEP-141 token pool on the contract. Isolation relies on the contract's internal accounting ledger (mitigation: deploy one contract instance per tenant via sub-account envelopes).
   - Callback latency: if an external token transfer callback stalls, unlocking the reserved balance requires the guardian key to invoke `resolve_stale` after `STALE_BLOCKS` (approx. 200 blocks).

3. **What has not been proven:**
   - Formal verification: invariants (P1 through P10) have been verified with property-based testing (`proptest`), mutation testing, and sandbox execution, but have not been subjected to machine-checked mathematical proof (e.g. Coq or TLA+).
   - Independent security audit: the codebase underwent two internal fresh-context audit passes (AUDIT_1, AUDIT_2) and mutation testing, but has not received a formal review from an external commercial auditing firm.
   - Mainnet operation: all testing was conducted exclusively on NEAR Testnet (`testnet`). No mainnet contracts are deployed.
   - Deterministic agent demo scope: the demo agent (`demo/agent.mjs`) is a deterministic scripted test harness, not a live LLM. It intentionally obeys prompt injections 100% of the time to demonstrate that on-chain smart contract rules hold when an agent is compromised.
   - Comprehensive security guarantee: these differentiators, test suites, and attack catalog results do not constitute proof of comprehensive or universal security. They establish resilience strictly against the cataloged threat vectors tested under stated assumptions.

## What NEAR makes possible here

- **Native Function-Call Access Keys:** NEAR accounts can provision keys restricted to invoke a single contract method (`request_payment`) with a designated gas allowance and zero yoctoNEAR attached deposit permission. The agent physically cannot call native transfer methods, register new access keys, or call foreign smart contracts.
- **NEP-366 Delegate Actions (Meta-Transactions):** Agents sign standard `DelegateAction` structures off-chain. The facilitator relayer verifies the signature, wraps it in a transaction, and pays the network gas fee. The agent requires zero NEAR native tokens to operate.
- **Hierarchical Accounts and Disposable Envelopes:** NEAR supports creating sub-accounts (such as `task-12.funder.testnet`). Scrip creates dedicated sub-accounts for specific agent tasks, funds them with exact budgets, and deletes them upon task completion. All remaining storage deposits are refunded back to the parent account.
- **Asynchronous Cross-Contract Callbacks:** NEAR executes cross-contract calls asynchronously via receipts and execution outcomes. Scrip implements two-phase reservations: funds are locked in `reserved` during phase 1 before calling `ft_transfer`. When `on_payment_done` executes in phase 2, it inspects the promise outcome to confirm settlement or immediately release the reservation upon transfer failure.

## Repository

| Directory | Purpose and Responsibility |
|---|---|
| `client/` | TypeScript/JavaScript SDK: intent hashing, NEP-366 delegate signing, x402 payment header parser, and client-side counterparty risk guard. |
| `contracts/scrip/` | Rust smart contract crate (`scrip`) implementing immutable spending mandates and atomic reservations on NEAR Protocol. |
| `contracts/scrip_naive/` | Negative baseline contract enforcing limits without upfront reservation, proving concurrent race vulnerability. |
| `demo/` | Deterministic prompt injection scenarios, x402-style payment flows, and counterparty guard demo fixtures. |
| `docs/` | System architecture specification, formal security invariants (P1-P10), ADRs, threat models, and numerical verification index. |
| `facilitator/` | Lightweight Node.js relayer service verifying access key permissions, rate-limiting, and sponsoring NEAR gas. |
| `results/` | Recorded execution artifacts for prompt injection comparisons, burst attacks, guard checks, and end-to-end gate runs. |
| `scripts/` | Testnet attack catalog runner, harness, account recovery sweeps, and transaction link verifiers. |
| `tools/` | Independent Python test vector generators for cross-language validation of deterministic intent hashes. |
| `web/` | Web application showcasing interactive demonstrations and mandate management telemetry. |

Build the contract:
```sh
cd contracts/scrip && cargo near build non-reproducible-wasm --no-abi
```

Run test suite:
```sh
make test
```

## Built with

near-sdk 5 and near-contract-standards, near-api-js 7, @noble/curves, Node.js 22, Rust 1.80+, Stryker.

## License

[MIT](LICENSE)
