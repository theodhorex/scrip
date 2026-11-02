//! K3: integration tests of the REAL scrip.wasm in the near-workspaces sandbox,
//! against the tests/ft_mock NEP-141 test double (token only, never Scrip).
//!
//! Run (Makefile target `contract-it`, needs network for the sandbox binary):
//!   cd contracts/scrip && cargo test --test integration -- --test-threads=1
//!
//! Wasm inputs (built by the same target before the tests):
//!   target/wasm32-unknown-unknown/release/scrip.wasm
//!   tests/ft_mock/target/wasm32-unknown-unknown/release/ft_mock.wasm
#![allow(dead_code)]

use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const SCRIP_WASM: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/target/wasm32-unknown-unknown/release/scrip.wasm");
const FT_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/ft_mock/target/wasm32-unknown-unknown/release/ft_mock.wasm"
);

/// Well above MIN_PREPAID_GAS (60 Tg) so the whole request_payment receipt chain fits.
const GAS_300: Gas = Gas::from_tgas(300);
const GAS_150: Gas = Gas::from_tgas(150);
const YOCTO: NearToken = NearToken::from_yoctonear(1);

const DEPOSIT: u128 = 10_000; // token units deposited to the mandate
const BUDGET: u128 = 1_000;
const CAP: u128 = 100;
const THRESHOLD: u128 = 50; // amounts above this need a guardian approval
const CREATION_DEPOSIT: NearToken = NearToken::from_near(1); // >= 0.05 NEAR required

/// Mandate expiry margin relative to creation time (1 h of chain-time).
const EXPIRY_MARGIN_MS: u64 = 3_600_000;

// ---------------------------------------------------------------- Env / setup

struct Env {
    worker: Worker<Sandbox>,
    scrip: Contract,
    scrip_id: AccountId,
    token: Contract,
    token_id: AccountId,
    owner: Account,
    guardian: Account,
    agent: Account,
    stranger: Account,
    #[allow(dead_code)]
    merchant: Account,
    merchant_id: AccountId,
}

fn wasm(path: &str) -> Vec<u8> {
    std::fs::read(path)
        .unwrap_or_else(|e| panic!("read {path}: {e} (build it first: make contract-it)"))
}

async fn now_ms(worker: &Worker<Sandbox>) -> Result<u64, Box<dyn std::error::Error>> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

async fn setup() -> Result<Env, Box<dyn std::error::Error>> {
    let worker: Worker<Sandbox> = near_workspaces::sandbox().await?;
    let token: Contract = worker.dev_deploy(&wasm(FT_WASM)).await?;
    token.call("new").args_json(json!({})).gas(GAS_150).transact().await?.unwrap();
    let scrip: Contract = worker.dev_deploy(&wasm(SCRIP_WASM)).await?;
    scrip.call("new").args_json(json!({})).gas(GAS_150).transact().await?.unwrap();
    let owner = worker.dev_create_account().await?;
    let guardian = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    let merchant = worker.dev_create_account().await?;
    let scrip_id = scrip.as_account().id().clone();
    let token_id = token.as_account().id().clone();
    // The receiver (scrip) must itself be registered with the token to receive deposits.
    owner
        .call(&token_id, "storage_deposit")
        .args_json(json!({ "account_id": scrip_id }))
        .deposit(YOCTO)
        .gas(GAS_150)
        .transact()
        .await?
        .unwrap();
    Ok(Env {
        scrip_id,
        token_id,
        merchant_id: merchant.id().clone(),
        worker,
        scrip,
        token,
        owner,
        guardian,
        agent,
        stranger,
        merchant,
    })
}

/// Receipt-level guard: the tx-level final status is `SuccessValue` even when a
/// mid-chain receipt panicked (only the LAST receipt's return value shows up), so
/// every helper that must not swallow a failed receipt asserts on `failures()`.
trait ReceiptGuard {
    fn must_have_no_failed_receipts(&self);
}
impl ReceiptGuard for near_workspaces::result::ExecutionFinalResult {
    fn must_have_no_failed_receipts(&self) {
        let failures: Vec<String> = self.failures().iter().map(|f| format!("{f:?}")).collect();
        assert!(
            failures.is_empty(),
            "unexpected failed receipt(s): {failures:?}\nlogs: {:?}",
            self.logs()
        );
    }
}

/// Registers `who` with the mock FT so it can receive ft_transfer (no balance credited).
async fn ft_register(env: &Env, who: &str) -> Result<(), Box<dyn std::error::Error>> {
    env.owner
        .call(&env.token_id, "storage_deposit")
        .args_json(json!({ "account_id": who }))
        .deposit(YOCTO)
        .gas(GAS_150)
        .transact()
        .await?
        .must_have_no_failed_receipts();
    Ok(())
}

/// Mint `amount` test tokens to `who` (ft_mint also registers the account with the FT).
async fn ft_mint(env: &Env, who: &str, amount: u128) -> Result<(), Box<dyn std::error::Error>> {
    env.owner
        .call(&env.token_id, "ft_mint")
        .args_json(json!({ "account_id": who, "amount": amount.to_string() }))
        .gas(GAS_150)
        .transact()
        .await?
        .unwrap();
    Ok(())
}

// ------------------------------------------------------------------ actions

/// Owner creates a mandate over the mock token. Returns the mandate id.
async fn create_mandate(
    env: &Env,
    budget: u128,
    cap: u128,
    threshold: u128,
    recipients: &[&str],
) -> Result<(u64, near_workspaces::result::ExecutionFinalResult), Box<dyn std::error::Error>> {
    create_mandate_with_expiry(env, budget, cap, threshold, recipients, EXPIRY_MARGIN_MS).await
}

