# AUDIT_2: Scrip contract + facilitator (round 2, post-fix)

Scope: `contracts/scrip/src/lib.rs` (885 lines now), `facilitator/src/*.mjs` (7 files). Read-only on source.
Verified by running: `cargo test --lib` 95/95 pass, `node --test` 46/46 pass. Everything else is traced by hand (marked VERIFIED = traced against code, SUSPECTED = plausible, needs a runtime check).
Counts: critical 0, high 0, medium 2, low 5, info 5.

## Round-1 fix verification

- F1 (withdraw/revive): FIXED and complete. VERIFIED.
  - Ceiling is `min(budget, deposited.saturating_sub(withdrawn))` (lib.rs:489); loosen Budget uses the same bound (656).
  - `withdraw` requires `status == Revoked` (712). `Revoked` is terminal: every mutator (`loosen`, `tighten`, `approve_intent`, `ft_on_transfer`, `request_payment`) requires `Active`, and nothing sets Active again.
  - Conservation: while Active `withdrawn == 0` (only `withdraw` raises it and it needs Revoked), so reserve/spend are bounded by `deposited`. After Revoke no new reserve occurs, and `withdraw` bounds `withdrawn` by `deposited - spent - reserved - withdrawn`. In-flight Pending settle or refund keep `spent+reserved+withdrawn <= deposited`. Invariant `spent+reserved+withdrawn <= deposited` holds on every path except `resolve_stale(false)` (accepted F4).
  - `revoke` now uses `saturating_sub` (697), so it can no longer panic.
  - Owner can always exit: owner may call `revoke` itself (692), the guardian cannot block it. No remaining way to revive an expired or withdrawn mandate.
- F3 (approval deposit): FIXED. VERIFIED. 2 mNEAR (`STORAGE_DEPOSIT_PER_APPROVAL`, 585) is checked before any state write and kept. Real storage per approval is about 82 bytes (~0.0008 NEAR), so each call nets the contract a profit; unauthorized callers panic and are refunded. See N-L3 for the residual (no cap, never deleted, harmless economically).
- F2 (access-key check): FIXED. VERIFIED. `keycheck.mjs` runs after `validate` (which already enforces the mandatory non-empty `allowedAgents`, policy.mjs fail-closed) and before any rate-limit token is spent (relay.mjs:26). It requires a FunctionCall key with `receiver_id == contractId`, a non-empty method list that is a subset of `allowedMethods`, and a non-zero allowance. FullAccess and empty-method (all methods) keys are rejected. Not-found errors are matched by class name; any other error is `UPSTREAM_ERROR` and is not cached. Limits: see N-M2, N-L4.
- F8 (outer success / gas): PARTIAL. `minGas >= 60 Tgas` is enforced (validate.mjs:42) and the response states the outer-only meaning (`OUTER_NOTE`, `outer_tx_succeeded`). A global bucket was added. Replay dedupe was NOT added (N-L2). Only the honest labeling and min gas were fixed.
- F9 (rpcUrl): FIXED. VERIFIED. Exact https host allowlist, no userinfo, local hosts only with `allowLocalRpc`, and `main.mjs` re-checks the effective URL (RPC_URL env included) with the strict default.
- F4 and F5: accepted known limits, unchanged (resolve_stale flag trust, withdraw callback failure). Not re-reported except where the interplay changed (N-L1).

## New findings

