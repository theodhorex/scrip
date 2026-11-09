//! A1: Callback & ambiguous state review tests.
//! Covers patterns (a) ambiguous callback / Pending hold & same-nonce/id parameter conflicts,
//! (b) late/out-of-order/duplicate callbacks across budget changes, expiry, revoke, withdraw,
//! and resolve_stale, and (c) on-chain readable rejection events and panic logs.

use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, Gas, NearToken, PromiseResult, RuntimeFeesConfig};
use proptest::prelude::*;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};

const CONTRACT: &str = "scrip.testnet";
const OWNER: &str = "alice.testnet";
const AGENT: &str = "agent.testnet";
const GUARDIAN: &str = "guardian.testnet";
const TOKEN: &str = "usdc.testnet";
const SHOP: &str = "shop.testnet";
const CAFE: &str = "cafe.testnet";
const STRANGER: &str = "bob.testnet";
const NOW: u64 = 1_000_000;
const EXPIRES: u64 = 10_000_000;
const START_HEIGHT: u64 = 1000;
const STALE_HEIGHT: u64 = START_HEIGHT + STALE_BLOCKS;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_full(pred: &str, ts_ms: u64, tgas: u64, height: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(ts_ms * 1_000_000)
        .block_height(height)
        .prepaid_gas(Gas::from_tgas(tgas))
        .attached_deposit(NearToken::from_yoctonear(0));
    b
}

fn set_ctx(pred: &str, ts_ms: u64, height: u64) {
    testing_env!(ctx_full(pred, ts_ms, 200, height).build());
}

fn set_with_deposit(pred: &str, deposit: NearToken) {
    testing_env!(ctx_full(pred, NOW, 100, START_HEIGHT).attached_deposit(deposit).build());
}

fn set_callback_at(result: PromiseResult, ts_ms: u64, height: u64) {
    testing_env!(
        ctx_full(CONTRACT, ts_ms, 100, height).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
}

fn reset_storage() {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage())
    }));
}

fn setup_mandate() -> (Scrip, u64) {
    reset_storage();
    set_with_deposit(OWNER, STORAGE_DEPOSIT_PER_MANDATE);
    let mut c = Scrip::new();
    let id = c.create_mandate(
        acc(AGENT),
        acc(GUARDIAN),
        acc(TOKEN),
        U128(1000),
        U128(100),
        U128(50),
        vec![acc(SHOP), acc(CAFE)],
        EXPIRES,
    );
    set_ctx(TOKEN, NOW, START_HEIGHT);
    let msg = format!("{{\"mandate_id\":{id}}}");
    match c.ft_on_transfer(acc(OWNER), U128(1000), msg) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!("ft_on_transfer must return Value(0)"),
    }
    (c, id)
}

fn parsed_events(logs: &[String]) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn unwrap_val(r: PromiseOrValue<PaymentResult>) -> PaymentResult {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected PromiseOrValue::Value, got Promise"),
    }
}

