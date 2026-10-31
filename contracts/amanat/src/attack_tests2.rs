//! Attack catalog unit tests for Layer A (contract unit level), Part 2.
//! Implements parametric attack vectors for:
//! - Category 4 (Approvals & Nonce)
//! - Category 10 (Mandate Lifecycle & State Transitions)

use super::*;
use super::attack_tests::*;
use near_sdk::NearToken;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn evaluate_view_inert<T>(
    c: &Amanat,
    id: u64,
    snap_before: Option<MandateSnapshot>,
    res: Result<T, Box<dyn std::any::Any + Send>>,
) -> CaseActual {
    let snap_after = take_snapshot(c, id);
    let state_unmodified = snap_before == snap_after;
    match res {
        Ok(_) if state_unmodified => CaseActual {
            label: "INERT".into(),
            code: None,
            note: Some("View call returned without mutating state".into()),
        },
        Ok(_) => CaseActual {
            label: "BREACH".into(),
            code: None,
            note: Some("State mutated during view call".into()),
        },
        Err(err) => {
            let code = extract_panic_code(err);
            CaseActual {
                label: "FAIL".into(),
                code: Some(code),
                note: Some("View call unexpectedly panicked".into()),
            }
        }
    }
}

pub(crate) fn build_category_4_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. Deposit checks on approve_intent (KAT-A-04-01 .. 05)
    let deposit_scenarios: Vec<(&'static str, NearToken)> = vec![
        ("0 attached deposit", NearToken::from_yoctonear(0)),
        ("1 yocto deposit", NearToken::from_yoctonear(1)),
        ("1 millinear deposit", NearToken::from_millinear(1)),
        ("1.99 millinear deposit", NearToken::from_yoctonear(1_990_000_000_000_000_000_000)),
        ("0.001999 NEAR deposit", NearToken::from_yoctonear(1_999_000_000_000_000_000_000)),
    ];
    for (idx, (desc, dep)) in deposit_scenarios.into_iter().enumerate() {
        let sub_id = idx + 1;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "deposit": dep.as_yoctonear().to_string() }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:INSUFFICIENT_APPROVAL_DEPOSIT".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, dep, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.approve_intent(id, acc(SHOP), U128(75), 1, NOW + 10_000);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 2. Caller authorization & mandate checks on approve_intent (KAT-A-04-06 .. 14)
    let caller_scenarios: Vec<(&'static str, &'static str, u64, &'static str)> = vec![
        ("Owner calls approve_intent", OWNER, 1, "AMANAT_ERR:UNAUTHORIZED_GUARDIAN"),
        ("Agent calls approve_intent", AGENT, 1, "AMANAT_ERR:UNAUTHORIZED_GUARDIAN"),
        ("Stranger calls approve_intent", STRANGER, 1, "AMANAT_ERR:UNAUTHORIZED_GUARDIAN"),
        ("Contract calls approve_intent", CONTRACT, 1, "AMANAT_ERR:UNAUTHORIZED_GUARDIAN"),
        ("Relayer calls approve_intent", RELAYER, 1, "AMANAT_ERR:UNAUTHORIZED_GUARDIAN"),
        ("approve_intent on mandate 999", GUARDIAN, 999, "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("approve_intent on mandate 0", GUARDIAN, 0, "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("approve_intent on mandate u64::MAX", GUARDIAN, u64::MAX, "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("approve_intent on revoked mandate", GUARDIAN, 1, "AMANAT_ERR:NOT_ACTIVE"),
    ];
    for (idx, (desc, caller, mid, exp_code)) in caller_scenarios.into_iter().enumerate() {
        let sub_id = 6 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        let is_revoked = idx == 8;
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "caller": caller, "mandate_id": mid, "is_revoked": is_revoked }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = if is_revoked {
                    setup_revoked_mandate_with_free_remainder()
                } else {
                    setup_standard_contract()
                };
                let target_mid = if mid == 1 { id } else { mid };
                let snap = take_snapshot(&c, id);
                set_context(caller, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.approve_intent(target_mid, acc(SHOP), U128(75), 1, NOW + 10_000);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 3. Recipient validation on approve_intent (KAT-A-04-15 .. 24)
    let bad_recipients: Vec<(&'static str, &'static str)> = vec![
        ("Empty recipient", ""),
        ("Uppercase recipient", "SHOP.TESTNET"),
        ("Space in recipient", "shop testnet"),
        ("At sign in recipient", "shop@testnet"),
        ("Slash in recipient", "shop/testnet"),
        ("Colon in recipient", "shop:testnet"),
        ("Semicolon in recipient", "shop;testnet"),
        ("Recipient 65 chars", "a123456789b123456789c123456789d123456789e123456789f12345678901234x"),
        ("Recipient 100 chars", "a123456789b123456789c123456789d123456789e123456789f1234567890123456789012345678901234567890123456789x"),
        ("Null byte in recipient", "shop\0.testnet"),
    ];
    for (idx, (desc, bad_rec)) in bad_recipients.into_iter().enumerate() {
        let sub_id = 15 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "recipient": bad_rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:INVALID_RECIPIENT".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    #[allow(deprecated)]
                    let r: AccountId = AccountId::new_unvalidated(bad_rec.to_string());
                    c.approve_intent(id, r, U128(75), 1, NOW + 10_000);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 4. Expiry validation on approve_intent (KAT-A-04-25 .. 29)
    let bad_expiries: Vec<(&'static str, u64)> = vec![
        ("Approval expiry equals NOW", NOW),
        ("Approval expiry equals NOW - 1", NOW - 1),
        ("Approval expiry is 0", 0),
        ("Approval expiry in distant past", NOW - 100_000),
        ("Approval expiry is 1", 1),
    ];
    for (idx, (desc, bad_exp)) in bad_expiries.into_iter().enumerate() {
        let sub_id = 25 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "approval_expires_at_ms": bad_exp }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:APPROVAL_NOT_IN_FUTURE".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.approve_intent(id, acc(SHOP), U128(75), 1, bad_exp);
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 5. Replay / Duplicate / Limit checks on approve_intent (KAT-A-04-30 .. 33)
    // 30: exact duplicate
    cases.push(TestCaseDef {
        id: "KAT-A-04-30",
        category: 4,
        title: "Exact duplicate approve_intent",
        params: serde_json::json!({ "mandate_id": 1, "nonce": 30, "amount": 75 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:ALREADY_APPROVED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 30, NOW + 10_000);
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.approve_intent(id, acc(SHOP), U128(75), 30, NOW + 10_000);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 31: duplicate approve_intent after payment was executed
    cases.push(TestCaseDef {
        id: "KAT-A-04-31",
        category: 4,
        title: "approve_intent again after approval was used",
        params: serde_json::json!({ "mandate_id": 1, "nonce": 31, "amount": 75 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:ALREADY_APPROVED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 31, NOW + 10_000);
            // Execute payment with approval
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.request_payment(id, acc(SHOP), U128(75), 31);
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.approve_intent(id, acc(SHOP), U128(75), 31, NOW + 10_000);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 32: duplicate approve_intent with different expiry date but same intent hash
    cases.push(TestCaseDef {
        id: "KAT-A-04-32",
        category: 4,
        title: "approve_intent with same intent parameters but different approval expiry",
        params: serde_json::json!({ "mandate_id": 1, "nonce": 32, "amount": 75, "exp1": NOW + 10_000, "exp2": NOW + 20_000 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:ALREADY_APPROVED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 32, NOW + 10_000);
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.approve_intent(id, acc(SHOP), U128(75), 32, NOW + 20_000);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 33: MAX_APPROVALS_PER_MANDATE exceeded (513th approval)
    cases.push(TestCaseDef {
        id: "KAT-A-04-33",
        category: 4,
        title: "Exceeding MAX_APPROVALS_PER_MANDATE (513 approvals)",
        params: serde_json::json!({ "limit": 512 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:TOO_MANY_APPROVALS".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.approvals_count = MAX_APPROVALS_PER_MANDATE;
            }
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.approve_intent(id, acc(SHOP), U128(75), 33, NOW + 10_000);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 6. Payment request approval policy checks (KAT-A-04-34 .. 47)
    // 34: amount 51 without approval
    cases.push(TestCaseDef {
        id: "KAT-A-04-34",
        category: 4,
        title: "Payment amount 51 (cap=100, thresh=50) without approval",
        params: serde_json::json!({ "amount": 51, "threshold": 50 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(51), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 35: amount 75 without approval
    cases.push(TestCaseDef {
        id: "KAT-A-04-35",
        category: 4,
        title: "Payment amount 75 without approval",
        params: serde_json::json!({ "amount": 75 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 36: amount 100 without approval
    cases.push(TestCaseDef {
        id: "KAT-A-04-36",
        category: 4,
        title: "Payment amount 100 (per_payment_cap) without approval",
        params: serde_json::json!({ "amount": 100 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(100), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // Nonce tampering variations (KAT-A-04-37 .. 41)
    let nonce_tampering: Vec<(&'static str, u64, u64)> = vec![
        ("Approved nonce 370, requested nonce 371", 370, 371),
        ("Approved nonce 380, requested nonce 0", 380, 0),
        ("Approved nonce 390, requested nonce u64::MAX", 390, u64::MAX),
        ("Approved nonce 400, requested nonce 401", 400, 401),
        ("Approved nonce 410, requested nonce 409", 410, 409),
    ];
    for (idx, (desc, app_nonce, req_nonce)) in nonce_tampering.into_iter().enumerate() {
        let sub_id = 37 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "approved_nonce": app_nonce, "requested_nonce": req_nonce }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(SHOP), U128(75), app_nonce, NOW + 10_000);
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(75), req_nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // Amount tampering variations (KAT-A-04-42 .. 45)
    let amount_tampering: Vec<(&'static str, u128, u128)> = vec![
        ("Approved amount 75, requested amount 76", 75, 76),
        ("Approved amount 75, requested amount 74", 75, 74),
        ("Approved amount 75, requested amount 51", 75, 51),
        ("Approved amount 75, requested amount 100", 75, 100),
    ];
    for (idx, (desc, app_amt, req_amt)) in amount_tampering.into_iter().enumerate() {
        let sub_id = 42 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "approved_amount": app_amt, "requested_amount": req_amt, "nonce": sub_id }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(SHOP), U128(app_amt), sub_id as u64, NOW + 10_000);
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(req_amt), sub_id as u64)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 46: Recipient mismatch between approval and request
    cases.push(TestCaseDef {
        id: "KAT-A-04-46",
        category: 4,
        title: "Approved for SHOP, requested for CAFE",
        params: serde_json::json!({ "approved_rec": SHOP, "requested_rec": CAFE, "nonce": 46 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 46, NOW + 10_000);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(CAFE), U128(75), 46)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 47: Mandate ID mismatch (approval created on mandate 1, requested on mandate 2)
    cases.push(TestCaseDef {
        id: "KAT-A-04-47",
        category: 4,
        title: "Approval on mandate 1 used on mandate 2",
        params: serde_json::json!({ "approval_mandate": 1, "request_mandate": 2, "nonce": 47 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id1) = setup_standard_contract();
            // Create second mandate
            set_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let id2 = c.create_mandate(
                acc(AGENT),
                acc(GUARDIAN),
                acc(TOKEN),
                U128(1000),
                U128(100),
                U128(50),
                vec![acc(SHOP), acc(CAFE)],
                EXPIRES,
            );
            set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let msg2 = format!("{{\"mandate_id\":{id2}}}");
            let _ = c.ft_on_transfer(acc(OWNER), U128(1000), msg2);

            // Approve on mandate 1
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id1, acc(SHOP), U128(75), 47, NOW + 10_000);

            let snap2 = take_snapshot(&c, id2);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id2, acc(SHOP), U128(75), 47)
            }));
            evaluate_payment_result(&c, id2, snap2, res)
        }),
    });

    // Approval expired on payment (KAT-A-04-48 .. 51)
    let expired_scenarios: Vec<(&'static str, u64)> = vec![
        ("Payment at exact approval expiry", NOW + 5000),
        ("Payment at approval expiry + 1 ms", NOW + 5001),
        ("Payment 5s after approval expiry", NOW + 10_000),
        ("Payment 1000s after approval expiry", NOW + 1_000_000),
    ];
    for (idx, (desc, pay_ts)) in expired_scenarios.into_iter().enumerate() {
        let sub_id = 48 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "approval_expiry": NOW + 5000, "payment_ts": pay_ts, "nonce": sub_id }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:APPROVAL_EXPIRED".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(SHOP), U128(75), sub_id as u64, NOW + 5000);

                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, pay_ts, 1100);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(75), sub_id as u64)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // Approval used / replay on payment (KAT-A-04-52 .. 54)
    // 52: double payment using same approval
    cases.push(TestCaseDef {
        id: "KAT-A-04-52",
        category: 4,
        title: "Replay approval on second request_payment",
        params: serde_json::json!({ "nonce": 52, "amount": 75 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:APPROVAL_USED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 52, NOW + 10_000);

            // First payment succeeds
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.request_payment(id, acc(SHOP), U128(75), 52);

            let snap = take_snapshot(&c, id);
            // Second payment with same approval
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 52)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 53: replay approval after 100 blocks
    cases.push(TestCaseDef {
        id: "KAT-A-04-53",
        category: 4,
        title: "Replay approval 100 blocks later",
        params: serde_json::json!({ "nonce": 53, "height_delta": 100 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:APPROVAL_USED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 53, NOW + 10_000);

            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.request_payment(id, acc(SHOP), U128(75), 53);

            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW + 1000, 1100);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 53)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 54: replay approval after expiry (used check precedence over expired check)
    cases.push(TestCaseDef {
        id: "KAT-A-04-54",
        category: 4,
        title: "Replay used approval after approval expiration time",
        params: serde_json::json!({ "nonce": 54 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:APPROVAL_USED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 54, NOW + 5000);

            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.request_payment(id, acc(SHOP), U128(75), 54);

            let snap = take_snapshot(&c, id);
            // Attempt after approval expiry
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW + 6000, 1100);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 54)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // Mandate expiry de-synchronization attacks (KAT-A-04-55 .. 56)
    // 55: Mandate expiry tightened after approval was granted
    cases.push(TestCaseDef {
        id: "KAT-A-04-55",
        category: 4,
        title: "Approval granted then mandate expiry tightened",
        params: serde_json::json!({ "old_expiry": EXPIRES, "new_expiry": EXPIRES - 1000, "nonce": 55 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 55, NOW + 10_000);

            // Guardian tightens expiry
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::Expiry(EXPIRES - 1000));

            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 55)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 56: Mandate expiry loosened after approval was granted
    cases.push(TestCaseDef {
        id: "KAT-A-04-56",
        category: 4,
        title: "Approval granted then mandate expiry loosened",
        params: serde_json::json!({ "old_expiry": EXPIRES, "new_expiry": EXPIRES + 1000, "nonce": 56 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 56, NOW + 10_000);

            // Guardian loosens expiry
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.loosen(id, Change::Expiry(EXPIRES + 1000));

            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 56)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // Nonce collisions & cross-parameter independence (KAT-A-04-57 .. 63)
    let cross_param_cases: Vec<(&'static str, &'static str, u128, u64, &'static str, u128, u64)> = vec![
        ("Cross-recipient nonce reuse (SHOP->CAFE)", SHOP, 70, 571, CAFE, 70, 571),
        ("Cross-amount nonce reuse (70->80)", SHOP, 70, 581, SHOP, 80, 581),
        ("Same amount different nonce (nonce 591 vs 592)", SHOP, 70, 591, SHOP, 70, 592),
        ("Same amount different nonce (nonce 601 vs 602)", SHOP, 90, 601, SHOP, 90, 602),
        ("Zero nonce vs nonce 1", SHOP, 80, 0, SHOP, 80, 1),
        ("u64::MAX - 1 vs u64::MAX", SHOP, 80, u64::MAX - 1, SHOP, 80, u64::MAX),
        ("Cross-amount and cross-recipient nonce reuse", SHOP, 60, 631, CAFE, 70, 631),
    ];
    for (idx, (desc, app_rec, app_amt, app_n, req_rec, req_amt, req_n)) in cross_param_cases.into_iter().enumerate() {
        let sub_id = 57 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({
                "app": { "rec": app_rec, "amt": app_amt, "nonce": app_n },
                "req": { "rec": req_rec, "amt": req_amt, "nonce": req_n },
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:NEEDS_APPROVAL".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(app_rec), U128(app_amt), app_n, NOW + 10_000);

                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(req_rec), U128(req_amt), req_n)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // View method get_approval / intent_hash fuzzing & attacks (KAT-A-04-64 .. 75)
    let bad_hex_hashes: Vec<(&'static str, &'static str)> = vec![
        ("Empty hash hex", ""),
        ("63-character hash hex", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"),
        ("65-character hash hex", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1"),
        ("32-character hash hex", "a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        ("Non-hex character 'g'", "g1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        ("Non-hex character 'z'", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9z"),
        ("Special character '!' in hash", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f!0"),
        ("Spaces in hash hex", "a1b2c3d4e5f60718 93a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
        ("Uppercase non-hex character 'Z'", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8fZ0"),
    ];
    for (idx, (desc, hex_str)) in bad_hex_hashes.into_iter().enumerate() {
        let sub_id = 64 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-04-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 4,
            title: desc,
            params: serde_json::json!({ "hash_hex": hex_str }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("AMANAT_ERR:INVALID_HASH_HEX".into()),
            },
            runner: Box::new(move || {
                let (c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.get_approval(hex_str.to_string())
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 73: get_approval with 64 zeros (non-existent valid hex) -> INERT (returns None)
    cases.push(TestCaseDef {
        id: "KAT-A-04-73",
        category: 4,
        title: "get_approval for non-existent hash (64 zeros)",
        params: serde_json::json!({ "hash_hex": "0".repeat(64) }),
        expected: CaseExpected {
            label: "INERT".into(),
            code: None,
        },
        runner: Box::new(|| {
            let (c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.get_approval("0".repeat(64))
            }));
            evaluate_view_inert(&c, id, snap, res)
        }),
    });

    // 74: get_approval with 64 'f's (non-existent valid hex) -> INERT (returns None)
    cases.push(TestCaseDef {
        id: "KAT-A-04-74",
        category: 4,
        title: "get_approval for non-existent hash (64 f's)",
        params: serde_json::json!({ "hash_hex": "f".repeat(64) }),
        expected: CaseExpected {
            label: "INERT".into(),
            code: None,
        },
        runner: Box::new(|| {
            let (c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.get_approval("f".repeat(64))
            }));
            evaluate_view_inert(&c, id, snap, res)
        }),
    });

    // 75: intent_hash view method with invalid recipient -> BLOCKED (panics INVALID_RECIPIENT)
    cases.push(TestCaseDef {
        id: "KAT-A-04-75",
        category: 4,
        title: "intent_hash view call with uppercase recipient",
        params: serde_json::json!({ "recipient": "SHOP.TESTNET" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:INVALID_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                #[allow(deprecated)]
                let r: AccountId = AccountId::new_unvalidated("SHOP.TESTNET".to_string());
                c.intent_hash(id, r, U128(75), 1, EXPIRES)
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases
}

#[allow(clippy::type_complexity)]
pub(crate) fn build_category_10_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. Mandate Creation Edge Cases / Invalid Lifecycle start (KAT-A-10-01 .. 10)
    let creation_cases: Vec<(&'static str, &'static str, &'static str, U128, U128, U128, Vec<AccountId>, u64, NearToken, &'static str)> = vec![
        ("create_mandate with budget < per_payment_cap", AGENT, GUARDIAN, U128(50), U128(100), U128(50), vec![acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:BUDGET_LESS_THAN_CAP"),
        ("create_mandate with cap < approval_threshold", AGENT, GUARDIAN, U128(1000), U128(50), U128(100), vec![acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:THRESHOLD_ABOVE_CAP"),
        ("create_mandate with expiry in past", AGENT, GUARDIAN, U128(1000), U128(100), U128(50), vec![acc(SHOP)], NOW - 1000, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with expiry == block_timestamp", AGENT, GUARDIAN, U128(1000), U128(100), U128(50), vec![acc(SHOP)], NOW, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with owner as agent", OWNER, GUARDIAN, U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:OWNER_IS_AGENT"),
        ("create_mandate with guardian as agent", AGENT, AGENT, U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:GUARDIAN_IS_AGENT"),
        ("create_mandate with guardian as owner", AGENT, OWNER, U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:GUARDIAN_IS_OWNER"),
        ("create_mandate with empty recipients", AGENT, GUARDIAN, U128(1000), U128(100), U128(50), vec![], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:EMPTY_RECIPIENTS"),
        ("create_mandate with duplicate recipients", AGENT, GUARDIAN, U128(1000), U128(100), U128(50), vec![acc(SHOP), acc(CAFE), acc(SHOP)], EXPIRES, STORAGE_DEPOSIT_PER_MANDATE, "AMANAT_ERR:DUPLICATE_RECIPIENT"),
        ("create_mandate with insufficient storage deposit (49 millinear)", AGENT, GUARDIAN, U128(1000), U128(100), U128(50), vec![acc(SHOP)], EXPIRES, NearToken::from_millinear(49), "AMANAT_ERR:INSUFFICIENT_STORAGE_DEPOSIT"),
    ];
    for (idx, (desc, agent, guardian, budget, cap, threshold, recs, exp, dep, exp_code)) in creation_cases.into_iter().enumerate() {
        let sub_id = idx + 1;
        let id_str: &'static str = Box::leak(format!("KAT-A-10-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 10,
            title: desc,
            params: serde_json::json!({
                "agent": agent, "guardian": guardian, "budget": budget.0.to_string(),
                "cap": cap.0.to_string(), "threshold": threshold.0.to_string(),
                "expires_at_ms": exp, "deposit": dep.as_yoctonear().to_string()
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let mut c = Amanat::new();
                let recs_for_call = recs.clone();
                let snap = take_snapshot(&c, 1);
                set_context(OWNER, dep, 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(acc(agent), acc(guardian), acc(TOKEN), budget, cap, threshold, recs_for_call, exp);
                }));
                evaluate_call_panic(&c, 1, snap, res)
            }),
        });
    }

    // 2. Revocation Caller & State Attacks (KAT-A-10-11 .. 20)
    let revoke_cases: Vec<(&'static str, &'static str, u64, bool, &'static str, &'static str)> = vec![
        ("Agent calls revoke", AGENT, 1, false, "", "AMANAT_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN"),
        ("Stranger calls revoke", STRANGER, 1, false, "", "AMANAT_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN"),
        ("Contract calls revoke", CONTRACT, 1, false, "", "AMANAT_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN"),
        ("Relayer calls revoke", RELAYER, 1, false, "", "AMANAT_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN"),
        ("Revoke on non-existent mandate 999", OWNER, 999, false, "", "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("Revoke on mandate 0", OWNER, 0, false, "", "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("Double revoke by owner", OWNER, 1, true, OWNER, "AMANAT_ERR:ALREADY_REVOKED"),
        ("Double revoke by guardian after owner revoked", GUARDIAN, 1, true, OWNER, "AMANAT_ERR:ALREADY_REVOKED"),
        ("Double revoke by owner after guardian revoked", OWNER, 1, true, GUARDIAN, "AMANAT_ERR:ALREADY_REVOKED"),
        ("Double revoke by guardian after guardian revoked", GUARDIAN, 1, true, GUARDIAN, "AMANAT_ERR:ALREADY_REVOKED"),
    ];
    for (idx, (desc, caller, mid, is_double, first_revoker, exp_code)) in revoke_cases.into_iter().enumerate() {
        let sub_id = 11 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-10-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 10,
            title: desc,
            params: serde_json::json!({ "caller": caller, "mandate_id": mid, "is_double": is_double }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                if is_double {
                    set_context(first_revoker, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    c.revoke(id);
                }
                let snap = take_snapshot(&c, mid);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.revoke(mid);
                }));
                evaluate_call_panic(&c, mid, snap, res)
            }),
        });
    }

    // 3. Payments on Revoked or Expired Mandates ("revoke lalu bayar", "mandat kedaluwarsa") (KAT-A-10-21 .. 30)
    // 21: revoked mandate, payment 25
    cases.push(TestCaseDef {
        id: "KAT-A-10-21",
        category: 10,
        title: "Payment request on revoked mandate (amount 25 <= cap, thresh)",
        params: serde_json::json!({ "mandate_id": 1, "amount": 25, "revoked": true }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1021)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 22: revoked mandate, payment 45
    cases.push(TestCaseDef {
        id: "KAT-A-10-22",
        category: 10,
        title: "Payment request on revoked mandate (amount 45 <= cap, thresh)",
        params: serde_json::json!({ "mandate_id": 1, "amount": 45, "revoked_by": GUARDIAN }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(45), 1022)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 23: revoked mandate with approved intent (amount 75)
    cases.push(TestCaseDef {
        id: "KAT-A-10-23",
        category: 10,
        title: "Payment request on revoked mandate with approved intent (amount 75)",
        params: serde_json::json!({ "mandate_id": 1, "amount": 75, "nonce": 1023 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 1023, NOW + 10_000);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 1023)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 24: payment at exact expiry
    cases.push(TestCaseDef {
        id: "KAT-A-10-24",
        category: 10,
        title: "Payment request on expired mandate at exact expiry ms",
        params: serde_json::json!({ "payment_ts": EXPIRES }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:EXPIRED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, EXPIRES, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1024)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 25: payment 1ms after expiry
    cases.push(TestCaseDef {
        id: "KAT-A-10-25",
        category: 10,
        title: "Payment request on expired mandate 1ms after expiry",
        params: serde_json::json!({ "payment_ts": EXPIRES + 1 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:EXPIRED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, EXPIRES + 1, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1025)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 26: payment 1000s after expiry
    cases.push(TestCaseDef {
        id: "KAT-A-10-26",
        category: 10,
        title: "Payment request on expired mandate 1000s after expiry",
        params: serde_json::json!({ "payment_ts": EXPIRES + 1_000_000 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:EXPIRED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, EXPIRES + 1_000_000, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1026)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 27: payment on expired mandate with valid approval
    cases.push(TestCaseDef {
        id: "KAT-A-10-27",
        category: 10,
        title: "Payment request on expired mandate with valid approval",
        params: serde_json::json!({ "approval_expiry": EXPIRES + 50_000, "payment_ts": EXPIRES + 10 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:EXPIRED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 1027, EXPIRES + 50_000);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, EXPIRES + 10, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 1027)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 28: payment on mandate that is both revoked AND expired
    cases.push(TestCaseDef {
        id: "KAT-A-10-28",
        category: 10,
        title: "Payment request on mandate that is both revoked and expired",
        params: serde_json::json!({ "revoked": true, "payment_ts": EXPIRES + 10 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, EXPIRES + 10, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1028)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 29: tighten called on revoked mandate
    cases.push(TestCaseDef {
        id: "KAT-A-10-29",
        category: 10,
        title: "tighten called on revoked mandate",
        params: serde_json::json!({ "revoked": true, "change": "Budget(900)" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(900)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 30: loosen called on revoked mandate
    cases.push(TestCaseDef {
        id: "KAT-A-10-30",
        category: 10,
        title: "loosen called on revoked mandate",
        params: serde_json::json!({ "revoked": true, "change": "PerPaymentCap(120)" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::PerPaymentCap(U128(120)))
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 4. Withdrawal Lifecycle Attacks (KAT-A-10-31 .. 42)
    let withdraw_cases: Vec<(&'static str, &'static str, u64, bool, u128, u64, &'static str)> = vec![
        ("withdraw called while mandate is still Active", OWNER, 1, false, 100, 100, "AMANAT_ERR:MANDATE_STILL_ACTIVE"),
        ("withdraw called by Agent on revoked mandate", AGENT, 1, true, 100, 100, "AMANAT_ERR:UNAUTHORIZED_OWNER"),
        ("withdraw called by Guardian on revoked mandate", GUARDIAN, 1, true, 100, 100, "AMANAT_ERR:UNAUTHORIZED_OWNER"),
        ("withdraw called by Stranger on revoked mandate", STRANGER, 1, true, 100, 100, "AMANAT_ERR:UNAUTHORIZED_OWNER"),
        ("withdraw called on non-existent mandate 999", OWNER, 999, true, 100, 100, "AMANAT_ERR:MANDATE_NOT_FOUND"),
        ("withdraw with amount 0 on revoked mandate", OWNER, 1, true, 0, 100, "AMANAT_ERR:ZERO_AMOUNT"),
        ("withdraw with amount exceeding free remainder (1001 > 1000)", OWNER, 1, true, 1001, 100, "AMANAT_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw with amount u128::MAX on revoked mandate", OWNER, 1, true, u128::MAX, 100, "AMANAT_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw with insufficient prepaid gas (59 Tgas < 60 Tgas)", OWNER, 1, true, 100, 59, "AMANAT_ERR:INSUFFICIENT_GAS"),
    ];
    for (idx, (desc, caller, mid, is_revoked, amt, tgas, exp_code)) in withdraw_cases.into_iter().enumerate() {
        let sub_id = 31 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-10-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 10,
            title: desc,
            params: serde_json::json!({ "caller": caller, "mandate_id": mid, "amount": amt.to_string(), "gas_tgas": tgas }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                if is_revoked {
                    set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    c.revoke(id);
                }
                let snap = take_snapshot(&c, mid);
                set_context(caller, NearToken::from_yoctonear(0), tgas, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    let _ = c.withdraw(mid, U128(amt));
                }));
                evaluate_call_panic(&c, mid, snap, res)
            }),
        });
    }

    // 40: double withdraw exceeding free balance
    cases.push(TestCaseDef {
        id: "KAT-A-10-40",
        category: 10,
        title: "Double withdraw exceeding remaining free balance",
        params: serde_json::json!({ "first_withdraw": 1000, "second_withdraw": 1 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:AMOUNT_EXCEEDS_FREE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            // First withdraw full amount
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.withdraw(id, U128(1000));
            let snap = take_snapshot(&c, id);
            // Second withdraw of 1 token should fail
            let res = catch_unwind(AssertUnwindSafe(|| {
                let _ = c.withdraw(id, U128(1));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 41: withdraw cannot touch reserved amount
    cases.push(TestCaseDef {
        id: "KAT-A-10-41",
        category: 10,
        title: "withdraw cannot touch reserved amount for in-flight requests",
        params: serde_json::json!({ "deposited": 1000, "reserved": 25, "withdraw_attempt": 976 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:AMOUNT_EXCEEDS_FREE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1041);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            let snap = take_snapshot(&c, id);
            // Free remainder is 1000 - 25 = 975; attempting 976 must fail
            let res = catch_unwind(AssertUnwindSafe(|| {
                let _ = c.withdraw(id, U128(976));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 42: request_payment after withdrawal ("withdraw lalu bayar")
    cases.push(TestCaseDef {
        id: "KAT-A-10-42",
        category: 10,
        title: "Payment request after full withdrawal (withdraw lalu bayar)",
        params: serde_json::json!({ "withdrawn": 1000, "request_amount": 25 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.revoke(id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.withdraw(id, U128(1000));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1042)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // 5. Tighten vs Loosen Direction Inversion Attacks ("tighten/loosen terbalik") (KAT-A-10-43 .. 54)
    let dir_inversion_cases: Vec<(&'static str, bool, Change, &'static str)> = vec![
        ("tighten budget higher than current budget (1100 > 1000)", true, Change::Budget(U128(1100)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten budget equal to current budget (1000 == 1000)", true, Change::Budget(U128(1000)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten per_payment_cap higher than current cap (150 > 100)", true, Change::PerPaymentCap(U128(150)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten per_payment_cap equal to current cap (100 == 100)", true, Change::PerPaymentCap(U128(100)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten approval_threshold higher than current threshold (60 > 50)", true, Change::ApprovalThreshold(U128(60)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten approval_threshold equal to current threshold (50 == 50)", true, Change::ApprovalThreshold(U128(50)), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten expiry later than current expiry (EXPIRES + 1000)", true, Change::Expiry(EXPIRES + 1000), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten expiry equal to current expiry (EXPIRES == EXPIRES)", true, Change::Expiry(EXPIRES), "AMANAT_ERR:NOT_STRICTER"),
        ("tighten AddRecipient (not stricter)", true, Change::AddRecipient(acc(STRANGER)), "AMANAT_ERR:NOT_STRICTER"),
        ("loosen budget lower than current budget (900 < 1000)", false, Change::Budget(U128(900)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen budget equal to current budget (1000 == 1000)", false, Change::Budget(U128(1000)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen per_payment_cap lower than current cap (90 < 100)", false, Change::PerPaymentCap(U128(90)), "AMANAT_ERR:NOT_LOOSER"),
    ];
    for (idx, (desc, is_tighten, change, exp_code)) in dir_inversion_cases.into_iter().enumerate() {
        let sub_id = 43 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-10-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 10,
            title: desc,
            params: serde_json::json!({ "is_tighten": is_tighten, "change": format!("{:?}", change) }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                let ch = change.clone();
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    if is_tighten {
                        c.tighten(id, ch);
                    } else {
                        c.loosen(id, ch);
                    }
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 6. Tighten/Loosen Invariant & Boundary Violations (KAT-A-10-55 .. 64)
    let boundary_inversion_cases: Vec<(&'static str, bool, Change, &'static str)> = vec![
        ("loosen per_payment_cap equal to current cap (100 == 100)", false, Change::PerPaymentCap(U128(100)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen approval_threshold lower than current threshold (40 < 50)", false, Change::ApprovalThreshold(U128(40)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen approval_threshold equal to current threshold (50 == 50)", false, Change::ApprovalThreshold(U128(50)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen RemoveRecipient (not looser)", false, Change::RemoveRecipient(acc(SHOP)), "AMANAT_ERR:NOT_LOOSER"),
        ("loosen expiry earlier than current expiry (EXPIRES - 1000)", false, Change::Expiry(EXPIRES - 1000), "AMANAT_ERR:NOT_LOOSER"),
    ];
    for (idx, (desc, is_tighten, change, exp_code)) in boundary_inversion_cases.into_iter().enumerate() {
        let sub_id = 55 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-10-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 10,
            title: desc,
            params: serde_json::json!({ "is_tighten": is_tighten, "change": format!("{:?}", change) }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_standard_contract();
                let snap = take_snapshot(&c, id);
                let ch = change.clone();
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    if is_tighten {
                        c.tighten(id, ch);
                    } else {
                        c.loosen(id, ch);
                    }
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // 60: tighten budget below spent + reserved
    cases.push(TestCaseDef {
        id: "KAT-A-10-60",
        category: 10,
        title: "tighten budget below committed (spent 200 + reserved 100 = 300; try 250)",
        params: serde_json::json!({ "committed": 300, "new_budget": 250 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:BUDGET_BELOW_COMMITTED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = 200;
                m.reserved = 100;
            }
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(250)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 61: tighten budget below per_payment_cap
    cases.push(TestCaseDef {
        id: "KAT-A-10-61",
        category: 10,
        title: "tighten budget below per_payment_cap (cap=100; try 90)",
        params: serde_json::json!({ "cap": 100, "new_budget": 90 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:BUDGET_BELOW_CAP".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Budget(U128(90)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 62: tighten cap below approval_threshold
    cases.push(TestCaseDef {
        id: "KAT-A-10-62",
        category: 10,
        title: "tighten cap below approval_threshold (thresh=50; try 40)",
        params: serde_json::json!({ "threshold": 50, "new_cap": 40 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:CAP_BELOW_THRESHOLD".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::PerPaymentCap(U128(40)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 63: tighten expiry to timestamp <= now
    cases.push(TestCaseDef {
        id: "KAT-A-10-63",
        category: 10,
        title: "tighten expiry to timestamp <= now (NOW)",
        params: serde_json::json!({ "new_expiry": NOW }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:EXPIRY_NOT_IN_FUTURE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::Expiry(NOW));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 64: tighten RemoveRecipient for non-existent recipient
    cases.push(TestCaseDef {
        id: "KAT-A-10-64",
        category: 10,
        title: "tighten RemoveRecipient for non-existent recipient (stranger.testnet)",
        params: serde_json::json!({ "recipient": STRANGER }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NO_SUCH_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::RemoveRecipient(acc(STRANGER)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 7. Loosen Boundaries, Stale Resolution & Callbacks (KAT-A-10-65 .. 75)
    // 65: loosen budget above deposited
    cases.push(TestCaseDef {
        id: "KAT-A-10-65",
        category: 10,
        title: "loosen budget above deposited amount (deposited 1000, try 1500)",
        params: serde_json::json!({ "deposited": 1000, "new_budget": 1500 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:BUDGET_ABOVE_DEPOSITED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::Budget(U128(1500)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 66: loosen cap above budget
    cases.push(TestCaseDef {
        id: "KAT-A-10-66",
        category: 10,
        title: "loosen cap above budget (budget 1000, try 1200)",
        params: serde_json::json!({ "budget": 1000, "new_cap": 1200 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:CAP_ABOVE_BUDGET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::PerPaymentCap(U128(1200)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 67: loosen threshold above cap
    cases.push(TestCaseDef {
        id: "KAT-A-10-67",
        category: 10,
        title: "loosen threshold above cap (cap 100, try 150)",
        params: serde_json::json!({ "cap": 100, "new_threshold": 150 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:THRESHOLD_ABOVE_CAP".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::ApprovalThreshold(U128(150)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 68: loosen add duplicate recipient
    cases.push(TestCaseDef {
        id: "KAT-A-10-68",
        category: 10,
        title: "loosen add duplicate recipient (SHOP)",
        params: serde_json::json!({ "recipient": SHOP }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:DUPLICATE_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::AddRecipient(acc(SHOP)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 69: loosen add invalid recipient format
    cases.push(TestCaseDef {
        id: "KAT-A-10-69",
        category: 10,
        title: "loosen add invalid recipient format ('INVALID.SHOP')",
        params: serde_json::json!({ "recipient": "INVALID.SHOP" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:INVALID_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                #[allow(deprecated)]
                let r = AccountId::new_unvalidated("INVALID.SHOP".to_string());
                c.loosen(id, Change::AddRecipient(r));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 70: resolve_stale called by Owner
    cases.push(TestCaseDef {
        id: "KAT-A-10-70",
        category: 10,
        title: "resolve_stale called by Owner (unauthorized guardian)",
        params: serde_json::json!({ "caller": OWNER }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:UNAUTHORIZED_GUARDIAN".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 100);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1070);
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 350);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 1, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 71: resolve_stale called by Agent
    cases.push(TestCaseDef {
        id: "KAT-A-10-71",
        category: 10,
        title: "resolve_stale called by Agent (unauthorized guardian)",
        params: serde_json::json!({ "caller": AGENT }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:UNAUTHORIZED_GUARDIAN".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 100);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1071);
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 350);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 1, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 72: resolve_stale before STALE_BLOCKS have passed (delta = 50 < 200)
    cases.push(TestCaseDef {
        id: "KAT-A-10-72",
        category: 10,
        title: "resolve_stale before STALE_BLOCKS have passed (delta = 50 < 200)",
        params: serde_json::json!({ "start_height": 100, "call_height": 150, "delta": 50 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_STALE_YET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 100);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1072);
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 150);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 1, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 73: resolve_stale at STALE_BLOCKS - 1 (delta = 199 < 200)
    cases.push(TestCaseDef {
        id: "KAT-A-10-73",
        category: 10,
        title: "resolve_stale at STALE_BLOCKS - 1 (delta = 199 < 200)",
        params: serde_json::json!({ "start_height": 100, "call_height": 299, "delta": 199 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NOT_STALE_YET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 100);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1073);
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 299);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 1, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 74: Double resolve_stale call (resolve_stale ganda)
    cases.push(TestCaseDef {
        id: "KAT-A-10-74",
        category: 10,
        title: "Double resolve_stale call (resolve_stale ganda)",
        params: serde_json::json!({ "first_resolution": "success", "second_call": "must fail NO_SUCH_PENDING" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NO_SUCH_PENDING".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 100);
            let _ = c.request_payment(id, acc(SHOP), U128(25), 1074);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 350);
            // First resolution succeeds
            c.resolve_stale(id, 1, false);
            let snap = take_snapshot(&c, id);
            // Second call with same request_id must fail
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 1, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // 75: resolve_stale for non-existent request_id 999
    cases.push(TestCaseDef {
        id: "KAT-A-10-75",
        category: 10,
        title: "resolve_stale for non-existent request_id 999",
        params: serde_json::json!({ "request_id": 999 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("AMANAT_ERR:NO_SUCH_PENDING".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.resolve_stale(id, 999, false);
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases
}

#[test]
fn attack_catalog_layer_a_part2() {
    let mut all_cases = Vec::new();
    all_cases.extend(build_category_4_cases());
    all_cases.extend(build_category_10_cases());

    println!("Total Layer A Part 2 test cases: {}", all_cases.len());

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
        "Layer A Part 2 Summary: Total={}, PASS={}, FAIL={}, BREACH={}",
        outputs.len(),
        pass_count,
        fail_count,
        breach_count
    );

    if let Ok(out_path) = std::env::var("ATTACK_CATALOG_OUT_PART2") {
        if !out_path.is_empty() {
            println!("Writing Layer A Part 2 catalog output to: {}", out_path);
            let json_data = serde_json::to_string_pretty(&outputs).expect("Failed to serialize catalog outputs");
            if let Some(parent) = std::path::Path::new(&out_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&out_path, json_data).expect("Failed to write catalog output file");
        }
    }

    assert_eq!(breach_count, 0, "BREACH detected in Layer A attack catalog part 2!");
    assert_eq!(fail_count, 0, "FAIL detected in Layer A attack catalog part 2!");
}
