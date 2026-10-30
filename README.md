# Amanat

**Keys can be stolen. Funds can't.** Capped spending mandates for AI agents on NEAR (testnet only).

An agent holds a function-call access key, not your funds. The key can call exactly one method on the Amanat contract, `request_payment`. The contract enforces the mandate on-chain: recipient allowlist, per-payment cap, cumulative budget, expiry, and guardian approval above a threshold. A hijacked or prompt-injected agent can spend only what the mandate allows.

Payments are relayed as NEP-366 delegate actions by a small facilitator, so the agent needs no NEAR for gas.

Landing page and interactive demos: `web/` (see [Run](#run)). Rules for the visual design: `web/MASTER.md`. Architecture specification and ADRs: `docs/ARCHITECTURE.md`.

---

## Verify in 60 seconds

Clone and run the offline quality gates locally:

```bash
make setup          # installs pinned JS dependencies (needs network once)
make script-test    # unit tests for recovery and RPC link verifier (7 passed)
make static         # contract clippy static analysis on wasm target (0 warnings)
make contract-build # builds release wasm32 binary
make verify-links   # read-only: verifies all 23 recorded testnet txs against public RPC (needs network)
```

---

## The problem

An agent that pays with a full-access key can be talked into paying anyone. The x402 `exact` scheme on NEAR needs a full-access key for the payer, because a function-call key cannot attach the 1 yocto deposit; the client-side `spendControls` of `@x402/core` 2.28.0 limit one payment at a time, with no cumulative budget (read in the package source on 28 Oct 2026; the source is not vendored in this repo, so verify before relying on it). Amanat closes that gap before the money arrives, on the contract side. It does not claim to be the first or only such design; see [Comparisons](#comparisons).

---

## How it works

```
Owner --funds--> Vault (Amanat contract) <--request_payment-- Agent (function-call key)
                      |  rules: recipient, per-payment cap, budget, expiry, approval
                      v
                 ft_transfer --> Merchant
Guardian: tighten any time, loosen only within safe bounds, approve large payments, resolve stuck requests
Facilitator: validates the delegate, checks the signing key, pays gas, rate-limits
```

- One contract holds many mandates. Each mandate has an owner, one agent, one guardian, a token, a budget, a per-payment cap, an approval threshold, a recipient list and an expiry.
- `request_payment` reserves the amount before the token transfer and settles in a callback, so parallel requests cannot pass the budget.
- Large payments need a guardian approval bound to the exact intent hash (mandate id, recipient, amount, nonce, mandate expiry).
- The owner can revoke and withdraw the unspent remainder. This path skips the rules by design: the money is the owner's.
- Contract methods and rejection codes: `contracts/amanat/README.md`.

---

## Claims, Evidence, and Reproduction

Every claim in this repository traces back to concrete evidence in `results/` and reproducible commands:

| Claim | Evidence / Artifact | How to Reproduce |
|---|---|---|
| Injected agent cannot drain vault balance | `results/demo.json`, NearBlocks tx [`4dAYzt…PHL5`](https://testnet.nearblocks.io/txns/4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5) rejected with `RECIPIENT_NOT_ALLOWED` | `node --test demo/test/` |
| Overcharge attempts exceeding payment cap fail | `results/demo.json`, NearBlocks tx [`2y4YMU…AQy9`](https://testnet.nearblocks.io/txns/2y4YMUGcxcuqoP1aBw1mFgKtyyLoCR2bv38exo1EAQy9) rejected with `OVER_PER_PAYMENT_CAP` | `node --test demo/test/` |
| Parallel burst attacks cannot exceed budget | `results/attack.json`: Amanat strictly capped at 1.0 USDC, whereas naive baseline leaked 1.4 USDC | Compare `contracts/amanat/src/lib.rs` reservation vs `contracts/amanat_naive/src/lib.rs`; `cd contracts/amanat && cargo test --lib` |
| End-to-end gate cleans up all temporary accounts | `results/gate.json`: 2 valid payments settled, 5 attack vectors refused, remainder withdrawn, 0 orphaned sub-accounts | `make verify-links` (verifies all tx hashes in `results/` on chain: 32 of 32 on 30 Oct) |
| Contract compiles to clean Wasm with zero Clippy warnings | `contracts/amanat/target/wasm32-unknown-unknown/release/amanat.wasm` | `make static && make contract-build` |
| Safe orphan account recovery without secret disclosure | `scripts/recover.mjs`, `scripts/test/recover.test.mjs` | `make script-test` |
| CI automation runs offline verification on every pull request | `.github/workflows/ci.yml` | `make ci` (runs test, static, contract-build) |

---

## Results (real testnet runs, files in `results/`)

| Run | Baseline without Amanat | Amanat |
|---|---|---|
| 30 pre-signed payments of 0.1 USDC in about 10 s, budget 1.0 (`attack.json`) | naive contract (same rules, no upfront reservation) paid 1.4 USDC, 0.4 over budget | paid exactly 1.0 USDC, `reserved` 0 |
| Prompt-injection demo, 1.0 USDC funded; both agents first pay an honest 0.2 invoice (`demo.json`) | agent with a full-access key paid 0.8 USDC to the attacker ([`7FmibF…a4Lv`](https://testnet.nearblocks.io/txns/7FmibFsaMTCzaTDgK2jLviqTuNtKq3shxNomMn1oa4Lv)) | injected payment rejected `RECIPIENT_NOT_ALLOWED` ([`4dAYzt…PHL5`](https://testnet.nearblocks.io/txns/4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5)); overcharge rejected `OVER_PER_PAYMENT_CAP` ([`2y4YMU…AQy9`](https://testnet.nearblocks.io/txns/2y4YMUGcxcuqoP1aBw1mFgKtyyLoCR2bv38exo1EAQy9)); attacker got 0; remainder withdrawn |
| End-to-end gate (`gate.json`) | n/a | two legitimate 0.5 USDC payments settled ([`HLaUww…Z4kH`](https://testnet.nearblocks.io/txns/HLaUwwtihuG1zUpABeA1Xgo3tAseFBrAukWbGaxSZ4kH)); five attacks refused (below); a third payment past the budget refused (`OVER_BUDGET`); revoke ([`ELpjaq…P9FS`](https://testnet.nearblocks.io/txns/ELpjaqsTgkTtVgsrVKGA1SQaSc1izfBJBv5LNURGP9FS)) and withdraw ([`EhFQpi…ybvn`](https://testnet.nearblocks.io/txns/EhFQpi33PnqGZA65C1z5t2Jjcf8Z7Pxo9m1VPuvaybvn)); all accounts deleted |

Gate attacks and where each was stopped:

| Attack | Stopped by | Code |
|---|---|---|
| recipient outside the list ([`7xpa79…QZv5`](https://testnet.nearblocks.io/txns/7xpa79ixi7C3vnmC6hesZLz6KbwNj8VPQjpR33tZQZv5)) | contract | `RECIPIENT_NOT_ALLOWED` |
| amount over the per-payment cap ([`C1u2JX…rvK9`](https://testnet.nearblocks.io/txns/C1u2JX5kiWVkD3fQhrjmrX7sjgiRjV1hemycHUnzrvK9)) | contract | `OVER_PER_PAYMENT_CAP` |
| agent calls a guardian method through the relay | facilitator | `METHOD_NOT_ALLOWED` |
| gas too low to finish | facilitator | `GAS_TOO_LOW` |
| random key posing as the agent | facilitator | `KEY_NOT_ALLOWED` |

Deploy [`7VjVW5…NPWs`](https://testnet.nearblocks.io/txns/7VjVW5u2zyvBvELD4NWu5Yu7bE9VEQuVNm3QJpZPNPWs), mandate [`mVxMUi…rQwL`](https://testnet.nearblocks.io/txns/mVxMUic3VNtfKjHCv5HajjGcpPDGtrvRLBwVVsprQwL), funding [`DKbL7y…7G16`](https://testnet.nearblocks.io/txns/DKbL7y52y4gTSFawiXFkyEGQQTofvFNV8EoUC65d7G16).

Notes on these numbers:
- The demo agent is a deterministic script, not an LLM. It shows contract enforcement, not model robustness.
- The parallel burst takes about 10 s because broadcast is sequential, so the naive overshoot is moderate.
- `attack.json` was recorded before the audit fixes below; `demo.json` after the first round of contract fixes but before the second round of facilitator hardening; `gate.json` was re-run on 30 Oct after both and after the v1.3 contract and facilitator changes (the previous run is kept as `gate.prev-before-v13.json`). Every run deletes its accounts and the funder's USDC balance is unchanged.

---

## x402-Style (Not Standard x402)

Amanat intentionally implements an **x402-style** architecture rather than the standard x402 `exact` scheme:

1. **Why standard x402 exact fails agent containment:** The standard x402 specification for NEAR ([`scheme_exact_near.md`](https://github.com/x402-foundation/x402/blob/2aa22d3e6a38547a8232737599d9f519c9ac5533/specs/schemes/exact/scheme_exact_near.md)) requires the payer to sign a direct `ft_transfer` transaction with an attached deposit of 1 yoctoNEAR. The specification explicitly dictates that facilitators must reject FunctionCall keys because "they cannot attach a deposit." Consequently, standard x402 forces the payer to hold a **Full-Access key**. If an AI agent holds a full-access key, prompt injection or key compromise gives the attacker the power to transfer all tokens or delete the account.
2. **The Amanat x402-style solution:** Amanat uses a `FunctionCall` access key bound strictly to `request_payment` on the Amanat vault contract. The agent signs an NEP-366 `DelegateAction` that is relayed by an authorized facilitator (which sponsors the NEAR gas). The merchant presents an HTTP 402 with invoice requirements (`payTo`, `amount`, `mandate`, `asset`), the agent provides a `PAYMENT-SIGNATURE` header containing the signed delegate, and the facilitator settles via `/settle` and validates via `/verify`.
3. **Compatibility note:** Standard x402 client packages (such as `@x402/core` or `@x402/fetch`) cannot directly pay Amanat merchants without using Amanat's client adapter (`client/`). We declare this plainly: Amanat prioritizes true cryptographic containment over standard compatibility. See ADR-001 in `docs/ARCHITECTURE.md`.

---

## Run

```bash
make setup           # npm ci for client, facilitator, scripts (needs network once)
make test            # offline tests: client (82), facilitator (96), demo (29), scripts (7), contract (112 + 2 ignored)
make contract-it     # sandbox integration, 20 tests, needs network (about 5 minutes)
cd web && bun install && bun run dev   # landing page on :3000
```

Actual test suite status during Wave 1 execution:
- **Client library:** 82 passed (`cd client && node --test test/`)
- **Facilitator service:** 96 passed (`cd facilitator && node --test test/`)
- **Merchant/Agent demo:** 29 passed (`node --test demo/test/`)
- **Scripts (recovery & link verifier):** 7 passed (`make script-test`)
- **Contract unit tests:** 112 passed, 2 ignored on purpose (known limit N-L5: a token that returns more than 1024 bytes from `ft_transfer`; see `contracts/amanat/AUDIT_3.md`)
- **Contract sandbox integration:** 19 tests passed (the 20th, the 40-way mixed race, was added after that full run and passed on its own) (`make contract-it`)
- **On-chain link verification:** 23/23 transaction hashes verified on public testnet RPC (`make verify-links`)

Testnet scripts (`scripts/gate.mjs`, `attack.mjs`, `demo.mjs`) need funder and relayer key files passed by environment variable; keys are never printed or committed.

---

## Threat model and acknowledged limits

| Threat | Handled by | Remaining risk |
|---|---|---|
| Injected agent asks to pay an attacker | Recipient allowlist enforced on-chain | An allowed merchant can still be abused within its cap |
| Agent key leaks | Key can only call `request_payment`; contract mandate rules apply | Attacker can spend the budget on allowed recipients only |
| Parallel requests pass the limit | Two-phase atomic reservation (`reserved` tracked before transfer) | A failed callback holds budget until `resolve_stale` clears it |
| Merchant overcharges | Per-payment cap + guardian approval above threshold | A legitimate merchant can charge up to the cap; a threshold can be split into smaller payments (budget still holds) |
| Guardian compromised | Not handled on-chain | A guardian can add recipients, raise the budget up to the deposit, approve large payments, or revoke for good; keep guardian keys separate |
| Owner compromised or malicious | Not handled on-chain | The owner can revoke and withdraw remaining deposited funds; this is by design (owner custody) |
| Relayer flooded with rejected requests | Facilitator rate limits (IP & agent), key check, replay dedupe | The relayer still pays gas for requests the contract rejects on-chain |
| Contract bug | Unit and sandbox tests, static analysis (`make static`), property tests | No external third-party audit, no formal verification proof |
| Shared token pool across mandates (K-3) | Contract isolates mandate limits via internal bookkeeping (`spent`, `reserved`, `budget`); transfers only succeed if contract balance covers them | An un-sandboxed or malicious token contract, or catastrophic callback stalling, could affect shared token balance. Mitigation: deploy one Amanat contract per tenant/owner. |

Known limits:
- **K-3 (Pooled token balance):** A single Amanat contract deployment pools all deposited tokens of the same NEP-141 asset across all its mandates. While mandate bookkeeping is strictly isolated (`spent + reserved <= budget`), the contract trusts the underlying NEP-141 token contract to honor transfers. If one tenant's callback were permanently stuck or a token behaved maliciously, other mandates could experience delayed liquidity. The primary mitigation is architectural: deploy one independent Amanat contract per owner/tenant.
- **Contract Immutability (K-E):** The smart contract has no `migrate` method and no upgrade authority. On testnet deployment, the contract's full-access key is deleted after initialization (`init`). See ADR-002 in `docs/ARCHITECTURE.md`.
- **Withdraw callback failure:** If the callback of a `withdraw` fails, `withdrawn` stays raised with no recovery path (audit F5).
- **Non-standard token transfer results:** An `ft_transfer` result over 1024 bytes counts as failed, which can release funds for non-standard tokens (N-L5).
- **Stuck pending requests:** Recovering a stuck pending request requires the guardian's key to call `resolve_stale` after `STALE_TIMEOUT_BLOCKS` (N-I4).
- **Approval retention:** Approvals are never deleted after use, though replay is prevented by an internal bit/used check. See `contracts/amanat/AUDIT_1.md`, `AUDIT_2.md`, `IT_REPORT.md`.

---

## What does not exist yet

- Third-party audit or formal verification.
- Standard x402 `exact` flow (this design uses a function-call key and delegate actions instead).
- Mainnet. Testnet only; no mainnet keys or accounts were used.
- An LLM agent in the demo (the demo agent uses deterministic injection triggers).
- Facilitator hardening beyond `facilitator/README.md` (limits listed there).

---

## Comparisons

- OutLayer: a wallet policy engine for agents on NEAR; described in its own docs as a policy engine whose cumulative limits are best-effort under parallel requests and whose gateway must be trusted; I have not verified this independently, so check its docs before relying on the comparison.
- StableSettle, allowance.eth: EVM designs for agent spending limits.
- Subfloor: the pattern reference for this contract's style, not a competitor.
- Mandate and Clearance: other entries in this track, to be compared after 1 Nov.

---

## Built before vs during the hackathon

Declared plainly: the envelope idea (a disposable sub-account paying through x402) and its spike scripts existed before; the Amanat contract, facilitator, client, demo, audits and landing page were written on 28-29 Oct 2026 and after, before the official coding window opens on 1 Nov. The repository has no commit history yet; the first commit is planned for 1 Nov, so timing claims rest on the dates inside `results/`.

---

## Layout

| Folder | What |
|---|---|
| `contracts/amanat` | Rust contract (near-sdk 5.30.0) with unit and sandbox tests, audits |
| `contracts/amanat_naive` | negative control: enforces the same mandate rules but without the upfront reservation before the transfer |
| `facilitator/` | relayer for NEP-366 delegate actions |
| `client/` | intent hash, delegate builder, relay response classifier |
| `demo/`, `scripts/` | merchant and agent demo, e2e gate, parallel attack, recovery & link verifiers |
| `docs/` | Architecture specification (`docs/ARCHITECTURE.md`), PRD, video scripts |
| `web/` | landing page (Next.js) with live rule machine and the real results |
| `results/` | testnet output only, never hand-written |

---

## License

MIT (see [`LICENSE`](LICENSE)).
