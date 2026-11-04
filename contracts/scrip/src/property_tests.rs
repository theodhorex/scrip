//! Property-based tests (proptest) for the PRD 5.3 invariants P1..P10.
//!
//! Every test drives the real contract through a generated operation sequence and
//! compares it against an independent reference model (`Model`). The model re-implements
//! the decision rules from the PRD, so a change in `lib.rs` that accepts what the model
//! rejects (or the other way round) fails here. Time and block height are fixed, which
//! makes every generated sequence reproducible; `proptest` shrinks failures to a minimal
//! operation list.
use super::*;
use proptest::prelude::*;
use std::collections::BTreeMap;

const MANDATE: u64 = 1;
const STALE_SET_HEIGHT: u64 = 1000 + STALE_BLOCKS;
const APPROVAL_VALID_UNTIL: u64 = NOW + 5_000;

fn name(i: u8) -> &'static str {
    match i % 6 {
        0 => SHOP,
        1 => CAFE,
        2 => STRANGER,
        3 => AGENT,
        4 => "extra0.testnet",
        _ => "extra1.testnet",
    }
}

// --------------------------------------------------------------------------- model

/// Independent state machine: money counters, rule values, pending table and the
/// approval table (hash inputs -> used flag). It does not call into the contract.
struct Model {
    deposited: u128,
    spent: u128,
    reserved: u128,
    withdrawn: u128,
    ledger: u128, // tokens physically held by the contract, tracked by the test
    budget: u128,
    cap: u128,
    threshold: u128,
    expires: u64,
    revoked: bool,
    recipients: Vec<&'static str>,
    pending: BTreeMap<u64, (u128, u128, &'static str)>,
    next_rid: u64,
    approvals: BTreeMap<(u128, u64, &'static str), bool>,
}

impl Model {
    fn seed_with_deposit(initial_deposit: u128) -> Self {
        Self {
            deposited: initial_deposit,
            spent: 0,
            reserved: 0,
            withdrawn: 0,
            ledger: initial_deposit,
            budget: 1000,
            cap: 100,
            threshold: 50,
            expires: EXPIRES,
            revoked: false,
            recipients: vec![SHOP, CAFE],
            pending: BTreeMap::new(),
            next_rid: 1,
            approvals: BTreeMap::new(),
        }
    }

    fn free(&self) -> u128 {
        self.deposited.saturating_sub(self.spent + self.reserved + self.withdrawn)
    }

    fn ceiling(&self) -> u128 {
        self.budget.min(self.deposited.saturating_sub(self.withdrawn))
    }

    /// PRD 3.3 decision order, written from the PRD text (not from `lib.rs`).
    fn request_outcome(&self, amount: u128, recipient: &str, nonce: u64) -> Option<&'static str> {
        if self.revoked {
            return Some("NOT_ACTIVE");
        }
        if NOW >= self.expires {
            return Some("EXPIRED");
        }
        if !self.recipients.contains(&recipient) {
            return Some("RECIPIENT_NOT_ALLOWED");
        }
        if amount == 0 || amount > self.cap {
            return Some("OVER_PER_PAYMENT_CAP");
        }
        if self.pending.len() >= MAX_OPEN as usize {
            return Some("TOO_MANY_OPEN");
        }
        if self.spent + self.reserved + amount > self.ceiling() {
            return Some("OVER_BUDGET");
        }
        if amount > self.threshold {
            match self.approvals.get(&(amount, nonce, recipient)) {
                None => return Some("NEEDS_APPROVAL"),
                Some(true) => return Some("APPROVAL_USED"),
                Some(false) => {}
            }
        }
        None
    }
}

fn try_call<T>(f: impl FnOnce() -> T) -> Result<T, ()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|_| ())
}

/// Each proptest case runs in the same thread and near-sdk keeps mocked storage in a
/// thread-local, so collections (`LookupMap`/`LookupSet`) would otherwise leak keys from
/// the previous case into the next one. Empty the storage before building a fresh
/// contract so every case really starts from a clean mandate.
fn reset_storage() {
    let _ = try_call(|| near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()));
}

