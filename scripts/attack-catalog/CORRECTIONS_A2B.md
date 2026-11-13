# Catalog Expectation Corrections - Part A2B (11 Class B + 12 Class A)

This document records (1) harness/case-definition fixes for Class B cases without changing `expected`, and (2) `expected` corrections for the 12 remaining Class A cases. Each change points to the code that handles it.

## 1. Class B - harness fixes (expected NOT changed)

| ID | Problem | Change | Evidence (file:line) |
|---|---|---|---|
| `KAT-B-05-109/110/111` | `node:http.request` uppercases `post`/`Post`/`pOsT` to `POST`, so the dummy body is what gets rejected (`BAD_ENCODING`), not the verb. | Case uses `rawRequest: true`; harness sends the raw request line via `net.Socket`. | `cases/b2_extra.mjs:49-51`, `layers/facilitator.mjs:235,308-311` |
| `KAT-B-12-102` | `new URL()` normalizes `/relay/../relay` to `/relay`. | Case uses `rawRequest: true`; request-target is written as-is. | `cases/b2_extra.mjs:837`, `layers/facilitator.mjs:235` |
| `KAT-B-09-02..05` | Runner advances the clock +5 s per case, refilling the token bucket; cases depended on the flood from the previous case. | Each case adds its own `floodCount: 25`. | `cases/category_9.mjs:35,47,58,69`, `layers/facilitator.mjs:379-383` |
| `KAT-B-09-130/131/132` | `/verify` rejects first because `payment-signature` is missing, so `get_mandate` is never called. | Harness builds a valid x402 header (real ed25519 delegate + matching requirements) when `paymentSignature: true`; dummy body removed. | `cases/b2_extra.mjs:731,738,745`, `layers/facilitator.mjs:359-379`, `facilitator/src/server.mjs:142-170` |

## 2. Class A - `expected` corrections (12 cases)

| ID | Problem | Change | Evidence (file:line) |
|---|---|---|---|
| `KAT-B-12-119/120/121` | llhttp rejects verbs `BREACH`/`ATTACK`/`HACK` before the handler (raw 400). | `METHOD_NOT_ALLOWED` -> `HTTP_400`. | `facilitator/src/server.mjs:310,365`, `layers/facilitator.mjs:427` |
| `KAT-B-08-114/115` | Empty/whitespace body fails `JSON.parse` and returns `BAD_JSON`. | `BAD_REQUEST` -> `BAD_JSON`. | `facilitator/src/server.mjs:78-82` |
| `KAT-B-08-147` | A raw null byte inside a JSON string is an RFC 8259 syntax error -> `BAD_JSON`. | `BAD_ENCODING` -> `BAD_JSON`. | `facilitator/src/server.mjs:79-81` |
| `KAT-B-12-135` | Conflicting `Content-Length` + `Transfer-Encoding` is rejected by llhttp with a raw 400. | `BAD_REQUEST` -> `HTTP_400`. | `facilitator/src/server.mjs:310`, `layers/facilitator.mjs:427` |
| `KAT-B-12-130` | A 10 KB header is still under Node's 16 KB limit, so the body is validated and rejected with `BAD_ENCODING`. | `REQUEST_HEADER_FIELDS_TOO_LARGE` -> `BAD_ENCODING`. | `facilitator/src/server.mjs:67-90`, `facilitator/src/validate.mjs:89-91` |
| `KAT-C-08-11` | JSON nested 1500 levels deep is parsed by V8 without crashing; the parser returns a safe object with `ok=false`. | `BLOCKED (RangeError)` -> `INERT`. | `client/src/payment.mjs:147-181`, `client/src/payment.mjs:9-29` |
| `KAT-C-08-25` | Corrupt base64 in the `payment-response` header is ignored; falls back to a safe response object. | `BLOCKED (RangeError)` -> `INERT`. | `client/src/payment.mjs:159-181` |
| `KAT-C2-08-12` | A raw null byte in a JSON string is rejected by `JSON.parse`; the parser wraps it as a `RangeError`. | `INERT` -> `BLOCKED (RangeError)`. | `client/src/payment.mjs:154-157`, RFC 8259 |
| `KAT-C2-12-11` | A root array `[]` makes `input.mandateId` `undefined`; `toU64` throws `TypeError` (wrong type). | `BLOCKED (RangeError)` -> `BLOCKED (TypeError)`. | `client/src/intent.mjs:21-31,72-74` |

### Fail-closed for the RangeError <-> INERT label changes

- `KAT-C-08-11` and `KAT-C-08-25`: the result is `INERT` because the input does not change state and does not trigger execution; the parser still returns `ok=false`/`success=false`. There is no false success path.
- `KAT-C2-08-12`: `RangeError` is thrown before the result object is used, so the rejection is still fail-closed.
- `KAT-C2-12-11`: `TypeError` is thrown by `toU64` before the hash is built; no intent/hash is produced, so it is still fail-closed.

## 3. Deferred

No cases are deferred. All 12 in-scope Class A cases were verified against the real code.

## 4. Execution results (real)

- Layer B (`--layers B`): 369 cases, **PASS 363 / FAIL 6 / BREACH 0 / SKIPPED 0**.
  - PASS after the fixes: `KAT-B-12-102`, `KAT-B-09-02..05`, and all 8 B-side Class A cases (`08-114/115/147`, `12-119/120/121`, `12-130`, `12-135`).
  - Remaining FAIL: `KAT-B-05-109..111` (actual `HTTP_400`, expected `METHOD_NOT_ALLOWED`) and `KAT-B-09-130..132` (actual `UPSTREAM_ERROR`/`MANDATE_NOT_FOUND`/`ASSET_MISMATCH`, expected `BAD_REQUEST`).
- Layer C (`--layers C`): 317 cases, **PASS 317 / FAIL 0 / BREACH 0 / SKIPPED 0**.
- The six Layer B FAILs above are no longer harness artifacts: the harness now sends the raw verb / a valid x402 header. The actual code is more specific than the designed `expected`. Per the instruction "do not change expected" for Class B, the values were left unchanged and reported as-is; correcting their `expected` needs a PM decision (not part of the 12 Class A cases in this task).
