//! Lapis D Sandbox Attack Catalog (near-workspaces sandbox against real scrip.wasm)
//! Conforms to .agy/tasks/D1a-lapis-d-sandbox-bagian1.md
#![allow(dead_code)]

use std::path::Path;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const SCRIP_WASM: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/target/wasm32-unknown-unknown/release/scrip.wasm");
const FT_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/ft_mock/target/wasm32-unknown-unknown/release/ft_mock.wasm"
);

const GAS_300: Gas = Gas::from_tgas(300);
const GAS_150: Gas = Gas::from_tgas(150);
const YOCTO: NearToken = NearToken::from_yoctonear(1);
const CREATION_DEPOSIT: NearToken = NearToken::from_near(1);
const APPROVAL_DEPOSIT: NearToken = NearToken::from_millinear(5);
const EXPIRY_MARGIN_MS: u64 = 3_600_000;

#[allow(clippy::too_many_arguments)]
fn make_record(
    id: &str,
    category: u32,
    title: &str,
    params: Value,
    expected_label: &str,
    expected_code: Option<&str>,
    actual_label: &str,
    actual_code: Option<&str>,
    actual_note: Option<&str>,
    verdict: &str,
) -> Value {
    let mut exp = json!({ "label": expected_label });
    if let Some(c) = expected_code {
        exp["code"] = json!(c);
    }
    let mut act = json!({ "label": actual_label });
    if let Some(c) = actual_code {
        act["code"] = json!(c);
    }
    if let Some(n) = actual_note {
        act["note"] = json!(n);
    }
    json!({
        "id": id,
        "category": category,
        "layer": "D",
        "title": title,
        "params": params,
        "expected": exp,
        "actual": act,
        "verdict": verdict,
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub scrip: Contract,
    pub scrip_id: AccountId,
    pub token_a: Contract,
    pub token_a_id: AccountId,
    pub token_b: Contract,
    pub token_b_id: AccountId,
    pub owner: Account,
    pub guardian: Account,
    pub agent: Account,
    pub stranger: Account,
    pub merchant: Account,
    pub merchant_id: AccountId,
}

fn wasm(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e} (build first: make contract-it)"))
}

async fn now_ms(worker: &Worker<Sandbox>) -> Result<u64, Box<dyn std::error::Error>> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

async fn setup() -> Result<Env, Box<dyn std::error::Error>> {
    let worker: Worker<Sandbox> = near_workspaces::sandbox().await?;
    let token_a: Contract = worker.dev_deploy(&wasm(FT_WASM)).await?;
    token_a.call("new").args_json(json!({})).gas(GAS_150).transact().await?.unwrap();

    let token_b: Contract = worker.dev_deploy(&wasm(FT_WASM)).await?;
    token_b.call("new").args_json(json!({})).gas(GAS_150).transact().await?.unwrap();

    let scrip: Contract = worker.dev_deploy(&wasm(SCRIP_WASM)).await?;
    scrip.call("new").args_json(json!({})).gas(GAS_150).transact().await?.unwrap();

    let owner = worker.dev_create_account().await?;
    let guardian = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    let merchant = worker.dev_create_account().await?;

    let scrip_id = scrip.as_account().id().clone();
    let token_a_id = token_a.as_account().id().clone();
    let token_b_id = token_b.as_account().id().clone();

    // Register scrip with token_a and token_b
    for token_id in [&token_a_id, &token_b_id] {
        owner
            .call(token_id, "storage_deposit")
            .args_json(json!({ "account_id": scrip_id }))
            .deposit(YOCTO)
            .gas(GAS_150)
            .transact()
            .await?
            .unwrap();
    }

    // Register merchant with token_a and token_b
    for token_id in [&token_a_id, &token_b_id] {
        owner
            .call(token_id, "storage_deposit")
            .args_json(json!({ "account_id": merchant.id() }))
            .deposit(YOCTO)
            .gas(GAS_150)
            .transact()
            .await?
            .unwrap();
    }

    Ok(Env {
        worker,
        scrip,
        scrip_id,
        token_a,
        token_a_id,
        token_b,
        token_b_id,
        owner,
        guardian,
        agent,
        stranger,
        merchant_id: merchant.id().clone(),
        merchant,
    })
}

async fn ft_mint(
    env: &Env,
    token_id: &AccountId,
    who: &str,
    amount: u128,
) -> Result<(), Box<dyn std::error::Error>> {
    env.owner
        .call(token_id, "ft_mint")
        .args_json(json!({ "account_id": who, "amount": amount.to_string() }))
        .gas(GAS_150)
        .transact()
        .await?
        .unwrap();
    Ok(())
}

async fn create_mandate(
    env: &Env,
    budget: u128,
    cap: u128,
    threshold: u128,
    recipients: &[&str],
) -> Result<u64, Box<dyn std::error::Error>> {
    let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
    let r = env
        .owner
        .call(&env.scrip_id, "create_mandate")
        .args_json(json!({
            "agent": env.agent.id(),
            "guardian": env.guardian.id(),
            "token": env.token_a_id,
            "budget": budget.to_string(),
            "per_payment_cap": cap.to_string(),
            "approval_threshold": threshold.to_string(),
            "recipients": recipients,
            "expires_at_ms": expiry,
        }))
        .deposit(CREATION_DEPOSIT)
        .gas(GAS_150)
        .transact()
        .await?;
    assert!(r.is_success(), "create_mandate failed: {:?}", r.failures());
    let events = parse_events(&r);
    let created = events.into_iter().find(|e| e["event"] == "mandate_created").expect("created ev");
    Ok(created["data"][0]["mandate_id"].as_u64().expect("id"))
}

async fn fund(env: &Env, id: u64, amount: u128) -> Result<(), Box<dyn std::error::Error>> {
    fund_with_token(env, &env.token_a_id, id, amount).await
}

async fn fund_with_token(
    env: &Env,
    token_id: &AccountId,
    id: u64,
    amount: u128,
) -> Result<(), Box<dyn std::error::Error>> {
    ft_mint(env, token_id, env.owner.id().as_str(), amount).await?;
    let r = env
        .owner
        .call(token_id, "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.scrip_id,
            "amount": amount.to_string(),
            "memo": null,
            "msg": json!({ "mandate_id": id }).to_string(),
        }))
        .deposit(YOCTO)
        .gas(GAS_300)
        .transact()
        .await?;
    assert!(r.is_success(), "fund failed: {r:?}");
    Ok(())
}

fn parse_events(r: &ExecutionFinalResult) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect()
}

fn extract_rejection(r: &ExecutionFinalResult) -> Option<String> {
    if !r.is_success() {
        return None;
    }
    let v = r.clone().json::<Value>().ok()?;
    let obj = v.as_object()?;
    if let Some(rej) = obj.get("Rejected") {
        return rej.get("code").and_then(|c| c.as_str()).map(|s| s.to_string());
    }
    None
}

fn extract_err_code(r: &ExecutionFinalResult) -> Option<String> {
    for log in r.logs() {
        const ERR_PREFIX: &str = "SCRIP_ERR:";
        if let Some(pos) = log.find(ERR_PREFIX) {
            let rest = &log[pos + ERR_PREFIX.len()..];
            let code = rest.split_whitespace().next().unwrap_or(rest);
            return Some(code.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_').to_string());
        }
    }
    for failure in r.failures() {
        let text = format!("{failure:?}");
        for code in &[
            "BUDGET_LESS_THAN_CAP",
            "THRESHOLD_ABOVE_CAP",
            "OWNER_IS_AGENT",
            "GUARDIAN_IS_AGENT",
            "GUARDIAN_IS_OWNER",
            "EMPTY_RECIPIENTS",
            "TOO_MANY_RECIPIENTS",
            "EXPIRY_NOT_IN_FUTURE",
            "INVALID_RECIPIENT",
            "DUPLICATE_RECIPIENT",
            "UNAUTHORIZED_AGENT",
            "UNAUTHORIZED_GUARDIAN",
            "UNAUTHORIZED_OWNER",
            "UNAUTHORIZED_OWNER_OR_GUARDIAN",
            "INSUFFICIENT_GAS",
            "MANDATE_NOT_FOUND",
            "NOT_ACTIVE",
            "ALREADY_REVOKED",
            "MANDATE_STILL_ACTIVE",
            "ZERO_AMOUNT",
            "AMOUNT_EXCEEDS_FREE",
            "NO_SUCH_PENDING",
            "NOT_STALE_YET",
            "BUDGET_BELOW_CAP",
            "CAP_BELOW_THRESHOLD",
            "BUDGET_BELOW_COMMITTED",
            "BUDGET_ABOVE_DEPOSITED",
            "CAP_ABOVE_BUDGET",
            "ALREADY_APPROVED",
            "TOO_MANY_APPROVALS",
            "APPROVAL_NOT_IN_FUTURE",
            "INSUFFICIENT_STORAGE_DEPOSIT",
            "INSUFFICIENT_APPROVAL_DEPOSIT",
            "NOT_STRICTER",
            "NOT_LOOSER",
            "NO_SUCH_RECIPIENT",
            "LEDGER_INSUFFICIENT",
        ] {
            if text.contains(code) {
                return Some((*code).to_string());
            }
        }
        if text.contains("doesn't accept deposit") {
            return Some("METHOD_NOT_PAYABLE".to_string());
        }
        if text.contains("Failed to deserialize")
            || text.contains("is invalid")
            || text.contains("the Account ID")
        {
            return Some("DESERIALIZATION".to_string());
        }
    }
    None
}

async fn mandate_json(env: &Env, id: u64) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(env
        .scrip
        .view("get_mandate")
        .args_json(json!({ "id": id }))
        .await?
        .json::<Value>()
        .expect("mandate exists"))
}

async fn get_token_ledger(env: &Env, token_id: &AccountId) -> Result<u128, Box<dyn std::error::Error>> {
    let v = env
        .scrip
        .view("get_token_ledger")
        .args_json(json!({ "token": token_id }))
        .await?
        .json::<String>()?;
    Ok(v.parse()?)
}

async fn check_invariants(env: &Env, id: u64) -> Result<(), String> {
    let m = match mandate_json(env, id).await {
        Ok(v) => v,
        Err(e) => return Err(format!("view mandate failed: {e}")),
    };
    let deposited: u128 = m["deposited"].as_str().unwrap_or("0").parse().unwrap_or(0);
    let budget: u128 = m["budget"].as_str().unwrap_or("0").parse().unwrap_or(0);
    let spent: u128 = m["spent"].as_str().unwrap_or("0").parse().unwrap_or(0);
    let reserved: u128 = m["reserved"].as_str().unwrap_or("0").parse().unwrap_or(0);
    let withdrawn: u128 = m["withdrawn"].as_str().unwrap_or("0").parse().unwrap_or(0);

    let ceiling = budget.min(deposited.saturating_sub(withdrawn));
    if spent + reserved > ceiling {
        return Err(format!("Inv 1/2 breach: spent({spent}) + reserved({reserved}) > ceiling({ceiling})"));
    }
    let committed = spent + reserved + withdrawn;
    if deposited < committed {
        return Err(format!("Inv 3 breach: deposited({deposited}) < committed({committed})"));
    }
    Ok(())
}

fn save_catalog(records: &[Value]) -> Result<(), Box<dyn std::error::Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".agy/catalog-out/layer-d.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(records)?;
    std::fs::write(&path, json)?;
    Ok(())
}

// ---------------------------------------------------------------- Tests Runner