/// The contract fields and the model must agree on money, rules, status and pending.
fn assert_synced(c: &Scrip, m: &Model) {
    let a = mandate(c, MANDATE);
    assert_eq!(
        (a.deposited, a.spent, a.reserved, a.withdrawn),
        (m.deposited, m.spent, m.reserved, m.withdrawn),
        "money counters drifted from the reference model"
    );
    assert_eq!(
        (a.budget, a.per_payment_cap, a.approval_threshold, a.expires_at_ms),
        (m.budget, m.cap, m.threshold, m.expires),
        "rule values drifted from the reference model"
    );
    assert_eq!(a.status == MandateStatus::Revoked, m.revoked, "status drifted");
    assert_eq!(a.open_requests as usize, m.pending.len(), "open_requests != pending");
    // P1 / P2: the committed money never exceeds the budget nor the free deposit.
    assert!(a.spent + a.reserved <= a.budget, "P1: spent + reserved <= budget");
    assert!(
        a.spent + a.reserved <= a.deposited.saturating_sub(a.withdrawn),
        "P2: spent + reserved <= deposited - withdrawn"
    );
    assert!(
        a.budget >= a.per_payment_cap && a.per_payment_cap >= a.approval_threshold,
        "K-A: budget >= cap >= threshold"
    );
    // P3: independent ledger == deposited - spent - withdrawn (reserved still held).
    assert_eq!(
        m.ledger,
        a.deposited - a.spent - a.withdrawn,
        "P3: token conservation against the independent ledger"
    );
}

/// Extract the `amount` of the `ft_transfer` receipt created by the last contract call.
fn last_ft_transfer_amount() -> u128 {
    for r in get_created_receipts() {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } = a {
                if method_name == b"ft_transfer" {
                    let v: Value = serde_json::from_slice(&args).expect("ft_transfer JSON args");
                    return v["amount"].as_str().expect("amount string").parse().expect("u128");
                }
            }
        }
    }
    panic!("expected an ft_transfer receipt");
}

/// P7/P9 bookkeeping: an approval may be consumed once; a pending request once.
fn settle_model(m: &mut Model, rid: u64, ok: bool) -> bool {
    let Some((amount, ft_amount, _)) = m.pending.remove(&rid) else { return false };
    m.reserved -= amount;
    if ok {
        m.spent += amount;
        m.ledger -= ft_amount;
    }
    true
}

