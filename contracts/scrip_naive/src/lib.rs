// NEGATIVE CONTROL, DO NOT USE. Built from the pre-hackathon S2 spike (declared as such in the README).
// With the default `naive` feature the budget check does not reserve first, so concurrent requests overrun the budget.
// Build the safe spike behaviour with `--no-default-features` only for comparison tests.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use serde_json::json;

const MAX_OPEN: u32 = 32;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);

#[ext_contract(ext_ft)]
pub trait ExtFt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_payment_done(&mut self, request_id: u64) -> PaymentResult;
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingRecord {
    pub recipient: AccountId,
    pub amount: U128,
    pub height: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub enum MandateStatus {
    Active,
    Revoked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct MandateView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub guardian: AccountId,
    pub token: AccountId,
    pub deposited: U128,
    pub budget: U128,
    pub spent: U128,
    pub reserved: U128,
    pub per_payment_cap: U128,
    pub recipients: Vec<AccountId>,
    pub status: MandateStatus,
    pub open_requests: u32,
    pub next_request_id: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub enum PaymentResult {
    Reserved { request_id: u64 },
    Rejected { code: String },
    Settled { request_id: u64 },
    Refunded { request_id: u64, reason: String },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ScripSpike {
    pub owner: AccountId,
    pub agent: AccountId,
    pub guardian: AccountId,
    pub token: AccountId,
    pub deposited: U128,
    pub budget: U128,
    pub spent: U128,
    pub reserved: U128,
    pub per_payment_cap: U128,
    pub recipients: Vec<AccountId>,
    pub status: MandateStatus,
    pub open_requests: u32,
    pub next_request_id: u64,
    pub pending: LookupMap<u64, PendingRecord>,
}

#[near]
impl ScripSpike {
    #[init]
    pub fn init(
        owner: AccountId,
        agent: AccountId,
        guardian: AccountId,
        token: AccountId,
        budget: U128,
        per_payment_cap: U128,
        recipients: Vec<AccountId>,
    ) -> Self {
        assert!(budget.0 >= per_payment_cap.0, "BUDGET_LESS_THAN_CAP");
        assert!(!recipients.is_empty(), "EMPTY_RECIPIENTS");
        assert_ne!(agent, guardian, "AGENT_CANNOT_BE_GUARDIAN");

        let this = Self {
            owner: owner.clone(),
            agent: agent.clone(),
            guardian,
            token,
            deposited: U128(0),
            budget,
            spent: U128(0),
            reserved: U128(0),
            per_payment_cap,
            recipients,
            status: MandateStatus::Active,
            open_requests: 0,
            next_request_id: 1,
            pending: LookupMap::new(b"p"),
        };

        this.log_nep297(
            "mandate_created",
            json!({
                "mandate_id": 0,
                "owner": owner,
                "agent": agent,
                "budget": budget,
                "per_payment_cap": per_payment_cap,
            }),
        );

        this
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        assert_eq!(
            env::predecessor_account_id(),
            self.token,
            "ONLY_TOKEN_CONTRACT"
        );
        assert_eq!(sender_id, self.owner, "ONLY_OWNER_DEPOSIT");
        assert_eq!(self.status, MandateStatus::Active, "MANDATE_NOT_ACTIVE");

        let new_deposited = self
            .deposited
            .0
            .checked_add(amount.0)
            .expect("DEPOSIT_OVERFLOW");
        self.deposited = U128(new_deposited);

        self.log_nep297(
            "deposited",
            json!({
                "mandate_id": 0,
                "sender": sender_id,
                "amount": amount,
            }),
        );

        PromiseOrValue::Value(U128(0))
    }

    pub fn request_payment(
        &mut self,
        recipient: AccountId,
        amount: U128,
        nonce: u64,
        callback_gas: Option<u64>,
    ) -> PromiseOrValue<PaymentResult> {
        let _ = nonce;
        // 1. predecessor == mandate.agent (panic if not predecessor)
        assert_eq!(
            env::predecessor_account_id(),
            self.agent,
            "UNAUTHORIZED_AGENT"
        );

        // 2. status Active
        if self.status != MandateStatus::Active {
            return self.reject("NOT_ACTIVE", &recipient, amount);
        }

        // 3. recipient in allowed list
        if !self.recipients.contains(&recipient) {
            return self.reject("RECIPIENT_NOT_ALLOWED", &recipient, amount);
        }

        // 4. amount > 0 and amount <= per_payment_cap
        if amount.0 == 0 || amount.0 > self.per_payment_cap.0 {
            return self.reject("OVER_PER_PAYMENT_CAP", &recipient, amount);
        }

        // 5. open_requests < MAX_OPEN
        if self.open_requests >= MAX_OPEN {
            return self.reject("TOO_MANY_OPEN", &recipient, amount);
        }

        // 6. budget check (checked arithmetic)
        #[cfg(not(feature = "naive"))]
        {
            let needed = match self
                .spent
                .0
                .checked_add(self.reserved.0)
                .and_then(|v| v.checked_add(amount.0))
            {
                Some(v) => v,
                None => return self.reject("ARITHMETIC_OVERFLOW", &recipient, amount),
            };
            if needed > self.budget.0 {
                return self.reject("OVER_BUDGET", &recipient, amount);
            }
        }
        #[cfg(feature = "naive")]
        {
            // NAIVE: does NOT check reserved, only spent + amount <= budget
            let needed = match self.spent.0.checked_add(amount.0) {
                Some(v) => v,
                None => return self.reject("ARITHMETIC_OVERFLOW", &recipient, amount),
            };
            if needed > self.budget.0 {
                return self.reject("OVER_BUDGET", &recipient, amount);
            }
        }

        // 8. Write upfront
        let request_id = self.next_request_id;
        self.next_request_id += 1;

        #[cfg(not(feature = "naive"))]
        {
            let new_reserved = self
                .reserved
                .0
                .checked_add(amount.0)
                .expect("RESERVED_OVERFLOW");
            self.reserved = U128(new_reserved);
        }
        #[cfg(feature = "naive")]
        {
            // NAIVE: does NOT reserve upfront!
        }

        self.open_requests += 1;
        self.pending.insert(
            request_id,
            PendingRecord {
                recipient: recipient.clone(),
                amount,
                height: env::block_height(),
            },
        );

        self.log_nep297(
            "reserved",
            json!({
                "mandate_id": 0,
                "request_id": request_id,
                "recipient": recipient,
                "amount": amount,
            }),
        );

        // 9. Send ft_transfer and chain on_payment_done
        let callback_builder =
            ext_self::ext(env::current_account_id());

        let callback_promise = if let Some(raw_gas) = callback_gas {
            callback_builder
                .with_static_gas(Gas::from_gas(raw_gas))
                .with_unused_gas_weight(0)
                .on_payment_done(request_id)
        } else {
            callback_builder
                .with_unused_gas_weight(1)
                .on_payment_done(request_id)
        };

        let promise = ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .with_unused_gas_weight(0)
            .ft_transfer(recipient, amount, None)
            .then(callback_promise);

        PromiseOrValue::Promise(promise)
    }

    #[private]
    pub fn on_payment_done(&mut self, request_id: u64) -> PaymentResult {
        let pending = match self.pending.remove(&request_id) {
            Some(p) => p,
            None => {
                env::panic_str("PENDING_NOT_FOUND");
            }
        };

        let is_success = env::promise_result_checked(0, 1024).is_ok();

        self.open_requests = self.open_requests.saturating_sub(1);

        if is_success {
            #[cfg(not(feature = "naive"))]
            {
                let new_reserved = self
                    .reserved
                    .0
                    .checked_sub(pending.amount.0)
                    .expect("RESERVE_UNDERFLOW");
                self.reserved = U128(new_reserved);
            }

            let new_spent = self
                .spent
                .0
                .checked_add(pending.amount.0)
                .expect("SPENT_OVERFLOW");
            self.spent = U128(new_spent);

            self.log_nep297(
                "settled",
                json!({
                    "mandate_id": 0,
                    "request_id": request_id,
                    "recipient": pending.recipient,
                    "amount": pending.amount,
                }),
            );

            PaymentResult::Settled { request_id }
        } else {
            #[cfg(not(feature = "naive"))]
            {
                let new_reserved = self
                    .reserved
                    .0
                    .checked_sub(pending.amount.0)
                    .expect("RESERVE_UNDERFLOW");
                self.reserved = U128(new_reserved);
            }

            self.log_nep297(
                "refunded",
                json!({
                    "mandate_id": 0,
                    "request_id": request_id,
                    "recipient": pending.recipient,
                    "amount": pending.amount,
                }),
            );

            PaymentResult::Refunded {
                request_id,
                reason: "ft_transfer_failed".into(),
            }
        }
    }

    pub fn resolve_stale(&mut self, request_id: u64, transferred: bool) -> bool {
        assert_eq!(
            env::predecessor_account_id(),
            self.guardian,
            "GUARDIAN_ONLY"
        );

        let pending = match self.pending.remove(&request_id) {
            Some(p) => p,
            None => env::panic_str("PENDING_NOT_FOUND"),
        };

        self.open_requests = self.open_requests.saturating_sub(1);

        #[cfg(not(feature = "naive"))]
        {
            let new_reserved = self
                .reserved
                .0
                .checked_sub(pending.amount.0)
                .expect("RESERVE_UNDERFLOW");
            self.reserved = U128(new_reserved);
        }

        if transferred {
            let new_spent = self
                .spent
                .0
                .checked_add(pending.amount.0)
                .expect("SPENT_OVERFLOW");
            self.spent = U128(new_spent);

            self.log_nep297(
                "stale_resolved",
                json!({
                    "mandate_id": 0,
                    "request_id": request_id,
                    "transferred": true,
                    "recipient": pending.recipient,
                    "amount": pending.amount,
                }),
            );
        } else {
            self.log_nep297(
                "stale_resolved",
                json!({
                    "mandate_id": 0,
                    "request_id": request_id,
                    "transferred": false,
                    "recipient": pending.recipient,
                    "amount": pending.amount,
                }),
            );
        }

        true
    }

    pub fn revoke(&mut self) {
        assert!(
            env::predecessor_account_id() == self.owner
                || env::predecessor_account_id() == self.guardian,
            "ONLY_OWNER_OR_GUARDIAN"
        );
        self.status = MandateStatus::Revoked;
        self.log_nep297("revoked", json!({ "mandate_id": 0 }));
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_eq!(env::predecessor_account_id(), self.owner, "ONLY_OWNER");
        assert_eq!(self.status, MandateStatus::Revoked, "MUST_BE_REVOKED");
        let avail = self
            .deposited
            .0
            .checked_sub(self.spent.0)
            .and_then(|v| v.checked_sub(self.reserved.0))
            .expect("INSUFFICIENT_AVAILABLE_FUNDS");
        assert!(amount.0 <= avail, "AMOUNT_EXCEEDS_AVAILABLE");

        self.deposited = U128(self.deposited.0.checked_sub(amount.0).expect("UNDERFLOW"));

        self.log_nep297(
            "withdrawn",
            json!({
                "mandate_id": 0,
                "owner": self.owner,
                "amount": amount,
            }),
        );

        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(self.owner.clone(), amount, Some("withdraw".into()))
    }

    pub fn get_mandate(&self) -> MandateView {
        MandateView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            guardian: self.guardian.clone(),
            token: self.token.clone(),
            deposited: self.deposited,
            budget: self.budget,
            spent: self.spent,
            reserved: self.reserved,
            per_payment_cap: self.per_payment_cap,
            recipients: self.recipients.clone(),
            status: self.status.clone(),
            open_requests: self.open_requests,
            next_request_id: self.next_request_id,
        }
    }

    pub fn get_pending(&self, request_id: u64) -> Option<PendingRecord> {
        self.pending.get(&request_id).cloned()
    }

    /// Helper for testing Point 8: panic vs logs on NEAR testnet
    pub fn test_panic_with_log(&self, msg: String) {
        env::log_str(&format!("LOG_BEFORE_PANIC: {}", msg));
        env::panic_str("DELIBERATE_TEST_PANIC");
    }

    fn reject(
        &self,
        code: &str,
        recipient: &AccountId,
        amount: U128,
    ) -> PromiseOrValue<PaymentResult> {
        self.log_nep297(
            "rejected",
            json!({
                "mandate_id": 0,
                "code": code,
                "recipient": recipient,
                "amount": amount,
            }),
        );
        PromiseOrValue::Value(PaymentResult::Rejected {
            code: code.to_string(),
        })
    }

    fn log_nep297(&self, event: &str, data: serde_json::Value) {
        let event_json = json!({
            "standard": "scrip",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        });
        env::log_str(&format!("EVENT_JSON:{}", event_json));
    }
}
