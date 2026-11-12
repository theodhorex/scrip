# Try Scrip

Three ways in, from least to most effort. None of them needs a mainnet account or real funds.

## A. No install: read the evidence

- **Web verifier**: open the `/verify` page of the deployed web app, paste any testnet transaction hash from `results/*.json`, and it checks the transaction against the public archival testnet RPC (21 recorded transactions, all verified on 12 Nov 2026). (The page is in `web/src/app/verify/`; deployment steps are in `web/DEPLOY.md`.)
- **Attack results**: the `/attack` page renders the recorded attack catalog (`results/attack*.json`) with every label and verdict.
- **Claims to evidence**: `JUDGES.md` maps each claim to a command, the expected output and the file that backs it.

## B. Local, offline (Node 20+, Rust stable)

```sh
git clone <repo> && cd scrip
make script-test        # attack-catalog harness and script tests, no network
make contract-test      # contract unit and property tests
make demo-test          # client/facilitator tests
node scripts/attack-catalog/run.mjs --layers B,C   # offline attack layers; expect no FAIL or BREACH
```

## C. Local, with live testnet reads (no keys, no dependencies)

```sh
make verify-onchain     # re-checks every tx hash in results/*.json against the public archival testnet RPC (21 recorded transactions, all verified on 12 Nov 2026)
```

The verifier is read-only and uses the archival endpoint because the regular testnet RPC no longer keeps older transactions. If the RPC is overloaded or a transaction cannot be fetched it reports `UNVERIFIABLE`, which never counts as a pass. Re-run later, or set another RPC endpoint (see the header of `scripts/verify-onchain.mjs`).

## D. Your own testnet run (needs a funded testnet account)

Live waves (layer E) spend testnet NEAR and testnet USDC from a funder account you control. Never use a mainnet key. The procedure and safety stops are in `scripts/attack-catalog/README.md`.

## What this does not show

A hosted live demo against an AI agent with a real model is not part of this repo yet. See "What is not claimed" in `JUDGES.md`.