### N-M1 [MEDIUM] Pre-authentication RPC amplification: every POST /relay costs at least one upstream RPC call, with no limiter in front. VERIFIED (by code trace).
Refs: relay.mjs:13-21 (viewBlock first), server.mjs:58-62 (no IP or connection limit), near-api-js `withBackoff` wrapping.
`provider.viewBlock` runs before decoding or any validation. Anyone can POST garbage (even a 10-byte `signed_delegate`) at line rate; each request triggers an RPC call (plus the provider's own retry/backoff). The per-agent and global buckets only apply after validate and the key check, so they never see this traffic. Impact: exhaust the operator's RPC quota or rate limit; once the upstream returns 429, every legitimate agent gets `UPSTREAM_ERROR`. No funds at risk, availability only.
Fix: decode and validate offline first (reject `BAD_ENCODING`, wrong agent, wrong method before touching the network); cache the block height for about 1 s (height only needs to be roughly current); add an IP-based token bucket in front of `/relay` and a cap on concurrent in-flight relays.

### N-M2 [MEDIUM] Concurrent relays share one relayer key and race on nonce; token is spent before submit. VERIFIED by code, SUSPECTED at runtime.
Refs: relay.mjs:34-41, main.mjs:25-26.
`relayerAccount.relayMetaTransaction` builds a transaction with a freshly fetched access-key nonce per call; there is no mutex or nonce allocator. The configured burst (global capacity 30, per-agent capacity N) allows many concurrent requests, so simultaneous requests can reuse a nonce and all but one fail with `RELAY_FAILED` (502). The per-agent and global tokens are already consumed, so an agent retrying under load keeps hitting 429 (self-inflicted DoS; a hostile allowed agent can also use bursts to starve others by exhausting the shared global bucket, since the global bucket is taken after the per-agent one). Also, if `relayMetaTransaction` times out after broadcast, the response is `RELAY_FAILED` although the delegate may have landed; a client that treats it as "not sent" and re-signs a new delegate (new nonce) would issue a second payment. The contract does not dedupe payments by client intent.
Fix: serialize submission through a single-flight queue (promise chain) per relayer key, or use a key pool; refund the token on `RELAY_FAILED` before broadcast; return tx hash/pending state on timeout; document that clients must re-use the same signed delegate on retry (chain nonce makes it idempotent).

### N-L1 [LOW] Withdraw/guardian interplay: `resolve_stale(false)` + `owner == guardian` makes the accepted F4 self-contained. VERIFIED (logic), exploit needs a stuck callback.
Refs: lib.rs:753-772, 374 (only `guardian != agent` is enforced), README accepted-limit note.
Unchanged from F4 but the F1 fix moved the cross-mandate theft entry point to here: a single attacker account as owner+guardian (agent a second account) who can make a callback stick can mark a landed transfer as not transferred, then `revoke` + `withdraw` the reserved amount from the shared pool. I found no way for the attacker to force a stuck callback (callback gas is a fixed 15 Tgas and the work is small). Residual risk is any token contract that makes the callback fail (see N-I1). Cheap hardening: require `owner != guardian` in `create_mandate`; for `transferred == false` verify with an `ft_balance_of`/receipt-based check or only allow it after a longer delay with an event, and do not let the owner withdraw the freed amount until a cooling period.

### N-L2 [LOW] No replay/dedupe of identical signed delegates; each replay costs relayer gas and one agent token. VERIFIED.
Refs: relay.mjs:26-36.
An observer of one valid request (it travels over the client-to-facilitator hop; no TLS requirement is enforced by the facilitator itself) can resend it until `maxBlockHeight`: each replay passes validate and the key check, takes a bucket token, and the chain rejects it on the delegate nonce check after the relayer already paid. Fix: cache `hash(signed_delegate)` (or `(agentId, nonce)`) for the validity window and short-circuit; require TLS at the edge.

### N-L3 [LOW] Approvals are never deleted; no per-mandate cap. VERIFIED.
Refs: lib.rs:593, 526-530.
Now economically safe (2 mNEAR deposit vs ~0.8 mNEAR storage, F3 fixed), but state grows forever and used/expired entries are never reclaimed. Fix (optional): delete the approval on consumption or on expiry, refund part of the deposit.

### N-L4 [LOW] Key-check cache and RPC amplification from forged keys; positive TTL window after key removal. VERIFIED.
Refs: keycheck.mjs:6-7, 31-46.
An attacker may use an allowed agent id with random fresh public keys. Each unique pair misses the cache and costs one `view_access_key` RPC call (the first-line limiter is not applied yet, see N-M1), and flooding up to 10,000 entries evicts real positive entries (FIFO) which only adds latency. A key deleted or rotated on chain stays accepted for up to 60 s; those requests then fail on chain and burn relayer gas (bounded by the agent's bucket). Fix: per-IP limiter and a small global limit on key-check misses; on `TX_FAILED` caused by unknown access key, evict the cache entry.

### N-L5 [LOW] `promise_result_checked(0, 1024)` treats an oversized result as failure. VERIFIED (logic).
Refs: lib.rs:555, 736.
If an `ft_transfer` ever returns more than 1024 bytes, `is_ok()` is false although the transfer landed: payment is refunded (`reserved` released, `spent` unchanged) and the budget can be re-spent, or for withdraw `withdrawn` is restored and the owner can withdraw again. Standard NEP-141 returns nothing so this needs a non-standard token, and it only matters for the pool of that token; but tokens are not allow-listed and honest mandates sharing the pool would lose funds. Fix: use `promise_result_checked(0, usize::MAX)`-style tolerant check (success status regardless of size) or match `PromiseError::Failed` only.

## Informational / design observations

- N-I1: pooled-token model trusts the token's accounting. Fee-on-transfer, rebasing or deflationary tokens cause `deposited` to exceed what the contract holds; the mandate owner can withdraw the difference from other mandates' funds. Consider a token allowlist or per-token vaults. SUSPECTED, needs such a token.
- N-I2: `approval_threshold` is per payment, not cumulative. An agent can split a large intent into many sub-threshold payments (up to `per_payment_cap` each, `MAX_OPEN` 32 at once) and bypass guardian approval up to the budget. Likely a PRD design choice; document it, or add a rolling cumulative cap.
- N-I3: storage margin. A mandate grown to 16 max-length recipients uses about 3.5 KB (~0.035 NEAR); `loosen(AddRecipient)` adds this without further deposit. Up to 32 Pending entries add about 4.8 KB transiently, so worst case transient storage of one mandate (~0.083 NEAR) exceeds the 0.05 NEAR deposit. Entries free on callback, so there is no sustained drain; a request that would break the staking minimum reverts atomically. Raising the deposit to 0.1 NEAR gives full margin.
- N-I4: owner liveness after revoke depends on the guardian for stale Pending (`resolve_stale` is guardian only). A lost guardian key leaves that reserved amount unrecoverable. Optional: allow the owner after a long delay (for example 10000 blocks).
- N-I5: `tighten(Expiry)` by the owner changes the intent hash, silently invalidating all unused guardian approvals (fail-safe `NEEDS_APPROVAL`, liveness only). `new()` still has no access control (no state impact; deploy and init in one batch).

## Checked and sound (round 2)
- Guardian/owner/agent separation: only the guardian loosens (650) or resolves stale (755) or approves (587); agent only `request_payment` (468, predecessor-based); owner only withdraw (711). The owner cannot loosen; a third party can name any account as guardian or agent in their own mandate but gains nothing on others.
- Approval binding: hash covers prefix, mandate id, length-prefixed recipient, amount, nonce and the mandate's expiry at approve time; never overwritten (592); consumed at reserve; cap and budget checks precede the approval check so an approval cannot exceed either.
- Callback ordering: reserve/Pending/approval are written before the promise; Pending is removed before the result is read (552); `resolve_stale` and callback are mutually idempotent; no cross-callback reuse of request ids (monotonic, overflow checked).
- `ft_on_transfer`: gated by `predecessor == m.token`, `sender_id == owner`, Active, checked add; any failure refunds all. A direct call by a non-token account only credits mandates whose chosen token is that account (self-harm).
- Gas guards precede all state changes in `request_payment` and `withdraw`; static gas with weight 0 on both promises.
- Facilitator: strict canonical decode, single FunctionCall, pinned receiver, zero deposit, min/max gas, block-height window, ed25519 only, allowedAgents fail-closed, access-key check before rate-limit, RPC host exact allowlist, no keys or bodies in logs, body size capped, per-agent bucket memory bounded by the allowlist size.
