# Attack Catalog FAIL Triage (Layer B and Layer C)

This document triages all **68 FAIL cases** (64 in Layer B, 4 in Layer C) from the Scrip protocol attack catalog, per `.agy/BRIEF_BACKEND.md` and `scripts/attack-catalog/README.md`.

Each case was assessed without changing test files or production code, and put into one of 3 classes:
- **A. SAFE_MISMATCH**: The system stays safe and rejects the attack (fail-closed), but the error code or status format returned differs from what the test expects.
- **B. HARNESS_ARTIFACT**: The test does not exercise its intended target because of a harness/runner limit (e.g. isolated rate-limit state, automatic normalization by the HTTP client, or a required header not sent).
- **C. REAL_DEFECT**: Actual behavior violates the design spec or contract and needs a source code fix.

---

## 1. Classification Summary

### Distribution Matrix by Category and Class

| Attack Category | FAIL Cases | Class A (SAFE_MISMATCH) | Class B (HARNESS_ARTIFACT) | Class C (REAL_DEFECT) |
| :--- | :---: | :---: | :---: | :---: |
| **05. Agent Identity & Header Security** | 17 | 14 | 3 | 0 |
| **07. Burst & Concurrency Limits** | 4 | 4 | 0 | 0 |
| **08. Encoding & Malformed Payloads** | 10 | 10 | 0 | 0 |
| **09. Operational HTTP & RPC Handling** | 21 | 12 | 7 | 2 |
| **12. Boundary Fuzzing & Absurd Inputs** | 16 | 15 | 1 | 0 |
| **TOTAL** | **68** | **55** | **11** | **2** |

---

## 2. Class C (REAL_DEFECT) Findings: Verified File Paths and Lines

Two cases in Category 9 are **REAL_DEFECT**:

