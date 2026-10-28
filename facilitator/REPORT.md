# F1 facilitator report
Tests: `node --test test/` → 29 pass, 0 fail (offline, <1 s); `make test` runs client + facilitator.

## near-api-js 7.4.0 functions used
`SCHEMA.SignedDelegate` (decode schema), `encodeSignedDelegate` (canonical round-trip check), `encodeDelegateAction` (prefix + borsh, hashed with sha256 for the signature check), `PublicKey.verify`, `KeyType`; relay uses `Account.relayMetaTransaction`, `JsonRpcProvider.viewBlock`. Tests: `KeyPair.fromRandom`, `KeyPairSigner.signDelegateAction`, `buildDelegateAction`, `actions.*`.
7.4.0 has no `decodeSignedDelegate`/`deserialize` export, so decoding uses `deserialize` from `borsh` (near-api-js's own hoisted dependency, not declared in package.json).

## Assumptions
- Rate limit runs after validation (incl. signature) so forged requests cannot drain a victim's bucket.
- Non-ed25519 keys → `BAD_SIGNATURE`; non-`.testnet` sender → `AGENT_NOT_ALLOWED`.
- Check order: encoding, agent, receiver, action count/type, method, deposit, gas, expiry, nonce, signature.
- Decoded delegates must re-encode byte-identically (rejects trailing bytes); max 8 KB decoded.
- `tx_hash` read from `outcome.transaction.hash` as in spike S1.
- Added extra codes: `UPSTREAM_ERROR`, `RELAY_FAILED`, `TX_FAILED`, `RATE_LIMITED`, `BAD_JSON`, `BAD_REQUEST`.

## Skills dipakai
- api-and-interface-design: five small modules with injected deps; codes documented in README.
- test-driven-development: policy/validate/ratelimit tests written first and seen red (suites failed to import), then implemented.
- security-and-hardening: strict decoding, signature/deposit/gas/receiver/method checks, 16 KB cap, no stack traces/keys/bodies in logs, bounded limiter.
- source-driven-development: read near-api-js 7.4.0 in node_modules (index.js) instead of guessing; probed decode shape.
- incremental-implementation: policy → validate → ratelimit → relay → server, tests run after each stage (relay+server tests were added together).

## Audit fixes (AUDIT_1 F2, F8 partial, F9)
Tests: `node --test test/` -> 45 pass, 0 fail (29 before; written first, red on missing module/fields, then green).
- F2: new `src/keycheck.mjs` (`view_access_key` via injected provider; FunctionCall + receiver == contractId + non-empty methods subset of allowedMethods + allowance != 0; cache 60 s / 10 s, bounded). Runs before any limiter token; RPC failure -> `UPSTREAM_ERROR`, no token. `loadPolicy` now requires non-empty `allowedAgents`. Missing key detected by error class name (`AccessKeyDoesNotExistError`/`AccountDoesNotExistError`, not exported by near-api-js 7.4.0 root).
- `minGas` (default/min 60 Tgas, <= maxGas) -> `GAS_TOO_LOW`; `globalRateLimit` (default 30, 0.5/s) second limiter.
- F9: exact host allowlist; local hosts only with `allowLocalRpc`.
- F8 partial: 200 carries `outer_tx_succeeded` and `note` (inner result not checked). Not done: replay dedupe, per-IP limit, nonce-race handling, balance floor (not required).
- Changed existing tests only because behaviour tightened: helpers `basePolicy` gets `allowedAgents`, maxGas 100 Tgas and default gas 60 Tgas (old 30 Tgas is now GAS_TOO_LOW / minGas > maxGas); validate gas boundary test moved to 100 Tgas; relay tests use a fake RPC provider (test double of the RPC only); server success test expects the new response fields.
