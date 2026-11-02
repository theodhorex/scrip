// Layer B (Facilitator HTTP) Executor for Attack Catalog
// Starts real facilitator with mock RPC once, sends real HTTP requests, and maps responses.

import http from 'node:http';
import net from 'node:net';
import * as nearApi from '../../../facilitator/node_modules/near-api-js/lib/index.js';
import { createServer } from '../../../facilitator/src/server.mjs';
import { makeRelayer, createSerialQueue } from '../../../facilitator/src/relay.mjs';
import { loadPolicy } from '../../../facilitator/src/policy.mjs';
import { createRateLimiter } from '../../../facilitator/src/ratelimit.mjs';
import { createKeyVerifier } from '../../../facilitator/src/keycheck.mjs';
import {
  basePolicy,
  fakeProvider,
  makeSigned,
  goodPermission,
  AGENT,
  CONTRACT,
} from '../../../facilitator/test/helpers.mjs';

const { actions, KeyPair } = nearApi;

let serverState = null;

/**
 * Initializes and starts the real facilitator server once.
 *
 * @returns {Promise<{baseUrl: string, calls: object, state: object, server: object}>}
 */
export async function startFacilitatorServer() {
  if (serverState) {
    return serverState;
  }

  const calls = { submit: 0, viewAccessKey: 0, viewBlock: 0, callFunction: 0 };
  const dynamicState = {
    height: 1000,
    keyNonce: 0n,
    keyPermission: goodPermission(),
    onKey: null,
    onCallFunction: null,
    now: 1000,
  };

  const policy = loadPolicy({
    ...basePolicy,
    rateLimit: { capacity: 1000, refillPerSecond: 100 },
    globalRateLimit: { capacity: 5000, refillPerSecond: 500 },
    ipRateLimit: { capacity: 20, refillPerSecond: 1 },
    trustProxy: true,
  });

  const provider = fakeProvider({
    height: dynamicState.height,
    permission: dynamicState.keyPermission,
    onKey: async (args) => {
      calls.viewAccessKey++;
      if (typeof dynamicState.onKey === 'function') {
        return dynamicState.onKey(args);
      }
      return {
        nonce: dynamicState.keyNonce,
        permission: dynamicState.keyPermission,
      };
    },
    onCallFunction: async (args) => {
      calls.callFunction++;
      if (typeof dynamicState.onCallFunction === 'function') {
        return dynamicState.onCallFunction(args);
      }
      if (args?.method === 'get_mandate') {
        return { id: 1, token: 'usdc.testnet', owner: 'alice.testnet' };
      }
      return null;
    },
  });

  // Override viewBlock to use dynamicState.height
  provider.viewBlock = async () => {
    calls.viewBlock++;
    if (typeof dynamicState.onViewBlock === 'function') {
      return dynamicState.onViewBlock();
    }
    return { header: { height: dynamicState.height } };
  };

  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => {
      calls.submit++;
      return { transaction: { hash: 'TX_HASH_OK' }, receipts_outcome: [] };
    },
  };

  const limiter = createRateLimiter({
    capacity: 1000,
    refillPerSecond: 100,
    now: () => dynamicState.now,
  });
  const globalLimiter = createRateLimiter({
    capacity: 5000,
    refillPerSecond: 500,
    now: () => dynamicState.now,
  });
  const keyVerifier = createKeyVerifier({
    provider,
    policy,
    now: () => dynamicState.now,
  });

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter,
    globalLimiter,
    keyVerifier,
    relayerBalance: async () => BigInt(10e24),
    now: () => dynamicState.now,
    queue: createSerialQueue(64),
  });

  const ipLimiter = createRateLimiter({
    capacity: 20,
    refillPerSecond: 1,
    now: () => dynamicState.now,
  });

  const server = createServer({
    relayer,
    ipLimiter,
    trustProxy: true,
    maxInFlight: 32,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  serverState = {
    server,
    baseUrl,
    calls,
    state: dynamicState,
    policy,
    relayer,
    ipLimiter,
  };

  return serverState;
}

/**
 * Shuts down the facilitator server if running.
 */
export async function stopFacilitatorServer() {
  if (!serverState) return;
  const { server } = serverState;
  serverState = null;
  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  } catch {}
}

// Clean shutdown on process exit
process.on('exit', () => {
  if (serverState?.server) {
    try {
      serverState.server.closeAllConnections?.();
      serverState.server.close?.();
    } catch {}
  }
});

/**
 * Sends a raw HTTP request to the target server.
 *
 * @param {string} urlStr
 * @param {object} options
 * @returns {Promise<{status: number, headers: object, text: string, json: any}>}
 */