async fn create_mandate_with_expiry(
    env: &Env,
    budget: u128,
    cap: u128,
    threshold: u128,
    recipients: &[&str],
    expiry_margin_ms: u64,
) -> Result<(u64, near_workspaces::result::ExecutionFinalResult), Box<dyn std::error::Error>> {
    let expiry = now_ms(&env.worker).await? + expiry_margin_ms;
    let r = env
        .owner
        .call(&env.scrip_id, "create_mandate")
        .args_json(json!({
            "agent": env.agent.id(),
            "guardian": env.guardian.id(),
            "token": env.token_id,
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
    r.must_have_no_failed_receipts();
    let created_ev = find_event(&r, "mandate_created").expect("mandate_created event");
    let id = created_ev["data"][0]["mandate_id"].as_u64().expect("mandate_id");
    Ok((id, r))
}

/// Owner funds mandate `id` with `amount` through a REAL cross-contract ft_transfer_call.
async fn fund(
    env: &Env,
    id: u64,
    amount: u128,
) -> Result<near_workspaces::result::ExecutionFinalResult, Box<dyn std::error::Error>> {
    ft_mint(env, env.owner.id().as_str(), amount).await?;
    let st = env
        .owner
        .call(&env.token_id, "ft_transfer_call")
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
    assert!(st.is_success(), "fund failed: {st:?}");
    Ok(st)
}

/// Agent sends request_payment. Returns the full execution result (policy rejections
/// arrive as `Rejected{code}` JSON; the promise chain's receipt failures via `failures()`).
async fn request(
    env: &Env,
    id: u64,
    recipient: &str,
    amount: u128,
    nonce: u64,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error>> {
    Ok(env
        .agent
        .call(&env.scrip_id, "request_payment")
        .args_json(json!({
            "mandate_id": id,
            "recipient": recipient,
            "amount": amount.to_string(),
            "nonce": nonce,
        }))
        .gas(GAS_300)
        .transact()
        .await?)
}

// ------------------------------------------------------------------ views

async fn mandate_json(env: &Env, id: u64) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(env
        .scrip
        .view("get_mandate")
        .args_json(json!({ "id": id }))
        .await?
        .json::<Value>()
        .expect("mandate exists"))
}

fn u128_field(v: &Value, key: &str) -> u128 {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} not a U128 string: {v:?}"))
        .parse()
        .expect("decimal u128")
}

async fn balance_of(env: &Env, account: &str) -> Result<u128, Box<dyn std::error::Error>> {
    let v = env
        .token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account }))
        .await?
        .json::<String>()?;
    Ok(v.parse().unwrap())
}

/// True while the Pending entry for `(id, request_id)` still exists.
async fn pending_exists(env: &Env, id: u64, request_id: u64) -> Result<bool, Box<dyn std::error::Error>> {
    let v = env
        .scrip
        .view("get_pending")
        .args_json(json!({ "id": id, "request_id": request_id }))
        .await?
        .json::<Value>()?;
    Ok(!v.is_null())
}

/// PRD 5.3 invariants, called after every step of every scenario.
async fn check_invariants(env: &Env, id: u64) -> Result<(), Box<dyn std::error::Error>> {
    let m = mandate_json(env, id).await?;
    let (deposited, budget, spent, reserved, withdrawn, open_requests) = (
        u128_field(&m, "deposited"),
        u128_field(&m, "budget"),
        u128_field(&m, "spent"),
        u128_field(&m, "reserved"),
        u128_field(&m, "withdrawn"),
        m["open_requests"].as_u64().expect("open"),
    );
    let next_request_id = m["next_request_id"].as_u64().expect("nrid");
    assert!(
        spent + reserved <= budget.min(deposited),
        "inv 1 (spent+reserved<=min(budget,deposited), the K1 reading of budget<=deposited) failed: {m}"
    );

    // free = deposited - spent - reserved - withdrawn >= 0, and the token contract
    // really holds spent-kept custody: contract balance == deposited - spent - withdrawn.
    let committed = spent + reserved + withdrawn;
    assert!(
        deposited >= committed,
        "inv 3 (conservation, free={}) failed: deposited={deposited} committed={committed}",
        deposited - committed
    );
    let contract_tokens = balance_of(env, env.scrip_id.as_str()).await?;
    assert_eq!(contract_tokens, deposited - spent - withdrawn,
        "inv 3 (token custody) failed: contract holds {contract_tokens}");

    // inv 7: open_requests == number of existing Pending entries.
    let mut pending = 0u64;
    for rid in 1..next_request_id {
        if pending_exists(env, id, rid).await? {
            pending += 1;
        }
    }
    assert_eq!(pending, open_requests, "inv 7 (pending count) failed: mandate {m}");
    Ok(())
}

// --------------------------------------------------------------- events

/// Parse every `EVENT_JSON:{...}` log the execution produced (tx + all receipts).
fn events(r: &ExecutionFinalResult) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect()
}

fn find_event(r: &ExecutionFinalResult, name: &str) -> Option<Value> {
    events(r).into_iter().find(|e| e["event"] == name)
}

// --------------------------------------------------------------- results

use near_workspaces::result::ExecutionFinalResult;

/// Assert a successful call returned a policy rejection with `code`.
fn assert_rejected(r: ExecutionFinalResult, code: &str) {
    assert!(r.is_success(), "policy rejection must not fail the tx: {r:?}");
    let v = r.json::<Value>().expect("json");
    let obj = v.as_object().expect("externally tagged result");
    assert_eq!((obj.len(), obj.contains_key("Rejected")), (1, true), "not a Rejected result: {v}");
    assert_eq!(
        obj["Rejected"]["code"].as_str().unwrap_or_default(),
        code,
        "wrong code in {v}"
    );
}

/// Assert the tx failed with the contract's panic `code`.
/// Reads `SCRIP_ERR:<code>` from execution receipt logs or surfaces failure message.
fn assert_err_code(r: &ExecutionFinalResult, code: &str) {
    assert!(r.is_failure(), "expected a panic/failure with `{code}`, but call succeeded");
    let target = format!("SCRIP_ERR:{code}");
    let found_log = r.logs().iter().any(|l| l.contains(&target));
    let found_failure = r.failures().iter().any(|f| {
        let text = format!("{f:?}");
        text.contains(code)
    });
    assert!(
        found_log || found_failure,
        "panic `{code}` not visible in logs (target `{target}`, logs: {:?}) nor failures ({:?})",
        r.logs(),
        r.failures()
    );
}

