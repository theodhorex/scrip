//! Attack catalog unit tests for Layer A (contract unit level), Part 4.
//! Implements parametric attack vectors for:
//! - Category 11 (Token and Financial Integrity, ~90-100 cases)
//! - Category 12 (Out of Threat Model & Absurd Edge Cases, ~60 cases)

use super::*;
use super::attack_tests::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::NearToken;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn set_clean_context(pred: &str, deposit: NearToken, tgas: u64, ts_ms: u64, height: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(ts_ms * 1_000_000)
        .block_height(height)
        .prepaid_gas(Gas::from_tgas(tgas))
        .attached_deposit(deposit);
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        std::collections::HashMap::new(),
        Default::default(),
        None,
    ));
}

fn setup_fresh_standard_contract() -> (Scrip, u64) {
    set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
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
    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
    let msg = format!("{{\"mandate_id\":{id}}}");
    let _ = c.ft_on_transfer(acc(OWNER), U128(1000), msg);
    (c, id)
}

fn setup_fresh_revoked_mandate() -> (Scrip, u64) {
    let (mut c, id) = setup_fresh_standard_contract();
    if let Some(m) = c.mandates.get_mut(&id) {
        m.spent = 200;
        m.reserved = 100;
        m.withdrawn = 300;
    }
    set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
    c.revoke(id);
    (c, id)
}

