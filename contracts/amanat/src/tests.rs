//! Unit tests (VMContextBuilder). Written before the implementation (red first).
use super::*;
use crate::hash::{intent_hash, validate_recipient};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{
    test_vm_config, testing_env, Gas, NearToken, PromiseResult, RuntimeFeesConfig,
};
use serde_json::{json, Value};
use std::collections::HashMap;

const NOW: u64 = 1_000_000; // ms
const EXPIRES: u64 = 10_000_000; // ms
const CONTRACT: &str = "amanat.testnet";
const OWNER: &str = "alice.testnet";
const AGENT: &str = "agent.testnet";
const GUARDIAN: &str = "guardian.testnet";
const TOKEN: &str = "usdc.testnet";
const SHOP: &str = "shop.testnet";
const CAFE: &str = "cafe.testnet";
const STRANGER: &str = "bob.testnet";
const VECTORS: &str = include_str!("../../../docs/vectors/intent_hash.json");

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

fn set_at(pred: &str, ts_ms: u64) {
    testing_env!(ctx_full(pred, ts_ms, 100, 1000).build());
}

fn set(pred: &str) {
    set_at(pred, NOW);
}

/// Context with an attached NEAR deposit (K2: `create_mandate` needs the storage deposit).
fn set_with_deposit(pred: &str, deposit: NearToken) {
    testing_env!(ctx_full(pred, NOW, 100, 1000).attached_deposit(deposit).build());
}

fn set_callback(result: PromiseResult) {
    testing_env!(
        ctx_full(CONTRACT, NOW, 100, 1001).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
}

fn create_default(c: &mut Amanat) -> u64 {
    set_with_deposit(OWNER, STORAGE_DEPOSIT_PER_MANDATE);
    c.create_mandate(
        acc(AGENT),
        acc(GUARDIAN),
        acc(TOKEN),
        U128(1000),
        U128(100),
        U128(50),
        vec![acc(SHOP), acc(CAFE)],
        EXPIRES,
    )
}

fn fund(c: &mut Amanat, token: &str, sender: &str, id: u64, amount: u128) -> u128 {
    set(token);
    let msg = format!("{{\"mandate_id\":{id}}}");
    match c.ft_on_transfer(acc(sender), U128(amount), msg) {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("ft_on_transfer must return a value"),
    }
}

/// Mandate 1: budget 1000, cap 100, threshold 50, deposited 1000.
fn setup() -> (Amanat, u64) {
    set(OWNER);
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    assert_eq!(fund(&mut c, TOKEN, OWNER, id, 1000), 0);
    (c, id)
}

fn req(c: &mut Amanat, id: u64, recipient: &str, amount: u128, nonce: u64) -> PromiseOrValue<PaymentResult> {
    set(AGENT);
    c.request_payment(id, acc(recipient), U128(amount), nonce)
}

fn reserved_id(r: PromiseOrValue<PaymentResult>) -> u64 {
    // A successful request returns the callback promise chain (reserved above).
    match r {
        PromiseOrValue::Promise(_) => 0,
        PromiseOrValue::Value(v) => panic!("expected a promise, got {v:?}"),
    }
}

fn rejected_code(r: PromiseOrValue<PaymentResult>) -> String {
    match r {
        PromiseOrValue::Value(PaymentResult::Rejected { code }) => code,
        PromiseOrValue::Value(v) => panic!("expected Rejected, got {v:?}"),
        PromiseOrValue::Promise(_) => panic!("expected Rejected, got a promise"),
    }
}

fn mandate(c: &Amanat, id: u64) -> &Mandate {
    c.mandates.get(&id).unwrap()
}

fn pending_count(c: &Amanat, id: u64) -> u32 {
    let next = mandate(c, id).next_request_id;
    (1..next).filter(|r| c.get_pending(id, *r).is_some()).count() as u32
}

fn hex(h: &[u8; 32]) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn events(logs: &[String]) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

// ---------- create_mandate ----------

#[test]
fn create_mandate_stores_state_and_emits_event() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    assert_eq!(id, 1);
    let m = c.get_mandate(1).unwrap();
    assert_eq!(m.owner, acc(OWNER));
    assert_eq!(m.agent, acc(AGENT));
    assert_eq!(m.guardian, acc(GUARDIAN));
    assert_eq!(m.token, acc(TOKEN));
    assert_eq!(m.budget, U128(1000));
    assert_eq!(m.per_payment_cap, U128(100));
    assert_eq!(m.approval_threshold, U128(50));
    assert_eq!(m.expires_at_ms, EXPIRES);
    assert_eq!(m.status, MandateStatus::Active);
    assert_eq!((m.deposited, m.spent, m.reserved, m.withdrawn), (U128(0), U128(0), U128(0), U128(0)));
    assert_eq!((m.open_requests, m.next_request_id), (0, 1));
    assert_eq!((m.approvals_count, m.approvals_remaining), (0, MAX_APPROVALS_PER_MANDATE));
    assert_eq!(m.recipients, vec![acc(SHOP), acc(CAFE)]);
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "mandate_created");
    // ids are sequential, one contract holds many mandates
    assert_eq!(create_default(&mut c), 2);
    assert!(c.get_mandate(3).is_none());
}

fn try_create(f: impl FnOnce(&mut [Value])) -> u64 {
    let mut a = [
        json!(AGENT), json!(GUARDIAN), json!(1000u128), json!(100u128), json!(50u128),
        json!([SHOP, CAFE]), json!(EXPIRES),
    ];
    f(&mut a);
    let mut c = Amanat::new();
    set_with_deposit(OWNER, STORAGE_DEPOSIT_PER_MANDATE);
    let recips: Vec<AccountId> = serde_json::from_value(a[5].clone()).unwrap();
    c.create_mandate(
        acc(a[0].as_str().unwrap()),
        acc(a[1].as_str().unwrap()),
        acc(TOKEN),
        U128(a[2].as_u64().unwrap() as u128),
        U128(a[3].as_u64().unwrap() as u128),
        U128(a[4].as_u64().unwrap() as u128),
        recips,
        a[6].as_u64().unwrap(),
    )
}

#[test]
#[should_panic(expected = "BUDGET_LESS_THAN_CAP")]
fn create_rejects_budget_below_cap() {
    try_create(|a| { a[2] = json!(99); });
}

#[test]
fn create_accepts_budget_equal_cap_and_threshold_equal_cap() {
    assert_eq!(try_create(|a| { a[2] = json!(100); a[4] = json!(100); }), 1);
}

#[test]
#[should_panic(expected = "GUARDIAN_IS_AGENT")]
fn create_rejects_guardian_equal_agent() {
    try_create(|a| { a[1] = json!(AGENT); });
}

#[test]
#[should_panic(expected = "GUARDIAN_IS_OWNER")]
fn create_rejects_guardian_equal_owner() {
    try_create(|a| { a[1] = json!(OWNER); });
}

#[test]
#[should_panic(expected = "EMPTY_RECIPIENTS")]
fn create_rejects_empty_recipients() {
    try_create(|a| { a[5] = json!([]); });
}

#[test]
#[should_panic(expected = "TOO_MANY_RECIPIENTS")]
fn create_rejects_17_recipients() {
    try_create(|a| {
        let v: Vec<String> = (0..17).map(|i| format!("r{i}.testnet")).collect();
        a[5] = json!(v);
    });
}

#[test]
fn create_accepts_16_recipients() {
    assert_eq!(
        try_create(|a| {
            let v: Vec<String> = (0..16).map(|i| format!("r{i}.testnet")).collect();
            a[5] = json!(v);
        }),
        1
    );
}

#[test]
#[should_panic(expected = "DUPLICATE_RECIPIENT")]
fn create_rejects_duplicate_recipients() {
    try_create(|a| { a[5] = json!([SHOP, CAFE, SHOP]); });
}

#[test]
#[should_panic(expected = "EXPIRY_NOT_IN_FUTURE")]
fn create_rejects_expiry_equal_now() {
    try_create(|a| { a[6] = json!(NOW); });
}

#[test]
#[should_panic(expected = "THRESHOLD_ABOVE_CAP")]
fn create_rejects_threshold_above_cap() {
    try_create(|a| { a[4] = json!(101); });
}

// ---------- K-B: owner != agent, refund of excess NEAR ----------

/// K-B: an owner that is also the agent could self-approve every rule; reject early.
#[test]
fn create_rejects_owner_equal_agent_with_explicit_code() {
    let mut c = Amanat::new();
    set_with_deposit(AGENT, STORAGE_DEPOSIT_PER_MANDATE); // predecessor == agent == owner
    panics_with("OWNER_IS_AGENT", || {
        c.create_mandate(
            acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50),
            vec![acc(SHOP)], EXPIRES,
        );
    });
    assert!(c.get_mandate(1).is_none(), "rejected create must store nothing");
    assert!(get_created_receipts().is_empty(), "rejected create must not move NEAR");
}

/// Sum of `Transfer` actions created by the last call.
fn transfer_total() -> u128 {
    let mut total = 0u128;
    for r in &get_created_receipts() {
        for a in &r.actions {
            if let near_sdk::mock::MockAction::Transfer { deposit, .. } = a {
                total += deposit.as_yoctonear();
            }
        }
    }
    total
}

fn transfer_receivers() -> Vec<String> {
    let mut out = vec![];
    for r in &get_created_receipts() {
        for a in &r.actions {
            if matches!(a, near_sdk::mock::MockAction::Transfer { .. }) {
                out.push(r.receiver_id.to_string());
            }
        }
    }
    out
}

/// K-B: exactly the storage deposit is kept; the rest goes back to the owner.
#[test]
fn create_mandate_refunds_excess_near_to_owner() {
    let excess = NearToken::from_millinear(950); // 1 NEAR attached, 0.05 kept
    let mut c = Amanat::new();
    set_with_deposit(OWNER, NearToken::from_near(1));
    c.create_mandate(
        acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50),
        vec![acc(SHOP)], EXPIRES,
    );
    assert_eq!(transfer_total(), excess.as_yoctonear());
    assert_eq!(transfer_receivers(), vec![OWNER.to_string()]);

    // exactly the minimum creates no refund receipt at all
    set_with_deposit(OWNER, STORAGE_DEPOSIT_PER_MANDATE);
    c.create_mandate(
        acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50),
        vec![acc(SHOP)], EXPIRES,
    );
    assert!(get_created_receipts().is_empty());
    assert_eq!(transfer_total(), 0);
}

