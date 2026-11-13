# Scrip Attack Catalog

Structured attack catalog framework proving Scrip protocol resilience across execution layers (Layers A-E) according to `web/docs/RENCANA_ATTACK_2500.md` and `.agy/BRIEF_BACKEND.md`.

## Result Label Definitions

Attack execution results fall into 4 objective labels:
- `BLOCKED`: The attack was rejected with the expected error code or exception, without balance changes or unauthorized state mutation.
- `INERT`: Absurd or invalid input that had no effect on the system and caused no crash or unexpected failure.
- `OUT_OF_SCOPE`: Scenario outside the threat model (e.g., leaked full-access key, malicious token contract, lying RPC); not claimed as prevented by the protocol, recorded honestly as a recognized boundary.
- `BREACH`: An attack that penetrated system security boundaries. Every BREACH finding must be reported directly without omission.

## Verdict Definitions

- `PASS`: The `actual` execution result matches the `expected` design (both label and code match).
- `FAIL`: The `actual` execution result differs from the `expected` design.
- `BREACH`: The attack bypassed protection (`actual.label === 'BREACH'`).
- `SKIPPED`: The executor for the relevant layer is not yet available (counted separately, never counted as PASS).

## Running the Catalog

Run all sample cases for Layer C (offline client and parser):
```bash
node scripts/attack-catalog/run.mjs --layers C
```

Available CLI options:
```bash
# Specify which layers to run
node scripts/attack-catalog/run.mjs --layers C

# Specify output file path
node scripts/attack-catalog/run.mjs --layers C --out results/attack-catalog.json

# Specify timeout per case (milliseconds)
node scripts/attack-catalog/run.mjs --layers C --timeout 3000
```

By default, execution results are saved to `scripts/attack-catalog/.out/attack-catalog.json` (ignored by git).

Run all catalog unit tests:
```bash
node --test scripts/attack-catalog
```

## Adding New Cases

1. Create or update case generators in `scripts/attack-catalog/cases/`:
   - Use parametric generation (parameter variation vectors) rather than repetitive object literals.
   - Assign a unique `id` (recommended format: `KAT-<LAYER>-<CATEGORY>-<NUMBER>`).
   - Specify `category` (1..12), `layer` ('A'|'B'|'C'|'D'|'E'), `title`, and `params`.
   - Specify `expected` based on **DESIGN/SPECIFICATION**, not current implementation output.
2. Register new cases in `getSampleCases()` in `scripts/attack-catalog/cases/index.mjs`.
3. Provide layer executor functions in `defaultExecutors` if testing a new layer.

## Strict Honesty Rules

When an actual result (`actual`) differs from design expectation (`expected`), **REPORT it as FAIL**. Never change `expected` silently just to produce green test reports.

### Layer C Design Correction Notes
- `KAT-C-02-01` (amount "0"): original expectation was misplaced: Layer C only validates format; zero rejection is tested in Layer A -> expected changed to INERT.

## Layer E (Testnet Harness)

End-to-end execution harness on NEAR Testnet via real facilitator / RPC (`scripts/attack-catalog/layers/testnet.mjs`).

### Safety and Operational Rules
- **Rate Limiting**: Strictly limited to `<= 8 rps` via a Token-Bucket limiter.
- **Fail-Closed & State Audit**: Compares mandate status (`get_mandate`) and balances before vs after; `BLOCKED` cases that mutate state are classified as `BREACH`.
- **Wave Execution**: Cases process in waves `<= 60 cases` with partial result saves to prevent progress loss from timeouts.
- **Lifecycle & Recovery**: A `.recovery-catalog-<ts>.json` file (`0600` mode) must exist BEFORE on-chain accounts are created. In the `finally` block, all mandates are revoked & withdrawn, NEAR/USDC balances sweep back to the funder, and accounts are deleted. The recovery file is removed only when leftover accounts equal `[]`.