fn assert_panics(r: ExecutionFinalResult, code: &str) {
    assert_err_code(&r, code);
}

// ---------------------------------------------------------------- F1/F2

/// F1 create + fund via ft_transfer_call; F2 request_payment request->merchant.
#[tokio::test(flavor = "current_thread")]
async fn f1_f2_full_flow_merchant_paid_and_invariants() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    ft_register(&env, env.merchant_id.as_str()).await?;
    let (mid, created) = create_mandate(&env, BUDGET, CAP, THRESHOLD, &[env.merchant_id.as_str()]).await?;
    let created_ev = find_event(&created, "mandate_created").expect("mandate_created event");
    assert_eq!(created_ev["data"][0]["mandate_id"].as_u64(), Some(mid));
    check_invariants(&env, mid).await?;
    let funded = fund(&env, mid, DEPOSIT).await?;
    let deposited_ev = find_event(&funded, "deposited").expect("deposited event");
    assert_eq!(deposited_ev["data"][0]["amount"].as_str().unwrap(), DEPOSIT.to_string());
    check_invariants(&env, mid).await?;
    assert_eq!(balance_of(&env, env.scrip_id.as_str()).await?, DEPOSIT);

    let amt: u128 = 30; // below THR = 50: no approval needed
    let r = request(&env, mid, env.merchant_id.as_str(), amt, 1).await?;
    assert!(
        r.is_success(),
        "accepted request's whole receipt chain (transfer+callback) must succeed: {r:?}"
    );
    check_invariants(&env, mid).await?;

    let m = mandate_json(&env, mid).await?;
    assert_eq!(u128_field(&m, "spent"), amt, "spent up");
    assert_eq!(u128_field(&m, "reserved"), 0, "callback released reserved");
    assert_eq!(u128_field(&m, "deposited"), DEPOSIT);
    assert_eq!(m["open_requests"].as_u64(), Some(0));
    assert_eq!(m["next_request_id"].as_u64(), Some(2)); // one request consumed id 1

    // Real on-chain balances: merchant up, owner down, contract custody unchanged net.
    assert_eq!(balance_of(&env, env.merchant_id.as_str()).await?, amt, "merchant balance up");
    assert_eq!(balance_of(&env, env.scrip_id.as_str()).await?, DEPOSIT - amt);
    assert_eq!(balance_of(&env, env.owner.id().as_str()).await?, 0);

    // The request result carries the per-request lifecycle events.
    for name in ["reserved", "settled"] {
        let e = find_event(&r, name).unwrap_or_else(|| panic!("{name} event missing"));
        assert_eq!(e["data"][0]["mandate_id"].as_u64(), Some(mid));
        assert_eq!(e["data"][0]["amount"].as_str().and_then(|s| s.parse::<u128>().ok()).unwrap(), amt);
        assert_eq!(e["data"][0]["recipient"].as_str(), Some(env.merchant_id.as_str()));
    }
    assert_eq!(find_event(&r, "reserved").unwrap()["data"][0]["request_id"].as_u64(), Some(1));
    assert_eq!(find_event(&r, "settled").unwrap()["data"][0]["request_id"].as_u64(), Some(1));
    assert!(find_event(&r, "rejected").is_none());
    check_invariants(&env, mid).await?;
    Ok(())
}

// ------------------------------------------------- F3/F4 rejection matrix
/// Helper for F3/F4: mandate with custom rules; registered merchant; funded.
/// `threshold == cap` means no approval is ever needed.
async fn scenario_mandate(
    env: &Env,
    budget: u128,
    cap: u128,
    threshold: u128,
    extra_recipients: &[&str],
    expiry_margin_ms: u64,
) -> Result<u64, Box<dyn std::error::Error>> {
    ft_register(env, env.merchant_id.as_str()).await?;
    ft_register(env, env.stranger.id().as_str()).await?;
    let mut recs: Vec<&str> = vec![env.merchant_id.as_str()];
    recs.extend(extra_recipients.iter().copied());
    let (mid, _) =
        create_mandate_with_expiry(env, budget, cap, threshold, &recs, expiry_margin_ms).await?;
    fund(env, mid, budget * 2).await?.must_have_no_failed_receipts();
    Ok(mid)
}

#[tokio::test(flavor = "current_thread")]
async fn f3_recipient_not_allowed() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let r = request(&env, mid, env.stranger.id().as_str(), 30, 1).await?;
    assert_rejected(r, "RECIPIENT_NOT_ALLOWED");
    check_invariants(&env, mid).await?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn f3_cap_plus_one_rejected_cap_passes() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    // threshold == cap (100): no approval needed at any legal amount
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let r = request(&env, mid, env.merchant_id.as_str(), CAP + 1, 1).await?;
    assert_rejected(r, "OVER_PER_PAYMENT_CAP");
    check_invariants(&env, mid).await?;
    let r = request(&env, mid, env.merchant_id.as_str(), CAP, 1).await?;
    assert!(r.is_success(), "cap amount must be accepted: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "spent"), CAP);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn f4_over_budget_exact_remaining_passes_plus_one_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    // budget 130, cap 100: 100 settles, 29 passes (exact remaining), 30 -> OVER_BUDGET
    let mid = scenario_mandate(&env, 130, 100, 100, &[], EXPIRY_MARGIN_MS).await?;
    let r = request(&env, mid, env.merchant_id.as_str(), 100, 1).await?;
    assert!(r.is_success(), "first payment of 100 must settle: {r:?}");
    check_invariants(&env, mid).await?;
    let r = request(&env, mid, env.merchant_id.as_str(), 29, 2).await?;
    assert!(r.is_success(), "exact remaining 29 must settle: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "spent"), 129);
    let r = request(&env, mid, env.merchant_id.as_str(), 30, 3).await?;
    assert_rejected(r, "OVER_BUDGET");
    check_invariants(&env, mid).await?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn f4_expired_mandate_rejects() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    // Tiny expiry margin, then fast-forward past it.
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], 1_000).await?;
    env.worker.fast_forward(100).await?;
    let now = now_ms(&env.worker).await?;
    let m = mandate_json(&env, mid).await?;
    // show the sandbox time really passed expiry
    assert!(now >= m["expires_at_ms"].as_u64().unwrap(), "fast_forward must pass expiry");
    let r = request(&env, mid, env.merchant_id.as_str(), 30, 1).await?;
    assert_rejected(r, "EXPIRED");
    check_invariants(&env, mid).await?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn f4_revoked_mandate_rejects() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    env.owner.call(&env.scrip_id, "revoke").args_json(json!({"mandate_id": mid})).gas(GAS_150)
        .transact().await?.must_have_no_failed_receipts();
    let r = request(&env, mid, env.merchant_id.as_str(), 30, 1).await?;
    assert_rejected(r, "NOT_ACTIVE");
    check_invariants(&env, mid).await?;
    Ok(())
}