export function sendHttpRequest(urlStr, { method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Sends a raw HTTP/1.1 request over a TCP socket, bypassing Node's client-side
 * method-casing normalisation and WHATWG URL path resolution. Needed for cases
 * that must transmit a non-canonical verb or a non-normalised path verbatim.
 *
 * @param {string} urlStr - Base URL (scheme/host/port only; path is taken from options.path)
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {string|Buffer|null} [options.body]
 * @param {string} [options.path] - Exact request-target written to the socket
 * @returns {Promise<{status: number, headers: object, text: string, json: any}>}
 */
export function sendRawHttpRequest(urlStr, { method = 'POST', headers = {}, body = null, path: rawPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const requestPath = rawPath ?? (u.pathname + u.search);
    const socket = net.connect(Number(u.port) || 80, u.hostname, () => {
      const lines = [`${method} ${requestPath} HTTP/1.1`, `host: ${u.host}`, 'connection: close'];
      for (const [k, v] of Object.entries(headers)) {
        const name = k.toLowerCase();
        if (name === 'host' || name === 'connection') continue;
        lines.push(`${k}: ${v}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (body !== null && body !== undefined) socket.write(body);
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep === -1 ? raw.toString('utf8') : raw.subarray(0, sep).toString('utf8');
      const text = sep === -1 ? '' : raw.subarray(sep + 4).toString('utf8');
      const headLines = head.split('\r\n');
      const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headLines[0] ?? '');
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const resHeaders = {};
      for (const line of headLines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) resHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      resolve({ status, headers: resHeaders, text, json });
    });
  });
}

/**
 * Executes an attack case against the real running Facilitator HTTP server (Layer B).
 *
 * @param {object} c - Case definition
 * @returns {Promise<{label: string, code?: string, note?: string, txHash?: string}>}
 */
export async function executeLayerB(c) {
  if (c.params?.outOfScope || c.expected?.label === 'OUT_OF_SCOPE') {
    return {
      label: 'OUT_OF_SCOPE',
      code: c.expected?.code || 'OUT_OF_SCOPE',
      note: c.params?.reason || 'Threat model boundary: scenario outside Scrip protocol guarantees',
    };
  }

  const { baseUrl, calls, state } = await startFacilitatorServer();

  // Isolation: the relayer caches the final block height for HEIGHT_TTL_MS (1 s). Advance the mock clock past it
  // so a case never inherits the height (or hides an injected viewBlock failure) from the previous case.
  state.now += 5000;

  // Reset or configure dynamic RPC mock state
  state.height = typeof c.params?.height === 'number' ? c.params.height : 1000;
  state.keyNonce = typeof c.params?.keyNonce === 'bigint' ? c.params.keyNonce : 0n;
  state.keyPermission = c.params?.keyPermission ?? goodPermission();
  state.onKey = typeof c.params?.onKey === 'function' ? c.params.onKey : null;
  state.onCallFunction = typeof c.params?.onCallFunction === 'function' ? c.params.onCallFunction : null;
  state.onViewBlock = typeof c.params?.onViewBlock === 'function' ? c.params.onViewBlock : null;

  const method = c.params?.method || 'POST';
  const path = c.params?.path || '/relay';
  const headers = { ...(c.params?.headers || {}) };
  // Cases that assert on the verb casing or on the unnormalised request-target must bypass
  // node:http's client-side normalisation (method upper-casing, WHATWG URL path resolution).
  const useRaw = c.params?.rawRequest === true;
  const send = useRaw
    ? (url, opts) => sendRawHttpRequest(url, { ...opts, path })
    : sendHttpRequest;

  // Ensure deterministic IP per test unless testing IP flood
  if (c.params?.clientIp) {
    headers['x-forwarded-for'] = c.params.clientIp;
  } else if (!headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = `10.5.0.${c.id.replace(/[^0-9]/g, '').slice(-3) || '1'}`;
  }

  let body = null;
  if (c.params?.body !== undefined) {
    body = c.params.body;
    if (typeof body === 'object' && body !== null && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
    }
  } else if (c.params?.delegate) {
    const dOpts = { ...c.params.delegate };
    // Handle action array if helper options specified
    if (dOpts.actionType === 'transfer') {
      dOpts.actions = [actions.transfer(dOpts.transferAmount ?? 100n)];
    } else if (dOpts.actionType === 'empty') {
      dOpts.actions = [];
    } else if (dOpts.actionType === 'multiple') {
      dOpts.actions = [
        actions.functionCall('request_payment', { mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 1 }, 60_000_000_000_000n, 0n),
        actions.functionCall('request_payment', { mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 2 }, 60_000_000_000_000n, 0n),
      ];
    } else if (dOpts.rawActionMethod) {
      dOpts.actions = [
        actions.functionCall(dOpts.rawActionMethod, dOpts.rawActionArgs ?? {}, dOpts.gas ?? 60_000_000_000_000n, dOpts.deposit ?? 0n),
      ];
    }
    const signed = await makeSigned(dOpts);
    body = JSON.stringify({ signed_delegate: signed.b64 });
  } else if (method === 'POST' && path === '/relay') {
    body = '{}';
  }

  // Set default content headers unless omitted
  if (body !== null && headers['content-length'] === undefined && !c.params?.omitContentLength && !headers['transfer-encoding']) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  if (body !== null && !headers['content-type'] && !c.params?.omitContentType) {
    headers['content-type'] = 'application/json';
  }

  // Build a syntactically valid x402 PAYMENT-SIGNATURE so /verify reaches the on-chain
  // mandate lookup instead of failing early on a missing header.
  if (c.params?.paymentSignature === true) {
    const requirements = {
      scheme: 'scrip',
      network: 'near:testnet',
      payTo: 'bob.testnet',
      amount: '1',
      asset: 'usdc.testnet',
      mandate: 1,
      maxTimeoutSeconds: 300,
    };
    const signed = await makeSigned({ nonce: 7n });
    headers['payment-signature'] = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: 'scrip',
      network: 'near:testnet',
      payload: { signedDelegateAction: signed.b64 },
      paymentRequirements: requirements,
    })).toString('base64');
  }

  // Handle burst/flood requests if requested (e.g. for IP rate limit testing)
  if (typeof c.params?.floodCount === 'number' && c.params.floodCount > 1) {
    for (let i = 0; i < c.params.floodCount - 1; i++) {
      await send(`${baseUrl}${path}`, { method, headers, body }).catch(() => {});
    }
  }

  if (typeof c.params?.concurrentFlood === 'number' && c.params.concurrentFlood > 1) {
    const burst = [];
    for (let i = 0; i < c.params.concurrentFlood - 1; i++) {
      burst.push(send(`${baseUrl}${path}`, { method, headers, body }).catch(() => {}));
    }
    await Promise.all(burst);
  }

  const submitBefore = calls.submit;
  let res;
  try {
    res = await send(`${baseUrl}${path}`, { method, headers, body });
  } catch (err) {
    if (serverState?.server?.listening) {
      return {
        label: 'BLOCKED',
        code: 'CONNECTION_DROPPED',
        note: `HTTP transport connection rejected or dropped cleanly: ${err.message}`,
      };
    }
    return {
      label: 'BREACH',
      code: 'SERVER_CRASH',
      note: `Facilitator connection dropped / crashed: ${err.message}`,
    };
  }

  const submitted = calls.submit > submitBefore;
  const status = res.status;
  const json = res.json;
  const bodyText = res.text;

  // 1. 4xx with known error code -> BLOCKED(code)
  if (status >= 400 && status < 500) {
    let code = json?.code || json?.invalidReason;
    if (!code) {
      if (status === 431) code = 'REQUEST_HEADER_FIELDS_TOO_LARGE';
      else if (status === 404) code = 'NOT_FOUND';
      else if (status === 405) code = 'METHOD_NOT_ALLOWED';
      else if (status === 413) code = 'BODY_TOO_LARGE';
      else if (status === 415) code = 'UNSUPPORTED_MEDIA_TYPE';
      else code = `HTTP_${status}`;
    }
    return {
      label: 'BLOCKED',
      code: String(code),
      note: `HTTP ${status}: ${code} - ${bodyText.slice(0, 100)}`,
    };
  }

  // 2. 2xx responses
  if (status >= 200 && status < 300) {
    if (submitted) {
      if (c.expected?.label === 'BLOCKED') {
        return {
          label: 'BREACH',
          code: 'UNAUTHORIZED_TX_RELAYED',
          note: `Transaction was relayed to relayer for request that should be BLOCKED: ${bodyText.slice(0, 100)}`,
          txHash: json?.tx_hash,
        };
      }
      return {
        label: 'INERT',
        note: `HTTP ${status}, tx relayed: ${json?.tx_hash || 'none'}`,
        txHash: json?.tx_hash,
      };
    }
    // 2xx without effect -> INERT
    return {
      label: 'INERT',
      note: `HTTP ${status}, no transaction relayed: ${bodyText.slice(0, 100)}`,
    };
  }

  // 3. 5xx responses
  if (status >= 500) {
    const code = json?.code;
    const knownBlockedCodes = ['SERVER_BUSY', 'UPSTREAM_ERROR', 'RELAY_FAILED', 'TX_FAILED', 'RELAY_PENDING'];
    if (knownBlockedCodes.includes(code)) {
      return {
        label: 'BLOCKED',
        code,
        note: `HTTP ${status} ${code}: ${bodyText.slice(0, 100)}`,
      };
    }
    return {
      label: 'BREACH',
      code: code || `HTTP_${status}`,
      note: `Server returned 5xx unhandled error (${status}): ${bodyText.slice(0, 100)}`,
    };
  }

  return {
    label: 'BLOCKED',
    code: `HTTP_${status}`,
    note: `HTTP ${status}: ${bodyText.slice(0, 100)}`,
  };
}
