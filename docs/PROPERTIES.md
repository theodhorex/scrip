# PROPERTIES: Contract Invariants and Audit Findings for Scrip

This document maps all formal invariants (P1..P10 per PRD v1.3 s4 / T-A) and audit findings (`AUDIT_1.md` and `AUDIT_2.md` per T-E) to real test function names in `contracts/scrip/src/tests.rs` and `contracts/scrip/src/property_tests.rs`.

---

## 1. Contract Invariants (P1..P10)

| ID | Invariant Definition | Property Test (`property_tests.rs`) | Regression Unit Test (`tests.rs`) | Status |
|---|---|---|---|---|
| **P1** | `spent + reserved <= budget` | `p1_spent_plus_reserved_never_exceeds_budget` | `reject_over_budget_boundaries`, `reject_over_budget_counts_reserved_and_one_over`, `reject_over_budget_when_deposit_does_not_cover` | Tested |
| **P2** | Effective ceiling `min(budget, deposited - withdrawn)` is never exceeded | `p2_ceiling_never_exceeds_deposited_minus_withdrawn` | `budget_ceiling_never_counts_tokens_already_withdrawn`, `loosen_budget_cannot_exceed_deposited_minus_withdrawn` | Tested |
| **P3** | Token conservation: contract physical token balance = `deposited - spent - withdrawn` | `p3_token_conservation_holds_against_independent_ledger` | `fund_conservation_holds_over_a_scripted_sequence`, `invariants_hold_over_a_mixed_run` | Tested |
| **P4** | `tighten` only tightens (parameters only move inward, preserving `budget >= cap >= threshold`) | `p4_tighten_never_loosens` | `tighten_budget_boundaries`, `tighten_cap_threshold_boundaries`, `tighten_recipients_only_removes_and_only_existing`, `tighten_expiry_must_move_earlier_but_stay_in_the_future` | Tested |
| **P5** | `loosen` never exceeds `deposited - withdrawn`, obeys limit hierarchy, and requires guardian | `p5_loosen_stays_inside_deposit_and_ladder` | `loosen_budget_boundaries`, `loosen_cap_and_threshold_boundaries`, `loosen_recipients_only_adds_valid_new_ones_up_to_16`, `loosen_expiry_must_move_later` | Tested |
| **P6** | `withdraw` only for owner on `Revoked` mandate, only free remainder (`deposited - spent - reserved - withdrawn`), and writes state before promise | `p6_withdraw_only_owner_after_revoke_within_free` | `withdraw_needs_an_explicit_revoke_even_after_expiry`, `withdraw_only_the_free_remainder_and_increments_before_the_promise`, `withdraw_creates_ft_transfer_to_owner_and_callback`, `withdraw_callback_success_keeps_withdrawn_and_emits_event`, `withdraw_callback_failure_restores_withdrawn_and_emits_nothing` | Tested |
| **P7** | Intent approval (`approve_intent`) is consumed at most once for an exact matching tuple | `p7_approval_is_consumed_at_most_once` | `approval_is_consumed_once_then_reports_used`, `approve_then_request_round_trip_over_threshold`, `approve_intent_rejects_duplicates_even_after_the_approval_was_used` | Tested |
| **P8** | Intent hash (`intent_hash`) is deterministic, sensitive to changes in each field, and binds mandate expiry | `p8_intent_hash_is_deterministic_and_field_sensitive` | `intent_hash_matches_every_positive_vector`, `intent_hash_view_returns_hex_of_pure_function`, `approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it` | Tested |
| **P9** | Requests with `Pending` status are resolved (settled or refunded) exactly once, via callback or `resolve_stale` | `p9_pending_never_resolves_twice` | `callback_settles_on_success`, `callback_refunds_on_failure`, `callback_is_idempotent_when_pending_missing`, `resolve_stale_second_call_and_unknown_request_panic`, `resolve_stale_works_on_revoked_mandates_and_late_callback_is_a_no_op` | Tested |
| **P10** | Random sequences of arbitrary operations preserve all invariants P1..P3 and K-A | `p10_random_orders_preserve_money_invariants` | `fund_conservation_holds_over_a_scripted_sequence`, `invariants_hold_over_a_mixed_run` | Tested |

---

## 2. Mapping of Audit Findings from AUDIT_1 to Real Test Names

