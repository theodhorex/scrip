# AUDIT_1: Scrip contract + facilitator (independent review)

Scope: `contracts/scrip/src/lib.rs` (880 lines), tests/README/REPORTs skimmed, `facilitator/src/*.mjs`, PRD v1.2 s3/5.3/7.
Method: manual read, no network, no build. No PoC test was run (read-only rule); scenarios are traced by hand against the code.
Counts: critical 1, high 1, medium 3, low 4.

## Findings

### F1 [CRITICAL] Known issue CONFIRMED and worse than recorded: a withdrawn mandate can be revived and spend other mandates' tokens
Refs: lib.rs:486 (ceiling), lib.rs:651 (loosen Budget bound), lib.rs:645-646 + 673-676 (loosen Expiry), lib.rs:708 (withdraw allowed on expiry), lib.rs:692 (revoke subtraction).
Root cause: `ceiling = min(budget, deposited)` ignores `withdrawn`. Also `withdraw` is allowed when merely `now >= expires_at_ms` while status is still `Active` (PRD s3 line 94 says Revoked only), and `loosen` only checks `status == Active`, never that the mandate is unexpired.
All mandates of one token share ONE token balance in the contract, so the free-standing "ceiling" is the only thing keeping a mandate off other users' funds.
Scenario (permissionless, attacker needs 2 accounts, ~0.05 NEAR + dust):
1. A creates mandate M: owner=A, guardian=G (also attacker), agent=B, token=USDC, budget=cap=100, expiry = now+few seconds. A deposits 100 USDC. Victim mandates hold 10,000 USDC of the same token in the same contract.
2. After expiry A calls `withdraw(M,100)`: allowed (lib.rs:708), free=100, A receives 100. M.withdrawn=100, status still Active.
3. G calls `loosen(M, Expiry(later))` (lib.rs:673, status Active is the only gate). M is live again.
4. B calls `request_payment(M, recipient, 100)`: needed = spent 0 + reserved 0 + 100 <= min(100,100) passes. Contract `ft_transfer`s 100 USDC that belong to victims. Callback settles: spent=100.
Result: attacker nets +100 per cycle; repeat for any amount deposited, pool drained to zero. State is then spent+withdrawn=200 > deposited=100, violating PRD 5.3 #3.
Side effect: `revoke` at lib.rs:692 does `deposited - spent - reserved - withdrawn` with overflow-checks on (Cargo.toml) and panics, so the broken mandate can no longer be revoked.
Even without the loosen trick, a malicious/mistaken guardian is a cross-mandate risk (see F4).
Fix: ceiling = `min(budget, deposited - withdrawn)` (use `saturating_sub`), same bound in loosen Budget (651); make `loosen` reject expired mandates (and tighten/approve too) or forbid withdraw while Active (PRD says Revoked only); make revoke use `saturating_sub`. Add a test: deposit, expire, withdraw, loosen expiry, request_payment must be OVER_BUDGET.

### F2 [HIGH] Facilitator never checks the signing key is an access key of `senderId`: gas drain and rate-limit hijack
Refs: validate.mjs:49-59, relay.mjs:19-21.
validate only verifies that the signature matches the public key INSIDE the delegate action. Anyone can generate a fresh ed25519 key, set `senderId` to any `.testnet` id and sign. It passes (`ok:true`), consumes a bucket slot, and the relayer submits a real transaction (relay.mjs:24) that the chain rejects for the unknown access key, but the relayer still pays tx fees and burns gas on every attempt.
Scenarios:
- `allowedAgents` unset (README line 14 marks it optional): attacker uses a new random `senderId` per request, so the per-agent bucket never limits anything: unbounded relayer gas drain. Each request also grows the 10,000-entry map (ratelimit.mjs:19); flooding evicts real agents' buckets (ratelimit.mjs:10).
- `allowedAgents` set: attacker signs with a junk key as the real agent `a.testnet`, repeatedly: empties `a.testnet`'s bucket so the legitimate agent gets 429 (the comment at relay.mjs:19 claiming this cannot happen is wrong), while still burning relayer gas.
Fix: before rate-limit, query `view_access_key(senderId, publicKey)` (cached) and require `permission.FunctionCall` with `receiver_id == contractId` and methods subset of allowedMethods; require `allowedAgents` (fail closed at policy load if absent); add a per-IP limit and global limit on relays/min and a relayer balance floor.

### F3 [MEDIUM] Unpaid, unbounded `approvals` storage lets an attacker lock the contract's NEAR
Refs: lib.rs:573-594, lib.rs:238.
Anyone can make themselves guardian of a mandate (0.05 NEAR, lib.rs:367), then call `approve_intent` with unlimited distinct `nonce` values. Each call adds a permanent ~80-120 byte entry (about 0.001 NEAR of storage staking) paid by the contract, never by the caller, never deleted (also used/expired approvals stay forever; request_payment never removes them, lib.rs:523-527). Caller cost per call is only gas. About 50 calls consume the whole 0.05 deposit; thousands lock the contract's balance until contract calls fail with storage-staking errors, freezing payments and withdrawals for every mandate (settlement callbacks write state). Fix: require attached deposit per approval or charge storage to the guardian's mandate budget; cap approvals per mandate; delete the approval when it is used or on expiry.

