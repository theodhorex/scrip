# C1 client lib report
Result: `make -C /home/theo/Documents/dev/hackathon/amanat test` → 60 tests, 60 pass, 0 fail (intent 32, events 12, stats 16).
TDD: each test file was run red first (module missing; first run 1 fail, then 2 fail with events/stats tests) before implementation.
Mutation check: switching `le()` to big-endian made 11 intent tests fail (21/32 pass); reverted → green.

## Vectors: 10 positive (typical, zeros, max u64, max u128, 64-byte and 1-byte recipient, charset, 2^64 amount, amount 1, endianness probe)
## Negative cases (all RangeError): mandate_id u64 overflow, mandate_id negative, nonce overflow, expires overflow,
amount u128 overflow, amount leading zero, "-5", "+5", "1.5", "", " 5", recipient empty, 65 bytes, uppercase,
non-ASCII, space, slash. Extra JS-only tests: unsafe/non-integer/NaN/negative/string Number inputs, non-string amount/recipient (TypeError).

## PRD ambiguities resolved
- Recipient charset is `[a-z0-9._-]` per task; ASCII-only so byte length == char length. Violations are RangeError.
- Empty/over-long/charset recipient and non-canonical amount: RangeError; wrong JS type: TypeError.
- `withdrawn` must not exceed `deposited` (treated as "total would go negative"). Funding via `mandate_created` is NOT counted as deposit; if the contract funds that way, relax this check.
- Settle/refund/stale_resolved also throw if no request is open (`open` would go negative).
- Partial settlement is not modeled: each release event removes one open request.
- Events with `mandate_id` seen first create the mandate entry, even `rejected`.

## Skills dipakai
- test-driven-development: vectors and tests first, red then green, mutation check.
- api-and-interface-design: small exports, typed errors, no global state, README.
- security-and-hardening: strict canonical validation, no floats, reject instead of normalize.
- incremental-implementation: intent → vectors → events → stats, `make test` after each slice.