/// K-B: the same refund rule on `approve_intent` (guardian pays 2 mNEAR, rest back).
#[test]
fn approve_intent_refunds_excess_near_to_guardian() {
    let (mut c, id) = setup();
    set_with_deposit(GUARDIAN, NearToken::from_millinear(10));
    c.approve_intent(id, acc(SHOP), U128(80), 7, NOW + 5000);
    assert_eq!(transfer_total(), NearToken::from_millinear(8).as_yoctonear());
    assert_eq!(transfer_receivers(), vec![GUARDIAN.to_string()]);

    set_with_deposit(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL);
    c.approve_intent(id, acc(SHOP), U128(80), 8, NOW + 5000);
    assert!(get_created_receipts().is_empty(), "no excess means no transfer");
}

// ---------- ft_on_transfer ----------

#[test]
fn deposit_by_owner_increases_deposited_and_emits() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    assert_eq!(fund(&mut c, TOKEN, OWNER, id, 400), 0);
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "deposited");
    assert_eq!(fund(&mut c, TOKEN, OWNER, id, 600), 0);
    assert_eq!(mandate(&c, id).deposited, 1000);
}

#[test]
fn deposit_by_non_owner_is_refunded_in_full() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    assert_eq!(fund(&mut c, TOKEN, STRANGER, id, 400), 400);
    assert_eq!(mandate(&c, id).deposited, 0);
    assert!(events(&get_logs()).is_empty());
}

#[test]
fn deposit_with_wrong_token_is_refunded_in_full() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    assert_eq!(fund(&mut c, "fake.testnet", OWNER, id, 400), 400);
    assert_eq!(mandate(&c, id).deposited, 0);
    assert!(events(&get_logs()).is_empty());
}

#[test]
fn deposit_to_revoked_unknown_or_malformed_is_refunded() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    c.mandates.get_mut(&id).unwrap().status = MandateStatus::Revoked;
    assert_eq!(fund(&mut c, TOKEN, OWNER, id, 5), 5);
    assert_eq!(fund(&mut c, TOKEN, OWNER, 99, 6), 6);
    set(TOKEN);
    match c.ft_on_transfer(acc(OWNER), U128(7), "not json".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 7),
        _ => panic!(),
    }
    assert_eq!(mandate(&c, id).deposited, 0);
}

#[test]
fn deposit_overflow_is_refunded() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    c.mandates.get_mut(&id).unwrap().deposited = u128::MAX - 5;
    assert_eq!(fund(&mut c, TOKEN, OWNER, id, 10), 10);
    assert_eq!(mandate(&c, id).deposited, u128::MAX - 5);
}

// ---------- intent hash (vectors from docs/vectors/intent_hash.json) ----------

fn num(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn intent_hash_matches_every_positive_vector() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let positive = doc["positive"].as_array().unwrap();
    assert!(!positive.is_empty());
    for v in positive {
        let i = &v["input"];
        assert!(validate_recipient(num(&i["recipient"])), "{}", v["name"]);
        let h = intent_hash(
            num(&i["mandateId"]).parse().unwrap(),
            num(&i["recipient"]),
            num(&i["amount"]).parse().unwrap(),
            num(&i["nonce"]).parse().unwrap(),
            num(&i["expiresAtMs"]).parse().unwrap(),
        );
        assert_eq!(hex(&h), num(&v["hash"]), "vector {}", v["name"]);
    }
}

#[test]
fn recipient_negative_vectors_are_rejected_by_validator() {
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let mut n = 0;
    for v in doc["negative"].as_array().unwrap() {
        if num(&v["name"]).starts_with("recipient_") {
            assert!(!validate_recipient(num(&v["input"]["recipient"])), "{}", v["name"]);
            n += 1;
        }
    }
    assert!(n >= 5);
}

#[test]
fn intent_hash_view_returns_hex_of_pure_function() {
    let (c, _) = setup();
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let v = &doc["positive"][0];
    let i = &v["input"];
    let got = c.intent_hash(
        num(&i["mandateId"]).parse().unwrap(),
        acc(num(&i["recipient"])),
        U128(num(&i["amount"]).parse().unwrap()),
        num(&i["nonce"]).parse().unwrap(),
        num(&i["expiresAtMs"]).parse().unwrap(),
    );
    assert_eq!(got, num(&v["hash"]));
}

#[test]
fn get_approval_by_hex() {
    let (mut c, _) = setup();
    let h = intent_hash(1, SHOP, 60, 7, EXPIRES);
    assert!(c.get_approval(hex(&h)).is_none());
    c.approvals.insert(h, Approval { expires_at_ms: EXPIRES, used: false });
    assert_eq!(c.get_approval(hex(&h)), Some(Approval { expires_at_ms: EXPIRES, used: false }));
}

// ---------- request_payment: guards ----------

#[test]
#[should_panic(expected = "UNAUTHORIZED_AGENT")]
fn non_agent_caller_panics() {
    let (mut c, id) = setup();
    set(STRANGER);
    let _ = c.request_payment(id, acc(SHOP), U128(10), 1);
}

#[test]
#[should_panic(expected = "UNAUTHORIZED_AGENT")]
fn signer_being_agent_is_not_enough_predecessor_decides() {
    let (mut c, id) = setup();
    let mut b = ctx_full(STRANGER, NOW, 100, 1000);
    b.signer_account_id(acc(AGENT));
    testing_env!(b.build());
    let _ = c.request_payment(id, acc(SHOP), U128(10), 1);
}

#[test]
#[should_panic(expected = "MANDATE_NOT_FOUND")]
fn unknown_mandate_panics() {
    let (mut c, _) = setup();
    set(AGENT);
    let _ = c.request_payment(99, acc(SHOP), U128(10), 1);
}

#[test]
#[should_panic(expected = "INSUFFICIENT_GAS")]
fn gas_below_60_tgas_panics_before_anything_else() {
    let (mut c, id) = setup();
    // caller is not even the agent: the gas guard must fire first
    testing_env!(ctx_full(STRANGER, NOW, 59, 1000).build());
    let _ = c.request_payment(id, acc(SHOP), U128(10), 1);
}

#[test]
fn exactly_60_tgas_is_accepted() {
    let (mut c, id) = setup();
    testing_env!(ctx_full(AGENT, NOW, 60, 1000).build());
    reserved_id(c.request_payment(id, acc(SHOP), U128(10), 1));
    assert_eq!(mandate(&c, id).reserved, 10);
}

// ---------- request_payment: rejection codes (PRD 3.3 order) ----------

#[test]
fn reject_not_active() {
    let (mut c, id) = setup();
    c.mandates.get_mut(&id).unwrap().status = MandateStatus::Revoked;
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 10, 1)), "NOT_ACTIVE");
}

#[test]
fn reject_expired_at_and_after_expiry_but_not_before() {
    let (mut c, id) = setup();
    set_at(AGENT, EXPIRES);
    assert_eq!(rejected_code(c.request_payment(id, acc(SHOP), U128(10), 1)), "EXPIRED");
    set_at(AGENT, EXPIRES + 1);
    assert_eq!(rejected_code(c.request_payment(id, acc(SHOP), U128(10), 1)), "EXPIRED");
    set_at(AGENT, EXPIRES - 1);
    reserved_id(c.request_payment(id, acc(SHOP), U128(10), 1));
}

#[test]
fn reject_recipient_not_allowed() {
    let (mut c, id) = setup();
    assert_eq!(rejected_code(req(&mut c, id, STRANGER, 10, 1)), "RECIPIENT_NOT_ALLOWED");
}

#[test]
fn reject_over_per_payment_cap_zero_and_cap_plus_one() {
    let (mut c, id) = setup();
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 0, 1)), "OVER_PER_PAYMENT_CAP");
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 101, 1)), "OVER_PER_PAYMENT_CAP");
}

#[test]
fn reject_too_many_open_at_33rd_and_counts_match_pending() {
    let (mut c, id) = setup();
    for n in 0..MAX_OPEN as u64 {
        reserved_id(req(&mut c, id, SHOP, 1, n));
    }
    assert_eq!(mandate(&c, id).open_requests, MAX_OPEN);
    assert_eq!(pending_count(&c, id), MAX_OPEN);
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 1, 99)), "TOO_MANY_OPEN");
    assert_eq!(mandate(&c, id).open_requests, MAX_OPEN);
    assert_eq!(pending_count(&c, id), MAX_OPEN);
    assert_eq!(mandate(&c, id).reserved, MAX_OPEN as u128);
}

#[test]
fn reject_over_budget_boundaries() {
    let (mut c, id) = setup();
    {
        let m = c.mandates.get_mut(&id).unwrap();
        m.spent = 900;
        m.approval_threshold = 100; // keep step 7 out of this boundary test
    }
    reserved_id(req(&mut c, id, SHOP, 100, 1)); // remaining exactly equal
    assert_eq!(mandate(&c, id).reserved, 100);
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 1, 2)), "OVER_BUDGET"); // 900+100+1 > 1000
}

#[test]
fn reject_over_budget_counts_reserved_and_one_over() {
    let (mut c, id) = setup();
    {
        let m = c.mandates.get_mut(&id).unwrap();
        m.spent = 801;
        m.reserved = 100;
    }
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 100, 1)), "OVER_BUDGET"); // 1001
}

#[test]
fn reject_over_budget_when_deposit_does_not_cover() {
    // PRD 5.3 #1: budget <= deposited - withdrawn. Effective ceiling is min(budget, deposited - withdrawn).
    let (mut c, id) = setup();
    c.mandates.get_mut(&id).unwrap().deposited = 90;
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 91, 1)), "OVER_BUDGET");
}

