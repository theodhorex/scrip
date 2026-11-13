# scrip-client

Agent-side SDK for [Scrip](https://github.com/theodhorex/scrip) spending mandates on NEAR testnet. Your agent holds a
function-call key that can only call `request_payment`; this library signs those calls as NEP-366 delegates, sends
them to a relayer that pays the gas, and reads back what the contract decided.

Node 20+, ESM. One runtime dependency: `near-api-js` 7.4.0 (pinned).

## Install

From the GitHub release (no npm registry needed):

```bash
npm install --allow-remote=all https://github.com/theodhorex/scrip/releases/download/client-v0.1.0/scrip-client-0.1.0.tgz
```

npm 12 refuses tarball URLs unless `--allow-remote=all` is passed (older npm does not need the flag). Or download the
`.tgz` from the [release page](https://github.com/theodhorex/scrip/releases/tag/client-v0.1.0) and run
`npm install ./scrip-client-0.1.0.tgz`.

## Pay gasless in five lines

Create a mandate at [scrip-dev.vercel.app/mandates/new](https://scrip-dev.vercel.app/mandates/new) (or use the
public demo agent in `web/src/data/live.json`), then:

```js
import { KeyPair } from 'near-api-js';
import { payGasless } from 'scrip-client';

const r = await payGasless({
  agentId: 'scrip-agent-xxxx.you.testnet',
  keyPair: KeyPair.fromString(process.env.AGENT_KEY), // the agent's function-call key
  contractId: 'live-scrip.envtest-theo-1747.testnet',
  mandateId: 2,
  recipient: 'live-shop-a.envtest-theo-1747.testnet',
  amount: '10000', // token units (0.01 USDC)
});
// r = { ok, txHash, innerStatus: 'Settled' | 'Rejected' | 'Refunded' | ..., innerCode, code, retryable }
```

`ok` means the relayer submitted the transaction. The contract's answer is `innerStatus`: a payment to a recipient
outside the allowlist comes back `Rejected` with `innerCode: 'RECIPIENT_NOT_ALLOWED'`, and no token moves. The hosted
relayer (`https://scrip-dev.vercel.app/api/relay`) only relays for the agent recorded on the mandate; pass `relayUrl`
to use your own facilitator (`facilitator/` in the repo).

## API

- `payGasless(...)` (above), `HOSTED_RELAY_URL`, `TESTNET_RPC_URL`. The only module that uses the network; `provider` and `fetch` are injectable.
- `intentHash({mandateId, recipient, amount, nonce, expiresAtMs})` → `Uint8Array(32)`; `intentHashHex(...)` → hex.
  `mandateId/nonce/expiresAtMs`: BigInt or safe-integer Number. `amount`: canonical decimal string.
  Throws `TypeError` (wrong type, non-integer Number) / `RangeError` (range, non-canonical, bad recipient).
- `parseEventLogs(logs)` → validated `EVENT_JSON:` events of standard `scrip`/`1.0.0`; foreign standards ignored;
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

## Tests

`npm test` (offline, `node --test`). From the repo root, `make test` runs them with the contract and facilitator suites.