| Finding ID | Category / Issue | Real Test Name / Test Location | Status |
|---|---|---|---|
| **F1** | Mandate with tokens withdrawn can be revived & drain other mandates' balance | `budget_ceiling_never_counts_tokens_already_withdrawn`, `loosen_budget_cannot_exceed_deposited_minus_withdrawn`, `withdraw_needs_an_explicit_revoke_even_after_expiry`, `revoke_after_inconsistent_accounting_does_not_underflow` | Tested (Fix F1) |
| **F2** | Facilitator does not check access key public key for `senderId` | Facilitator: `keycheck.test.mjs`, `relay.test.mjs` | Tested (Facilitator) |
| **F3** | Unpaid and unbounded `approvals` storage locks contract NEAR | `approve_intent_needs_the_storage_deposit`, `approve_intent_refunds_excess_near_to_guardian`, `approve_intent_caps_entries_per_mandate` | Tested (Fix F3 / K-C) |
| **F4** | `resolve_stale(transferred=false)` releases reservation without verification | `resolve_stale_transferred_false_rejected_unprovable`, `test_f4_attack_cannot_reopen_budget_via_false_guardian_claim`, `create_rejects_guardian_equal_owner` | Closed (F45, Nov 3, 2026): `false` rejected with `STALE_REFUND_UNPROVABLE`; `true` retained |
| **F5** | Withdraw callback failure locks funds without a recovery path | `withdraw_callback_failure_restores_withdrawn_and_emits_nothing`, `withdraw_needs_enough_prepaid_gas_for_the_callback`, `p11_f5_callbacks_never_panic_and_invariants_hold`, `f45_callback_gas_margin_settle_refund_and_withdraw` (integration) | Mitigated (F45): callback does not panic on reachable paths (property tests) and measured gas margin >= 7x; acknowledged residual: a lost callback locks funds belonging to the owner themselves |
| **F6** | Approval remains consumed even when transfer fails | `audit_f6_refunded_request_leaves_approval_consumed` | Tested |
| **F7** | Per-mandate storage can exceed 0.05 NEAR deposit when Pending is full | `create_mandate_deposit_boundary_is_exactly_0_05_near` | Tested (Design limit) |
| **F8** | Facilitator outer transaction success vs inner transaction failure | Facilitator: `outer_tx_succeeded` labeling and min gas limit | Tested (Facilitator) |
| **F9** | Weak `rpcUrl` hostname check in facilitator policy | Facilitator: strict https host allowlist | Tested (Facilitator) |

---

## 3. Mapping of Audit Findings from AUDIT_2 to Real Test Names

| Finding ID | Category / Issue | Real Test Name / Test Location | Status |
|---|---|---|---|
| **N-M1** | Pre-auth RPC amplification on facilitator | Facilitator: IP rate limiter & offline decode | Tested (Facilitator) |
| **N-M2** | Relay concurrency sharing single access key nonce | Facilitator: relay queue handling / concurrency tests | Tested (Facilitator) |
| **N-L1** | Withdraw/guardian interaction: `resolve_stale(false)` + `owner == guardian` | `create_rejects_guardian_equal_owner`, `resolve_stale_transferred_false_rejected_unprovable` | Tested (F4 closed in F45) |
| **N-L2** | Missing deduplication of identical signed delegates in facilitator | Facilitator: sqlite database delegate deduplication | Tested (Facilitator) |
| **N-L3** | Approvals never deleted and unbounded per mandate | `approve_intent_caps_entries_per_mandate` (K-C: 512 limit, panic `TOO_MANY_APPROVALS`) | Tested |
| **N-L4** | Key-check cache and RPC amplification from bogus keys | Facilitator: cache TTL validation and key eviction | Tested (Facilitator) |
| **N-L5** | `promise_result_checked(0, 1024)` treats return values >1024 bytes as failure | `audit_nl5_exact_1024_bytes_result_settles_successfully` (succeeds at 1024 bytes); `audit_nl5_oversized_transfer_result_should_settle` (`#[ignore]`, real bug in lib.rs); `audit_nl5_oversized_withdraw_result_should_succeed` (`#[ignore]`, real bug in lib.rs) | Tested & marked `#[ignore]` |
| **N-I1** | Shared token model trusts token accounting (fee-on-transfer / rebasing) | Threat Model README K-3 / K-F (1 contract/owner mitigation) | untested (proposed token allowlist) |
| **N-I2** | `approval_threshold` is calculated per payment, not cumulatively | `audit_ni2_approval_threshold_is_per_payment_not_cumulative` | Tested |
| **N-I3** | Storage margin of mandate with 16 recipients and 32 pending | `create_mandate_deposit_boundary_is_exactly_0_05_near` | Tested |
| **N-I4** | Owner liveness dependency on guardian for expired pending requests | Design limitation; no bypass method without guardian | untested |
| **N-I5** | Expiry change via `tighten` invalidates unused guardian approvals | `approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it` | Tested |
