//! Tests for H2: per-token ledger (buku besar saldo per token di kontrak).
//!
//! Enforces the global invariant:
//! ledger[token] == SUM(deposited - spent - withdrawn) across all mandates for that token.
//! Reserved tokens remain in ledger until settled.
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, Gas, NearToken, PromiseResult};
use proptest::prelude::*;

const CONTRACT: &str = "scrip.testnet";
const OWNER: &str = "alice.testnet";
const AGENT: &str = "agent.testnet";
const GUARDIAN: &str = "guardian.testnet";
const TOKEN_A: &str = "usdc.testnet";
const TOKEN_B: &str = "wrap.testnet";
const SHOP: &str = "shop.testnet";
const CAFE: &str = "cafe.testnet";
const STRANGER: &str = "bob.testnet";
const NOW: u64 = 1_000_000;
const EXPIRES: u64 = 10_000_000;
const STALE_SET_HEIGHT: u64 = 1000 + STALE_BLOCKS;

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

fn set(pred: &str) {
    testing_env!(ctx_full(pred, NOW, 100, 1000).build());
}

fn set_with_deposit(pred: &str, deposit: NearToken) {
    testing_env!(ctx_full(pred, NOW, 100, 1000).attached_deposit(deposit).build());
}

fn set_callback(result: PromiseResult) {
    testing_env!(
        ctx_full(CONTRACT, NOW, 100, 1001).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![result]
    );
}

fn reset_storage() {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        near_sdk::mock::with_mocked_blockchain(|b| b.take_storage())
    }));
}

fn try_call<T>(f: impl FnOnce() -> T) -> Result<T, ()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|_| ())
}

fn create_mandate_with_token(c: &mut Scrip, token: &str, budget: u128, cap: u128, threshold: u128) -> u64 {
    set_with_deposit(OWNER, STORAGE_DEPOSIT_PER_MANDATE);
    c.create_mandate(
        acc(AGENT),
        acc(GUARDIAN),
        acc(token),
        U128(budget),
        U128(cap),
        U128(threshold),
        vec![acc(SHOP), acc(CAFE)],
        EXPIRES,
    )
}

fn fund(c: &mut Scrip, token: &str, sender: &str, id: u64, amount: u128) -> u128 {
    set(token);
    let msg = format!("{{\"mandate_id\":{id}}}");
    match c.ft_on_transfer(acc(sender), U128(amount), msg) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("ft_on_transfer must return a value"),
    }
}

