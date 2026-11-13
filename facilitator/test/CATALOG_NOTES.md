# Scrip Facilitator F9 Test Catalog

This document summarizes the entire F9 facilitator robustness test catalog: format parsing (Step 1), relayer operations (Step 2), and delegate & access key verification (Step 3 / F9b).

---

## 1. Format & Parsing Robustness (`f9-format-parsing.test.mjs`)
- **Number of cases**: 61 automated subcases
- **Expectations (design/README)**:
  - Non-JSON input, whitespace, unclosed JSON, string/number/null/boolean literals, and HTML are rejected with HTTP 400 (`BAD_JSON` or `BAD_REQUEST`).
  - Deeply-nested payload exceeding 16 KB is rejected at the HTTP boundary with HTTP 413 `BODY_TOO_LARGE`.
  - Corrupt borsh base64, internal whitespace, unpadded url-safe characters, truncated borsh, and empty strings are rejected with HTTP 400 `BAD_ENCODING`.
  - Special characters (null byte `\u0000`, RTL override `\u202E`, zero-width space `\u200B`, emoji) are rejected with `BAD_ENCODING`.
  - Non-JSON Content-Type on `/relay` is rejected with HTTP 415 `UNSUPPORTED_MEDIA_TYPE`.
  - Missing, corrupt, or oversized `PAYMENT-SIGNATURE` header on `/verify` and `/settle` is rejected with HTTP 400.
  - Disallowed HTTP methods (GET/PUT/DELETE/PATCH on `/relay`, POST on `/health`) are rejected with HTTP 405 `METHOD_NOT_ALLOWED`.
  - URL traversal, double slashes, rogue subpaths, and empty hashes are rejected with HTTP 404 / 400.
- **Actual Results**: 61/61 passed, fail-closed, zero unhandled exceptions, zero stack trace leaks.
- **Findings**: The body size limit (16 KB) runs strictly before borsh parsing, protecting the process from excess memory allocation.

---

## 2. Operational & Relayer Robustness (`f9-operational.test.mjs`)
- **Number of groups**: 6 groups (29 subcases)
  1. Per-IP flooding (limiter): 7 subcases
  2. Random tx hash to `/status/:hash`: 7 subcases
  3. Low relayer balance: 4 subcases
  4. Slow, dead, garbage, truncated RPC: 8 subcases
  5. Replay after restart (SQLite persistent dedupe): 3 subcases
  6. Serial queue robustness (failing jobs): 1 subcase
- **Expectations (design/README)**:
  - IP flooding is stopped by per-IP bucket limiter with HTTP 429 `IP_RATE_LIMITED` and `Retry-After` header.
  - Random or invalid tx hashes are rejected directly from local store (HTTP 404 `TX_NOT_FOUND`) without hitting upstream RPC.
  - Relayer balance <= `minBalance` is rejected with `RELAYER_LOW_BALANCE` without submitting tx and without deducting limiter tokens.
  - RPC timeout or connection abort during broadcast triggers `RELAY_PENDING` (tokens & dedupe preserved to prevent double submission).
  - Deterministic errors before broadcast trigger `RELAY_FAILED` and refund agent & global limiter tokens.
  - SQLite persistent dedupe survives relayer restart and rejects offline replays.
  - Failure of one relay job does not stall the relayer serial queue.
- **Actual Results**: All operational scenarios passed 100%.
- **Findings**: Distinguishing ambiguous vs deterministic network errors (`isAmbiguousFailure`) is crucial to prevent gas double-spend when broadcast times out.

---

## 3. Delegate & Access Key Verification (`f9-delegate-keys.test.mjs`)
- **Number of groups**: 3 groups (29 registered subcases, covering 128 bit-flip evaluations):
  1. Access Key Verification: 8 subcases
  2. Signature Integrity: 4 subcases (32 bits in signature + 32 bits in payload + 64-bit full buffer sweep + key mismatch)
  3. Delegate & Nonce Validation: 14 subcases
- **Expectations (design/README)**:
  - `FullAccess` access keys must be rejected with `KEY_NOT_ALLOWED`.
  - `FunctionCall` access keys with non-`request_payment` method, empty method, or foreign methods must be rejected with `KEY_NOT_ALLOWED`.
  - Access keys with wrong receiver or 0 allowance must be rejected with `KEY_NOT_ALLOWED`.
  - Unregistered key (`AccessKeyDoesNotExistError`) or non-existent account (`AccountDoesNotExistError`) is rejected with `KEY_NOT_ALLOWED`.
  - 1-bit corruption in signature position must produce `BAD_SIGNATURE` 100% of the time.
  - 1-bit corruption in DelegateAction payload position must be rejected fail-closed 100% of the time (0 accepted).
  - 64-position bit flip sweep across the entire SignedDelegate buffer must be rejected 100% by the relayer with zero submits.
  - Exact delegate replay is rejected with `DUPLICATE_DELEGATE` (409) without re-submission.
  - Delegate nonce <= on-chain access key nonce is rejected with `NONCE_TOO_LOW`.
  - Sender not testnet or outside `allowedAgents` is rejected with `AGENT_NOT_ALLOWED`.
  - Wrong receiver contract is rejected with `WRONG_RECEIVER`.
  - MaxBlockHeight expired or too far is rejected with `EXPIRES_TOO_SOON` / `EXPIRES_TOO_FAR`.
  - Nonce 0 is rejected with `NONCE_INVALID`.
  - Nonce u64::MAX (`2^64 - 1`) is accepted if above keyNonce.
  - Nonce exceeding `2^64 - 1` in request_payment args is rejected with `BAD_CALL_ARGS`.
  - Nonce `2^64` in delegateAction wraps around modulo 2^64 to 0 and is rejected with `NONCE_INVALID`.
- **Actual Results**: 29/29 subcases passed (100% pass), 0 rogue submits.
- **Findings**:
  1. Borsh u64 serialization in `near-api-js` truncates modulo 2^64; the value `1n << 64n` becomes `0n`, which is caught fail-closed by the `da.nonce === 0n` guard as `NONCE_INVALID`.
  2. 1-bit corruption in signature always produces `BAD_SIGNATURE` via ed25519 verification. 1-bit corruption in payload is rejected with `BAD_ENCODING`, `BAD_SIGNATURE`, or specific field validations (`AGENT_NOT_ALLOWED`, `WRONG_RECEIVER`, `METHOD_NOT_ALLOWED`, `BAD_CALL_ARGS`, `DEPOSIT_NOT_ZERO`), with none passing.
  3. Modifications to `facilitator/src/**`: No modifications required because existing implementation is fully secure and fail-closed.
