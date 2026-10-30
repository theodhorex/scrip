// node:http server. POST /relay, GET /health, GET /status/:hash, GET /metrics.
// No stack traces or request bodies in responses/logs.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRateLimiter } from './ratelimit.mjs';
import { parsePaymentSignatureHeader, matchPaymentRequirements, validateSignedDelegate } from './validate.mjs';

export const MAX_BODY_BYTES = 16 * 1024;

export const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

const metrics = new Map();
export function recordMetric(code) {
  metrics.set(code, (metrics.get(code) ?? 0) + 1);
}
export function getMetrics() {
  return Object.fromEntries(metrics);
}
export function resetMetrics() {
  metrics.clear();
}

const STATUS = { RATE_LIMITED: 429, BUSY: 429, UPSTREAM_ERROR: 502, RELAY_FAILED: 502, TX_FAILED: 502, RELAY_PENDING: 504, DUPLICATE_DELEGATE: 409, MANDATE_NOT_FOUND: 400, ASSET_MISMATCH: 400 };

const DEFAULT_IP_LIMIT = { capacity: 20, refillPerSecond: 1 };

export function createServer({ relayer, log = () => {}, ipLimiter = createRateLimiter(DEFAULT_IP_LIMIT), maxInFlight = 8, trustProxy = false }) {
  let inFlight = 0;
  // Client IP: the socket address. X-Forwarded-For (last hop = what our own proxy saw) only if trustProxy is true.
  const clientIp = (req) => {
    if (trustProxy === true) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('too large'), { tooLarge: true }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleRelay(req, res, send, reqId) {
    const ip = ipLimiter.tryTake(clientIp(req));
    if (!ip.allowed) {
      const secs = Math.max(1, Math.ceil(ip.retryAfterMs / 1000));
      return send(res, 429, { ok: false, code: 'IP_RATE_LIMITED' }, { 'retry-after': String(secs), connection: 'close' });
    }
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return send(res, 413, { ok: false, code: 'BODY_TOO_LARGE' }, { connection: 'close' });
    let text;
    try {
      text = await readBody(req);
    } catch (e) {
      return send(res, e.tooLarge ? 413 : 400, { ok: false, code: e.tooLarge ? 'BODY_TOO_LARGE' : 'BAD_REQUEST' }, { connection: 'close' });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { ok: false, code: 'BAD_JSON' });
    }
    if (!body || typeof body !== 'object' || typeof body.signed_delegate !== 'string') {
      return send(res, 400, { ok: false, code: 'BAD_REQUEST' });
    }
    if (inFlight >= maxInFlight) return send(res, 503, { ok: false, code: 'SERVER_BUSY' }, { 'retry-after': '1' });
    inFlight++;
    let r;
    try {
      r = await relayer.relay(body.signed_delegate);
    } finally {
      inFlight--;
    }
    log({
      t: new Date().toISOString(),
      request_id: reqId,
      path: '/relay',
      code: r.ok ? 'OK' : r.code,
      agent: r.agentId,
      tx: r.txHash,
    });
    if (r.ok) {
      return send(res, 200, {
        ok: true,
        tx_hash: r.txHash,
        outer_tx_succeeded: r.outerSuccess === true,
        inner_status: r.inner_status,
        ...(r.inner_code ? { inner_code: r.inner_code } : {}),
        note: r.note,
      });
    }
    if (r.code === 'RATE_LIMITED' || r.code === 'BUSY') {
      const secs = Math.max(1, Math.ceil((r.retryAfterMs ?? 1000) / 1000));
      return send(res, 429, { ok: false, code: r.code }, { 'retry-after': String(secs) });
    }
    return send(res, STATUS[r.code] ?? 400, { ok: false, code: r.code, ...(r.txHash ? { tx_hash: r.txHash } : {}) });
  }

  async function handleVerify(req, res, send, reqId) {
    const ip = ipLimiter.tryTake(clientIp(req));
    if (!ip.allowed) {
      const secs = Math.max(1, Math.ceil(ip.retryAfterMs / 1000));
      return send(res, 429, { ok: false, isValid: false, code: 'IP_RATE_LIMITED' }, { 'retry-after': String(secs), connection: 'close' });
    }
    const hdr = req.headers['payment-signature'];
    let bodyReqs;
    const cl = Number(req.headers['content-length'] ?? 0);
    const ct = String(req.headers['content-type'] ?? '');
    if (cl > MAX_BODY_BYTES) return send(res, 413, { ok: false, isValid: false, code: 'BODY_TOO_LARGE' }, { connection: 'close' });
    if (cl > 0 || (ct && ct.includes('application/json'))) {
      try {
        const text = await readBody(req);
        if (text.trim().length > 0) {
          const parsedBody = JSON.parse(text);
          bodyReqs = parsedBody?.paymentRequirements ?? parsedBody?.requirements ?? parsedBody;
        }
      } catch (e) {
        return send(res, e.tooLarge ? 413 : 400, { ok: false, isValid: false, code: e.tooLarge ? 'BODY_TOO_LARGE' : 'BAD_JSON' }, { connection: 'close' });
      }
    }

    const parsedHdr = parsePaymentSignatureHeader(hdr, bodyReqs);
    if (!parsedHdr.ok) {
      return send(res, 400, { ok: false, isValid: false, code: parsedHdr.code, invalidReason: parsedHdr.code });
    }
    const { signedDelegateBase64, requirements } = parsedHdr;
    // 1) Pure offline validation of delegate bytes
    const v = validateSignedDelegate(signedDelegateBase64, relayer.policy);
    if (!v.ok) {
      return send(res, 400, { ok: false, isValid: false, code: v.code, invalidReason: v.code });
    }
    // 2) Match payment requirements against call arguments
    const match = matchPaymentRequirements(v.call, requirements, relayer.policy);
    if (!match.ok) {
      return send(res, 400, { ok: false, isValid: false, code: match.code, invalidReason: match.code });
    }
    // 3) N3-I1: Match asset against on-chain mandate token (fail-closed)
    if (requirements.asset && typeof relayer.checkMandateAsset === 'function') {
      const ma = await relayer.checkMandateAsset(v.call.mandateId, requirements.asset);
      if (!ma.ok) {
        log({
          t: new Date().toISOString(),
          request_id: reqId,
          path: '/verify',
          code: ma.code,
          agent: v.agentId,
        });
        const st = STATUS[ma.code] ?? 400;
        return send(res, st, { ok: false, isValid: false, code: ma.code, invalidReason: ma.code });
      }
    }
    // 4) Run relayer.verify (checks expiry, access key, nonce, min relayer balance) without broadcasting
    const vr = await relayer.verify(signedDelegateBase64, { maxTimeoutSeconds: requirements.maxTimeoutSeconds });
    log({
      t: new Date().toISOString(),
      request_id: reqId,
      path: '/verify',
      code: vr.ok ? 'OK' : vr.code,
      agent: v.agentId,
    });
    if (!vr.ok) {
      const status = STATUS[vr.code] ?? 400;
      return send(res, status, { ok: false, isValid: false, code: vr.code, invalidReason: vr.code });
    }
    return send(res, 200, {
      ok: true,
      isValid: true,
      payer: v.agentId,
      network: 'near:testnet',
      scheme: 'amanat',
      call: {
        mandate_id: String(v.call.mandateId),
        recipient: v.call.recipient,
        amount: v.call.amount,
        nonce: String(v.call.nonce),
      },
    });
  }

  async function handleSettle(req, res, send, reqId) {
    const ip = ipLimiter.tryTake(clientIp(req));
    if (!ip.allowed) {
      const secs = Math.max(1, Math.ceil(ip.retryAfterMs / 1000));
      return send(res, 429, { ok: false, code: 'IP_RATE_LIMITED' }, { 'retry-after': String(secs), connection: 'close' });
    }
    const hdr = req.headers['payment-signature'];
    let bodyReqs;
    const cl = Number(req.headers['content-length'] ?? 0);
    const ct = String(req.headers['content-type'] ?? '');
    if (cl > MAX_BODY_BYTES) return send(res, 413, { ok: false, code: 'BODY_TOO_LARGE' }, { connection: 'close' });
    if (cl > 0 || (ct && ct.includes('application/json'))) {
      try {
        const text = await readBody(req);
        if (text.trim().length > 0) {
          const parsedBody = JSON.parse(text);
          bodyReqs = parsedBody?.paymentRequirements ?? parsedBody?.requirements ?? parsedBody;
        }
      } catch (e) {
        return send(res, e.tooLarge ? 413 : 400, { ok: false, code: e.tooLarge ? 'BODY_TOO_LARGE' : 'BAD_JSON' }, { connection: 'close' });
      }
    }

    const parsedHdr = parsePaymentSignatureHeader(hdr, bodyReqs);
    if (!parsedHdr.ok) {
      return send(res, 400, { ok: false, code: parsedHdr.code, invalidReason: parsedHdr.code });
    }
    const { signedDelegateBase64, requirements } = parsedHdr;
    // 1) Offline validation
    const v = validateSignedDelegate(signedDelegateBase64, relayer.policy);
    if (!v.ok) {
      return send(res, 400, { ok: false, code: v.code, invalidReason: v.code });
    }
    // 2) Match payment requirements
    const match = matchPaymentRequirements(v.call, requirements, relayer.policy);
    if (!match.ok) {
      return send(res, 400, { ok: false, code: match.code, invalidReason: match.code });
    }
    // 3) N3-I1: Match asset against on-chain mandate token (fail-closed)
    if (requirements.asset && typeof relayer.checkMandateAsset === 'function') {
      const ma = await relayer.checkMandateAsset(v.call.mandateId, requirements.asset);
      if (!ma.ok) {
        log({
          t: new Date().toISOString(),
          request_id: reqId,
          path: '/settle',
          code: ma.code,
          agent: v.agentId,
        });
        const st = STATUS[ma.code] ?? 400;
        return send(res, st, { ok: false, code: ma.code, invalidReason: ma.code });
      }
    }

    if (inFlight >= maxInFlight) return send(res, 503, { ok: false, code: 'SERVER_BUSY' }, { 'retry-after': '1' });
    inFlight++;
    let r;
    try {
      r = await relayer.relay(signedDelegateBase64, { maxTimeoutSeconds: requirements.maxTimeoutSeconds });
    } finally {
      inFlight--;
    }

    log({
      t: new Date().toISOString(),
      request_id: reqId,
      path: '/settle',
      code: r.ok ? 'OK' : r.code,
      agent: v.agentId,
      tx: r.txHash,
    });

    if (r.ok) {
      const isSettled = r.inner_status === 'Settled' || r.inner_status === 'Reserved';
      const respObj = {
        ok: true,
        success: isSettled,
        tx_hash: r.txHash,
        outer_tx_succeeded: r.outerSuccess === true,
        inner_status: r.inner_status,
        ...(r.inner_code ? { inner_code: r.inner_code } : {}),
        note: r.note,
      };
      const payHdr = Buffer.from(JSON.stringify(respObj), 'utf8').toString('base64');
      return send(res, 200, respObj, { 'payment-response': payHdr });
    }
    if (r.code === 'RATE_LIMITED' || r.code === 'BUSY') {
      const secs = Math.max(1, Math.ceil((r.retryAfterMs ?? 1000) / 1000));
      return send(res, 429, { ok: false, code: r.code }, { 'retry-after': String(secs) });
    }
    return send(res, STATUS[r.code] ?? 400, { ok: false, code: r.code, ...(r.txHash ? { tx_hash: r.txHash } : {}) });
  }

  const server = http.createServer(async (req, res) => {
    const reqId = String(req.headers['x-request-id'] ?? '').trim() || randomUUID();
    const send = (res, status, obj, headers = {}) => {
      const code = obj?.code ?? (status === 200 ? 'OK' : 'UNKNOWN');
      recordMetric(code);
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-request-id': reqId,
        ...SECURITY_HEADERS,
        ...headers,
      });
      res.end(body);
    };

    try {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/health') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
        return send(res, 200, { ok: true });
      }
      if (path === '/supported') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
        const pol = relayer?.policy;
        const extra = pol
          ? { contractId: pol.contractId, allowedMethods: [...pol.allowedMethods] }
          : {};
        return send(res, 200, {
          ok: true,
          kinds: [{ x402Version: 2, scheme: 'amanat', network: 'near:testnet', extra }],
        });
      }
      if (path === '/metrics') {
        if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
        recordMetric('METRICS');
        const counts = Object.fromEntries(metrics);
        if (req.headers['accept']?.includes('application/json')) {
          return send(res, 200, { ok: true, metrics: counts });
        }
        let txt = '# HELP facilitator_requests_total Total requests by code\n# TYPE facilitator_requests_total counter\n';
        for (const [code, count] of metrics) {
          txt += `facilitator_requests_total{code="${code}"} ${count}\n`;
        }
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4',
          'x-request-id': reqId,
          ...SECURITY_HEADERS,
        });
        return res.end(txt);
      }
      if (path.startsWith('/status/')) {
        if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
        const ip = ipLimiter.tryTake(clientIp(req));
        if (!ip.allowed) {
          const secs = Math.max(1, Math.ceil(ip.retryAfterMs / 1000));
          return send(res, 429, { ok: false, code: 'IP_RATE_LIMITED' }, { 'retry-after': String(secs), connection: 'close' });
        }
        const txHash = path.slice('/status/'.length);
        if (!txHash) return send(res, 400, { ok: false, code: 'BAD_REQUEST' });
        const result = await relayer.getTxStatus(txHash);
        const status = result.ok ? 200 : (result.code === 'TX_NOT_FOUND' ? 404 : (result.code === 'INVALID_TX_HASH' ? 400 : 502));
        return send(res, status, result);
      }
      if (path === '/verify') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
        return await handleVerify(req, res, send, reqId);
      }
      if (path === '/settle') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
        return await handleSettle(req, res, send, reqId);
      }
      if (path === '/relay') {
        if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
        return await handleRelay(req, res, send, reqId);
      }
      return send(res, 404, { ok: false, code: 'NOT_FOUND' });
    } catch {
      if (!res.headersSent) {
        send(res, 500, { ok: false, code: 'INTERNAL' });
      } else {
        res.end();
      }
    }
  });

  server.on('close', () => {
    try { relayer?.store?.close?.(); } catch {}
  });

  return server;
}
