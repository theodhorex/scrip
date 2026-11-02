//! Scrip: multi-mandate spending contract (PRD 3.1 to 3.6).
//!
//! Many mandates live in one contract. Authorization always uses
//! `predecessor_account_id` (never the signer: meta-transactions go through a relayer).
//! A rejected payment request is a SUCCESSFUL call returning `Rejected{code}` plus a
//! NEP-297 event (a panic would roll back state); panics are reserved for programmer
//! and authorization errors.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use hash::validate_recipient;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult,
};

/// Maximum number of unresolved `Pending` entries per mandate (bounds storage).
pub const MAX_OPEN: u32 = 32;
/// A `Pending` entry older than this many blocks may be resolved by the guardian
/// (`resolve_stale`, K2). Adjustable; 200 blocks is roughly 3 to 4 minutes.
pub const STALE_BLOCKS: u64 = 200;
/// Maximum number of allowed recipients per mandate.
pub const MAX_RECIPIENTS: usize = 16;
/// `request_payment` refuses to run with less prepaid gas than this (measured, PRD 3.6).
pub const MIN_PREPAID_GAS: Gas = Gas::from_tgas(60);
/// Static gas for `ft_transfer`, unused-gas weight 0.
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Static gas for `on_payment_done`, unused-gas weight 0 (an out-of-gas callback leaves
/// `reserved` + `Pending` stuck while the transfer still lands).
pub const CALLBACK_GAS: Gas = Gas::from_tgas(15);

/// `withdraw` refuses to run with less prepaid gas than this: `ft_transfer` (15) + callback
/// (15) + the call itself, with headroom, so the restore-on-failure callback can always run.
pub const MIN_WITHDRAW_GAS: Gas = Gas::from_tgas(60);
/// Static gas for `on_withdraw_done`, unused-gas weight 0.
pub const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Minimum NEAR attached to `create_mandate`. It stays in the contract account and pays
/// for the mandate's storage (about 0.02 NEAR at 16 recipients, see README) with margin.
/// Without it anyone could drain the contract's NEAR by creating mandates. No refund.
pub const STORAGE_DEPOSIT_PER_MANDATE: NearToken = NearToken::from_millinear(50);
/// Attached to every `approve_intent` (guardian pays for the permanent approval entry).
pub const STORAGE_DEPOSIT_PER_APPROVAL: NearToken = NearToken::from_millinear(2);
/// Maximum number of approval entries ever created per mandate (they are never deleted,
/// a used hash must stay to block replays), K-C. Bounds contract storage growth.
pub const MAX_APPROVALS_PER_MANDATE: u32 = 512;

const EVENT_STANDARD: &str = "scrip";
const EVENT_VERSION: &str = "1.0.0";

#[ext_contract(ext_ft)]
pub trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_payment_done(&mut self, mandate_id: u64, request_id: u64) -> PaymentResult;
    fn on_withdraw_done(&mut self, mandate_id: u64, amount: U128) -> bool;
}

/// Panic codes of the guardian/owner methods (K2), the single place they are defined.
/// Panics (state rolled back) are for authorization and programmer errors only.
pub mod err {
    pub const INSUFFICIENT_STORAGE_DEPOSIT: &str = "INSUFFICIENT_STORAGE_DEPOSIT";
    pub const INSUFFICIENT_APPROVAL_DEPOSIT: &str = "INSUFFICIENT_APPROVAL_DEPOSIT";
    pub const MANDATE_NOT_FOUND: &str = "MANDATE_NOT_FOUND";
    pub const UNAUTHORIZED_GUARDIAN: &str = "UNAUTHORIZED_GUARDIAN";
    pub const UNAUTHORIZED_OWNER: &str = "UNAUTHORIZED_OWNER";
    pub const UNAUTHORIZED_OWNER_OR_GUARDIAN: &str = "UNAUTHORIZED_OWNER_OR_GUARDIAN";
    pub const NOT_ACTIVE: &str = "NOT_ACTIVE";
    pub const INVALID_RECIPIENT: &str = "INVALID_RECIPIENT";
    pub const APPROVAL_NOT_IN_FUTURE: &str = "APPROVAL_NOT_IN_FUTURE";
    pub const ALREADY_APPROVED: &str = "ALREADY_APPROVED";
    pub const NOT_STRICTER: &str = "NOT_STRICTER";
    pub const NOT_LOOSER: &str = "NOT_LOOSER";
    pub const BUDGET_BELOW_COMMITTED: &str = "BUDGET_BELOW_COMMITTED";
    pub const BUDGET_ABOVE_DEPOSITED: &str = "BUDGET_ABOVE_DEPOSITED";
    pub const CAP_ABOVE_BUDGET: &str = "CAP_ABOVE_BUDGET";
    pub const THRESHOLD_ABOVE_CAP: &str = "THRESHOLD_ABOVE_CAP";
    pub const EXPIRY_NOT_IN_FUTURE: &str = "EXPIRY_NOT_IN_FUTURE";
    pub const NO_SUCH_RECIPIENT: &str = "NO_SUCH_RECIPIENT";
    pub const DUPLICATE_RECIPIENT: &str = "DUPLICATE_RECIPIENT";
    pub const TOO_MANY_RECIPIENTS: &str = "TOO_MANY_RECIPIENTS";
    pub const ALREADY_REVOKED: &str = "ALREADY_REVOKED";
    pub const MANDATE_STILL_ACTIVE: &str = "MANDATE_STILL_ACTIVE";
    pub const ZERO_AMOUNT: &str = "ZERO_AMOUNT";
    pub const AMOUNT_EXCEEDS_FREE: &str = "AMOUNT_EXCEEDS_FREE";
    pub const INSUFFICIENT_GAS: &str = "INSUFFICIENT_GAS";
    pub const NO_SUCH_PENDING: &str = "NO_SUCH_PENDING";
    pub const NOT_STALE_YET: &str = "NOT_STALE_YET";
    /// K-A: `tighten(Budget)` may not go below `per_payment_cap`.
    pub const BUDGET_BELOW_CAP: &str = "BUDGET_BELOW_CAP";
    /// K-A: `tighten(PerPaymentCap)` may not go below `approval_threshold`.
    pub const CAP_BELOW_THRESHOLD: &str = "CAP_BELOW_THRESHOLD";
    /// K-B: `create_mandate` with `owner == agent`.
    pub const OWNER_IS_AGENT: &str = "OWNER_IS_AGENT";
    /// K-C: per-mandate approval entry limit reached.
    pub const TOO_MANY_APPROVALS: &str = "TOO_MANY_APPROVALS";
    /// K-3: token ledger insufficient for transfer.
    pub const LEDGER_INSUFFICIENT: &str = "LEDGER_INSUFFICIENT";
}

