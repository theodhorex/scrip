# Open key challenge (DRAFT, NOT PUBLISHED)

Status: prepared only. Publishing a key is Theo's decision. Do not run any step below without it.

## Idea
Publish the agent's function-call private key for a funded testnet mandate and invite anyone to drain it. If the contract rules hold, the most an attacker can take is the mandate's budget, and only to allowlisted recipients, within the per-payment cap and before expiry.

## Setup (to run once Theo approves)
1. New testnet accounts only (never reuse funder keys): `challenge-owner`, `challenge-agent`, `challenge-guardian`, merchant on the allowlist.
2. Deploy the final `amanat.wasm`; create a mandate with a small budget (e.g. 1 USDC), per-payment cap 0.1, allowlist = the merchant only, expiry = challenge end.
3. Add the agent's function-call key (receiver = contract, method `request_payment`). Publish THAT key only. Owner and guardian keys stay private.
4. Run the facilitator with `allowedAgents = [challenge-agent]`.
5. Publish: contract id, mandate id, agent key, facilitator URL, rules, and a link to `contracts/amanat/AUDIT_*.md`.

## Success definition
- Attacker cannot move more than the budget, cannot pay a non-allowlisted account, cannot exceed the cap, cannot call owner/guardian methods.
- A bounty-free challenge; any valid break is reported in the repo issues and fixed.

## After
Revoke, withdraw the remainder, delete the accounts, record the on-chain tx list in `results/challenge.json`.
