# K1 REPORT: contract core

## Result
- `cargo test`: **49 passed, 0 failed** (`make -C /home/theo/Documents/dev/hackathon/scrip contract-test` passes). Red first: with signature stubs (`unimplemented!()`) the same suite was 0 passed / 49 failed; then implemented to green.
- wasm: `contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm` = 248,538 bytes (release profile opt-level z, lto, strip). Build about 15 s.
- Big-endian check: changing `amount.to_le_bytes()` to `to_be_bytes()` made 2 tests fail (`intent_hash_matches_every_positive_vector`, `intent_hash_view_returns_hex_of_pure_function`); same for `mandate_id`. Both mutations reverted, suite green again.
- `signer_account_id`: not used in `src/lib.rs`. It appears ONLY in `src/tests.rs`, in the context builder and in the test proving a signer==agent caller still panics (predecessor decides).

## Rejection-code coverage (test names in `src/tests.rs`)
| Code | Test |
|---|---|
| NOT_ACTIVE | `reject_not_active` |
| EXPIRED | `reject_expired_at_and_after_expiry_but_not_before` |
| RECIPIENT_NOT_ALLOWED | `reject_recipient_not_allowed` |
| OVER_PER_PAYMENT_CAP | `reject_over_per_payment_cap_zero_and_cap_plus_one` (amount 0 and cap+1; cap itself is accepted in `reject_over_budget_boundaries`/others) |
| TOO_MANY_OPEN | `reject_too_many_open_at_33rd_and_counts_match_pending` |
| OVER_BUDGET | `reject_over_budget_boundaries`, `..._counts_reserved_and_one_over`, `..._when_deposit_does_not_cover`, `..._u128_overflow_is_a_rejection_not_a_panic` |
| NEEDS_APPROVAL | `reject_needs_approval_above_threshold_but_not_at_threshold` |
| APPROVAL_USED | `approval_is_consumed_once_then_reports_used` |
| APPROVAL_EXPIRED | `reject_approval_expired` |
Other: agent mismatch (`non_agent_caller_panics`, `signer_being_agent_is_not_enough_predecessor_decides`), `INSUFFICIENT_GAS` (`gas_below_60_tgas_panics_before_anything_else`, `exactly_60_tgas_is_accepted`), check order (`check_order_follows_prd`), reserve-before-promise (`reserves_before_creating_the_transfer_promise`: reserved, Pending written and receipts show ft_transfer 1 yocto/15 Tgas/weight 0 + callback 15 Tgas/weight 0), callback settle/refund/idempotent, funding refunds (non-owner, wrong token, revoked/unknown/malformed msg, overflow), events shape (`every_emitted_event_has_the_shape_the_js_parser_expects`), invariants (`invariants_hold_over_a_mixed_run`).

