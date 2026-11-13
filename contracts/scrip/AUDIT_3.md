# AUDIT_3: Scrip Contract + Facilitator + Client (Round 3, Post-v1.3 Changes)

**Date:** October 30, 2026  
**Audit Scope:**
1. Contract: `contracts/scrip/src/lib.rs` (921 lines), `tests.rs`, `property_tests.rs` (K-A, K-B, K-C, N-L5, reservations, callback, resolve_stale, integer math, predecessor access).
2. Facilitator: `facilitator/src/*.mjs` (`store.mjs`, `inner_status.mjs`, `validate.mjs`, `relay.mjs`, `server.mjs`, `keycheck.mjs`, `policy.mjs`).
3. Client: `client/src/payment.mjs` (`parsePaymentResponse`, base64/base64url decoding).
4. Documentation & Specification: `docs/PROPERTIES.md`, `contracts/scrip/README.md`.

**Execution Verification:**
- Contract: `cargo test --lib` -> 112 passed, 0 failed, 2 ignored (`#[ignore]` N-L5).
- Facilitator & Client: `node --test` -> 91 passed, 0 failed.

**Findings Summary:**  
Total: 0 Critical, 0 High, 3 Medium, 2 Low, 3 Info.  
Audit status: **SAFE FOR TESTNET & DEMO**, with operational facilitator hardening and client parser fixes noted.

---

## 1. Verification of v1.3 Changes (Confirmed Correct)

- **K-A (`tighten` preserves limit hierarchy)**: **PROVEN CORRECT**.
  - `tighten(Budget)` rejects values below `spent + reserved` (`BUDGET_BELOW_COMMITTED`) and below `per_payment_cap` (`BUDGET_BELOW_CAP`, `lib.rs:643`).
  - `tighten(PerPaymentCap)` rejects values below `approval_threshold` (`CAP_BELOW_THRESHOLD`, `lib.rs:648`).
  - `tighten(ApprovalThreshold)` only lowers the threshold value.
  - The invariant `budget >= per_payment_cap >= approval_threshold` is proven maintained across all combinations of random operations (`property_tests.rs: p4_tighten_never_loosens`).
- **K-B (`OWNER_IS_AGENT` & `refund_excess`)**: **PROVEN CORRECT & CANNOT BE DRAINED**.
  - `create_mandate` verifies `owner != agent` (`lib.rs:389`), `guardian != agent`, and `guardian != owner`.
  - `refund_excess(to, keep)` (`lib.rs:862-868`) computes `attached.saturating_sub(keep)`. Because the refunded funds come directly from `env::attached_deposit()` of the current transaction and transfer to `predecessor_account_id()` (`owner` on `create_mandate`, `guardian` on `approve_intent`), the contract never refunds more than the newly attached deposit. The contract NEAR balance always increases by `keep`.
- **K-C (`TOO_MANY_APPROVALS`)**: **PROVEN CORRECT**.
  - `approvals_count` is capped at a maximum of 512 entries per mandate (`lib.rs:612`). Call 513 panics with `TOO_MANY_APPROVALS`. Contract state growth is safely bounded.
- **F-A (SQLite Persistent Dedupe Store)**: **PROVEN CORRECT**.
  - The `delegates` table in `.facilitator.db` uses `hash` as PRIMARY KEY.
  - Checks for `store.get(dh)` and `store.set(...)` in `relay.mjs:250-255` run synchronously without `await` pauses in the Node.js event loop, preventing races across parallel requests.
  - Automatic pruning removes entries with `max_block_height < lastHeight` (expired on-chain) and bounds maximum size (`dedupeMax = 10_000`).
- **F-B & F-C (Inner Status & Nonce Check)**: **PROVEN CORRECT**.
  - `extractInnerStatus` extracts `Settled`, `Refunded`, `Rejected`, and `Reserved` accurately from `EVENT_JSON` and `SCRIP_ERR:`.
  - Delegate nonce must be strictly above the on-chain nonce (`k.nonce >= v.nonce` rejected with `NONCE_TOO_LOW`).
  - Facilitator rejects broadcast if relayer balance is below `minBalance` (`RELAYER_LOW_BALANCE`).
- **F-D & F-E (Operational & x402 Endpoints)**: **PROVEN CORRECT**.
  - Structured JSON logging without leaking transaction bodies, private keys, or secrets (`server.mjs:94, 159, 233`).
  - Endpoints `/verify`, `/settle`, `/supported`, `/status/:hash`, `/metrics`, and `/health` function per PRD v1.3 specification.

---

## 2. New Findings