fn panics_with_code(code: &str, f: impl FnOnce()) {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err(&format!("expected panic {code}"));
    let logs = get_logs();
    let logged = logs.iter().any(|l| l == &format!("SCRIP_ERR:{code}"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(
        logged && msg.contains(code),
        "expected SCRIP_ERR:{code} in logs {logs:?} and panic msg {msg:?}"
    );
}

// ---------------------------------------------------------------------------
// Scenario 1: Late callbacks after revoke and withdraw
// ---------------------------------------------------------------------------

#[test]
fn late_callback_after_revoke_and_withdraw_settles_or_unlocks_remainder() {
    let (mut c, id) = setup_mandate();

    // Two in-flight requests: rid 1 (40) and rid 2 (30) -> reserved = 70
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert!(matches!(c.request_payment(id, acc(SHOP), U128(40), 1), PromiseOrValue::Promise(_)));
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert!(matches!(c.request_payment(id, acc(CAFE), U128(30), 2), PromiseOrValue::Promise(_)));

    // Owner revokes mandate while both requests are Pending
    set_ctx(OWNER, NOW, START_HEIGHT + 1);
    c.revoke(id);

    // Owner cannot withdraw the 70 reserved tokens; max withdrawable free remainder is 930
    panics_with_code(err::AMOUNT_EXCEEDS_FREE, || {
        set_ctx(OWNER, NOW, START_HEIGHT + 2);
        let _ = c.withdraw(id, U128(931));
    });

    set_ctx(OWNER, NOW, START_HEIGHT + 2);
    let _ = c.withdraw(id, U128(930));
    set_callback_at(PromiseResult::Successful(vec![]), NOW, START_HEIGHT + 3);
    assert!(c.on_withdraw_done(id, U128(930)));
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 70);

    // Late callback for rid 1 settles (40): reserved 70 -> 30, spent 0 -> 40, ledger 70 -> 30
    set_callback_at(PromiseResult::Successful(vec![]), NOW + 50_000, START_HEIGHT + 50);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Settled { request_id: 1 });
    let s1 = c.get_stats(id).unwrap();
    assert_eq!(
        (s1.spent.0, s1.reserved.0, s1.withdrawn.0, s1.open_requests),
        (40, 30, 930, 1)
    );
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 30);

    // Free is still 0 because rid 2 (30) is still reserved
    panics_with_code(err::AMOUNT_EXCEEDS_FREE, || {
        set_ctx(OWNER, NOW + 50_000, START_HEIGHT + 51);
        let _ = c.withdraw(id, U128(1));
    });

    // Late callback for rid 2 fails (refunds 30): reserved 30 -> 0, ledger stays 30
    set_callback_at(PromiseResult::Failed, NOW + 60_000, START_HEIGHT + 60);
    assert_eq!(c.on_payment_done(id, 2), PaymentResult::Refunded { request_id: 2 });
    let s2 = c.get_stats(id).unwrap();
    assert_eq!(
        (s2.spent.0, s2.reserved.0, s2.withdrawn.0, s2.open_requests),
        (40, 0, 930, 0)
    );
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 30);

    // Owner can now withdraw the newly freed 30 tokens
    set_ctx(OWNER, NOW + 60_000, START_HEIGHT + 61);
    let _ = c.withdraw(id, U128(30));
    set_callback_at(PromiseResult::Successful(vec![]), NOW + 60_000, START_HEIGHT + 62);
    assert!(c.on_withdraw_done(id, U128(30)));

    let s3 = c.get_stats(id).unwrap();
    assert_eq!(
        (s3.deposited.0, s3.spent.0, s3.reserved.0, s3.withdrawn.0),
        (1000, 40, 0, 960)
    );
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 0);
}

#[test]
fn interleaved_payment_and_withdraw_callbacks_commute_in_all_orders() {
    for (pay_ok, withdraw_ok) in [(true, true), (true, false), (false, true), (false, false)] {
        let (mut c, id) = setup_mandate();

        // Reserve 40
        set_ctx(AGENT, NOW, START_HEIGHT);
        let _ = c.request_payment(id, acc(SHOP), U128(40), 1);

        // Revoke and start withdraw of 600 (before payment callback runs)
        set_ctx(OWNER, NOW, START_HEIGHT + 1);
        c.revoke(id);
        set_ctx(OWNER, NOW, START_HEIGHT + 2);
        let _ = c.withdraw(id, U128(600));

        // While both are in-flight: reserved = 40, withdrawn = 600, ledger = 400
        assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 400);

        // 1. Payment callback arrives FIRST while withdraw is still in-flight
        set_callback_at(
            if pay_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 1000,
            START_HEIGHT + 3,
        );
        let pres = c.on_payment_done(id, 1);
        assert_eq!(
            pres,
            if pay_ok {
                PaymentResult::Settled { request_id: 1 }
            } else {
                PaymentResult::Refunded { request_id: 1 }
            }
        );

        // 2. Withdraw callback arrives SECOND
        set_callback_at(
            if withdraw_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 2000,
            START_HEIGHT + 4,
        );
        assert_eq!(c.on_withdraw_done(id, U128(600)), withdraw_ok);

        let exp_spent = if pay_ok { 40 } else { 0 };
        let exp_withdrawn = if withdraw_ok { 600 } else { 0 };
        let s = c.get_stats(id).unwrap();
        assert_eq!(s.spent.0, exp_spent);
        assert_eq!(s.reserved.0, 0);
        assert_eq!(s.withdrawn.0, exp_withdrawn);
        assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 1000 - exp_spent - exp_withdrawn);
    }
}

// ---------------------------------------------------------------------------
// Scenario 2: Late callbacks after resolve_stale & duplicate callbacks
// ---------------------------------------------------------------------------