## PRD ambiguities resolved
1. **Approval hash expiry**: the agent passes only `nonce`, so the lookup hashes with `mandate.expires_at_ms`. K2 `approve_intent` must hash with the mandate's expiry. `APPROVAL_EXPIRED` is then driven by `Approval.expires_at_ms` (tests insert approvals directly).
2. **budget <= deposited - withdrawn** (5.3 #1) with `create_mandate` before any deposit: step 6 uses ceiling `min(budget, deposited - withdrawn)`, rejecting as `OVER_BUDGET`.
3. **Event fields**: parser needs `recipient` and `amount` on every event; `mandate_created` uses agent/budget, `deposited` uses owner/amount.
4. **Recipient list**: LookupSet cannot be enumerated, so added `recipient_lists: LookupMap<u64, Vec<AccountId>>` for views (K2 must keep both in sync).
5. First mandate id is 1. Callback on a missing Pending returns new variant `AlreadyResolved`. Numeric args (`nonce`, `expires_at_ms`, ids) are plain `u64`; amounts `U128`.
6. Free fn `intent_hash` lives in `scrip::hash` because the exported view `intent_hash` clashes with a root-level fn in the wasm build.
7. Not testable in unit tests: runtime rejection of an attached deposit on non-payable `request_payment` (done by the macro-generated wrapper). Numeric negative vectors in the vector file are JS-side parse rules; only recipient negatives apply on-chain and are tested.

## Left for K2
`approve_intent`, `tighten`, `loosen`, `revoke`, `withdraw`, `resolve_stale` and their events (marker `// K2` in `lib.rs`); `withdrawn` stays 0.

## Skills dipakai
- test-driven-development: tests and vector-driven hash test written first, red (49 failed) before green.
- incremental-implementation: slices state/create, funding, hash, request, callback, views, events, `cargo test` after each; honest note: red was done once for the whole suite via stubs, not per slice.
- api-and-interface-design: `RejectCode` enum rendered to SCREAMING_SNAKE, stable view structs, one `emit`.
- security-and-hardening: predecessor auth, checked arithmetic, reserve before call, idempotent callback, gas guard first.
- planning-and-task-breakdown: ordered plan at top of README.
- code-review-and-quality: self-review below.

## Self-review vs PRD 3.3 / 5.3
Checked steps 1..9 order in code and in `check_order_follows_prd`; checked invariants 1 (min ceiling), 3 (funds conservation by checked sub/add in reserve/settle/refund), 5 (approval marked used in step 8 only), 6, 7 (`open_requests == pending count` tests); no `unsafe`; no `signer_account_id` in lib. Gaps: invariant 2/4 mostly K2 (no guardian methods yet); `cargo fmt` not installed so no formatting pass; no clippy run.

---

# K2 REPORT: guardian roles

## Result
- `cargo test`: **91 passed, 0 failed** (49 K1 + 42 K2; `make -C .. contract-test` passes). Red first: with `unimplemented!()` stubs for the 6 methods + callback, the suite was 50 passed / 41 failed; then implemented to green. No compiler warnings (test and wasm builds).
- wasm: `make contract-build` OK, `scrip.wasm` = 279,120 bytes (K1: 248,538).
- K1 tests changed: none weakened or deleted. Only the helpers `create_default` and `try_create` now attach 0.05 NEAR (new `set_with_deposit`), because `create_mandate` requires it now.

## K1 review fixes
1. `create_mandate` needs `attached_deposit >= STORAGE_DEPOSIT_PER_MANDATE` (0.05 NEAR), panic `INSUFFICIENT_STORAGE_DEPOSIT`, deposit kept (tests: `create_mandate_without_deposit_panics`, `create_mandate_deposit_boundary_is_exactly_0_05_near`).
2. Approval hash binds the mandate's current `expires_at_ms`; `approve_intent(..., approval_expires_at_ms)` (test: `approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it`).
3. `recipient_lists` and `recipients` in sync (test: `recipient_list_and_set_stay_in_sync_on_add_and_remove`).

## Allowed / denied matrix (test `role_matrix_allowed_and_denied`, every cell asserted)
| Method | owner | guardian | agent | stranger |
|---|---|---|---|---|
| `approve_intent` | deny | **allow** | deny | deny |
| `tighten` | **allow** | **allow** | deny | deny |
| `loosen` | deny | **allow** | deny | deny |
| `revoke` | **allow** | **allow** | deny | deny |
| `withdraw` | **allow** | deny | deny | deny |
| `resolve_stale` | deny | **allow** | deny | deny |
| `request_payment` (K1) | deny | deny | **allow** | deny |
Exact panic codes: `denied_calls_change_nothing`, `withdraw_and_resolve_stale_deny_the_wrong_roles_with_clear_codes`.

## Invariant (PRD 5.3) -> covering test
| # | Invariant | Tests |
|---|---|---|
| 1 | `spent + reserved <= budget <= deposited - withdrawn` (ceiling `min(budget, deposited.saturating_sub(withdrawn))`) | `check_invariants` in `fund_conservation_holds_over_a_scripted_sequence`; `budget_ceiling_never_counts_tokens_already_withdrawn`, `tighten_budget_boundaries`, `loosen_budget_boundaries`; K1 `reject_over_budget_*` |
| 2 | tokens leave only to listed recipients, or to the owner via `withdraw` after revoke | `withdraw_needs_an_explicit_revoke_even_after_expiry`, `withdraw_only_the_free_remainder_...`, `withdraw_creates_ft_transfer_to_owner_and_callback`, `recipient_list_and_set_stay_in_sync_...`; K1 `reject_recipient_not_allowed` |
| 3 | `deposited == spent + reserved + withdrawn + remaining` | `fund_conservation_holds_over_a_scripted_sequence` (independent token ledger; includes failed transfer, stale both ways, failed and successful withdraw) |
| 4 | only the guardian raises limits / adds recipients; the agent never changes rules | `only_the_guardian_raises_limits_and_the_agent_never_changes_rules`, role matrix, `denied_calls_change_nothing` |
| 5 | an approval is used at most once | `approve_then_request_round_trip_over_threshold`, `approve_intent_rejects_duplicates_even_after_the_approval_was_used`; K1 `approval_is_consumed_once_...` |
| 6 | Revoked or expired mandates take no new requests | `revoke_by_owner_or_guardian_then_second_revoke_panics` (NOT_ACTIVE after revoke); K1 `reject_not_active`, `reject_expired_...` |
| 7 | `open_requests <= MAX_OPEN` and equals the Pending count | `check_invariants` in the scripted sequence (incl. `resolve_stale`); K1 `reject_too_many_open_...` |

## Other tests required by the task
tighten/loosen boundaries (budget == spent + reserved, cap == budget, threshold == cap, 16 recipients, expiry now/now+1); approve round trip (approved passes, `NEEDS_APPROVAL`, `APPROVAL_USED`, `APPROVAL_EXPIRED`, nonce/amount/recipient mismatch); withdraw callback success and failure; `resolve_stale` at 199/200 blocks, both branches, double call, revoked mandate, late callback no-op; revoke with open request then callbacks settle and refund; `change_json_is_stable`; `k2_events_all_have_the_js_parser_shape`.

## Deviations / decisions
- `withdraw` requires prepaid gas >= 60 Tgas (`INSUFFICIENT_GAS`), added by me: a callback that runs out of gas would leave `withdrawn` raised though the transfer failed. 45 Tgas was first tried but the mock hit `GasExceeded`, so 60 like `request_payment`.
- `on_withdraw_done` failure emits no event (task says `withdrawn` on success only); it returns `bool`.
- `approve_intent` also rejects an already existing hash even if used (re-inserting would reset `used` and allow a replay); it also panics `NOT_ACTIVE` / `APPROVAL_NOT_IN_FUTURE` (`now >= approval_expires_at_ms`).
- Tighten in K2 did not force `budget >= per_payment_cap` or `cap >= threshold`; updated in PRD v1.3 (K-A) to strictly enforce `budget >= per_payment_cap >= approval_threshold` (`BUDGET_BELOW_CAP`, `CAP_BELOW_THRESHOLD`), with effective ceiling `min(budget, deposited - withdrawn)`.
- `revoke` of an expired-but-Active mandate is allowed. `withdraw` strictly requires `MandateStatus::Revoked` (per F1 fix, `now >= expires_at_ms` alone panics `MANDATE_STILL_ACTIVE`; explicit `revoke` is mandatory).
- Event field mapping for `tightened`/`loosened`/`revoked`: see README events table (parser needs `recipient` + `amount`).
- Owner may equal the agent in early K1/K2; updated in PRD v1.3 (K-B) to strictly reject `owner == agent` (`OWNER_IS_AGENT`).
- Not unit-testable: `#[private]` and `#[payable]` checks live in the generated wrapper, so direct method calls skip them (same as K1). `INVALID_RECIPIENT` in `loosen`/`approve_intent` is defence in depth: the `AccountId` type already rejects invalid names before the method runs.
- Panic codes are constants in `scrip::err`; K1 inline codes were left untouched (scope).

## Skills dipakai
- test-driven-development: wrote the whole K2 suite against `unimplemented!()` stubs first (41 red), then green; honest note: red was one shot for the suite, not per method.
- incremental-implementation: slices approve, tighten/loosen, revoke, withdraw (+callback), resolve_stale; note the implementation landed in one edit followed by `cargo test`, not a test run after each method.
- security-and-hardening: access matrix with all roles, one-directional tighten/loosen, withdraw writes state before the promise and restores in callback, double-resolution guard, no approval overwrite.
- api-and-interface-design: `Change` JSON documented and pinned by a test, panic codes in `scrip::err`.
- planning-and-task-breakdown: invariant -> test table above.
- code-review-and-quality: re-read the diff against PRD 3.2 / 5.3, found and fixed an unreachable match arm and a wrong test assertion; `cargo fmt`/clippy not run (not installed in K1 either).
