# amanat contract (K1 core + K2 guardian roles)

Rust, near-sdk 5.30.0 (pinned). Many mandates in one contract (PRD 3.1 to 3.6).

## Plan (written before coding)

1. Crate skeleton + state types (`Mandate`, `Pending`, `Approval`, views) and `create_mandate`.
2. `ft_on_transfer` (funding, full refund on any invalid condition).
3. Intent hash (pure fn, vector-driven test against `docs/vectors/intent_hash.json`).
4. `request_payment` (gas guard, steps 1 to 8: reserve, then step 9 `ft_transfer`).
5. `on_payment_done` callback (settle/refund, idempotent).
6. Views, events through one `emit` helper, README, Makefile targets.
7. Tests first (red), then code (green); `cargo test` after each slice; final self-review against PRD 3.3 and 5.3.

## Methods

| Method | Caller (predecessor) | Notes |
|---|---|---|
| `new()` | deployer | init |
| `create_mandate(agent, guardian, token, budget, per_payment_cap, approval_threshold, recipients, expires_at_ms) -> u64` | anyone becomes the owner | `#[payable]`: needs >= 0.05 NEAR (`STORAGE_DEPOSIT_PER_MANDATE`, panic `INSUFFICIENT_STORAGE_DEPOSIT`); exactly 0.05 NEAR stays in the contract, excess refunded to owner (K-B); rejects `owner == agent` with `OWNER_IS_AGENT` |
| `ft_on_transfer(sender_id, amount, msg)` (`msg={"mandate_id":N}`) | token contract | funding; any invalid case refunds in full |
| `request_payment(mandate_id, recipient, amount, nonce)` | agent only | not payable |
| `on_payment_done(mandate_id, request_id)` | contract itself (`#[private]`) | settle / refund |
| `approve_intent(mandate_id, recipient, amount, nonce, approval_expires_at_ms)` | guardian only | mandate Active; `#[payable]` >= 2 mNEAR (`STORAGE_DEPOSIT_PER_APPROVAL`), excess refunded to guardian (K-B); capped at 512 approvals per mandate (`TOO_MANY_APPROVALS`, K-C); `approval_expires_at_ms` in future; hash binds current `expires_at_ms`; duplicate panics `ALREADY_APPROVED` |
| `tighten(mandate_id, change)` | owner or guardian | Active; only stricter changes; preserves `budget >= cap >= threshold` (`BUDGET_BELOW_CAP`, `CAP_BELOW_THRESHOLD`, K-A) |
| `loosen(mandate_id, change)` | guardian only | Active; only looser changes within the bounds below |
| `revoke(mandate_id)` | owner or guardian | Active -> Revoked; in-flight requests still settle |
| `withdraw(mandate_id, amount)` | owner only | Revoked only (`MANDATE_STILL_ACTIVE` otherwise); `amount <= deposited - spent - reserved - withdrawn`; needs >= 60 Tgas |
| `on_withdraw_done(mandate_id, amount)` | contract itself (`#[private]`) | success: emit `withdrawn`; failure: restore `withdrawn` |
| `resolve_stale(mandate_id, request_id, transferred)` | guardian only | Pending older than `STALE_BLOCKS` (200); also on Revoked mandates |
| `get_mandate`, `get_pending`, `get_stats`, `get_approval(hash_hex)`, `intent_hash(...)` | anyone | views |

The agent can call exactly one state-changing method: `request_payment`.

### `change` (for `tighten` / `loosen`), JSON is stable

`{"Budget":"500"}`, `{"PerPaymentCap":"50"}`, `{"ApprovalThreshold":"10"}`, `{"AddRecipient":"shop.testnet"}`, `{"RemoveRecipient":"shop.testnet"}`, `{"Expiry":1893456000000}` (amounts are decimal strings, `Expiry` is u64 ms).

| Change | `tighten` accepts | `loosen` accepts |
|---|---|---|
| `Budget(x)` | `max(cap, spent + reserved) <= x < budget` | `budget < x <= deposited - withdrawn` |
| `PerPaymentCap(x)` | `threshold <= x < cap` | `cap < x <= budget` |
| `ApprovalThreshold(x)` | `x < threshold` | `threshold < x <= cap` |
| `AddRecipient(a)` | never | `a` new and valid, at most 16 recipients |
| `RemoveRecipient(a)` | `a` is in the list | never |
| `Expiry(t)` | `now < t < expiry` | `t > expiry` |

A wrong-direction change panics `NOT_STRICTER` / `NOT_LOOSER`; bound violations panic `BUDGET_BELOW_COMMITTED`, `BUDGET_BELOW_CAP` (K-A), `BUDGET_ABOVE_DEPOSITED`, `CAP_BELOW_THRESHOLD` (K-A), `CAP_ABOVE_BUDGET`, `THRESHOLD_ABOVE_CAP`, `EXPIRY_NOT_IN_FUTURE`, `NO_SUCH_RECIPIENT`, `DUPLICATE_RECIPIENT`, `TOO_MANY_RECIPIENTS`. All panic codes live in `amanat::err`.

### `withdraw` is the owner's exit path and bypasses the rules by design

Once a mandate is revoked the owner can take back the free remainder of the deposit. This skips the recipient list, caps and approvals on purpose: the money is the owner's, and the only destination is the owner. It cannot touch `spent` or `reserved` funds. `withdrawn` goes up BEFORE the transfer; if the transfer fails the callback puts it back.

### Approval hash and expiry

The approval hash uses the mandate's current `expires_at_ms`. Changing the mandate's expiry (either way) makes earlier approvals stop matching: the agent then gets `NEEDS_APPROVAL` (fails safe) and the guardian approves again. `approval_expires_at_ms` is only the approval's own validity time.