/// Guardian approves an intent for `(id, recipient, amount, nonce)`; expiry = now + margin.
async fn approve(
    env: &Env,
    id: u64,
    recipient: &str,
    amount: u128,
    nonce: u64,
    margin_ms: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let expiry = now_ms(&env.worker).await? + margin_ms;
    env.guardian
        .call(&env.scrip_id, "approve_intent")
        .args_json(json!({
            "mandate_id": id,
            "recipient": recipient,
            "amount": amount.to_string(),
            "nonce": nonce,
            "approval_expires_at_ms": expiry,
        }))
        .deposit(NearToken::from_millinear(2))
        .gas(GAS_150)
        .transact()
        .await?
        .must_have_no_failed_receipts();
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn f4_approval_needed_used_and_expired() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    // threshold 50; amount 60 > 50 requires approval
    let mid = scenario_mandate(&env, BUDGET, CAP, 50, &[], EXPIRY_MARGIN_MS).await?;
    let m = env.merchant_id.as_str().to_string();
    // no approval -> NEEDS_APPROVAL
    let r = request(&env, mid, &m, 60, 1).await?;
    assert_rejected(r, "NEEDS_APPROVAL");
    check_invariants(&env, mid).await?;
    // approved -> settles
    approve(&env, mid, &m, 60, 1, 1_000_000).await?;
    let r = request(&env, mid, &m, 60, 1).await?;
    assert!(r.is_success(), "approved request must settle: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "spent"), 60);
    // same approval again -> APPROVAL_USED (approval consumed exactly once)
    let r = request(&env, mid, &m, 60, 1).await?;
    assert_rejected(r, "APPROVAL_USED");
    check_invariants(&env, mid).await?;
    // a fresh approval to be CURRENTLY valid; fast-forward makes it expired
    approve(&env, mid, &m, 61, 2, 1_000).await?;
    env.worker.fast_forward(100).await?;
    let r = request(&env, mid, &m, 61, 2).await?;
    assert_rejected(r, "APPROVAL_EXPIRED");
    check_invariants(&env, mid).await?;
    Ok(())
}

// ------------------------------------------------- sandbox time diagnostics
/// Sanity harness: measures how fast_forward advances chain time. Kept as a named
/// test so the expiry tests' assumptions are proven on this machine, not assumed.
#[tokio::test(flavor = "current_thread")]
async fn sandbox_time_fast_forward_advances_chain_time() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let t0 = now_ms(&env.worker).await?;
    env.worker.fast_forward(500).await?;
    let t1 = now_ms(&env.worker).await?;
    let ms_per_block = (t1.saturating_sub(t0)) as f64 / 500.0;
    println!("sandbox time: t0={t0} t1={t1} ms/block≈{ms_per_block}");
    assert!(t1 > t0, "fast_forward must advance chain timestamps");
    Ok(())
}


// ---------------------------------------------------------------- F6 refund

#[tokio::test(flavor = "current_thread")]
async fn f6_unregistered_receiver_transfers_fail_and_callback_refunds() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    // Deliberately DO NOT register the merchant with the FT: in `strict` mode the mock
    // panics on ft_transfer to unregistered receivers, like a real NEP-141.
    let (mid, _) = create_mandate(&env, BUDGET, CAP, CAP, &[env.merchant_id.as_str()]).await?;
    check_invariants(&env, mid).await?;
    fund(&env, mid, DEPOSIT).await?.must_have_no_failed_receipts();
    check_invariants(&env, mid).await?;
    let amt = 30;
    let r = request(&env, mid, env.merchant_id.as_str(), amt, 1).await?;
    // The tx as a whole must succeed and the callback must report a refund.
    assert!(r.is_success(), "whole chain must end in a handled refund: {r:?}");
    let v = r.clone().json::<Value>()?;
    assert_eq!(v["Refunded"]["request_id"].as_u64(), Some(1), "expected Refunded: {v}");
    let refunded = find_event(&r, "refunded").expect("refunded event");
    assert_eq!(refunded["data"][0]["mandate_id"].as_u64(), Some(mid));
    check_invariants(&env, mid).await?;
    // reserved returned, merchant got nothing, custody fully back at the mandate.
    let m = mandate_json(&env, mid).await?;
    assert_eq!(u128_field(&m, "reserved"), 0);
    assert_eq!(m["open_requests"].as_u64(), Some(0));
    assert_eq!(u128_field(&m, "spent"), 0);
    assert_eq!(balance_of(&env, env.merchant_id.as_str()).await?, 0);
    assert_eq!(balance_of(&env, env.scrip_id.as_str()).await?, DEPOSIT);
    Ok(())
}

// ---------------------------------------------------------------- Mode B gas

