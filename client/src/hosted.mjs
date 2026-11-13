// Gasless payments through a hosted Scrip relayer (default: the public testnet relayer at scrip-dev.vercel.app).
// The only module here that touches the network: it reads the agent key's nonce and a final block height over RPC,
// signs a request_payment delegate offline, and POSTs it. Provider and fetch are injectable for tests.
import { JsonRpcProvider } from 'near-api-js';
import { buildRequestPayment, signDelegate, relayBodyFor, classifyRelayResponse } from './delegate.mjs';

export const HOSTED_RELAY_URL = 'https://scrip-dev.vercel.app/api/relay';
export const TESTNET_RPC_URL = 'https://rpc.testnet.fastnear.com';
/** Blocks the signed delegate stays valid for (the hosted relayer accepts up to 300 ahead). */
export const DELEGATE_TTL_BLOCKS = 100n;

/**
 * Pays from a mandate as its agent, with the relayer paying the gas.
 * @param {{agentId: string, keyPair: object, contractId: string, mandateId: bigint|number, recipient: string, amount: string,
 *   nonce?: bigint|number, gas?: bigint, relayUrl?: string, rpcUrl?: string, provider?: object, fetch?: Function}} p
 * @returns {Promise<{ok: boolean, txHash: string|null, innerStatus: string|null, innerCode: string|null, code: string|null, retryable: boolean}>}
 *   `ok` means the relayer submitted the transaction; `innerStatus` is the contract's answer (Settled, Rejected, Refunded, ...).
 */
export async function payGasless(p) {
  if (p === null || typeof p !== 'object') throw new TypeError('input must be an object');
  const provider = p.provider ?? new JsonRpcProvider({ url: p.rpcUrl ?? TESTNET_RPC_URL });
  const doFetch = p.fetch ?? globalThis.fetch;
  const publicKey = p.keyPair?.getPublicKey?.();
  if (!publicKey) throw new TypeError('keyPair must be a near-api-js KeyPair');
  const action = buildRequestPayment({
    contractId: p.contractId, mandateId: p.mandateId, recipient: p.recipient, amount: p.amount,
    nonce: p.nonce ?? BigInt(Date.now()), ...(p.gas === undefined ? {} : { gas: p.gas }),
  });
  const [key, block] = await Promise.all([
    provider.viewAccessKey({ accountId: p.agentId, publicKey: publicKey.toString() }),
    provider.viewBlock({ finality: 'final' }),
  ]);
  const { base64 } = await signDelegate({
    agentId: p.agentId, contractId: p.contractId, action,
    nonce: BigInt(key.nonce) + 1n, maxBlockHeight: BigInt(block.header.height) + DELEGATE_TTL_BLOCKS, keyPair: p.keyPair,
  });
  const res = await doFetch(p.relayUrl ?? HOSTED_RELAY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: relayBodyFor(base64) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const c = classifyRelayResponse({ status: res.status, body, retryAfter: res.headers?.get?.('retry-after') ?? null });
  return {
    ok: c.ok,
    txHash: c.txHash,
    innerStatus: c.ok && typeof body?.inner_status === 'string' ? body.inner_status : null,
    innerCode: c.ok && typeof body?.inner_code === 'string' ? body.inner_code : null,
    code: c.code,
    retryable: c.retryable,
  };
}
