//! Attack catalog unit tests for Layer A (contract unit level).
//! Implements parametric attack vectors for Category 2 (Amounts & Numeric Limits)
//! and Category 5 (Access Control & Caller Authorization).

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, Gas, NearToken, PromiseOrValue};
use near_sdk::serde::{Deserialize, Serialize};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub(crate) const NOW: u64 = 1_000_000; // ms
pub(crate) const EXPIRES: u64 = 10_000_000; // ms
pub(crate) const CONTRACT: &str = "scrip.testnet";
pub(crate) const OWNER: &str = "alice.testnet";
pub(crate) const AGENT: &str = "agent.testnet";
pub(crate) const GUARDIAN: &str = "guardian.testnet";
pub(crate) const TOKEN: &str = "usdc.testnet";
pub(crate) const SHOP: &str = "shop.testnet";
pub(crate) const CAFE: &str = "cafe.testnet";
pub(crate) const STRANGER: &str = "bob.testnet";
pub(crate) const RELAYER: &str = "relayer.testnet";

pub(crate) fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub(crate) fn set_context(pred: &str, deposit: NearToken, tgas: u64, ts_ms: u64, height: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(ts_ms * 1_000_000)
        .block_height(height)
        .prepaid_gas(Gas::from_tgas(tgas))
        .attached_deposit(deposit);
    testing_env!(b.build());
}

pub(crate) fn setup_standard_contract() -> (Scrip, u64) {
    set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
    let mut c = Scrip::new();
    let id = c.create_mandate(
        acc(AGENT),
        acc(GUARDIAN),
        acc(TOKEN),
        U128(1000), // budget
        U128(100),  // per_payment_cap
        U128(50),   // approval_threshold
        vec![acc(SHOP), acc(CAFE)],
        EXPIRES,
    );
    // Fund with 1000 tokens
    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
    let msg = format!("{{\"mandate_id\":{id}}}");
    let _ = c.ft_on_transfer(acc(OWNER), U128(1000), msg);
    (c, id)
}