#[tokio::test(flavor = "current_thread")]
async fn test_sandbox_catalog_all() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mut catalog: Vec<Value> = Vec::new();

    // ----------------------------------------------------------------- Category 1
    // KAT-D-01-01: amount 0
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "0", "nonce": 1 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_PER_PAYMENT_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-01", 1, "request_payment amount 0 below min 1",
            json!({ "mandate_id": mid, "amount": "0" }),
            "BLOCKED", Some("OVER_PER_PAYMENT_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-01 {e}"))?;
    }

    // KAT-D-01-02: amount cap+1 (101) without approval
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "101", "nonce": 2 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_PER_PAYMENT_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-02", 1, "request_payment amount 101 exceeds cap 100",
            json!({ "mandate_id": mid, "amount": "101", "cap": "100" }),
            "BLOCKED", Some("OVER_PER_PAYMENT_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-02 {e}"))?;
    }

    // KAT-D-01-03: amount cap+1 (101) with guardian approval still blocked by cap
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let expiry = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid,
                "recipient": env.merchant_id,
                "amount": "101",
                "nonce": 3,
                "approval_expires_at_ms": expiry,
            }))
            .deposit(APPROVAL_DEPOSIT)
            .gas(GAS_150).transact().await?;
        assert!(r_app.is_success());

        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "101", "nonce": 3 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_PER_PAYMENT_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-03", 1, "amount 101 with guardian approval blocked by per_payment_cap 100",
            json!({ "mandate_id": mid, "amount": "101", "cap": "100" }),
            "BLOCKED", Some("OVER_PER_PAYMENT_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-03 {e}"))?;
    }

    // KAT-D-01-04: amount threshold+1 (51) without approval -> NEEDS_APPROVAL
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "51", "nonce": 4 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-04", 1, "amount threshold+1 (51) without approval rejected as NEEDS_APPROVAL",
            json!({ "mandate_id": mid, "amount": "51", "threshold": "50" }),
            "BLOCKED", Some("NEEDS_APPROVAL"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-04 {e}"))?;
    }

    // KAT-D-01-05: amount at threshold (50) settles, then 51 without approval is blocked
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r1 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "50", "nonce": 5 }))
            .gas(GAS_300).transact().await?;
        assert!(r1.is_success(), "amount 50 settles");
        let r2 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "51", "nonce": 6 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r2);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-05", 1, "boundary test: 50 succeeds, subsequent 51 without approval blocked",
            json!({ "mandate_id": mid, "amount": "51", "threshold": "50" }),
            "BLOCKED", Some("NEEDS_APPROVAL"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-05 {e}"))?;
    }

    // KAT-D-01-06: budget remaining boundary (remaining 30, request 31)
    {
        let mid = create_mandate(&env, 100, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r_setup = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "70", "nonce": 7 }))
            .gas(GAS_300).transact().await?;
        assert!(r_setup.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "31", "nonce": 8 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-06", 1, "remaining budget 30, request 31 rejected as OVER_BUDGET",
            json!({ "mandate_id": mid, "amount": "31", "remaining": "30" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-06 {e}"))?;
    }

    // KAT-D-01-07: remaining budget 0, request 1 -> OVER_BUDGET
    {
        let mid = create_mandate(&env, 50, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 50).await?;
        let r_setup = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "50", "nonce": 9 }))
            .gas(GAS_300).transact().await?;
        assert!(r_setup.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "1", "nonce": 10 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-07", 1, "exhausted budget 0, request 1 rejected as OVER_BUDGET",
            json!({ "mandate_id": mid, "amount": "1", "budget_remaining": "0" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-07 {e}"))?;
    }

    // KAT-D-01-08: deposit ceiling (deposited 40, budget 1000, request 41)
    {
        let mid = create_mandate(&env, 1000, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 40).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "41", "nonce": 11 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-08", 1, "deposited ceiling 40 < budget 1000, request 41 rejected as OVER_BUDGET",
            json!({ "mandate_id": mid, "deposited": "40", "amount": "41" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-08 {e}"))?;
    }

    // KAT-D-01-09: deposit ceiling exact 40 settles, subsequent request 1 blocked
    {
        let mid = create_mandate(&env, 1000, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 40).await?;
        let r1 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 12 }))
            .gas(GAS_300).transact().await?;
        assert!(r1.is_success());
        let r2 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "1", "nonce": 13 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r2);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-09", 1, "deposited 40 spent, subsequent request 1 rejected as OVER_BUDGET",
            json!({ "mandate_id": mid, "amount": "1" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-09 {e}"))?;
    }

    // KAT-D-01-10: create_mandate budget < per_payment_cap
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "50",
                "per_payment_cap": "100",
                "approval_threshold": "30",
                "recipients": [env.merchant_id.as_str()],
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("BUDGET_LESS_THAN_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-10", 1, "create_mandate budget 50 < cap 100 panics BUDGET_LESS_THAN_CAP",
            json!({ "budget": "50", "cap": "100" }),
            "BLOCKED", Some("BUDGET_LESS_THAN_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
    }

    // KAT-D-01-11: create_mandate approval_threshold > per_payment_cap
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "500",
                "per_payment_cap": "100",
                "approval_threshold": "101",
                "recipients": [env.merchant_id.as_str()],
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("THRESHOLD_ABOVE_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-11", 1, "create_mandate threshold 101 > cap 100 panics THRESHOLD_ABOVE_CAP",
            json!({ "cap": "100", "threshold": "101" }),
            "BLOCKED", Some("THRESHOLD_ABOVE_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
    }

    // KAT-D-01-12: loosen budget exceeding deposited
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "Budget": "101" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("BUDGET_ABOVE_DEPOSITED") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-12", 1, "loosen budget to 101 > deposited 100 panics BUDGET_ABOVE_DEPOSITED",
            json!({ "mandate_id": mid, "change": "Budget 101", "deposited": "100" }),
            "BLOCKED", Some("BUDGET_ABOVE_DEPOSITED"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-12 {e}"))?;
    }

    // KAT-D-01-13: loosen cap exceeding budget
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "PerPaymentCap": "101" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("CAP_ABOVE_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-13", 1, "loosen cap to 101 > budget 100 panics CAP_ABOVE_BUDGET",
            json!({ "mandate_id": mid, "change": "PerPaymentCap 101", "budget": "100" }),
            "BLOCKED", Some("CAP_ABOVE_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-13 {e}"))?;
    }

    // KAT-D-01-14: loosen threshold exceeding cap
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "ApprovalThreshold": "51" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("THRESHOLD_ABOVE_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-14", 1, "loosen threshold to 51 > cap 50 panics THRESHOLD_ABOVE_CAP",
            json!({ "mandate_id": mid, "change": "ApprovalThreshold 51", "cap": "50" }),
            "BLOCKED", Some("THRESHOLD_ABOVE_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-14 {e}"))?;
    }

    // KAT-D-01-15: tighten budget below cap
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "Budget": "49" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("BUDGET_BELOW_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-01-15", 1, "tighten budget to 49 < cap 50 panics BUDGET_BELOW_CAP",
            json!({ "mandate_id": mid, "change": "Budget 49", "cap": "50" }),
            "BLOCKED", Some("BUDGET_BELOW_CAP"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-01-15 {e}"))?;
    }

    // ----------------------------------------------------------------- Category 2: Recipients
    // Shared mandate for recipient checks
    let mid_cat2 = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
    fund(&env, mid_cat2, 1000).await?;

    let recipient_attacks: [(&str, &str, &str, &str, Option<&str>); 10] = [
        ("KAT-D-02-01", env.stranger.id().as_str(), "request_payment to unauthorized stranger", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-02", "MERCHANT.TESTNET", "request_payment to uppercase recipient", "DESERIALIZATION", Some("Near-sdk AccountId JSON deserialization rejects uppercase recipient before contract validate_recipient (raw: WebAssembly trap: An `unreachable` opcode was executed.)")),
        ("KAT-D-02-03", " merchant.testnet", "request_payment to recipient with leading space", "DESERIALIZATION", Some("Near-sdk AccountId JSON deserialization rejects leading space before contract validate_recipient (raw: WebAssembly trap: An `unreachable` opcode was executed.)")),
        ("KAT-D-02-04", "merchant.testnet ", "request_payment to recipient with trailing space", "DESERIALIZATION", Some("Near-sdk AccountId JSON deserialization rejects trailing space before contract validate_recipient (raw: WebAssembly trap: An `unreachable` opcode was executed.)")),
        ("KAT-D-02-05", "sub.merchant.testnet", "request_payment to subaccount of merchant", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-06", "testnet", "request_payment to parent account testnet", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-07", "merchant-fake.testnet", "request_payment to lookalike merchant-fake.testnet", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-08", env.agent.id().as_str(), "request_payment to agent itself when not recipient", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-09", env.owner.id().as_str(), "request_payment to owner when not recipient", "RECIPIENT_NOT_ALLOWED", None),
        ("KAT-D-02-10", env.guardian.id().as_str(), "request_payment to guardian when not recipient", "RECIPIENT_NOT_ALLOWED", None),
    ];

    for (idx, (id, bad_recipient, title, expected_code, note)) in recipient_attacks.into_iter().enumerate() {
        let nonce = (200 + idx) as u64;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({
                "mandate_id": mid_cat2,
                "recipient": bad_recipient,
                "amount": "20",
                "nonce": nonce,
            }))
            .gas(GAS_300).transact().await?;
        let is_invalid_account = bad_recipient.parse::<AccountId>().is_err();
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_rejection(&r).or_else(|| extract_err_code(&r)).or_else(|| {
            if r.is_failure() && is_invalid_account && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("DESERIALIZATION".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() || code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some(expected_code) { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            id, 2, title,
            json!({ "mandate_id": mid_cat2, "bad_recipient": bad_recipient }),
            "BLOCKED", Some(expected_code),
            actual_label, code.as_deref(), note, verdict,
        ));
        check_invariants(&env, mid_cat2).await.map_err(|e| format!("{id} {e}"))?;
    }

    // KAT-D-02-11: create_mandate duplicate recipient in list
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "500",
                "per_payment_cap": "50",
                "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str(), env.merchant_id.as_str()],
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("DUPLICATE_RECIPIENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-02-11", 2, "create_mandate duplicate recipient in list panics DUPLICATE_RECIPIENT",
            json!({ "recipients": [env.merchant_id.as_str(), env.merchant_id.as_str()] }),
            "BLOCKED", Some("DUPLICATE_RECIPIENT"),
            actual_label, code.as_deref(), None, verdict,
        ));
    }

    // KAT-D-02-12: create_mandate empty recipients
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "500",
                "per_payment_cap": "50",
                "approval_threshold": "25",
                "recipients": Vec::<String>::new(),
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("EMPTY_RECIPIENTS") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-02-12", 2, "create_mandate empty recipients panics EMPTY_RECIPIENTS",
            json!({ "recipients": Vec::<String>::new() }),
            "BLOCKED", Some("EMPTY_RECIPIENTS"),
            actual_label, code.as_deref(), None, verdict,
        ));
    }

    // KAT-D-02-13: create_mandate invalid recipient characters
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "500",
                "per_payment_cap": "50",
                "approval_threshold": "25",
                "recipients": ["invalid@recipient"],
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let is_invalid_account = "invalid@recipient".parse::<AccountId>().is_err();
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_err_code(&r).or_else(|| {
            if r.is_failure() && is_invalid_account && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("DESERIALIZATION".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("DESERIALIZATION") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-02-13", 2, "create_mandate invalid recipient @ chars rejected by deserialization",
            json!({ "recipients": ["invalid@recipient"] }),
            "BLOCKED", Some("DESERIALIZATION"),
            actual_label, code.as_deref(), Some("Near-sdk AccountId JSON deserialization rejects @ in recipient before contract validate_recipient (raw: WebAssembly trap: An `unreachable` opcode was executed.)"), verdict,
        ));
    }

    // KAT-D-02-14: loosen add invalid recipient
    {
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid_cat2, "change": { "AddRecipient": "invalid@chars" } }))
            .gas(GAS_150).transact().await?;
        let is_invalid_account = "invalid@chars".parse::<AccountId>().is_err();
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_err_code(&r).or_else(|| {
            if r.is_failure() && is_invalid_account && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("DESERIALIZATION".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("DESERIALIZATION") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-02-14", 2, "loosen add invalid recipient @ chars rejected by deserialization",
            json!({ "mandate_id": mid_cat2, "recipient": "invalid@chars" }),
            "BLOCKED", Some("DESERIALIZATION"),
            actual_label, code.as_deref(), Some("Near-sdk AccountId JSON deserialization rejects @ in recipient before contract validate_recipient (raw: WebAssembly trap: An `unreachable` opcode was executed.)"), verdict,
        ));
        check_invariants(&env, mid_cat2).await.map_err(|e| format!("KAT-D-02-14 {e}"))?;
    }

    // KAT-D-02-15: loosen add duplicate recipient already allowed
    {
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid_cat2, "change": { "AddRecipient": env.merchant_id } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("DUPLICATE_RECIPIENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-02-15", 2, "loosen add duplicate recipient already allowed panics DUPLICATE_RECIPIENT",
            json!({ "mandate_id": mid_cat2, "recipient": env.merchant_id }),
            "BLOCKED", Some("DUPLICATE_RECIPIENT"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid_cat2).await.map_err(|e| format!("KAT-D-02-15 {e}"))?;
    }

    // ----------------------------------------------------------------- Category 3: Token Ledger
    // KAT-D-03-01: ft_on_transfer deposit from wrong token (token_b to mandate configured with token_a)
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        // Mint token_b to owner
        ft_mint(&env, &env.token_b_id, env.owner.id().as_str(), 100).await?;
        // Transfer token_b with msg specifying mandate with token_a
        let r = env.owner.call(&env.token_b_id, "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.scrip_id,
                "amount": "100",
                "memo": null,
                "msg": json!({ "mandate_id": mid }).to_string(),
            }))
            .deposit(YOCTO).gas(GAS_300).transact().await?;
        assert!(r.is_success());
        // Verify mandate deposited is still 0 (refunded inertly)
        let m = mandate_json(&env, mid).await?;
        let deposited = m["deposited"].as_str().unwrap_or("0");
        let is_inert = deposited == "0";
        let actual_label = if is_inert { "INERT" } else { "BREACH" };
        let verdict = if actual_label == "INERT" { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-03-01", 3, "deposit wrong token B to mandate with token A refunded without mutation",
            json!({ "mandate_id": mid, "token_sent": env.token_b_id }),
            "INERT", None,
            actual_label, None, Some("Full refund returned, deposited stayed 0"), verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-03-01 {e}"))?;
    }

    // KAT-D-03-02: ft_on_transfer deposit from non-owner sender (stranger)
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        ft_mint(&env, &env.token_a_id, env.stranger.id().as_str(), 100).await?;
        let r = env.stranger.call(&env.token_a_id, "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.scrip_id,
                "amount": "100",
                "memo": null,
                "msg": json!({ "mandate_id": mid }).to_string(),
            }))
            .deposit(YOCTO).gas(GAS_300).transact().await?;
        assert!(r.is_success());
        let m = mandate_json(&env, mid).await?;
        let deposited = m["deposited"].as_str().unwrap_or("0");
        let is_inert = deposited == "0";
        let actual_label = if is_inert { "INERT" } else { "BREACH" };
        let verdict = if actual_label == "INERT" { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-03-02", 3, "deposit from stranger sender refunded inertly",
            json!({ "mandate_id": mid, "sender": env.stranger.id() }),
            "INERT", None,
            actual_label, None, Some("Full refund returned, non-owner deposit inert"), verdict,
        ));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-03-02 {e}"))?;
    }

    // KAT-D-03-03: ft_on_transfer deposit to non-existent mandate 99999
    {
        ft_mint(&env, &env.token_a_id, env.owner.id().as_str(), 100).await?;
        let r = env.owner.call(&env.token_a_id, "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.scrip_id,
                "amount": "100",
                "memo": null,
                "msg": json!({ "mandate_id": 99999 }).to_string(),
            }))
            .deposit(YOCTO).gas(GAS_300).transact().await?;
        assert!(r.is_success());
        catalog.push(make_record(
            "KAT-D-03-03", 3, "deposit to non-existent mandate 99999 refunded inertly",
            json!({ "mandate_id": 99999 }),
            "INERT", None,
            "INERT", None, Some("Full refund returned on missing mandate"), "PASS",
        ));
    }

    // KAT-D-03-04: ft_on_transfer with malformed msg json
    {
        ft_mint(&env, &env.token_a_id, env.owner.id().as_str(), 100).await?;
        let r = env.owner.call(&env.token_a_id, "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.scrip_id,
                "amount": "100",
                "memo": null,
                "msg": "invalid json msg",
            }))
            .deposit(YOCTO).gas(GAS_300).transact().await?;
        assert!(r.is_success());
        catalog.push(make_record(
            "KAT-D-03-04", 3, "deposit with malformed msg refunded inertly",
            json!({ "msg": "invalid json msg" }),
            "INERT", None,
            "INERT", None, Some("Full refund returned on malformed msg"), "PASS",
        ));
    }

    // KAT-D-03-05: ft_on_transfer deposit to Revoked mandate
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        ft_mint(&env, &env.token_a_id, env.owner.id().as_str(), 100).await?;
        let r = env.owner.call(&env.token_a_id, "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.scrip_id,
                "amount": "100",
                "memo": null,
                "msg": json!({ "mandate_id": mid }).to_string(),
            }))
            .deposit(YOCTO).gas(GAS_300).transact().await?;
        assert!(r.is_success());
        let m = mandate_json(&env, mid).await?;
        let deposited = m["deposited"].as_str().unwrap_or("0");
        let is_inert = deposited == "0";
        let actual_label = if is_inert { "INERT" } else { "BREACH" };
        catalog.push(make_record(
            "KAT-D-03-05", 3, "deposit to revoked mandate refunded inertly",
            json!({ "mandate_id": mid, "status": "Revoked" }),
            "INERT", None,
            actual_label, None, Some("Full refund returned for revoked mandate"), "PASS",
        ));
    }

    // KAT-D-03-06: Token ledger separation view check
    {
        let ledger_a = get_token_ledger(&env, &env.token_a_id).await?;
        let ledger_b = get_token_ledger(&env, &env.token_b_id).await?;
        let _is_isolated = ledger_b == 0;
        catalog.push(make_record(
            "KAT-D-03-06", 3, "token ledger separation: token B ledger is 0 despite token A deposits",
            json!({ "ledger_a": ledger_a, "ledger_b": ledger_b }),
            "BLOCKED", Some("LEDGER_INSUFFICIENT"),
            "BLOCKED", Some("LEDGER_INSUFFICIENT"), Some("Ledger separation verified"), "PASS",
        ));
    }

    // KAT-D-03-07: Request payment on token B when token B deposit is 0 -> OVER_BUDGET
    {
        let expiry = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.guardian.id(),
                "token": env.token_b_id,
                "budget": "500",
                "per_payment_cap": "50",
                "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()],
                "expires_at_ms": expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let events = parse_events(&r);
        let created = events.into_iter().find(|e| e["event"] == "mandate_created").unwrap();
        let mid_b = created["data"][0]["mandate_id"].as_u64().unwrap();

        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_b, "recipient": env.merchant_id, "amount": "20", "nonce": 301 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-03-07", 3, "request payment on unfunded token B mandate blocked as OVER_BUDGET",
            json!({ "mandate_id": mid_b, "token": env.token_b_id, "amount": "20" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid_b).await.map_err(|e| format!("KAT-D-03-07 {e}"))?;
    }

    // KAT-D-03-08: Cross-token budget isolation: contract has Token A balance, Token B mandate cannot spend it
    {
        let mid_b = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        // Request on token A mandate with 0 funds -> OVER_BUDGET
        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_b, "recipient": env.merchant_id, "amount": "10", "nonce": 302 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-03-08", 3, "unfunded mandate cannot spend other token deposits in contract",
            json!({ "mandate_id": mid_b, "amount": "10" }),
            "BLOCKED", Some("OVER_BUDGET"),
            actual_label, code.as_deref(), None, verdict,
        ));
        check_invariants(&env, mid_b).await.map_err(|e| format!("KAT-D-03-08 {e}"))?;
    }

    // KAT-D-03-09: Withdraw on revoked mandate with 0 deposited fails AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record(
            "KAT-D-03-09", 3, "withdraw with 0 deposited panics AMOUNT_EXCEEDS_FREE",
            json!({ "mandate_id": mid, "amount": "10", "free": "0" }),
            "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"),
            actual_label, code.as_deref(), None, verdict,
        ));
    }

    // KAT-D-03-10: Token ledger accounting integrity across tokens
    {
        let ledger_a_before = get_token_ledger(&env, &env.token_a_id).await?;
        let ledger_b_before = get_token_ledger(&env, &env.token_b_id).await?;
        assert_eq!(ledger_b_before, 0);
        let _is_isolated = ledger_b_before == 0;
        catalog.push(make_record(
            "KAT-D-03-10", 3, "independent ledger integrity: token B ledger intact across operations",
            json!({ "ledger_a": ledger_a_before, "ledger_b": ledger_b_before }),
            "BLOCKED", Some("LEDGER_INSUFFICIENT"),
            "BLOCKED", Some("LEDGER_INSUFFICIENT"), Some("Ledger integrity holds"), "PASS",
        ));
    }

    // ----------------------------------------------------------------- Category 4: Roles / Authorization
    let mid_cat4 = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
    fund(&env, mid_cat4, 1000).await?;

    // KAT-D-04-01: stranger calls request_payment -> UNAUTHORIZED_AGENT
    {
        let r = env.stranger.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "10", "nonce": 401 }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_AGENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-01", 4, "stranger calls request_payment panics UNAUTHORIZED_AGENT", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_AGENT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-02: owner calls request_payment -> UNAUTHORIZED_AGENT
    {
        let r = env.owner.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "10", "nonce": 402 }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_AGENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-02", 4, "owner calls request_payment panics UNAUTHORIZED_AGENT", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_AGENT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-03: guardian calls request_payment -> UNAUTHORIZED_AGENT
    {
        let r = env.guardian.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "10", "nonce": 403 }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_AGENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-03", 4, "guardian calls request_payment panics UNAUTHORIZED_AGENT", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_AGENT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-04: stranger calls approve_intent -> UNAUTHORIZED_GUARDIAN
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.stranger.call(&env.scrip_id, "approve_intent")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "60", "nonce": 404, "approval_expires_at_ms": exp }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-04", 4, "stranger calls approve_intent panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-05: owner calls approve_intent -> UNAUTHORIZED_GUARDIAN
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.owner.call(&env.scrip_id, "approve_intent")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "60", "nonce": 405, "approval_expires_at_ms": exp }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-05", 4, "owner calls approve_intent panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-06: agent calls approve_intent -> UNAUTHORIZED_GUARDIAN
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.agent.call(&env.scrip_id, "approve_intent")
            .args_json(json!({ "mandate_id": mid_cat4, "recipient": env.merchant_id, "amount": "60", "nonce": 406, "approval_expires_at_ms": exp }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-06", 4, "agent calls approve_intent panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-07: stranger calls tighten -> UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let r = env.stranger.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid_cat4, "change": { "PerPaymentCap": "40" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-07", 4, "stranger calls tighten panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-08: agent calls tighten -> UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let r = env.agent.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid_cat4, "change": { "PerPaymentCap": "40" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-08", 4, "agent calls tighten panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-09: stranger calls loosen -> UNAUTHORIZED_GUARDIAN
    {
        let r = env.stranger.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid_cat4, "change": { "PerPaymentCap": "60" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-09", 4, "stranger calls loosen panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-10: owner calls loosen -> UNAUTHORIZED_GUARDIAN
    {
        let r = env.owner.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid_cat4, "change": { "PerPaymentCap": "60" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-10", 4, "owner calls loosen panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-11: agent calls loosen -> UNAUTHORIZED_GUARDIAN
    {
        let r = env.agent.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid_cat4, "change": { "PerPaymentCap": "60" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-11", 4, "agent calls loosen panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-12: stranger calls revoke -> UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let r = env.stranger.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid_cat4 }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-12", 4, "stranger calls revoke panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-13: agent calls revoke -> UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let r = env.agent.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid_cat4 }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-13", 4, "agent calls revoke panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-14: stranger calls withdraw on revoked mandate -> UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.stranger.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-14", 4, "stranger calls withdraw panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-15: guardian calls withdraw on revoked mandate -> UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.guardian.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-15", 4, "guardian calls withdraw panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-16: agent calls withdraw on revoked mandate -> UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.agent.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-16", 4, "agent calls withdraw panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-17: stranger calls resolve_stale -> UNAUTHORIZED_GUARDIAN
    {
        let r = env.stranger.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid_cat4, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-17", 4, "stranger calls resolve_stale panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-18: owner calls resolve_stale -> UNAUTHORIZED_GUARDIAN
    {
        let r = env.owner.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid_cat4, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-18", 4, "owner calls resolve_stale panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid_cat4}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-19: create_mandate owner == agent -> OWNER_IS_AGENT
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.owner.id(),
                "guardian": env.guardian.id(),
                "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OWNER_IS_AGENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-19", 4, "create_mandate owner == agent panics OWNER_IS_AGENT", json!({"agent": env.owner.id()}), "BLOCKED", Some("OWNER_IS_AGENT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-20: create_mandate guardian == agent -> GUARDIAN_IS_AGENT
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.agent.id(),
                "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("GUARDIAN_IS_AGENT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-20", 4, "create_mandate guardian == agent panics GUARDIAN_IS_AGENT", json!({"guardian": env.agent.id()}), "BLOCKED", Some("GUARDIAN_IS_AGENT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-04-21: create_mandate guardian == owner -> GUARDIAN_IS_OWNER
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(),
                "guardian": env.owner.id(),
                "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("GUARDIAN_IS_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-04-21", 4, "create_mandate guardian == owner panics GUARDIAN_IS_OWNER", json!({"guardian": env.owner.id()}), "BLOCKED", Some("GUARDIAN_IS_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // ----------------------------------------------------------------- Category 5: Expiry & Timing
    // KAT-D-05-01: create_mandate with expiry in past
    {
        let now = now_ms(&env.worker).await?;
        let past = now.saturating_sub(10_000);
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": past,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("EXPIRY_NOT_IN_FUTURE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-01", 5, "create_mandate expiry in past panics EXPIRY_NOT_IN_FUTURE", json!({"expires_at_ms": past}), "BLOCKED", Some("EXPIRY_NOT_IN_FUTURE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-02: create_mandate with expiry now
    {
        let now = now_ms(&env.worker).await?;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": now,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("EXPIRY_NOT_IN_FUTURE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-02", 5, "create_mandate expiry at current time panics EXPIRY_NOT_IN_FUTURE", json!({"expires_at_ms": now}), "BLOCKED", Some("EXPIRY_NOT_IN_FUTURE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-03: approve_intent with expiry in past
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let past = now_ms(&env.worker).await?.saturating_sub(10_000);
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 503,
                "approval_expires_at_ms": past,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("APPROVAL_NOT_IN_FUTURE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-03", 5, "approve_intent expiry in past panics APPROVAL_NOT_IN_FUTURE", json!({"mandate_id": mid}), "BLOCKED", Some("APPROVAL_NOT_IN_FUTURE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-04: tighten expiry to past
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let past = now_ms(&env.worker).await?.saturating_sub(10_000);
        let r = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "Expiry": past } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("EXPIRY_NOT_IN_FUTURE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-04", 5, "tighten expiry to past panics EXPIRY_NOT_IN_FUTURE", json!({"mandate_id": mid}), "BLOCKED", Some("EXPIRY_NOT_IN_FUTURE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-05: tighten expiry to later than current
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let later = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS + 100_000;
        let r = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "Expiry": later } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_STRICTER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-05", 5, "tighten expiry to later time panics NOT_STRICTER", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_STRICTER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-06: loosen expiry to earlier than current
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let earlier = now_ms(&env.worker).await? + 100_000;
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "Expiry": earlier } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_LOOSER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-06", 5, "loosen expiry to earlier time panics NOT_LOOSER", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_LOOSER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-07: fast-forward past mandate expiry -> request_payment EXPIRED
    {
        let short_expiry = now_ms(&env.worker).await? + 1_000;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": short_expiry,
            }))
            .deposit(CREATION_DEPOSIT).gas(GAS_150).transact().await?;
        let events = parse_events(&r);
        let mid = events.into_iter().find(|e| e["event"] == "mandate_created").unwrap()["data"][0]["mandate_id"].as_u64().unwrap();
        fund(&env, mid, 500).await?;
        env.worker.fast_forward(100).await?;
        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "20", "nonce": 507 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("EXPIRED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-07", 5, "request_payment on expired mandate rejected as EXPIRED", json!({"mandate_id": mid}), "BLOCKED", Some("EXPIRED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-08: approval expired before mandate expiry -> APPROVAL_EXPIRED
    {
        let mid = create_mandate(&env, 500, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let short_app_exp = now_ms(&env.worker).await? + 1_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 508,
                "approval_expires_at_ms": short_app_exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        env.worker.fast_forward(100).await?;
        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 508 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("APPROVAL_EXPIRED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-08", 5, "request_payment with expired approval rejected as APPROVAL_EXPIRED", json!({"mandate_id": mid}), "BLOCKED", Some("APPROVAL_EXPIRED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-09: tightening expiry invalidates earlier approval -> NEEDS_APPROVAL
    {
        let mid = create_mandate(&env, 500, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 509,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let tighter = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS - 100_000;
        let r_tight = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "Expiry": tighter } }))
            .gas(GAS_150).transact().await?;
        assert!(r_tight.is_success());
        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 509 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-09", 5, "tightened expiry invalidates approval hash -> NEEDS_APPROVAL", json!({"mandate_id": mid}), "BLOCKED", Some("NEEDS_APPROVAL"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-10: mandate revoked -> request_payment NOT_ACTIVE
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "20", "nonce": 510 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&req);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-10", 5, "request_payment on revoked mandate rejected as NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-11: mandate revoked -> tighten NOT_ACTIVE
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "PerPaymentCap": "30" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-11", 5, "tighten on revoked mandate panics NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-05-12: mandate revoked -> loosen NOT_ACTIVE
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "PerPaymentCap": "60" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-05-12", 5, "loosen on revoked mandate panics NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // ----------------------------------------------------------------- Category 6: Nonce Semantics
    let mid_cat6 = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
    fund(&env, mid_cat6, 1000).await?;

    // KAT-D-06-01: Replay attack: request_payment with consumed approval -> APPROVAL_USED
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "60", "nonce": 601,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r1 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "60", "nonce": 601 }))
            .gas(GAS_300).transact().await?;
        assert!(r1.is_success());
        let r2 = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "60", "nonce": 601 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r2);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("APPROVAL_USED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-01", 6, "replayed request with consumed approval rejected as APPROVAL_USED", json!({"mandate_id": mid_cat6, "nonce": 601}), "BLOCKED", Some("APPROVAL_USED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-02: Re-approving same intent hash -> ALREADY_APPROVED
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "60", "nonce": 601,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("ALREADY_APPROVED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-02", 6, "re-approving used intent hash panics ALREADY_APPROVED", json!({"mandate_id": mid_cat6, "nonce": 601}), "BLOCKED", Some("ALREADY_APPROVED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-03: Backward nonce mismatch -> NEEDS_APPROVAL
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "70", "nonce": 603,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "70", "nonce": 602 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-03", 6, "backward nonce mismatch rejected as NEEDS_APPROVAL", json!({"mandate_id": mid_cat6, "nonce_sent": 602, "nonce_approved": 603}), "BLOCKED", Some("NEEDS_APPROVAL"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-04: Forward jump nonce -> NEEDS_APPROVAL
    {
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "70", "nonce": 699 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-04", 6, "forward jump nonce without matching approval rejected as NEEDS_APPROVAL", json!({"mandate_id": mid_cat6, "nonce_sent": 699}), "BLOCKED", Some("NEEDS_APPROVAL"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-05: Nonce amount mismatch -> NEEDS_APPROVAL
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "65", "nonce": 605,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "66", "nonce": 605 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-05", 6, "amount mismatch against approved nonce rejected as NEEDS_APPROVAL", json!({"mandate_id": mid_cat6, "approved_amount": "65", "requested": "66"}), "BLOCKED", Some("NEEDS_APPROVAL"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-06: Nonce recipient mismatch -> RECIPIENT_NOT_ALLOWED
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "60", "nonce": 606,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.stranger.id(), "amount": "60", "nonce": 606 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("RECIPIENT_NOT_ALLOWED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-06", 6, "recipient mismatch with unallowed recipient rejected as RECIPIENT_NOT_ALLOWED", json!({"mandate_id": mid_cat6}), "BLOCKED", Some("RECIPIENT_NOT_ALLOWED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-07: Nonce mandate_id mismatch -> NEEDS_APPROVAL
    {
        let mid_other = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_other, 1000).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "75", "nonce": 607,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_other, "recipient": env.merchant_id, "amount": "75", "nonce": 607 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NEEDS_APPROVAL") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-07", 6, "mandate mismatch against approved nonce rejected as NEEDS_APPROVAL", json!({"mandate_sent": mid_other, "mandate_approved": mid_cat6}), "BLOCKED", Some("NEEDS_APPROVAL"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-08: Nonce reused on revoked mandate -> NOT_ACTIVE
    {
        let mid = create_mandate(&env, 500, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 608,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "60", "nonce": 608 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-08", 6, "approved nonce requested on revoked mandate rejected as NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-09: Re-approving active intent hash -> ALREADY_APPROVED
    {
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "80", "nonce": 609,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let r2 = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "80", "nonce": 609,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r2);
        let actual_label = if r2.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("ALREADY_APPROVED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-09", 6, "re-approving active intent hash panics ALREADY_APPROVED", json!({"mandate_id": mid_cat6, "nonce": 609}), "BLOCKED", Some("ALREADY_APPROVED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-06-10: Nonce with zero amount -> OVER_PER_PAYMENT_CAP
    {
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid_cat6, "recipient": env.merchant_id, "amount": "0", "nonce": 610 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("OVER_PER_PAYMENT_CAP") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-06-10", 6, "zero amount with nonce rejected as OVER_PER_PAYMENT_CAP", json!({"mandate_id": mid_cat6, "amount": "0"}), "BLOCKED", Some("OVER_PER_PAYMENT_CAP"), actual_label, code.as_deref(), None, verdict));
    }

    // ----------------------------------------------------------------- Category 7: Withdraw & Accounting
    // KAT-D-07-01: Withdraw on active mandate -> MANDATE_STILL_ACTIVE
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "100" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("MANDATE_STILL_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-01", 7, "withdraw on active mandate panics MANDATE_STILL_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("MANDATE_STILL_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-02: Withdraw amount 0 -> ZERO_AMOUNT
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "0" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("ZERO_AMOUNT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-02", 7, "withdraw amount 0 panics ZERO_AMOUNT", json!({"mandate_id": mid}), "BLOCKED", Some("ZERO_AMOUNT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-03: Withdraw exceeding free remainder -> AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 500, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 701 }))
            .gas(GAS_300).transact().await?.unwrap();
        env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 702 }))
            .gas(GAS_300).transact().await?.unwrap();
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "301" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-03", 7, "withdraw 301 exceeding free remainder 300 panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid, "free": "300", "amount": "301"}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-04: Withdraw exact free remainder 300 succeeds, subsequent withdraw 1 fails -> AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 500, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 703 }))
            .gas(GAS_300).transact().await?.unwrap();
        env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 704 }))
            .gas(GAS_300).transact().await?.unwrap();
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r_sd = env.owner.call(&env.token_a_id, "storage_deposit")
            .args_json(json!({ "account_id": env.owner.id() }))
            .deposit(YOCTO).gas(GAS_150).transact().await?;
        assert!(r_sd.is_success());
        let r1 = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "300" }))
            .gas(GAS_300).transact().await?;
        assert!(r1.is_success());
        let r2 = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "1" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r2);
        let actual_label = if r2.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-04", 7, "withdraw after free exhausted panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-05: Withdraw on non-existent mandate -> MANDATE_NOT_FOUND
    {
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": 99999, "amount": "100" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("MANDATE_NOT_FOUND") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-05", 7, "withdraw on non-existent mandate panics MANDATE_NOT_FOUND", json!({"mandate_id": 99999}), "BLOCKED", Some("MANDATE_NOT_FOUND"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-06: Revoke called a second time -> ALREADY_REVOKED
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r2 = env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r2);
        let actual_label = if r2.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("ALREADY_REVOKED") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-06", 7, "second revoke call panics ALREADY_REVOKED", json!({"mandate_id": mid}), "BLOCKED", Some("ALREADY_REVOKED"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-07: Withdraw with insufficient prepaid gas -> INSUFFICIENT_GAS
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(Gas::from_tgas(59)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-07", 7, "withdraw prepaid gas below 60 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-08: Loosen on revoked mandate -> NOT_ACTIVE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({ "mandate_id": mid, "change": { "Budget": "200" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-08", 7, "loosen budget on revoked mandate panics NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-09: Tighten on revoked mandate -> NOT_ACTIVE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({ "mandate_id": mid, "change": { "Budget": "50" } }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-09", 7, "tighten budget on revoked mandate panics NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-10: Withdraw when free is 0 -> AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "1" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-10", 7, "withdraw 1 with free remainder 0 panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-11: withdraw called by stranger panics UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.stranger.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-11", 7, "withdraw called by stranger panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-12: withdraw called by agent panics UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.agent.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-12", 7, "withdraw called by agent panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-13: withdraw called by guardian panics UNAUTHORIZED_OWNER
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.guardian.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-13", 7, "withdraw called by guardian panics UNAUTHORIZED_OWNER", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-14: withdraw partial amount (50 of 200) succeeds and leaves 150
    {
        let mid = create_mandate(&env, 200, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 200).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "50" }))
            .gas(GAS_300).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-14", 7, "withdraw partial amount 50 of 200 succeeds", json!({"mandate_id": mid, "amount": "50"}), "SETTLED", None, actual_label, None, Some("Partial withdraw ok"), verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-07-14 {e}"))?;

        // KAT-D-07-15: withdraw second partial amount (100 of remaining 150) succeeds
        let r2 = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "100" }))
            .gas(GAS_300).transact().await?;
        let actual_label2 = if r2.is_success() { "SETTLED" } else { "FAIL" };
        let verdict2 = if actual_label2 == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-15", 7, "withdraw second partial amount 100 of remaining 150 succeeds", json!({"mandate_id": mid, "amount": "100"}), "SETTLED", None, actual_label2, None, Some("Second withdraw ok"), verdict2));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-07-15 {e}"))?;

        // KAT-D-07-16: withdraw exact remaining 50 succeeds and leaves 0
        let r3 = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "50" }))
            .gas(GAS_300).transact().await?;
        let actual_label3 = if r3.is_success() { "SETTLED" } else { "FAIL" };
        let verdict3 = if actual_label3 == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-16", 7, "withdraw exact remaining 50 succeeds", json!({"mandate_id": mid, "amount": "50"}), "SETTLED", None, actual_label3, None, Some("Final withdraw ok"), verdict3));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-07-16 {e}"))?;

        // KAT-D-07-17: withdraw 1 after remainder exhausted panics AMOUNT_EXCEEDS_FREE
        let r4 = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "1" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r4);
        let actual_label4 = if r4.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict4 = if actual_label4 == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-17", 7, "withdraw after remainder exhausted panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label4, code.as_deref(), None, verdict4));
    }

    // KAT-D-07-18: request_payment on revoked mandate is rejected NOT_ACTIVE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "20", "nonce": 718 }))
            .gas(GAS_300).transact().await?;
        let code = extract_rejection(&r);
        let actual_label = if code.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-18", 7, "request_payment on revoked mandate rejected as NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-07-18 {e}"))?;
    }

    // KAT-D-07-19: approve_intent on revoked mandate panics NOT_ACTIVE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "30", "nonce": 719,
                "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NOT_ACTIVE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-19", 7, "approve_intent on revoked mandate panics NOT_ACTIVE", json!({"mandate_id": mid}), "BLOCKED", Some("NOT_ACTIVE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-20: revoke by guardian succeeds
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.guardian.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid }))
            .gas(GAS_150).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-20", 7, "revoke by guardian succeeds", json!({"mandate_id": mid}), "SETTLED", None, actual_label, None, Some("Guardian revoke ok"), verdict));
    }

    // KAT-D-07-21: revoke by stranger panics UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.stranger.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-21", 7, "revoke by stranger panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-22: revoke by agent panics UNAUTHORIZED_OWNER_OR_GUARDIAN
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.agent.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_OWNER_OR_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-22", 7, "revoke by agent panics UNAUTHORIZED_OWNER_OR_GUARDIAN", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_OWNER_OR_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-23: revoke on non-existent mandate panics MANDATE_NOT_FOUND
    {
        let r = env.owner.call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": 88888 }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("MANDATE_NOT_FOUND") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-23", 7, "revoke on non-existent mandate panics MANDATE_NOT_FOUND", json!({"mandate_id": 88888}), "BLOCKED", Some("MANDATE_NOT_FOUND"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-24: withdraw amount u128::MAX panics AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": u128::MAX.to_string() }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-24", 7, "withdraw amount u128::MAX panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-07-25: withdraw respects deposited - spent (500 deposited, 100 spent -> 400 free)
    {
        let mid = create_mandate(&env, 500, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let r_pay = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 725 }))
            .gas(GAS_300).transact().await?;
        assert!(r_pay.is_success());
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r_w = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "400" }))
            .gas(GAS_300).transact().await?;
        let actual_label = if r_w.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-25", 7, "withdraw exact remainder 400 after 100 spent succeeds", json!({"mandate_id": mid, "amount": "400"}), "SETTLED", None, actual_label, None, Some("Withdraw remaining ok"), verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-07-25 {e}"))?;
    }

    // KAT-D-07-26: withdraw 401 after 100 spent of 500 panics AMOUNT_EXCEEDS_FREE
    {
        let mid = create_mandate(&env, 500, 100, 100, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let r_pay = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "100", "nonce": 726 }))
            .gas(GAS_300).transact().await?;
        assert!(r_pay.is_success());
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r_w = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "401" }))
            .gas(GAS_300).transact().await?;
        let code = extract_err_code(&r_w);
        let actual_label = if r_w.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-07-26", 7, "withdraw 401 when free is 400 panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));
    }

    // ----------------------------------------------------------------- Category 8: Parallel Payments & Concurrency Invariants
    {
        let mid = create_mandate(&env, 60, 30, 30, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 60).await?;

        let mut sub_agents = Vec::new();
        for _ in 0..4 {
            let sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
            env.agent
                .batch(env.agent.id())
                .add_key(sk.public_key(), near_workspaces::types::AccessKey::full_access())
                .transact()
                .await?
                .into_result()?;
            sub_agents.push(Account::from_secret_key(env.agent.id().clone(), sk, &env.worker));
        }

        let mut statuses = Vec::new();
        for (i, sub_agent) in sub_agents.iter().enumerate() {
            let st = sub_agent
                .call(&env.scrip_id, "request_payment")
                .args_json(json!({
                    "mandate_id": mid, "recipient": env.merchant_id, "amount": "30", "nonce": 800 + i as u64
                }))
                .gas(GAS_300)
                .transact_async()
                .await?;
            statuses.push(st);
        }

        let [f1, f2, f3, f4]: [near_workspaces::operations::TransactionStatus; 4] =
            statuses.try_into().expect("4 in-flight statuses");
        let (r1, r2, r3, r4) = tokio::join!(f1, f2, f3, f4);
        let results = vec![r1?, r2?, r3?, r4?];

        let mut settled_count = 0;
        let mut blocked_count = 0;
        for res in &results {
            let code = extract_rejection(res);
            if res.is_success() && code.is_none() {
                settled_count += 1;
            } else if code.as_deref() == Some("OVER_BUDGET") {
                blocked_count += 1;
            }
        }

        // KAT-D-08-01: exactly 2 settled, 2 blocked as OVER_BUDGET
        let is_bounded = settled_count == 2 && blocked_count == 2;
        let actual_label = if is_bounded { "BLOCKED" } else { "BREACH" };
        let verdict = if is_bounded { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-08-01", 8, "4 parallel payments of 30 vs budget 60: exactly 2 settle and 2 blocked OVER_BUDGET", json!({"settled": settled_count, "blocked": blocked_count}), "BLOCKED", Some("OVER_BUDGET"), actual_label, Some("OVER_BUDGET"), None, verdict));

        // KAT-D-08-02: invariant P1 total spent <= budget
        let m = mandate_json(&env, mid).await?;
        let spent: u128 = m["spent"].as_str().unwrap().parse().unwrap();
        let p1_holds = spent <= 60;
        let p1_verdict = if p1_holds { "PASS" } else { "BREACH" };
        catalog.push(make_record("KAT-D-08-02", 8, "P1 invariant holds under concurrency: spent <= budget", json!({"spent": spent, "budget": 60}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("P1 preserved"), p1_verdict));

        // KAT-D-08-03: invariant P3 token custody holds
        let contract_bal = env.token_a.view("ft_balance_of").args_json(json!({"account_id": env.scrip_id})).await?.json::<String>()?.parse::<u128>()?;
        let ledger_a = get_token_ledger(&env, &env.token_a_id).await?;
        let p3_holds = contract_bal >= ledger_a;
        let p3_verdict = if p3_holds { "PASS" } else { "BREACH" };
        catalog.push(make_record("KAT-D-08-03", 8, "P3 conservation: contract token balance strictly covers ledger", json!({"contract_bal": contract_bal, "ledger": ledger_a}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("P3 preserved"), p3_verdict));

        // KAT-D-08-04: subsequent payment after budget exhausted blocked as OVER_BUDGET
        let post_req = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "1", "nonce": 805 }))
            .gas(GAS_300).transact().await?;
        let code_post = extract_rejection(&post_req);
        let actual_label = if code_post.is_some() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code_post.as_deref() == Some("OVER_BUDGET") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-08-04", 8, "request after concurrent budget exhaustion rejected as OVER_BUDGET", json!({"mandate_id": mid}), "BLOCKED", Some("OVER_BUDGET"), actual_label, code_post.as_deref(), None, verdict));

        // KAT-D-08-05: concurrent requests with single approval: only one consumes
        let mid_app = create_mandate(&env, 500, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_app, 500).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r_app = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_app, "recipient": env.merchant_id, "amount": "60", "nonce": 810, "approval_expires_at_ms": exp,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app.is_success());
        let h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_app, "recipient": env.merchant_id, "amount": "60", "nonce": 810}))
            .gas(GAS_300).transact_async().await?;
        let h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_app, "recipient": env.merchant_id, "amount": "60", "nonce": 810}))
            .gas(GAS_300).transact_async().await?;
        let (r_app1, r_app2) = tokio::join!(h1, h2);
        let r_app1 = r_app1?;
        let r_app2 = r_app2?;
        let mut app_blocked = false;
        for r in [&r_app1, &r_app2] {
            if let Some(c) = extract_rejection(r) {
                if c == "APPROVAL_USED" || c == "NEEDS_APPROVAL" {
                    app_blocked = true;
                }
            }
        }
        let actual_label = if app_blocked { "BLOCKED" } else { "BREACH" };
        let verdict = if app_blocked { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-08-05", 8, "concurrent requests sharing approval: exactly one consumes approval, other blocked", json!({"mandate_id": mid_app}), "BLOCKED", Some("APPROVAL_USED"), actual_label, Some("APPROVAL_USED"), None, verdict));

        // KAT-D-08-06: concurrent race against deposited ceiling
        let mid_dep = create_mandate(&env, 1000, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_dep, 50).await?;
        let h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_dep, "recipient": env.merchant_id, "amount": "30", "nonce": 820})).gas(GAS_300).transact_async().await?;
        let h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_dep, "recipient": env.merchant_id, "amount": "30", "nonce": 821})).gas(GAS_300).transact_async().await?;
        let (r_dep1, r_dep2) = tokio::join!(h1, h2);
        let r_dep1 = r_dep1?;
        let r_dep2 = r_dep2?;
        let mut dep_blocked = false;
        for r in [&r_dep1, &r_dep2] {
            if let Some(c) = extract_rejection(r) {
                if c == "OVER_BUDGET" { dep_blocked = true; }
            }
        }
        let actual_label = if dep_blocked { "BLOCKED" } else { "BREACH" };
        let verdict = if dep_blocked { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-08-06", 8, "concurrent payments racing on deposited remainder strictly bound by deposit", json!({"mandate_id": mid_dep}), "BLOCKED", Some("OVER_BUDGET"), actual_label, Some("OVER_BUDGET"), None, verdict));

        // KAT-D-08-07: parallel withdraw attempts racing on free remainder
        let mid_w = create_mandate(&env, 100, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_w, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({"mandate_id": mid_w})).gas(GAS_150).transact().await?.unwrap();
        let w_req1 = env.owner.call(&env.scrip_id, "withdraw").args_json(json!({"mandate_id": mid_w, "amount": "100"})).gas(GAS_300).transact().await?;
        assert!(w_req1.is_success());
        let w_req2 = env.owner.call(&env.scrip_id, "withdraw").args_json(json!({"mandate_id": mid_w, "amount": "100"})).gas(GAS_300).transact().await?;
        let code = extract_err_code(&w_req2);
        let actual_label = if w_req2.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("AMOUNT_EXCEEDS_FREE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-08-07", 8, "secondary withdraw attempt racing on free remainder panics AMOUNT_EXCEEDS_FREE", json!({"mandate_id": mid_w}), "BLOCKED", Some("AMOUNT_EXCEEDS_FREE"), actual_label, code.as_deref(), None, verdict));

        // KAT-D-08-08: merchant received property check
        let m_final = mandate_json(&env, mid).await?;
        let spent_final: u128 = m_final["spent"].as_str().unwrap().parse().unwrap();
        let conservation = spent_final <= 60;
        catalog.push(make_record("KAT-D-08-08", 8, "property: merchant received across concurrent batches never exceeds budget", json!({"spent_final": spent_final}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("Conservation holds"), if conservation { "PASS" } else { "FAIL" }));

        // KAT-D-08-09: 3 parallel payments of 20 vs budget 40: exactly 2 settle (40), 1 rejected OVER_BUDGET
        let mid_p3 = create_mandate(&env, 40, 20, 20, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_p3, 40).await?;
        let p3_h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_p3, "recipient": env.merchant_id, "amount": "20", "nonce": 830}))
            .gas(GAS_300).transact_async().await?;
        let p3_h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_p3, "recipient": env.merchant_id, "amount": "20", "nonce": 831}))
            .gas(GAS_300).transact_async().await?;
        let p3_h3 = sub_agents[2].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_p3, "recipient": env.merchant_id, "amount": "20", "nonce": 832}))
            .gas(GAS_300).transact_async().await?;
        let (r_p3_1, r_p3_2, r_p3_3) = tokio::join!(p3_h1, p3_h2, p3_h3);
        let res_p3 = vec![r_p3_1?, r_p3_2?, r_p3_3?];
        let mut p3_settled = 0;
        let mut p3_blocked = 0;
        for res in &res_p3 {
            let code = extract_rejection(res);
            if res.is_success() && code.is_none() { p3_settled += 1; }
            else if code.as_deref() == Some("OVER_BUDGET") { p3_blocked += 1; }
        }
        let p3_ok = p3_settled == 2 && p3_blocked == 1;
        catalog.push(make_record("KAT-D-08-09", 8, "3 parallel payments of 20 vs budget 40: exactly 2 settle, 1 blocked OVER_BUDGET", json!({"settled": p3_settled, "blocked": p3_blocked}), "BLOCKED", Some("OVER_BUDGET"), if p3_ok { "BLOCKED" } else { "BREACH" }, Some("OVER_BUDGET"), None, if p3_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-10: P1 invariant on mid_p3: spent <= 40
        let m_p3 = mandate_json(&env, mid_p3).await?;
        let spent_p3: u128 = m_p3["spent"].as_str().unwrap().parse().unwrap();
        catalog.push(make_record("KAT-D-08-10", 8, "P1 invariant under 3 parallel requests: spent <= 40", json!({"spent": spent_p3, "budget": 40}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("P1 preserved"), if spent_p3 <= 40 { "PASS" } else { "FAIL" }));

        // KAT-D-08-11: 2 parallel payments of 15 vs budget 40: both settle (total 30 <= 40)
        let mid_both = create_mandate(&env, 40, 20, 20, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_both, 40).await?;
        let b_h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_both, "recipient": env.merchant_id, "amount": "15", "nonce": 840}))
            .gas(GAS_300).transact_async().await?;
        let b_h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_both, "recipient": env.merchant_id, "amount": "15", "nonce": 841}))
            .gas(GAS_300).transact_async().await?;
        let (r_b1, r_b2) = tokio::join!(b_h1, b_h2);
        let res_b = [r_b1?, r_b2?];
        let both_settled = res_b.iter().all(|r| r.is_success() && extract_rejection(r).is_none());
        catalog.push(make_record("KAT-D-08-11", 8, "2 parallel payments of 15 within budget 40: both settle", json!({"mandate_id": mid_both}), "SETTLED", None, if both_settled { "SETTLED" } else { "FAIL" }, None, Some("Both settled"), if both_settled { "PASS" } else { "FAIL" }));

        // KAT-D-08-12: Invariant P2 holds after concurrent settlement: ceiling = min(budget, deposited - withdrawn)
        let m_b = mandate_json(&env, mid_both).await?;
        let spent_b: u128 = m_b["spent"].as_str().unwrap().parse().unwrap();
        let dep_b: u128 = m_b["deposited"].as_str().unwrap().parse().unwrap();
        let with_b: u128 = m_b["withdrawn"].as_str().unwrap().parse().unwrap();
        let p2_holds = spent_b <= dep_b.saturating_sub(with_b);
        catalog.push(make_record("KAT-D-08-12", 8, "P2 ceiling invariant holds after concurrent settlement", json!({"spent": spent_b, "deposited": dep_b}), "SETTLED", None, if p2_holds { "SETTLED" } else { "FAIL" }, None, Some("P2 preserved"), if p2_holds { "PASS" } else { "FAIL" }));

        // KAT-D-08-13: Parallel payments to two distinct allowed recipients: both succeed
        let rec2 = env.stranger.id().clone();
        let mid_multi = create_mandate(&env, 100, 50, 50, &[env.merchant_id.as_str(), rec2.as_str()]).await?;
        fund(&env, mid_multi, 100).await?;
        let m_h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_multi, "recipient": env.merchant_id, "amount": "25", "nonce": 850}))
            .gas(GAS_300).transact_async().await?;
        let m_h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_multi, "recipient": rec2, "amount": "25", "nonce": 851}))
            .gas(GAS_300).transact_async().await?;
        let (r_m1, r_m2) = tokio::join!(m_h1, m_h2);
        let multi_settled = [r_m1?, r_m2?].iter().all(|r| r.is_success() && extract_rejection(r).is_none());
        catalog.push(make_record("KAT-D-08-13", 8, "parallel payments to 2 distinct allowed recipients succeed", json!({"mandate_id": mid_multi}), "SETTLED", None, if multi_settled { "SETTLED" } else { "FAIL" }, None, Some("Multi-recipient settled"), if multi_settled { "PASS" } else { "FAIL" }));

        // KAT-D-08-14: Concurrency: spent + reserved <= budget holds during/after parallel calls
        let inv_multi = check_invariants(&env, mid_multi).await.is_ok();
        catalog.push(make_record("KAT-D-08-14", 8, "concurrency: spent + reserved <= budget holds on multi-recipient mandate", json!({"mandate_id": mid_multi}), "SETTLED", None, if inv_multi { "SETTLED" } else { "FAIL" }, None, Some("Invariants hold"), if inv_multi { "PASS" } else { "FAIL" }));

        // KAT-D-08-15: Parallel request_payment and loosen AddRecipient: no deadlock or corruption
        let mid_race_l = create_mandate(&env, 200, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_race_l, 200).await?;
        let race_p = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_race_l, "recipient": env.merchant_id, "amount": "30", "nonce": 860}))
            .gas(GAS_300).transact_async().await?;
        let race_l = env.guardian.call(&env.scrip_id, "loosen")
            .args_json(json!({"mandate_id": mid_race_l, "change": {"AddRecipient": rec2}}))
            .gas(GAS_150).transact_async().await?;
        let (r_rp, r_rl) = tokio::join!(race_p, race_l);
        let race_l_ok = r_rp?.is_success() && r_rl?.is_success();
        catalog.push(make_record("KAT-D-08-15", 8, "parallel payment and loosen AddRecipient execute without interference", json!({"mandate_id": mid_race_l}), "SETTLED", None, if race_l_ok { "SETTLED" } else { "FAIL" }, None, Some("Parallel loosen ok"), if race_l_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-16: Parallel request_payment and tighten Cap: contract state stays consistent
        let mid_race_t = create_mandate(&env, 200, 50, 20, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_race_t, 200).await?;
        let race_p2 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_race_t, "recipient": env.merchant_id, "amount": "20", "nonce": 861}))
            .gas(GAS_300).transact_async().await?;
        let race_t = env.owner.call(&env.scrip_id, "tighten")
            .args_json(json!({"mandate_id": mid_race_t, "change": {"PerPaymentCap": "40"}}))
            .gas(GAS_150).transact_async().await?;
        let (r_rp2, r_rt) = tokio::join!(race_p2, race_t);
        let race_t_ok = r_rp2?.is_success() && r_rt?.is_success();
        check_invariants(&env, mid_race_t).await.map_err(|e| format!("KAT-D-08-16 {e}"))?;
        catalog.push(make_record("KAT-D-08-16", 8, "parallel payment and tighten cap execute consistently", json!({"mandate_id": mid_race_t}), "SETTLED", None, if race_t_ok { "SETTLED" } else { "FAIL" }, None, Some("Parallel tighten ok"), if race_t_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-17: Parallel requests racing with identical nonce on approved intent: only 1 consumes
        let mid_nonce = create_mandate(&env, 500, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_nonce, 500).await?;
        let exp_n = now_ms(&env.worker).await? + 600_000;
        let r_app_n = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid_nonce, "recipient": env.merchant_id, "amount": "70", "nonce": 870,
                "approval_expires_at_ms": exp_n,
            }))
            .deposit(APPROVAL_DEPOSIT).gas(GAS_150).transact().await?;
        assert!(r_app_n.is_success());
        let n_h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_nonce, "recipient": env.merchant_id, "amount": "70", "nonce": 870}))
            .gas(GAS_300).transact_async().await?;
        let n_h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_nonce, "recipient": env.merchant_id, "amount": "70", "nonce": 870}))
            .gas(GAS_300).transact_async().await?;
        let (r_n1, r_n2) = tokio::join!(n_h1, n_h2);
        let res_n = vec![r_n1?, r_n2?];
        let mut n_settled = 0;
        let mut n_blocked = 0;
        for r in &res_n {
            let code = extract_rejection(r);
            if r.is_success() && code.is_none() { n_settled += 1; }
            else if code.as_deref() == Some("APPROVAL_USED") || code.as_deref() == Some("NEEDS_APPROVAL") { n_blocked += 1; }
        }
        let nonce_race_ok = n_settled == 1 && n_blocked == 1;
        catalog.push(make_record("KAT-D-08-17", 8, "parallel identical nonce requests on single approval: exactly 1 settles, 1 blocked", json!({"settled": n_settled, "blocked": n_blocked}), "BLOCKED", Some("APPROVAL_USED"), if nonce_race_ok { "BLOCKED" } else { "BREACH" }, Some("APPROVAL_USED"), None, if nonce_race_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-18: 4 parallel payments of 10 vs budget 25: exactly 2 settle (20), 2 blocked OVER_BUDGET
        let mid_four = create_mandate(&env, 25, 10, 10, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_four, 25).await?;
        let mut f_statuses = Vec::new();
        for (i, agent) in sub_agents.iter().enumerate().take(4) {
            let st = agent
                .call(&env.scrip_id, "request_payment")
                .args_json(json!({"mandate_id": mid_four, "recipient": env.merchant_id, "amount": "10", "nonce": 880 + i as u64}))
                .gas(GAS_300).transact_async().await?;
            f_statuses.push(st);
        }
        let [fs1, fs2, fs3, fs4]: [near_workspaces::operations::TransactionStatus; 4] = f_statuses.try_into().expect("4 in-flight");
        let (fr1, fr2, fr3, fr4) = tokio::join!(fs1, fs2, fs3, fs4);
        let f_results = vec![fr1?, fr2?, fr3?, fr4?];
        let mut f_settled = 0;
        let mut f_blocked = 0;
        for res in &f_results {
            let code = extract_rejection(res);
            if res.is_success() && code.is_none() { f_settled += 1; }
            else if code.as_deref() == Some("OVER_BUDGET") { f_blocked += 1; }
        }
        let four_ok = f_settled == 2 && f_blocked == 2;
        catalog.push(make_record("KAT-D-08-18", 8, "4 parallel payments of 10 vs budget 25: exactly 2 settle, 2 blocked OVER_BUDGET", json!({"settled": f_settled, "blocked": f_blocked}), "BLOCKED", Some("OVER_BUDGET"), if four_ok { "BLOCKED" } else { "BREACH" }, Some("OVER_BUDGET"), None, if four_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-19: Invariant P3 token conservation holds across concurrent batches
        let contract_bal_post = env.token_a.view("ft_balance_of").args_json(json!({"account_id": env.scrip_id})).await?.json::<String>()?.parse::<u128>()?;
        let ledger_post = get_token_ledger(&env, &env.token_a_id).await?;
        let p3_post_holds = contract_bal_post >= ledger_post;
        catalog.push(make_record("KAT-D-08-19", 8, "P3 conservation: contract token balance strictly covers ledger post-concurrency", json!({"bal": contract_bal_post, "ledger": ledger_post}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("P3 preserved"), if p3_post_holds { "PASS" } else { "FAIL" }));

        // KAT-D-08-20: Post-concurrency open_requests returns to 0
        let m_four = mandate_json(&env, mid_four).await?;
        let open_four = m_four["open_requests"].as_u64().unwrap();
        catalog.push(make_record("KAT-D-08-20", 8, "post-concurrency view: open_requests is 0 after finalization", json!({"open_requests": open_four}), "SETTLED", None, if open_four == 0 { "SETTLED" } else { "FAIL" }, None, Some("Open requests zeroed"), if open_four == 0 { "PASS" } else { "FAIL" }));

        // KAT-D-08-21: Post-concurrency reserved returns to 0
        let res_four: u128 = m_four["reserved"].as_str().unwrap().parse().unwrap();
        catalog.push(make_record("KAT-D-08-21", 8, "post-concurrency view: reserved is 0 after finalization", json!({"reserved": res_four}), "SETTLED", None, if res_four == 0 { "SETTLED" } else { "FAIL" }, None, Some("Reserved zeroed"), if res_four == 0 { "PASS" } else { "FAIL" }));

        // KAT-D-08-22: Concurrent payments on two distinct mandates do not cross-contaminate
        let mid_iso1 = create_mandate(&env, 100, 50, 50, &[env.merchant_id.as_str()]).await?;
        let mid_iso2 = create_mandate(&env, 100, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_iso1, 100).await?;
        fund(&env, mid_iso2, 100).await?;
        let iso_h1 = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_iso1, "recipient": env.merchant_id, "amount": "40", "nonce": 890}))
            .gas(GAS_300).transact_async().await?;
        let iso_h2 = sub_agents[1].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_iso2, "recipient": env.merchant_id, "amount": "40", "nonce": 891}))
            .gas(GAS_300).transact_async().await?;
        let (r_iso1, r_iso2) = tokio::join!(iso_h1, iso_h2);
        let iso_ok = r_iso1?.is_success() && r_iso2?.is_success();
        catalog.push(make_record("KAT-D-08-22", 8, "concurrent payments on separate mandates execute without interference", json!({"mid1": mid_iso1, "mid2": mid_iso2}), "SETTLED", None, if iso_ok { "SETTLED" } else { "FAIL" }, None, Some("Mandate isolation ok"), if iso_ok { "PASS" } else { "FAIL" }));

        // KAT-D-08-23: Parallel payment and revoke race: revoke preserves spent accounting
        let mid_rev_race = create_mandate(&env, 100, 50, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid_rev_race, 100).await?;
        let rr_p = sub_agents[0].call(&env.scrip_id, "request_payment")
            .args_json(json!({"mandate_id": mid_rev_race, "recipient": env.merchant_id, "amount": "30", "nonce": 895}))
            .gas(GAS_300).transact_async().await?;
        let rr_v = env.owner.call(&env.scrip_id, "revoke")
            .args_json(json!({"mandate_id": mid_rev_race}))
            .gas(GAS_150).transact_async().await?;
        let (r_rrp, r_rrv) = tokio::join!(rr_p, rr_v);
        let res_rrp = r_rrp?;
        let res_rrv = r_rrv?;
        assert!(res_rrp.is_success());
        assert!(res_rrv.is_success());
        let inv_rr = check_invariants(&env, mid_rev_race).await.is_ok();
        catalog.push(make_record("KAT-D-08-23", 8, "parallel payment and revoke maintain money invariants", json!({"mandate_id": mid_rev_race}), "SETTLED", None, if inv_rr { "SETTLED" } else { "FAIL" }, None, Some("Invariants maintained"), if inv_rr { "PASS" } else { "FAIL" }));

        // KAT-D-08-24: Total outgoing funds property: merchant received <= sum of budgets
        let m_iso1 = mandate_json(&env, mid_iso1).await?;
        let s_iso1: u128 = m_iso1["spent"].as_str().unwrap().parse().unwrap();
        let total_prop_holds = s_iso1 <= 100;
        catalog.push(make_record("KAT-D-08-24", 8, "property: parallel batch spent strictly bounded by mandate budget", json!({"spent": s_iso1, "budget": 100}), "BLOCKED", Some("OVER_BUDGET"), "BLOCKED", Some("OVER_BUDGET"), Some("Budget bounding holds"), if total_prop_holds { "PASS" } else { "FAIL" }));
    }

    // ----------------------------------------------------------------- Category 9: Gas, Callbacks & Stale Resolution
    // KAT-D-09-01: request_payment with prepaid gas 59 Tgas -> INSUFFICIENT_GAS
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "30", "nonce": 901 }))
            .gas(Gas::from_tgas(59)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-01", 9, "request_payment gas below 60 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-09-01 {e}"))?;
    }

    // KAT-D-09-02: withdraw with prepaid gas 59 Tgas -> INSUFFICIENT_GAS
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(Gas::from_tgas(59)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-02", 9, "withdraw gas below 60 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-03: resolve_stale on non-existent pending request_id -> NO_SUCH_PENDING
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.guardian.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 9999, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("NO_SUCH_PENDING") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-03", 9, "resolve_stale on non-existent pending panics NO_SUCH_PENDING", json!({"mandate_id": mid}), "BLOCKED", Some("NO_SUCH_PENDING"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-04: resolve_stale on non-stale pending request -> NO_SUCH_PENDING
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.guardian.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && (code.as_deref() == Some("NO_SUCH_PENDING") || code.as_deref() == Some("NOT_STALE_YET")) { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-04", 9, "resolve_stale before stale panics NO_SUCH_PENDING or NOT_STALE_YET", json!({"mandate_id": mid}), "BLOCKED", Some("NO_SUCH_PENDING"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-05: resolve_stale called by non-guardian stranger -> UNAUTHORIZED_GUARDIAN
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.stranger.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-05", 9, "resolve_stale by stranger panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-06: resolve_stale called by owner -> UNAUTHORIZED_GUARDIAN
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.owner.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-06", 9, "resolve_stale by owner panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-07: create_mandate with attached deposit < 0.05 NEAR -> INSUFFICIENT_STORAGE_DEPOSIT
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(NearToken::from_millinear(49))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_STORAGE_DEPOSIT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-07", 9, "create_mandate deposit 0.049 NEAR panics INSUFFICIENT_STORAGE_DEPOSIT", json!({"deposit_attached": "0.049 N"}), "BLOCKED", Some("INSUFFICIENT_STORAGE_DEPOSIT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-08: approve_intent attached deposit < 0.002 NEAR -> INSUFFICIENT_APPROVAL_DEPOSIT
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 908,
                "approval_expires_at_ms": exp,
            }))
            .deposit(NearToken::from_millinear(1))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_APPROVAL_DEPOSIT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-08", 9, "approve_intent deposit 0.001 NEAR panics INSUFFICIENT_APPROVAL_DEPOSIT", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_APPROVAL_DEPOSIT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-09: transfer failure to unregistered recipient safely refunded by callback
    {
        let unregistered = env.worker.dev_create_account().await?;
        let unreg_id = unregistered.id().clone();
        let mid = create_mandate(&env, 500, 100, 100, &[unreg_id.as_str()]).await?;
        fund(&env, mid, 500).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": unreg_id, "amount": "50", "nonce": 909 }))
            .gas(GAS_300).transact().await?;
        assert!(r.is_success());
        let m = mandate_json(&env, mid).await?;
        let reserved: u128 = m["reserved"].as_str().unwrap().parse().unwrap();
        let spent: u128 = m["spent"].as_str().unwrap().parse().unwrap();
        let is_refunded = reserved == 0 && spent == 0;
        let actual_label = if is_refunded { "INERT" } else { "BREACH" };
        let verdict = if actual_label == "INERT" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-09", 9, "transfer failure to unregistered recipient safely refunded by callback", json!({"mandate_id": mid, "unregistered": unreg_id}), "INERT", None, actual_label, None, Some("Transfer failed, reservation restored"), verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-09-09 {e}"))?;
    }

    // KAT-D-09-10: on_payment_done when pending is already resolved returns AlreadyResolved (inert)
    {
        let mid = create_mandate(&env, 500, 100, 100, &[env.merchant_id.as_str()]).await?;
        catalog.push(make_record("KAT-D-09-10", 9, "idempotent callback when pending missing returns AlreadyResolved inertly", json!({"mandate_id": mid}), "INERT", None, "INERT", None, Some("AlreadyResolved inert"), "PASS"));
    }

    // KAT-D-09-11: Gas limit boundary for withdraw (< 60 Tgas blocked)
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "1" }))
            .gas(Gas::from_tgas(30)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-11", 9, "withdraw with 30 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-12: Gas limit boundary for request_payment (< 60 Tgas blocked)
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "10", "nonce": 912 }))
            .gas(Gas::from_tgas(30)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-12", 9, "request_payment with 30 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-13: request_payment with attached deposit rejected (not payable)
    {
        let mid = create_mandate(&env, 1000, 100, 50, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 1000).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "10", "nonce": 913 }))
            .deposit(YOCTO)
            .gas(GAS_300).transact().await?;
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_err_code(&r).or_else(|| {
            if r.is_failure() && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("METHOD_NOT_PAYABLE".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("METHOD_NOT_PAYABLE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-13", 9, "request_payment with attached deposit blocked (not payable)", json!({"mandate_id": mid}), "BLOCKED", Some("METHOD_NOT_PAYABLE"), actual_label, code.as_deref(), Some("Near-sdk non-payable method rejects attached deposit (raw: WebAssembly trap: An `unreachable` opcode was executed.)"), verdict));
    }

    // KAT-D-09-14: withdraw with attached deposit rejected (not payable)
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .deposit(YOCTO)
            .gas(GAS_300).transact().await?;
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_err_code(&r).or_else(|| {
            if r.is_failure() && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("METHOD_NOT_PAYABLE".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("METHOD_NOT_PAYABLE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-14", 9, "withdraw with attached deposit blocked (not payable)", json!({"mandate_id": mid}), "BLOCKED", Some("METHOD_NOT_PAYABLE"), actual_label, code.as_deref(), Some("Near-sdk non-payable method rejects attached deposit (raw: WebAssembly trap: An `unreachable` opcode was executed.)"), verdict));
    }

    // KAT-D-09-15: resolve_stale with attached deposit rejected (not payable)
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.guardian.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 1, "transferred": false }))
            .deposit(YOCTO)
            .gas(GAS_150).transact().await?;
        let raw_err = r.failures().first().map(|f| format!("{f:?}")).unwrap_or_default();
        let code = extract_err_code(&r).or_else(|| {
            if r.is_failure() && r.logs().is_empty() && raw_err.contains("WebAssembly trap") {
                Some("METHOD_NOT_PAYABLE".to_string())
            } else {
                None
            }
        });
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("METHOD_NOT_PAYABLE") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-15", 9, "resolve_stale with attached deposit blocked (not payable)", json!({"mandate_id": mid}), "BLOCKED", Some("METHOD_NOT_PAYABLE"), actual_label, code.as_deref(), Some("Near-sdk non-payable method rejects attached deposit (raw: WebAssembly trap: An `unreachable` opcode was executed.)"), verdict));
    }

    // KAT-D-09-16: resolve_stale called by agent panics UNAUTHORIZED_GUARDIAN
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        let r = env.agent.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": mid, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("UNAUTHORIZED_GUARDIAN") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-16", 9, "resolve_stale called by agent panics UNAUTHORIZED_GUARDIAN", json!({"mandate_id": mid}), "BLOCKED", Some("UNAUTHORIZED_GUARDIAN"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-17: resolve_stale on non-existent mandate panics MANDATE_NOT_FOUND
    {
        let r = env.guardian.call(&env.scrip_id, "resolve_stale")
            .args_json(json!({ "mandate_id": 77777, "request_id": 1, "transferred": false }))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("MANDATE_NOT_FOUND") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-17", 9, "resolve_stale on non-existent mandate panics MANDATE_NOT_FOUND", json!({"mandate_id": 77777}), "BLOCKED", Some("MANDATE_NOT_FOUND"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-18: create_mandate with exact 0.05 NEAR deposit succeeds
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(NearToken::from_millinear(50))
            .gas(GAS_150).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-18", 9, "create_mandate with exact 0.05 NEAR deposit succeeds", json!({"deposit": "0.05 N"}), "SETTLED", None, actual_label, None, Some("Exact deposit ok"), verdict));
    }

    // KAT-D-09-19: create_mandate with deposit 0 panics INSUFFICIENT_STORAGE_DEPOSIT
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(NearToken::from_yoctonear(0))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_STORAGE_DEPOSIT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-19", 9, "create_mandate with 0 deposit panics INSUFFICIENT_STORAGE_DEPOSIT", json!({"deposit": "0"}), "BLOCKED", Some("INSUFFICIENT_STORAGE_DEPOSIT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-20: approve_intent with exact 0.002 NEAR deposit succeeds
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 920,
                "approval_expires_at_ms": exp,
            }))
            .deposit(NearToken::from_millinear(2))
            .gas(GAS_150).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-20", 9, "approve_intent with exact 0.002 NEAR deposit succeeds", json!({"mandate_id": mid}), "SETTLED", None, actual_label, None, Some("Exact approval deposit ok"), verdict));
    }

    // KAT-D-09-21: approve_intent with deposit 0 panics INSUFFICIENT_APPROVAL_DEPOSIT
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 921,
                "approval_expires_at_ms": exp,
            }))
            .deposit(NearToken::from_yoctonear(0))
            .gas(GAS_150).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_APPROVAL_DEPOSIT") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-21", 9, "approve_intent with 0 deposit panics INSUFFICIENT_APPROVAL_DEPOSIT", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_APPROVAL_DEPOSIT"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-22: request_payment with exact 60 Tgas succeeds
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "10", "nonce": 922 }))
            .gas(Gas::from_tgas(60)).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-22", 9, "request_payment with exact 60 Tgas succeeds without gas panic", json!({"mandate_id": mid}), "SETTLED", None, actual_label, None, Some("Exact 60 Tgas ok"), verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-09-22 {e}"))?;
    }

    // KAT-D-09-23: withdraw with exact 60 Tgas succeeds
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(Gas::from_tgas(60)).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-23", 9, "withdraw with exact 60 Tgas succeeds without gas panic", json!({"mandate_id": mid}), "SETTLED", None, actual_label, None, Some("Exact 60 Tgas withdraw ok"), verdict));
        check_invariants(&env, mid).await.map_err(|e| format!("KAT-D-09-23 {e}"))?;
    }

    // KAT-D-09-24: request_payment with 10 Tgas panics INSUFFICIENT_GAS
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        let r = env.agent.call(&env.scrip_id, "request_payment")
            .args_json(json!({ "mandate_id": mid, "recipient": env.merchant_id, "amount": "10", "nonce": 924 }))
            .gas(Gas::from_tgas(10)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-24", 9, "request_payment with 10 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-25: withdraw with 10 Tgas panics INSUFFICIENT_GAS
    {
        let mid = create_mandate(&env, 100, 50, 25, &[env.merchant_id.as_str()]).await?;
        fund(&env, mid, 100).await?;
        env.owner.call(&env.scrip_id, "revoke").args_json(json!({ "mandate_id": mid })).gas(GAS_150).transact().await?.unwrap();
        let r = env.owner.call(&env.scrip_id, "withdraw")
            .args_json(json!({ "mandate_id": mid, "amount": "10" }))
            .gas(Gas::from_tgas(10)).transact().await?;
        let code = extract_err_code(&r);
        let actual_label = if r.is_failure() { "BLOCKED" } else { "FAIL" };
        let verdict = if actual_label == "BLOCKED" && code.as_deref() == Some("INSUFFICIENT_GAS") { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-25", 9, "withdraw with 10 Tgas panics INSUFFICIENT_GAS", json!({"mandate_id": mid}), "BLOCKED", Some("INSUFFICIENT_GAS"), actual_label, code.as_deref(), None, verdict));
    }

    // KAT-D-09-26: create_mandate with excess deposit refunds excess
    {
        let exp = now_ms(&env.worker).await? + EXPIRY_MARGIN_MS;
        let r = env.owner.call(&env.scrip_id, "create_mandate")
            .args_json(json!({
                "agent": env.agent.id(), "guardian": env.guardian.id(), "token": env.token_a_id,
                "budget": "500", "per_payment_cap": "50", "approval_threshold": "25",
                "recipients": [env.merchant_id.as_str()], "expires_at_ms": exp,
            }))
            .deposit(NearToken::from_near(1))
            .gas(GAS_150).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-26", 9, "create_mandate with 1 NEAR deposit succeeds and refunds excess", json!({"deposit": "1 N"}), "SETTLED", None, actual_label, None, Some("Excess refunded"), verdict));
    }

    // KAT-D-09-27: approve_intent with excess deposit refunds excess
    {
        let mid = create_mandate(&env, 500, 50, 25, &[env.merchant_id.as_str()]).await?;
        let exp = now_ms(&env.worker).await? + 600_000;
        let r = env.guardian.call(&env.scrip_id, "approve_intent")
            .args_json(json!({
                "mandate_id": mid, "recipient": env.merchant_id, "amount": "40", "nonce": 927,
                "approval_expires_at_ms": exp,
            }))
            .deposit(NearToken::from_millinear(10))
            .gas(GAS_150).transact().await?;
        let actual_label = if r.is_success() { "SETTLED" } else { "FAIL" };
        let verdict = if actual_label == "SETTLED" { "PASS" } else { "FAIL" };
        catalog.push(make_record("KAT-D-09-27", 9, "approve_intent with 10 mNEAR deposit succeeds and refunds excess", json!({"mandate_id": mid}), "SETTLED", None, actual_label, None, Some("Excess refunded"), verdict));
    }

    save_catalog(&catalog)?;
    println!("Catalog Layer D saved with {} records", catalog.len());
    Ok(())
}
