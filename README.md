# Scrip

> Disposable spending envelopes and cryptographically enforced mandates for autonomous AI agents on NEAR Protocol.

> **Status:** work in progress during the NEAR Hackathon window. The project was renamed from *Amanat* to **Scrip** on 2 Nov 2026 (crate `scrip`, folders `contracts/scrip`, `contracts/scrip_naive`). Recorded files in `results/` keep the names used when they were produced. Numbers marked TBD are not final.

## Problem & Solution

Autonomous AI agents given direct custody of crypto assets or full-access keys are fundamentally vulnerable to prompt injection, social engineering, and supply-chain compromises: an adversary manipulating the agent's context can instruct it to drain its entire wallet in a single transaction. **Scrip** eliminates this risk by stripping agents of direct custody and full-access permissions, enforcing spending policies entirely on-chain on NEAR Protocol through scoped smart contract mandates: a strict cumulative budget, an immutable recipient allowlist, a per-payment transfer ceiling, guardian approval requirements for high-value transactions, disposable sub-account envelopes that isolate risk per task, client-side counterparty guards that evaluate recipients (allow / warn / block) prior to signing, and structurally restricted `FunctionCall` access keys that cannot send native NEAR or alter account permissions.

## Try It

Reproducible steps executable from a fresh clone:

1. **Install dependencies**
   ```bash
   make setup
   ```
   <!-- source: Makefile:3 -->
   You should see: npm cleanly installs pinned JavaScript dependencies across `client/`, `facilitator/`, and `scripts/`.

2. **Run offline demo test suite**
   ```bash
   make demo-test
   ```
   <!-- source: Makefile:16, demo/README.md:27 -->
   You should see: 29 passing tests in `demo/test/` demonstrating honest payments succeeding, the agent obeying simulated prompt injections, the contract rejecting unauthorized recipients and overcharges, and x402-style settlement.

3. **Run client-side counterparty risk guard demo**
   ```bash
   node scripts/demo-guard.mjs --blocklist demo/fixtures/blocklist.json
   ```
   <!-- source: demo/README.md:39, scripts/demo-guard.mjs -->
   *Note: Requires internet access to reach the public NEAR testnet RPC (default `rpc.testnet.fastnear.com`). Read-only; no private keys or testnet tokens required.*
   You should see: 4 sequential evaluation logs printed (`known-merchant` -> `allow`/`signed`, `new-recipient` -> `warn`/`denied`, `injection-block` -> `block`/`blocked` for an evidenced attacker address, `unevidenced-report` -> `warn`/`denied`), concluding with a summary table confirming 0 on-chain transactions sent.

4. **Run scripts and verifier tests**
   ```bash
   make script-test
   ```
   <!-- source: Makefile:30, scripts/test/ -->
   You should see: 28 passing tests in `scripts/test/` validating argument parsing, recovery sweeps, and transaction link extraction.

5. **Verify on-chain testnet transaction links**
   ```bash
   make verify-links
   ```
   <!-- source: Makefile:44, scripts/verify-links.mjs -->
   *Note: Read-only; checks recorded transaction hashes against public testnet RPC.*
   You should see: all recorded transaction hashes from `results/` queried and validated against testnet RPC.

6. **Execute full testnet demo (optional, live testnet)**
   ```bash
   node scripts/demo.mjs
   ```
   <!-- source: demo/README.md:29, scripts/demo.mjs -->
   *Note: Requires testnet credentials in environment variables (`FUNDER_KEY_FILE`, `FUNDER_ACCOUNT_ID`, `RELAYER_KEY_FILE`, `RELAYER_ACCOUNT_ID`) with >= 2.0 testnet USDC and NEAR for gas.*
   You should see: automated contract deployment, creation of a 1.0 USDC mandate, an honest 0.2 USDC payment settled, a prompt-injected 0.8 USDC payment rejected on-chain with `RECIPIENT_NOT_ALLOWED`, an overcharge rejected with `OVER_PER_PAYMENT_CAP`, unspent funds returned via `revoke` and `withdraw`, and complete deletion of ephemeral sub-accounts (`leftoverAccounts: []`).

## How It Works

```
[Agent] (FunctionCall Key)
   │  1. Signs NEP-366 DelegateAction (request_payment)
   ▼
[Facilitator] (Relayer Service)
   │  2. Validates key permission, rate limits, checks nonces, pays gas
   ▼
[Scrip Contract Vault] (NEAR Smart Contract)
   │  3. Atomically verifies: recipient in allowlist, amount <= cap, spent+reserved <= budget
   │  4. Places atomic reservation (`reserved += amount`)
   ▼
[NEP-141 Token] ──5. ft_transfer──> [Merchant]
   │
   └──6. Callback: settled (`spent += amount`) or refunded (`reserved -= amount`)
```

### Function-Call Access Key Boundaries
The agent is provisioned solely with a NEAR `FunctionCall` access key bound to `request_payment` on the Scrip vault contract:
- **Cannot send native NEAR:** The key structure prevents attaching non-zero yoctoNEAR deposits.
- **Cannot add or delete keys:** Restricted keys have zero administrative authority over the account.
- **Lockout risk:** The key has a finite gas allowance; if exhausted, the agent is locked out until the owner replenishes the allowance.
- **No external calls:** The key cannot invoke arbitrary smart contracts or change mandate rules (`tighten`, `loosen`, and `withdraw` reject the agent).

## Evidence & Concrete Results