#[test]
fn late_callback_after_resolve_stale_ignores_both_success_and_failure_even_with_other_pending() {
    let (mut c, id) = setup_mandate();

    // Two pending requests: rid 1 (40) and rid 2 (40) -> reserved = 80
    set_ctx(AGENT, NOW, START_HEIGHT);
    let _ = c.request_payment(id, acc(SHOP), U128(40), 1);
    set_ctx(AGENT, NOW, START_HEIGHT);
    let _ = c.request_payment(id, acc(CAFE), U128(40), 2);

    // Resolve rid 1 via resolve_stale(transferred=true) at STALE_HEIGHT
    set_ctx(GUARDIAN, NOW + 200_000, STALE_HEIGHT);
    c.resolve_stale(id, 1, true);

    let after_stale = c.get_stats(id).unwrap();
    assert_eq!(
        (after_stale.spent.0, after_stale.reserved.0, after_stale.open_requests),
        (40, 40, 1)
    );
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 960);

    // Late FAILED callback for rid 1 arrives while rid 2 still holds reserved = 40.
    // Must return AlreadyResolved and MUST NOT subtract 40 from rid 2's reserve!
    set_callback_at(PromiseResult::Failed, NOW + 210_000, STALE_HEIGHT + 1);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::AlreadyResolved { request_id: 1 });
    assert!(parsed_events(&get_logs()).is_empty());
    let after_failed_cb = c.get_stats(id).unwrap();
    assert_eq!(after_failed_cb, after_stale);
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 960);

    // Late SUCCESSFUL callback for rid 1 arrives: must NOT double-increment spent or deduct ledger!
    set_callback_at(PromiseResult::Successful(vec![]), NOW + 220_000, STALE_HEIGHT + 2);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::AlreadyResolved { request_id: 1 });
    assert!(parsed_events(&get_logs()).is_empty());
    assert_eq!(c.get_stats(id).unwrap(), after_stale);
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 960);

    // Rid 2's own callback still settles its 40 cleanly
    set_callback_at(PromiseResult::Successful(vec![]), NOW + 230_000, STALE_HEIGHT + 3);
    assert_eq!(c.on_payment_done(id, 2), PaymentResult::Settled { request_id: 2 });
    let final_stats = c.get_stats(id).unwrap();
    assert_eq!((final_stats.spent.0, final_stats.reserved.0, final_stats.open_requests), (80, 0, 0));
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 920);
}

#[test]
fn late_callback_after_rejected_stale_refund_still_resolves_pending() {
    for cb_ok in [true, false] {
        let (mut c, id) = setup_mandate();
        set_ctx(AGENT, NOW, START_HEIGHT);
        let _ = c.request_payment(id, acc(SHOP), U128(40), 1);

        // Guardian tries resolve_stale(..., false) -> panics STALE_REFUND_UNPROVABLE
        panics_with_code(err::STALE_REFUND_UNPROVABLE, || {
            set_ctx(GUARDIAN, NOW + 200_000, STALE_HEIGHT);
            c.resolve_stale(id, 1, false);
        });
        assert!(c.get_pending(id, 1).is_some());

        // Late callback arrives afterwards and resolves rid 1 normally
        set_callback_at(
            if cb_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 210_000,
            STALE_HEIGHT + 1,
        );
        let res = c.on_payment_done(id, 1);
        assert_eq!(
            res,
            if cb_ok {
                PaymentResult::Settled { request_id: 1 }
            } else {
                PaymentResult::Refunded { request_id: 1 }
            }
        );
        assert!(c.get_pending(id, 1).is_none());
    }
}

