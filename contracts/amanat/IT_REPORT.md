# K3 IT_REPORT: sandbox integration tests of the real amanat.wasm

## Result
- `make -C /home/theo/Documents/dev/hackathon/amanat contract-it`: **18 passed, 0 failed** (builds amanat.wasm release + tests/ft_mock wasm, then `cargo test --test integration -- --test-threads=1`). NOT part of `make test` (needs network for the sandbox binary; the binary itself is cached at `~/.near/near-sandbox-2.14.0`).
- Runtime ~4.5-5 min (sandbox-heavy tests). Run scenario groups separately if needed.

## Coverage matrix F1..F11 -> integration test
| Feature | Test(s) in tests/integration.rs |
|---|---|
| F1 create + fund via real cross-contract `ft_transfer_call` | `f1_f2_full_flow_merchant_paid_and_invariants` (+ event field checks) |
| F2 request -> merchant balance up, spent up, reserved 0, events (`deposited`, `reserved`, `settled`, no `rejected`) | same as F1 |
| F3 recipient not allowed | `f3_recipient_not_allowed` |
| F3 cap+1 rejected, cap passes | `f3_cap_plus_one_rejected_cap_passes` |
| F4 over-budget boundaries (exact remaining passes, +1 rejected) | `f4_over_budget_exact_remaining_passes_plus_one_rejected` |
| F4 expired (`fast_forward` past expiry) | `f4_expired_mandate_rejects`, `audit_f1_expired_mandate_cannot_withdraw_then_revive` |
| F4 revoked | `f4_revoked_mandate_rejects`, `f11_...` |
| F4 approval needed / used / expired | `f4_approval_needed_used_and_expired` |
| F6 recipient not FT-registered: transfer fails, callback refunds, `reserved` returns, `refunded` event, custody intact | `f6_unregistered_receiver_transfers_fail_and_callback_refunds` |
| Mode B gas guard (< 60 Tgas -> `INSUFFICIENT_GAS`; exactly 60 accepted) | `mode_b_request_with_prepaad...` (exact names in file) |
| F7 guardian-only: agent/stranger/owner denied, guardian allowed; tighten owner allowed | `f7_guardian_only_methods_reject_agent_stranger_owner` |
| F8 approval round trip, hash mismatch (amount/recipient), replay -> `APPROVAL_USED`, tightens-expiry invalidates approval | `f8_hash_mismatch_and_replay`, `f8_tightening_expiry_invalidates_stored_approval` |
| F11 withdraw before revoke fails; after revoke only the free remainder; conservation to zero | `f11_withdraw_before_revocation_fails_then_free_remainder_only` |
| F5 concurrency (20 parallel vs budget of 5), reserve-before-transfer | `f5_twenty_parallel_requests_never_exceed_budget` |
| F13 minimal random sequences (seeded, 300 calls, mixed callers) | `random_call_sequences_keep_invariants` |
| Invariants after every step | `check_invariants(env, id)` called after every step of every scenario |

## Concurrency numbers (F5)
- 20 request_payment submitted concurrently (one access key per tx, all keys owned by the single agent account; `tokio::spawn` + collect, not `tokio::join!` of raw handles).
- Outcome: **accepted=5, over_budget=15 (REJECTED OVER_BUDGET), other=0**.
- Final state: `spent=500 <= budget=500`, `reserved=0`, `open_requests=0`, merchant received exactly 500 (paid == accepted * cap == budget).

## Random-sequence test (F13 minimal)
- Written-by-me seeded xorshift: `Rng(seed)`; seed=0x5eeda11a2026, 300 steps of mixed
  `request_payment / approve_intent / tighten / loosen / withdraw / revoke / resolve_stale`
  calls from owner/guardian/agent/stranger; from step 100 the mandate is revoked and the
  callers mostly withdraw (exit phase). `check_invariants` after EVERY call.
- Counts: ok=101, failed=199 (by method: request_payment 58 ok/3 failed; approve_intent 10/10;
  tighten 4/17; loosen 6/36; resolve_stale 0/30 (all `NOT_STALE_YET`); withdraw 22/103; revoke 1/0).
  `is_success()` counts both accepted and policy-rejected results (both are valid, state may move).
  Final: spent=1361, reserved=0, withdrawn=8634, status=Revoked, all invariants held.

## Bugs / findings
1. **On-chain panic messages are unobservable (build-profile issue, NOT a logic bug).**
   In this sandbox (near-sandbox-2.14.0) and this wasm release profile (opt-level z, lto,
   strip), EVERY wasm panic — including `env::panic_str` — surfaces as a bare
   `WebAssembly trap: An 'unreachable' opcode was executed.` with NO panic message and no
   log. Verified with a probe calling `env::panic_str("MOCK_PANIC_PROBE")` directly.
   Integration tests therefore assert "tx failed" for panics and cannot pin the code text;
   the codes are pinned by the K1/K2 unit tests. Risk to operators: on-chain error
   diagnosis loses the code. Suggested follow-up for the PM: investigate the release
   profile/build-std `panic` handling (do NOT change src/).
2. No contract bugs found: all rejection codes, the F6 refund round trip, the gas floor,
   roles, approval binding and fund conservation behaved exactly as K1/K2 report.
3. Sandbox timestamp calibration: `fast_forward(100)` ~= 1 minute of chain time on this
   machine (measured by `sandbox_time_fast_forward_advances_chain_time`).

## Mode B (`resolve_stale`) coverage decision
End-to-end "callback out of gas" cannot be reproduced here: the contract enforces STATIC
default callback gas with unused-gas weight 0, so the `ft_transfer` receipt cannot burn
into the callback's gas; an FT mock can never refuse to answer because the CALLBACK
promise is chained on the transfer by the CONTRACT, not by the mock. Creating an
artificial stale Pending without mocking Amanat itself is not possible, so per the task
`resolve_stale` remains covered by the K2 unit tests (both branches, double call, revoked
mandate) and the integration level asserts the INSUFFICIENT_GAS guard at 59/60 TGas.

## Skills dipakai
- planning-and-task-breakdown: this file starts with the coverage matrix F1..F11.
- incremental-implementation: slice per scenario group (F1/F2 -> F3/F4 -> F6/Mode B/F7 -> F8/F11 -> F5/F13), `cargo test --test integration` after each.
- test-driven-development: F6 was written against expected behavior where merchant-not-registered must refund; F4-over-budget showed red against a stale burnt gas prior helpers slice and was re-derived; all groups first written, then run to green (honest note: red was demonstrated for the compile-broken helpers and the wrong invariant, not per scenario).
- debugging-and-error-recovery: root-caused three separate misbehaviors (compile-broken helpers, stale ft_mock wasm, unregistered-receiver NEP-141 semantics) before changing anything; findings reported above.
- security-and-hardening: attacker-minded cases included: agent calling owner/guardian methods, replayed used approvals, over-cap and over-budget amounts, stranger recipients, second withdraw after drains.