#[test]
fn reject_over_budget_u128_overflow_is_a_rejection_not_a_panic() {
    let (mut c, id) = setup();
    {
        let m = c.mandates.get_mut(&id).unwrap();
        m.budget = u128::MAX;
        m.deposited = u128::MAX;
        m.spent = u128::MAX - 10;
    }
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 100, 1)), "OVER_BUDGET");
    assert_eq!(mandate(&c, id).reserved, 0);
}

#[test]
fn reject_needs_approval_above_threshold_but_not_at_threshold() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 50, 1)); // == threshold: no approval
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 51, 2)), "NEEDS_APPROVAL");
}

#[test]
fn approval_is_consumed_once_then_reports_used() {
    let (mut c, id) = setup();
    let h = intent_hash(id, SHOP, 60, 7, EXPIRES);
    c.approvals.insert(h, Approval { expires_at_ms: EXPIRES, used: false });
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 60, 8)), "NEEDS_APPROVAL"); // other nonce
    reserved_id(req(&mut c, id, SHOP, 60, 7));
    assert!(c.approvals.get(&h).unwrap().used);
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 60, 7)), "APPROVAL_USED");
}

#[test]
fn reject_approval_expired() {
    let (mut c, id) = setup();
    let h = intent_hash(id, SHOP, 60, 7, EXPIRES);
    c.approvals.insert(h, Approval { expires_at_ms: NOW, used: false });
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 60, 7)), "APPROVAL_EXPIRED");
    assert!(!c.approvals.get(&h).unwrap().used);
}

#[test]
fn check_order_follows_prd() {
    let (mut c, id) = setup();
    // not active beats everything
    c.mandates.get_mut(&id).unwrap().status = MandateStatus::Revoked;
    assert_eq!(rejected_code(req(&mut c, id, STRANGER, 0, 1)), "NOT_ACTIVE");
    c.mandates.get_mut(&id).unwrap().status = MandateStatus::Active;
    // recipient beats amount
    assert_eq!(rejected_code(req(&mut c, id, STRANGER, 0, 1)), "RECIPIENT_NOT_ALLOWED");
    // cap beats too-many-open
    c.mandates.get_mut(&id).unwrap().open_requests = MAX_OPEN;
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 101, 1)), "OVER_PER_PAYMENT_CAP");
    // too-many-open beats budget
    c.mandates.get_mut(&id).unwrap().spent = 1000;
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 10, 1)), "TOO_MANY_OPEN");
    // budget beats approval
    c.mandates.get_mut(&id).unwrap().open_requests = 0;
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 60, 1)), "OVER_BUDGET");
}

#[test]
fn rejection_changes_no_state_and_emits_rejected_event() {
    let (mut c, id) = setup();
    let before = (mandate(&c, id).reserved, mandate(&c, id).next_request_id, mandate(&c, id).open_requests);
    assert_eq!(rejected_code(req(&mut c, id, STRANGER, 10, 1)), "RECIPIENT_NOT_ALLOWED");
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "rejected");
    assert_eq!(ev[0]["data"][0]["code"], "RECIPIENT_NOT_ALLOWED");
    let after = (mandate(&c, id).reserved, mandate(&c, id).next_request_id, mandate(&c, id).open_requests);
    assert_eq!(before, after);
    assert!(get_created_receipts().is_empty());
}

// ---------- request_payment: reserve then transfer ----------

#[test]
fn reserves_before_creating_the_transfer_promise() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    // state was written in the same call that created the promises
    let m = mandate(&c, id);
    assert_eq!((m.reserved, m.spent, m.open_requests, m.next_request_id), (40, 0, 1, 2));
    let p = c.get_pending(id, 1).unwrap();
    assert_eq!((p.recipient, p.amount, p.height), (acc(SHOP), U128(40), 1000));

    let receipts = get_created_receipts();
    let mut calls = vec![];
    for r in &receipts {
        for a in &r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, attached_deposit, prepaid_gas, gas_weight, ..
            } = a
            {
                calls.push((
                    r.receiver_id.to_string(),
                    String::from_utf8(method_name.clone()).unwrap(),
                    String::from_utf8(args.clone()).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                    gas_weight.0,
                ));
            }
        }
    }
    assert_eq!(calls.len(), 2, "{calls:?}");
    let ft = calls.iter().find(|c| c.1 == "ft_transfer").unwrap();
    assert_eq!(ft.0, TOKEN);
    assert_eq!((ft.3, ft.4, ft.5), (1, Gas::from_tgas(15).as_gas(), 0));
    let args: Value = serde_json::from_str(&ft.2).unwrap();
    assert_eq!((args["receiver_id"].as_str(), args["amount"].as_str()), (Some(SHOP), Some("40")));
    let cb = calls.iter().find(|c| c.1 == "on_payment_done").unwrap();
    assert_eq!(cb.0, CONTRACT);
    assert_eq!((cb.3, cb.4, cb.5), (0, Gas::from_tgas(15).as_gas(), 0));
    let args: Value = serde_json::from_str(&cb.2).unwrap();
    assert_eq!((args["mandate_id"].as_u64(), args["request_id"].as_u64()), (Some(1), Some(1)));
}

#[test]
fn reserved_event_has_request_id() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "reserved");
    assert_eq!(ev[0]["data"][0]["request_id"], 1);
}

// ---------- callback ----------

#[test]
fn callback_settles_on_success() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    set_callback(PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Settled { request_id: 1 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0));
    assert!(c.get_pending(id, 1).is_none());
    assert_eq!(events(&get_logs())[0]["event"], "settled");
}

#[test]
fn callback_refunds_on_failure() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    set_callback(PromiseResult::Failed);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Refunded { request_id: 1 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (0, 0, 0));
    assert!(c.get_pending(id, 1).is_none());
    assert_eq!(events(&get_logs())[0]["event"], "refunded");
}

#[test]
fn callback_is_idempotent_when_pending_missing() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    set_callback(PromiseResult::Successful(vec![]));
    c.on_payment_done(id, 1);
    set_callback(PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::AlreadyResolved { request_id: 1 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0));
    assert!(events(&get_logs()).is_empty());
}

#[test]
fn callback_only_touches_its_own_request() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 10, 1));
    reserved_id(req(&mut c, id, CAFE, 20, 2));
    set_callback(PromiseResult::Successful(vec![]));
    c.on_payment_done(id, 2);
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (20, 10, 1));
    assert_eq!(pending_count(&c, id), 1);
    assert!(c.get_pending(id, 1).is_some());
}

#[test]
fn mandates_are_isolated() {
    let (mut c, id) = setup();
    let id2 = create_default(&mut c);
    fund(&mut c, TOKEN, OWNER, id2, 500);
    reserved_id(req(&mut c, id2, SHOP, 30, 1));
    assert_eq!(mandate(&c, id).reserved, 0);
    assert_eq!(mandate(&c, id2).reserved, 30);
    assert_eq!(mandate(&c, id).deposited, 1000);
    assert_eq!(mandate(&c, id2).deposited, 500);
}

// ---------- views ----------

#[test]
fn stats_view_matches_mandate() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    let s = c.get_stats(id).unwrap();
    assert_eq!(
        s,
        Stats {
            deposited: U128(1000),
            budget: U128(1000),
            spent: U128(0),
            reserved: U128(40),
            withdrawn: U128(0),
            open_requests: 1
        }
    );
    assert!(c.get_stats(77).is_none());
    assert!(c.get_mandate(77).is_none());
}

#[test]
fn mandate_view_approvals_count_and_remaining() {
    let (mut c, id) = setup();

    // 1. Zero approvals
    let v0 = c.get_mandate(id).unwrap();
    assert_eq!(v0.approvals_count, 0);
    assert_eq!(v0.approvals_remaining, MAX_APPROVALS_PER_MANDATE);

    // Serialization compatibility of old fields and new fields
    let v0_json = serde_json::to_value(&v0).expect("serialize");
    assert_eq!(v0_json["id"], 1);
    assert_eq!(v0_json["owner"], OWNER);
    assert_eq!(v0_json["guardian"], GUARDIAN);
    assert_eq!(v0_json["agent"], AGENT);
    assert_eq!(v0_json["token"], TOKEN);
    assert_eq!(v0_json["budget"], "1000");
    assert_eq!(v0_json["per_payment_cap"], "100");
    assert_eq!(v0_json["approval_threshold"], "50");
    assert_eq!(v0_json["status"], "Active");
    assert_eq!(v0_json["open_requests"], 0);
    assert_eq!(v0_json["next_request_id"], 1);
    assert_eq!(v0_json["approvals_count"], 0);
    assert_eq!(v0_json["approvals_remaining"], MAX_APPROVALS_PER_MANDATE);

    // 2. Partial approvals (e.g., 3 approvals)
    for nonce in 1..=3 {
        approve_as(&mut c, GUARDIAN, id, SHOP, 80, nonce, NOW + 5000);
    }
    let v_partial = c.get_mandate(id).unwrap();
    assert_eq!(v_partial.approvals_count, 3);
    assert_eq!(v_partial.approvals_remaining, MAX_APPROVALS_PER_MANDATE - 3);

    // 3. Full approvals (up to MAX_APPROVALS_PER_MANDATE = 512)
    for nonce in 4..=MAX_APPROVALS_PER_MANDATE as u64 {
        approve_as(&mut c, GUARDIAN, id, SHOP, 80, nonce, NOW + 5000);
    }
    let v_full = c.get_mandate(id).unwrap();
    assert_eq!(v_full.approvals_count, MAX_APPROVALS_PER_MANDATE);
    assert_eq!(v_full.approvals_remaining, 0);
}

// ---------- events ----------