#[test]
fn duplicate_callbacks_all_four_outcome_pairs_are_idempotent() {
    for (first_ok, second_ok) in [(true, true), (true, false), (false, true), (false, false)] {
        let (mut c, id) = setup_mandate();
        set_ctx(AGENT, NOW, START_HEIGHT);
        let _ = c.request_payment(id, acc(SHOP), U128(40), 1);

        set_callback_at(
            if first_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 1000,
            START_HEIGHT + 1,
        );
        let r1 = c.on_payment_done(id, 1);
        assert_eq!(
            r1,
            if first_ok {
                PaymentResult::Settled { request_id: 1 }
            } else {
                PaymentResult::Refunded { request_id: 1 }
            }
        );
        assert_eq!(parsed_events(&get_logs()).len(), 1);
        let snap_stats = c.get_stats(id).unwrap();
        let snap_ledger = c.get_token_ledger(acc(TOKEN));

        // Duplicate callback with second_ok
        set_callback_at(
            if second_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 2000,
            START_HEIGHT + 2,
        );
        let r2 = c.on_payment_done(id, 1);
        assert_eq!(r2, PaymentResult::AlreadyResolved { request_id: 1 });
        assert!(parsed_events(&get_logs()).is_empty());
        assert_eq!(c.get_stats(id).unwrap(), snap_stats);
        assert_eq!(c.get_token_ledger(acc(TOKEN)), snap_ledger);

        // Subsequent resolve_stale also fails with NO_SUCH_PENDING
        panics_with_code(err::NO_SUCH_PENDING, || {
            set_ctx(GUARDIAN, NOW + 200_000, STALE_HEIGHT);
            c.resolve_stale(id, 1, true);
        });
    }
}

// ---------------------------------------------------------------------------
// Scenario 3: Ambiguous PromiseResult / Pending reserve hold & rule/generation changes
// ---------------------------------------------------------------------------

#[test]
fn ambiguous_in_flight_pending_locks_reserve_and_arbitrary_success_payloads_settle() {
    let (mut c, id) = setup_mandate();

    // Tighten budget to 100, cap 100, threshold 100 so 2 requests of 50 fill the budget
    set_ctx(GUARDIAN, NOW, START_HEIGHT);
    c.loosen(id, Change::ApprovalThreshold(U128(100)));
    c.tighten(id, Change::Budget(U128(100)));

    // Request 1 (60) is Pending (callback hasn't arrived -> ambiguous state on-chain)
    set_ctx(AGENT, NOW, START_HEIGHT);
    let _ = c.request_payment(id, acc(SHOP), U128(60), 1);
    assert_eq!(c.get_stats(id).unwrap().reserved.0, 60);

    // While Request 1 is unresolved, agent cannot spend more than remaining 40
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert_eq!(
        unwrap_val(c.request_payment(id, acc(SHOP), U128(41), 2)),
        PaymentResult::Rejected { code: "OVER_BUDGET".into() }
    );

    // Request 2 (40) is accepted, bringing reserved to 100
    let _ = c.request_payment(id, acc(CAFE), U128(40), 3);
    assert_eq!(c.get_stats(id).unwrap().reserved.0, 100);

    // Non-JSON / binary / large (16 KB) Successful payload on callback still settles (Audit N-L5)
    set_callback_at(PromiseResult::Successful(vec![0xffu8; 16_384]), NOW + 1000, START_HEIGHT + 1);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Settled { request_id: 1 });
    assert_eq!(c.get_stats(id).unwrap().spent.0, 60);
    assert_eq!(c.get_stats(id).unwrap().reserved.0, 40);
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 940);

    // Failed callback on Request 2 releases its 40 reserve without touching ledger
    set_callback_at(PromiseResult::Failed, NOW + 2000, START_HEIGHT + 2);
    assert_eq!(c.on_payment_done(id, 2), PaymentResult::Refunded { request_id: 2 });
    assert_eq!(c.get_stats(id).unwrap().spent.0, 60);
    assert_eq!(c.get_stats(id).unwrap().reserved.0, 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN)).0, 940);
}