fn settle(c: &mut Scrip, id: u64, rid: u64, ok: bool) -> PaymentResult {
    set_callback(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_payment_done(id, rid)
}

fn withdraw_cb(c: &mut Scrip, id: u64, amount: u128, ok: bool) -> bool {
    set_callback(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_withdraw_done(id, U128(amount))
}

fn resolve_at(c: &mut Scrip, who: &str, height: u64, id: u64, rid: u64, transferred: bool) {
    testing_env!(ctx_full(who, NOW, 100, height).build());
    c.resolve_stale(id, rid, transferred);
}

fn approve_as(c: &mut Scrip, who: &str, id: u64, recipient: &str, amount: u128, nonce: u64, valid_until: u64) {
    testing_env!(ctx_full(who, NOW, 100, 1000).attached_deposit(STORAGE_DEPOSIT_PER_APPROVAL).build());
    c.approve_intent(id, acc(recipient), U128(amount), nonce, valid_until);
}

fn assert_ledger_invariant_holds(c: &Scrip, token: &str, mandate_ids: &[u64]) {
    let token_acc = acc(token);
    let mut sum: u128 = 0;
    let mut reserved_sum: u128 = 0;
    for &id in mandate_ids {
        if let Some(m) = c.get_mandate(id) {
            if m.token == token_acc {
                let net = m.deposited.0.checked_sub(m.spent.0).expect("spent <= deposited")
                    .checked_sub(m.withdrawn.0).expect("withdrawn <= net");
                sum = sum.checked_add(net).expect("sum overflow");
                reserved_sum = reserved_sum.checked_add(m.reserved.0).expect("reserved sum overflow");
            }
        }
    }
    let ledger_val = c.get_token_ledger(token_acc.clone()).0;
    assert_eq!(
        ledger_val, sum,
        "Invariant violated for token {}: ledger ({}) != sum ({})",
        token, ledger_val, sum
    );
    assert!(
        ledger_val >= reserved_sum,
        "Ledger {} must cover all active reservations {}",
        ledger_val, reserved_sum
    );
}

#[test]
fn deterministic_ledger_invariant_two_tokens_multiple_mandates() {
    reset_storage();
    let mut c = Scrip::new();

    // 1. Initial state: both token ledgers are 0
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN_B)).0, 0);

    // Create 4 mandates: 2 on TOKEN_A, 2 on TOKEN_B
    let m1 = create_mandate_with_token(&mut c, TOKEN_A, 1000, 100, 50);
    let m2 = create_mandate_with_token(&mut c, TOKEN_A, 500, 80, 40);
    let m3 = create_mandate_with_token(&mut c, TOKEN_B, 2000, 200, 100);
    let m4 = create_mandate_with_token(&mut c, TOKEN_B, 1500, 150, 75);
    let all_m = vec![m1, m2, m3, m4];

    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);
    assert_ledger_invariant_holds(&c, TOKEN_B, &all_m);

    // 2. Deposit to m1 (TOKEN_A: +1000)
    assert_eq!(fund(&mut c, TOKEN_A, OWNER, m1, 1000), 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1000);
    assert_eq!(c.get_token_ledger(acc(TOKEN_B)).0, 0);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);
    assert_ledger_invariant_holds(&c, TOKEN_B, &all_m);

    // 3. Deposit to m2 (TOKEN_A: +500)
    assert_eq!(fund(&mut c, TOKEN_A, OWNER, m2, 500), 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1500);
    assert_eq!(c.get_token_ledger(acc(TOKEN_B)).0, 0);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 4. Deposit to m3 (TOKEN_B: +2000) and m4 (TOKEN_B: +800)
    assert_eq!(fund(&mut c, TOKEN_B, OWNER, m3, 2000), 0);
    assert_eq!(fund(&mut c, TOKEN_B, OWNER, m4, 800), 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1500);
    assert_eq!(c.get_token_ledger(acc(TOKEN_B)).0, 2800);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);
    assert_ledger_invariant_holds(&c, TOKEN_B, &all_m);

    // 5. Invalid deposit (stranger sender) refunded, ledger unchanged
    assert_eq!(fund(&mut c, TOKEN_A, STRANGER, m1, 300), 300);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1500);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 6. Request payment on m1 (amount: 40 <= threshold 50)
    set(AGENT);
    let res = c.request_payment(m1, acc(SHOP), U128(40), 1);
    assert!(matches!(res, PromiseOrValue::Promise(_)));
    // Reserved tokens remain in ledger
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1500);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 7. Payment settles on m1: ledger decreases by 40 -> 1460
    let pres = settle(&mut c, m1, 1, true);
    assert_eq!(pres, PaymentResult::Settled { request_id: 1 });
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1460);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 8. Request payment on m2 (amount: 30), but payment fails/refunds
    set(AGENT);
    let res2 = c.request_payment(m2, acc(SHOP), U128(30), 1);
    assert!(matches!(res2, PromiseOrValue::Promise(_)));
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1460);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    let pres2 = settle(&mut c, m2, 1, false);
    assert_eq!(pres2, PaymentResult::Refunded { request_id: 1 });
    // Refund: ledger unchanged!
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1460);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 9. Revoke m1 and withdraw 300
    set(OWNER);
    c.revoke(m1);
    set(OWNER);
    let _ = c.withdraw(m1, U128(300));
    // Ledger deducted immediately (state first)
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1160);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // Callback succeeds: ledger stays 1160
    assert!(withdraw_cb(&mut c, m1, 300, true));
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1160);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 10. Withdraw 200 on m1 with failed callback: ledger restored!
    set(OWNER);
    let _ = c.withdraw(m1, U128(200));
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 960);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    assert!(!withdraw_cb(&mut c, m1, 200, false));
    // Restored!
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1160);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 11. Stale resolution: request on m2 (40 Token A), resolve_stale transferred=true
    set(AGENT);
    let _ = c.request_payment(m2, acc(CAFE), U128(40), 2);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1160);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    resolve_at(&mut c, GUARDIAN, STALE_SET_HEIGHT, m2, 2, true);
    // transferred=true -> settled: ledger decreased by 40 -> 1120
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1120);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // 12. Stale resolution: request on m2 (20 Token A), resolve_stale transferred=false is rejected (STALE_REFUND_UNPROVABLE)
    set(AGENT);
    let _ = c.request_payment(m2, acc(CAFE), U128(20), 3);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1120);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    let res = try_call(|| resolve_at(&mut c, GUARDIAN, STALE_SET_HEIGHT + 100, m2, 3, false));
    assert!(res.is_err(), "resolve_stale transferred=false must be rejected with STALE_REFUND_UNPROVABLE");
    // State and ledger remain completely unchanged
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 1120);
    assert_ledger_invariant_holds(&c, TOKEN_A, &all_m);

    // TOKEN_B is completely untouched throughout TOKEN_A operations
    assert_eq!(c.get_token_ledger(acc(TOKEN_B)).0, 2800);
    assert_ledger_invariant_holds(&c, TOKEN_B, &all_m);
}

