# CORRECTIONS_D2 — D1b-re_staging 6 layer B cases + header-spoof case design

## Part 1 — Triage of the 6 remaining FAIL cases (all Class A: SAFE_MISMATCH; no change to `facilitator/src/**`)

| id | problem (root cause) | change | evidence |
| --- | --- | --- | --- |
| KAT-B-05-109 | The harness already sends the verb `post` verbatim via raw socket, but the Node HTTP server parser (llhttp) rejects non-canonical method tokens with `HPE_INVALID_METHOD` → 400 Bad Request at the transport level; the 405 handler (`server.mjs:366`) is never reached. This rejection is stronger than the application-level 405 (same fail-closed behavior). Same class of problem as 12-119..121, which were already corrected to `HTTP_400` in A2B. | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | Repro `/tmp/opencode/repro-verb.mjs`: `clientError: HPE_INVALID_METHOD Parse Error: Invalid method encountered` for `post`, `Post`, `pOsT`; `facilitator/src/server.mjs:365-367` (405 only after parsing succeeds) |
| KAT-B-05-110 | Same as 05-109 (verb `Post`). | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | same as above |
| KAT-B-05-111 | Same as 05-109 (verb `pOsT`). | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | same as above |
| KAT-B-09-130 | The request uses a VALID x402 header (payment-signature built with a real ed25519 delegate), so it reaches the `get_mandate` lookup; the mock `onCallFunction` throws an upstream error. The server rejects fail-closed with 502 `UPSTREAM_ERROR` (mapped in `server.mjs:28`), not a generic `BAD_REQUEST`. | `expected.code`: `BAD_REQUEST` → `UPSTREAM_ERROR` | `facilitator/src/server.mjs:142-171` (valid header is required and passes before the lookup); `server.mjs:28` (STATUS.UPSTREAM_ERROR=502); baseline run shows actual 502 UPSTREAM_ERROR |
| KAT-B-09-131 | Same, but `get_mandate` returns `null` → rejected with `MANDATE_NOT_FOUND` (400), the exact code per the `STATUS` map contract. | `expected.code`: `BAD_REQUEST` → `MANDATE_NOT_FOUND` | `facilitator/src/relay.mjs` getMandate; `server.mjs:28` (MANDATE_NOT_FOUND=400); baseline run actual MANDATE_NOT_FOUND |
| KAT-B-09-132 | Same, the mandate is found but `token: 'evil.token'` ≠ `requirements.asset usdc.testnet` → `ASSET_MISMATCH` (400). | `expected.code`: `BAD_REQUEST` → `ASSET_MISMATCH` | `facilitator/src/server.mjs:157-171` (fail-closed asset check); baseline run actual ASSET_MISMATCH |

Result: layer B run after the corrections → **369 cases: PASS 369, FAIL 0, BREACH 0**.

## Part 2 — Header-spoof case design (`cases/d2_spoof.mjs`, expectations written BEFORE execution)

Premise: all cases use a VALID delegate/payload (based on the layer B case pattern that already passes — real ed25519 delegate via `facilitator/test/helpers.mjs makeSigned`, same configuration as the INERT cases that already pass). No fake body/forged payload. Duplicates the passing case patterns: `c2_extra` (default delegate INERT) and `b2_extra: paymentSignature`.

Spoofed headers: `x-forwarded-for`, `x-real-ip`, `forwarded`, `host`, `origin`.
Code facts (`facilitator/src/server.mjs:34-41`, `trustProxy: true` in the harness): only the LAST-HOP `x-forwarded-for` is trusted; `x-real-ip`, `forwarded`, `host`, `origin` are not read at all for IP/route decisions.

### Expectations (written before running)

| id | spoofed header | scenario | expectation (reason) |
| --- | --- | --- | --- |
| KAT-B-05-210 | — (control) | valid delegate, no fake header | INERT — tx is relayed; baseline for "no fake header" |
| KAT-B-05-211 | — (control) | valid delegate but expired `maxBlockHeight` (2400 vs height ~1000) | BLOCKED `EXPIRES_TOO_FAR` — baseline for the BLOCKED decision |
| KAT-B-05-212 | `x-forwarded-for` (fresh fake IP) | valid delegate | INERT — same as control 210; XFF only selects a fresh bucket |
| KAT-B-05-213 | `x-real-ip` | valid delegate | INERT — header is not read (server.mjs:35-41) |
| KAT-B-05-214 | `forwarded` | valid delegate | INERT — header is not read |
| KAT-B-05-215 | `host` | valid delegate | INERT — routing does not depend on Host |
| KAT-B-05-216 | `origin` | valid delegate | INERT — no Origin check on /relay |
| KAT-B-05-217 | `x-forwarded-for` (fresh fake IP) | valid delegate + expired | BLOCKED `EXPIRES_TOO_FAR` — the BLOCKED decision is not changed by the claimed IP |
| KAT-B-05-218 | `x-real-ip` | valid delegate + expired | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-219 | `forwarded` | valid delegate + expired | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-220 | `host` | valid delegate + expired | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-221 | `origin` | valid delegate + expired | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-222 | `x-forwarded-for` constant `10.20.30.42` | flood of 25 identical valid-delegate requests → the 25th request | BLOCKED `IP_RATE_LIMITED` — the same claimed IP cannot refill the bucket (capacity 20, refill 1/s) |
| KAT-B-05-223 | `x-real-ip`+`forwarded`+`origin` (fresh IP) in flood + final | flood of 25 with constant XFF + fake "fresh IP" headers | BLOCKED `IP_RATE_LIMITED` — unread headers cannot rotate the bucket (bucket is keyed by the constant last-hop XFF) |
| KAT-B-05-224 | fake `host`+`origin` in flood + final | flood of 25 with constant XFF | BLOCKED `IP_RATE_LIMITED` — Host/Origin spoofing does not open the bucket |
| KAT-B-05-225 | `/verify`, constant `x-forwarded-for` | flood of 25 valid x402 → the 25th | BLOCKED `IP_RATE_LIMITED` — the per-IP limit also applies on the /verify route (server.mjs:120) |

If the actual result differs from the expectation, the result CAN BE REPORTED as-is (BREACH/FAIL is not patched); BLOCKED/INERT/BREACH classification follows `runner.mjs:83-93`.

### Actual results (executed AFTER the expectation table above was written; no expectation adjustments)

| id | actual | result |
| --- | --- | --- |
| 210..216 | INERT (`tx relayed`) for control 210 AND 212..216; 211 BLOCKED EXPIRES_TOO_FAR | as expected |
| 212 | INERT — same as control 210 (tx relayed) | as expected |
| 213..216 | INERT — x-real-ip / forwarded / host / origin ignored, per `server.mjs:35-41` | as expected |
| 217..221 | BLOCKED `EXPIRES_TOO_FAR` — decision identical to control 211 even though a fake IP/Host/Origin is claimed | as expected |
| 222..224 | BLOCKED `IP_RATE_LIMITED` (HTTP 429) on the 25th request | as expected |
| 225 | BLOCKED `IP_RATE_LIMITED` (HTTP 429) on /verify | as expected |

Summary: all 16 spoof cases match the expectations written before execution; 0 BREACH; no fake header changed a decision or opened a per-IP bucket. Limitation note: a last-hop XFF claim that is ROTATED creates a fresh bucket because `trustProxy: true` in the harness assumes a trusted reverse proxy that appends the last hop itself (an operator configuration decision, not a code defect; moved to triage, not patched).