### `KAT-B-09-123` & `KAT-B-09-124`: Malformed RPC Block Height Accepted as Valid
- **File and lines**: [`facilitator/src/relay.mjs:169-170`](<repo>/facilitator/src/relay.mjs#L169-L170)
- **Faulty code**:
  ```javascript
  const block = await withTimeout(provider.viewBlock({ finality: 'final' }), rpcTimeoutMs);
  const h = Number(block.header.height);
  if (!Number.isSafeInteger(h)) throw new Error('bad height');
  lastHeight = Math.max(lastHeight, h);
  return h;
  ```
- **Scenario and code evidence**:
  1. In `KAT-B-09-123`, the mock RPC returns `{ header: { height: null } }`. In JavaScript, `Number(null)` is `0`.
  2. In `KAT-B-09-124`, the mock RPC returns `{ header: { height: -10 } }`. `Number(-10)` is `-10`.
  3. `Number.isSafeInteger(0)` and `Number.isSafeInteger(-10)` are both `true`.
  4. As a result, `getHeight()` treats `0` and `-10` as valid final block heights and does not throw `bad height`. The value is then passed to `checkExpiry(v.maxBlockHeight, policy, currentBlockHeight)`.
  5. The delegate block height (~1100) is far above `0 + maxBlockHeightWindow`, so the delegate is rejected with `EXPIRES_TOO_FAR` instead of `UPSTREAM_ERROR`.
- **Security impact**:
  No balance leak and no stray relay execution (the system still rejects the transaction, fail-closed, via the expiry path). However, accepting a corrupt RPC response violates the principle "only a final height is honest" (`relay.mjs:168`).
- **Proposed fix**:
  Change the validation at `facilitator/src/relay.mjs:170` to:
  ```javascript
  if (typeof block?.header?.height !== 'number' || !Number.isSafeInteger(h) || h <= 0) {
    throw new Error('bad height');
  }
  ```

---

## 3. Analysis of Similar Case Groups

### Family 1: Runner Clock Isolation Refills the Rate Limit Bucket (Class B)
- **Related cases**: `KAT-B-09-02`, `KAT-B-09-03`, `KAT-B-09-04`, `KAT-B-09-05` (4 cases)
- **Root cause**: The Layer B runner (`scripts/attack-catalog/layers/facilitator.mjs:240`) advances the mock clock by 5000 ms (`state.now += 5000`) before each case to keep the block height cache isolated. This also refills the IP rate limiter token bucket (`capacity: 20, refillPerSecond: 1`) by 5 tokens. These cases do not set their own `floodCount: 25` and wrongly assume the rate limit state from the earlier case `KAT-B-09-01` is still in effect.
- **Proposed action**: Add `floodCount: 25` explicitly to each case in `scripts/attack-catalog/cases/category_9.mjs` so no case depends on another case's state.

### Family 2: HTTP Method Case Normalization by the HTTP Client (Class B)
- **Related cases**: `KAT-B-05-109`, `KAT-B-05-110`, `KAT-B-05-111` (3 cases)
- **Root cause**: The tests send the HTTP method variants `post`, `Post`, and `pOsT`. The client-side `node:http.request` module automatically normalizes standard method strings to uppercase `"POST"` before the packet reaches the TCP socket. The server receives a plain `"POST"` and processes the dummy body `{"signed_delegate":"dummy"}`, which is rejected with `BAD_ENCODING` (HTTP 400).
- **Proposed action**: Update the Layer B test executor to use a raw socket (`net.connect`) when testing HTTP verbs with non-standard casing, so client normalization does not intercept them.

### Family 3: URL Path Traversal Resolution by the Runner Client (Class B)
- **Related cases**: `KAT-B-12-102` (1 case)
- **Root cause**: The case tests the path traversal `/relay/../relay`, expecting `NOT_FOUND`. In `scripts/attack-catalog/layers/facilitator.mjs:186`, `sendHttpRequest` builds a `new URL(urlStr)` object. The WHATWG URL standard automatically collapses the segment `/relay/../relay` to `/relay`. The request that reaches the facilitator is `/relay`, which rejects the dummy body with `BAD_ENCODING`.
- **Proposed action**: Send the raw HTTP path over a socket, or do not normalize through `new URL()`.

### Family 4: Mandate Lookup Tests Missing the Required Signature Header (Class B)
- **Related cases**: `KAT-B-09-130`, `KAT-B-09-131`, `KAT-B-09-132` (3 cases)
- **Root cause**: The tests aim to verify error handling when the `get_mandate` RPC call fails on the `/verify` endpoint. However, the test generator (`scripts/attack-catalog/cases/b2_extra.mjs:768`) sends the request without a `payment-signature` header. The `/verify` handler in `facilitator/src/server.mjs:143` rejects the request with `MISSING_PAYMENT_SIGNATURE` before the `get_mandate` RPC lookup is ever called.
- **Proposed action**: Include a dummy `payment-signature` header that passes the initial offline validation, so execution reaches the mandate check in `relayer.checkMandateAsset()`.

### Family 5: Extra Headers and Parameters with an Empty/Dummy Body Payload (Class A)
- **Related cases**:
  - `KAT-B-05-125` .. `KAT-B-05-138` (14 cases)
  - `KAT-B-07-140` .. `KAT-B-07-143` (4 cases)
  - `KAT-B-08-110`, `KAT-B-08-111`, `KAT-B-08-112` (3 cases)
  - `KAT-B-09-106`, `KAT-B-09-109`, `KAT-B-09-110` (3 cases)
  - `KAT-B-12-112`, `KAT-B-12-113`, `KAT-B-12-114`, `KAT-B-12-116` (4 cases)
  - `KAT-B-12-129`, `KAT-B-12-130`, `KAT-B-12-131`, `KAT-B-12-132`, `KAT-B-12-133`, `KAT-B-12-134` (6 cases)
  *(Total 34 cases)*
- **Root cause**: These cases vary headers (spoofed IP, auth, query injections, custom headers) or send concurrency below the rate limit threshold. Because the body sent is the dummy payload `{"signed_delegate":""}`, the server passes the HTTP transport layer, then checks the delegate in `facilitator/src/validate.mjs:91` and rejects with the specific code `BAD_ENCODING` (HTTP 400).
- **Security status**: All cases are safe (fail-closed). `BAD_ENCODING` is more accurate than the generic expected `BAD_REQUEST`, because the JSON structure is valid but the borsh delegate string is empty.
- **Proposed action**: Change the test expectation to `BAD_ENCODING`.

### Family 6: x402 Protocol Header Validation on the /verify and /settle Routes (Class A)
- **Related cases**:
  - `KAT-B-08-113` (1 case)
  - `KAT-B-09-107`, `KAT-B-09-108` (2 cases)
  - `KAT-B-09-140`, `KAT-B-09-141`, `KAT-B-09-142`, `KAT-B-09-144`, `KAT-B-09-145`, `KAT-B-09-146`, `KAT-B-09-147` (7 cases)
  *(Total 10 cases)*
- **Root cause**: The facilitator implements an x402 payment header parser (`facilitator/src/validate.mjs:268`). Requests with a missing or empty header are rejected with `MISSING_PAYMENT_SIGNATURE`, and malformed base64 is rejected with `BAD_PAYMENT_SIGNATURE`. The tests expect the generic error `BAD_REQUEST`.
- **Security status**: Responses are fail-closed with HTTP 400. The actual error code gives client integrations a much clearer contract.
- **Proposed action**: Update the test expectation to the specific code `MISSING_PAYMENT_SIGNATURE` or `BAD_PAYMENT_SIGNATURE`.

### Family 7: Empty Body and Null Byte Parsing (Class A)
- **Related cases**: `KAT-B-08-114`, `KAT-B-08-115`, `KAT-B-08-147` (3 cases)
- **Root cause**:
  1. For an empty or whitespace body (`114`, `115`), `JSON.parse` throws `SyntaxError`. The facilitator catches it in `facilitator/src/server.mjs:80` and returns `{ ok: false, code: 'BAD_JSON' }`.
  2. For a buffer with an unescaped null byte (`147`: `{"signed_delegate":"\0"}`), the internal V8 JSON parser rejects the unescaped control character per RFC 8259, yielding `BAD_JSON` before the delegate is checked.
- **Security status**: Fail-closed HTTP 400. `BAD_JSON` is the most precise code.
- **Proposed action**: Change the expectation from `BAD_REQUEST`/`BAD_ENCODING` to `BAD_JSON`.

### Family 8: Verb Rejection and Conflicting Headers in the Node.js HTTP Parser (Class A)
- **Related cases**: `KAT-B-12-119`, `KAT-B-12-120`, `KAT-B-12-121`, `KAT-B-12-135` (4 cases)
- **Root cause**:
  1. Absurd verbs (`BREACH`, `ATTACK`, `HACK`) are rejected directly by Node.js's C library `llhttp` before reaching the application handler. This triggers a `clientError` event with a raw `400 Bad Request` response (`HTTP_400`). The tests expect `METHOD_NOT_ALLOWED` (405).
  2. Conflicting `Content-Length` and `Transfer-Encoding` headers violate RFC HTTP/1.1 and are rejected directly by the Node parser with status 400 (`HTTP_400`).
- **Security status**: Rejection at the socket transport level is safer and more efficient at preventing request smuggling.
- **Proposed action**: Update the test expectation to `HTTP_400`.

### Family 9: Layer C Client Parser (Class A)
- **Related cases**: `KAT-C-08-11`, `KAT-C-08-25`, `KAT-C2-08-12`, `KAT-C2-12-11` (4 cases)
- **Root cause**:
  1. `KAT-C-08-11`: JSON nested 1500 levels deep is parsed by the V8 parser without a crash, producing an object with `ok: false, success: false`. The client parser returns a safe `INERT` object and does not throw `RangeError`.
  2. `KAT-C-08-25`: A response with a malformed base64 header fails to decode and falls back to a safe response payload (`ok: false, success: false`), without throwing `RangeError`.
  3. `KAT-C2-08-12`: A null byte in a JSON string is rejected by `JSON.parse` per RFC 8259, triggering a safe `RangeError`. The test wrongly expects `INERT`.
  4. `KAT-C2-12-11`: An empty array `[]` is passed to `intentHash`. Reading `input.mandateId` gives `undefined`, which triggers a `TypeError` in `toU64`. The test expects `RangeError`.
- **Security status**: All are safe and reject forged transaction state.
- **Proposed action**: Update the test expectations to match ECMAScript semantics and RFC 8259.

---

## 4. Detailed List of the 68 FAIL Cases

| Case ID | Expected | Actual | Class | Reason | Proposed Action |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **KAT-B-05-109** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` uppercases verb `post` to `POST`, dummy body triggers BAD_ENCODING. | Use a raw socket to send non-standard method casing. |
| **KAT-B-05-110** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` uppercases verb `Post` to `POST`. | Use a raw socket to send non-standard method casing. |
| **KAT-B-05-111** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` uppercases verb `pOsT` to `POST`. | Use a raw socket to send non-standard method casing. |
| **KAT-B-05-125** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | XFF header is allowed; empty string body payload is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-126** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Whitespace XFF is parsed; empty string body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-127** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Authorization header is ignored by the relayer; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-128** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Basic Auth header is ignored; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-129** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | AWS4 signature header is ignored; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-130** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | External Host header is accepted by transport; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-131** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | X-Forwarded-Host header is ignored; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-132** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | X-Forwarded-Proto header is ignored; body is rejected fail-closed with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-133** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | X-Real-IP header is ignored (XFF is used); body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-134** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Valid x-request-id header is logged; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-135** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Punctuation in x-request-id is accepted; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-136** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | URL-encoded characters in x-request-id are accepted; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-137** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Duplicate version header is ignored; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-05-138** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Fake rate-limit bypass header is ignored; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-07-140** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Burst of 10 requests is within the capacity of 20; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-07-141** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Burst of 15 requests is within the capacity of 20; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-07-142** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Concurrency of 5 requests is within the capacity of 20; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-07-143** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Concurrency of 12 requests is within the capacity of 20; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-08-110** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Valid content-type charset utf-8 is accepted; empty string body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-08-111** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Case-insensitive content-type APPLICATION/JSON is valid; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-08-112** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Boundary parameter on application/json is ignored; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-08-113** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Route /verify rejects the missing payment-signature header before the content-type check. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-08-114** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_JSON) | **A** | Empty string body fails JSON.parse and returns code BAD_JSON. | Update expectation to BAD_JSON. |
| **KAT-B-08-115** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_JSON) | **A** | Whitespace-only body fails JSON.parse and returns code BAD_JSON. | Update expectation to BAD_JSON. |
| **KAT-B-08-147** | BLOCKED (BAD_ENCODING) | BLOCKED (BAD_JSON) | **A** | Unescaped null byte in a JSON string is an RFC 8259 syntax error (BAD_JSON). | Update expectation to BAD_JSON. |
| **KAT-B-09-02** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (BAD_ENCODING) | **B** | Runner clock jump (+5s) refills tokens; request is not rate-limited and is rejected via body. | Add parameter floodCount: 25 to the case. |
| **KAT-B-09-03** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (TX_NOT_FOUND) | **B** | IP limiter tokens have been refilled; endpoint /status returns TX_NOT_FOUND. | Add parameter floodCount: 25 to the case. |
| **KAT-B-09-04** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | IP limiter tokens have been refilled; /verify rejects the missing signature header. | Add parameter floodCount: 25 to the case. |
| **KAT-B-09-05** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | IP limiter tokens have been refilled; /settle rejects the missing signature header. | Add parameter floodCount: 25 to the case. |
| **KAT-B-09-106** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Concurrency of 20 requests on /relay fails delegate validation (BAD_ENCODING). | Update expectation to BAD_ENCODING. |
| **KAT-B-09-107** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Concurrent requests on /verify are rejected fail-closed because the payment-signature header is missing. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-108** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Concurrent requests on /settle are rejected fail-closed because the payment-signature header is missing. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-109** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | 18 sequential requests (capacity 20) are rejected fail-closed by the delegate validator. | Update expectation to BAD_ENCODING. |
| **KAT-B-09-110** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Concurrency of 10 requests is rejected fail-closed by the delegate validator with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-09-123** | BLOCKED (UPSTREAM_ERROR) | BLOCKED (EXPIRES_TOO_FAR) | **C** | `relay.mjs:170` converts `height: null` to 0, so it reaches the expiry check. | Fix validation: `typeof height === 'number' && h > 0`. |
| **KAT-B-09-124** | BLOCKED (UPSTREAM_ERROR) | BLOCKED (EXPIRES_TOO_FAR) | **C** | `relay.mjs:170` treats a negative height (-10) as valid, so it reaches the expiry check. | Fix block height validation to require `h > 0`. |
| **KAT-B-09-130** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | The get_mandate test on /verify does not send a payment-signature header. | Add a payment-signature header to the case definition. |
| **KAT-B-09-131** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | The null get_mandate test on /verify does not send a payment-signature header. | Add a payment-signature header to the case definition. |
| **KAT-B-09-132** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | The token mismatch test on /verify does not send a payment-signature header. | Add a payment-signature header to the case definition. |
| **KAT-B-09-140** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /verify rejects a missing payment-signature with a precise structured code. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-141** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /verify rejects an empty payment-signature header with a precise code. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-142** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /verify rejects malformed payment-signature base64 with BAD_PAYMENT_SIGNATURE. | Update expectation to BAD_PAYMENT_SIGNATURE. |
| **KAT-B-09-144** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /settle rejects a missing payment-signature with a precise structured code. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-145** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /settle rejects an empty payment-signature header with a precise code. | Update expectation to MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-146** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /settle rejects malformed payment-signature base64 with BAD_PAYMENT_SIGNATURE. | Update expectation to BAD_PAYMENT_SIGNATURE. |
| **KAT-B-09-147** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /settle with body {} and signature 'abc' (not JSON) is rejected with BAD_PAYMENT_SIGNATURE. | Update expectation to BAD_PAYMENT_SIGNATURE. |
| **KAT-B-12-102** | BLOCKED (NOT_FOUND) | BLOCKED (BAD_ENCODING) | **B** | `new URL()` in the runner normalizes `/relay/../relay` to `/relay`, then it is rejected via body. | Use a raw HTTP path without client resolution. |
| **KAT-B-12-112** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Query string on POST /relay is ignored by routing; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-113** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | SQL injection query is ignored by routing; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-114** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Log4j JNDI query is ignored by routing; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-116** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Long query string (2KB) is ignored by routing; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-119** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | Node.js HTTP parser (llhttp) rejects verb 'BREACH' with 400 Bad Request. | Update expectation to HTTP_400. |
| **KAT-B-12-120** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | Node.js HTTP parser (llhttp) rejects verb 'ATTACK' with 400 Bad Request. | Update expectation to HTTP_400. |
| **KAT-B-12-121** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | Node.js HTTP parser (llhttp) rejects verb 'HACK' with 400 Bad Request. | Update expectation to HTTP_400. |
| **KAT-B-12-129** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | 4KB custom header is within Node's 16KB limit; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-130** | BLOCKED (REQUEST_HEADER_FIELDS_TOO_LARGE) | BLOCKED (BAD_ENCODING) | **A** | 10KB header does not exceed Node's default 16KB limit; body is rejected with BAD_ENCODING. | Raise the test header size above 16KB or change the expectation. |
| **KAT-B-12-131** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | 50 custom headers are accepted by the HTTP parser; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-132** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Space header is accepted by the HTTP parser; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-133** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header with a trailing colon is accepted; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-134** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header with a URL-encoded carriage return is accepted; body is rejected with BAD_ENCODING. | Update expectation to BAD_ENCODING. |
| **KAT-B-12-135** | BLOCKED (BAD_REQUEST) | BLOCKED (HTTP_400) | **A** | Conflicting Content-Length and Transfer-Encoding headers are rejected directly by llhttp (400). | Update expectation to HTTP_400. |
| **KAT-C-08-11** | BLOCKED (RangeError) | INERT | **A** | JSON nested 1500 levels deep is parsed safely by V8 and yields ok=false without a crash. | Update expectation to INERT. |
| **KAT-C-08-25** | BLOCKED (RangeError) | INERT | **A** | Malformed base64 header is ignored and falls back to a safe response object (ok=false). | Update expectation to INERT. |
| **KAT-C2-08-12** | INERT | BLOCKED (RangeError) | **A** | Unescaped null byte in a string is forbidden by RFC 8259, triggering RangeError. | Update expectation to BLOCKED (RangeError). |
| **KAT-C2-12-11** | BLOCKED (RangeError) | BLOCKED (TypeError) | **A** | Input array `[]` triggers TypeError in toU64 (wrong type), not RangeError. | Update expectation to BLOCKED (TypeError). |