/// Mirror of client/src/events.mjs validateData: the shape the JS parser accepts.
fn assert_js_parser_shape(e: &Value) {
    assert_eq!(e["standard"], "amanat");
    assert_eq!(e["version"], "1.0.0");
    assert!(e["event"].is_string());
    for d in e["data"].as_array().unwrap() {
        assert!(d["mandate_id"].as_u64().is_some());
        if d.get("request_id").is_some() {
            assert!(d["request_id"].as_u64().is_some());
        }
        assert!(d["recipient"].is_string());
        let a = d["amount"].as_str().expect("amount is a string");
        assert!(a == "0" || (!a.starts_with('0') && a.chars().all(|c| c.is_ascii_digit()) && !a.is_empty()));
        if e["event"] == "rejected" {
            assert!(d["code"].is_string());
        }
    }
}

fn wrap(event: &str, data: Value) -> Value {
    json!({"standard":"amanat","version":"1.0.0","event":event,"data":[data]})
}

#[test]
fn every_emitted_event_has_the_shape_the_js_parser_expects() {
    let mut c = Amanat::new();
    let id = create_default(&mut c);
    let created = events(&get_logs());
    fund(&mut c, TOKEN, OWNER, id, 1000);
    let deposited = events(&get_logs());
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    let reserved = events(&get_logs());
    assert_eq!(rejected_code(req(&mut c, id, STRANGER, 5, 2)), "RECIPIENT_NOT_ALLOWED");
    let rejected = events(&get_logs());
    set_callback(PromiseResult::Successful(vec![]));
    c.on_payment_done(id, 1);
    let settled = events(&get_logs());
    reserved_id(req(&mut c, id, CAFE, 25, 3));
    set_callback(PromiseResult::Failed);
    c.on_payment_done(id, 2);
    let refunded = events(&get_logs());

    let all: Vec<Value> = [created, deposited, reserved, rejected, settled, refunded]
        .into_iter()
        .map(|v| {
            assert_eq!(v.len(), 1);
            v.into_iter().next().unwrap()
        })
        .collect();
    for e in &all {
        assert_js_parser_shape(e);
    }
    assert_eq!(
        all[0],
        wrap("mandate_created", json!({
            "mandate_id": 1, "owner": OWNER, "guardian": GUARDIAN, "agent": AGENT, "token": TOKEN,
            "recipient": AGENT, "amount": "1000", "per_payment_cap": "100",
            "approval_threshold": "50", "expires_at_ms": EXPIRES
        }))
    );
    assert_eq!(all[1], wrap("deposited", json!({"mandate_id": 1, "recipient": OWNER, "amount": "1000"})));
    assert_eq!(all[2], wrap("reserved", json!({"mandate_id": 1, "request_id": 1, "recipient": SHOP, "amount": "40"})));
    assert_eq!(all[3], wrap("rejected", json!({"mandate_id": 1, "recipient": STRANGER, "amount": "5", "code": "RECIPIENT_NOT_ALLOWED"})));
    assert_eq!(all[4], wrap("settled", json!({"mandate_id": 1, "request_id": 1, "recipient": SHOP, "amount": "40"})));
    assert_eq!(all[5], wrap("refunded", json!({"mandate_id": 1, "request_id": 2, "recipient": CAFE, "amount": "25"})));
}

// ---------- property-style invariants over a mixed run ----------

#[test]
fn invariants_hold_over_a_mixed_run() {
    let (mut c, id) = setup();
    for n in 0..20u64 {
        let amount = (n % 7 + 1) as u128 * 10;
        let r = req(&mut c, id, if n % 2 == 0 { SHOP } else { CAFE }, amount.min(50), n);
        if let PromiseOrValue::Promise(_) = r {
            if n % 3 == 0 {
                set_callback(PromiseResult::Failed);
            } else {
                set_callback(PromiseResult::Successful(vec![]));
            }
            let rid = mandate(&c, id).next_request_id - 1;
            c.on_payment_done(id, rid);
        }
        let m = mandate(&c, id);
        assert!(m.spent + m.reserved <= m.budget);
        assert!(m.budget <= m.deposited);
        assert!(m.open_requests <= MAX_OPEN);
        assert_eq!(m.open_requests, pending_count(&c, id));
    }
}

// =====================================================================================
// K2: guardian/owner roles. Written before the implementation (stubs panic: red first).
// =====================================================================================

const ONE_NEAR_MILLI: u128 = 10u128.pow(21);

fn panics_with(code: &str, f: impl FnOnce()) {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .expect_err(&format!("expected panic {code}"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(code), "panic was {msg:?}, wanted {code}");
}

fn req_at(c: &mut Amanat, id: u64, recipient: &str, amount: u128, nonce: u64, ts_ms: u64) -> PromiseOrValue<PaymentResult> {
    set_at(AGENT, ts_ms);
    c.request_payment(id, acc(recipient), U128(amount), nonce)
}

fn approve_as(c: &mut Amanat, who: &str, id: u64, recipient: &str, amount: u128, nonce: u64, exp: u64) {
    set_with_deposit(who, STORAGE_DEPOSIT_PER_APPROVAL);
    c.approve_intent(id, acc(recipient), U128(amount), nonce, exp);
}

fn tighten_as(c: &mut Amanat, who: &str, id: u64, ch: Change) {
    set(who);
    c.tighten(id, ch);
}

fn loosen_as(c: &mut Amanat, who: &str, id: u64, ch: Change) {
    set(who);
    c.loosen(id, ch);
}

fn revoke_as(c: &mut Amanat, who: &str, id: u64) {
    set(who);
    c.revoke(id);
}

fn withdraw_as(c: &mut Amanat, who: &str, id: u64, amount: u128) {
    set(who);
    let _ = c.withdraw(id, U128(amount));
}

fn resolve_at(c: &mut Amanat, who: &str, height: u64, id: u64, rid: u64, transferred: bool) {
    testing_env!(ctx_full(who, NOW, 100, height).build());
    c.resolve_stale(id, rid, transferred);
}

fn stale_height() -> u64 {
    1000 + STALE_BLOCKS
}

fn withdraw_cb(c: &mut Amanat, id: u64, amount: u128, result: PromiseResult) -> bool {
    set_callback(result);
    c.on_withdraw_done(id, U128(amount))
}

fn settle(c: &mut Amanat, id: u64, rid: u64, ok: bool) -> PaymentResult {
    set_callback(if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_payment_done(id, rid)
}

/// (receiver, method, args, attached yocto, prepaid gas, gas weight) of every call receipt.
fn function_calls() -> Vec<(String, String, String, u128, u64, u64)> {
    let mut calls = vec![];
    for r in &get_created_receipts() {
        for a in &r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, attached_deposit, prepaid_gas, gas_weight, ..
            } = a
            {
                calls.push((
                    r.receiver_id.to_string(),
                    String::from_utf8(method_name.clone()).unwrap(),
                    String::from_utf8(args.clone()).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                    gas_weight.0,
                ));
            }
        }
    }
    calls
}

fn approval_hex(id: u64, recipient: &str, amount: u128, nonce: u64, expires: u64) -> String {
    hex(&intent_hash(id, recipient, amount, nonce, expires))
}

/// Active mandate 1 with budget tightened to 900 so every loosen has room.
fn world_active() -> (Amanat, u64) {
    let (mut c, id) = setup();
    tighten_as(&mut c, GUARDIAN, id, Change::Budget(U128(900)));
    (c, id)
}

/// Revoked mandate with one open request (10 reserved, Pending id 1 at height 1000).
fn world_revoked_with_pending() -> (Amanat, u64) {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 10, 1));
    revoke_as(&mut c, OWNER, id);
    (c, id)
}

// ---------- fixes found in the K1 review ----------

#[test]
#[should_panic(expected = "INSUFFICIENT_STORAGE_DEPOSIT")]
fn create_mandate_without_deposit_panics() {
    let mut c = Amanat::new();
    set(OWNER);
    c.create_mandate(acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES);
}

#[test]
fn create_mandate_deposit_boundary_is_exactly_0_05_near() {
    assert_eq!(STORAGE_DEPOSIT_PER_MANDATE.as_yoctonear(), 50 * ONE_NEAR_MILLI);
    let mut c = Amanat::new();
    set_with_deposit(OWNER, NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_MANDATE.as_yoctonear() - 1));
    panics_with("INSUFFICIENT_STORAGE_DEPOSIT", || {
        c.create_mandate(acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES);
    });
    assert!(c.get_mandate(1).is_none(), "nothing stored by the rejected call");
    assert_eq!(create_default(&mut c), 1); // exactly the minimum is accepted
    set_with_deposit(OWNER, NearToken::from_near(1)); // more is fine too
    assert_eq!(
        c.create_mandate(acc(AGENT), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES),
        2
    );
}

#[test]
fn approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it() {
    let (mut c, id) = setup();
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    // the stored key uses mandate.expires_at_ms (EXPIRES), not the approval's own time
    assert!(c.get_approval(approval_hex(id, SHOP, 80, 7, EXPIRES)).is_some());
    assert!(c.get_approval(approval_hex(id, SHOP, 80, 7, NOW + 5000)).is_none());
    tighten_as(&mut c, OWNER, id, Change::Expiry(EXPIRES - 1));
    // earlier approval stops matching: fails safe as NEEDS_APPROVAL
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 80, 7)), "NEEDS_APPROVAL");
    // the guardian can approve again under the new expiry
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    reserved_id(req(&mut c, id, SHOP, 80, 7));
}

#[test]
fn recipient_list_and_set_stay_in_sync_on_add_and_remove() {
    let (mut c, id) = setup();
    let view = |c: &Amanat| c.get_mandate(id).unwrap().recipients;
    assert_eq!(view(&c), vec![acc(SHOP), acc(CAFE)]);
    loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc("new.testnet")));
    assert_eq!(view(&c), vec![acc(SHOP), acc(CAFE), acc("new.testnet")]);
    reserved_id(req(&mut c, id, "new.testnet", 10, 1)); // set knows it too
    tighten_as(&mut c, OWNER, id, Change::RemoveRecipient(acc(SHOP)));
    assert_eq!(view(&c), vec![acc(CAFE), acc("new.testnet")]);
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 10, 2)), "RECIPIENT_NOT_ALLOWED");
    tighten_as(&mut c, GUARDIAN, id, Change::RemoveRecipient(acc(CAFE)));
    assert_eq!(view(&c), vec![acc("new.testnet")]);
    loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc(SHOP))); // re-adding works
    assert_eq!(view(&c), vec![acc("new.testnet"), acc(SHOP)]);
    reserved_id(req(&mut c, id, SHOP, 10, 3));
    for r in view(&c) {
        assert!(c.recipients.contains(&(id, r)));
    }
    assert!(!c.recipients.contains(&(id, acc(CAFE))));
}