/// One rule change for `tighten` / `loosen` (PRD 3.2). JSON is serde's externally tagged
/// form and is a stable contract: `{"Budget":"500"}`, `{"PerPaymentCap":"50"}`,
/// `{"ApprovalThreshold":"10"}`, `{"AddRecipient":"shop.testnet"}`,
/// `{"RemoveRecipient":"shop.testnet"}`, `{"Expiry":1893456000000}`. Amounts are decimal
/// strings (`U128`), `Expiry` is a plain u64 in ms.
#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Budget(U128),
    PerPaymentCap(U128),
    ApprovalThreshold(U128),
    AddRecipient(AccountId),
    RemoveRecipient(AccountId),
    Expiry(u64),
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum MandateStatus {
    Active,
    Revoked,
}

#[near(serializers=[borsh])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub id: u64,
    pub owner: AccountId,
    pub guardian: AccountId,
    pub agent: AccountId,
    /// FT contract.
    pub token: AccountId,
    /// Total ever received from the owner via `ft_on_transfer`.
    pub deposited: u128,
    /// Total spending ceiling. Effective ceiling is `min(budget, deposited - withdrawn)`
    /// (enforced in `request_payment` step 6; `loosen(Budget)` is bounded the same way).
    pub budget: u128,
    /// Settled transfers.
    pub spent: u128,
    /// Reserved while a transfer awaits its callback.
    pub reserved: u128,
    /// Withdrawn by the owner after revocation (K2).
    pub withdrawn: u128,
    pub per_payment_cap: u128,
    /// Amounts above this need a guardian-approved intent hash.
    pub approval_threshold: u128,
    pub expires_at_ms: u64,
    pub status: MandateStatus,
    pub open_requests: u32,
    pub next_request_id: u64,
    /// Approval entries ever created for this mandate (K-C, capped).
    pub approvals_count: u32,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub recipient: AccountId,
    pub amount: U128,
    pub height: u64,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub expires_at_ms: u64,
    pub used: bool,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MandateView {
    pub id: u64,
    pub owner: AccountId,
    pub guardian: AccountId,
    pub agent: AccountId,
    pub token: AccountId,
    pub deposited: U128,
    pub budget: U128,
    pub spent: U128,
    pub reserved: U128,
    pub withdrawn: U128,
    pub per_payment_cap: U128,
    pub approval_threshold: U128,
    pub expires_at_ms: u64,
    pub status: MandateStatus,
    pub open_requests: u32,
    pub next_request_id: u64,
    pub recipients: Vec<AccountId>,
    pub approvals_count: u32,
    pub approvals_remaining: u32,
}

#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub deposited: U128,
    pub budget: U128,
    pub spent: U128,
    pub reserved: U128,
    pub withdrawn: U128,
    pub open_requests: u32,
}

/// Result of `request_payment` / `on_payment_done`.
#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentResult {
    Reserved { request_id: u64 },
    Rejected { code: String },
    Settled { request_id: u64 },
    Refunded { request_id: u64 },
    /// Callback ran again for a request that was already resolved: no state change.
    AlreadyResolved { request_id: u64 },
}

/// Policy rejection codes, rendered as SCREAMING_SNAKE strings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RejectCode {
    NotActive,
    Expired,
    RecipientNotAllowed,
    OverPerPaymentCap,
    TooManyOpen,
    OverBudget,
    NeedsApproval,
    ApprovalUsed,
    ApprovalExpired,
    LedgerInsufficient,
}

