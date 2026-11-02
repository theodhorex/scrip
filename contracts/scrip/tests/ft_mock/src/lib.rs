//! Minimal NEP-141 TEST DOUBLE for the token only (never for Scrip).
//! `strict` (default true): `ft_transfer` panics for receivers that did not call
//! `storage_deposit`, like a real FT. `ft_mint` registers the account.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

#[ext_contract(ext_receiver)]
pub trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128;
}
#[ext_contract(ext_self)]
pub trait SelfCb {
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ft {
    balances: LookupMap<AccountId, u128>,
    registered: LookupSet<AccountId>,
    strict: bool,
}

#[near]
impl Ft {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b"), registered: LookupSet::new(b"r"), strict: true }
    }
    pub fn set_strict(&mut self, strict: bool) {
        self.strict = strict;
    }
    pub fn ft_mint(&mut self, account_id: AccountId, amount: U128) {
        self.registered.insert(account_id.clone());
        let b = self.bal(&account_id);
        self.balances.insert(account_id, b + amount.0);
    }
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let a = account_id.unwrap_or_else(env::predecessor_account_id);
        self.registered.insert(a);
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.bal(&account_id))
    }
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert!(env::attached_deposit() == NearToken::from_yoctonear(1), "REQUIRES_1_YOCTO");
        let _ = memo;
        self.transfer(&env::predecessor_account_id(), &receiver_id, amount.0);
    }
    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> Promise {
        env::log_str("ftc1");
        assert!(env::attached_deposit() == NearToken::from_yoctonear(1), "REQUIRES_1_YOCTO");
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.transfer(&sender, &receiver_id, amount.0);
        env::log_str("ftc2");
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(40))
            .with_unused_gas_weight(0)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result(0) {
            PromiseResult::Successful(v) => near_sdk::serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            PromiseResult::Failed => amount.0,
        };
        let refund = unused.min(self.bal(&receiver_id));
        if refund > 0 {
            let r = self.bal(&receiver_id);
            self.balances.insert(receiver_id, r - refund);
            let s = self.bal(&sender_id);
            self.balances.insert(sender_id, s + refund);
        }
        U128(amount.0 - refund)
    }
}

impl Ft {
    fn bal(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }
    fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        assert!(amount > 0, "ZERO_AMOUNT");
        assert!(self.registered.contains(to), "RECEIVER_NOT_REGISTERED");
        let f = self.bal(from);
        assert!(f >= amount, "NOT_ENOUGH_BALANCE");
        self.balances.insert(from.clone(), f - amount);
        let t = self.bal(to);
        self.balances.insert(to.clone(), t + amount);
    }
}
