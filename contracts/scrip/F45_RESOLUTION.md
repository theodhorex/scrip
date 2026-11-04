# F45: resolution of F4 and F5 (internal note, 3 Nov 2026)

This note records how two accepted limits from `AUDIT_1.md` (F4, F5) and their follow-ups in `AUDIT_2.md` (N-L1, N-I4) were handled. The audit files are history and are left unchanged. All review rounds so far are internal; there is no third-party audit.

## What the limits were
- **F4:** `resolve_stale(..., transferred=false)` released a stale reservation on the guardian's word alone. If the `ft_transfer` had in fact landed, the mandate's budget could be spent twice and the shared token pool came up short, which could make other mandates fail to withdraw.
- **F5:** `withdraw` raises `withdrawn` before the transfer. If its callback were lost, nothing restored it.

## What changed
- `resolve_stale` now rejects `transferred=false` with `STALE_REFUND_UNPROVABLE` (checked after the guardian check and the staleness check, before any state change). `transferred=true` is unchanged (`reserved -> spent`, ledger down). Method signatures are unchanged.
- Direction of any remaining error: a wrong `true` or a lost callback only locks funds inside the affected mandate. It cannot reduce what any other mandate can withdraw.
- The callbacks were checked, not assumed: the property test `p11_f5_callbacks_never_panic_and_invariants_hold` runs random operation sequences and asserts the accounting invariants after every step, and the sandbox test `f45_callback_gas_margin_settle_refund_and_withdraw` measures callback gas: 2.133 Tgas (settle), 1.779 Tgas (withdraw), 1.947 Tgas (refund) against 15 Tgas pinned, a margin of 7.0x to 8.4x. Gas constants were not changed.

## Verification (re-run 3 Nov 2026)
`cargo test --lib`: 127 passed. `cargo clippy --lib --tests -- -D warnings`: clean. `cargo test --test integration`: 20 of 20 passed on the rebuilt wasm (the KAT-E-04-15 repro test, added afterwards, passed in its own run; a single full run of all 21 will be repeated at the freeze). Sandbox attack catalog (layer D): 160 of 160 cases passed, 0 breaches.

## Alternative that was rejected
Comparing the real token balance (`ft_balance_of`) with the contract ledger before releasing a stale reservation looks verifiable but is not sound: a deposit in flight (balance already moved, `ft_on_transfer` not yet run) inflates the measured balance, so a guardian colluding with a depositor could pass the check while the transfer had in fact landed. It was dropped before being built.

## Residual limits (still true)
- If a callback were lost and the transfer had failed, that amount stays locked in its mandate (the owner's own funds in the `withdraw` case).
- A lost guardian key leaves a stale reservation unresolved (N-I4); only the guardian can settle it.
- The shared NEP-141 pool and trust in the token contract are unchanged (K-3).
