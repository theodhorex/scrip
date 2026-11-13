# CORRECTIONS_E_CAT5_10 — expected.code for categories 10 & 5 vs `contracts/scrip/src/lib.rs`

Source of truth: `contracts/scrip/src/lib.rs` (check order of each method) and the code table in
`contracts/scrip/README.md` (lines 60-63, 48). Only `expected.code` was changed; labels were
never changed. All rows below are labeled `BLOCKED` both before and after the correction.

## Corrections

| case | old code | new code | evidence (lib.rs line) | label unchanged |
| --- | --- | --- | --- | --- |
| KAT-E-10-03 double revoke | `NOT_ACTIVE` | `ALREADY_REVOKED` | 747: `require(status == Active, err::ALREADY_REVOKED)` in `revoke` | yes (BLOCKED) |
| KAT-E-10-08 withdraw exceeding free | `INSUFFICIENT_FREE_BALANCE` | `AMOUNT_EXCEEDS_FREE` | 770: `require(amount <= free, err::AMOUNT_EXCEEDS_FREE)` | yes (BLOCKED) |
| KAT-E-10-21 resolve_stale not yet stale | `REQUEST_NOT_STALE` | `NOT_STALE_YET` | 825: `require(block_height - p.height >= STALE_BLOCKS, err::NOT_STALE_YET)` | yes (BLOCKED) |
| KAT-E-05-15 tighten by agent | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660: `require(caller == owner \|\| guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN)` | yes (BLOCKED) |
| KAT-E-05-16 tighten by stranger | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660 (same) | yes (BLOCKED) |
| KAT-E-05-19 revoke by agent | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 746: `require(caller == owner \|\| guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN)` | yes (BLOCKED) |
| KAT-E-05-20 revoke by stranger | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 746 (same) | yes (BLOCKED) |
| KAT-E-05-69, -72, -74, -76, -77, -78, -84, -97 (seed tighten) | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660 (same) | yes (BLOCKED) |

Total cases changed: **15** (3 category 10 + 12 category 5).

## Not changed — contract code already matches

All other cases in both files already match the lib.rs check order, including:
`NOT_ACTIVE` (507-508, 632, 661, 705), `MANDATE_STILL_ACTIVE` (766), `INSUFFICIENT_GAS` (497, 763),
`NOT_STRICTER`/`NOT_LOOSER` (666/672/677/680/688, 709/714/719/731/733), `BUDGET_BELOW_CAP` (668),
`CAP_BELOW_THRESHOLD` (673), `NO_SUCH_RECIPIENT` (682), `EXPIRY_NOT_IN_FUTURE` (689),
`BUDGET_ABOVE_DEPOSITED` (710), `CAP_ABOVE_BUDGET` (715), `THRESHOLD_ABOVE_CAP` (720),
`DUPLICATE_RECIPIENT` (725), `TOO_MANY_RECIPIENTS` (727), `UNAUTHORIZED_AGENT` (505),
`UNAUTHORIZED_GUARDIAN` (631, 704, 820), `UNAUTHORIZED_OWNER` (765), `OWNER_IS_AGENT` (402),
`GUARDIAN_IS_OWNER` (404), `GUARDIAN_IS_AGENT` (403), `INSUFFICIENT_STORAGE_DEPOSIT` (398),
`INSUFFICIENT_APPROVAL_DEPOSIT` (629), `ALREADY_APPROVED` (636), `TOO_MANY_APPROVALS` (637),
`APPROVAL_NOT_IN_FUTURE` (634), `NEEDS_APPROVAL`/`APPROVAL_USED`/`APPROVAL_EXPIRED` (541-546),
`RECIPIENT_NOT_ALLOWED` (514-515).

## Codes that are not `SCRIP_ERR` (from near-sdk / VM)

| case | code | code origin | action |
| --- | --- | --- | --- |
| KAT-E-05-29..36 (external `on_payment_done`/`on_withdraw_done`) | `METHOD_IS_PRIVATE` | not `SCRIP_ERR`; the `#[private]` macro (lib.rs:589, 792) calls `panic_str("Method <name> is private")` from near-sdk-macros-5.30 (`impl_item_method_info.rs:187`) | `classifyTxError` now maps the text "is private" to `METHOD_IS_PRIVATE` (previously a generic regex matched "Method") |
| KAT-E-05-49..68 (deposit on non-payable method) | `METHOD_NOT_PAYABLE` | not `SCRIP_ERR`; a method without `#[payable]` (lib.rs:489, 657, 701, 743, 818) is rejected by near-sdk with `panic_str("Method <name> doesn't accept deposit")` (`impl_item_method_info.rs:156`) | `classifyTxError` now maps the text "doesn't accept deposit" to `METHOD_NOT_PAYABLE` |