### F4 [MEDIUM] `resolve_stale(transferred=false)` and withdraw interplay lets any guardian break conservation for the whole token pool
Refs: lib.rs:749-767, lib.rs:710-713.
The guardian's flag is unverified. If the guardian passes `false` for a transfer that actually landed, `reserved` is released without `spent` rising, so `free` (lib.rs:711) is overstated by `amount`, and the owner can `withdraw` tokens that belong to other mandates (same pooled balance); the budget is also re-spendable. Guardian = attacker is possible for their own mandate, but a stale pending cannot normally be forced (callback always runs), so this needs a real stuck callback (low likelihood) or a colluding owner/guardian with such an event. Mitigation: do not let guardian trust be unbounded; consider one contract/vault per token-owner, or make resolve_stale use a verified on-chain check (promise to `ft_balance_of`) or restrict `false` outcomes to pay nothing out until reconciled.

### F5 [MEDIUM] Withdraw callback failure strands funds, no recovery path
Refs: lib.rs:713, 731-741.
`withdrawn` is incremented before the transfer and restored only by `on_withdraw_done`. If the callback runs out of gas or fails (15 Tgas static; contract balance below storage-stake rules after F3 also fails it), `withdrawn` stays raised although the transfer failed, so the owner's tokens are permanently counted as withdrawn and no method (resolve_stale covers only `Pending`) can fix it. Scenario: withdraw 1000, FT receiver not registered, ft_transfer fails, callback OOG: owner funds lost. Fix: track withdrawals as pending entries with the same stale/resolve mechanism, or let the guardian/owner reconcile after a delay.

### F6 [LOW] Used approvals are consumed even if the transfer later fails
lib.rs:523-527 sets `used=true` at reserve; a refunded request (lib.rs:561) leaves the approval spent, so the guardian must re-approve with a new nonce. Fail-safe, but liveness cost. Also approval hash omits the token/mandate expiry change handling noted in README (fails safe).

### F7 [LOW] Storage per mandate can exceed the 0.05 NEAR deposit when Pending is full
lib.rs:39 sizes the deposit for the mandate plus 16 recipients (about 3.5 KB). Up to 32 Pending entries (~5 KB, lib.rs:17,519) are also paid by the contract. Entries are freed on callback, so the exposure is only the transient window, but any stuck pending (callback missing) keeps the contract paying. Low.

### F8 [LOW] Facilitator replay/dedupe and result reporting
relay.mjs:23-27: no dedupe of identical `signed_delegate` within the validity window; a replay hits the chain nonce check but still costs relayer gas and a bucket token. `relayMetaTransaction` success (`outcome.status`) only reflects the outer transaction; an inner `request_payment` failure (including INSUFFICIENT_GAS since validate.mjs:42 enforces only a max, not the 60 Tgas minimum) is reported as `ok:true`. Concurrent requests share one relayer key, so nonce races return `RELAY_FAILED` (availability only).

### F9 [LOW] Policy `rpcUrl` host check is weak
policy.mjs:26 accepts any https host containing the substring "testnet" (e.g. `testnet.attacker.example`): a malicious RPC could return fake heights or swallow signed delegates. Operator-controlled config, so low.

## Observations (no concrete exploit shown)
- lib.rs:698: `owner == guardian` or `owner == agent` is allowed; combined with F1/F4 this is what makes the attack self-contained. Consider forbidding `owner == guardian`.
- lib.rs:600-621 `tighten(PerPaymentCap)` can push cap below `approval_threshold`; harmless (stricter).
- lib.rs:338 `new()` has no access control; first caller initializes. No owner state is set, so impact is nil, but deploy+init should be in one batch.
- `token` and `agent`/`guardian` account ids are not validated against `validate_recipient`; no impact found.
- ft_on_transfer from a malicious token only affects mandates that already chose that token (lib.rs:436).
- Idempotence between `on_payment_done` and `resolve_stale` is safe: whichever runs second finds no Pending.
- main.mjs:17 re-validates an object after mutation; harmless.

## Checked and found sound
- Spending beyond per-payment cap, to non-listed recipient: steps 3-4 (lib.rs:474-480) run before any state write and use a fixed-account membership set; `RemoveRecipient` keeps set and list in sync (623-626). Approval cannot exceed cap (cap check precedes approval check).
- Approval binding: hash covers mandate id, length-prefixed recipient, amount, nonce, expiry (264-275), guardian-only creation, never overwritten (587), consumed once. No replay across mandates.
- Authorization uses predecessor everywhere (465, 582, 603, 645, 687, 707, 751); agent can never call tighten/loosen/revoke/withdraw/approve; owner cannot loosen; guardian cannot withdraw; function-call key cannot attach deposit and `request_payment` is non-payable.
- Reentrancy/ordering: reserve + Pending + approval consumption are written before the promise (512-527); callback removes Pending before reading the result (549), so double settle is impossible; Pending removed once in both callback and `resolve_stale`.
- ft_transfer failure: any failed result refunds (`is_ok` false, 552-563); open_requests/reserved decrement are checked. Missing callback leaves Pending, recoverable by guardian after 200 blocks.
- Gas: guard (457) precedes state; 15 + 15 static with weight 0 fits inside 60 Tgas; promise creation fails atomically if gas short, rolling back reserve.
- Arithmetic: overflow-checks enabled in release (Cargo.toml), checked_add on deposit/reserve/spent; u128 amounts as U128 strings; `Expiry as u128` safe. Only unchecked ops: lib.rs:692 (see F1) and 713 (bounded by `free`).
- MAX_OPEN bounds per-mandate pending; rejection path does not mutate state. `create_mandate` deposit blocks cheap contract-NEAR drain via mandates (but see F3 for approvals).
- Facilitator: strict canonical base64/borsh round trip (validate.mjs:14-25), single FunctionCall action, receiver pinned, zero deposit, max gas, block-height window, non-ed25519 rejected, body size capped (server.mjs:4,21), no key or body logging (server.mjs:54, main.mjs:19-23).
