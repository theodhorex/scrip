# amanat-client (pure library)

Node ESM, no network, no keys held. One dependency: `near-api-js` 7.4.0 (pinned, for `delegate.mjs`; run `npm install` once). Run: `make -C .. test` or `cd client && npm test`.

## API
- `intentHash({mandateId, recipient, amount, nonce, expiresAtMs})` → `Uint8Array(32)`; `intentHashHex(...)` → hex.
  `mandateId/nonce/expiresAtMs`: BigInt or safe-integer Number. `amount`: canonical decimal string.
  Throws `TypeError` (wrong type, non-integer Number) / `RangeError` (range, non-canonical, bad recipient).
- `parseEventLogs(logs)` → validated `EVENT_JSON:` events of standard `amanat`/`1.0.0`; foreign standards ignored;
  malformed lines throw `EventParseError` (`.lineNumber`, 1-based). `toBig(amountString)` → BigInt.
- `reduceEvents(events)` → `Map<mandate_id, {deposited, reserved, spent, refunded, withdrawn, rejectedByCode, open}>`;
  throws `InvariantError`. `checkBudget(state, budget)` → `{ok, overBy}` (ok iff spent+reserved <= budget).

- `buildRequestPayment({contractId, mandateId, recipient, amount, nonce, gas?})` → function-call action (deposit 0n, default 100 Tgas;
  gas < 60 Tgas throws `RangeError`, the contract requires >= 60). u64 args stay exact above 2^53.
- `signDelegate({agentId, contractId, action, nonce, maxBlockHeight, keyPair})` → `{signedDelegate, base64}` (offline, NEP-366, ed25519 function-call key).
- `relayBodyFor(base64)` → JSON body for `POST /relay`. `classifyRelayResponse({status, body, retryAfter?})` →
  `{ok, retryable, code, retryAfterSeconds, txHash}` (retryable: RATE_LIMITED, UPSTREAM_ERROR, RELAY_FAILED; TX_FAILED is not).
- `parseRequestResult(jsonOrBase64)` → `{kind: Reserved|Rejected|Settled|Refunded|AlreadyResolved, requestId: bigint|null, code}`;
  `REJECT_CODES` (frozen, mirrors contract `RejectCode`), `RELAY_ERROR_CODES`. `src/index.mjs` re-exports everything.
  Delegate tests import the facilitator's `validateSignedDelegate` by relative path and run offline.

## Encoding (PRD 3.4) — SHA-256 of
| Field | Bytes |
|---|---|
| `"amanat/v1"` | 9, ASCII |
| mandate_id | 8, u64 LE |
| len(recipient) | 4, u32 LE |
| recipient | 1..64, ASCII `[a-z0-9._-]` |
| amount | 16, u128 LE |
| nonce | 8, u64 LE |
| expires_at_ms | 8, u64 LE |

## Vectors
`python3 tools/gen_vectors.py` writes `docs/vectors/intent_hash.json` using only `hashlib` (never calls JS).
Tests read that file; expected hashes are never computed in JS. The Rust contract should reuse the same file.