Notes & Derivation Rules (H4):
The release wasm build (strip=true, opt-level="z") turns near-sdk's internal panics (non-payable method & private callback) into `WebAssembly trap: An unreachable opcode was executed` with no utf8 panic message (see `.agy/results/D1d-tighten-and-last-four.report.md`).
To classify these traps honestly without loosening the assessment and without reading `expected`, a pure classification function `inferVmRejection({ method, deposit, callerIsContractItself, txFailedWithTrap })` was added:
1. `METHOD_IS_PRIVATE`: only if the method is `on_payment_done` or `on_withdraw_done`, the caller is not the contract account itself (`callerIsContractItself === false`), and the tx failed with a trap.
2. `METHOD_NOT_PAYABLE`: only if the method is in the non-payable set from `contracts/scrip/src/lib.rs` (`request_payment`, `withdraw`, `tighten`, `loosen`, `revoke`, `resolve_stale`; only `create_mandate` and `approve_intent` are `#[payable]`), the attached deposit is > 0, and the tx failed with a trap.
3. Outside those conditions, the result stays `TX_FAILED`.
State evidence: after the case runs, the mandate snapshot (`spent`, `reserved`, status) and the merchant balance are verified not to have mutated (`detectMandateBreach`), proving the rejection was complete. The case notes include: "code derived from call shape because release wasm does not emit panic message".

Limitations of this derivation:
- It assumes that a trap on a non-payable method with deposit > 0, or on an external private callback, was triggered by a near-sdk guard; if another VM trap occurs (e.g. extreme out-of-gas before the method guard), the classification still identifies it as a method guard rejection.
- It depends on call metadata (method name, deposit, caller identity) and on-chain Failure status confirmation, not a direct error string from the VM.

## Findings (not changed, per task scope)

| case | old expectation | per contract | reason not changed |
| --- | --- | --- | --- |
| KAT-E-05-09 loosen Budget 1500000 by guardian | `INERT` / null | `BLOCKED` / `BUDGET_ABOVE_DEPOSITED` (710), because deposited = 1250000 (testnet.mjs:717/803) | the label would have to change INERT -> BLOCKED; the task forbids changing labels |
| KAT-E-10-20 loosen 17th recipient | `BLOCKED` / `TOO_MANY_RECIPIENTS` | with the real setup (1 recipient) adding a 2nd is accepted -> `INERT` (723-729); `TOO_MANY_RECIPIENTS` only if the list already has 16 | the 16-recipient setup does not exist; the code for the "17th" condition is already correct, so the data was not changed |
| KAT-E-10-21 resolve_stale not yet stale | `BLOCKED` / `NOT_STALE_YET` (after correction) | without a `Pending`, check 822 (`NO_SUCH_PENDING`) comes before 825 | the pending/stale state prep does not exist yet; the code for the "not yet stale" condition is already correct |
| KAT-E-05-25 resolve_stale by guardian | `INERT` / null | without pending/stale: `NO_SUCH_PENDING` (822) or `NOT_STALE_YET` (825) | the label would have to change INERT -> BLOCKED; the task forbids it |

## Covered outside testnet

A stale `Pending` cannot be held on testnet, so these two cases were not changed and stay `SKIPPED` in layer E. Neither is counted as a pass. Their behavior is proven by the Rust unit tests in `contracts/scrip/src/tests.rs`:

| case | Rust test | what it proves |
| --- | --- | --- |
| KAT-E-10-21 resolve_stale not yet stale | `resolve_stale_before_stale_blocks_panics_and_at_blocks_works` | `resolve_stale` before the stale threshold is rejected, and exactly at the stale threshold it runs |
| KAT-E-05-25 resolve_stale by guardian | `resolve_stale_transferred_true_settles` | the guardian resolving a stale `Pending` with `transferred=true` successfully settles the state |
