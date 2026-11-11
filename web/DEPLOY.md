# Deploying Scrip Web to Vercel

This guide covers deploying the Scrip frontend to [Vercel](https://vercel.com).

## 1. Project Configuration

When importing this repository into Vercel:

- **Root Directory**: `web` (click Edit and select the `web` folder)
- **Framework Preset**: Next.js
- **Build Command**: `next build` (default)
- **Output Directory**: `.next` (default)
- **Node.js Version**: 20.x or higher

## 2. Environment Variables

All environment variables are optional. No private keys, seed phrases, or sensitive API secrets are ever required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SCRIP_RPC_URL` | No | `https://rpc.testnet.fastnear.com` | Public NEAR testnet JSON-RPC endpoint. Must use HTTPS and include `testnet` in the hostname. |
| `SCRIP_CONTRACT_ID` | No | *(unset)* | Testnet account ID of the deployed Scrip contract (e.g. `scrip-1.testnet`). |

### Running with Sample Data vs On-Chain Mandates

- **Without `SCRIP_CONTRACT_ID`**: The application runs entirely in sample mode, loading pre-recorded testnet results and fixtures (`demo.json`, `gate.json`, `attack.json`). A clear banner notifies viewers that sample data is displayed.
- **With `SCRIP_CONTRACT_ID`**: The dashboard queries live state for mandates from the deployed contract over read-only JSON-RPC `call_function` view calls.

## 3. Verification Page

The client-side verification page (`/verify`) queries the public NEAR testnet RPC directly from the browser without requiring any API keys or server-side relays.