#[test]
fn ledger_insufficient_guard_triggers() {
    reset_storage();
    let mut c = Scrip::new();
    let m1 = create_mandate_with_token(&mut c, TOKEN_A, 1000, 100, 50);
    assert_eq!(fund(&mut c, TOKEN_A, OWNER, m1, 100), 0);
    assert_eq!(c.get_token_ledger(acc(TOKEN_A)).0, 100);

    // Artificially reduce token_ledger to 10 to test the guard
    c.token_ledger.insert(acc(TOKEN_A), 10);

    // Request payment of 20 (> ledger 10) panics with LEDGER_INSUFFICIENT
    set(AGENT);
    let res = try_call(|| c.request_payment(m1, acc(SHOP), U128(20), 1));
    assert!(res.is_err(), "request_payment must fail when ledger < amount");

    // Revoke and try to withdraw 20 (> ledger 10) panics with LEDGER_INSUFFICIENT
    set(OWNER);
    c.revoke(m1);
    set(OWNER);
    let res_w = try_call(|| c.withdraw(m1, U128(20)));
    assert!(res_w.is_err(), "withdraw must fail when ledger < amount");
}

// --------------------------------------------------------------------------- Property Tests

#[derive(Clone, Debug)]
enum LedgerOp {
    Deposit { mandate_idx: usize, amount: u16, valid_sender: bool },
    Approve { mandate_idx: usize, amount: u16, nonce: u64 },
    Request { mandate_idx: usize, amount: u16, nonce: u64 },
    Settle { mandate_idx: usize, rid: u64, ok: bool },
    ResolveStale { mandate_idx: usize, rid: u64, transferred: bool },
    Revoke { mandate_idx: usize },
    Withdraw { mandate_idx: usize, amount: u16, ok: bool },
}