// ---------- approve_intent ----------

#[test]
fn approve_intent_stores_hash_and_emits_event() {
    let (mut c, id) = setup();
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    let a = c.get_approval(approval_hex(id, SHOP, 80, 7, EXPIRES)).unwrap();
    assert_eq!(a, Approval { expires_at_ms: NOW + 5000, used: false });
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_js_parser_shape(&ev[0]);
    assert_eq!(
        ev[0],
        wrap("intent_approved", json!({
            "mandate_id": 1, "recipient": SHOP, "amount": "80", "nonce": 7,
            "approval_expires_at_ms": NOW + 5000,
            "intent_hash": approval_hex(id, SHOP, 80, 7, EXPIRES)
        }))
    );
}

#[test]
fn approve_intent_rejects_past_or_present_validity_time() {
    let (mut c, id) = setup();
    panics_with("APPROVAL_NOT_IN_FUTURE", || approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW));
    panics_with("APPROVAL_NOT_IN_FUTURE", || approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW - 1));
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 1); // one ms ahead is fine
}

#[test]
fn approve_intent_requires_active_and_existing_mandate() {
    let (mut c, id) = setup();
    panics_with("MANDATE_NOT_FOUND", || approve_as(&mut c, GUARDIAN, 99, SHOP, 80, 7, NOW + 5000));
    revoke_as(&mut c, OWNER, id);
    panics_with("NOT_ACTIVE", || approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000));
}

#[test]
fn approve_intent_rejects_duplicates_even_after_the_approval_was_used() {
    let (mut c, id) = setup();
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    panics_with("ALREADY_APPROVED", || approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 9000));
    assert_eq!(c.get_approval(approval_hex(id, SHOP, 80, 7, EXPIRES)).unwrap().expires_at_ms, NOW + 5000);
    reserved_id(req(&mut c, id, SHOP, 80, 7)); // consumes it
    // re-approving a USED hash must not reset `used` (that would allow a replay)
    panics_with("ALREADY_APPROVED", || approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 9000));
    assert!(c.get_approval(approval_hex(id, SHOP, 80, 7, EXPIRES)).unwrap().used);
}

/// K-C: the per-mandate approval table is capped; the 513th entry is refused and
/// the counter never exceeds the cap.
#[test]
fn approve_intent_caps_entries_per_mandate() {
    let (mut c, id) = setup();
    for nonce in 1..=MAX_APPROVALS_PER_MANDATE as u64 {
        approve_as(&mut c, GUARDIAN, id, SHOP, 80, nonce, NOW + 5000);
    }
    assert_eq!(mandate(&c, id).approvals_count, MAX_APPROVALS_PER_MANDATE);
    panics_with("TOO_MANY_APPROVALS", || {
        approve_as(&mut c, GUARDIAN, id, SHOP, 80, 9999, NOW + 5000)
    });
    assert_eq!(mandate(&c, id).approvals_count, MAX_APPROVALS_PER_MANDATE);
    assert!(c.get_approval(approval_hex(id, SHOP, 80, 9999, EXPIRES)).is_none());
    // a duplicate is rejected before the cap check and does not consume a slot
    panics_with("ALREADY_APPROVED", || {
        approve_as(&mut c, GUARDIAN, id, SHOP, 80, 1, NOW + 5000)
    });
    assert_eq!(mandate(&c, id).approvals_count, MAX_APPROVALS_PER_MANDATE);
}

#[test]
fn approve_then_request_round_trip_over_threshold() {
    let (mut c, id) = setup(); // threshold 50, cap 100
    // not approved: NEEDS_APPROVAL
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 80, 7)), "NEEDS_APPROVAL");
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    // nonce, amount and recipient mismatches are not approved
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 80, 8)), "NEEDS_APPROVAL");
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 81, 7)), "NEEDS_APPROVAL");
    assert_eq!(rejected_code(req(&mut c, id, CAFE, 80, 7)), "NEEDS_APPROVAL");
    // approved: passes and is consumed
    reserved_id(req(&mut c, id, SHOP, 80, 7));
    assert!(c.get_approval(approval_hex(id, SHOP, 80, 7, EXPIRES)).unwrap().used);
    // reused: APPROVAL_USED
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 80, 7)), "APPROVAL_USED");
    assert_eq!(mandate(&c, id).reserved, 80);
}

#[test]
fn approved_request_expires_at_the_approval_time() {
    let (mut c, id) = setup();
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 1000);
    assert_eq!(rejected_code(req_at(&mut c, id, SHOP, 80, 7, NOW + 1000)), "APPROVAL_EXPIRED");
    reserved_id(req_at(&mut c, id, SHOP, 80, 7, NOW + 999));
}

// ---------- tighten: direction and boundaries ----------

#[test]
fn tighten_budget_boundaries() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 10, 1)); // reserved 10
    settle(&mut c, id, 1, true); // spent 10
    reserved_id(req(&mut c, id, CAFE, 20, 2)); // reserved 20, committed 30
    panics_with("NOT_STRICTER", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(1000))));
    panics_with("NOT_STRICTER", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(1001))));
    panics_with("BUDGET_BELOW_COMMITTED", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(29))));
    // K-A: budget may never fall below the cap (100), even when everything is committed.
    panics_with("BUDGET_BELOW_CAP", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(30))));
    panics_with("BUDGET_BELOW_CAP", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(99))));
    // Walk cap and threshold down first, then the budget can reach spent + reserved.
    tighten_as(&mut c, OWNER, id, Change::ApprovalThreshold(U128(30)));
    tighten_as(&mut c, OWNER, id, Change::PerPaymentCap(U128(30)));
    tighten_as(&mut c, OWNER, id, Change::Budget(U128(30))); // == spent + reserved == cap
    let m = mandate(&c, id);
    assert_eq!((m.budget, m.per_payment_cap, m.approval_threshold), (30, 30, 30));
    let ev = events(&get_logs());
    assert_eq!(ev[0]["event"], "tightened");
    panics_with("NOT_STRICTER", || tighten_as(&mut c, GUARDIAN, id, Change::Budget(U128(30))));
}

#[test]
fn tighten_cap_threshold_boundaries() {
    let (mut c, id) = setup(); // cap 100, threshold 50
    for v in [100u128, 101] {
        panics_with("NOT_STRICTER", || tighten_as(&mut c, OWNER, id, Change::PerPaymentCap(U128(v))));
    }
    // K-A: cap may not be tightened below approval_threshold (50)
    panics_with("CAP_BELOW_THRESHOLD", || tighten_as(&mut c, OWNER, id, Change::PerPaymentCap(U128(49))));
    tighten_as(&mut c, OWNER, id, Change::PerPaymentCap(U128(99)));
    assert_eq!(mandate(&c, id).per_payment_cap, 99);
    for v in [50u128, 51] {
        panics_with("NOT_STRICTER", || tighten_as(&mut c, GUARDIAN, id, Change::ApprovalThreshold(U128(v))));
    }
    tighten_as(&mut c, GUARDIAN, id, Change::ApprovalThreshold(U128(49)));
    assert_eq!(mandate(&c, id).approval_threshold, 49);
}

#[test]
fn tighten_recipients_only_removes_and_only_existing() {
    let (mut c, id) = setup();
    panics_with("NO_SUCH_RECIPIENT", || tighten_as(&mut c, OWNER, id, Change::RemoveRecipient(acc("ghost.testnet"))));
    panics_with("NOT_STRICTER", || tighten_as(&mut c, OWNER, id, Change::AddRecipient(acc("new.testnet"))));
    tighten_as(&mut c, OWNER, id, Change::RemoveRecipient(acc(SHOP)));
    assert_eq!(c.get_mandate(id).unwrap().recipients, vec![acc(CAFE)]);
    panics_with("NO_SUCH_RECIPIENT", || tighten_as(&mut c, OWNER, id, Change::RemoveRecipient(acc(SHOP))));
}

#[test]
fn tighten_expiry_must_move_earlier_but_stay_in_the_future() {
    let (mut c, id) = setup();
    for v in [EXPIRES, EXPIRES + 1] {
        panics_with("NOT_STRICTER", || tighten_as(&mut c, OWNER, id, Change::Expiry(v)));
    }
    for v in [NOW, NOW - 1] {
        panics_with("EXPIRY_NOT_IN_FUTURE", || tighten_as(&mut c, OWNER, id, Change::Expiry(v)));
    }
    tighten_as(&mut c, OWNER, id, Change::Expiry(NOW + 1));
    assert_eq!(mandate(&c, id).expires_at_ms, NOW + 1);
}

#[test]
fn tighten_requires_active_and_existing_mandate() {
    let (mut c, id) = setup();
    panics_with("MANDATE_NOT_FOUND", || tighten_as(&mut c, OWNER, 42, Change::Budget(U128(1))));
    revoke_as(&mut c, OWNER, id);
    panics_with("NOT_ACTIVE", || tighten_as(&mut c, OWNER, id, Change::Budget(U128(5))));
}

#[test]
fn tighten_event_carries_the_change() {
    let (mut c, id) = setup();
    tighten_as(&mut c, GUARDIAN, id, Change::PerPaymentCap(U128(70)));
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_js_parser_shape(&ev[0]);
    assert_eq!(
        ev[0],
        wrap("tightened", json!({
            "mandate_id": 1, "recipient": AGENT, "amount": "70", "by": GUARDIAN,
            "change": {"PerPaymentCap": "70"}
        }))
    );
    tighten_as(&mut c, OWNER, id, Change::RemoveRecipient(acc(SHOP)));
    let ev = events(&get_logs());
    assert_js_parser_shape(&ev[0]);
    assert_eq!(ev[0]["data"][0]["recipient"], SHOP);
    assert_eq!(ev[0]["data"][0]["change"], json!({"RemoveRecipient": SHOP}));
}

