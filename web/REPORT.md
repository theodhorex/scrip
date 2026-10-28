# FE2 Chain Reader Implementation Report

## Summary of Implementation
- **`src/lib/chain.ts`**: Implemented `viewCall<T>(contractId, method, args)` over NEAR testnet JSON-RPC (`call_function` / `finality: "final"`). Server-only (`import "server-only"`). Validates `AMANAT_RPC_URL` (default `https://rpc.testnet.fastnear.com`), requiring HTTPS and "testnet" in hostname. Base64-encodes args, decodes result bytes to JSON, sets 8s timeout with `AbortController`. Catches HTTP 429 (`RpcRateLimitError`), RPC error payloads (`RpcError`), network/timeout errors (`RpcTimeoutError`).
- **`src/lib/mandate-map.ts`**: Pure `mapMandateView(raw, id): Mandate` mapping contract snake_case fields to camelCase `Mandate` type. Strictly validates canonical decimal strings for amounts (`CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/`), checks `<= U128_MAX`, validates NEAR account IDs, and ensures status is "Active" | "Revoked". Throws typed `MandateMapError` with field name on failure.
- **`src/lib/mandate-map.test.mjs`**: Comprehensive test suite using Node native test runner (`node --test`). Tests valid mappings, status variations, missing field detection, non-canonical amounts rejection, U128 limits, non-object payloads, and malformed accounts/counters.
- **`src/lib/amanat.ts`**: Evaluates `IS_SAMPLE_DATA = !process.env.AMANAT_CONTRACT_ID` server-side. When set, `listMandates()` queries mandate 0 (spike contract), `getMandate(id)` fetches live via RPC and maps it, `listEvents` returns `[]` (honest empty state). Throws errors so calling pages can render `<ChainError />`.
- **`src/components/ChainError.tsx`**: Accessible error boundary UI (`role="alert"`) distinguishing rate limits, timeouts, RPC errors, and schema mismatches. Clearly indicates live data is configured so sample data is never shown in its place.
- **`src/app/mandates/page.tsx` & `src/app/mandates/[id]/page.tsx`**: Integrated with `ChainError`, wrapped with `<Suspense>` and `LoadingState`.
- **`web/.env.example` & `web/README.md`**: Documented environment variables and updated Data source section.

## Next.js Documentation & Caching Approach
- Followed `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md` ("Streaming uncached data") and `06-fetching-data.md` ("Streaming with <Suspense>").
- With `cacheComponents: true`, live chain data must not be frozen into the static prerender shell. We used `await connection()` and wrapped data components in `<Suspense fallback={<LoadingState />}>` so that the static layout shell renders instantly while uncached live data streams per request.

## Test & Verification Results
- `node --test src/lib/mandate-map.test.mjs`: 9 tests passed, 0 failures.
- `bunx tsc --noEmit`: Clean exit (0 errors).
- `bun run lint`: Clean exit (0 errors).

## Limitations
- Single mandate spike contract: contract only supports mandate ID 0 (`get_mandate` takes no arguments yet).
- Events: returns `[]` in live mode until an indexer is deployed.
- Read-only: only JSON-RPC view calls are implemented; transaction creation requires wallet integration.

## Skills dipakai
- **source-driven-development**: Verified caching & data fetching patterns directly against Next.js 16 docs in `node_modules/next/dist/docs/` (`08-caching.md`, `06-fetching-data.md`), applying Suspense and `connection()` for uncached RPC streaming.
- **frontend-ui-engineering**: Built accessible `ChainError` component with `role="alert"` and clear error messaging without layout shifts.
- **test-driven-development**: Wrote 9 unit tests in `mandate-map.test.mjs` verifying valid views, missing fields, non-canonical amounts, and boundary cases.
- **security-and-hardening**: Guarded RPC endpoint to HTTPS testnet only, enforced server-only execution, base64-encoded arguments, and strictly validated untrusted chain data.
- **incremental-implementation**: Implemented slices incrementally (`chain.ts` -> `mandate-map.ts` -> `amanat.ts` -> UI), checking `tsc` and `lint` after each step.