pub(crate) fn setup_revoked_mandate_with_free_remainder() -> (Scrip, u64) {
    let (mut c, id) = setup_standard_contract();
    // Simulate spending 200, reserved 100, withdrawn 300
    // Deposited is 1000, so free remainder = 1000 - (200 + 100 + 300) = 400
    if let Some(m) = c.mandates.get_mut(&id) {
        m.spent = 200;
        m.reserved = 100;
        m.withdrawn = 300;
    }
    // Revoke as owner
    set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
    c.revoke(id);
    (c, id)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct CaseExpected {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct CaseActual {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct AttackCaseOutput {
    pub id: String,
    pub category: u8,
    pub layer: String,
    pub title: String,
    pub params: serde_json::Value,
    pub expected: CaseExpected,
    pub actual: CaseActual,
    pub verdict: String,
}

#[derive(Clone, PartialEq, Debug)]
pub(crate) struct MandateSnapshot {
    pub(crate) deposited: u128,
    pub(crate) budget: u128,
    pub(crate) spent: u128,
    pub(crate) reserved: u128,
    pub(crate) withdrawn: u128,
    pub(crate) per_payment_cap: u128,
    pub(crate) approval_threshold: u128,
    pub(crate) status: MandateStatus,
    pub(crate) open_requests: u32,
    pub(crate) approvals_count: u32,
    pub(crate) recipients: Vec<AccountId>,
}

pub(crate) fn take_snapshot(c: &Scrip, id: u64) -> Option<MandateSnapshot> {
    let m = c.mandates.get(&id)?;
    let recs = c.recipient_lists.get(&id).cloned().unwrap_or_default();
    Some(MandateSnapshot {
        deposited: m.deposited,
        budget: m.budget,
        spent: m.spent,
        reserved: m.reserved,
        withdrawn: m.withdrawn,
        per_payment_cap: m.per_payment_cap,
        approval_threshold: m.approval_threshold,
        status: m.status.clone(),
        open_requests: m.open_requests,
        approvals_count: m.approvals_count,
        recipients: recs,
    })
}

pub(crate) fn extract_panic_code(err: Box<dyn std::any::Any + Send>) -> String {
    let logs = get_logs();
    for l in logs.iter().rev() {
        if let Some(rest) = l.strip_prefix("SCRIP_ERR:") {
            return format!("SCRIP_ERR:{}", rest.trim());
        }
    }
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    if msg.starts_with("SCRIP_ERR:") {
        msg
    } else {
        format!("SCRIP_ERR:{msg}")
    }
}

pub(crate) fn evaluate_payment_result(
    c: &Scrip,
    id: u64,
    snap_before: Option<MandateSnapshot>,
    res: Result<PromiseOrValue<PaymentResult>, Box<dyn std::any::Any + Send>>,
) -> CaseActual {
    let snap_after = take_snapshot(c, id);
    let state_unmodified = snap_before == snap_after;

    match res {
        Ok(PromiseOrValue::Value(PaymentResult::Rejected { code })) => {
            if !state_unmodified {
                CaseActual {
                    label: "BREACH".into(),
                    code: Some(format!("SCRIP_ERR:{code}")),
                    note: Some("State mutated despite rejected payment".into()),
                }
            } else {
                CaseActual {
                    label: "BLOCKED".into(),
                    code: Some(format!("SCRIP_ERR:{code}")),
                    note: None,
                }
            }
        }
        Ok(PromiseOrValue::Promise(_)) | Ok(PromiseOrValue::Value(PaymentResult::Reserved { .. })) => {
            CaseActual {
                label: "BREACH".into(),
                code: None,
                note: Some("Payment request succeeded when expected to be blocked".into()),
            }
        }
        Ok(PromiseOrValue::Value(v)) => CaseActual {
            label: "BREACH".into(),
            code: None,
            note: Some(format!("Unexpected return value {v:?}")),
        },
        Err(err) => {
            let code = extract_panic_code(err);
            if !state_unmodified {
                CaseActual {
                    label: "BREACH".into(),
                    code: Some(code),
                    note: Some("State mutated before panic".into()),
                }
            } else {
                CaseActual {
                    label: "BLOCKED".into(),
                    code: Some(code),
                    note: None,
                }
            }
        }
    }
}

pub(crate) fn evaluate_call_panic<T>(
    c: &Scrip,
    id: u64,
    snap_before: Option<MandateSnapshot>,
    res: Result<T, Box<dyn std::any::Any + Send>>,
) -> CaseActual {
    let snap_after = take_snapshot(c, id);
    let state_unmodified = snap_before == snap_after;

    match res {
        Ok(_) => CaseActual {
            label: "BREACH".into(),
            code: None,
            note: Some("Unauthorized call succeeded without panicking".into()),
        },
        Err(err) => {
            let code = extract_panic_code(err);
            if !state_unmodified {
                CaseActual {
                    label: "BREACH".into(),
                    code: Some(code),
                    note: Some("State mutated before panic".into()),
                }
            } else {
                CaseActual {
                    label: "BLOCKED".into(),
                    code: Some(code),
                    note: None,
                }
            }
        }
    }
}

pub(crate) fn evaluate_create_mandate_panic(
    c: &Scrip,
    next_id_before: u64,
    res: Result<u64, Box<dyn std::any::Any + Send>>,
) -> CaseActual {
    let next_id_after = c.next_mandate_id;
    let state_unmodified = next_id_before == next_id_after;

    match res {
        Ok(new_id) => CaseActual {
            label: "BREACH".into(),
            code: None,
            note: Some(format!("create_mandate unexpectedly succeeded returning id {new_id}")),
        },
        Err(err) => {
            let code = extract_panic_code(err);
            if !state_unmodified {
                CaseActual {
                    label: "BREACH".into(),
                    code: Some(code),
                    note: Some("next_mandate_id advanced despite panic".into()),
                }
            } else {
                CaseActual {
                    label: "BLOCKED".into(),
                    code: Some(code),
                    note: None,
                }
            }
        }
    }
}

pub(crate) fn evaluate_ft_on_transfer_inert(
    c: &Scrip,
    id: u64,
    snap_before: Option<MandateSnapshot>,
    amount: u128,
    res: Result<PromiseOrValue<U128>, Box<dyn std::any::Any + Send>>,
) -> CaseActual {
    let snap_after = take_snapshot(c, id);
    let state_unmodified = snap_before == snap_after;

    match res {
        Ok(PromiseOrValue::Value(refund)) => {
            if refund.0 == amount && state_unmodified {
                CaseActual {
                    label: "INERT".into(),
                    code: None,
                    note: Some("Full refund returned without state mutation".into()),
                }
            } else {
                CaseActual {
                    label: "BREACH".into(),
                    code: None,
                    note: Some(format!("Expected full refund of {amount}, got {refund:?}")),
                }
            }
        }
        _ => CaseActual {
            label: "FAIL".into(),
            code: None,
            note: Some("ft_on_transfer did not return a value".into()),
        },
    }
}

pub(crate) struct TestCaseDef {
    pub(crate) id: &'static str,
    pub(crate) category: u8,
    pub(crate) title: &'static str,
    pub(crate) params: serde_json::Value,
    pub(crate) expected: CaseExpected,
    pub(crate) runner: Box<dyn Fn() -> CaseActual + Send + Sync>,
}

fn build_category_2_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. Amount boundary variations on request_payment
    let cap_amounts: Vec<(u128, &'static str)> = vec![
        (0, "0"),
        (101, "101"),
        (102, "102"),
        (105, "105"),
        (110, "110"),
        (120, "120"),
        (150, "150"),
        (200, "200"),
        (500, "500"),
        (1000, "1000"),
        (1001, "1001"),
        (u32::MAX as u128, "u32::MAX"),
        ((u32::MAX as u128) + 1, "u32::MAX + 1"),
        (u64::MAX as u128, "u64::MAX"),
        ((u64::MAX as u128) + 1, "u64::MAX + 1"),
        (u128::MAX, "u128::MAX"),
        (u128::MAX - 1, "u128::MAX - 1"),
        (u128::MAX / 2, "u128::MAX / 2"),
    ];

    for (idx, (amt, desc)) in cap_amounts.into_iter().enumerate() {
        let sub_id = idx + 1;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment amount {} exceeds cap", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "recipient": SHOP }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_PER_PAYMENT_CAP".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 2. Unapproved amounts above threshold (threshold = 50, cap = 100)
    let threshold_amounts: Vec<u128> = vec![51, 52, 55, 60, 70, 80, 90, 99, 100];
    for (idx, amt) in threshold_amounts.into_iter().enumerate() {
        let sub_id = 19 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment amount {} above threshold without approval", amt).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "threshold": 50 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NEEDS_APPROVAL".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 3. Approved amounts that still violate per_payment_cap (cap = 100)
    let approved_over_cap: Vec<u128> = vec![101, 200, u128::MAX];
    for (idx, amt) in approved_over_cap.into_iter().enumerate() {
        let sub_id = 28 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment amount {} approved but exceeds cap", amt).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "cap": 100 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_PER_PAYMENT_CAP".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                // Pre-approve the amount as guardian
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(SHOP), U128(amt), 77, NOW + 5000);
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 77)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 4. Budget ceiling & additions (contract budget = 100, cap = 100, threshold = 100, spent = 80, remaining = 20)
    let budget_over_amounts: Vec<u128> = vec![21, 22, 25, 30, 40, 50, 75, 100];
    for (idx, amt) in budget_over_amounts.into_iter().enumerate() {
        let sub_id = 31 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment amount {} exceeds remaining budget of 20", amt).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "remaining_budget": 20 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let id = c.create_mandate(
                    acc(AGENT), acc(GUARDIAN), acc(TOKEN),
                    U128(100), U128(100), U128(100), vec![acc(SHOP)], EXPIRES,
                );
                set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let _ = c.ft_on_transfer(acc(OWNER), U128(100), format!("{{\"mandate_id\":{id}}}"));
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.spent = 80;
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 5. Deposited lower than budget (deposited = 50, budget = 100, spent = 30, ceiling = 50, remaining = 20)
    let deposited_over_amounts: Vec<u128> = vec![21, 25, 50];
    for (idx, amt) in deposited_over_amounts.into_iter().enumerate() {
        let sub_id = 39 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment amount {} exceeds deposited ceiling of 50", amt).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "deposited": 50, "spent": 30 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let id = c.create_mandate(
                    acc(AGENT), acc(GUARDIAN), acc(TOKEN),
                    U128(100), U128(100), U128(100), vec![acc(SHOP)], EXPIRES,
                );
                set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let _ = c.ft_on_transfer(acc(OWNER), U128(50), format!("{{\"mandate_id\":{id}}}"));
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.spent = 30;
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 6. Addition overflow in budget check
    let overflow_scenarios: Vec<(&'static str, u128, u128, u128)> = vec![
        ("spent + amount overflows u128", u128::MAX - 10, 0, 20),
        ("reserved + amount overflows u128", 0, u128::MAX - 10, 20),
        ("spent + reserved + amount overflows u128", u128::MAX / 2 + 10, u128::MAX / 2, 1),
    ];
    for (idx, (desc, s, r, amt)) in overflow_scenarios.into_iter().enumerate() {
        let sub_id = 42 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: desc,
            params: serde_json::json!({ "spent": s.to_string(), "reserved": r.to_string(), "amount": amt.to_string() }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.spent = s;
                    m.reserved = r;
                    m.deposited = u128::MAX;
                    m.budget = u128::MAX;
                    m.per_payment_cap = u128::MAX;
                    m.approval_threshold = u128::MAX;
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // KAT-A-02-45: Budget = 0 mandate
    cases.push(TestCaseDef {
        id: "KAT-A-02-45",
        category: 2,
        title: "request_payment on budget 0 mandate",
        params: serde_json::json!({ "budget": "0", "amount": "1" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:OVER_PER_PAYMENT_CAP".into()),
        },
        runner: Box::new(|| {
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let id = c.create_mandate(
                acc(AGENT), acc(GUARDIAN), acc(TOKEN),
                U128(0), U128(0), U128(0), vec![acc(SHOP)], EXPIRES,
            );
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(1), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 7. Withdraw amount boundary checks (Revoked mandate, free remainder = 400)
    let withdraw_amounts: Vec<(u128, &'static str, &'static str)> = vec![
        (0, "0", "SCRIP_ERR:ZERO_AMOUNT"),
        (401, "401 (free + 1)", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (402, "402", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (410, "410", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (500, "500", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (1000, "1000", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (1001, "1001", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (u32::MAX as u128, "u32::MAX", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (u64::MAX as u128, "u64::MAX", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (u128::MAX, "u128::MAX", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        (u128::MAX - 1, "u128::MAX - 1", "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
    ];

    for (idx, (amt, desc, err_code)) in withdraw_amounts.into_iter().enumerate() {
        let sub_id = 46 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("withdraw amount {} with free remainder 400", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "amount": amt.to_string(), "free_remainder": 400 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(err_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_revoked_mandate_with_free_remainder();
                let snap = take_snapshot(&c, id);
                set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.withdraw(id, U128(amt))
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // KAT-A-02-57: withdraw 1 when free remainder is 0
    cases.push(TestCaseDef {
        id: "KAT-A-02-57",
        category: 2,
        title: "withdraw 1 when free remainder is 0",
        params: serde_json::json!({ "mandate_id": 1, "amount": "1", "free_remainder": 0 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:AMOUNT_EXCEEDS_FREE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_revoked_mandate_with_free_remainder();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.withdrawn = 700; // committed 200+100+700 = 1000 => free = 0
            }
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.withdraw(id, U128(1))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 8. create_mandate amount and storage deposit boundaries
    let create_scenarios: Vec<(&'static str, NearToken, u128, u128, u128, &'static str)> = vec![
        ("attached deposit 0 NEAR", NearToken::from_yoctonear(0), 1000, 100, 50, "SCRIP_ERR:INSUFFICIENT_STORAGE_DEPOSIT"),
        ("attached deposit 49 milliNEAR", NearToken::from_millinear(49), 1000, 100, 50, "SCRIP_ERR:INSUFFICIENT_STORAGE_DEPOSIT"),
        ("attached deposit 1 yoctoNEAR", NearToken::from_yoctonear(1), 1000, 100, 50, "SCRIP_ERR:INSUFFICIENT_STORAGE_DEPOSIT"),
        ("budget 99 less than cap 100", STORAGE_DEPOSIT_PER_MANDATE, 99, 100, 50, "SCRIP_ERR:BUDGET_LESS_THAN_CAP"),
        ("budget 0 less than cap 1", STORAGE_DEPOSIT_PER_MANDATE, 0, 1, 0, "SCRIP_ERR:BUDGET_LESS_THAN_CAP"),
        ("budget 50 less than cap 100", STORAGE_DEPOSIT_PER_MANDATE, 50, 100, 50, "SCRIP_ERR:BUDGET_LESS_THAN_CAP"),
        ("threshold 101 above cap 100", STORAGE_DEPOSIT_PER_MANDATE, 1000, 100, 101, "SCRIP_ERR:THRESHOLD_ABOVE_CAP"),
        ("threshold 200 above cap 100", STORAGE_DEPOSIT_PER_MANDATE, 1000, 100, 200, "SCRIP_ERR:THRESHOLD_ABOVE_CAP"),
        ("threshold u128::MAX above cap 100", STORAGE_DEPOSIT_PER_MANDATE, 1000, 100, u128::MAX, "SCRIP_ERR:THRESHOLD_ABOVE_CAP"),
        ("budget 100, cap 100, threshold 101", STORAGE_DEPOSIT_PER_MANDATE, 100, 100, 101, "SCRIP_ERR:THRESHOLD_ABOVE_CAP"),
    ];

    for (idx, (desc, dep, b, cap, thr, err_code)) in create_scenarios.into_iter().enumerate() {
        let sub_id = 58 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-02-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 2,
            title: desc,
            params: serde_json::json!({ "deposit": dep.as_yoctonear().to_string(), "budget": b.to_string(), "cap": cap.to_string(), "threshold": thr.to_string() }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(err_code.into()),
            },
            runner: Box::new(move || {
                set_context(OWNER, dep, 100, NOW, 1000);
                let mut c = Scrip::new();
                let next_before = c.next_mandate_id;
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(
                        acc(AGENT), acc(GUARDIAN), acc(TOKEN),
                        U128(b), U128(cap), U128(thr), vec![acc(SHOP)], EXPIRES,
                    )
                }));
                evaluate_create_mandate_panic(&c, next_before, res)
            }),
        });
    }

    // 9. tighten and loosen numeric boundaries
    cases.push(TestCaseDef {
        id: "KAT-A-02-68",
        category: 2,
        title: "tighten budget to same budget 1000",
        params: serde_json::json!({ "new_budget": "1000", "current_budget": 1000 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:NOT_STRICTER".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(1000)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-69",
        category: 2,
        title: "tighten budget to higher budget 1001",
        params: serde_json::json!({ "new_budget": "1001", "current_budget": 1000 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:NOT_STRICTER".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(1001)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-70",
        category: 2,
        title: "tighten budget below committed (committed = 300, new = 299)",
        params: serde_json::json!({ "new_budget": "299", "committed": 300 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:BUDGET_BELOW_COMMITTED".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = 200;
                m.reserved = 100;
            }
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(299)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-71",
        category: 2,
        title: "tighten budget to 0 when committed is 300",
        params: serde_json::json!({ "new_budget": "0", "committed": 300 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:BUDGET_BELOW_COMMITTED".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = 200;
                m.reserved = 100;
            }
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(0)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-72",
        category: 2,
        title: "tighten budget below per_payment_cap (cap = 100, new = 90)",
        params: serde_json::json!({ "new_budget": "90", "cap": 100 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:BUDGET_BELOW_CAP".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(90)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-73",
        category: 2,
        title: "tighten cap to same cap 100",
        params: serde_json::json!({ "new_cap": "100", "current_cap": 100 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:NOT_STRICTER".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::PerPaymentCap(U128(100)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-74",
        category: 2,
        title: "tighten cap below approval_threshold (threshold = 50, new = 49)",
        params: serde_json::json!({ "new_cap": "49", "threshold": 50 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:CAP_BELOW_THRESHOLD".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::PerPaymentCap(U128(49)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-75",
        category: 2,
        title: "loosen budget to same budget 1000",
        params: serde_json::json!({ "new_budget": "1000", "current_budget": 1000 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:NOT_LOOSER".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::Budget(U128(1000)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-76",
        category: 2,
        title: "loosen budget above deposited (deposited = 1000, new = 1001)",
        params: serde_json::json!({ "new_budget": "1001", "deposited": 1000 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:BUDGET_ABOVE_DEPOSITED".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::Budget(U128(1001)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-02-77",
        category: 2,
        title: "loosen cap above budget (budget = 1000, new = 1001)",
        params: serde_json::json!({ "new_cap": "1001", "budget": 1000 }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:CAP_ABOVE_BUDGET".into()) },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::PerPaymentCap(U128(1001)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases
}

fn build_category_5_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. create_mandate role attacks
    cases.push(TestCaseDef {
        id: "KAT-A-05-01",
        category: 5,
        title: "create_mandate where owner == agent",
        params: serde_json::json!({ "owner": OWNER, "agent": OWNER }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:OWNER_IS_AGENT".into()) },
        runner: Box::new(|| {
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(OWNER), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-05-02",
        category: 5,
        title: "create_mandate where guardian == agent",
        params: serde_json::json!({ "guardian": AGENT, "agent": AGENT }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:GUARDIAN_IS_AGENT".into()) },
        runner: Box::new(|| {
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(AGENT), acc(AGENT), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-05-03",
        category: 5,
        title: "create_mandate where guardian == owner",
        params: serde_json::json!({ "guardian": OWNER, "owner": OWNER }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:GUARDIAN_IS_OWNER".into()) },
        runner: Box::new(|| {
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(AGENT), acc(OWNER), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-05-04",
        category: 5,
        title: "create_mandate stranger as owner and agent",
        params: serde_json::json!({ "owner": STRANGER, "agent": STRANGER }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:OWNER_IS_AGENT".into()) },
        runner: Box::new(|| {
            set_context(STRANGER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(STRANGER), acc(GUARDIAN), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-05-05",
        category: 5,
        title: "create_mandate stranger as guardian and agent",
        params: serde_json::json!({ "guardian": STRANGER, "agent": STRANGER }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:GUARDIAN_IS_AGENT".into()) },
        runner: Box::new(|| {
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(STRANGER), acc(STRANGER), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-05-06",
        category: 5,
        title: "create_mandate stranger as guardian and owner",
        params: serde_json::json!({ "guardian": STRANGER, "owner": STRANGER }),
        expected: CaseExpected { label: "BLOCKED".into(), code: Some("SCRIP_ERR:GUARDIAN_IS_OWNER".into()) },
        runner: Box::new(|| {
            set_context(STRANGER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let next_before = c.next_mandate_id;
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.create_mandate(acc(AGENT), acc(STRANGER), acc(TOKEN), U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES)
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    // 2. request_payment unauthorized callers (Authorized caller is AGENT)
    let unauthorized_agents: Vec<(&'static str, &'static str)> = vec![
        (OWNER, "owner alice.testnet"),
        (GUARDIAN, "guardian.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (RELAYER, "relayer.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "recipient shop.testnet"),
        ("sub.agent.testnet", "subaccount sub.agent.testnet"),
        ("fake-agent.testnet", "prefix fake-agent.testnet"),
        ("agent.near", "mainnet suffix agent.near"),
        (CAFE, "recipient cafe.testnet"),
        ("charlie.testnet", "charlie.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_agents.into_iter().enumerate() {
        let sub_id = 7 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("request_payment called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller, "expected_agent": AGENT }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_AGENT".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(10), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 3. tighten unauthorized callers (Authorized: OWNER, GUARDIAN)
    let unauthorized_tighten: Vec<(&'static str, &'static str)> = vec![
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "recipient shop.testnet"),
        ("sub.alice.testnet", "subaccount sub.alice.testnet"),
        ("sub.guardian.testnet", "subaccount sub.guardian.testnet"),
        ("charlie.testnet", "charlie.testnet"),
        ("anon.testnet", "anon.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_tighten.into_iter().enumerate() {
        let sub_id = 19 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("tighten called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::PerPaymentCap(U128(90)))
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 4. loosen unauthorized callers (Authorized: GUARDIAN only!)
    let unauthorized_loosen: Vec<(&'static str, &'static str)> = vec![
        (OWNER, "owner alice.testnet"),
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "shop.testnet"),
        ("sub.guardian.testnet", "subaccount sub.guardian.testnet"),
        ("guardian.near", "mainnet suffix guardian.near"),
        ("charlie.testnet", "charlie.testnet"),
        ("dave.testnet", "dave.testnet"),
        ("mallory.testnet", "mallory.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_loosen.into_iter().enumerate() {
        let sub_id = 29 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("loosen called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller, "expected_guardian": GUARDIAN }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::PerPaymentCap(U128(110)))
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 5. revoke unauthorized callers (Authorized: OWNER, GUARDIAN)
    let unauthorized_revoke: Vec<(&'static str, &'static str)> = vec![
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "shop.testnet"),
        ("sub.agent.testnet", "subaccount sub.agent.testnet"),
        ("mallory.testnet", "mallory.testnet"),
        ("charlie.testnet", "charlie.testnet"),
        ("attacker.testnet", "attacker.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_revoke.into_iter().enumerate() {
        let sub_id = 41 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("revoke called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.revoke(id)
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 6. withdraw unauthorized callers (Authorized: OWNER only!)
    let unauthorized_withdraw: Vec<(&'static str, &'static str)> = vec![
        (GUARDIAN, "guardian.testnet"),
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "shop.testnet"),
        ("sub.alice.testnet", "subaccount sub.alice.testnet"),
        ("alice.near", "mainnet suffix alice.near"),
        ("charlie.testnet", "charlie.testnet"),
        ("mallory.testnet", "mallory.testnet"),
        ("eve.testnet", "eve.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_withdraw.into_iter().enumerate() {
        let sub_id = 51 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("withdraw called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller, "expected_owner": OWNER }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_OWNER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_revoked_mandate_with_free_remainder();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.withdraw(id, U128(100))
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 7. approve_intent unauthorized callers (Authorized: GUARDIAN only!)
    let unauthorized_approvers: Vec<(&'static str, &'static str)> = vec![
        (OWNER, "owner alice.testnet"),
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        (SHOP, "shop.testnet"),
        ("sub.guardian.testnet", "subaccount sub.guardian.testnet"),
        ("charlie.testnet", "charlie.testnet"),
        ("mallory.testnet", "mallory.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_approvers.into_iter().enumerate() {
        let sub_id = 63 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("approve_intent called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller, "expected_guardian": GUARDIAN }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.approve_intent(id, acc(SHOP), U128(80), 999, NOW + 5000);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 8. resolve_stale unauthorized callers (Authorized: GUARDIAN only!)
    let unauthorized_resolvers: Vec<(&'static str, &'static str)> = vec![
        (OWNER, "owner alice.testnet"),
        (AGENT, "agent.testnet"),
        (STRANGER, "stranger bob.testnet"),
        (RELAYER, "relayer.testnet"),
        (CONTRACT, "contract scrip.testnet"),
        (TOKEN, "token usdc.testnet"),
        ("sub.guardian.testnet", "subaccount sub.guardian.testnet"),
        ("mallory.testnet", "mallory.testnet"),
    ];

    for (idx, (caller, desc)) in unauthorized_resolvers.into_iter().enumerate() {
        let sub_id = 73 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let title_str: &'static str = Box::leak(format!("resolve_stale called by unauthorized {}", desc).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: title_str,
            params: serde_json::json!({ "mandate_id": 1, "caller": caller, "expected_guardian": GUARDIAN }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                // Add a pending entry at height 1000
                c.pending.insert((id, 1), Pending { recipient: acc(SHOP), amount: U128(10), height: 1000 });
                let snap = take_snapshot(&c, id);
                // Call at height 1000 + STALE_BLOCKS
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000 + STALE_BLOCKS);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.resolve_stale(id, 1, false);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 9. ft_on_transfer token and sender verification (INERT cases - refund without mutation)
    let ft_scenarios: Vec<(&'static str, &'static str, &'static str, u64)> = vec![
        ("ft_on_transfer from untrusted token contract", "fake_usdc.testnet", OWNER, 1),
        ("ft_on_transfer with sender == agent instead of owner", TOKEN, AGENT, 1),
        ("ft_on_transfer with sender == guardian instead of owner", TOKEN, GUARDIAN, 1),
        ("ft_on_transfer with sender == stranger instead of owner", TOKEN, STRANGER, 1),
        ("ft_on_transfer to non-existent mandate id 999", TOKEN, OWNER, 999),
        ("ft_on_transfer to revoked mandate", TOKEN, OWNER, 1),
    ];

    for (idx, (desc, token_caller, sender, mid)) in ft_scenarios.into_iter().enumerate() {
        let sub_id = 81 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-05-{:02}", sub_id).into_boxed_str());
        let is_revoked = idx == 5;
        cases.push(TestCaseDef {
            id: id_str,
            category: 5,
            title: desc,
            params: serde_json::json!({ "token_caller": token_caller, "sender": sender, "mandate_id": mid }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = if is_revoked {
                    setup_revoked_mandate_with_free_remainder()
                } else {
                    setup_standard_contract()
                };
                let snap = take_snapshot(&c, id);
                set_context(token_caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = format!("{{\"mandate_id\":{mid}}}");
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(sender), U128(500), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, 500, res)
            }),
        });
    }

    // The private-callback guard (on_payment_done, on_withdraw_done) lives in the ABI wrapper,
    // which a direct unit call bypasses; those attacks are exercised in layer D (real wasm) instead.

    cases
}

#[test]
fn attack_catalog_layer_a() {
    let mut all_cases = Vec::new();
    all_cases.extend(build_category_2_cases());
    all_cases.extend(build_category_5_cases());

    println!("Total Layer A test cases: {}", all_cases.len());

    let mut outputs: Vec<AttackCaseOutput> = Vec::new();
    let mut breach_count = 0;
    let mut fail_count = 0;
    let mut pass_count = 0;

    for case in all_cases {
        let actual = (case.runner)();
        let verdict = if actual.label == "BREACH" {
            breach_count += 1;
            "BREACH".to_string()
        } else if actual.label == case.expected.label && actual.code == case.expected.code {
            pass_count += 1;
            "PASS".to_string()
        } else {
            fail_count += 1;
            "FAIL".to_string()
        };

        if verdict != "PASS" {
            println!(
                "NON-PASS: Case [{}] Expected ({:?}, {:?}) vs Actual ({:?}, {:?}) note: {:?}",
                case.id, case.expected.label, case.expected.code, actual.label, actual.code, actual.note
            );
        }

        outputs.push(AttackCaseOutput {
            id: case.id.to_string(),
            category: case.category,
            layer: "A".to_string(),
            title: case.title.to_string(),
            params: case.params,
            expected: case.expected,
            actual,
            verdict,
        });
    }

    println!(
        "Layer A Summary: Total={}, PASS={}, FAIL={}, BREACH={}",
        outputs.len(),
        pass_count,
        fail_count,
        breach_count
    );

    // If ATTACK_CATALOG_OUT environment variable is set, write JSON array
    if let Ok(out_path) = std::env::var("ATTACK_CATALOG_OUT") {
        if !out_path.is_empty() {
            println!("Writing Layer A catalog output to: {}", out_path);
            let json_data = serde_json::to_string_pretty(&outputs).expect("Failed to serialize catalog outputs");
            if let Some(parent) = std::path::Path::new(&out_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&out_path, json_data).expect("Failed to write catalog output file");
        }
    }

    assert_eq!(breach_count, 0, "BREACH detected in Layer A attack catalog!");
    assert_eq!(fail_count, 0, "FAIL detected in Layer A attack catalog!");
}