// ---------- loosen: direction and boundaries ----------

#[test]
fn loosen_budget_boundaries() {
    let (mut c, id) = world_active(); // budget 900, deposited 1000
    panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(900))));
    panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(899))));
    panics_with("BUDGET_ABOVE_DEPOSITED", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(1001))));
    loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(1000))); // == deposited
    assert_eq!(mandate(&c, id).budget, 1000);
    assert_eq!(events(&get_logs())[0]["event"], "loosened");
    panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(1000))));
    panics_with("BUDGET_ABOVE_DEPOSITED", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(1001))));
}

#[test]
fn loosen_cap_and_threshold_boundaries() {
    let (mut c, id) = world_active(); // budget 900, cap 100, threshold 50
    for v in [100u128, 99] {
        panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::PerPaymentCap(U128(v))));
    }
    panics_with("CAP_ABOVE_BUDGET", || loosen_as(&mut c, GUARDIAN, id, Change::PerPaymentCap(U128(901))));
    loosen_as(&mut c, GUARDIAN, id, Change::PerPaymentCap(U128(900))); // == budget
    assert_eq!(mandate(&c, id).per_payment_cap, 900);
    for v in [50u128, 49] {
        panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::ApprovalThreshold(U128(v))));
    }
    panics_with("THRESHOLD_ABOVE_CAP", || loosen_as(&mut c, GUARDIAN, id, Change::ApprovalThreshold(U128(901))));
    loosen_as(&mut c, GUARDIAN, id, Change::ApprovalThreshold(U128(900))); // == cap
    assert_eq!(mandate(&c, id).approval_threshold, 900);
}

#[test]
fn loosen_recipients_only_adds_valid_new_ones_up_to_16() {
    let (mut c, id) = setup(); // 2 recipients
    panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::RemoveRecipient(acc(SHOP))));
    panics_with("DUPLICATE_RECIPIENT", || loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc(SHOP))));
    for i in 0..14 {
        loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc(&format!("r{i}.testnet"))));
    }
    assert_eq!(c.get_mandate(id).unwrap().recipients.len(), 16);
    panics_with("TOO_MANY_RECIPIENTS", || loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc("r99.testnet"))));
    assert_eq!(c.get_mandate(id).unwrap().recipients.len(), 16);
    assert!(!c.recipients.contains(&(id, acc("r99.testnet"))));
    // removing one frees a slot again
    tighten_as(&mut c, GUARDIAN, id, Change::RemoveRecipient(acc("r0.testnet")));
    loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc("r99.testnet")));
}

#[test]
fn loosen_expiry_must_move_later() {
    let (mut c, id) = setup();
    for v in [EXPIRES, EXPIRES - 1] {
        panics_with("NOT_LOOSER", || loosen_as(&mut c, GUARDIAN, id, Change::Expiry(v)));
    }
    loosen_as(&mut c, GUARDIAN, id, Change::Expiry(EXPIRES + 1));
    assert_eq!(mandate(&c, id).expires_at_ms, EXPIRES + 1);
}

#[test]
fn loosen_requires_active_mandate_and_emits_change() {
    let (mut c, id) = world_active();
    loosen_as(&mut c, GUARDIAN, id, Change::AddRecipient(acc("new.testnet")));
    let ev = events(&get_logs());
    assert_js_parser_shape(&ev[0]);
    assert_eq!(
        ev[0],
        wrap("loosened", json!({
            "mandate_id": 1, "recipient": "new.testnet", "amount": "0", "by": GUARDIAN,
            "change": {"AddRecipient": "new.testnet"}
        }))
    );
    revoke_as(&mut c, GUARDIAN, id);
    panics_with("NOT_ACTIVE", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(950))));
}

#[test]
fn change_json_is_stable() {
    let cases = [
        (Change::Budget(U128(500)), json!({"Budget": "500"})),
        (Change::PerPaymentCap(U128(50)), json!({"PerPaymentCap": "50"})),
        (Change::ApprovalThreshold(U128(10)), json!({"ApprovalThreshold": "10"})),
        (Change::AddRecipient(acc(SHOP)), json!({"AddRecipient": SHOP})),
        (Change::RemoveRecipient(acc(SHOP)), json!({"RemoveRecipient": SHOP})),
        (Change::Expiry(1_893_456_000_000), json!({"Expiry": 1_893_456_000_000u64})),
    ];
    for (change, expected) in cases {
        assert_eq!(serde_json::to_value(&change).unwrap(), expected);
        assert_eq!(serde_json::from_value::<Change>(expected).unwrap(), change);
    }
}

// ---------- revoke ----------

#[test]
fn revoke_by_owner_or_guardian_then_second_revoke_panics() {
    for who in [OWNER, GUARDIAN] {
        let (mut c, id) = setup();
        revoke_as(&mut c, who, id);
        assert_eq!(mandate(&c, id).status, MandateStatus::Revoked);
        let ev = events(&get_logs());
        assert_eq!(ev.len(), 1);
        assert_js_parser_shape(&ev[0]);
        assert_eq!(ev[0]["event"], "revoked");
        assert_eq!(ev[0]["data"][0]["by"], who);
        panics_with("ALREADY_REVOKED", || revoke_as(&mut c, who, id));
        assert_eq!(rejected_code(req(&mut c, id, SHOP, 10, 1)), "NOT_ACTIVE");
    }
}

#[test]
fn revoke_does_not_cancel_in_flight_requests_and_callbacks_still_settle_or_refund() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    reserved_id(req(&mut c, id, CAFE, 25, 2));
    revoke_as(&mut c, GUARDIAN, id);
    let m = mandate(&c, id);
    assert_eq!((m.reserved, m.open_requests), (65, 2));
    assert!(c.get_pending(id, 1).is_some() && c.get_pending(id, 2).is_some());
    set_callback(PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Settled { request_id: 1 });
    set_callback(PromiseResult::Failed);
    assert_eq!(c.on_payment_done(id, 2), PaymentResult::Refunded { request_id: 2 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests, m.status.clone()), (40, 0, 0, MandateStatus::Revoked));
}

// ---------- withdraw ----------

#[test]
fn withdraw_needs_an_explicit_revoke_even_after_expiry() {
    // Audit F1: an expired but still-Active mandate could be revived by `loosen(Expiry)` after a
    // withdraw, so the exit path is open ONLY once the mandate is Revoked.
    let (mut c, id) = setup();
    panics_with("MANDATE_STILL_ACTIVE", || withdraw_as(&mut c, OWNER, id, 1));
    set_at(OWNER, EXPIRES);
    panics_with("MANDATE_STILL_ACTIVE", || {
        let _ = c.withdraw(id, U128(100));
    });
    assert_eq!(mandate(&c, id).withdrawn, 0);
    revoke_as(&mut c, OWNER, id);
    withdraw_as(&mut c, OWNER, id, 100);
    assert_eq!(mandate(&c, id).withdrawn, 100);
}

#[test]
fn budget_ceiling_never_counts_tokens_already_withdrawn() {
    // Audit F1: ceiling = min(budget, deposited - withdrawn). Force the state directly
    // (withdrawn 600 of 1000 deposited): only 400 can still be paid, 50 at a time (the threshold).
    let (mut c, id) = setup();
    c.mandates.get_mut(&id).unwrap().withdrawn = 600;
    for n in 1..=8 {
        reserved_id(req(&mut c, id, SHOP, 50, n));
    }
    assert!(matches!(
        req(&mut c, id, SHOP, 1, 9),
        PromiseOrValue::Value(PaymentResult::Rejected { ref code }) if code == "OVER_BUDGET"
    ));
}

#[test]
fn loosen_budget_cannot_exceed_deposited_minus_withdrawn() {
    let (mut c, id) = setup();
    let m = mandate(&c, id);
    let (budget, deposited) = (m.budget, m.deposited);
    c.mandates.get_mut(&id).unwrap().withdrawn = deposited - budget / 2; // only budget/2 is still really there
    // a budget above deposited - withdrawn is refused even though it is below `deposited`
    panics_with("BUDGET_ABOVE_DEPOSITED", || loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(budget + 1))));
}

#[test]
fn approve_intent_needs_the_storage_deposit() {
    // Audit F3: the guardian pays for the permanent approval entry.
    let (mut c, id) = world_active();
    set(GUARDIAN);
    panics_with("INSUFFICIENT_APPROVAL_DEPOSIT", || c.approve_intent(id, acc(SHOP), U128(80), 7, NOW + 5000));
    set_with_deposit(GUARDIAN, NearToken::from_yoctonear(STORAGE_DEPOSIT_PER_APPROVAL.as_yoctonear() - 1));
    panics_with("INSUFFICIENT_APPROVAL_DEPOSIT", || c.approve_intent(id, acc(SHOP), U128(80), 7, NOW + 5000));
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
}

#[test]
fn revoke_after_inconsistent_accounting_does_not_underflow() {
    // Audit F1 side effect: `revoke` used a plain subtraction that could panic on bad state.
    let (mut c, id) = setup();
    {
        let m = c.mandates.get_mut(&id).unwrap();
        m.spent = 700;
        m.withdrawn = 700;
    }
    revoke_as(&mut c, OWNER, id);
    assert_eq!(mandate(&c, id).status, MandateStatus::Revoked);
}