### Cost Estimates
Based on `web/docs/RENCANA_ATTACK_2500.md`:
- **Contract Deploy**: ~1.4 NEAR (one-time storage cost; refunded to funder upon deleteAccount).
- **Mandates**: ~2–3 NEAR for 40–60 mandates (0.05 NEAR initial deposit per mandate; recovered via withdraw).
- **Relayer Gas**: ~0.15 NEAR for ~600 relay transactions (~0.00025 NEAR per tx, covered by relayer).
- **USDC**: Small testnet USDC amount for valid payment testing (swept back to funder).
- **Funder Balance Requirements**: Minimum 5 NEAR in funder account and 3 NEAR in relayer account.

### Execution Instructions
1. **Unit Test & Dry Run Mode (Offline / No Network)**:
   ```bash
   node --test scripts/attack-catalog/test/testnet.test.mjs
   node --test scripts/attack-catalog
   ```
   *Note: Dry mode uses in-memory dynamic state simulation and cannot write to the `results/` directory.*

2. **Real Testnet Execution Mode (Project Manager Only)**:
   ```javascript
   import { createTestnetSession, runLayerEInWaves } from './layers/testnet.mjs';

   const session = await createTestnetSession({ dry: false, mandatesCount: 40 });
   try {
     const results = await runLayerEInWaves(cases, session, {
       waveSize: 50,
       partialOutPath: '.out/attack-catalog-layer-e.json',
     });
   } finally {
     await session.closeSession();
   }
   ```

## Running Layer E and Merging Results

### 1. Layer E Runner (`run-testnet.mjs`)

Dedicated CLI runner to execute Layer E attack cases in controlled waves (maximum 60 cases per wave, limiter `<= 8 rps`):

```bash
# Run wave 1 in dry mode (offline / no network)
node scripts/attack-catalog/run-testnet.mjs --wave 1 --dry

# Run a specific index range
node scripts/attack-catalog/run-testnet.mjs --from 0 --to 60 --dry

# Run naive baseline comparison cases
node scripts/attack-catalog/run-testnet.mjs --comparison --dry

# Specify custom output path
node scripts/attack-catalog/run-testnet.mjs --wave 1 --dry --out scripts/attack-catalog/.out/testnet-wave-1.json
```

**Guardrails:**
- Initializes testnet session once per run command.
- Writes partial results incrementally to the output file after each processed case to prevent loss on abort.
- Calls `closeSession()` strictly in `finally` blocks, as well as on `SIGINT` and `SIGTERM`.
- Prints execution summary (PASS, FAIL, BREACH), collected txHash count (without dumping full hash lists to log), and verifies remaining accounts are `[]`.
- In `--dry` mode, forbids writing directly to `results/`. Every case is tagged with `source: "dry"` (or `source: "real"` on real runs).

### 2. Catalog Result Merging (`merge.mjs`)

Reads layer result files (such as `.out/attack-catalog.json` for A/B/C, `.out/testnet-wave-*.json` for E, `.out/layer-a.json`, `.out/layer-d.json`) and merges them into one complete catalog:

```bash
# Merge all existing outputs in .out/ into .out/attack-catalog.merged.json
node scripts/attack-catalog/merge.mjs

# Specify specific input and output files
node scripts/attack-catalog/merge.mjs --inputs .out/attack-catalog.json,.out/testnet-wave-1.json --out .out/merged.json

# Publish results to results/attack-catalog.json (Real testnet runs only!)
node scripts/attack-catalog/merge.mjs --publish
```

**Guardrails:**
- Produces a 3-dimensional summary matrix: `category x layer x label`.
- Separately indexes all `BREACH` cases, `FAIL` cases, `SKIPPED` counts, `OUT_OF_SCOPE` cases, and naive comparison cases (`comparisonCases`).
- **Strict Publication Guard**: Writing to `results/` requires the explicit `--publish` flag. The command fails immediately if any included case has `source: "dry"`.