/// Mode B (callback out of gas) cannot be simulated end to end: the contract pins
/// static callback gas with unused-gas weight 0, so an `ft_transfer` receipt cannot
/// burn the callback's gas. The defense the contract provides is the < 60 Tgas
/// INSUFFICIENT_GAS guard, asserted below. An FT mock that never answers its callback
/// cannot create a stale Pending without mocking Scrip itself (the callback is
/// chained on the transfer by the CONTRACT, and the mock's ft_transfer resolves
/// normally), so `resolve_stale` stays covered by the K2 unit tests. No contract
/// hack was invented for this; full reasoning in IT_REPORT.md.
#[tokio::test(flavor = "current_thread")]
async fn mode_b_request_with_prepaid_gas_below_60_tgas_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let paused = mandate_json(&env, mid).await?; // state before the rejected call
    let r = env
        .agent
        .call(&env.scrip_id, "request_payment")
        .args_json(json!({
            "mandate_id": mid,
            "recipient": env.merchant_id.as_str(),
            "amount": "30",
            "nonce": 1,
        }))
        .gas(Gas::from_tgas(59)) // one TGas below the floor
        .transact()
        .await?;
    // INSUFFICIENT_GAS is checked via assert_err_code reading SCRIP_ERR:INSUFFICIENT_GAS
    assert_err_code(&r, "INSUFFICIENT_GAS");
    let m = mandate_json(&env, mid).await?;
    assert_eq!(m, paused, "state must be untouched by the INSUFFICIENT_GAS guard");
    check_invariants(&env, mid).await?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn mode_b_exactly_60_tgas_accepted() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let r = env
        .agent
        .call(&env.scrip_id, "request_payment")
        .args_json(json!({
            "mandate_id": mid,
            "recipient": env.merchant_id.as_str(),
            "amount": "30",
            "nonce": 1,
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    // At the floor the call must not panic (it settles or refunds cleanly).
    assert!(r.is_success(), "60 Tgas must not panic: {r:?}");
    check_invariants(&env, mid).await?;
    Ok(())
}

// ---------------------------------------------------------------- F7 roles

#[tokio::test(flavor = "current_thread")]
async fn f7_guardian_only_methods_reject_agent_stranger_owner() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, 50, &[], EXPIRY_MARGIN_MS).await?;
    let loosened = json!({"Budget": (BUDGET * 2).to_string()});    for caller in [&env.agent, &env.stranger, &env.owner] {
        let r = caller
            .call(&env.scrip_id, "loosen")
            .args_json(json!({"mandate_id": mid, "change": loosened}))
            .gas(GAS_150)
            .transact()
            .await?;
        assert_panics(r, "UNAUTHORIZED_GUARDIAN");
        check_invariants(&env, mid).await?;
    }
    // guardian loosening works
    let r = env
        .guardian
        .call(&env.scrip_id, "loosen")
        .args_json(json!({"mandate_id": mid, "change": loosened}))
        .gas(GAS_150)
        .transact()
        .await?;
    assert!(r.is_success(), "guardian may loosen: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "budget"), BUDGET * 2);

    // tighten: agent and stranger denied (owner or guardian allowed)
    let tightened = json!({"Budget": BUDGET.to_string()});
    for caller in [&env.agent, &env.stranger] {
        let r = caller
            .call(&env.scrip_id, "tighten")
            .args_json(json!({"mandate_id": mid, "change": tightened}))
            .gas(GAS_150)
            .transact()
            .await?;
        assert_panics(r, "UNAUTHORIZED_OWNER_OR_GUARDIAN");
        check_invariants(&env, mid).await?;
    }
    let r = env
        .owner
        .call(&env.scrip_id, "tighten")
        .args_json(json!({"mandate_id": mid, "change": tightened}))
        .gas(GAS_150)
        .transact()
        .await?;
    assert!(r.is_success(), "owner may tighten: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "budget"), BUDGET);
    Ok(())
}

// ---------------------------------------------------------------- F8 approvals

/// F8: the intent hash binds (mandate_id, recipient, amount, nonce, mandate expiry).
/// Any mismatch is NEEDS_APPROVAL; a reused approval is APPROVAL_USED even for a
/// different amount (the hash differs, but the (used) entry for the exact tuple stays).
#[tokio::test(flavor = "current_thread")]
async fn f8_hash_mismatch_and_replay() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let stranger = env.stranger.id().as_str().to_string();
    let mid = scenario_mandate(&env, BUDGET, CAP, 50, &[stranger.as_str()], EXPIRY_MARGIN_MS).await?;
    let m = env.merchant_id.as_str().to_string();
    // approved exactly for (merchant, 60, nonce 7)
    approve(&env, mid, &m, 60, 7, 1_000_000).await?;
    // different amount, same nonce -> different hash -> NEEDS_APPROVAL
    let r = request(&env, mid, &m, 61, 7).await?;
    assert_rejected(r, "NEEDS_APPROVAL");
    check_invariants(&env, mid).await?;
    // different recipient, same nonce -> different hash -> NEEDS_APPROVAL (stranger is registered)
    let r = request(&env, mid, env.stranger.id().as_str(), 60, 7).await?;
    assert_rejected(r, "NEEDS_APPROVAL");
    check_invariants(&env, mid).await?;
    // exact tuple -> settles
    let r = request(&env, mid, &m, 60, 7).await?;
    assert!(r.is_success(), "approved exact tuple must settle: {r:?}");
    check_invariants(&env, mid).await?;
    assert_eq!(u128_field(&mandate_json(&env, mid).await?, "spent"), 60);
    // replay of the used approval for the exact tuple -> APPROVAL_USED
    let r = request(&env, mid, &m, 60, 7).await?;
    assert_rejected(r, "APPROVAL_USED");
    check_invariants(&env, mid).await?;
    Ok(())
}

/// F8 expiry variant + security case: after the guardian APPROVES, the owner TIGHTENS
/// the mandate expiry. The stored hash binds the mandate's OLD expiry, so the approval
/// stops matching: the request fails safe with NEEDS_APPROVAL (no replay window).
#[tokio::test(flavor = "current_thread")]
async fn f8_tightening_expiry_invalidates_stored_approval() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, 50, &[], EXPIRY_MARGIN_MS).await?;
    let m = env.merchant_id.as_str().to_string();
    approve(&env, mid, &m, 60, 9, 1_000_000).await?;
    let expiry = now_ms(&env.worker).await? + 1_800_000;
    let r = env
        .owner
        .call(&env.scrip_id, "tighten")
        .args_json(json!({ "mandate_id": mid, "change": { "Expiry": expiry } }))
        .gas(GAS_150)
        .transact()
        .await?;
    assert!(r.is_success(), "owner tightens expiry: {r:?}");
    let r = request(&env, mid, &m, 60, 9).await?;
    assert_rejected(r, "NEEDS_APPROVAL");
    check_invariants(&env, mid).await?;
    Ok(())
}