#[test]
fn withdraw_only_the_free_remainder_and_increments_before_the_promise() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 10, 1));
    settle(&mut c, id, 1, true); // spent 10
    reserved_id(req(&mut c, id, CAFE, 20, 2)); // reserved 20, free = 1000 - 10 - 20 = 970
    revoke_as(&mut c, OWNER, id);
    panics_with("ZERO_AMOUNT", || withdraw_as(&mut c, OWNER, id, 0));
    panics_with("AMOUNT_EXCEEDS_FREE", || withdraw_as(&mut c, OWNER, id, 971));
    assert_eq!(mandate(&c, id).withdrawn, 0);
    withdraw_as(&mut c, OWNER, id, 970);
    assert_eq!(mandate(&c, id).withdrawn, 970); // written before the callback ran
    panics_with("AMOUNT_EXCEEDS_FREE", || withdraw_as(&mut c, OWNER, id, 1));
}

#[test]
fn withdraw_creates_ft_transfer_to_owner_and_callback() {
    let (mut c, id) = world_revoked_with_pending(); // free = 990
    withdraw_as(&mut c, OWNER, id, 400);
    let calls = function_calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    let ft = calls.iter().find(|c| c.1 == "ft_transfer").unwrap();
    assert_eq!(ft.0, TOKEN);
    assert_eq!((ft.3, ft.4, ft.5), (1, Gas::from_tgas(15).as_gas(), 0));
    let args: Value = serde_json::from_str(&ft.2).unwrap();
    assert_eq!((args["receiver_id"].as_str(), args["amount"].as_str()), (Some(OWNER), Some("400")));
    let cb = calls.iter().find(|c| c.1 == "on_withdraw_done").unwrap();
    assert_eq!(cb.0, CONTRACT);
    assert_eq!((cb.3, cb.4, cb.5), (0, Gas::from_tgas(15).as_gas(), 0));
    let args: Value = serde_json::from_str(&cb.2).unwrap();
    assert_eq!((args["mandate_id"].as_u64(), args["amount"].as_str()), (Some(1), Some("400")));
    assert!(events(&get_logs()).is_empty(), "withdrawn is emitted by the callback only");
}

#[test]
fn withdraw_callback_success_keeps_withdrawn_and_emits_event() {
    let (mut c, id) = world_revoked_with_pending();
    withdraw_as(&mut c, OWNER, id, 400);
    assert!(withdraw_cb(&mut c, id, 400, PromiseResult::Successful(vec![])));
    assert_eq!(mandate(&c, id).withdrawn, 400);
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_js_parser_shape(&ev[0]);
    assert_eq!(ev[0], wrap("withdrawn", json!({"mandate_id": 1, "recipient": OWNER, "amount": "400"})));
}

#[test]
fn withdraw_callback_failure_restores_withdrawn_and_emits_nothing() {
    let (mut c, id) = world_revoked_with_pending();
    withdraw_as(&mut c, OWNER, id, 400);
    assert_eq!(mandate(&c, id).withdrawn, 400);
    assert!(!withdraw_cb(&mut c, id, 400, PromiseResult::Failed));
    assert_eq!(mandate(&c, id).withdrawn, 0);
    assert!(events(&get_logs()).is_empty());
    // the full free remainder can be withdrawn again
    withdraw_as(&mut c, OWNER, id, 990);
    assert_eq!(mandate(&c, id).withdrawn, 990);
}

#[test]
fn withdraw_needs_enough_prepaid_gas_for_the_callback() {
    let (mut c, id) = world_revoked_with_pending();
    testing_env!(ctx_full(OWNER, NOW, 59, 1000).build());
    panics_with("INSUFFICIENT_GAS", || {
        let _ = c.withdraw(id, U128(1));
    });
    assert_eq!(mandate(&c, id).withdrawn, 0);
    testing_env!(ctx_full(OWNER, NOW, 60, 1000).build());
    let _ = c.withdraw(id, U128(1));
}

#[test]
fn withdraw_unknown_mandate_panics() {
    let (mut c, _) = setup();
    panics_with("MANDATE_NOT_FOUND", || withdraw_as(&mut c, OWNER, 9, 1));
}

// ---------- resolve_stale ----------

#[test]
fn resolve_stale_before_stale_blocks_panics_and_at_blocks_works() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1)); // Pending height 1000
    panics_with("NOT_STALE_YET", || resolve_at(&mut c, GUARDIAN, 1000, id, 1, true));
    panics_with("NOT_STALE_YET", || resolve_at(&mut c, GUARDIAN, stale_height() - 1, id, 1, true));
    assert!(c.get_pending(id, 1).is_some());
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, true);
    assert!(c.get_pending(id, 1).is_none());
}

#[test]
fn resolve_stale_transferred_true_settles() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, true);
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0));
    let ev = events(&get_logs());
    assert_eq!(ev.len(), 1);
    assert_js_parser_shape(&ev[0]);
    assert_eq!(
        ev[0],
        wrap("stale_resolved", json!({
            "mandate_id": 1, "request_id": 1, "recipient": SHOP, "amount": "40", "transferred": true
        }))
    );
}

#[test]
fn resolve_stale_transferred_false_refunds() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, false);
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (0, 0, 0));
    assert_eq!(events(&get_logs())[0]["data"][0]["transferred"], false);
}

#[test]
fn resolve_stale_second_call_and_unknown_request_panic() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, true);
    panics_with("NO_SUCH_PENDING", || resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, true));
    panics_with("NO_SUCH_PENDING", || resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, false));
    panics_with("NO_SUCH_PENDING", || resolve_at(&mut c, GUARDIAN, stale_height(), id, 77, false));
    panics_with("MANDATE_NOT_FOUND", || resolve_at(&mut c, GUARDIAN, stale_height(), 5, 1, false));
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0)); // counted once
}

#[test]
fn resolve_stale_works_on_revoked_mandates_and_late_callback_is_a_no_op() {
    let (mut c, id) = world_revoked_with_pending();
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, false);
    assert_eq!(mandate(&c, id).reserved, 0);
    set_callback(PromiseResult::Successful(vec![]));
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::AlreadyResolved { request_id: 1 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (0, 0, 0));
}

// ---------- role matrix: method x caller ----------

const ROLES: [&str; 4] = [OWNER, GUARDIAN, AGENT, STRANGER];

fn attempt(method: &str, caller: &str) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match method {
        "approve_intent" => {
            let (mut c, id) = world_active();
            approve_as(&mut c, caller, id, SHOP, 80, 7, NOW + 5000);
        }
        "tighten" => {
            let (mut c, id) = world_active();
            tighten_as(&mut c, caller, id, Change::PerPaymentCap(U128(90)));
        }
        "loosen" => {
            let (mut c, id) = world_active();
            loosen_as(&mut c, caller, id, Change::PerPaymentCap(U128(110)));
        }
        "revoke" => {
            let (mut c, id) = world_active();
            revoke_as(&mut c, caller, id);
        }
        "withdraw" => {
            let (mut c, id) = world_revoked_with_pending();
            withdraw_as(&mut c, caller, id, 100);
        }
        "resolve_stale" => {
            let (mut c, id) = world_revoked_with_pending();
            resolve_at(&mut c, caller, stale_height(), id, 1, true);
        }
        "request_payment" => {
            let (mut c, id) = world_active();
            let _ = req_as(&mut c, caller, id);
        }
        _ => unreachable!(),
    }))
    .is_ok()
}

fn req_as(c: &mut Amanat, who: &str, id: u64) -> PromiseOrValue<PaymentResult> {
    set(who);
    c.request_payment(id, acc(SHOP), U128(10), 1)
}

#[test]
fn role_matrix_allowed_and_denied() {
    // method -> callers allowed; everyone else must be denied (panic)
    let matrix: [(&str, &[&str]); 7] = [
        ("approve_intent", &[GUARDIAN]),
        ("tighten", &[OWNER, GUARDIAN]),
        ("loosen", &[GUARDIAN]),
        ("revoke", &[OWNER, GUARDIAN]),
        ("withdraw", &[OWNER]),
        ("resolve_stale", &[GUARDIAN]),
        ("request_payment", &[AGENT]),
    ];
    for (method, allowed) in matrix {
        for role in ROLES {
            assert_eq!(
                attempt(method, role),
                allowed.contains(&role),
                "{method} called by {role}: expected allowed={}",
                allowed.contains(&role)
            );
        }
    }
}

#[test]
fn denied_calls_change_nothing() {
    let (mut c, id) = world_active();
    let snapshot = |c: &Amanat| {
        let m = c.get_mandate(id).unwrap();
        (m.budget, m.per_payment_cap, m.approval_threshold, m.expires_at_ms, m.status, m.recipients)
    };
    let before = snapshot(&c);
    for who in [AGENT, STRANGER] {
        panics_with("UNAUTHORIZED_OWNER_OR_GUARDIAN", || tighten_as(&mut c, who, id, Change::Budget(U128(1))));
        panics_with("UNAUTHORIZED_GUARDIAN", || loosen_as(&mut c, who, id, Change::Budget(U128(950))));
        panics_with("UNAUTHORIZED_OWNER_OR_GUARDIAN", || revoke_as(&mut c, who, id));
        panics_with("UNAUTHORIZED_GUARDIAN", || approve_as(&mut c, who, id, SHOP, 80, 7, NOW + 5000));
    }
    // the owner cannot loosen either (only the guardian can)
    panics_with("UNAUTHORIZED_GUARDIAN", || loosen_as(&mut c, OWNER, id, Change::Budget(U128(950))));
    assert_eq!(before, snapshot(&c));
}

#[test]
fn withdraw_and_resolve_stale_deny_the_wrong_roles_with_clear_codes() {
    let (mut c, id) = world_revoked_with_pending();
    for who in [GUARDIAN, AGENT, STRANGER] {
        panics_with("UNAUTHORIZED_OWNER", || withdraw_as(&mut c, who, id, 1));
    }
    for who in [OWNER, AGENT, STRANGER] {
        panics_with("UNAUTHORIZED_GUARDIAN", || resolve_at(&mut c, who, stale_height(), id, 1, true));
    }
    assert_eq!(mandate(&c, id).withdrawn, 0);
    assert!(c.get_pending(id, 1).is_some());
}

// ---------- invariants (PRD 5.3) over a scripted sequence ----------

