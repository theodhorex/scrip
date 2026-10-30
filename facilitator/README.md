# Amanat facilitator (testnet relayer)

Validates an agent-signed NEP-366 delegate action against a policy, verifies the signing key on chain, rate-limits per agent and globally, and submits it paying the gas.

## API
- `POST /relay` — `Content-Type: application/json`, body `{ "signed_delegate": "<base64 borsh SignedDelegate>" }` (max 16 KB)
  - `200 { ok:true, tx_hash, outer_tx_succeeded:true, note }`. `ok:true` means ONLY that the outer relay transaction was accepted without a top-level failure. The inner function call (e.g. `request_payment`) can still fail or be refunded; read its result from the chain events/receipts via `tx_hash`. It is not proof of payment.
  - `400 { ok:false, code }` (see codes), `413` body too large, `415` not JSON
  - `429 { ok:false, code:"RATE_LIMITED" | "IP_RATE_LIMITED" | "BUSY" }` + `Retry-After` (seconds)
  - `409 DUPLICATE_DELEGATE` (this exact signed delegate was already relayed or is in flight; includes `tx_hash` when known), `503 SERVER_BUSY` (in-flight cap reached), `504 RELAY_PENDING` (timeout after broadcast: the tx MAY have landed)
  - `502` upstream/submit failure (`UPSTREAM_ERROR`, `RELAY_FAILED`, `TX_FAILED`)
- `POST /verify` & `POST /settle` (x402) — validate against `paymentRequirements` and check `requirements.asset` against on-chain mandate token (`get_mandate`, cached ~5 s). Rejects with `ASSET_MISMATCH` (400) on mismatch, `MANDATE_NOT_FOUND` (400) if absent, or `UPSTREAM_ERROR` (502) on RPC error.
- `GET /health` → `200 { ok:true }`

## Policy (JSON, `POLICY_FILE`)
- `network` ("testnet"), `contractId` (`*.testnet`), `allowedMethods` (e.g. `["request_payment"]`)
- `allowedAgents` REQUIRED, non-empty list of `*.testnet` ids (fail closed: loading a policy without it throws)
- `maxGas` (string), `minGas?` (string, default and minimum `60000000000000` = 60 Tgas, must be <= `maxGas`; the contract needs >= 60 Tgas, less only burns relayer gas)
- `maxBlockHeightWindow` (max blocks ahead), `minBlockHeightMargin`
- `rateLimit {capacity, refillPerSecond}` per agent; `globalRateLimit? {capacity, refillPerSecond}` for all relays together (default 30 / 0.5 per s)
- `ipRateLimit? {capacity, refillPerSecond}` per client IP in front of `/relay` (default 20 / 1 per s); `maxInFlightRelays?` concurrent relays, more get `503` (default 8); `trustProxy?` boolean (default false): the IP is `socket.remoteAddress`; only when true the last `X-Forwarded-For` entry is used (set it only behind your own proxy that overwrites the header)
- `rpcUrl?` exact host allowlist: `rpc.testnet.fastnear.com`, `test.rpc.fastnear.com`, `rpc.testnet.near.org`, `rpc.testnet.pagoda.co` (https). `localhost`/`127.0.0.1` only via `loadPolicy(obj, { allowLocalRpc: true })` (tests).

## Request pipeline
decode + validate offline (incl. signature, no network) -> replay dedupe -> block height (cached ~1 s) + expiry check -> `view_access_key(senderId, publicKey)` -> per-agent limiter -> global limiter -> submit (serialized through one single-flight queue with max length, so the relayer key never races on its nonce; rejects `BUSY` / 429 when queue is full). Per-IP bucket and in-flight cap run before all of this.
For `/verify` and `/settle`, `paymentRequirements.asset` is checked against on-chain mandate token via `get_mandate` (cached ~5 s, fail-closed: `ASSET_MISMATCH`, `MANDATE_NOT_FOUND`, or `UPSTREAM_ERROR`).

## Error codes
`BAD_ENCODING`, `AGENT_NOT_ALLOWED`, `WRONG_RECEIVER`, `WRONG_ACTION_COUNT`, `NOT_FUNCTION_CALL`, `METHOD_NOT_ALLOWED`, `DEPOSIT_NOT_ZERO`, `GAS_TOO_HIGH`, `GAS_TOO_LOW` (400), `EXPIRES_TOO_SOON`, `EXPIRES_TOO_FAR`, `NONCE_INVALID`, `BAD_SIGNATURE`, `KEY_NOT_ALLOWED` (400), `ASSET_MISMATCH` (400), `MANDATE_NOT_FOUND` (400), plus `RATE_LIMITED` (429; per agent or global), `BUSY` (429; relayer queue full), `UPSTREAM_ERROR`, `RELAY_FAILED`, `TX_FAILED` (502), `IP_RATE_LIMITED` (429), `DUPLICATE_DELEGATE` (409), `SERVER_BUSY` (503), `RELAY_PENDING` (504), `BAD_JSON`, `BAD_REQUEST`.

## Run
```
npm install && npm test
POLICY_FILE=policy.json RELAYER_ACCOUNT_ID=relayer.testnet RELAYER_KEY_FILE=/path/key \
  [RPC_URL=https://rpc.testnet.fastnear.com] [PORT=8787] node src/main.mjs
```
The key file holds `ed25519:...` or JSON with `private_key`; it is never printed or logged.

## Retry rules for clients
`RELAY_FAILED` happened before broadcast: the agent and global tokens are refunded and the SAME signed delegate may be resent. `RELAY_PENDING` (timeout after broadcast) is ambiguous: do NOT sign a new delegate; check the chain for the delegate nonce, or resend the same delegate (the facilitator answers `DUPLICATE_DELEGATE`, the chain nonce makes a second landing impossible).

## Honest limits
Single instance; in-memory limiters, dedupe set (10,000 entries, entries older than their `maxBlockHeight` are pruned, oldest evicted when full) and key cache (reset on restart); testnet only. The pending/failed split is a heuristic on the thrown error (timeout, abort, connection reset = pending; everything else = failed). Not done: no relayer balance floor, no TLS (terminate at the edge), no global limit on key-check misses (the per-IP bucket bounds them per IP; many IPs can still cause RPC calls), a key deleted on chain stays accepted for up to 60 s (the chain then rejects it and the relayer pays the gas; bounded by the agent's bucket), the per-IP bucket is per address (NAT shares one, IPv6 clients can rotate addresses). Serialized submission means throughput is one tx at a time, and a hung broadcast delays queued requests until it times out. `ok:true` does not report the inner contract call result (see API).
