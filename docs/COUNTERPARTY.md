# Counterparty Risk Evaluation & Guarded Signing

Client-side security module to evaluate recipient accounts (`receiver`) before the agent signs or submits a payment.

## Signals & Data Sources

1. **`account_age` (Account Age & Activity)**
   - **Source**: HTTP indexer (`providers.accountHistory(receiver)`)
   - **Data**: `firstSeenMs` (when the account first appeared on chain) and `txCount` (number of transactions).
   - **Thresholds**: Default `minAgeMs` = 7 days (604,800,000 ms), `minTxCount` = 3 transactions.
   - **Verdict**: New or underage account or transactions < 3 produces `warn`.

2. **`contract_code` (Contract Code Status & Integrity)**
   - **Source**: NEAR JSON-RPC `query/view_account` (`providers.accountState`) + local pin store (`providers.codePin`).
   - **Verdict**:
     - Not a contract (`codeHash` null): `info`.
     - First-time new contract: mild `warn`; hash is stored to pin ONLY if final verdict is not `block`.
     - Code changed compared to pin: `warn` ("code changed since last seen").
     - Account does not exist on chain: `warn`.

3. **`prior_interaction` (Agent Interaction History)**
   - **Source**: Local JSON log of agent history (`providers.interactions(agentId, receiver)`).
   - **Verdict**: `count == 0` -> `warn` ("new recipient for this agent"); `count >= 1` -> `info`.

4. **`blocklist` (Evidence-Based Blocklist)**
   - **Source**: Curated local JSON file (`providers.blocklist.lookup(receiver)`).
   - **Evidence Rule**: An entry is considered evidenced only if it contains `txHash` (base58 string, 32-44 characters) OR `url` with `http`/`https` scheme (up to 300 characters); `note` is auxiliary only and never sufficient alone, so text claims without verifiable references cannot block a legitimate recipient.
   - **Anti-Griefing Protection**: Reports without verifiable evidence (including `note` only, malformed or too short `txHash`, or `url` with schemes like `javascript:`/`ftp:`) are excluded from block status and recorded as `warn` ("report without evidence").

## Aggregation & Signing (`guardedSign`)

- **Aggregation**: Any `block` reason -> `block` verdict (score 100); any `warn` reason -> `warn` verdict (+20 score per warn, max 100); otherwise `allow` (score 0).
- **Fail-Closed**: Provider failure (default timeout 4000ms / throw) produces `warn` with `source: 'unavailable'`, NOT a silent `allow`.
- **Input Validation**: Recipient invalid per NEAR/intent hash rules directly produces `block` (`signal: 'input'`).
- **`guardedSign` Flow**:
  - `block`: Rejects transaction, does not call `sign`, throws `GuardBlockedError`.
  - `warn`: Prompts human (`askHuman`). Only signs if answer is strictly `true`; if `false`/error/timeout/no `askHuman` -> throws `GuardDeniedError`.
  - `allow`: Calls `sign` exactly once.
  - Optional audit log recorded via `policy.audit` without leaking secret keys.

## Honest Limitations

1. **Indexer Dependency**: Without a trusted external indexer, account age and transaction volume history cannot be verified independently by a standard RPC full node.
2. **Local Pin Limitations**: `codePin` relies on local storage per machine/agent; a new agent lacks previous pin snapshots unless shared securely.
3. **Not a Logic Audit**: An `allow` status or matching hash only proves code has not changed since the first pin, not that the contract is secure or vulnerability-free.
