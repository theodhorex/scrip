# CORRECTIONS_E_CAT1_6_7_11: harness and expected.code vs `facilitator/src/*.mjs` and `lib.rs`

PM evidence: `.agy/catalog-out/final2/wave{7,8,9}.json` (BREACH = 0). All findings below are harness/spec FAILs,
not leaks. The label (BLOCKED/INERT) was not changed on any case. No network was used in this work;
the evidence is the offline test `test/relay-attack.test.mjs`, which runs the real facilitator code.

## (A) Category 6: the attack was never sent

Root cause (proven from the code): the relay branch of `executeLayerE` (`layers/testnet.mjs`, before the fix around lines 2238-2283) only
read `forgedKey`, `senderId`, `nonce`, `gas`, `method`, `args`. The parameters `keyAllowedMethods`, `keyType`, `keyAllowance`,
`keyReceiverId`, `delegateReceiverId`, `maxBlockHeight`, `actionsCount`, `invalidSignature` were ignored; `maxBlockHeight` was always
head+100, the receiver was always the contract, there was one action, and the key was always the valid `agent.fcKey`. The valid delegate was relayed, and the result
"Transaction confirmed" = INERT (KAT-E-06-01..08, 12, 13, 16, 17). Seeded cases 18..45 did not even have attack parameters.

Fix: `layers/relay_attack.mjs` (`planRelayAttack`, `buildAttackDelegate`) applies every parameter and fails closed if a
parameter is broken; the attacked key is actually created on the agent account (`addFunctionCallAccessKey` / `addFullAccessKey`); if it cannot be
created or the key nonce cannot be read, the case is `SKIPPED` (not a verdict). The decision still belongs to the facilitator `/relay`. Seeded cases were given
attack parameters matching their titles.

| case | old code | new code | evidence |
| --- | --- | --- | --- |
| 06-01..03 key other method | `KEY_NOT_ALLOWED` | same | keycheck.mjs:13 (`method_names.every(in allowedMethods)`) |
| 06-04 FullAccess | `KEY_NOT_ALLOWED` | same | keycheck.mjs:10-11 (`'FullAccess'` is not a FunctionCall object) |
| 06-05 allowance 0 | `KEY_NOT_ALLOWED` | same | keycheck.mjs:14-16 |
| 06-06 key receiver usdc | `RECEIVER_NOT_ALLOWED` | `KEY_NOT_ALLOWED` | keycheck.mjs:11 (`receiver_id !== contractId`); `RECEIVER_NOT_ALLOWED` does not exist in the facilitator |
| 06-07, 06-08 delegate other receiver | `RECEIVER_NOT_ALLOWED` | `WRONG_RECEIVER` | validate.mjs:98 |
| 06-11 random key (forged) | `INVALID_SIGNATURE` | `KEY_NOT_ALLOWED` | signature is valid, key does not exist on the account: keycheck.mjs:60-66; the real wave7 result is also `KEY_NOT_ALLOWED` |
| 06-12 payload changed after signing | `INVALID_SIGNATURE` | `BAD_SIGNATURE` | validate.mjs:134. Note: a bit flip in the method name hits `METHOD_NOT_ALLOWED` (validate.mjs:102) first, so the nonce field is what gets changed |
| 06-13 past maxBlockHeight | `EXPIRED_DELEGATE` | `EXPIRES_TOO_SOON` | validate.mjs:84, called from relay.mjs:201 |
| 06-14 nonce 1 | `INVALID_NONCE` | `NONCE_TOO_LOW` | relay.mjs:224-225; the real wave7 result is the same |
| 06-15 nonce 0 | `INVALID_NONCE` | `NONCE_INVALID` | validate.mjs:121; the real wave7 result is the same |
| 06-16, 06-17 0 / 2 actions | `ACTION_NOT_ALLOWED` | `WRONG_ACTION_COUNT` | validate.mjs:99 |
| 06-09, 06-10 agent of another mandate | `UNAUTHORIZED_AGENT` | same | lib.rs:505 (already PASS in wave7) |
| seeded: forged signature | `INVALID_SIGNATURE` | `BAD_SIGNATURE` (param `invalidSignature`) | validate.mjs:134 |
| seeded: expired | `EXPIRED_DELEGATE` | `EXPIRES_TOO_SOON` (param `maxBlockHeight: 100`) | validate.mjs:84 |
| seeded: nonce | `INVALID_NONCE` | `NONCE_TOO_LOW` (param `nonce: 1`) | relay.mjs:225 |
| seeded: cross-mandate | `UNAUTHORIZED_AGENT` | same (param `agentIndex` 1/2, mandate 1) | lib.rs:505 |

Facilitator check order used (it determines the code when several conditions are wrong at once): validate.mjs:95-134 (offline) ->
dedupe -> expiry (relay.mjs:201) -> keycheck (relay.mjs:213-219) -> nonce (relay.mjs:224).

## (B) Category 7: gas code names