fn arb_ledger_op() -> impl Strategy<Value = LedgerOp> {
    prop_oneof![
        3 => (0usize..4, 1u16..=400, any::<bool>()).prop_map(|(m, a, v)| LedgerOp::Deposit { mandate_idx: m, amount: a, valid_sender: v }),
        2 => (0usize..4, 10u16..=120, 1u64..10).prop_map(|(m, a, n)| LedgerOp::Approve { mandate_idx: m, amount: a, nonce: n }),
        4 => (0usize..4, 1u16..=100, 1u64..10).prop_map(|(m, a, n)| LedgerOp::Request { mandate_idx: m, amount: a, nonce: n }),
        3 => (0usize..4, 1u64..=10, any::<bool>()).prop_map(|(m, r, ok)| LedgerOp::Settle { mandate_idx: m, rid: r, ok }),
        2 => (0usize..4, 1u64..=10, any::<bool>()).prop_map(|(m, r, t)| LedgerOp::ResolveStale { mandate_idx: m, rid: r, transferred: t }),
        1 => (0usize..4).prop_map(|m| LedgerOp::Revoke { mandate_idx: m }),
        2 => (0usize..4, 1u16..=300, any::<bool>()).prop_map(|(m, a, ok)| LedgerOp::Withdraw { mandate_idx: m, amount: a, ok }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 25, .. ProptestConfig::default() })]

    #[test]
    fn p_ledger_invariant_random_sequence_two_tokens(ops in prop::collection::vec(arb_ledger_op(), 20..=60)) {
        reset_storage();
        let mut c = Scrip::new();

        let m1 = create_mandate_with_token(&mut c, TOKEN_A, 2000, 100, 50);
        let m2 = create_mandate_with_token(&mut c, TOKEN_A, 1500, 80, 40);
        let m3 = create_mandate_with_token(&mut c, TOKEN_B, 3000, 120, 60);
        let m4 = create_mandate_with_token(&mut c, TOKEN_B, 2500, 90, 45);
        let mandate_ids = [m1, m2, m3, m4];

        for (step, op) in ops.iter().enumerate() {
            match op {
                LedgerOp::Deposit { mandate_idx, amount, valid_sender } => {
                    let id = mandate_ids[*mandate_idx];
                    let token = if *mandate_idx < 2 { TOKEN_A } else { TOKEN_B };
                    let sender = if *valid_sender { OWNER } else { STRANGER };
                    let _ = fund(&mut c, token, sender, id, *amount as u128);
                }
                LedgerOp::Approve { mandate_idx, amount, nonce } => {
                    let id = mandate_ids[*mandate_idx];
                    let _ = try_call(|| approve_as(&mut c, GUARDIAN, id, SHOP, *amount as u128, *nonce, NOW + 50_000));
                }
                LedgerOp::Request { mandate_idx, amount, nonce } => {
                    let id = mandate_ids[*mandate_idx];
                    set(AGENT);
                    let _ = try_call(|| c.request_payment(id, acc(SHOP), U128(*amount as u128), *nonce));
                }
                LedgerOp::Settle { mandate_idx, rid, ok } => {
                    let id = mandate_ids[*mandate_idx];
                    let _ = try_call(|| settle(&mut c, id, *rid, *ok));
                }
                LedgerOp::ResolveStale { mandate_idx, rid, transferred } => {
                    let id = mandate_ids[*mandate_idx];
                    let _ = try_call(|| resolve_at(&mut c, GUARDIAN, STALE_SET_HEIGHT, id, *rid, *transferred));
                }
                LedgerOp::Revoke { mandate_idx } => {
                    let id = mandate_ids[*mandate_idx];
                    set(OWNER);
                    let _ = try_call(|| c.revoke(id));
                }
                LedgerOp::Withdraw { mandate_idx, amount, ok } => {
                    let id = mandate_ids[*mandate_idx];
                    set(OWNER);
                    let res = try_call(|| c.withdraw(id, U128(*amount as u128)));
                    if res.is_ok() {
                        let _ = try_call(|| withdraw_cb(&mut c, id, *amount as u128, *ok));
                    }
                }
            }

            // Verify invariant after EVERY operation for both tokens
            assert_ledger_invariant_holds(&c, TOKEN_A, &mandate_ids);
            assert_ledger_invariant_holds(&c, TOKEN_B, &mandate_ids);
            let _ = step;
        }
    }
}