impl RejectCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            RejectCode::NotActive => "NOT_ACTIVE",
            RejectCode::Expired => "EXPIRED",
            RejectCode::RecipientNotAllowed => "RECIPIENT_NOT_ALLOWED",
            RejectCode::OverPerPaymentCap => "OVER_PER_PAYMENT_CAP",
            RejectCode::TooManyOpen => "TOO_MANY_OPEN",
            RejectCode::OverBudget => "OVER_BUDGET",
            RejectCode::NeedsApproval => "NEEDS_APPROVAL",
            RejectCode::ApprovalUsed => "APPROVAL_USED",
            RejectCode::ApprovalExpired => "APPROVAL_EXPIRED",
            RejectCode::LedgerInsufficient => "LEDGER_INSUFFICIENT",
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Scrip {
    pub next_mandate_id: u64,
    pub mandates: LookupMap<u64, Mandate>,
    /// Ordered recipient list per mandate (for views; max `MAX_RECIPIENTS`).
    /// Must be kept in sync with `recipients` (K2 add/remove).
    pub recipient_lists: LookupMap<u64, Vec<AccountId>>,
    /// O(1) membership test used by `request_payment`.
    pub recipients: LookupSet<(u64, AccountId)>,
    pub pending: LookupMap<(u64, u64), Pending>,
    pub approvals: LookupMap<[u8; 32], Approval>,
    pub token_ledger: LookupMap<AccountId, u128>,
}

/// Pure intent-hash helpers. Kept in a module because the exported contract view is also
/// named `intent_hash` and a root-level function of the same name would clash in wasm.
pub mod hash {
    use near_sdk::env;

    const HASH_PREFIX: &[u8] = b"amanat/v1";
    const MAX_RECIPIENT_BYTES: usize = 64;

    /// Recipient encoding rule of the intent hash (PRD 3.4): 1..=64 bytes of `[a-z0-9._-]`.
    pub fn validate_recipient(recipient: &str) -> bool {
        !recipient.is_empty()
            && recipient.len() <= MAX_RECIPIENT_BYTES
            && recipient
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
    }