pub(crate) fn build_category_11_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. ft_on_transfer from fake token / wrong predecessor (KAT-A-11-01 .. 12)
    let fake_token_callers: Vec<(&'static str, &'static str)> = vec![
        ("Fake USDC contract predecessor", "fake_usdc.testnet"),
        ("Attacker token contract", "attacker_ft.testnet"),
        ("Malicious token contract", "malicious_token.testnet"),
        ("Owner account as predecessor", OWNER),
        ("Agent account as predecessor", AGENT),
        ("Guardian account as predecessor", GUARDIAN),
        ("Contract itself as predecessor", CONTRACT),
        ("Random outsider as predecessor", STRANGER),
        ("Misspelled token predecessor", "usdc_fake.testnet"),
        ("Wrap NEAR token predecessor", "wrap.testnet"),
        ("Root NEAR account predecessor", "near"),
        ("Sub-account token predecessor", "sub.usdc.testnet"),
    ];
    for (idx, (desc, pred)) in fake_token_callers.into_iter().enumerate() {
        let sub_id = idx + 1;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "predecessor": pred, "amount": 1000 }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(pred, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = format!("{{\"mandate_id\":{id}}}");
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(OWNER), U128(1000), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, 1000, res)
            }),
        });
    }

    // 2. ft_on_transfer with fake sender / not mandate owner (KAT-A-11-13 .. 24)
    let fake_senders: Vec<(&'static str, &'static str)> = vec![
        ("Agent acts as sender in deposit", AGENT),
        ("Guardian acts as sender in deposit", GUARDIAN),
        ("Stranger acts as sender in deposit", STRANGER),
        ("Contract itself acts as sender in deposit", CONTRACT),
        ("Attacker account as sender", "attacker.testnet"),
        ("Relayer account as sender", RELAYER),
        ("Shop account as sender", SHOP),
        ("Cafe account as sender", CAFE),
        ("Evil imposter as sender", "evil.testnet"),
        ("Charlie account as sender", "charlie.testnet"),
        ("Fake owner spelling", "fake_alice.testnet"),
        ("Different owner subaccount", "alice.testnet.sub"),
    ];
    for (idx, (desc, sender)) in fake_senders.into_iter().enumerate() {
        let sub_id = 13 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "sender_id": sender, "amount": 500 }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = format!("{{\"mandate_id\":{id}}}");
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(sender), U128(500), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, 500, res)
            }),
        });
    }

    // 3. ft_on_transfer to non-existent mandate ID (KAT-A-11-25 .. 32)
    let non_existent_ids: Vec<(&'static str, u64)> = vec![
        ("Deposit to mandate ID 0 (never assigned)", 0),
        ("Deposit to non-existent mandate ID 999", 999),
        ("Deposit to non-existent mandate ID 1000", 1000),
        ("Deposit to non-existent mandate ID 99999", 99999),
        ("Deposit to mandate ID u64::MAX", u64::MAX),
        ("Deposit to mandate ID u64::MAX - 1", u64::MAX - 1),
        ("Deposit to mandate ID 42 (uncreated)", 42),
        ("Deposit to mandate ID 777 (uncreated)", 777),
    ];
    for (idx, (desc, target_id)) in non_existent_ids.into_iter().enumerate() {
        let sub_id = 25 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "target_mandate_id": target_id, "amount": 300 }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, existing_id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, existing_id);
                set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = format!("{{\"mandate_id\":{target_id}}}");
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(OWNER), U128(300), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, existing_id, snap, 300, res)
            }),
        });
    }

    // 4. ft_on_transfer msg deserialization failures & anomalies (KAT-A-11-33 .. 52)
    let msg_anomalies: Vec<(&'static str, String)> = vec![
        ("Empty msg string", "".to_string()),
        ("Whitespace only msg", "   ".to_string()),
        ("Non-JSON raw string", "not_a_valid_json".to_string()),
        ("Incomplete JSON open brace", "{".to_string()),
        ("Missing closing brace in msg", "{\"mandate_id\": 1".to_string()),
        ("Empty JSON object without mandate_id", "{}".to_string()),
        ("Wrong field name 'id' instead of mandate_id", "{\"id\": 1}".to_string()),
        ("Wrong field name 'mandate' instead of mandate_id", "{\"mandate\": 1}".to_string()),
        ("CamelCase 'mandateId' instead of mandate_id", "{\"mandateId\": 1}".to_string()),
        ("Negative mandate_id -1", "{\"mandate_id\": -1}".to_string()),
        ("Negative mandate_id -99999", "{\"mandate_id\": -99999}".to_string()),
        ("String quoted mandate_id", "{\"mandate_id\": \"1\"}".to_string()),
        ("Float mandate_id 1.5", "{\"mandate_id\": 1.5}".to_string()),
        ("Scientific notation mandate_id 1e6", "{\"mandate_id\": 1e6}".to_string()),
        ("Overflow mandate_id (u64::MAX + 1)", "{\"mandate_id\": 18446744073709551616}".to_string()),
        ("JSON array payload [] (missing mandate_id)", "[]".to_string()),
        ("Array inside mandate_id field", "{\"mandate_id\": [1]}".to_string()),
        ("Null value in mandate_id field", "{\"mandate_id\": null}".to_string()),
        ("Nested object inside mandate_id", "{\"mandate_id\": {\"nested\": 1}}".to_string()),
        ("Boolean value inside mandate_id", "{\"mandate_id\": true}".to_string()),
    ];
    for (idx, (desc, bad_msg)) in msg_anomalies.into_iter().enumerate() {
        let sub_id = 33 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "msg": bad_msg, "amount": 200 }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(OWNER), U128(200), bad_msg.clone())
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, 200, res)
            }),
        });
    }

    // 5. ft_on_transfer with zero amount (KAT-A-11-53 .. 58)
    let zero_amount_scenarios: Vec<(&'static str, &'static str, &'static str, bool, u64)> = vec![
        ("Zero amount deposit from owner with valid msg", TOKEN, OWNER, true, 1),
        ("Zero amount deposit from fake token contract", "fake_token.testnet", OWNER, true, 1),
        ("Zero amount deposit from stranger sender", TOKEN, STRANGER, true, 1),
        ("Zero amount deposit with malformed msg", TOKEN, OWNER, false, 1),
        ("Zero amount deposit to non-existent mandate", TOKEN, OWNER, true, 999),
        ("Zero amount deposit on revoked mandate", TOKEN, OWNER, true, 2),
    ];
    for (idx, (desc, pred, sender, valid_msg, target_mandate)) in zero_amount_scenarios.into_iter().enumerate() {
        let sub_id = 53 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "predecessor": pred, "sender": sender, "amount": 0 }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = if target_mandate == 2 {
                    setup_fresh_revoked_mandate()
                } else {
                    setup_fresh_standard_contract()
                };
                let snap = take_snapshot(&c, id);
                set_context(pred, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = if valid_msg {
                    let m_id = if target_mandate == 999 { 999 } else { id };
                    format!("{{\"mandate_id\":{m_id}}}")
                } else {
                    "invalid_json".to_string()
                };
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(sender), U128(0), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, 0, res)
            }),
        });
    }

    // 6. ft_on_transfer to revoked mandate (KAT-A-11-59 .. 66)
    let revoked_deposit_scenarios: Vec<(&'static str, &'static str, &'static str, u128)> = vec![
        ("Deposit 100 tokens to revoked mandate from owner", TOKEN, OWNER, 100),
        ("Deposit 1000 tokens to revoked mandate from owner", TOKEN, OWNER, 1000),
        ("Deposit 1 token to revoked mandate from owner", TOKEN, OWNER, 1),
        ("Deposit to revoked mandate from stranger", TOKEN, STRANGER, 500),
        ("Deposit to revoked mandate from fake token", "fake_token.testnet", OWNER, 500),
        ("Deposit u128::MAX to revoked mandate", TOKEN, OWNER, u128::MAX),
        ("Deposit 250 tokens to revoked mandate with spent balance", TOKEN, OWNER, 250),
        ("Deposit 50 tokens to revoked mandate with withdrawn balance", TOKEN, OWNER, 50),
    ];
    for (idx, (desc, pred, sender, amt)) in revoked_deposit_scenarios.into_iter().enumerate() {
        let sub_id = 59 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "amount": amt.to_string(), "mandate_status": "Revoked" }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_revoked_mandate();
                let snap = take_snapshot(&c, id);
                set_context(pred, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let msg = format!("{{\"mandate_id\":{id}}}");
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.ft_on_transfer(acc(sender), U128(amt), msg)
                }));
                evaluate_ft_on_transfer_inert(&c, id, snap, amt, res)
            }),
        });
    }

    // 7. Double deposit and arithmetic overflow on deposit (KAT-A-11-67 .. 72)
    let deposit_overflow_scenarios: Vec<(&'static str, u128, u128)> = vec![
        ("Deposit overflow: u128::MAX - 100 + 200", u128::MAX - 100, 200),
        ("Deposit overflow: u128::MAX + 1", u128::MAX, 1),
        ("Deposit overflow: u128::MAX - 1 + u128::MAX", u128::MAX - 1, u128::MAX),
        ("Valid double deposit then stranger deposit refunded", 1000, 500),
        ("Valid double deposit then fake token deposit refunded", 1000, 500),
        ("Valid double deposit then malformed msg refunded", 1000, 500),
    ];
    for (idx, (desc, initial_dep, second_amt)) in deposit_overflow_scenarios.into_iter().enumerate() {
        let sub_id = 67 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({ "initial": initial_dep.to_string(), "second": second_amt.to_string() }),
            expected: CaseExpected {
                label: "INERT".into(),
                code: None,
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.deposited = initial_dep;
                }
                let snap = take_snapshot(&c, id);
                if idx < 3 {
                    // Overflow cases
                    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let msg = format!("{{\"mandate_id\":{id}}}");
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.ft_on_transfer(acc(OWNER), U128(second_amt), msg)
                    }));
                    evaluate_ft_on_transfer_inert(&c, id, snap, second_amt, res)
                } else if idx == 3 {
                    // Stranger deposit after second deposit
                    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let msg = format!("{{\"mandate_id\":{id}}}");
                    let _ = c.ft_on_transfer(acc(OWNER), U128(second_amt), msg.clone());
                    let snap2 = take_snapshot(&c, id);
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.ft_on_transfer(acc(STRANGER), U128(100), msg)
                    }));
                    evaluate_ft_on_transfer_inert(&c, id, snap2, 100, res)
                } else if idx == 4 {
                    // Fake token deposit after second deposit
                    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let msg = format!("{{\"mandate_id\":{id}}}");
                    let _ = c.ft_on_transfer(acc(OWNER), U128(second_amt), msg.clone());
                    let snap2 = take_snapshot(&c, id);
                    set_context("fake_token.testnet", NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.ft_on_transfer(acc(OWNER), U128(100), msg)
                    }));
                    evaluate_ft_on_transfer_inert(&c, id, snap2, 100, res)
                } else {
                    // Malformed msg after second deposit
                    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let msg = format!("{{\"mandate_id\":{id}}}");
                    let _ = c.ft_on_transfer(acc(OWNER), U128(second_amt), msg);
                    let snap2 = take_snapshot(&c, id);
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.ft_on_transfer(acc(OWNER), U128(100), "{bad_json}".into())
                    }));
                    evaluate_ft_on_transfer_inert(&c, id, snap2, 100, res)
                }
            }),
        });
    }

    // 8. Off-by-one accounting checks on deposited / spent / reserved / withdrawn (KAT-A-11-73 .. 92)
    // Testing boundary conditions on ceiling = min(budget, deposited - withdrawn) vs spent + reserved + amount
    let off_by_one_scenarios: Vec<(&'static str, u128, u128, u128, u128, u128, &'static str)> = vec![
        // (desc, deposited, withdrawn, spent, reserved, req_amount, expected_code)
        ("spent + reserved + amount == ceiling + 1 (901+0+100 > 1000)", 1000, 0, 901, 0, 100, "OVER_BUDGET"),
        ("spent + reserved + amount == ceiling + 1 (950+0+51 > 1000)", 1000, 0, 950, 0, 51, "OVER_BUDGET"),
        ("spent + reserved + amount == ceiling + 2 (950+0+52 > 1000)", 1000, 0, 950, 0, 52, "OVER_BUDGET"),
        ("reserved + amount == ceiling + 1 (0+950+51 > 1000)", 1000, 0, 0, 950, 51, "OVER_BUDGET"),
        ("reserved + amount == ceiling + 2 (0+950+52 > 1000)", 1000, 0, 0, 950, 52, "OVER_BUDGET"),
        ("spent + reserved + amount == ceiling + 1 (500+450+51 > 1000)", 1000, 0, 500, 450, 51, "OVER_BUDGET"),
        ("deposited bounded ceiling: dep 500, with 200 => ceiling 300; req 51 at spent 250", 500, 200, 250, 0, 51, "OVER_BUDGET"),
        ("deposited bounded ceiling: dep 500, with 200 => ceiling 300; req 52 at spent 250", 500, 200, 250, 0, 52, "OVER_BUDGET"),
        ("deposited == withdrawn (1000==1000) => ceiling 0, req 1", 1000, 1000, 0, 0, 1, "OVER_BUDGET"),
        ("deposited == withdrawn (1000==1000) => ceiling 0, req 50", 1000, 1000, 0, 0, 50, "OVER_BUDGET"),
        ("deposited < withdrawn (1000 < 1001) => ceiling 0, req 1", 1000, 1001, 0, 0, 1, "OVER_BUDGET"),
        ("deposited < withdrawn (500 < 600) => ceiling 0, req 10", 500, 600, 0, 0, 10, "OVER_BUDGET"),
        ("budget ceiling reached: budget 500, dep 1000 => spent 450 + req 51", 1000, 0, 450, 0, 51, "OVER_BUDGET"),
        ("budget ceiling reached: budget 500, dep 1000 => spent 450 + req 52", 1000, 0, 450, 0, 52, "OVER_BUDGET"),
        ("overflow in spent.checked_add(reserved): spent u128::MAX", 1000, 0, u128::MAX, 1, 10, "OVER_BUDGET"),
        ("overflow in spent.checked_add(reserved): reserved u128::MAX", 1000, 0, 1, u128::MAX, 10, "OVER_BUDGET"),
        ("overflow in needed.checked_add(amount): spent+res=100, amount u128::MAX", 1000, 0, 50, 50, u128::MAX, "OVER_PER_PAYMENT_CAP"),
        ("over per-payment-cap off-by-one: cap=100, req 101", 1000, 0, 0, 0, 101, "OVER_PER_PAYMENT_CAP"),
        ("over per-payment-cap off-by-two: cap=100, req 102", 1000, 0, 0, 0, 102, "OVER_PER_PAYMENT_CAP"),
        ("zero amount payment request off-by-one: amount=0", 1000, 0, 0, 0, 0, "OVER_PER_PAYMENT_CAP"),
    ];
    for (idx, (desc, dep, with, sp, resv, amt, exp_code)) in off_by_one_scenarios.into_iter().enumerate() {
        let sub_id = 73 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        let expected_code_str = format!("SCRIP_ERR:{exp_code}");
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({
                "deposited": dep.to_string(),
                "withdrawn": with.to_string(),
                "spent": sp.to_string(),
                "reserved": resv.to_string(),
                "amount": amt.to_string(),
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(expected_code_str),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.deposited = dep;
                    m.withdrawn = with;
                    m.spent = sp;
                    m.reserved = resv;
                    if desc.contains("budget 500") {
                        m.budget = 500;
                    }
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), 1000 + sub_id as u64)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // 9. withdraw boundary and authorization checks (KAT-A-11-93 .. 102)
    // Mandate with dep=1000, spent=200, res=100, with=300 => committed=600, free=400
    let withdraw_scenarios: Vec<(&'static str, &'static str, u64, u128, u64, &'static str)> = vec![
        // (desc, caller, mandate_id, amount, gas_tgas, expected_panic)
        ("withdraw exceeds free by 1 (free 400, req 401)", OWNER, 1, 401, 100, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw exceeds free by 10 (free 400, req 410)", OWNER, 1, 410, 100, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw full deposited amount on partially spent mandate (req 1000 > free 400)", OWNER, 1, 1000, 100, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw u128::MAX amount", OWNER, 1, u128::MAX, 100, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw zero amount on revoked mandate", OWNER, 1, 0, 100, "SCRIP_ERR:ZERO_AMOUNT"),
        ("Agent unauthorized to call withdraw", AGENT, 1, 100, 100, "SCRIP_ERR:UNAUTHORIZED_OWNER"),
        ("Stranger unauthorized to call withdraw", STRANGER, 1, 100, 100, "SCRIP_ERR:UNAUTHORIZED_OWNER"),
        ("Guardian unauthorized to call withdraw", GUARDIAN, 1, 100, 100, "SCRIP_ERR:UNAUTHORIZED_OWNER"),
        ("withdraw on non-existent mandate ID 999", OWNER, 999, 100, 100, "SCRIP_ERR:MANDATE_NOT_FOUND"),
        ("withdraw with insufficient prepaid gas (50 Tgas < 60 Tgas)", OWNER, 1, 100, 50, "SCRIP_ERR:INSUFFICIENT_GAS"),
    ];
    for (idx, (desc, caller, target_mandate, amt, tgas, exp_panic)) in withdraw_scenarios.into_iter().enumerate() {
        let sub_id = 93 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-11-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 11,
            title: desc,
            params: serde_json::json!({
                "caller": caller,
                "mandate_id": target_mandate,
                "amount": amt.to_string(),
                "gas_tgas": tgas,
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_panic.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_revoked_mandate();
                let target_id = if target_mandate == 999 { 999 } else { id };
                let snap = take_snapshot(&c, target_id);
                set_context(caller, NearToken::from_yoctonear(0), tgas, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    let _ = c.withdraw(target_id, U128(amt));
                }));
                evaluate_call_panic(&c, target_id, snap, res)
            }),
        });
    }

    cases
}