### N3-M1 [MEDIUM] Endpoint `/status/:hash` lacks IP Rate Limiter and triggers NEAR RPC amplification for arbitrary hashes.
- **Status:** PROVEN (code analysis).
- **Path:** `facilitator/src/server.mjs:314-321`, `facilitator/src/relay.mjs:161-179`.
- **Attack Scenario:**
  1. Attacker floods `GET /status/<random_tx_hash>` thousands of times per second from one or many connections.
  2. The `/status/:hash` route in `server.mjs` does not call `ipLimiter.tryTake(clientIp(req))` (unlike `/relay`, `/verify`, and `/settle`).
  3. `relayer.getTxStatus(txHash)` checks `store.getByTxHash(txHash)`. If `local == null` (unknown hash), the function still proceeds by calling `provider.viewTransactionStatusWithReceipts` to the upstream RPC node.
  4. Consequently, the facilitator NEAR RPC quota is rapidly exhausted until receiving HTTP 429 from the RPC provider, causing service denial (`UPSTREAM_ERROR`) for all legitimate agents.
- **Remediation Recommendation:**
  1. Add `ipLimiter.tryTake(clientIp(req))` to the `/status/:hash` route handler in `server.mjs`.
  2. If `local == null` (transaction was never relayed by this facilitator), return 404 `TX_NOT_FOUND` immediately without querying upstream NEAR RPC.

### N3-M2 [MEDIUM] RPC status query in `getTxStatus` lacks timeout protection (`withTimeout`), risking hanging connections.
- **Status:** PROVEN (code analysis).
- **Path:** `facilitator/src/relay.mjs:163-179`.
- **Attack Scenario:**
  1. NEAR RPC node experiences network congestion or socket hang while handling a `viewTransactionStatusWithReceipts` query with parameter `waitUntil: 'FINAL'`.
  2. Unlike calls `viewBlock` (`relay.mjs:84`) and `relayMetaTransaction` (`relay.mjs:258`) which are wrapped in `withTimeout(..., rpcTimeoutMs)`, the call inside `getTxStatus` executes without a timeout wrapper.
  3. Client HTTP requests to the facilitator hang indefinitely, holding in-flight slots and file descriptors until the server exhausts resources.
- **Remediation Recommendation:**
  Wrap calls `provider.viewTransactionStatusWithReceipts` and `provider.txStatus` with `withTimeout(..., rpcTimeoutMs)`.

### N3-M3 [MEDIUM] `parsePaymentResponse` misidentifies valid transaction response `status: "FINAL"` as payment failure.
- **Status:** PROVEN (verified via Node.js REPL).
- **Path:** `client/src/payment.mjs:192-195`.
- **Attack Scenario:**
  1. Client or merchant calls `getTxStatus(txHash)` and obtains an on-chain transaction response object: `{ ok: true, tx_hash: '...', status: 'FINAL', inner_status: 'Settled' }`.
  2. This object is passed to `parsePaymentResponse(resp)`.
  3. Line 192 checks: `const isOk = obj.ok !== false && (obj.status === undefined || obj.status === 200 || obj.status === 201);`.
  4. Because `obj.status` is string `'FINAL'`, the expression `(obj.status === undefined || obj.status === 200 || obj.status === 201)` evaluates to `false`.
  5. Consequently, `parsePaymentResponse` returns `{ ok: false, success: true, code: 'PAYMENT_FAILED' }`.
  6. The client system assumes payment failed and cancels the order, even though the transaction is final on blockchain and merchant funds are received.
- **Remediation Recommendation:**
  Update the `isOk` check so non-numeric status strings (such as `'FINAL'`) are not treated as HTTP error codes:
  `const isOk = obj.ok !== false && (typeof obj.status !== 'number' || obj.status === 200 || obj.status === 201);`.

### N3-L1 [LOW] Base64URL decoder logic in `validate.mjs` and `payment.mjs` fails to decode unpadded alphanumeric strings.
- **Status:** PROVEN (verified via Node.js REPL).
- **Path:** `facilitator/src/validate.mjs:251-255`, `client/src/payment.mjs:21-25`.
- **Attack Scenario:**
  1. External x402 client sends header `PAYMENT-SIGNATURE` or reads `PAYMENT-RESPONSE` encoded using base64url without padding (RFC 7515 standard).
  2. If the base64url string happens to contain only alphanumeric characters (no `-` or `_`, for example: `"eyJhIjoxfQ"` for `{"a":1}` with length 10), regex `B64` evaluates to `true` (`/^[A-Za-z0-9+/]+={0,2}$/`).
  3. The condition `if (B64_URL.test(s) && !B64.test(s))` evaluates to `false`.
  4. No padding `=` is appended to the string, so `b64.length % 4 !== 0` holds and the function returns `null` immediately.
  5. Facilitator rejects legitimate requests with code `BAD_PAYMENT_SIGNATURE` or client throws `RangeError`.