The facilitator rejects gas at `validate.mjs:105` (`GAS_TOO_LOW`) and `:106` (`GAS_TOO_HIGH`), before the contract is called. Expected
`INSUFFICIENT_GAS` / `EXCEEDS_MAX_GAS` was replaced with `GAS_TOO_LOW` / `GAS_TOO_HIGH` for all KAT-E-07 (relay path). `INSUFFICIENT_GAS`
remains correct as a CONTRACT code (`lib.rs:497`, direct call) and was not changed in the contract `README`/`REPORT`/`IT_REPORT`,
`approval_lifecycle.mjs:326`, or `comparison.mjs`. `grep -r INSUFFICIENT_GAS` in `web/`, `client/`, `facilitator/`: there are no
users of the old name for the relay path.

## (C) Category 1: uppercase and illegal characters

`validate.mjs:50-51` (`ACCOUNT_RE` = lowercase letters/digits with `-_.`, length <= 64) rejects the recipient with `BAD_CALL_ARGS` (HTTP 400)
before the mandate allowlist (which exists only in the contract, `lib.rs:514`). Expected was changed to `BAD_CALL_ARGS` for KAT-E-01-06 (uppercase),
-07 (mixed), -08/-09 (space), -10 (tab), -11 (Cyrillic homoglyph), -16 (empty string). Recipients with a valid form (subaccount, 64-hex,
nonexistent account, seeded) stay `RECIPIENT_NOT_ALLOWED` because they pass `ACCOUNT_RE` and are rejected by the contract. KAT-E-01-14.. SKIPPED INFRA_ERROR 502:
only need a rerun, not changed.

## (D) Category 11: ft_on_transfer

Root cause: `ft_on_transfer` NEVER panics and has no `INVALID_TOKEN`, `ZERO_AMOUNT`, `MANDATE_NOT_FOUND`, `NOT_ACTIVE`,
`INVALID_MSG` codes. A failed message parse (`lib.rs:464-466`), a missing mandate (`468-470`), `m.token != predecessor || m.owner != sender_id ||
status != Active` (`471-473`), and overflow (`474-480`) all return the full amount as "unused" with no event (doc `455-456`).
So the transaction is always "confirmed"; the old harness called it INERT even though the funds were fully refunded.

Fix:
- (i) Cases with a fake caller (`fake_usdc`, `malicious_token`, `counterfeit_token_*`): these names fall back to the real stranger account
  (`getCallerAccount`), so the stranger calls `ft_on_transfer` directly, predecessor != token (`lib.rs:471`). `classifyFtOnTransfer`
  reports BLOCKED/`FULL_REFUND` only if the return value == amount, there is no `deposited` event, and the mandate state is unchanged;
  a deposit or a state change becomes INERT/BREACH. Expected for all BLOCKED rows in category 11 became `FULL_REFUND`; the original branch is kept in
  `params.refundReason` (for the Rust tests).
- (ii) Cases with the `usdc.testnet` caller (valid token): these now actually RUN. The funder calls `ft_transfer_call` on the real USDC
  contract with `receiver_id` = the session contract and the case's `msg`, so the token becomes the `ft_on_transfer` predecessor (`lib.rs:463-473`).
  `classifyTokenCallerOutcome` (`layers/relay_attack.mjs`, test `test/token-caller.test.mjs`) reports BLOCKED/`FULL_REFUND` only if
  all four pieces of evidence hold: the sender's USDC balance is unchanged, the contract's USDC balance is unchanged, there is no `deposited` event, and the mandate state is
  unchanged. A consistent deposit becomes INERT (KAT-E-11-01, legitimate funding). Balance differences that do not mirror each other become BREACH
  (`LEDGER_MISMATCH`). Evidence that cannot be read (network error) becomes `SKIPPED/INFRA_ERROR`, not a verdict.
  Still `SKIPPED` / `TOKEN_REJECTS_INPUT`: zero amount (KAT-E-11-04), because the USDC token rejects before the contract is reached; this is covered by Rust tests
  and is not counted as a pass. Note: KAT-E-11-01 previously "PASSED" by coincidence (the stranger received a refund, not a deposit).

## Covered outside testnet

The `ft_on_transfer` branches in (ii) are proven by Rust tests: `contracts/scrip/src/tests.rs`, section `// ---------- ft_on_transfer ----------`
(line 331 onward, including the non-JSON msg at line 371) and `contracts/scrip/src/attack_tests4.rs` (KAT-A-11-01..66: fake token 66, sender
not owner 106, mandate not found 146, broken msg 182, zero amount 229, revoked mandate 272; the evaluator `evaluate_ft_on_transfer_inert` in
`attack_tests.rs:280` requires a full refund and unchanged state). This is indirect evidence; no layer E pass is claimed.

## Tests

`test/relay-attack.test.mjs` (18 tests, positive and negative): each attack parameter is applied and then run through the real facilitator's
`validateSignedDelegate`, `checkExpiry`, `createKeyVerifier`; negative controls (a valid delegate passes, a broken parameter throws,
a partial refund/changed state is never BLOCKED); catalog invariants (every category 6 case has an attack parameter and a code the
facilitator can produce).