    /// `SHA-256("amanat/v1" || u64le mandate_id || u32le len(recipient) || recipient
    /// || u128le amount || u64le nonce || u64le expires_at_ms)` (PRD 3.4).
    pub fn intent_hash(
        mandate_id: u64,
        recipient: &str,
        amount: u128,
        nonce: u64,
        expires_at_ms: u64,
    ) -> [u8; 32] {
        let mut buf = Vec::with_capacity(HASH_PREFIX.len() + 8 + 4 + recipient.len() + 16 + 8 + 8);
        buf.extend_from_slice(HASH_PREFIX);
        buf.extend_from_slice(&mandate_id.to_le_bytes());
        buf.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
        buf.extend_from_slice(recipient.as_bytes());
        buf.extend_from_slice(&amount.to_le_bytes());
        buf.extend_from_slice(&nonce.to_le_bytes());
        buf.extend_from_slice(&expires_at_ms.to_le_bytes());
        env::sha256_array(&buf)
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

fn from_hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Some(out)
}

/// The single NEP-297 emitter. `data` is one object; the log line carries `data: [data]`.
fn emit(event: &str, data: Value) {
    let e = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{e}"));
}

fn mandate_event(mandate_id: u64, request_id: Option<u64>, recipient: &AccountId, amount: u128) -> Value {
    let mut d = json!({
        "mandate_id": mandate_id,
        "recipient": recipient,
        "amount": amount.to_string(),
    });
    if let Some(r) = request_id {
        d["request_id"] = json!(r);
    }
    d
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct DepositMsg {
    mandate_id: u64,
}

#[near]
impl Scrip {
    #[init]
    pub fn new() -> Self {
        Self {
            next_mandate_id: 1,
            mandates: LookupMap::new(b"m"),
            recipient_lists: LookupMap::new(b"l"),
            recipients: LookupSet::new(b"r"),
            pending: LookupMap::new(b"p"),
            approvals: LookupMap::new(b"a"),
            token_ledger: LookupMap::new(b"t"),
        }
    }

    /// Create a mandate; the caller (predecessor) is the owner. Panics on invalid input.
    /// Payable: the caller must attach at least `STORAGE_DEPOSIT_PER_MANDATE` (0.05 NEAR,
    /// panic `INSUFFICIENT_STORAGE_DEPOSIT`); otherwise anyone could drain the contract's
    /// NEAR by creating mandates. Exactly `STORAGE_DEPOSIT_PER_MANDATE` stays in the
    /// contract; any excess is refunded to the caller (K-B).
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_mandate(
        &mut self,
        agent: AccountId,
        guardian: AccountId,
        token: AccountId,
        budget: U128,
        per_payment_cap: U128,
        approval_threshold: U128,
        recipients: Vec<AccountId>,
        expires_at_ms: u64,
    ) -> u64 {
        require(env::attached_deposit() >= STORAGE_DEPOSIT_PER_MANDATE, err::INSUFFICIENT_STORAGE_DEPOSIT);
        let owner = env::predecessor_account_id();
        require(budget.0 >= per_payment_cap.0, "BUDGET_LESS_THAN_CAP");
        require(approval_threshold.0 <= per_payment_cap.0, "THRESHOLD_ABOVE_CAP");
        require(owner != agent, err::OWNER_IS_AGENT);
        require(guardian != agent, "GUARDIAN_IS_AGENT");
        require(guardian != owner, "GUARDIAN_IS_OWNER");
        require(!recipients.is_empty(), "EMPTY_RECIPIENTS");
        require(recipients.len() <= MAX_RECIPIENTS, "TOO_MANY_RECIPIENTS");
        require(expires_at_ms > env::block_timestamp_ms(), "EXPIRY_NOT_IN_FUTURE");
        for (i, r) in recipients.iter().enumerate() {
            require(validate_recipient(r.as_str()), "INVALID_RECIPIENT");
            require(!recipients[..i].contains(r), "DUPLICATE_RECIPIENT");
        }

        let id = self.next_mandate_id;
        self.next_mandate_id = id.checked_add(1).expect("MANDATE_ID_OVERFLOW");
        for r in &recipients {
            self.recipients.insert((id, r.clone()));
        }
        self.recipient_lists.insert(id, recipients);
        let m = Mandate {
            id,
            owner: owner.clone(),
            guardian: guardian.clone(),
            agent: agent.clone(),
            token: token.clone(),
            deposited: 0,
            budget: budget.0,
            spent: 0,
            reserved: 0,
            withdrawn: 0,
            per_payment_cap: per_payment_cap.0,
            approval_threshold: approval_threshold.0,
            expires_at_ms,
            status: MandateStatus::Active,
            open_requests: 0,
            next_request_id: 1,
            approvals_count: 0,
        };
        self.mandates.insert(id, m);

        // `recipient` / `amount` are required by the client parser on every event:
        // for mandate_created they carry the agent and the budget.
        let mut d = mandate_event(id, None, &agent, budget.0);
        d["owner"] = json!(owner);
        d["guardian"] = json!(guardian);
        d["agent"] = json!(agent);
        d["token"] = json!(token);
        d["per_payment_cap"] = json!(per_payment_cap.0.to_string());
        d["approval_threshold"] = json!(approval_threshold.0.to_string());
        d["expires_at_ms"] = json!(expires_at_ms);
        emit("mandate_created", d);
        refund_excess(owner, STORAGE_DEPOSIT_PER_MANDATE);
        id
    }

    /// NEP-141 receiver. Any invalid condition refunds the FULL amount (returns it as
    /// the unused part) instead of panicking, and emits nothing.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let refund = PromiseOrValue::Value(amount);
        let Ok(parsed) = serde_json::from_str::<DepositMsg>(&msg) else {
            return refund;
        };
        let token = env::predecessor_account_id();
        let Some(m) = self.mandates.get_mut(&parsed.mandate_id) else {
            return refund;
        };
        if m.token != token || m.owner != sender_id || m.status != MandateStatus::Active {
            return refund;
        }
        let Some(new_deposited) = m.deposited.checked_add(amount.0) else {
            return refund;
        };
        let cur_ledger = self.token_ledger.get(&token).copied().unwrap_or(0);
        let Some(new_ledger) = cur_ledger.checked_add(amount.0) else {
            return refund;
        };
        m.deposited = new_deposited;
        self.token_ledger.insert(token, new_ledger);
        let owner = m.owner.clone();
        emit("deposited", mandate_event(parsed.mandate_id, None, &owner, amount.0));
        PromiseOrValue::Value(U128(0))
    }

    /// PRD 3.3. Steps 1 to 9; not payable (a deposit makes the runtime reject the call).
    pub fn request_payment(
        &mut self,
        mandate_id: u64,
        recipient: AccountId,
        amount: U128,
        nonce: u64,
    ) -> PromiseOrValue<PaymentResult> {
        // Gas guard BEFORE any state is touched (an out-of-gas callback strands funds).
        require(env::prepaid_gas() >= MIN_PREPAID_GAS, "INSUFFICIENT_GAS");
        let amount = amount.0;
        let now = env::block_timestamp_ms();

        let Some(m) = self.mandates.get(&mandate_id) else {
            fail("MANDATE_NOT_FOUND");
        };
        // 1. predecessor == agent (not a policy decision: panic)
        require(env::predecessor_account_id() == m.agent, "UNAUTHORIZED_AGENT");
        // 2. status, expiry
        if m.status != MandateStatus::Active {
            return self.reject(RejectCode::NotActive, mandate_id, &recipient, amount);
        }
        if now >= m.expires_at_ms {
            return self.reject(RejectCode::Expired, mandate_id, &recipient, amount);
        }
        // 3. recipient allowed
        if !self.recipients.contains(&(mandate_id, recipient.clone())) {
            return self.reject(RejectCode::RecipientNotAllowed, mandate_id, &recipient, amount);
        }
        // 4. 0 < amount <= per_payment_cap
        if amount == 0 || amount > m.per_payment_cap {
            return self.reject(RejectCode::OverPerPaymentCap, mandate_id, &recipient, amount);
        }
        // 5. open requests
        if m.open_requests >= MAX_OPEN {
            return self.reject(RejectCode::TooManyOpen, mandate_id, &recipient, amount);
        }
        // 6. budget (checked); the ceiling is min(budget, deposited - withdrawn) per invariant 5.3 #1
        let ceiling = m.budget.min(m.deposited.saturating_sub(m.withdrawn));
        let needed = m
            .spent
            .checked_add(m.reserved)
            .and_then(|v| v.checked_add(amount));
        match needed {
            Some(n) if n <= ceiling => {}
            _ => return self.reject(RejectCode::OverBudget, mandate_id, &recipient, amount),
        }
        // 7. approval for amounts above the threshold
        let mut approval_key = None;
        if amount > m.approval_threshold {
            // The hash binds the mandate's current expiry (see README: PRD ambiguity).
            let h = hash::intent_hash(mandate_id, recipient.as_str(), amount, nonce, m.expires_at_ms);
            match self.approvals.get(&h) {
                None => return self.reject(RejectCode::NeedsApproval, mandate_id, &recipient, amount),
                Some(a) if a.used => {
                    return self.reject(RejectCode::ApprovalUsed, mandate_id, &recipient, amount)
                }
                Some(a) if now >= a.expires_at_ms => {
                    return self.reject(RejectCode::ApprovalExpired, mandate_id, &recipient, amount)
                }
                Some(_) => approval_key = Some(h),
            }
        }

        // 8. write first: reserve, store Pending, consume the approval
        let token = m.token.clone();
        let cur_ledger = self.token_ledger.get(&token).copied().unwrap_or(0);
        require(cur_ledger >= amount, err::LEDGER_INSUFFICIENT);
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        let request_id = m.next_request_id;
        m.next_request_id = request_id.checked_add(1).expect("REQUEST_ID_OVERFLOW");
        m.reserved = m.reserved.checked_add(amount).expect("RESERVED_OVERFLOW");
        m.open_requests += 1;
        self.pending.insert(
            (mandate_id, request_id),
            Pending { recipient: recipient.clone(), amount: U128(amount), height: env::block_height() },
        );
        if let Some(h) = approval_key {
            if let Some(a) = self.approvals.get_mut(&h) {
                a.used = true;
            }
        }
        emit("reserved", mandate_event(mandate_id, Some(request_id), &recipient, amount));

        // 9. ft_transfer (1 yocto from the contract's own balance), then the callback.
        let promise = ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .with_unused_gas_weight(0)
            .ft_transfer(recipient, U128(amount), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_payment_done(mandate_id, request_id),
            );
        PromiseOrValue::Promise(promise)
    }

    /// Settles (`reserved -> spent`) or refunds (`reserved` released) a reserved request.
    /// If the `Pending` entry is gone it does nothing.
    #[private]
    pub fn on_payment_done(&mut self, mandate_id: u64, request_id: u64) -> PaymentResult {
        let Some(p) = self.pending.remove(&(mandate_id, request_id)) else {
            return PaymentResult::AlreadyResolved { request_id };
        };
        #[allow(deprecated)]
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let m = self.mandates.get_mut(&mandate_id).expect("MANDATE_NOT_FOUND");
        m.reserved = m.reserved.checked_sub(p.amount.0).expect("RESERVED_UNDERFLOW");
        m.open_requests = m.open_requests.checked_sub(1).expect("OPEN_UNDERFLOW");
        let ev = mandate_event(mandate_id, Some(request_id), &p.recipient, p.amount.0);
        if ok {
            m.spent = m.spent.checked_add(p.amount.0).expect("SPENT_OVERFLOW");
            let token = m.token.clone();
            let cur_ledger = self.token_ledger.get(&token).copied().unwrap_or(0);
            let new_ledger = cur_ledger.checked_sub(p.amount.0).expect("LEDGER_UNDERFLOW");
            self.token_ledger.insert(token, new_ledger);
            emit("settled", ev);
            PaymentResult::Settled { request_id }
        } else {
            emit("refunded", ev);
            PaymentResult::Refunded { request_id }
        }
    }

    /// Guardian only, mandate Active. Stores `approvals[hash] = {approval_expires_at_ms,
    /// used: false}` where the hash binds the mandate's CURRENT `expires_at_ms` (the agent
    /// only supplies a nonce, see `request_payment` step 7). Consequence: tightening or
    /// loosening the mandate expiry later makes earlier approvals stop matching, which fails
    /// safe as `NEEDS_APPROVAL`; the guardian approves again. A hash that already exists
    /// (used or not) is never overwritten: that would reset `used` and allow a replay.
    #[payable]
    pub fn approve_intent(
        &mut self,
        mandate_id: u64,
        recipient: AccountId,
        amount: U128,
        nonce: u64,
        approval_expires_at_ms: u64,
    ) {
        require(env::attached_deposit() >= STORAGE_DEPOSIT_PER_APPROVAL, err::INSUFFICIENT_APPROVAL_DEPOSIT);
        let m = self.mandate_ref(mandate_id);
        require(env::predecessor_account_id() == m.guardian, err::UNAUTHORIZED_GUARDIAN);
        require(m.status == MandateStatus::Active, err::NOT_ACTIVE);
        require(validate_recipient(recipient.as_str()), err::INVALID_RECIPIENT);
        require(approval_expires_at_ms > env::block_timestamp_ms(), err::APPROVAL_NOT_IN_FUTURE);
        let h = hash::intent_hash(mandate_id, recipient.as_str(), amount.0, nonce, m.expires_at_ms);
        require(self.approvals.get(&h).is_none(), err::ALREADY_APPROVED);
        require(m.approvals_count < MAX_APPROVALS_PER_MANDATE, err::TOO_MANY_APPROVALS);
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        m.approvals_count += 1;
        let guardian = m.guardian.clone();
        self.approvals.insert(h, Approval { expires_at_ms: approval_expires_at_ms, used: false });
        refund_excess(guardian, STORAGE_DEPOSIT_PER_APPROVAL);
        let mut d = mandate_event(mandate_id, None, &recipient, amount.0);
        d["nonce"] = json!(nonce);
        d["approval_expires_at_ms"] = json!(approval_expires_at_ms);
        d["intent_hash"] = json!(to_hex(&h));
        emit("intent_approved", d);
    }

    /// Owner OR guardian; mandate Active. Accepts ONLY a change toward stricter rules:
    /// budget down (never below `spent + reserved`, nor below `per_payment_cap`:
    /// `BUDGET_BELOW_CAP`), cap down (never below `approval_threshold`:
    /// `CAP_BELOW_THRESHOLD`), threshold down, a recipient removed, expiry moved earlier
    /// (but still in the future). This keeps `budget >= cap >= threshold` (K-A).
    /// Anything else panics `NOT_STRICTER` (or a more specific code). The agent can never
    /// call this.
    pub fn tighten(&mut self, mandate_id: u64, change: Change) {
        let caller = env::predecessor_account_id();
        let m = self.mandate_ref(mandate_id);
        require(caller == m.owner || caller == m.guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN);
        require(m.status == MandateStatus::Active, err::NOT_ACTIVE);
        let now = env::block_timestamp_ms();
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        match &change {
            Change::Budget(x) => {
                require(x.0 < m.budget, err::NOT_STRICTER);
                require(x.0 >= m.spent.saturating_add(m.reserved), err::BUDGET_BELOW_COMMITTED);
                require(x.0 >= m.per_payment_cap, err::BUDGET_BELOW_CAP);
                m.budget = x.0;
            }
            Change::PerPaymentCap(x) => {
                require(x.0 < m.per_payment_cap, err::NOT_STRICTER);
                require(x.0 >= m.approval_threshold, err::CAP_BELOW_THRESHOLD);
                m.per_payment_cap = x.0;
            }
            Change::ApprovalThreshold(x) => {
                require(x.0 < m.approval_threshold, err::NOT_STRICTER);
                m.approval_threshold = x.0;
            }
            Change::AddRecipient(_) => fail(err::NOT_STRICTER),
            Change::RemoveRecipient(r) => {
                require(self.recipients.remove(&(mandate_id, r.clone())), err::NO_SUCH_RECIPIENT);
                if let Some(list) = self.recipient_lists.get_mut(&mandate_id) {
                    list.retain(|a| a != r);
                }
            }
            Change::Expiry(t) => {
                require(*t < m.expires_at_ms, err::NOT_STRICTER);
                require(*t > now, err::EXPIRY_NOT_IN_FUTURE);
                m.expires_at_ms = *t;
            }
        }
        let agent = m.agent.clone();
        self.emit_change("tightened", mandate_id, &agent, &caller, &change);
    }

    /// Guardian ONLY; mandate Active. Accepts ONLY a change toward looser rules: budget up
    /// (`<= deposited`), cap up (`<= budget`), threshold up (`<= cap`), a recipient added
    /// (at most `MAX_RECIPIENTS`), expiry later. Anything else panics `NOT_LOOSER` (or a
    /// more specific code). Owner, agent and strangers can never raise a limit.
    pub fn loosen(&mut self, mandate_id: u64, change: Change) {
        let caller = env::predecessor_account_id();
        let m = self.mandate_ref(mandate_id);
        require(caller == m.guardian, err::UNAUTHORIZED_GUARDIAN);
        require(m.status == MandateStatus::Active, err::NOT_ACTIVE);
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        match &change {
            Change::Budget(x) => {
                require(x.0 > m.budget, err::NOT_LOOSER);
                require(x.0 <= m.deposited.saturating_sub(m.withdrawn), err::BUDGET_ABOVE_DEPOSITED);
                m.budget = x.0;
            }
            Change::PerPaymentCap(x) => {
                require(x.0 > m.per_payment_cap, err::NOT_LOOSER);
                require(x.0 <= m.budget, err::CAP_ABOVE_BUDGET);
                m.per_payment_cap = x.0;
            }
            Change::ApprovalThreshold(x) => {
                require(x.0 > m.approval_threshold, err::NOT_LOOSER);
                require(x.0 <= m.per_payment_cap, err::THRESHOLD_ABOVE_CAP);
                m.approval_threshold = x.0;
            }
            Change::AddRecipient(r) => {
                require(validate_recipient(r.as_str()), err::INVALID_RECIPIENT);
                require(!self.recipients.contains(&(mandate_id, r.clone())), err::DUPLICATE_RECIPIENT);
                let list = self.recipient_lists.get_mut(&mandate_id).expect("list exists with mandate");
                require(list.len() < MAX_RECIPIENTS, err::TOO_MANY_RECIPIENTS);
                list.push(r.clone());
                self.recipients.insert((mandate_id, r.clone()));
            }
            Change::RemoveRecipient(_) => fail(err::NOT_LOOSER),
            Change::Expiry(t) => {
                require(*t > m.expires_at_ms, err::NOT_LOOSER);
                m.expires_at_ms = *t;
            }
        }
        let agent = m.agent.clone();
        self.emit_change("loosened", mandate_id, &agent, &caller, &change);
    }

    /// Owner or guardian: Active -> Revoked (a second call panics). In-flight `Pending`
    /// requests are NOT cancelled: their callbacks still settle or refund correctly.
    pub fn revoke(&mut self, mandate_id: u64) {
        let caller = env::predecessor_account_id();
        let m = self.mandate_ref(mandate_id);
        require(caller == m.owner || caller == m.guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN);
        require(m.status == MandateStatus::Active, err::ALREADY_REVOKED);
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        m.status = MandateStatus::Revoked;
        let owner = m.owner.clone();
        let free = m.deposited.saturating_sub(m.spent).saturating_sub(m.reserved).saturating_sub(m.withdrawn);
        let mut d = mandate_event(mandate_id, None, &owner, free);
        d["by"] = json!(caller);
        emit("revoked", d);
    }

    /// The owner's exit path. Owner only, mandate Revoked. Pays out of the free
    /// remainder `deposited - spent - reserved - withdrawn` and BYPASSES the spending rules
    /// (recipients, caps, approvals) by design: it can only ever send to the owner.
    /// `withdrawn` is increased BEFORE the promise; `on_withdraw_done` restores it if the
    /// transfer failed. The `withdrawn` event is emitted by the callback on success only.
    pub fn withdraw(&mut self, mandate_id: u64, amount: U128) -> Promise {
        require(env::prepaid_gas() >= MIN_WITHDRAW_GAS, err::INSUFFICIENT_GAS);
        let m = self.mandates.get_mut(&mandate_id).unwrap_or_else(|| fail(err::MANDATE_NOT_FOUND));
        require(env::predecessor_account_id() == m.owner, err::UNAUTHORIZED_OWNER);
        require(m.status == MandateStatus::Revoked, err::MANDATE_STILL_ACTIVE);
        require(amount.0 > 0, err::ZERO_AMOUNT);
        let committed = m.spent.checked_add(m.reserved).and_then(|v| v.checked_add(m.withdrawn));
        let free = m.deposited.saturating_sub(committed.expect("COMMITTED_OVERFLOW"));
        require(amount.0 <= free, err::AMOUNT_EXCEEDS_FREE);
        let cur_ledger = self.token_ledger.get(&m.token).copied().unwrap_or(0);
        require(cur_ledger >= amount.0, err::LEDGER_INSUFFICIENT);
        let new_ledger = cur_ledger.checked_sub(amount.0).expect("LEDGER_UNDERFLOW");
        m.withdrawn = m.withdrawn.checked_add(amount.0).expect("WITHDRAWN_OVERFLOW"); // state first, promise after
        let (owner, token) = (m.owner.clone(), m.token.clone());
        self.token_ledger.insert(token.clone(), new_ledger);
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .with_unused_gas_weight(0)
            .ft_transfer(owner, amount, None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(WITHDRAW_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_withdraw_done(mandate_id, amount),
            )
    }

    /// Callback of `withdraw`: on success emit `withdrawn`; on failure give the amount back
    /// to the free remainder. Returns whether the transfer succeeded.
    #[private]
    pub fn on_withdraw_done(&mut self, mandate_id: u64, amount: U128) -> bool {
        #[allow(deprecated)]
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let m = self.mandates.get_mut(&mandate_id).expect("MANDATE_NOT_FOUND");
        if ok {
            let owner = m.owner.clone();
            emit("withdrawn", mandate_event(mandate_id, None, &owner, amount.0));
        } else {
            m.withdrawn = m.withdrawn.checked_sub(amount.0).expect("WITHDRAWN_UNDERFLOW");
            let token = m.token.clone();
            let cur_ledger = self.token_ledger.get(&token).copied().unwrap_or(0);
            let new_ledger = cur_ledger.checked_add(amount.0).expect("LEDGER_OVERFLOW");
            self.token_ledger.insert(token, new_ledger);
        }
        ok
    }

    /// Guardian only. Resolves a `Pending` entry older than `STALE_BLOCKS` (typically a
    /// callback that ran out of gas). The guardian first checks off-chain whether the
    /// `ft_transfer` really landed and passes `transferred`: true behaves like settle
    /// (`reserved -> spent`), false like refund (`reserved` released). Returning a stale
    /// request blindly could double-spend the budget, hence the explicit flag. Works on
    /// Revoked mandates too. A second call panics `NO_SUCH_PENDING`.
    pub fn resolve_stale(&mut self, mandate_id: u64, request_id: u64, transferred: bool) {
        let m = self.mandate_ref(mandate_id);
        require(env::predecessor_account_id() == m.guardian, err::UNAUTHORIZED_GUARDIAN);
        let key = (mandate_id, request_id);
        let p = self.pending.get(&key).unwrap_or_else(|| fail(err::NO_SUCH_PENDING)).clone();
        require(
            env::block_height().saturating_sub(p.height) >= STALE_BLOCKS,
            err::NOT_STALE_YET,
        );
        self.pending.remove(&key);
        let m = self.mandates.get_mut(&mandate_id).expect("checked above");
        m.reserved = m.reserved.checked_sub(p.amount.0).expect("RESERVED_UNDERFLOW");
        m.open_requests = m.open_requests.checked_sub(1).expect("OPEN_UNDERFLOW");
        if transferred {
            m.spent = m.spent.checked_add(p.amount.0).expect("SPENT_OVERFLOW");
            let token = m.token.clone();
            let cur_ledger = self.token_ledger.get(&token).copied().unwrap_or(0);
            let new_ledger = cur_ledger.checked_sub(p.amount.0).expect("LEDGER_UNDERFLOW");
            self.token_ledger.insert(token, new_ledger);
        }
        let mut d = mandate_event(mandate_id, Some(request_id), &p.recipient, p.amount.0);
        d["transferred"] = json!(transferred);
        emit("stale_resolved", d);
    }

    pub fn get_mandate(&self, id: u64) -> Option<MandateView> {
        let m = self.mandates.get(&id)?;
        Some(MandateView {
            id: m.id,
            owner: m.owner.clone(),
            guardian: m.guardian.clone(),
            agent: m.agent.clone(),
            token: m.token.clone(),
            deposited: U128(m.deposited),
            budget: U128(m.budget),
            spent: U128(m.spent),
            reserved: U128(m.reserved),
            withdrawn: U128(m.withdrawn),
            per_payment_cap: U128(m.per_payment_cap),
            approval_threshold: U128(m.approval_threshold),
            expires_at_ms: m.expires_at_ms,
            status: m.status.clone(),
            open_requests: m.open_requests,
            next_request_id: m.next_request_id,
            recipients: self.recipient_lists.get(&id).cloned().unwrap_or_default(),
            approvals_count: m.approvals_count,
            approvals_remaining: MAX_APPROVALS_PER_MANDATE.saturating_sub(m.approvals_count),
        })
    }

    pub fn get_pending(&self, id: u64, request_id: u64) -> Option<Pending> {
        self.pending.get(&(id, request_id)).cloned()
    }

    pub fn get_stats(&self, id: u64) -> Option<Stats> {
        let m = self.mandates.get(&id)?;
        Some(Stats {
            deposited: U128(m.deposited),
            budget: U128(m.budget),
            spent: U128(m.spent),
            reserved: U128(m.reserved),
            withdrawn: U128(m.withdrawn),
            open_requests: m.open_requests,
        })
    }

    pub fn get_token_ledger(&self, token: AccountId) -> U128 {
        U128(self.token_ledger.get(&token).copied().unwrap_or(0))
    }

    /// `hash_hex`: 64 hex chars. Panics on malformed input.
    pub fn get_approval(&self, hash_hex: String) -> Option<Approval> {
        let h = from_hex32(&hash_hex).unwrap_or_else(|| fail("INVALID_HASH_HEX"));
        self.approvals.get(&h).cloned()
    }

    /// Hex of the intent hash, so guardians/clients can compute it without re-implementing it.
    pub fn intent_hash(
        &self,
        mandate_id: u64,
        recipient: AccountId,
        amount: U128,
        nonce: u64,
        expires_at_ms: u64,
    ) -> String {
        require(validate_recipient(recipient.as_str()), "INVALID_RECIPIENT");
        to_hex(&hash::intent_hash(mandate_id, recipient.as_str(), amount.0, nonce, expires_at_ms))
    }
}

/// Return everything attached above `keep` to `to` (K-B). No-op without excess.
fn refund_excess(to: AccountId, keep: NearToken) {
    let attached = env::attached_deposit();
    if attached > keep {
        let _ = Promise::new(to).transfer(attached.saturating_sub(keep));
    }
}

/// Panic with a code from `err` unless `cond` holds.
fn require(cond: bool, code: &str) {
    if !cond {
        fail(code);
    }
}

/// Abort with `code`. The code is logged first because the built wasm loses the panic
/// message (the sandbox and the explorer show a bare `unreachable`); a log written before a
/// panic survives in the receipt (measured in S2), so the reason stays readable on chain.
fn fail(code: &str) -> ! {
    env::log_str(&format!("SCRIP_ERR:{code}"));
    env::panic_str(code)
}

impl Scrip {
    fn mandate_ref(&self, id: u64) -> &Mandate {
        self.mandates.get(&id).unwrap_or_else(|| fail(err::MANDATE_NOT_FOUND))
    }

    /// `tightened` / `loosened`. `recipient` / `amount` are required by the client parser:
    /// the affected recipient (else the agent) and the new numeric value (0 for recipient
    /// changes); the full change is in `change`, the caller in `by`.
    fn emit_change(&self, event: &str, mandate_id: u64, agent: &AccountId, by: &AccountId, change: &Change) {
        let (recipient, amount) = match change {
            Change::Budget(x) | Change::PerPaymentCap(x) | Change::ApprovalThreshold(x) => (agent, x.0),
            Change::AddRecipient(r) | Change::RemoveRecipient(r) => (r, 0),
            Change::Expiry(t) => (agent, *t as u128),
        };
        let mut d = mandate_event(mandate_id, None, recipient, amount);
        d["by"] = json!(by);
        d["change"] = serde_json::to_value(change).expect("Change serializes");
        emit(event, d);
    }

    /// Policy rejection: successful call, state untouched, `rejected` event.
    fn reject(
        &self,
        code: RejectCode,
        mandate_id: u64,
        recipient: &AccountId,
        amount: u128,
    ) -> PromiseOrValue<PaymentResult> {
        let mut d = mandate_event(mandate_id, None, recipient, amount);
        d["code"] = json!(code.as_str());
        emit("rejected", d);
        PromiseOrValue::Value(PaymentResult::Rejected { code: code.as_str().to_string() })
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod attack_tests;
#[cfg(test)]
mod attack_tests2;
#[cfg(test)]
mod attack_tests3;
#[cfg(test)]
mod attack_tests4;
#[cfg(test)]
mod ledger_tests;