/// `held` = tokens the token contract holds for this mandate, tracked by the TEST from the
/// transfers that actually landed (independent of the contract's counters);
/// `in_flight` = withdraw promise not yet resolved.
fn check_invariants(c: &Amanat, id: u64, held: u128, in_flight: u128) {
    let m = mandate(c, id);
    assert!(m.spent + m.reserved <= m.budget, "5.3 #1 spent+reserved <= budget");
    assert!(m.budget <= m.deposited, "5.3 #1 budget <= deposited");
    let remaining = held
        .checked_sub(m.reserved + in_flight)
        .expect("tokens held must cover reserved and in-flight withdrawals");
    assert_eq!(m.deposited, m.spent + m.reserved + m.withdrawn + remaining, "5.3 #3 conservation");
    assert!(m.open_requests <= MAX_OPEN, "5.3 #7");
    assert_eq!(m.open_requests, pending_count(c, id), "5.3 #7");
}

#[test]
fn fund_conservation_holds_over_a_scripted_sequence() {
    let (mut c, id) = setup();
    let mut held = 1000u128;
    check_invariants(&c, id, held, 0);

    reserved_id(req(&mut c, id, SHOP, 40, 1)); // request 1
    check_invariants(&c, id, held, 0);
    settle(&mut c, id, 1, true);
    held -= 40;
    check_invariants(&c, id, held, 0);

    reserved_id(req(&mut c, id, CAFE, 30, 2)); // request 2: transfer fails
    settle(&mut c, id, 2, false);
    check_invariants(&c, id, held, 0);

    reserved_id(req(&mut c, id, SHOP, 50, 3)); // request 3: callback out of gas, transfer failed
    reserved_id(req(&mut c, id, CAFE, 20, 4)); // request 4: callback out of gas, transfer landed
    check_invariants(&c, id, held, 0);

    tighten_as(&mut c, OWNER, id, Change::Budget(U128(800)));
    check_invariants(&c, id, held, 0);
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 3, false);
    check_invariants(&c, id, held, 0);
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 4, true);
    held -= 20;
    check_invariants(&c, id, held, 0);

    loosen_as(&mut c, GUARDIAN, id, Change::Budget(U128(1000)));
    revoke_as(&mut c, OWNER, id);
    check_invariants(&c, id, held, 0);

    // free = 1000 - 60 spent = 940
    withdraw_as(&mut c, OWNER, id, 500);
    check_invariants(&c, id, held, 500);
    assert!(!withdraw_cb(&mut c, id, 500, PromiseResult::Failed)); // transfer failed
    check_invariants(&c, id, held, 0);
    withdraw_as(&mut c, OWNER, id, 500);
    check_invariants(&c, id, held, 500);
    assert!(withdraw_cb(&mut c, id, 500, PromiseResult::Successful(vec![])));
    held -= 500;
    check_invariants(&c, id, held, 0);
    withdraw_as(&mut c, OWNER, id, 440);
    assert!(withdraw_cb(&mut c, id, 440, PromiseResult::Successful(vec![])));
    held -= 440;
    check_invariants(&c, id, held, 0);
    // everything is accounted: 60 paid to recipients + 940 back to the owner, nothing left
    assert_eq!((held, mandate(&c, id).spent, mandate(&c, id).withdrawn), (0, 60, 940));
    panics_with("AMOUNT_EXCEEDS_FREE", || withdraw_as(&mut c, OWNER, id, 1));
}

#[test]
fn only_the_guardian_raises_limits_and_the_agent_never_changes_rules() {
    // 5.3 #4: every rule-raising path is guardian-only, the agent has none.
    let (mut c, id) = world_active();
    let raises = [
        Change::Budget(U128(950)),
        Change::PerPaymentCap(U128(110)),
        Change::ApprovalThreshold(U128(60)),
        Change::AddRecipient(acc("new.testnet")),
        Change::Expiry(EXPIRES + 1),
    ];
    for ch in raises {
        for who in [OWNER, AGENT, STRANGER] {
            panics_with("UNAUTHORIZED_GUARDIAN", || loosen_as(&mut c, who, id, ch.clone()));
        }
        // and raising through `tighten` is refused for everyone, guardian included
        for who in [OWNER, GUARDIAN, AGENT] {
            panics_with("", || tighten_as(&mut c, who, id, ch.clone()));
        }
        loosen_as(&mut c, GUARDIAN, id, ch);
    }
}

#[test]
fn k2_events_all_have_the_js_parser_shape() {
    let (mut c, id) = setup();
    let mut all = vec![];
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 7, NOW + 5000);
    all.extend(events(&get_logs()));
    tighten_as(&mut c, OWNER, id, Change::Expiry(EXPIRES - 5));
    all.extend(events(&get_logs()));
    loosen_as(&mut c, GUARDIAN, id, Change::Expiry(EXPIRES));
    all.extend(events(&get_logs()));
    reserved_id(req(&mut c, id, CAFE, 10, 1));
    revoke_as(&mut c, GUARDIAN, id);
    all.extend(events(&get_logs()));
    resolve_at(&mut c, GUARDIAN, stale_height(), id, 1, true);
    all.extend(events(&get_logs()));
    withdraw_as(&mut c, OWNER, id, 100);
    withdraw_cb(&mut c, id, 100, PromiseResult::Successful(vec![]));
    all.extend(events(&get_logs()));
    let names: Vec<&str> = all.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["intent_approved", "tightened", "loosened", "revoked", "stale_resolved", "withdrawn"]
    );
    for e in &all {
        assert_js_parser_shape(e);
    }
}

// --------------------------------------------------------------------------- Audit regression tests (T-E)

#[test]
fn audit_nl5_exact_1024_bytes_result_settles_successfully() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    set_callback(PromiseResult::Successful(vec![0u8; 1024]));
    assert_eq!(
        c.on_payment_done(id, 1),
        PaymentResult::Settled { request_id: 1 }
    );
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0));
}

#[test]
fn audit_nl5_oversized_transfer_result_should_settle() {
    let (mut c, id) = setup();
    reserved_id(req(&mut c, id, SHOP, 40, 1));
    set_callback(PromiseResult::Successful(vec![0u8; 1025]));
    assert_eq!(
        c.on_payment_done(id, 1),
        PaymentResult::Settled { request_id: 1 }
    );
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (40, 0, 0));
}

#[test]
fn audit_nl5_oversized_withdraw_result_should_succeed() {
    let (mut c, id) = setup();
    revoke_as(&mut c, OWNER, id);
    withdraw_as(&mut c, OWNER, id, 100);
    let landed = withdraw_cb(&mut c, id, 100, PromiseResult::Successful(vec![0u8; 1025]));
    assert!(landed, "withdraw callback should be successful for >1024 bytes result");
}

#[test]
fn audit_f6_refunded_request_leaves_approval_consumed() {
    let (mut c, id) = setup();
    approve_as(&mut c, GUARDIAN, id, SHOP, 80, 42, NOW + 5000);
    reserved_id(req(&mut c, id, SHOP, 80, 42));
    set_callback(PromiseResult::Failed);
    assert_eq!(c.on_payment_done(id, 1), PaymentResult::Refunded { request_id: 1 });
    let m = mandate(&c, id);
    assert_eq!((m.spent, m.reserved, m.open_requests), (0, 0, 0));
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 80, 42)), "APPROVAL_USED");
}

#[test]
fn audit_ni2_approval_threshold_is_per_payment_not_cumulative() {
    let (mut c, id) = setup();
    for nonce in 1..=5 {
        reserved_id(req(&mut c, id, SHOP, 50, nonce));
        set_callback(PromiseResult::Successful(vec![]));
        assert_eq!(c.on_payment_done(id, nonce), PaymentResult::Settled { request_id: nonce });
    }
    let m = mandate(&c, id);
    assert_eq!(m.spent, 250);
    assert_eq!(rejected_code(req(&mut c, id, SHOP, 51, 99)), "NEEDS_APPROVAL");
}

// Mutation gap (T-C): every hex digit, both cases, at both nibble positions, with exact values.
#[test]
fn from_hex32_decodes_every_digit_in_both_cases_at_both_nibbles() {
    let digits = "0123456789abcdefABCDEF";
    for (i, c) in digits.chars().enumerate() {
        let want = if i < 10 { i as u8 } else if i < 16 { (i - 10 + 10) as u8 } else { (i - 16 + 10) as u8 };
        let high = format!("{c}0{}", "00".repeat(31));
        let low = format!("0{c}{}", "00".repeat(31));
        assert_eq!(from_hex32(&high).unwrap()[0], want << 4, "high nibble {c}");
        assert_eq!(from_hex32(&low).unwrap()[0], want, "low nibble {c}");
    }
}

#[test]
fn from_hex32_upper_lower_and_mixed_case_agree_and_roundtrip() {
    let bytes: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(11));
    let lower = to_hex(&bytes);
    let upper = lower.to_uppercase();
    let mixed: String = lower.chars().enumerate().map(|(i, c)| if i % 2 == 0 { c.to_ascii_uppercase() } else { c }).collect();
    assert_eq!(from_hex32(&lower), Some(bytes));
    assert_eq!(from_hex32(&upper), Some(bytes));
    assert_eq!(from_hex32(&mixed), Some(bytes));
}

#[test]
fn from_hex32_rejects_bad_length_and_non_hex_characters() {
    let ok = "00".repeat(32);
    assert!(from_hex32(&ok).is_some());
    assert!(from_hex32(&ok[..63]).is_none());
    assert!(from_hex32(&format!("{ok}0")).is_none());
    for bad in ['g', 'G', 'z', ' ', '@', '/', ':', '`', '\u{e9}'] {
        let s = format!("{bad}{}", &ok[1..]);
        if s.len() == 64 {
            assert!(from_hex32(&s).is_none(), "accepted {bad:?}");
        }
    }
    // the characters just outside each valid range must not decode
    for bad in ["/", ":", "@", "G", "`", "g"] {
        let s = format!("{bad}{}", "0".repeat(63));
        assert!(from_hex32(&s).is_none(), "accepted boundary char {bad}");
    }
}

#[path = "property_tests.rs"]
mod property_tests;