- **Remediation Recommendation:**
  Remove the `!B64.test(s)` condition for padding normalization:
  ```javascript
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  ```

### N3-L2 [LOW] Bug N-L5: `promise_result_checked(0, 1024)` causes accounting desynchronization if FT token returns >1024 bytes of data.
- **Status:** PROVEN (on non-standard tokens; currently ignored in `tests.rs:1814, 1828`).
- **Path:** `contracts/scrip/src/lib.rs:574, 765`.
- **Attack Scenario:**
  1. Contract is integrated with custom NEP-141 token that returns receipt/metadata data >1024 bytes on `ft_transfer`.
  2. `env::promise_result_checked(0, 1024).is_ok()` returns `false`.
  3. In `on_payment_done`, a transfer that actually succeeded in the token contract is treated as failed; `reserved` is released back to budget without recording `spent`. Physical contract funds decrease, but contract bookkeeping treats funds as intact, enabling double spending or excess withdrawals.
  4. In `on_withdraw_done`, callback failure restores the `withdrawn` value, enabling repeated fund withdrawals.
  5. *Note:* For standard NEP-141 tokens (USDC, USDT, wNEAR), `ft_transfer` returns `void` (0 bytes), so this is not triggered in the current testnet environment.
- **Remediation Recommendation:**
  Use `PromiseResult` handling without a 1024-byte limit or increase buffer to 16 KiB if supported by near-sdk.

### N3-I1 [INFO] `matchPaymentRequirements` in facilitator does not verify on-chain mandate token match (`asset`).
- **Status:** PROVEN.
- **Path:** `facilitator/src/validate.mjs:325-339`.
- **Context:** `matchPaymentRequirements` matches `payTo`, `amount`, `mandate_id`, and `contractId`, but does not validate whether the on-chain mandate uses a `token` matching `requirements.asset`. Calling `get_mandate` is required to confirm the token.

### N3-I2 [INFO] `approvals_count` is not included in `MandateView` / `get_mandate`.
- **Status:** PROVEN.
- **Path:** `contracts/scrip/src/lib.rs:171-189, 803-824`.
- **Context:** Guardians and clients cannot determine remaining approval capacity before the 512 limit is reached (`TOO_MANY_APPROVALS`). This field should be exposed in `MandateView`.

### N3-I3 [INFO] Inconsistency between literal string panic codes in `create_mandate` and `err` module constants.
- **Status:** PROVEN.
- **Path:** `contracts/scrip/src/lib.rs:387-398`, `contracts/scrip/README.md:48`.
- **Context:** README states all panic codes live in `scrip::err`, but `create_mandate` still uses direct string literals like `"BUDGET_LESS_THAN_CAP"`, `"GUARDIAN_IS_AGENT"`, `"GUARDIAN_IS_OWNER"`, `"EMPTY_RECIPIENTS"`, `"INVALID_RECIPIENT"`.

---

## 3. Top 3 Findings

1. **N3-M1 [MEDIUM]**: Endpoint `/status/:hash` lacks IP rate limiter and forwards arbitrary hashes directly to upstream NEAR RPC (RPC DoS Amplification).
2. **N3-M2 [MEDIUM]**: `getTxStatus` lacks RPC timeout (`withTimeout`), potentially causing indefinite request hanging.
3. **N3-M3 [MEDIUM]**: `parsePaymentResponse` misidentifies status `status: "FINAL"` as `{ ok: false, code: 'PAYMENT_FAILED' }`, breaking client verification flow.

---

## 4. Skills Applied

- **code-review-and-quality**: Applied five-axis review (correctness, readability, architecture, security, performance) across all new v1.3 code; all checklists satisfied.
- **security-and-hardening**: Applied STRIDE threat model to evaluate balance manipulation, delegate replay, DoS rate limiting, and secret leakage risks; no secrets leaked in logs.
- **doubt-driven-development**: Challenged security assumptions regarding base64url parsing, `FINAL` response status, and the `/status` endpoint; cross-model review skipped due to non-interactive environment per skill guidance.
- **differential-review**: Analyzed all v1.3 diff changes (K-A..K-C, F-A..F-E, C-A) and caller blast radius in depth.