// ---------------------------------------------------------------- F11 exit path

#[tokio::test(flavor = "current_thread")]
async fn f11_withdraw_before_revocation_fails_then_free_remainder_only() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    ft_register(&env, env.owner.id().as_str()).await?; // owner must be able to RECEIVE
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let owner = env.owner.id().as_str().to_string();

    // withdraw while Active -> MANDATE_STILL_ACTIVE
    let r = env
        .owner
        .call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": "1" }))
        .gas(GAS_300)
        .transact()
        .await?;
    assert_panics(r, "MANDATE_STILL_ACTIVE");
    check_invariants(&env, mid).await?;

    // spend 100 settled, then revoke; funded 2 x budget = 2000, free = 2000 - 100 = 1900
    let r = request(&env, mid, env.merchant_id.as_str(), 100, 1).await?;
    assert!(r.is_success(), "payment must settle: {r:?}");
    check_invariants(&env, mid).await?;
    let r = env
        .owner
        .call(&env.scrip_id, "revoke")
        .args_json(json!({ "mandate_id": mid }))
        .gas(GAS_150)
        .transact()
        .await?;
    r.must_have_no_failed_receipts();
    check_invariants(&env, mid).await?;

    // one more than free -> AMOUNT_EXCEEDS_FREE
    let r = env
        .owner
        .call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": (1_901u128).to_string() }))
        .gas(GAS_300)
        .transact()
        .await?;
    assert_panics(r, "AMOUNT_EXCEEDS_FREE");
    check_invariants(&env, mid).await?;

    // exactly the free remainder succeeds; owner's balance rises by it
    let r = env
        .owner
        .call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": (1_900u128).to_string() }))
        .gas(GAS_300)
        .transact()
        .await?;
    assert!(r.is_success(), "withdraw of the free remainder must settle: logs={:?}", r.logs());
    check_invariants(&env, mid).await?;
    let e = find_event(&r, "withdrawn").expect("withdrawn event");
    assert_eq!(e["data"][0]["amount"].as_str().unwrap(), "1900");
    assert_eq!(balance_of(&env, &owner).await?, 1_900);
    // conservation: deposited == spent + withdrawn, contract keeps nothing
    let m = mandate_json(&env, mid).await?;
    assert_eq!(u128_field(&m, "spent") + u128_field(&m, "withdrawn"), u128_field(&m, "deposited"));
    assert_eq!(u128_field(&m, "reserved"), 0);
    assert_eq!(balance_of(&env, env.scrip_id.as_str()).await?, 0);
    // a second withdraw of anything fails (nothing free left)
    let r = env
        .owner
        .call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": "1" }))
        .gas(GAS_300)
        .transact()
        .await?;
    assert_panics(r, "AMOUNT_EXCEEDS_FREE");
    check_invariants(&env, mid).await?;

    // attacker minded: the AGENT cannot withdraw even the free remainder
    let r = env
        .agent
        .call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": "1" }))
        .gas(GAS_300)
        .transact()
        .await?;
    assert_panics(r, "UNAUTHORIZED_OWNER");
    check_invariants(&env, mid).await?;
    Ok(())
}

// ------------------------------------------------------------- concurrency (F5)

/// F5: 20 request_payment calls are submitted without waiting for each other against a
/// budget that allows exactly 5 (cap 100, budget 500). Reserve-before-transfer must stop
/// the total at the budget. One access key per tx (a single key serializes its own txs).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn f5_twenty_parallel_requests_never_exceed_budget() -> Result<(), Box<dyn std::error::Error>> {
    // Task: budget that allows exactly 5 (cap 100 x 5 = 500) under 20 parallel calls.
    const CONCURRENCY_BUDGET: u128 = 500;
    let env = setup().await?;
    let mid = scenario_mandate(&env, CONCURRENCY_BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let merchant = env.merchant_id.as_str().to_string();
    let before = balance_of(&env, &merchant).await?;

    // One access key per concurrent tx: a single key cannot send 20 at once (nonce clash).
    // All keys belong to the same agent account, so the contract still sees one agent.
    let mut agents = Vec::new();
    for _ in 0..20 {
        let sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        env.agent
            .batch(env.agent.id())
            .add_key(sk.public_key(), near_workspaces::types::AccessKey::full_access())
            .transact()
            .await?
            .into_result()?;
        agents.push(Account::from_secret_key(env.agent.id().clone(), sk, &env.worker));
    }
    // 20 `transact_async` in flight at once: build all handles by SENDING each
    // request (no waiting for its receipts), then wait for all of them together
    // with tokio::join! on the 20 handles.
    let mut statuses: Vec<near_workspaces::operations::TransactionStatus> = Vec::new();
    for (n, agent) in agents.iter().enumerate() {
        let n = n as u64;
        let st = agent
            .call(&env.scrip_id, "request_payment")
            .args_json(json!({
                "mandate_id": mid,
                "recipient": merchant,
                "amount": CAP.to_string(),
                "nonce": n,
            }))
            .gas(GAS_300)
            .transact_async() // submit + return immediately, do not await receipts
            .await?;
        statuses.push(st);
    }
    let mut per_tx: Vec<String> = Vec::new();
    // join all 20 concurrently, exactly as the task prescribes.
    let [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20]:
        [near_workspaces::operations::TransactionStatus; 20] =
        statuses.try_into().expect("exactly 20 in-flight statuses");
    let (r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16, r17, r18, r19, r20) =
        tokio::join!(f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20);
    let results = vec![r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16, r17, r18, r19, r20];
    let (mut accepted, mut over_budget, mut other) = (0u32, 0u32, 0u32);
    for r in results.into_iter() {
        let r = r?;
        match r.json::<Value>() {
            Ok(v) if v.get("Rejected").is_some() => {
                if v["Rejected"]["code"] == "OVER_BUDGET" {
                    over_budget += 1;
                } else {
                    other += 1;
                }
                per_tx.push(format!("{v}"));
            }
            Ok(_) => {
                per_tx.push("settled".to_string());
                accepted += 1
            }
            Err(_) => other += 1,
        }
    }
    println!("f5: accepted={accepted} over_budget={over_budget} other={other}");
    println!("f5 PER-TX: {per_tx:?}");

    let m = mandate_json(&env, mid).await?;
    let paid = balance_of(&env, &merchant).await? - before;
    println!("f5: spent={} reserved={} open={} merchant_paid={paid}",
        u128_field(&m, "spent"), u128_field(&m, "reserved"), m["open_requests"]);
    assert!(u128_field(&m, "spent") <= CONCURRENCY_BUDGET, "spent exceeded budget: {m}");
    assert!(paid <= CONCURRENCY_BUDGET, "merchant received more than the budget: {paid}");
    assert_eq!(u128_field(&m, "reserved"), 0, "reservations left open: {m}");
    assert_eq!(m["open_requests"], 0);
    assert_eq!(accepted + over_budget + other, 20, "every call must be accounted for");
    assert_eq!(other, 0, "unexpected outcomes");
    assert_eq!(paid, accepted as u128 * CAP);
    assert_eq!(accepted as u128 * CAP, CONCURRENCY_BUDGET, "exactly the budget is spendable");
    check_invariants(&env, mid).await?;
    Ok(())
}