Claims in this repository are backed by deterministic test suites and execution artifacts in `results/`:

| Component / Layer | Scope / Description | Result in Files | Status |
|---|---|---|---|
| **Layer A (Contract)** | Smart contract unit & invariant tests (`property_tests.rs`, `tests.rs`) | 627 cases across 12 categories | 0 BREACH* |
| **Layer B (Facilitator)** | HTTP relayer policy, key validation, rate limits (`layer-b.pm.json`) | 385 cases (385 PASS, 0 FAIL) | 0 BREACH* |
| **Layer C (Client)** | Payload formatting, canonical hashing, counterparty guards (`layer-c.pm.json`) | 317 cases (317 PASS, 0 FAIL) | 0 BREACH* |
| **Layer D (Sandbox)** | near-workspaces integration against the real wasm and a mock NEP-141 (`contracts/scrip/tests/integration.rs`) | Extended sandbox catalog is in progress; no results claimed yet | TBD |
| **Layer E (Testnet)** | Live testnet attack catalog (REAL transactions) | In progress. Wave 1 (60 cases): 56 PASS, 4 FAIL, 0 BREACH; the 4 FAILs were wrong expectations in the harness (cases shared one mandate), since fixed. Wave 2 triage is open: it contains one flagged BREACH under investigation | TBD (final run pending) |
| **Prompt Injection Demo** | Deterministic agent vs naive agent under injection (`results/demo.json`) | Naive drained 0.8 USDC; Scrip rejected attack (`RECIPIENT_NOT_ALLOWED`) | Verified on-chain |
| **Parallel Burst Attack** | 30 concurrent payments of 0.1 USDC against 1.0 USDC budget (`results/attack.json`) | Naive contract: merchant received 1.4 USDC against a 1.0 USDC budget (overspent by 0.4); Scrip paid exactly 1.0 USDC | Verified on-chain |
| **End-to-End Gate** | Valid settlements, 5 attacks refused, cleanup (`results/gate.json`) | Valid payments settled; attacks rejected on-chain (`RECIPIENT_NOT_ALLOWED`, `OVER_PER_PAYMENT_CAP`, `OVER_BUDGET`, ...); remainder withdrawn; no leftover accounts | Verified on-chain |

*\*0 breach claim is strictly on the cataloged attacks tested, not a proof of security.*

## Not Built & Limitations

| Limitation | Reality & Context |
|---|---|
| **Deterministic Agent Demo** | The agent (`demo/agent.mjs`) is a deterministic script standing in for an LLM, not a real LLM. It always obeys injections to test contract enforcement, not model robustness. |
| **Testnet Only** | Developed and tested exclusively on NEAR Testnet (`testnet`). No mainnet contract is deployed and mainnet staking is not configured. |
| **External Indexer Dependency** | Counterparty risk signals for account age and transaction count depend on external indexers (`accountHistory`); full node RPCs cannot answer historical queries alone. |
| **Local Pin & History Storage** | Contract code pins (`codePin`) and prior interaction logs are stored locally (`results/guard-demo/`) per client instance, not synchronized via a distributed network. |
| **Shared NEP-141 Balance (K-3)** | All mandates on a single contract deployment share the contract's NEP-141 token pool. Isolation relies on contract bookkeeping. Mitigation: deploy one contract per tenant. |
| **Contract Immutability** | The contract contains no `migrate` function and its full-access key was burnt upon initialization (ADR-002). Upgrades require deploying a new contract and withdrawing funds. |
| **Stuck Callback Dependency** | Clearing an externally stalled token reservation requires the guardian key to invoke `resolve_stale` after `STALE_BLOCKS` (approx. 200 blocks). |
| **No External Third-Party Audit** | The codebase has undergone extensive unit, property, and mutation testing, but has not received a formal review from an independent security audit firm. |

## Repository Structure

- `client/`: Client library for canonical intent hashing, NEP-366 delegate signing, and counterparty risk evaluation.
- `contracts/`: Rust smart contract (`scrip`) implementing immutable spending mandates on NEAR Protocol.
- `demo/`: Deterministic prompt injection scenarios, x402-style payment flows, and counterparty guard demos.
- `docs/`: System architecture specification, formal security invariants (P1-P10), ADRs, and threat models.
- `facilitator/`: Lightweight Node.js relayer sponsoring gas, rate-limiting, and verifying function-call keys.
- `results/`: Recorded JSON execution artifacts for attack burst, prompt injection, guard demo, and gate runs.
- `scripts/`: Testnet orchestration scripts, attack catalog runners, link verifiers, and account recovery utilities.
- `tools/`: Independent Python vector generators for cross-language validation of deterministic intent hashes.
- `web/`: Next.js web application showcasing interactive demonstrations and mandate management.

## License

This project is licensed under the MIT License - see the [`LICENSE`](LICENSE) file for details.

## Hackathon Tracks

Submitted to the **NEAR Hackathon 2026**:
- **Track 06: Security** (`security`) - Client-side allow/warn/block signing guards, function-call key isolation, and verifiable prompt injection defenses.
- **Track 07: Agents** (`agents`) - Capped spending policies, budget containment, and gasless delegate execution for autonomous agents.

## Project History

This repository was imported on 2 Nov 2026 from a local working folder. Commits were reconstructed to follow the real work: each file is committed at the time it was last modified (approximate), so intermediate versions are not preserved. Work in this folder started on 28 Oct 2026; earlier exploratory work lives outside this repository.