#[test]
fn late_callback_after_rule_tightening_and_expiry_does_not_violate_new_budget() {
    for cb_ok in [true, false] {
        let (mut c, id) = setup_mandate();

        // Request 1 (40 to SHOP) is reserved at NOW
        set_ctx(AGENT, NOW, START_HEIGHT);
        let _ = c.request_payment(id, acc(SHOP), U128(40), 1);

        // While rid 1 is in-flight, owner tightens threshold->40, cap->40, budget->40 (== reserved),
        // removes SHOP from allowed recipients, and tightens expiry to NOW + 100
        set_ctx(OWNER, NOW, START_HEIGHT + 1);
        c.tighten(id, Change::ApprovalThreshold(U128(40)));
        c.tighten(id, Change::PerPaymentCap(U128(40)));
        c.tighten(id, Change::Budget(U128(40)));
        c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
        c.tighten(id, Change::Expiry(NOW + 100));

        // Time advances past mandate expiry (NOW + 5000 >= NOW + 100) and callback arrives
        set_callback_at(
            if cb_ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            NOW + 5000,
            START_HEIGHT + 50,
        );
        let res = c.on_payment_done(id, 1);
        let s = c.get_stats(id).unwrap();
        if cb_ok {
            assert_eq!(res, PaymentResult::Settled { request_id: 1 });
            assert_eq!((s.spent.0, s.reserved.0, s.budget.0), (40, 0, 40));
            assert!(s.spent.0 + s.reserved.0 <= s.budget.0);
        } else {
            assert_eq!(res, PaymentResult::Refunded { request_id: 1 });
            assert_eq!((s.spent.0, s.reserved.0, s.budget.0), (0, 0, 40));
            // Even though 40 was refunded, agent cannot spend it because mandate is now expired
            set_ctx(AGENT, NOW + 5000, START_HEIGHT + 51);
            assert_eq!(
                unwrap_val(c.request_payment(id, acc(CAFE), U128(10), 2)),
                PaymentResult::Rejected { code: "EXPIRED".into() }
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Scenario 4: Same nonce with different parameters (above and below threshold)
// ---------------------------------------------------------------------------

#[test]
fn same_nonce_with_different_params_above_threshold_is_rejected_without_consuming_approval() {
    let (mut c, id) = setup_mandate();

    // Guardian approves (id, SHOP, 80, nonce=42)
    set_with_deposit(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL);
    c.approve_intent(id, acc(SHOP), U128(80), 42, NOW + 5000);

    // Agent sends same nonce=42 with different recipient (CAFE) -> NEEDS_APPROVAL
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert_eq!(
        unwrap_val(c.request_payment(id, acc(CAFE), U128(80), 42)),
        PaymentResult::Rejected { code: "NEEDS_APPROVAL".into() }
    );

    // Agent sends same nonce=42 with different amount (75) -> NEEDS_APPROVAL
    assert_eq!(
        unwrap_val(c.request_payment(id, acc(SHOP), U128(75), 42)),
        PaymentResult::Rejected { code: "NEEDS_APPROVAL".into() }
    );

    // Original approval for (id, SHOP, 80, nonce=42) is still unconsumed and succeeds
    assert!(matches!(
        c.request_payment(id, acc(SHOP), U128(80), 42),
        PromiseOrValue::Promise(_)
    ));

    // Reusing (id, SHOP, 80, nonce=42) now returns APPROVAL_USED
    assert_eq!(
        unwrap_val(c.request_payment(id, acc(SHOP), U128(80), 42)),
        PaymentResult::Rejected { code: "APPROVAL_USED".into() }
    );
}

#[test]
fn same_nonce_below_threshold_assigns_distinct_monotonic_request_ids() {
    let (mut c, id) = setup_mandate();

    // Below threshold (<= 50), Scrip does not deduplicate client nonces: each accepted call
    // receives its own monotonic request_id (1, 2, 3) in `pending`.
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert!(matches!(c.request_payment(id, acc(SHOP), U128(40), 7), PromiseOrValue::Promise(_)));
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert!(matches!(c.request_payment(id, acc(CAFE), U128(30), 7), PromiseOrValue::Promise(_)));
    set_ctx(AGENT, NOW, START_HEIGHT);
    assert!(matches!(c.request_payment(id, acc(SHOP), U128(40), 7), PromiseOrValue::Promise(_)));

    assert_eq!(c.get_pending(id, 1).unwrap().amount.0, 40);
    assert_eq!(c.get_pending(id, 1).unwrap().recipient, acc(SHOP));
    assert_eq!(c.get_pending(id, 2).unwrap().amount.0, 30);
    assert_eq!(c.get_pending(id, 2).unwrap().recipient, acc(CAFE));
    assert_eq!(c.get_pending(id, 3).unwrap().amount.0, 40);
    assert_eq!(c.get_mandate(id).unwrap().next_request_id, 4);
}

// ---------------------------------------------------------------------------
// Scenario 5: Pattern (c) — All rejection reasons & panic codes readable on-chain
// ---------------------------------------------------------------------------

#[test]
fn all_rejection_reasons_emit_nep297_rejected_event_and_leave_state_untouched() {
    let (mut c, id) = setup_mandate();

    // Prepare an expired approval (nonce 10) and a used approval (nonce 11)
    set_with_deposit(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL);
    c.approve_intent(id, acc(SHOP), U128(60), 10, NOW + 10);
    set_with_deposit(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL);
    c.approve_intent(id, acc(SHOP), U128(60), 11, NOW + 50_000);
    set_ctx(AGENT, NOW, START_HEIGHT);
    let _ = c.request_payment(id, acc(SHOP), U128(60), 11);
    set_callback_at(PromiseResult::Failed, NOW, START_HEIGHT + 1);
    let _ = c.on_payment_done(id, 1);

    let now2 = NOW + 20;
    let mut seen_codes = Vec::new();

    let mut check_reject = |c: &mut Scrip, rec: &str, amt: u128, nonce: u64, ts: u64, want: RejectCode| {
        let before = c.get_mandate(id).unwrap();
        set_ctx(AGENT, ts, START_HEIGHT + 2);
        let res = c.request_payment(id, acc(rec), U128(amt), nonce);
        assert_eq!(
            unwrap_val(res),
            PaymentResult::Rejected { code: want.as_str().to_string() }
        );
        let evs = parsed_events(&get_logs());
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0]["standard"], "scrip");
        assert_eq!(evs[0]["version"], "1.0.0");
        assert_eq!(evs[0]["event"], "rejected");
        assert_eq!(evs[0]["data"][0]["mandate_id"], id);
        assert_eq!(evs[0]["data"][0]["recipient"], rec);
        assert_eq!(evs[0]["data"][0]["amount"], amt.to_string());
        assert_eq!(evs[0]["data"][0]["code"], want.as_str());
        assert!(get_created_receipts().is_empty());
        assert_eq!(c.get_mandate(id).unwrap(), before);
        seen_codes.push(want.as_str());
    };

    check_reject(&mut c, STRANGER, 10, 1, now2, RejectCode::RecipientNotAllowed);
    check_reject(&mut c, SHOP, 0, 1, now2, RejectCode::OverPerPaymentCap);
    check_reject(&mut c, SHOP, 60, 99, now2, RejectCode::NeedsApproval);
    check_reject(&mut c, SHOP, 60, 11, now2, RejectCode::ApprovalUsed);
    check_reject(&mut c, SHOP, 60, 10, now2, RejectCode::ApprovalExpired);

    c.mandates.get_mut(&id).unwrap().spent = 980;
    check_reject(&mut c, SHOP, 30, 1, now2, RejectCode::OverBudget);
    c.mandates.get_mut(&id).unwrap().spent = 0;

    c.mandates.get_mut(&id).unwrap().open_requests = MAX_OPEN;
    check_reject(&mut c, SHOP, 10, 1, now2, RejectCode::TooManyOpen);
    c.mandates.get_mut(&id).unwrap().open_requests = 0;

    check_reject(&mut c, SHOP, 10, 1, EXPIRES, RejectCode::Expired);

    set_ctx(OWNER, now2, START_HEIGHT + 2);
    c.revoke(id);
    check_reject(&mut c, SHOP, 10, 1, now2, RejectCode::NotActive);

    assert_eq!(
        seen_codes,
        vec![
            "RECIPIENT_NOT_ALLOWED",
            "OVER_PER_PAYMENT_CAP",
            "NEEDS_APPROVAL",
            "APPROVAL_USED",
            "APPROVAL_EXPIRED",
            "OVER_BUDGET",
            "TOO_MANY_OPEN",
            "EXPIRED",
            "NOT_ACTIVE",
        ]
    );
    // Document the two extra RejectCode variants that are enforced via panicking require()
    assert_eq!(RejectCode::LedgerInsufficient.as_str(), err::LEDGER_INSUFFICIENT);
    assert_eq!(RejectCode::StaleRefundUnprovable.as_str(), err::STALE_REFUND_UNPROVABLE);
}

// ---------------------------------------------------------------------------
// Scenario 6: Property test — arbitrary interleavings of callbacks, stale, revoke, withdraw
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum CbOp {
    Request { amount: u8, cafe: bool, nonce: u8 },
    Callback { rid: u8, ok: bool },
    ResolveStale { rid: u8, transferred: bool },
    TightenBudget { budget: u16 },
    Revoke,
    Withdraw { amount: u16, ok: bool },
}

fn arb_cb_op() -> impl Strategy<Value = CbOp> {
    prop_oneof![
        4 => (1u8..=50, any::<bool>(), 1u8..=8).prop_map(|(amount, cafe, nonce)| CbOp::Request { amount, cafe, nonce }),
        5 => (1u8..=12, any::<bool>()).prop_map(|(rid, ok)| CbOp::Callback { rid, ok }),
        3 => (1u8..=12, any::<bool>()).prop_map(|(rid, transferred)| CbOp::ResolveStale { rid, transferred }),
        2 => (100u16..=1000).prop_map(|budget| CbOp::TightenBudget { budget }),
        1 => Just(CbOp::Revoke),
        2 => (1u16..=500, any::<bool>()).prop_map(|(amount, ok)| CbOp::Withdraw { amount, ok }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 30, .. ProptestConfig::default() })]

    #[test]
    fn p_late_and_duplicate_callbacks_preserve_conservation_across_lifecycle(
        ops in prop::collection::vec(arb_cb_op(), 15..=45)
    ) {
        let (mut c, id) = setup_mandate();
        let mut expected_pending: BTreeMap<u64, u128> = BTreeMap::new();
        let mut next_rid = 1u64;

        for op in ops {
            match op {
                CbOp::Request { amount, cafe, nonce } => {
                    set_ctx(AGENT, NOW, START_HEIGHT);
                    let rec = if cafe { CAFE } else { SHOP };
                    if let PromiseOrValue::Promise(_) = c.request_payment(id, acc(rec), U128(amount as u128), nonce as u64) {
                        expected_pending.insert(next_rid, amount as u128);
                        next_rid += 1;
                    }
                }
                CbOp::Callback { rid, ok } => {
                    set_callback_at(
                        if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
                        NOW + 10_000,
                        STALE_HEIGHT + 5,
                    );
                    let res = c.on_payment_done(id, rid as u64);
                    if expected_pending.remove(&(rid as u64)).is_some() {
                        prop_assert_eq!(
                            res,
                            if ok {
                                PaymentResult::Settled { request_id: rid as u64 }
                            } else {
                                PaymentResult::Refunded { request_id: rid as u64 }
                            }
                        );
                    } else {
                        prop_assert_eq!(res, PaymentResult::AlreadyResolved { request_id: rid as u64 });
                    }
                }
                CbOp::ResolveStale { rid, transferred } => {
                    set_ctx(GUARDIAN, NOW + 5000, STALE_HEIGHT);
                    let ok = catch_unwind(AssertUnwindSafe(|| {
                        c.resolve_stale(id, rid as u64, transferred);
                    }))
                    .is_ok();
                    if ok {
                        prop_assert!(transferred);
                        prop_assert!(expected_pending.remove(&(rid as u64)).is_some());
                    }
                }
                CbOp::TightenBudget { budget } => {
                    set_ctx(OWNER, NOW, START_HEIGHT);
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        c.tighten(id, Change::Budget(U128(budget as u128)));
                    }));
                }
                CbOp::Revoke => {
                    set_ctx(OWNER, NOW, START_HEIGHT);
                    let _ = catch_unwind(AssertUnwindSafe(|| c.revoke(id)));
                }
                CbOp::Withdraw { amount, ok } => {
                    set_ctx(OWNER, NOW, START_HEIGHT);
                    let started = catch_unwind(AssertUnwindSafe(|| {
                        let _ = c.withdraw(id, U128(amount as u128));
                    }))
                    .is_ok();
                    if started {
                        set_callback_at(
                            if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
                            NOW + 1000,
                            START_HEIGHT + 1,
                        );
                        prop_assert_eq!(c.on_withdraw_done(id, U128(amount as u128)), ok);
                    }
                }
            }

            let m = c.get_mandate(id).unwrap();
            let ledger = c.get_token_ledger(acc(TOKEN)).0;
            let pending_sum: u128 = expected_pending.values().copied().sum();
            prop_assert_eq!(m.reserved.0, pending_sum);
            prop_assert_eq!(m.open_requests as usize, expected_pending.len());
            prop_assert!(m.spent.0 + m.reserved.0 <= m.budget.0);
            prop_assert!(m.spent.0 + m.reserved.0 + m.withdrawn.0 <= m.deposited.0);
            prop_assert_eq!(ledger, m.deposited.0 - m.spent.0 - m.withdrawn.0);
            prop_assert!(ledger >= m.reserved.0);
        }
    }
}