/// 40-way mixed race (T-B): 25 request_payment vs 5 tighten vs 5 revoke vs 5 withdraw.
/// All 40 submitted in parallel with dedicated access keys and joined concurrently.
/// Preserves money invariants and state consistency.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn f5_forty_parallel_mixed_race() -> Result<(), Box<dyn std::error::Error>> {
    const MIXED_BUDGET: u128 = 1_000;
    const MIXED_DEPOSIT: u128 = 3_000;
    let env = setup().await?;
    ft_register(&env, env.owner.id().as_str()).await?;
    let mid = scenario_mandate(&env, MIXED_BUDGET, CAP, CAP, &[], EXPIRY_MARGIN_MS).await?;
    let _ = fund(&env, mid, MIXED_DEPOSIT).await?;
    let merchant = env.merchant_id.as_str().to_string();

    // 25 access keys for agent (requests)
    let mut agent_keys = Vec::new();
    for _ in 0..25 {
        let sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        env.agent
            .batch(env.agent.id())
            .add_key(sk.public_key(), near_workspaces::types::AccessKey::full_access())
            .transact()
            .await?
            .into_result()?;
        agent_keys.push(Account::from_secret_key(env.agent.id().clone(), sk, &env.worker));
    }

    // 15 access keys for owner (tighten, revoke, withdraw)
    let mut owner_keys = Vec::new();
    for _ in 0..15 {
        let sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        env.owner
            .batch(env.owner.id())
            .add_key(sk.public_key(), near_workspaces::types::AccessKey::full_access())
            .transact()
            .await?
            .into_result()?;
        owner_keys.push(Account::from_secret_key(env.owner.id().clone(), sk, &env.worker));
    }

    // Build 40 async in-flight calls:
    let mut statuses: Vec<near_workspaces::operations::TransactionStatus> = Vec::new();

    // 1. 25 parallel request_payment
    for (n, caller) in agent_keys.iter().enumerate() {
        let st = caller
            .call(&env.scrip_id, "request_payment")
            .args_json(json!({
                "mandate_id": mid,
                "recipient": merchant,
                "amount": CAP.to_string(),
                "nonce": n as u64,
            }))
            .gas(GAS_300)
            .transact_async()
            .await?;
        statuses.push(st);
    }

    // 2. 5 parallel tighten (lowering budget safely)
    for (n, caller) in owner_keys[0..5].iter().enumerate() {
        let new_budget = 950 - (n as u128 * 10);
        let st = caller
            .call(&env.scrip_id, "tighten")
            .args_json(json!({
                "mandate_id": mid,
                "change": { "Budget": new_budget.to_string() },
            }))
            .gas(GAS_300)
            .transact_async()
            .await?;
        statuses.push(st);
    }

    // 3. 5 parallel revoke
    for caller in &owner_keys[5..10] {
        let st = caller
            .call(&env.scrip_id, "revoke")
            .args_json(json!({ "mandate_id": mid }))
            .gas(GAS_300)
            .transact_async()
            .await?;
        statuses.push(st);
    }

    // 4. 5 parallel withdraw (after revoke or racing with it)
    for caller in &owner_keys[10..15] {
        let st = caller
            .call(&env.scrip_id, "withdraw")
            .args_json(json!({
                "mandate_id": mid,
                "amount": "100",
            }))
            .gas(GAS_300)
            .transact_async()
            .await?;
        statuses.push(st);
    }

    assert_eq!(statuses.len(), 40, "exactly 40 in-flight calls");

    // Join all 40 concurrently on the current task
    let [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9,
         s10, s11, s12, s13, s14, s15, s16, s17, s18, s19,
         s20, s21, s22, s23, s24, s25, s26, s27, s28, s29,
         s30, s31, s32, s33, s34, s35, s36, s37, s38, s39]:
        [near_workspaces::operations::TransactionStatus; 40] =
        statuses.try_into().expect("exactly 40 in-flight statuses");
    let _outcomes = tokio::join!(
        s0, s1, s2, s3, s4, s5, s6, s7, s8, s9,
        s10, s11, s12, s13, s14, s15, s16, s17, s18, s19,
        s20, s21, s22, s23, s24, s25, s26, s27, s28, s29,
        s30, s31, s32, s33, s34, s35, s36, s37, s38, s39,
    );

    // State invariants must hold after the mixed race
    check_invariants(&env, mid).await?;
    let m = mandate_json(&env, mid).await?;
    let spent = u128_field(&m, "spent");
    let reserved = u128_field(&m, "reserved");
    let withdrawn = u128_field(&m, "withdrawn");
    let deposited = u128_field(&m, "deposited");
    assert!(spent <= MIXED_BUDGET, "spent {spent} exceeded budget {MIXED_BUDGET}");
    assert!(spent + reserved + withdrawn <= deposited, "conservation failed: {m}");
    Ok(())
}

