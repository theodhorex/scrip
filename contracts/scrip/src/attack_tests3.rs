//! Attack catalog unit tests for Layer A (contract unit level), Part 3.
//! Implements parametric attack vectors for:
//! - Category 1 (Recipients & Whitelist Enforcement)
//! - Category 3 (Budget, Limits & Parallel Requests Accounting)

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
        U128(1000),
        U128(100),
        U128(50),
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

fn setup_mandate_with_16_recipients() -> (Scrip, u64) {
    set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
    let mut c = Scrip::new();
    let recs: Vec<AccountId> = (1..=16).map(|i| acc(&format!("r{:02}.testnet", i))).collect();
    let id = c.create_mandate(
        acc(AGENT),
        acc(GUARDIAN),
        acc(TOKEN),
        U128(10_000),
        U128(100),
        U128(50),
        recs,
        EXPIRES,
    );
    set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
    let msg = format!("{{\"mandate_id\":{id}}}");
    let _ = c.ft_on_transfer(acc(OWNER), U128(10_000), msg);
    (c, id)
}

pub(crate) fn build_category_1_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // =========================================================================
    // Subgroup 1A: create_mandate recipient structural violations (KAT-A-01-01 .. 15)
    // =========================================================================

    // KAT-A-01-01: Empty recipient list
    cases.push(TestCaseDef {
        id: "KAT-A-01-01",
        category: 1,
        title: "create_mandate with empty recipient list",
        params: serde_json::json!({ "recipients_count": 0 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:EMPTY_RECIPIENTS".into()),
        },
        runner: Box::new(|| {
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
                    vec![],
                    EXPIRES,
                )
            }));
            evaluate_create_mandate_panic(&c, next_before, res)
        }),
    });

    // Duplicate recipient scenarios (KAT-A-01-02 .. 04, 10 .. 12)
    let duplicate_scenarios: Vec<(&'static str, Vec<&'static str>)> = vec![
        ("Duplicate recipient in 2-element list", vec![SHOP, SHOP]),
        ("Duplicate recipient at first and last position", vec![SHOP, CAFE, SHOP]),
        ("Duplicate recipient at adjacent trailing positions", vec![SHOP, CAFE, CAFE]),
    ];
    for (idx, (desc, recs)) in duplicate_scenarios.into_iter().enumerate() {
        let sub_id = 2 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        let accounts: Vec<AccountId> = recs.iter().map(|s| acc(s)).collect();
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "recipients": recs }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
            },
            runner: Box::new(move || {
                set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let next_before = c.next_mandate_id;
                let r_clone = accounts.clone();
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(
                        acc(AGENT),
                        acc(GUARDIAN),
                        acc(TOKEN),
                        U128(1000),
                        U128(100),
                        U128(50),
                        r_clone,
                        EXPIRES,
                    )
                }));
                evaluate_create_mandate_panic(&c, next_before, res)
            }),
        });
    }

    // Too many recipients scenarios (KAT-A-01-05 .. 09, 13 .. 15)
    let too_many_counts: Vec<(usize, &'static str)> = vec![
        (17, "17 recipients (1 over MAX_RECIPIENTS)"),
        (18, "18 recipients (2 over MAX_RECIPIENTS)"),
        (20, "20 recipients"),
        (32, "32 recipients (2x MAX_RECIPIENTS)"),
        (64, "64 recipients"),
    ];
    for (idx, (count, desc)) in too_many_counts.into_iter().enumerate() {
        let sub_id = 5 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "count": count }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:TOO_MANY_RECIPIENTS".into()),
            },
            runner: Box::new(move || {
                set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let next_before = c.next_mandate_id;
                let recs: Vec<AccountId> = (0..count).map(|i| acc(&format!("r{:02}.testnet", i))).collect();
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(
                        acc(AGENT),
                        acc(GUARDIAN),
                        acc(TOKEN),
                        U128(1000),
                        U128(100),
                        U128(50),
                        recs,
                        EXPIRES,
                    )
                }));
                evaluate_create_mandate_panic(&c, next_before, res)
            }),
        });
    }

    // Duplicate among 16 recipients (KAT-A-01-10 .. 12)
    let dup_in_16_scenarios: Vec<(&'static str, usize, usize)> = vec![
        ("Duplicate at index 0 and 15 in 16 recipients", 0, 15),
        ("Duplicate at index 5 and 10 in 16 recipients", 5, 10),
        ("Duplicate at index 14 and 15 in 16 recipients", 14, 15),
    ];
    for (idx, (desc, i1, i2)) in dup_in_16_scenarios.into_iter().enumerate() {
        let sub_id = 10 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "index1": i1, "index2": i2 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
            },
            runner: Box::new(move || {
                set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let next_before = c.next_mandate_id;
                let mut recs: Vec<AccountId> = (0..16).map(|i| acc(&format!("r{:02}.testnet", i))).collect();
                recs[i2] = recs[i1].clone();
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(
                        acc(AGENT),
                        acc(GUARDIAN),
                        acc(TOKEN),
                        U128(1000),
                        U128(100),
                        U128(50),
                        recs,
                        EXPIRES,
                    )
                }));
                evaluate_create_mandate_panic(&c, next_before, res)
            }),
        });
    }

    // Length check precedes duplicate check when >16 (KAT-A-01-13 .. 15)
    let count_with_dups: Vec<(usize, &'static str)> = vec![
        (17, "17 recipients with duplicates (length check fires first)"),
        (19, "19 recipients with all identical entries"),
        (25, "25 recipients with duplicate pairs"),
    ];
    for (idx, (count, desc)) in count_with_dups.into_iter().enumerate() {
        let sub_id = 13 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "count": count }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:TOO_MANY_RECIPIENTS".into()),
            },
            runner: Box::new(move || {
                set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
                let mut c = Scrip::new();
                let next_before = c.next_mandate_id;
                let recs: Vec<AccountId> = vec![acc(SHOP); count];
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.create_mandate(
                        acc(AGENT),
                        acc(GUARDIAN),
                        acc(TOKEN),
                        U128(1000),
                        U128(100),
                        U128(50),
                        recs,
                        EXPIRES,
                    )
                }));
                evaluate_create_mandate_panic(&c, next_before, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 1B: tighten recipient mutations (KAT-A-01-16 .. 30)
    // =========================================================================

    // AddRecipient via tighten is disallowed (NOT_STRICTER) (KAT-A-01-16 .. 19)
    let tighten_add_scenarios: Vec<(&'static str, &'static str, &'static str)> = vec![
        ("Owner calls tighten with AddRecipient(shop)", OWNER, SHOP),
        ("Guardian calls tighten with AddRecipient(shop)", GUARDIAN, SHOP),
        ("Owner calls tighten with AddRecipient(stranger)", OWNER, STRANGER),
        ("Guardian calls tighten with AddRecipient(stranger)", GUARDIAN, STRANGER),
    ];
    for (idx, (desc, caller, rec)) in tighten_add_scenarios.into_iter().enumerate() {
        let sub_id = 16 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "caller": caller, "recipient": rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_STRICTER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::AddRecipient(acc(rec)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Remove unlisted recipient via tighten (NO_SUCH_RECIPIENT) (KAT-A-01-20 .. 25)
    let tighten_no_such_scenarios: Vec<(&'static str, &'static str, &'static str)> = vec![
        ("Owner tightens RemoveRecipient with unknown1", OWNER, "unknown1.testnet"),
        ("Guardian tightens RemoveRecipient with unknown2", GUARDIAN, "unknown2.testnet"),
        ("Owner tightens RemoveRecipient with agent", OWNER, AGENT),
        ("Guardian tightens RemoveRecipient with owner", GUARDIAN, OWNER),
        ("Owner tightens RemoveRecipient with guardian", OWNER, GUARDIAN),
        ("Owner tightens RemoveRecipient with token", OWNER, TOKEN),
    ];
    for (idx, (desc, caller, rec)) in tighten_no_such_scenarios.into_iter().enumerate() {
        let sub_id = 20 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "caller": caller, "recipient": rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NO_SUCH_RECIPIENT".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(caller, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::RemoveRecipient(acc(rec)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Double remove / empty list remove / non-existent mandate (KAT-A-01-26 .. 30)
    cases.push(TestCaseDef {
        id: "KAT-A-01-26",
        category: 1,
        title: "Owner removes shop twice via tighten",
        params: serde_json::json!({ "recipient": SHOP }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NO_SUCH_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-27",
        category: 1,
        title: "Guardian removes cafe twice via tighten",
        params: serde_json::json!({ "recipient": CAFE }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NO_SUCH_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-28",
        category: 1,
        title: "Remove both recipients then remove again from empty list",
        params: serde_json::json!({ "removed": [SHOP, CAFE] }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NO_SUCH_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-29",
        category: 1,
        title: "Remove recipient from 16-element mandate twice",
        params: serde_json::json!({ "recipient": "r01.testnet" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NO_SUCH_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_mandate_with_16_recipients();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc("r01.testnet")));
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(id, Change::RemoveRecipient(acc("r01.testnet")));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-30",
        category: 1,
        title: "Remove recipient from unknown mandate 999",
        params: serde_json::json!({ "mandate_id": 999 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:MANDATE_NOT_FOUND".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.tighten(999, Change::RemoveRecipient(acc(SHOP)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // =========================================================================
    // Subgroup 1C: loosen recipient mutations (KAT-A-01-31 .. 45)
    // =========================================================================

    // RemoveRecipient via loosen is disallowed (NOT_LOOSER) (KAT-A-01-31 .. 33)
    let loosen_remove_scenarios: Vec<(&'static str, &'static str)> = vec![
        ("Guardian loosens RemoveRecipient with shop", SHOP),
        ("Guardian loosens RemoveRecipient with cafe", CAFE),
        ("Guardian loosens RemoveRecipient with stranger", STRANGER),
    ];
    for (idx, (desc, rec)) in loosen_remove_scenarios.into_iter().enumerate() {
        let sub_id = 31 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "recipient": rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_LOOSER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::RemoveRecipient(acc(rec)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Duplicate recipient via loosen AddRecipient (KAT-A-01-34, 35)
    let loosen_dup_scenarios: Vec<(&'static str, &'static str)> = vec![
        ("Loosen AddRecipient with duplicate shop", SHOP),
        ("Loosen AddRecipient with duplicate cafe", CAFE),
    ];
    for (idx, (desc, rec)) in loosen_dup_scenarios.into_iter().enumerate() {
        let sub_id = 34 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "recipient": rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::AddRecipient(acc(rec)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Exceeding 16 recipients via loosen AddRecipient (KAT-A-01-36 .. 39)
    let loosen_too_many: Vec<(&'static str, &'static str)> = vec![
        ("Add 17th recipient to 16-recipient mandate", "r17.testnet"),
        ("Add 18th recipient to 16-recipient mandate", "r18.testnet"),
        ("Add 19th recipient to 16-recipient mandate", "r19.testnet"),
        ("Add 20th recipient to 16-recipient mandate", "r20.testnet"),
    ];
    for (idx, (desc, rec)) in loosen_too_many.into_iter().enumerate() {
        let sub_id = 36 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "new_recipient": rec }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:TOO_MANY_RECIPIENTS".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_mandate_with_16_recipients();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::AddRecipient(acc(rec)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Loosen recipient on invalid mandate state (KAT-A-01-40 .. 42)
    cases.push(TestCaseDef {
        id: "KAT-A-01-40",
        category: 1,
        title: "Loosen AddRecipient on unknown mandate 888",
        params: serde_json::json!({ "mandate_id": 888 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:MANDATE_NOT_FOUND".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(888, Change::AddRecipient(acc(STRANGER)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-41",
        category: 1,
        title: "Loosen AddRecipient on revoked mandate",
        params: serde_json::json!({ "status": "Revoked" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_revoked_mandate();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::AddRecipient(acc(STRANGER)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-42",
        category: 1,
        title: "Loosen RemoveRecipient on revoked mandate",
        params: serde_json::json!({ "status": "Revoked" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:NOT_ACTIVE".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_revoked_mandate();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::RemoveRecipient(acc(SHOP)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-43",
        category: 1,
        title: "Add recipient via loosen then add it again (double add)",
        params: serde_json::json!({ "recipient": STRANGER }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.loosen(id, Change::AddRecipient(acc(STRANGER)));
            let snap = take_snapshot(&c, id);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::AddRecipient(acc(STRANGER)));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-44",
        category: 1,
        title: "Duplicate check fires before length check in loosen (r01 in 16-list)",
        params: serde_json::json!({ "recipient": "r01.testnet" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_mandate_with_16_recipients();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::AddRecipient(acc("r01.testnet")));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-45",
        category: 1,
        title: "Duplicate check fires before length check in loosen (r16 in 16-list)",
        params: serde_json::json!({ "recipient": "r16.testnet" }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:DUPLICATE_RECIPIENT".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_mandate_with_16_recipients();
            let snap = take_snapshot(&c, id);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.loosen(id, Change::AddRecipient(acc("r16.testnet")));
            }));
            evaluate_call_panic(&c, id, snap, res)
        }),
    });

    // =========================================================================
    // Subgroup 1D: request_payment unlisted recipient attacks (KAT-A-01-46 .. 65)
    // =========================================================================

    let unlisted_recipients: Vec<(&'static str, &'static str)> = vec![
        ("Payment to stranger bob.testnet", STRANGER),
        ("Payment to charlie.testnet", "charlie.testnet"),
        ("Payment to mallory.testnet", "mallory.testnet"),
        ("Payment to evil.testnet", "evil.testnet"),
        ("Payment to agent itself", AGENT),
        ("Payment to contract itself", CONTRACT),
        ("Payment to mandate owner alice.testnet", OWNER),
        ("Payment to mandate guardian", GUARDIAN),
        ("Payment to token contract usdc.testnet", TOKEN),
        ("Payment to subaccount shop.alice.testnet", "shop.alice.testnet"),
        ("Payment to subaccount sub.shop.testnet", "sub.shop.testnet"),
        ("Payment to shop.cafe.testnet", "shop.cafe.testnet"),
        ("Payment to cafe.shop.testnet", "cafe.shop.testnet"),
        (
            "Payment to 64-hex implicit account",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
        ("Payment to relayer.testnet", RELAYER),
    ];
    for (idx, (desc, rec)) in unlisted_recipients.into_iter().enumerate() {
        let sub_id = 46 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "recipient": rec, "amount": 25 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(rec), U128(25), 1)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // Payment after recipient removal via tighten (KAT-A-01-61 .. 65)
    cases.push(TestCaseDef {
        id: "KAT-A-01-61",
        category: 1,
        title: "Payment to shop after shop was removed via tighten",
        params: serde_json::json!({ "removed": SHOP }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-62",
        category: 1,
        title: "Payment to cafe after cafe was removed via tighten",
        params: serde_json::json!({ "removed": CAFE }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(CAFE), U128(25), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-63",
        category: 1,
        title: "Payment to shop after both shop and cafe were removed",
        params: serde_json::json!({ "removed": [SHOP, CAFE] }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(25), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-64",
        category: 1,
        title: "Payment to cafe after both shop and cafe were removed",
        params: serde_json::json!({ "removed": [SHOP, CAFE] }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(CAFE), U128(25), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-65",
        category: 1,
        title: "Payment to stranger after both shop and cafe were removed",
        params: serde_json::json!({ "removed": [SHOP, CAFE], "recipient": STRANGER }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(STRANGER), U128(25), 1)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // =========================================================================
    // Subgroup 1E: Recipient bypass attempts via approve_intent (KAT-A-01-66 .. 75)
    // =========================================================================

    let bypass_approved_unlisted: Vec<(&'static str, &'static str)> = vec![
        ("Approved intent for stranger bob cannot bypass whitelist", STRANGER),
        ("Approved intent for agent cannot bypass whitelist", AGENT),
        ("Approved intent for evil cannot bypass whitelist", "evil.testnet"),
        ("Approved intent for alice cannot bypass whitelist", OWNER),
        ("Approved intent for guardian cannot bypass whitelist", GUARDIAN),
        ("Approved intent for sub.shop cannot bypass whitelist", "sub.shop.testnet"),
    ];
    for (idx, (desc, rec)) in bypass_approved_unlisted.into_iter().enumerate() {
        let sub_id = 66 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-01-{:02}", sub_id).into_boxed_str());
        let nonce = (1000 + sub_id) as u64;
        cases.push(TestCaseDef {
            id: id_str,
            category: 1,
            title: desc,
            params: serde_json::json!({ "recipient": rec, "amount": 75, "nonce": nonce }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
                c.approve_intent(id, acc(rec), U128(75), nonce, NOW + 10_000);
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(rec), U128(75), nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // Approved intent then recipient removed via tighten (KAT-A-01-72 .. 73)
    cases.push(TestCaseDef {
        id: "KAT-A-01-72",
        category: 1,
        title: "Approved intent for shop, but shop removed before payment",
        params: serde_json::json!({ "recipient": SHOP, "removed": true }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(SHOP), U128(75), 1072, NOW + 10_000);
            set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(SHOP)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(75), 1072)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-73",
        category: 1,
        title: "Approved intent for cafe, but cafe removed before payment",
        params: serde_json::json!({ "recipient": CAFE, "removed": true }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            set_context(GUARDIAN, STORAGE_DEPOSIT_PER_APPROVAL, 100, NOW, 1000);
            c.approve_intent(id, acc(CAFE), U128(75), 1073, NOW + 10_000);
            set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            c.tighten(id, Change::RemoveRecipient(acc(CAFE)));
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(CAFE), U128(75), 1073)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    // Cross-mandate recipient confusion (KAT-A-01-74, 75)
    cases.push(TestCaseDef {
        id: "KAT-A-01-74",
        category: 1,
        title: "Pay shop on mandate 2 where only cafe is allowed",
        params: serde_json::json!({ "mandate_id": 2, "recipient": SHOP }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let _id1 = c.create_mandate(
                acc(AGENT),
                acc(GUARDIAN),
                acc(TOKEN),
                U128(1000),
                U128(100),
                U128(50),
                vec![acc(SHOP)],
                EXPIRES,
            );
            let id2 = c.create_mandate(
                acc(AGENT),
                acc(GUARDIAN),
                acc(TOKEN),
                U128(1000),
                U128(100),
                U128(50),
                vec![acc(CAFE)],
                EXPIRES,
            );
            set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.ft_on_transfer(acc(OWNER), U128(1000), format!("{{\"mandate_id\":{id2}}}"));
            let snap = take_snapshot(&c, id2);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id2, acc(SHOP), U128(25), 1074)
            }));
            evaluate_payment_result(&c, id2, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-01-75",
        category: 1,
        title: "Pay cafe on mandate 1 where only shop is allowed",
        params: serde_json::json!({ "mandate_id": 1, "recipient": CAFE }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:RECIPIENT_NOT_ALLOWED".into()),
        },
        runner: Box::new(|| {
            set_clean_context(OWNER, STORAGE_DEPOSIT_PER_MANDATE, 100, NOW, 1000);
            let mut c = Scrip::new();
            let id1 = c.create_mandate(
                acc(AGENT),
                acc(GUARDIAN),
                acc(TOKEN),
                U128(1000),
                U128(100),
                U128(50),
                vec![acc(SHOP)],
                EXPIRES,
            );
            let _id2 = c.create_mandate(
                acc(AGENT),
                acc(GUARDIAN),
                acc(TOKEN),
                U128(1000),
                U128(100),
                U128(50),
                vec![acc(CAFE)],
                EXPIRES,
            );
            set_context(TOKEN, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let _ = c.ft_on_transfer(acc(OWNER), U128(1000), format!("{{\"mandate_id\":{id1}}}"));
            let snap = take_snapshot(&c, id1);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id1, acc(CAFE), U128(25), 1075)
            }));
            evaluate_payment_result(&c, id1, snap, res)
        }),
    });

    cases
}

pub(crate) fn build_category_3_cases() -> Vec<TestCaseDef> {
    let mut cases = Vec::new();

    // =========================================================================
    // Subgroup 3A: Effective budget ceiling under-deposit boundaries (KAT-A-03-01 .. 15)
    // =========================================================================

    let under_deposit_amounts: Vec<(u128, &'static str)> = vec![
        (51, "Request 51 when ceiling remaining is 50"),
        (52, "Request 52 when ceiling remaining is 50"),
        (55, "Request 55 when ceiling remaining is 50"),
        (60, "Request 60 when ceiling remaining is 50"),
        (70, "Request 70 when ceiling remaining is 50"),
        (80, "Request 80 when ceiling remaining is 50"),
        (90, "Request 90 when ceiling remaining is 50"),
        (100, "Request 100 (cap) when ceiling remaining is 50"),
    ];
    for (idx, (amt, desc)) in under_deposit_amounts.into_iter().enumerate() {
        let sub_id = 1 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        let nonce = 2000 + sub_id as u64;
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({
                "budget": 1000,
                "deposited": 400,
                "spent": 300,
                "reserved": 50,
                "amount": amt,
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.deposited = 400;
                    m.spent = 300;
                    m.reserved = 50;
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // Exhausting remaining deposit = 100 then small requests (KAT-A-03-09 .. 15)
    let post_exhaust_amounts: Vec<(u128, &'static str)> = vec![
        (1, "Post-exhaustion request 1 token"),
        (2, "Post-exhaustion request 2 tokens"),
        (5, "Post-exhaustion request 5 tokens"),
        (10, "Post-exhaustion request 10 tokens"),
        (25, "Post-exhaustion request 25 tokens"),
        (50, "Post-exhaustion request 50 tokens"),
        (100, "Post-exhaustion request 100 tokens"),
    ];
    for (idx, (amt, desc)) in post_exhaust_amounts.into_iter().enumerate() {
        let sub_id = 9 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        let nonce = 2100 + sub_id as u64;
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "ceiling": 100, "committed": 100, "amount": amt }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.deposited = 100;
                    m.budget = 100;
                    // exhaust directly: a real request of 100 stops at NEEDS_APPROVAL and would leave the budget untouched
                    m.spent = 100;
                }
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let snap = take_snapshot(&c, id);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 3B: Effective ceiling with withdrawn tokens (KAT-A-03-16 .. 25)
    // =========================================================================

    let withdrawn_ceiling_amounts: Vec<(u128, &'static str)> = vec![
        (1, "Withdrawn ceiling: request 1 token beyond free"),
        (2, "Withdrawn ceiling: request 2 tokens beyond free"),
        (5, "Withdrawn ceiling: request 5 tokens beyond free"),
        (10, "Withdrawn ceiling: request 10 tokens beyond free"),
        (20, "Withdrawn ceiling: request 20 tokens beyond free"),
        (30, "Withdrawn ceiling: request 30 tokens beyond free"),
        (40, "Withdrawn ceiling: request 40 tokens beyond free"),
        (50, "Withdrawn ceiling: request 50 tokens beyond free"),
        (75, "Withdrawn ceiling: request 75 tokens beyond free"),
        (100, "Withdrawn ceiling: request 100 tokens beyond free"),
    ];
    for (idx, (amt, desc)) in withdrawn_ceiling_amounts.into_iter().enumerate() {
        let sub_id = 16 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        let nonce = 2200 + sub_id as u64;
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({
                "deposited": 1000,
                "withdrawn": 500,
                "spent": 400,
                "reserved": 100,
                "amount": amt,
            }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:OVER_BUDGET".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.deposited = 1000;
                    m.budget = 1000;
                    m.withdrawn = 500;
                    m.spent = 400;
                    m.reserved = 100;
                }
                let snap = take_snapshot(&c, id);
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 3C: MAX_OPEN boundary attacks (KAT-A-03-26 .. 40)
    // =========================================================================

    let max_open_amounts: Vec<(u128, &'static str)> = vec![
        (1, "33rd request with amount 1 when MAX_OPEN=32 reached"),
        (2, "33rd request with amount 2 when MAX_OPEN=32 reached"),
        (5, "33rd request with amount 5 when MAX_OPEN=32 reached"),
        (10, "33rd request with amount 10 when MAX_OPEN=32 reached"),
        (15, "33rd request with amount 15 when MAX_OPEN=32 reached"),
        (20, "33rd request with amount 20 when MAX_OPEN=32 reached"),
        (25, "33rd request with amount 25 when MAX_OPEN=32 reached"),
        (30, "33rd request with amount 30 when MAX_OPEN=32 reached"),
        (40, "33rd request with amount 40 when MAX_OPEN=32 reached"),
        (50, "33rd request with amount 50 when MAX_OPEN=32 reached"),
        (60, "33rd request with amount 60 when MAX_OPEN=32 reached"),
        (75, "33rd request with amount 75 when MAX_OPEN=32 reached"),
        (80, "33rd request with amount 80 when MAX_OPEN=32 reached"),
        (90, "33rd request with amount 90 when MAX_OPEN=32 reached"),
        (100, "33rd request with amount 100 (cap) when MAX_OPEN=32 reached"),
    ];
    for (idx, (amt, desc)) in max_open_amounts.into_iter().enumerate() {
        let sub_id = 26 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        let nonce = 2300 + sub_id as u64;
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "open_requests": 32, "amount": amt }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:TOO_MANY_OPEN".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.budget = 10_000;
                    m.deposited = 10_000;
                    m.open_requests = 32;
                }
                set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let snap = take_snapshot(&c, id);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.request_payment(id, acc(SHOP), U128(amt), nonce)
                }));
                evaluate_payment_result(&c, id, snap, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 3D: tighten budget & limits hierarchy violations (KAT-A-03-41 .. 55)
    // =========================================================================

    // Budget NOT_STRICTER (KAT-A-03-41 .. 43)
    let tighten_not_stricter: Vec<(&'static str, u128)> = vec![
        ("Tighten budget equal to current budget 1000", 1000),
        ("Tighten budget higher than current budget (1001)", 1001),
        ("Tighten budget much higher (2000)", 2000),
    ];
    for (idx, (desc, val)) in tighten_not_stricter.into_iter().enumerate() {
        let sub_id = 41 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_budget": val }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_STRICTER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::Budget(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Budget below committed (KAT-A-03-44 .. 48)
    let tighten_below_committed: Vec<(&'static str, u128)> = vec![
        ("Tighten budget to 299 when committed=300", 299),
        ("Tighten budget to 250 when committed=300", 250),
        ("Tighten budget to 200 (equal to spent only, ignores reserved)", 200),
        ("Tighten budget to 100 when committed=300", 100),
        ("Tighten budget to 0 when committed=300", 0),
    ];
    for (idx, (desc, val)) in tighten_below_committed.into_iter().enumerate() {
        let sub_id = 44 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_budget": val, "committed": 300 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:BUDGET_BELOW_COMMITTED".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                if let Some(m) = c.mandates.get_mut(&id) {
                    m.spent = 200;
                    m.reserved = 100;
                }
                let snap = take_snapshot(&c, id);
                set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::Budget(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Budget below per_payment_cap (KAT-A-03-49 .. 51)
    let tighten_below_cap: Vec<(&'static str, u128)> = vec![
        ("Tighten budget to 99 when cap=100", 99),
        ("Tighten budget to 50 when cap=100", 50),
        ("Tighten budget to 0 when cap=100", 0),
    ];
    for (idx, (desc, val)) in tighten_below_cap.into_iter().enumerate() {
        let sub_id = 49 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_budget": val, "cap": 100 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:BUDGET_BELOW_CAP".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::Budget(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Cap NOT_STRICTER (KAT-A-03-52, 53)
    let tighten_cap_not_stricter: Vec<(&'static str, u128)> = vec![
        ("Tighten cap equal to current cap 100", 100),
        ("Tighten cap higher than current cap (105)", 105),
    ];
    for (idx, (desc, val)) in tighten_cap_not_stricter.into_iter().enumerate() {
        let sub_id = 52 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_cap": val }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_STRICTER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::PerPaymentCap(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Cap below threshold (KAT-A-03-54, 55)
    let tighten_cap_below_thresh: Vec<(&'static str, u128)> = vec![
        ("Tighten cap to 49 when threshold=50", 49),
        ("Tighten cap to 0 when threshold=50", 0),
    ];
    for (idx, (desc, val)) in tighten_cap_below_thresh.into_iter().enumerate() {
        let sub_id = 54 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_cap": val, "threshold": 50 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:CAP_BELOW_THRESHOLD".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(OWNER, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.tighten(id, Change::PerPaymentCap(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 3E: loosen budget & limits hierarchy violations (KAT-A-03-56 .. 70)
    // =========================================================================

    // Budget NOT_LOOSER (KAT-A-03-56, 57)
    let loosen_budget_not_looser: Vec<(&'static str, u128)> = vec![
        ("Loosen budget equal to current budget 1000", 1000),
        ("Loosen budget less than current budget (999)", 999),
    ];
    for (idx, (desc, val)) in loosen_budget_not_looser.into_iter().enumerate() {
        let sub_id = 56 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_budget": val }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_LOOSER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::Budget(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Budget above deposited (KAT-A-03-58 .. 62)
    let loosen_budget_above_dep: Vec<(&'static str, u128)> = vec![
        ("Loosen budget to 1001 when deposited=1000", 1001),
        ("Loosen budget to 1010 when deposited=1000", 1010),
        ("Loosen budget to 1500 when deposited=1000", 1500),
        ("Loosen budget to 2000 when deposited=1000", 2000),
        ("Loosen budget to u128::MAX when deposited=1000", u128::MAX),
    ];
    for (idx, (desc, val)) in loosen_budget_above_dep.into_iter().enumerate() {
        let sub_id = 58 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_budget": val.to_string(), "deposited": 1000 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:BUDGET_ABOVE_DEPOSITED".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::Budget(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Cap NOT_LOOSER (KAT-A-03-63, 64)
    let loosen_cap_not_looser: Vec<(&'static str, u128)> = vec![
        ("Loosen cap equal to current cap 100", 100),
        ("Loosen cap less than current cap (99)", 99),
    ];
    for (idx, (desc, val)) in loosen_cap_not_looser.into_iter().enumerate() {
        let sub_id = 63 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_cap": val }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_LOOSER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::PerPaymentCap(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Cap above budget (KAT-A-03-65 .. 67)
    let loosen_cap_above_budget: Vec<(&'static str, u128)> = vec![
        ("Loosen cap to 1001 when budget=1000", 1001),
        ("Loosen cap to 1500 when budget=1000", 1500),
        ("Loosen cap to u128::MAX when budget=1000", u128::MAX),
    ];
    for (idx, (desc, val)) in loosen_cap_above_budget.into_iter().enumerate() {
        let sub_id = 65 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_cap": val.to_string(), "budget": 1000 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:CAP_ABOVE_BUDGET".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::PerPaymentCap(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Threshold NOT_LOOSER (KAT-A-03-68, 69)
    let loosen_thresh_not_looser: Vec<(&'static str, u128)> = vec![
        ("Loosen threshold equal to current threshold 50", 50),
        ("Loosen threshold less than current threshold (49)", 49),
    ];
    for (idx, (desc, val)) in loosen_thresh_not_looser.into_iter().enumerate() {
        let sub_id = 68 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_threshold": val }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:NOT_LOOSER".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::ApprovalThreshold(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // Threshold above cap (KAT-A-03-70 .. 72)
    let loosen_thresh_above_cap: Vec<(&'static str, u128)> = vec![
        ("Loosen threshold to 101 when cap=100", 101),
        ("Loosen threshold to 150 when cap=100", 150),
        ("Loosen threshold to u128::MAX when cap=100", u128::MAX),
    ];
    for (idx, (desc, val)) in loosen_thresh_above_cap.into_iter().enumerate() {
        let sub_id = 70 + idx;
        let id_str: &'static str = Box::leak(format!("KAT-A-03-{:02}", sub_id).into_boxed_str());
        cases.push(TestCaseDef {
            id: id_str,
            category: 3,
            title: desc,
            params: serde_json::json!({ "new_threshold": val.to_string(), "cap": 100 }),
            expected: CaseExpected {
                label: "BLOCKED".into(),
                code: Some("SCRIP_ERR:THRESHOLD_ABOVE_CAP".into()),
            },
            runner: Box::new(move || {
                let (mut c, id) = setup_fresh_standard_contract();
                let snap = take_snapshot(&c, id);
                set_context(GUARDIAN, NearToken::from_yoctonear(0), 100, NOW, 1000);
                let res = catch_unwind(AssertUnwindSafe(|| {
                    c.loosen(id, Change::ApprovalThreshold(U128(val)));
                }));
                evaluate_call_panic(&c, id, snap, res)
            }),
        });
    }

    // =========================================================================
    // Subgroup 3F: Overflow and edge accounting attacks (KAT-A-03-73 .. 75)
    // =========================================================================

    cases.push(TestCaseDef {
        id: "KAT-A-03-73",
        category: 3,
        title: "u128 overflow in spent + reserved + amount calculation",
        params: serde_json::json!({ "spent": (u128::MAX - 100).to_string(), "reserved": 50, "amount": 60 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:OVER_BUDGET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = u128::MAX - 100;
                m.reserved = 50;
            }
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(60), 2400)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-03-74",
        category: 3,
        title: "u128 overflow when reserved is near u128::MAX",
        params: serde_json::json!({ "spent": 1000, "reserved": (u128::MAX - 1050).to_string(), "amount": 60 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:OVER_BUDGET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = 1000;
                m.reserved = u128::MAX - 1050;
            }
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(60), 2401)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases.push(TestCaseDef {
        id: "KAT-A-03-75",
        category: 3,
        title: "u128 overflow when spent and reserved each take half of u128",
        params: serde_json::json!({ "spent": (u128::MAX / 2).to_string(), "reserved": (u128::MAX / 2 + 10).to_string(), "amount": 10 }),
        expected: CaseExpected {
            label: "BLOCKED".into(),
            code: Some("SCRIP_ERR:OVER_BUDGET".into()),
        },
        runner: Box::new(|| {
            let (mut c, id) = setup_fresh_standard_contract();
            if let Some(m) = c.mandates.get_mut(&id) {
                m.spent = u128::MAX / 2;
                m.reserved = u128::MAX / 2 + 10;
            }
            let snap = take_snapshot(&c, id);
            set_context(AGENT, NearToken::from_yoctonear(0), 100, NOW, 1000);
            let res = catch_unwind(AssertUnwindSafe(|| {
                c.request_payment(id, acc(SHOP), U128(10), 2402)
            }));
            evaluate_payment_result(&c, id, snap, res)
        }),
    });

    cases
}

#[test]
fn attack_catalog_layer_a_part3() {
    let mut all_cases = Vec::new();
    all_cases.extend(build_category_1_cases());
    all_cases.extend(build_category_3_cases());

    println!("Total Layer A Part 3 test cases: {}", all_cases.len());

    let mut outputs: Vec<AttackCaseOutput> = Vec::new();
    let mut breach_count = 0;
    let mut fail_count = 0;
    let mut pass_count = 0;

    for case in all_cases {
        println!("START_CASE: {}", case.id);
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
        "Layer A Part 3 Summary: Total={}, PASS={}, FAIL={}, BREACH={}",
        outputs.len(),
        pass_count,
        fail_count,
        breach_count
    );

    if let Ok(out_path) = std::env::var("ATTACK_CATALOG_OUT_PART3") {
        if !out_path.is_empty() {
            println!("Writing Layer A Part 3 catalog output to: {}", out_path);
            let json_data = serde_json::to_string_pretty(&outputs).expect("Failed to serialize catalog outputs");
            if let Some(parent) = std::path::Path::new(&out_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&out_path, json_data).expect("Failed to write catalog output file");
        }
    }

    assert_eq!(breach_count, 0, "BREACH detected in Layer A attack catalog part 3!");
    assert_eq!(fail_count, 0, "FAIL detected in Layer A attack catalog part 3!");
}