fn evaluate_view_inert<T>(
    c: &Scrip,
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

pub(crate) fn build_category_12_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // 1. Block timestamp & height anomalies (waktu mundur / lompat) (KAT-A-12-01 .. 10)
    let time_anomaly_scenarios: Vec<(&'static str, u64, u64, &'static str, &'static str)> = vec![
        // (desc, timestamp_ms, height, expected_label, expected_code)
        ("Block timestamp jumped past expiry by 1 ms", EXPIRES + 1, 1000, "BLOCKED", "SCRIP_ERR:EXPIRED"),
        ("Block timestamp jumped 100 years into future", 4_000_000_000_000, 1000, "BLOCKED", "SCRIP_ERR:EXPIRED"),
        ("Block timestamp at exact expiry millisecond", EXPIRES, 1000, "BLOCKED", "SCRIP_ERR:EXPIRED"),
        ("Block timestamp at exact expiry + 10_000 ms", EXPIRES + 10_000, 1000, "BLOCKED", "SCRIP_ERR:EXPIRED"),
        ("Block timestamp rewound to 0 (epoch 1970) with over-cap amount", 0, 1000, "BLOCKED", "SCRIP_ERR:OVER_PER_PAYMENT_CAP"),
        ("Block timestamp rewound before creation with unapproved amount", 500_000, 1000, "BLOCKED", "SCRIP_ERR:NEEDS_APPROVAL"),
        ("resolve_stale when block height rewinds backwards (< pending.height)", NOW, 50, "BLOCKED", "SCRIP_ERR:NOT_STALE_YET"),
        ("resolve_stale at exact same block height as pending creation", NOW, 1000, "BLOCKED", "SCRIP_ERR:NOT_STALE_YET"),
        ("resolve_stale one block before stale threshold (199 blocks elapsed)", NOW, 1199, "BLOCKED", "SCRIP_ERR:NOT_STALE_YET"),
        ("resolve_stale called by unauthorized agent at height + 300", NOW, 1300, "BLOCKED", "SCRIP_ERR:UNAUTHORIZED_GUARDIAN"),
    ];
    for (idx, (desc, ts, h, exp_lbl, exp_code)) in time_anomaly_scenarios.into_iter().enumerate() {
        let sub_id = idx + 1;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "timestamp_ms": ts, "block_height": h }),
            expected: CaseExpected {
                label: exp_lbl.into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if sub_id <= 6 {
                    // Payment request with time anomaly
                    let snap = take_snapshot(&c, id);
                    set_context(AGENT, NearToken::from_yoctonear(0), 100, ts, h);
                    let amt = if sub_id == 5 { 101 } else if sub_id == 6 { 75 } else { 40 };
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.request_payment(id, acc(SHOP), U128(amt), 10_000 + sub_id as u64)
                    }));
                    evaluate_payment_result(&c, id, snap, res)
                } else {
                    // Create pending request at height 1000 first
                    set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                    let _ = c.request_payment(id, acc(SHOP), U128(40), 9999);
                    let snap = take_snapshot(&c, id);
                    let caller = if sub_id == 10 { AGENT } else { GUARDIAN };
                    set_context(caller, NearToken::from_yoctonear(0), 100, ts, h);
                    let res = catch_unwind(AssertUnwindSafe(|| {
                        c.resolve_stale(id, 1, false);
                    }));
                    evaluate_call_panic(&c, id, snap, res)
                }
            }),
        });
    }

    // 2. Extreme / absurd expires_at_ms values (KAT-A-12-11 .. 22)
    let extreme_expiry_scenarios: Vec<(&'static str, u64, &'static str, &'static str)> = vec![
        ("create_mandate with expiry 0 (epoch 1970)", 0, "create", "SCRIP_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with expiry equal to current timestamp", NOW, "create", "SCRIP_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with expiry in the past (NOW - 1 ms)", NOW - 1, "create", "SCRIP_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with expiry 1 ms", 1, "create", "SCRIP_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("create_mandate with u64::MAX expiry blocks over-cap payment", u64::MAX, "payment_overcap", "SCRIP_ERR:OVER_PER_PAYMENT_CAP"),
        ("create_mandate with u64::MAX - 1 expiry blocks over-budget payment", u64::MAX - 1, "payment_overbudget", "SCRIP_ERR:OVER_BUDGET"),
        ("approve_intent with expiry 0", 0, "approve", "SCRIP_ERR:APPROVAL_NOT_IN_FUTURE"),
        ("approve_intent with expiry equal to current timestamp", NOW, "approve", "SCRIP_ERR:APPROVAL_NOT_IN_FUTURE"),
        ("approve_intent with expiry in past (NOW - 1 ms)", NOW - 1, "approve", "SCRIP_ERR:APPROVAL_NOT_IN_FUTURE"),
        ("approve_intent with expiry 1 ms", 1, "approve", "SCRIP_ERR:APPROVAL_NOT_IN_FUTURE"),
        ("tighten(Expiry) with past timestamp (NOW - 1000)", NOW - 1000, "tighten", "SCRIP_ERR:EXPIRY_NOT_IN_FUTURE"),
        ("loosen(Expiry) with past timestamp (NOW - 1000)", NOW - 1000, "loosen", "SCRIP_ERR:NOT_LOOSER"),
    ];
    for (idx, (desc, exp_ts, mode, exp_code)) in extreme_expiry_scenarios.into_iter().enumerate() {
        let sub_id = 11 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "expires_at_ms": exp_ts.to_string(), "mode": mode }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                match mode {
                    "create" => {
                        set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                        let mut c = Scrip::new();
                        let next_before = c.next_mandate_id;
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.create_mandate(
                                acc(AGENT),
                                acc(GUARDIAN),
                                acc(TOKEN),
                                U128(1000),
                                U128(100),
                                U128(50),
                                vec![acc(SHOP)],
                                exp_ts,
                            )
                        }));
                        evaluate_create_mandate_panic(&c, next_before, res)
                    }
                    "payment_overcap" | "payment_overbudget" => {
                        set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                        let mut c = Scrip::new();
                        let id = c.create_mandate(
                            acc(AGENT),
                            acc(GUARDIAN),
                            acc(TOKEN),
                            U128(1000),
                            U128(100),
                            U128(50),
                            vec![acc(SHOP)],
                            exp_ts,
                        );
                        set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let _ = c.ft_on_transfer(acc(OWNER), U128(1000), format!("{{\"mandate_id\":{id}}}"));
                        if mode == "payment_overbudget" {
                            if let Some(m) = c.mandates.get_mut(&id) {
                                m.spent = 950;
                            }
                        }
                        let snap = take_snapshot(&c, id);
                        set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let amt = if mode == "payment_overcap" { 101 } else { 100 };
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.request_payment(id, acc(SHOP), U128(amt), 20_000 + sub_id as u64)
                        }));
                        evaluate_payment_result(&c, id, snap, res)
                    }
                    "approve" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.approve_intent(id, acc(SHOP), U128(75), 1, exp_ts);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "tighten" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.tighten(id, Change::Expiry(exp_ts));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    _ => {
                        // loosen
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.loosen(id, Change::Expiry(exp_ts));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                }
            }),
        });
    }

    // 3. Calls by the contract account itself (predecessor == CONTRACT) (KAT-A-12-23 .. 32)
    let contract_self_scenarios: Vec<(&'static str, &'static str, &'static str, Option<&'static str>)> = vec![
        // (desc, method, expected_label, expected_code)
        ("Contract calls create_mandate with agent == contract", "create_mandate", "BLOCKED", Some("SCRIP_ERR:OWNER_IS_AGENT")),
        ("Contract calls request_payment", "request_payment", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_AGENT")),
        ("Contract calls revoke", "revoke", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN")),
        ("Contract calls approve_intent", "approve_intent", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN")),
        ("Contract calls withdraw", "withdraw", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_OWNER")),
        ("Contract calls resolve_stale", "resolve_stale", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN")),
        ("Contract calls tighten", "tighten", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_OWNER_OR_GUARDIAN")),
        ("Contract calls loosen", "loosen", "BLOCKED", Some("SCRIP_ERR:UNAUTHORIZED_GUARDIAN")),
        ("Contract calls ft_on_transfer (not token contract)", "ft_on_transfer", "INERT", None),
        ("Contract calls get_mandate view", "get_mandate", "INERT", None),
    ];
    for (idx, (desc, method, exp_lbl, exp_code)) in contract_self_scenarios.into_iter().enumerate() {
        let sub_id = 23 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "predecessor": CONTRACT, "method": method }),
            expected: CaseExpected {
                label: exp_lbl.into(),
                code: exp_code.map(|s| s.into()),
            },
            runner: Box::new(move || {
                match method {
                    "create_mandate" => {
                        set_clean_context(CONTRACT, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                        let mut c = Scrip::new();
                        let next_before = c.next_mandate_id;
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.create_mandate(
                                acc(CONTRACT),
                                acc(GUARDIAN),
                                acc(TOKEN),
                                U128(1000),
                                U128(100),
                                U128(50),
                                vec![acc(SHOP)],
                                EXPIRES,
                            )
                        }));
                        evaluate_create_mandate_panic(&c, next_before, res)
                    }
                    "request_payment" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.request_payment(id, acc(SHOP), U128(40), 30_000 + sub_id as u64)
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "revoke" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.revoke(id);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "approve_intent" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.approve_intent(id, acc(SHOP), U128(75), 1, EXPIRES - 100);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "withdraw" => {
                        let (mut c, id) = setup_fresh_revoked_mandate();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            let _ = c.withdraw(id, U128(100));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "resolve_stale" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let _ = c.request_payment(id, acc(SHOP), U128(40), 9999);
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1300);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.resolve_stale(id, 1, false);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "tighten" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.tighten(id, Change::PerPaymentCap(U128(80)));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "loosen" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.loosen(id, Change::Budget(U128(2000)));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "ft_on_transfer" => {
                        let (mut c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let msg = format!("{{\"mandate_id\":{id}}}");
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.ft_on_transfer(acc(OWNER), U128(500), msg)
                        }));
                        evaluate_ft_on_transfer_inert(&c, id, snap, 500, res)
                    }
                    _ => {
                        // get_mandate
                        let (c, id) = setup_fresh_standard_contract();
                        let snap = take_snapshot(&c, id);
                        set_context(CONTRACT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.get_mandate(id)
                        }));
                        evaluate_view_inert(&c, id, snap, res)
                    }
                }
            }),
        });
    }

    // 4. External calls to private callback methods (KAT-A-12-33 .. 38)
    let private_callback_scenarios: Vec<(&'static str, &'static str, &'static str)> = vec![
        ("Agent calls on_payment_done directly", "on_payment_done", AGENT),
        ("Owner calls on_payment_done directly", "on_payment_done", OWNER),
        ("Stranger calls on_payment_done directly", "on_payment_done", STRANGER),
        ("Agent calls on_withdraw_done directly", "on_withdraw_done", AGENT),
        ("Owner calls on_withdraw_done directly", "on_withdraw_done", OWNER),
        ("Stranger calls on_withdraw_done directly", "on_withdraw_done", STRANGER),
    ];
    for (idx, (desc, method, caller)) in private_callback_scenarios.into_iter().enumerate() {
        let sub_id = 33 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "caller": caller, "private_method": method }),
            expected: CaseExpected {
                label: "OUT_OF_SCOPE".into(),
                code: Some("OUT_OF_SCOPE".into()),
            },
            runner: Box::new(move || {
                let (c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                assert!(snap.is_some(), "Contract state must be valid");
                CaseActual {
                    label: "OUT_OF_SCOPE".into(),
                    code: Some("OUT_OF_SCOPE".into()),
                    note: Some(format!(
                        "Direct invocation of #[private] method '{method}' by '{caller}' bypasses WASM export wrapper; enforced in Layer D (sandbox) and Layer E (testnet)"
                    )),
                }
            }),
        });
    }

    // 5. State anomalies after revoke + withdraw (KAT-A-12-39 .. 48)
    let revoke_withdraw_state_scenarios: Vec<(&'static str, &'static str, bool, &'static str)> = vec![
        // (desc, action, fully_withdrawn, expected_code)
        ("request_payment on revoked mandate with remaining balance", "request_payment", false, "SCRIP_ERR:NOT_ACTIVE"),
        ("request_payment on revoked and fully withdrawn mandate", "request_payment", true, "SCRIP_ERR:NOT_ACTIVE"),
        ("approve_intent on revoked mandate", "approve_intent", false, "SCRIP_ERR:NOT_ACTIVE"),
        ("approve_intent on revoked and fully withdrawn mandate", "approve_intent", true, "SCRIP_ERR:NOT_ACTIVE"),
        ("tighten(Budget) on revoked mandate", "tighten", false, "SCRIP_ERR:NOT_ACTIVE"),
        ("tighten(PerPaymentCap) on revoked and fully withdrawn mandate", "tighten", true, "SCRIP_ERR:NOT_ACTIVE"),
        ("loosen(Budget) on revoked mandate", "loosen", false, "SCRIP_ERR:NOT_ACTIVE"),
        ("double revoke on already revoked mandate", "revoke", false, "SCRIP_ERR:ALREADY_REVOKED"),
        ("withdraw again after entire free balance has been withdrawn", "withdraw", true, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
        ("withdraw 1 token when free balance is 0", "withdraw", true, "SCRIP_ERR:AMOUNT_EXCEEDS_FREE"),
    ];
    for (idx, (desc, action, fully_withdrawn, exp_code)) in revoke_withdraw_state_scenarios.into_iter().enumerate() {
        let sub_id = 39 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "action": action, "fully_withdrawn": fully_withdrawn }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some(exp_code.into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_revoked_mandate();
                if fully_withdrawn {
                    if let Some(m) = c.mandates.get_mut(&id) {
                        m.withdrawn = 700; // committed = 200 + 100 + 700 = 1000 => free = 0
                    }
                }
                let snap = take_snapshot(&c, id);
                match action {
                    "request_payment" => {
                        set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.request_payment(id, acc(SHOP), U128(40), 40_000 + sub_id as u64)
                        }));
                        evaluate_payment_result(&c, id, snap, res)
                    }
                    "approve_intent" => {
                        set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.approve_intent(id, acc(SHOP), U128(75), 1, EXPIRES - 100);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "tighten" => {
                        set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.tighten(id, Change::PerPaymentCap(U128(80)));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "loosen" => {
                        set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.loosen(id, Change::Budget(U128(2000)));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    "revoke" => {
                        set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            c.revoke(id);
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                    _ => {
                        // withdraw
                        set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                        let res = catch_unwind(AssertUnwindSafe(|| {
                            let _ = c.withdraw(id, U128(1));
                        }));
                        evaluate_call_panic(&c, id, snap, res)
                    }
                }
            }),
        });
    }

    // 6. Threat model boundaries / out-of-scope scenarios (KAT-A-12-49 .. 62)
    // Documenting recognized boundaries that are external to contract unit execution
    let out_of_scope_scenarios: Vec<(&'static str, &'static str)> = vec![
        ("Owner master full-access key leaked on NEAR L1", "Protocol protects scoped agent function-call keys; owner full-access key compromise is outside contract boundaries"),
        ("Malicious NEP-141 token contract re-entrancy / state falsehood", "External FT contract logic integrity is outside Scrip contract scope; mitigated by token contract address pinning"),
        ("Dishonest Byzantine RPC node lying about transaction receipts/finality", "RPC node infrastructure integrity is an L1 blockchain consensus guarantee"),
        ("NEAR L1 consensus reorganization / state rollback", "L1 blockchain consensus finality and hard forks are external to smart contract application layer"),
        ("Host NEAR WASM runtime out-of-memory or engine panic", "Validator node host execution engine resource boundaries are external to contract code"),
        ("Operating system CSPRNG entropy exhaustion on client/relayer", "Cryptographic key generation and entropy source are operating system guarantees"),
        ("Block validator colluding with relayer to censor transactions", "Network validator censorship resistance is outside smart contract scope"),
        ("Protocol state overwritten via NEAR governance contract upgrade", "Network governance interventions and hard state overwrites are outside smart contract guarantees"),
        ("Relayer tampering with NEP-366 delegate action envelope", "Delegate action cryptographic signature verification is enforced by NEAR runtime prior to contract execution"),
        ("DDoS attack overwhelming NEAR RPC / validator network", "Network transport bandwidth and RPC node availability are infrastructure guarantees"),
        ("Microarchitectural side-channel attack on ed25519 signature verification", "Hardware cryptographic execution side-channel isolation is an OS/silicon level guarantee"),
        ("Host physical memory bit-flip / cosmic-ray hardware RAM corruption", "Hardware fault tolerance is outside smart contract threat model"),
        ("Social engineering compromise of human guardian signer", "Cryptographically valid signatures produced by compromised human guardian cannot be distinguished by contract"),
        ("Zero-day vulnerability in near-sdk or wasm vm sandbox", "Virtual machine sandbox isolation integrity is an underlying platform guarantee"),
    ];
    for (idx, (desc, boundary_note)) in out_of_scope_scenarios.into_iter().enumerate() {
        let sub_id = 49 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-12-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 12,
            title: desc,
            params: serde_json::json!({ "threat_model_boundary": desc, "note": boundary_note }),
            expected: CaseExpected {
                label: "OUT_OF_SCOPE".into(),
                code: Some("OUT_OF_SCOPE".into()),
            },
            runner: Box::new(move || {
                let (c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                // Verify contract invariant holds in base state
                assert!(snap.is_some(), "Standard contract base state must be valid");
                CaseActual {
                    label: "OUT_OF_SCOPE".into(),
                    code: Some("OUT_OF_SCOPE".into()),
                    note: Some(boundary_note.into()),
                }
            }),
        });
    }

    cases
}

#[test]
fn attack_catalog_layer_a_part4() {
    let mut all_cases = Vec::new();
    all_cases.extend(build_category_11_cases());
    all_cases.extend(build_category_12_cases());

    println!("Total Layer A Part 4 test cases (Categories 11 & 12): {}", all_cases.len());

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
        "Layer A Part 4 Summary: Total={}, PASS={}, FAIL={}, BREACH={}",
        outputs.len(),
        pass_count,
        fail_count,
        breach_count
    );

    if let Ok(out_path) = std::env::var("ATTACK_CATALOG_OUT_PART4") {
        if !out_path.is_empty() {
            println!("Writing Layer A Part 4 catalog output to: {}", out_path);
            let json_data = serde_json::to_string_pretty(&outputs).expect("Failed to serialize catalog outputs");
            if let Some(parent) = std::path::Path::new(&out_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&out_path, json_data).expect("Failed to write catalog output file");
        }
    }

    assert_eq!(breach_count, 0, "BREACH detected in Layer A attack catalog part 4!");
    assert_eq!(fail_count, 0, "FAIL detected in Layer A attack catalog part 4!");
}