// ------------------------------------------------------- random sequences (F13 min)

/// Tiny seeded xorshift so the run is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Random mixed calls from mixed callers; the invariants must hold after every call.
/// Biased towards VALID calls (right caller, amounts under the threshold) so the run reaches deep
/// states: many settled payments, tightened/loosened rules, revoke and withdraw.
#[tokio::test(flavor = "current_thread")]
async fn random_call_sequences_keep_invariants() -> Result<(), Box<dyn std::error::Error>> {
    const SEED: u64 = 0x5EED_A11A_2026;
    const STEPS: u32 = 300;
    let env = setup().await?;
    ft_register(&env, env.owner.id().as_str()).await?;
    let stranger = env.stranger.id().as_str().to_string();
    let mid = scenario_mandate(&env, 5_000, CAP, 50, &[stranger.as_str()], EXPIRY_MARGIN_MS).await?;
    let merchant = env.merchant_id.as_str().to_string();
    let mut rng = Rng(SEED);
    let (mut ok_calls, mut failed_calls) = (0u32, 0u32);
    let mut by_method: std::collections::BTreeMap<&str, (u32, u32)> = Default::default();
    for step in 0..STEPS {
        // after step 100 the owner revokes and then tries to withdraw random amounts
        let phase_exit = step >= 100;
        let roll = rng.below(100);
        let (caller, method, args, deposit): (&Account, &str, Value, u128) = if phase_exit && step == 100 {
            (&env.owner, "revoke", json!({"mandate_id": mid}), 0)
        } else if phase_exit && roll < 60 {
            let who = if rng.below(5) == 0 { &env.stranger } else { &env.owner };
            (who, "withdraw", json!({"mandate_id": mid, "amount": (1 + rng.below(900) as u128).to_string()}), 0)
        } else if roll < 55 {
            let amount = if rng.below(10) < 8 { 1 + rng.below(50) as u128 } else { 1 + rng.below(130) as u128 };
            let recipient = if rng.below(6) == 0 { stranger.clone() } else { merchant.clone() };
            let caller = if rng.below(12) == 0 { &env.stranger } else { &env.agent };
            (caller, "request_payment", json!({"mandate_id": mid, "recipient": recipient,
                "amount": amount.to_string(), "nonce": rng.below(6)}), 0)
        } else if roll < 65 {
            let amount = 51 + rng.below(80) as u128;
            (&env.guardian, "approve_intent", json!({"mandate_id": mid, "recipient": merchant,
                "amount": amount.to_string(), "nonce": rng.below(6),
                "approval_expires_at_ms": now_ms(&env.worker).await? + 600_000}), 2_000_000_000_000_000_000_000)
        } else if roll < 73 {
            let who = if rng.below(2) == 0 { &env.owner } else { &env.guardian };
            (who, "tighten", json!({"mandate_id": mid, "change": {"Budget": (5_000 - rng.below(30) as u128 * 10).to_string()}}), 0)
        } else if roll < 81 {
            (&env.guardian, "loosen", json!({"mandate_id": mid, "change": {"PerPaymentCap": (100 + rng.below(50) as u128).to_string()}}), 0)
        } else if roll < 89 {
            let who = if rng.below(4) == 0 { &env.agent } else { &env.guardian };
            (who, "loosen", json!({"mandate_id": mid, "change": {"Budget": (5_000 + rng.below(3) as u128).to_string()}}), 0)
        } else {
            (&env.guardian, "resolve_stale", json!({"mandate_id": mid, "request_id": 1 + rng.below(8), "transferred": rng.below(2) == 0}), 0)
        };
        let r = caller.call(&env.scrip_id, method).args_json(args)
            .deposit(NearToken::from_yoctonear(deposit)).gas(GAS_300).transact().await?;
        let e = by_method.entry(method).or_insert((0, 0));
        if r.is_success() { ok_calls += 1; e.0 += 1 } else { failed_calls += 1; e.1 += 1 }
        check_invariants(&env, mid).await.map_err(|e| format!("step {step} {method}: {e}"))?;
    }
    println!("random: seed={SEED:#x} steps={STEPS} ok={ok_calls} failed={failed_calls} by_method(ok,failed)={by_method:?}");
    let m = mandate_json(&env, mid).await?;
    println!("random final: spent={} reserved={} withdrawn={} status={}", u128_field(&m, "spent"), u128_field(&m, "reserved"), u128_field(&m, "withdrawn"), m["status"]);
    assert!(ok_calls >= 40, "sequence too shallow to mean anything: only {ok_calls} calls succeeded");
    Ok(())
}

// ------------------------------------------------- audit F1 regression (withdraw needs revoke)

/// Audit F1: an EXPIRED but still-Active mandate must not allow `withdraw`; otherwise the guardian
/// could revive it with `loosen(Expiry)` and spend tokens that belong to other mandates.
#[tokio::test(flavor = "current_thread")]
async fn audit_f1_expired_mandate_cannot_withdraw_then_revive() -> Result<(), Box<dyn std::error::Error>> {
    let env = setup().await?;
    ft_register(&env, env.owner.id().as_str()).await?;
    let mid = scenario_mandate(&env, BUDGET, CAP, CAP, &[], 30_000).await?; // expires in 30 s of chain time
    env.worker.fast_forward(400).await?; // ~2 minutes of sandbox time
    let r = env.owner.call(&env.scrip_id, "withdraw")
        .args_json(json!({ "mandate_id": mid, "amount": "1" })).gas(GAS_300).transact().await?;
    assert_panics(r, "MANDATE_STILL_ACTIVE");
    // the request itself is rejected as expired and nothing moved
    let r = request(&env, mid, env.merchant_id.as_str(), 10, 1).await?;
    assert_rejected(r, "EXPIRED");
    check_invariants(&env, mid).await?;
    assert_eq!(balance_of(&env, env.owner.id().as_str()).await?, 0);
    Ok(())
}