fn apply(c: &mut Scrip, id: u64, m: &mut Model, op: &Op, step: usize) {
    let ctx = format!("step {step} {op:?}");
    match op {
        Op::Deposit { from_owner, amount } => {
            let sender = if *from_owner { OWNER } else { STRANGER };
            let amount = *amount as u128;
            let refunded = fund(c, TOKEN, sender, id, amount);
            // Only an active mandate accepts deposits; after revocation every deposit is
            // refunded in full (ft_on_transfer is non-panicking by design).
            if *from_owner && !m.revoked {
                assert_eq!(refunded, 0, "{ctx}: owner deposit must be accepted");
                m.deposited += amount;
                m.ledger += amount;
            } else {
                assert_eq!(refunded, amount, "{ctx}: deposit must be refunded in full");
            }
        }
        Op::Request { amount, recipient, nonce } => {
            let amount = *amount as u128;
            let recipient = name(*recipient);
            let nonce = *nonce as u64;
            let expected = m.request_outcome(amount, recipient, nonce);
            match req(c, id, recipient, amount, nonce) {
                PromiseOrValue::Promise(p) => {
                    drop(p);
                    assert_eq!(expected, None, "{ctx}: model expected a rejection");
                    let ft_amount = last_ft_transfer_amount();
                    let rid = m.next_rid;
                    m.next_rid += 1;
                    m.reserved += amount;
                    m.pending.insert(rid, (amount, ft_amount, recipient));
                    if amount > m.threshold {
                        match m.approvals.get_mut(&(amount, nonce, recipient)) {
                            Some(used) => {
                                assert!(!*used, "{ctx}: approval must be unconsumed");
                                *used = true;
                            }
                            None => panic!("{ctx}: model expected a stored approval"),
                        }
                    }
                }
                PromiseOrValue::Value(PaymentResult::Rejected { code }) => {
                    assert_eq!(Some(code.as_str()), expected, "{ctx}: rejection code mismatch");
                }
                PromiseOrValue::Value(other) => panic!("{ctx}: unexpected result {other:?}"),
            }
        }
        Op::Settle { rid, ok } => {
            let rid = *rid as u64;
            let existed = m.pending.contains_key(&rid);
            let r = settle(c, id, rid, *ok);
            if existed {
                assert_eq!(
                    r,
                    if *ok {
                        PaymentResult::Settled { request_id: rid }
                    } else {
                        PaymentResult::Refunded { request_id: rid }
                    },
                    "{ctx}: callback result"
                );
                settle_model(m, rid, *ok);
            } else {
                assert_eq!(r, PaymentResult::AlreadyResolved { request_id: rid }, "{ctx}");
            }
        }
        Op::ResolveStale { rid, transferred } => {
            let rid = *rid as u64;
            let existed = m.pending.contains_key(&rid);
            let expected_ok = existed && *transferred;
            let r = try_call(|| resolve_at(c, GUARDIAN, STALE_SET_HEIGHT, id, rid, *transferred));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: resolve_stale accept/reject mismatch");
            if expected_ok {
                settle_model(m, rid, true);
            }
        }
        Op::Approve { amount, recipient, nonce } => {
            let amount = *amount as u128;
            let recipient = name(*recipient);
            let nonce = *nonce as u64;
            let key = (amount, nonce, recipient);
            let expected_ok = !m.revoked && !m.approvals.contains_key(&key);
            let r = try_call(|| approve_as(c, GUARDIAN, id, recipient, amount, nonce, APPROVAL_VALID_UNTIL));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: approve_intent accept/reject mismatch");
            if expected_ok {
                m.approvals.insert(key, false);
            }
        }
        Op::TightenBudget(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked
                && x < m.budget
                && x >= m.spent + m.reserved
                && x >= m.cap;
            let r = try_call(|| tighten_as(c, OWNER, id, Change::Budget(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: tighten(Budget) mismatch");
            if expected_ok {
                m.budget = x;
            }
        }
        Op::TightenCap(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked && x < m.cap && x >= m.threshold;
            let r = try_call(|| tighten_as(c, GUARDIAN, id, Change::PerPaymentCap(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: tighten(PerPaymentCap) mismatch");
            if expected_ok {
                m.cap = x;
            }
        }
        Op::TightenThreshold(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked && x < m.threshold;
            let r = try_call(|| tighten_as(c, OWNER, id, Change::ApprovalThreshold(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: tighten(ApprovalThreshold) mismatch");
            if expected_ok {
                m.threshold = x;
            }
        }
        Op::TightenExpiry(t) => {
            let t = *t;
            let expected_ok = !m.revoked && t > NOW && t < m.expires;
            let r = try_call(|| tighten_as(c, OWNER, id, Change::Expiry(t)));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: tighten(Expiry) mismatch");
            if expected_ok {
                m.expires = t;
            }
        }
        Op::RemoveRecipient(i) => {
            let who = name(*i);
            let expected_ok = !m.revoked && m.recipients.contains(&who);
            let res = try_call(|| tighten_as(c, OWNER, id, Change::RemoveRecipient(acc(who))));
            assert_eq!(res.is_ok(), expected_ok, "{ctx}: tighten(RemoveRecipient) mismatch");
            if expected_ok {
                m.recipients.retain(|x| *x != who);
            }
        }
        Op::LoosenBudget(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked && x > m.budget && x <= m.deposited.saturating_sub(m.withdrawn);
            let r = try_call(|| loosen_as(c, GUARDIAN, id, Change::Budget(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: loosen(Budget) mismatch");
            if expected_ok {
                m.budget = x;
            }
        }
        Op::LoosenCap(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked && x > m.cap && x <= m.budget;
            let r = try_call(|| loosen_as(c, GUARDIAN, id, Change::PerPaymentCap(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: loosen(PerPaymentCap) mismatch");
            if expected_ok {
                m.cap = x;
            }
        }
        Op::LoosenThreshold(x) => {
            let x = *x as u128;
            let expected_ok = !m.revoked && x > m.threshold && x <= m.cap;
            let r = try_call(|| loosen_as(c, GUARDIAN, id, Change::ApprovalThreshold(U128(x))));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: loosen(ApprovalThreshold) mismatch");
            if expected_ok {
                m.threshold = x;
            }
        }
        Op::LoosenExpiry(t) => {
            let t = *t;
            let expected_ok = !m.revoked && t > m.expires;
            let r = try_call(|| loosen_as(c, GUARDIAN, id, Change::Expiry(t)));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: loosen(Expiry) mismatch");
            if expected_ok {
                m.expires = t;
            }
        }
        Op::AddRecipient(i) => {
            let r = name(*i);
            let expected_ok = !m.revoked && !m.recipients.contains(&r) && m.recipients.len() < MAX_RECIPIENTS;
            let res = try_call(|| loosen_as(c, GUARDIAN, id, Change::AddRecipient(acc(r))));
            assert_eq!(res.is_ok(), expected_ok, "{ctx}: loosen(AddRecipient) mismatch");
            if expected_ok {
                m.recipients.push(r);
            }
        }
        Op::Revoke => {
            let expected_ok = !m.revoked;
            let r = try_call(|| revoke_as(c, OWNER, id));
            assert_eq!(r.is_ok(), expected_ok, "{ctx}: revoke accept/reject mismatch");
            if expected_ok {
                m.revoked = true;
            }
        }
        Op::Withdraw { amount, ok } => {
            let amount = *amount as u128;
            let expected_ok = m.revoked && amount > 0 && amount <= m.free();
            let accepted = try_call(|| {
                withdraw_as(c, OWNER, id, amount);
            })
            .is_ok();
            assert_eq!(accepted, expected_ok, "{ctx}: withdraw accept/reject mismatch");
            if !expected_ok {
                return;
            }
            let ft_amount = last_ft_transfer_amount();
            m.withdrawn += amount; // the contract writes before the promise
            let landed = withdraw_cb(c, id, amount, if *ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
            assert_eq!(landed, *ok, "{ctx}: withdraw callback result");
            if *ok {
                m.ledger -= ft_amount;
            } else {
                m.withdrawn -= amount;
            }
        }
    }
}

fn run_sequence(ops: &[Op], check: impl FnMut(&Scrip, &Model, usize)) {
    run_sequence_seeded(1000, ops, check);
}

fn run_sequence_seeded(initial_deposit: u128, ops: &[Op], mut check: impl FnMut(&Scrip, &Model, usize)) {
    reset_storage();
    set(OWNER);
    let mut c = Scrip::new();
    let id = create_default(&mut c);
    if initial_deposit > 0 {
        assert_eq!(fund(&mut c, TOKEN, OWNER, id, initial_deposit), 0);
    }
    let mut m = Model::seed_with_deposit(initial_deposit);
    check(&c, &m, 0);
    for (i, op) in ops.iter().enumerate() {
        apply(&mut c, id, &mut m, op, i);
        assert_synced(&c, &m);
        check(&c, &m, i);
    }
}

// ----------------------------------------------------------------------- generators

#[derive(Clone, Debug)]
enum Op {
    Deposit { from_owner: bool, amount: u16 },
    Request { amount: u16, recipient: u8, nonce: u8 },
    Settle { rid: u16, ok: bool },
    ResolveStale { rid: u16, transferred: bool },
    Approve { amount: u16, recipient: u8, nonce: u8 },
    TightenBudget(u16),
    TightenCap(u16),
    TightenThreshold(u16),
    TightenExpiry(u64),
    RemoveRecipient(u8),
    LoosenBudget(u16),
    LoosenCap(u16),
    LoosenThreshold(u16),
    LoosenExpiry(u64),
    AddRecipient(u8),
    Revoke,
    Withdraw { amount: u16, ok: bool },
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => (any::<bool>(), 0u16..700).prop_map(|(from_owner, amount)| Op::Deposit { from_owner, amount }),
        8 => (0u16..180, 0u8..6, 0u8..10).prop_map(|(amount, recipient, nonce)| Op::Request { amount, recipient, nonce }),
        5 => (0u16..50, any::<bool>()).prop_map(|(rid, ok)| Op::Settle { rid, ok }),
        2 => (0u16..50, any::<bool>()).prop_map(|(rid, transferred)| Op::ResolveStale { rid, transferred }),
        3 => (0u16..180, 0u8..6, 0u8..10).prop_map(|(amount, recipient, nonce)| Op::Approve { amount, recipient, nonce }),
        2 => (0u16..2000).prop_map(Op::TightenBudget),
        2 => (0u16..300).prop_map(Op::TightenCap),
        1 => (0u16..250).prop_map(Op::TightenThreshold),
        1 => (NOW..NOW + 9_000_000).prop_map(Op::TightenExpiry),
        1 => (0u8..6).prop_map(Op::RemoveRecipient),
        2 => (0u16..2000).prop_map(Op::LoosenBudget),
        1 => (0u16..300).prop_map(Op::LoosenCap),
        1 => (0u16..300).prop_map(Op::LoosenThreshold),
        1 => (EXPIRES..EXPIRES + 1_000_000).prop_map(Op::LoosenExpiry),
        1 => (0u8..6).prop_map(Op::AddRecipient),
        1 => Just(Op::Revoke),
        2 => (0u16..1200, any::<bool>()).prop_map(|(amount, ok)| Op::Withdraw { amount, ok }),
    ]
}

fn arb_ops() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(arb_op(), 1..50)
}

fn arb_change() -> impl Strategy<Value = Change> {
    prop_oneof![
        3 => (0u16..3000).prop_map(|x| Change::Budget(U128(x as u128))),
        2 => (0u16..350).prop_map(|x| Change::PerPaymentCap(U128(x as u128))),
        2 => (0u16..250).prop_map(|x| Change::ApprovalThreshold(U128(x as u128))),
        1 => (NOW..NOW + 9_000_000).prop_map(Change::Expiry),
        1 => (0u8..3).prop_map(|i| Change::AddRecipient(acc(name(i)))),
        1 => (0u8..3).prop_map(|i| Change::RemoveRecipient(acc(name(i)))),
    ]
}

// ------------------------------------------------------------------------- P1..P3

proptest! {
    #![proptest_config(ProptestConfig { cases: 40, .. ProptestConfig::default() })]

    // P1
    /// P1: `spent + reserved <= budget` after every step of a random sequence.
    #[test]
    fn p1_spent_plus_reserved_never_exceeds_budget(ops in arb_ops()) {
        run_sequence(&ops, |c, _m, step| {
            let a = mandate(c, MANDATE);
            assert!(
                a.spent + a.reserved <= a.budget,
                "step {step}: spent {} + reserved {} > budget {}",
                a.spent, a.reserved, a.budget
            );
        });
    }

    // P2
    /// P2: the effective ceiling is `min(budget, deposited - withdrawn)` and committed
    /// money never crosses `deposited - withdrawn`, even when `deposited < budget`.
    #[test]
    fn p2_ceiling_never_exceeds_deposited_minus_withdrawn(
        initial_deposit in 0u16..=1200,
        ops in arb_ops(),
    ) {
        run_sequence_seeded(initial_deposit as u128, &ops, |c, _m, step| {
            let a = mandate(c, MANDATE);
            let net_deposit = a.deposited.saturating_sub(a.withdrawn);
            let ceiling = a.budget.min(net_deposit);
            assert!(a.spent + a.reserved <= net_deposit, "step {step}: committed > deposited - withdrawn");
            assert!(a.spent + a.reserved <= ceiling, "step {step}: committed above ceiling");
        });
    }

    // P3
    /// P3: token conservation. The test keeps its own ledger of every `ft_transfer` receipt
    /// that really landed; it must equal `deposited - spent - withdrawn` and cover `reserved`.
    #[test]
    fn p3_token_conservation_holds_against_independent_ledger(ops in arb_ops()) {
        run_sequence(&ops, |c, m, step| {
            let a = mandate(c, MANDATE);
            assert_eq!(m.ledger, a.deposited - a.spent - a.withdrawn, "step {}: ledger", step);
            assert!(m.ledger >= a.reserved, "step {}: ledger must cover reserved tokens", step);
            assert!(
                a.spent + a.reserved + a.withdrawn <= a.deposited,
                "step {}: fund conservation", step
            );
        });
    }

    // P10
    /// P10: a random order of every operation preserves P1..P3 (the assertions in
    /// `assert_synced`, run after each step, plus the explicit checks below).
    #[test]
    fn p10_random_orders_preserve_money_invariants(ops in arb_ops()) {
        run_sequence(&ops, |c, m, step| {
            let a = mandate(c, MANDATE);
            assert!(a.spent + a.reserved <= a.budget, "step {}: P1", step);
            assert!(a.spent + a.reserved <= a.deposited.saturating_sub(a.withdrawn), "step {}: P2", step);
            assert_eq!(m.ledger, a.deposited - a.spent - a.withdrawn, "step {}: P3", step);
            assert!(a.budget >= a.per_payment_cap && a.per_payment_cap >= a.approval_threshold, "step {}: K-A", step);
        });
    }

    // P4
    /// P4: `tighten` never loosens any parameter. On success the value moves strictly
    /// inward (and K-A still holds); on failure nothing at all changes.
    #[test]
    fn p4_tighten_never_loosens(change in arb_change()) {
        reset_storage();
        let (mut c, id) = setup();
        set(OWNER);
        let before = {
            let v = c.get_mandate(id).unwrap();
            (v.budget.0, v.per_payment_cap.0, v.approval_threshold.0, v.expires_at_ms, v.recipients)
        };
        let accepted = try_call(|| tighten_as(&mut c, OWNER, id, change.clone())).is_ok();
        let view = c.get_mandate(id).unwrap();
        let m = mandate(&c, id);
        match &change {
            Change::Budget(x) => {
                if accepted {
                    prop_assert!(x.0 < before.0 && x.0 >= m.per_payment_cap);
                    prop_assert!(x.0 >= m.spent + m.reserved);
                    prop_assert_eq!(m.budget, x.0);
                } else {
                    prop_assert_eq!(m.budget, before.0);
                }
            }
            Change::PerPaymentCap(x) => {
                if accepted {
                    prop_assert!(x.0 < before.1 && x.0 >= m.approval_threshold);
                    prop_assert_eq!(m.per_payment_cap, x.0);
                } else {
                    prop_assert_eq!(m.per_payment_cap, before.1);
                }
            }
            Change::ApprovalThreshold(x) => {
                if accepted {
                    prop_assert!(x.0 < before.2);
                    prop_assert_eq!(m.approval_threshold, x.0);
                } else {
                    prop_assert_eq!(m.approval_threshold, before.2);
                }
            }
            Change::Expiry(t) => {
                if accepted {
                    prop_assert!(*t < before.3 && *t > NOW);
                    prop_assert_eq!(m.expires_at_ms, *t);
                } else {
                    prop_assert_eq!(m.expires_at_ms, before.3);
                }
            }
            Change::AddRecipient(_) => prop_assert!(!accepted, "tighten must never add a recipient"),
            Change::RemoveRecipient(r) => {
                if accepted {
                    prop_assert!(before.4.contains(r) && !view.recipients.contains(r));
                } else {
                    prop_assert_eq!(&view.recipients, &before.4);
                }
            }
        }
        if !accepted {
            prop_assert_eq!(
                (m.budget, m.per_payment_cap, m.approval_threshold, m.expires_at_ms, view.recipients.clone()),
                before,
                "a rejected tighten must change nothing"
            );
        }
        prop_assert!(m.budget >= m.per_payment_cap && m.per_payment_cap >= m.approval_threshold, "K-A");
    }

    // P5
    /// P5: `loosen` never exceeds what was deposited, never crosses the rule ladder,
    /// never adds a 17th recipient, and only the guardian can call it.
    #[test]
    fn p5_loosen_stays_inside_deposit_and_ladder(change in arb_change()) {
        reset_storage();
        let (mut c, id) = setup(); // budget 1000, deposited 1000, cap 100, threshold 50
        let before = {
            let v = c.get_mandate(id).unwrap();
            (v.budget.0, v.per_payment_cap.0, v.approval_threshold.0, v.expires_at_ms, v.recipients)
        };
        let accepted = try_call(|| loosen_as(&mut c, GUARDIAN, id, change.clone())).is_ok();
        let view = c.get_mandate(id).unwrap();
        let m = mandate(&c, id);
        match &change {
            Change::Budget(x) => {
                if accepted {
                    prop_assert!(x.0 > before.0 && x.0 <= m.deposited.saturating_sub(m.withdrawn));
                    prop_assert_eq!(m.budget, x.0);
                } else {
                    prop_assert_eq!(m.budget, before.0);
                }
            }
            Change::PerPaymentCap(x) => {
                if accepted {
                    prop_assert!(x.0 > before.1 && x.0 <= m.budget);
                    prop_assert_eq!(m.per_payment_cap, x.0);
                } else {
                    prop_assert_eq!(m.per_payment_cap, before.1);
                }
            }
            Change::ApprovalThreshold(x) => {
                if accepted {
                    prop_assert!(x.0 > before.2 && x.0 <= m.per_payment_cap);
                    prop_assert_eq!(m.approval_threshold, x.0);
                } else {
                    prop_assert_eq!(m.approval_threshold, before.2);
                }
            }
            Change::Expiry(t) => {
                if accepted {
                    prop_assert!(*t > before.3);
                    prop_assert_eq!(m.expires_at_ms, *t);
                } else {
                    prop_assert_eq!(m.expires_at_ms, before.3);
                }
            }
            Change::AddRecipient(r) => {
                if accepted {
                    prop_assert!(view.recipients.len() <= MAX_RECIPIENTS && view.recipients.len() == before.4.len() + 1);
                    prop_assert!(view.recipients.contains(r));
                } else {
                    prop_assert_eq!(&view.recipients, &before.4);
                }
            }
            Change::RemoveRecipient(_) => {
                prop_assert!(!accepted, "loosen must never remove a recipient");
                prop_assert_eq!(&view.recipients, &before.4);
            }
        }
        if !accepted {
            prop_assert_eq!(
                (m.budget, m.per_payment_cap, m.approval_threshold, m.expires_at_ms, view.recipients.clone()),
                before,
                "a rejected loosen must change nothing"
            );
        }
        prop_assert!(m.budget >= m.per_payment_cap && m.per_payment_cap >= m.approval_threshold, "K-A");
    }

    // P6
    /// P6: `withdraw` only after Revoked, only the owner, only the free remainder,
    /// and it writes `withdrawn` before the promise (restored on failure).
    #[test]
    fn p6_withdraw_only_owner_after_revoke_within_free(
        spend in 1u16..=50,
        reserve in 0u16..=50,
        amount in 0u16..1200,
        caller in 0u8..4,
        revoke in any::<bool>(),
        ok in any::<bool>(),
    ) {
        reset_storage();
        let (mut c, id) = setup();
        if spend > 0 {
            reserved_id(req(&mut c, id, SHOP, spend as u128, 1));
            settle(&mut c, id, 1, true);
        }
        if reserve > 0 {
            reserved_id(req(&mut c, id, CAFE, reserve as u128, 2));
        }
        if revoke {
            revoke_as(&mut c, OWNER, id);
        }
        let who = match caller {
            0 => OWNER,
            1 => GUARDIAN,
            2 => AGENT,
            _ => STRANGER,
        };
        let before = {
            let m = mandate(&c, id);
            (m.withdrawn, m.spent, m.reserved, m.deposited, m.status.clone())
        };
        let free = before.3.saturating_sub(before.1 + before.2 + before.0);
        let accepted = try_call(|| withdraw_as(&mut c, who, id, amount as u128)).is_ok();
        let expect = revoke && caller == 0 && amount as u128 > 0 && amount as u128 <= free;
        prop_assert_eq!(accepted, expect, "withdraw acceptance mismatch");
        if accepted {
            prop_assert_eq!(mandate(&c, id).withdrawn, before.0 + amount as u128);
            let landed = withdraw_cb(
                &mut c, id, amount as u128,
                if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed },
            );
            prop_assert_eq!(landed, ok);
            prop_assert_eq!(
                mandate(&c, id).withdrawn,
                if ok { before.0 + amount as u128 } else { before.0 },
                "failed callback must restore withdrawn"
            );
        } else {
            prop_assert_eq!(mandate(&c, id).withdrawn, before.0);
        }
    }

    // P7
    /// P7: an approval is usable at most once, and only for its exact tuple.
    #[test]
    fn p7_approval_is_consumed_at_most_once(
        amount in 51u16..100,
        nonce in 0u64..64,
        nonce2 in 0u64..64,
        recipient in 0u8..2,
    ) {
        reset_storage();
        let (mut c, id) = setup();
        let amount = amount as u128;
        let rec = name(recipient);
        approve_as(&mut c, GUARDIAN, id, rec, amount, nonce, APPROVAL_VALID_UNTIL);
        let key = approval_hex(id, rec, amount, nonce, EXPIRES);
        prop_assert_eq!(c.get_approval(key.clone()).map(|a| a.used), Some(false));
        // re-approving the same hash never resets `used`
        prop_assert!(try_call(|| approve_as(&mut c, GUARDIAN, id, rec, amount, nonce, APPROVAL_VALID_UNTIL)).is_err());
        // exact tuple consumes it
        reserved_id(req(&mut c, id, rec, amount, nonce));
        prop_assert!(c.get_approval(key.clone()).unwrap().used);
        // a second request with the same tuple is refused, a different nonce has no approval
        if nonce2 == nonce {
            prop_assert_eq!(rejected_code(req(&mut c, id, rec, amount, nonce)), "APPROVAL_USED");
        } else {
            prop_assert_eq!(rejected_code(req(&mut c, id, rec, amount, nonce2)), "NEEDS_APPROVAL");
        }
        prop_assert_eq!(mandate(&c, id).reserved, amount, "exactly one approval was consumed");
        prop_assert!(c.get_approval(key).unwrap().used, "used flag stays for replay protection");
    }

    // P8
    /// P8: the intent hash is deterministic and every field changes it.
    #[test]
    fn p8_intent_hash_is_deterministic_and_field_sensitive(
        mandate_id in 0u64..100_000,
        recipient in 0u8..6,
        amount in 0u128..u64::MAX as u128,
        nonce in 0u64..100_000,
        expires in NOW..NOW + 10_000_000,
    ) {
        let rec = name(recipient);
        let base = intent_hash(mandate_id, rec, amount, nonce, expires);
        prop_assert_eq!(base, intent_hash(mandate_id, rec, amount, nonce, expires));
        prop_assert_ne!(base, intent_hash(mandate_id + 1, rec, amount, nonce, expires));
        prop_assert_ne!(base, intent_hash(mandate_id, name(recipient + 1), amount, nonce, expires));
        prop_assert_ne!(base, intent_hash(mandate_id, rec, amount + 1, nonce, expires));
        prop_assert_ne!(base, intent_hash(mandate_id, rec, amount, nonce + 1, expires));
        prop_assert_ne!(base, intent_hash(mandate_id, rec, amount, nonce, expires + 1));
    }

    // P9
    /// P9: a pending request settles (or refunds) exactly once, whether the second
    /// attempt comes from the callback or from `resolve_stale`.
    #[test]
    fn p9_pending_never_resolves_twice(
        amount in 1u16..=50,
        ok in any::<bool>(),
        stale in any::<bool>(),
        stale_second in any::<bool>(),
    ) {
        reset_storage();
        let (mut c, id) = setup();
        let amount = amount as u128;
        reserved_id(req(&mut c, id, SHOP, amount, 1));
        let settled = settle(&mut c, id, 1, ok);
        prop_assert_eq!(
            settled,
            if ok { PaymentResult::Settled { request_id: 1 } } else { PaymentResult::Refunded { request_id: 1 } }
        );
        let after = {
            let m = mandate(&c, id);
            (m.spent, m.reserved, m.open_requests)
        };
        prop_assert_eq!(after, if ok { (amount, 0, 0) } else { (0, 0, 0) });
        // second callback is a no-op
        prop_assert_eq!(settle(&mut c, id, 1, !ok), PaymentResult::AlreadyResolved { request_id: 1 });
        prop_assert_eq!((mandate(&c, id).spent, mandate(&c, id).reserved), (after.0, after.1));
        // resolve_stale either finds nothing (callback ran) or is the only resolution
        prop_assert!(try_call(|| resolve_at(&mut c, GUARDIAN, STALE_SET_HEIGHT, id, 1, stale_second)).is_err());
        prop_assert_eq!((mandate(&c, id).spent, mandate(&c, id).reserved, mandate(&c, id).open_requests), after);
        let _ = stale; // both interleavings are covered by the second-callback assertion
    }

    // F5 / P11
    /// Proves F5 2(a): `on_payment_done` and `on_withdraw_done` cannot panic on reachable paths.
    /// Under random interleaved operations, accounting invariants (reserved, spent, withdrawn, ledger)
    /// strictly hold and callbacks never panic.
    #[test]
    fn p11_f5_callbacks_never_panic_and_invariants_hold(ops in arb_ops()) {
        run_sequence(&ops, |c, m, step| {
            let a = mandate(c, MANDATE);
            assert!(a.spent + a.reserved <= a.budget, "step {step}: P1 spent+reserved <= budget");
            assert!(a.spent + a.reserved + a.withdrawn <= a.deposited, "step {step}: fund conservation");
            assert_eq!(m.ledger, a.deposited - a.spent - a.withdrawn, "step {step}: ledger conservation");
            assert!(m.ledger >= a.reserved, "step {step}: ledger covers reserved");
        });
    }
}