`amanat::hash::{intent_hash, validate_recipient}` are the pure functions (in a module because the exported view is also named `intent_hash`).

## Rejection codes (successful call, `Rejected{code}` + `rejected` event)

Checked in this order; the first failure wins: `NOT_ACTIVE`, `EXPIRED`, `RECIPIENT_NOT_ALLOWED`, `OVER_PER_PAYMENT_CAP` (also amount 0), `TOO_MANY_OPEN`, `OVER_BUDGET` (also u128 overflow, and amount beyond `deposited`), `NEEDS_APPROVAL`, `APPROVAL_USED`, `APPROVAL_EXPIRED`.
Panics (state rolled back): `UNAUTHORIZED_AGENT` (predecessor is not the agent), `MANDATE_NOT_FOUND`, `INSUFFICIENT_GAS` (prepaid < 60 Tgas, checked before anything else).

## Events (NEP-297, standard `amanat`, version `1.0.0`)

Every `data[0]` has `mandate_id`, `recipient`, `amount` (decimal string), as the client parser requires.

| Event | Extra fields | `recipient` / `amount` mean |
|---|---|---|
| `mandate_created` | `owner, guardian, agent, token, per_payment_cap, approval_threshold, expires_at_ms` | agent / budget |
| `deposited` | none | owner / deposited amount |
| `reserved`, `settled`, `refunded` | `request_id` | payee / payment amount |
| `rejected` | `code` | requested payee / requested amount |
| `intent_approved` | `nonce, approval_expires_at_ms, intent_hash` | approved payee / amount |
| `tightened`, `loosened` | `by, change` | affected recipient (else the agent) / new numeric value (0 for recipient changes; new expiry ms for `Expiry`) |
| `revoked` | `by` | owner / free remainder at revoke time |
| `withdrawn` (emitted by the callback, success only) | none | owner / amount |
| `stale_resolved` | `request_id, transferred` | payee / payment amount |

## Gas assumptions (PRD 3.6, measured on testnet)

`request_payment` requires prepaid gas >= 60 Tgas. `ft_transfer` gets a static 15 Tgas and the callback a static 15 Tgas, both with unused-gas weight 0. A valid payment burns about 7.3 Tgas in total. If the callback runs out of gas the transfer still lands while `reserved` and `Pending` stay stuck: that is what K2 `resolve_stale` is for. `ft_transfer` (never `ft_transfer_call`) with 1 yocto from the contract's own balance.

## Storage estimate (computed, not measured on chain)

NEAR charges 1e19 yocto per byte (0.00001 NEAR) including ~40 bytes of per-record overhead.
- `Pending`: about 111 bytes (PRD 3.1 figure) = about 0.0011 NEAR, freed in the callback; bounded by `MAX_OPEN = 32` per mandate.
- Mandate record: about 240 bytes of value (4 account ids of ~20 chars, 7 u128, 2 u64, 2 counters) + key + overhead = roughly 0.0035 NEAR.
- Recipients: about 75 bytes per set entry + about 24 bytes per list entry = about 0.001 NEAR per recipient (max 16: about 0.016 NEAR).
- So one mandate with 16 recipients is about 0.02 NEAR. `create_mandate` therefore requires 0.05 NEAR attached (margin), kept by the contract. The agent cannot create mandates for free, so it cannot drain the storage balance.

## Design notes

- Auth is `predecessor_account_id` only.
- Effective spending ceiling is `min(budget, deposited.saturating_sub(withdrawn))`: PRD 5.3 #1 says `budget <= deposited - withdrawn`; `create_mandate` runs before deposit and withdrawals reduce free funds, so step 6 enforces this ceiling `min(budget, deposited.saturating_sub(withdrawn))` at request time (fixed in F1).
- The approval lookup hashes with the mandate's current `expires_at_ms` (the agent supplies only the nonce). `approve_intent` hashes with the same value.
- `recipient_lists` (ordered list for views) sits next to the `recipients` LookupSet (O(1) membership); `tighten`/`loosen` add/remove update both (tested).
- Callback on a missing `Pending` returns `AlreadyResolved{request_id}` and changes nothing.

## Immutability & Upgrade Policy (K-E / K-11)

The Amanat contract is designed to be **immutable** for the hackathon:
- Kontrak bersifat **immutable, tanpa migrate**; tidak ada mekanisme migrasi kode atau fungsi upgrade (tidak ada `#[init(ignore_state)]`, tidak ada fungsi `migrate`).
- **Kunci kontrak dihapus setelah init pada deploy demo** (full-access keys dihapus setelah inisialisasi).
- Transisi status kontrak dan perubahan aturan hanya dapat terjadi melalui metode yang didefinisikan secara ketat (`tighten`, `loosen`, `revoke`, dsb.) yang diverifikasi oleh `predecessor_account_id`.

## Threat Model & Token Balance Isolation (K-F / K-3)

- **Saldo token dipakai bersama (K-3)**: Kontrak menyimpan token NEP-141 pada saldo akun kontrak bersama untuk seluruh mandat yang menggunakan token tersebut.
- **Batas yang diakui (Acknowledged Boundary)**: Akuntansi kontrak memisahkan limit pembukuan (`deposited`, `spent`, `reserved`, `withdrawn`) per mandat. Namun, karena saldo token berada di akun kontrak bersama di tingkat kontrak NEP-141, cacat akuntansi teoretis dapat mempengaruhi saldo bersama tersebut.
- **Mitigasi**: Menerapkan mitigasi **satu kontrak per owner** atau per domain kepercayaan terisolasi.
- **Pekerjaan lanjutan**: Penerapan **allowlist token sebagai pekerjaan lanjutan** (token allowlist enforcement) serta isolasi brankas sub-akun per mandat.
