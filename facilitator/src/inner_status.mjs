// Helper to extract inner contract status from transaction receipts outcome and logs.
// Looks for EVENT_JSON (settled, refunded, rejected, reserved) and SCRIP_ERR:<code_name>.

/**
 * Extracts all log lines from a transaction outcome object.
 * @param {object} outcome
 * @returns {string[]}
 */
export function extractLogs(outcome) {
  const logs = [];
  if (Array.isArray(outcome?.transaction_outcome?.outcome?.logs)) {
    logs.push(...outcome.transaction_outcome.outcome.logs);
  }
  const receipts = outcome?.receipts_outcome ?? [];
  for (const r of receipts) {
    if (Array.isArray(r?.outcome?.logs)) {
      logs.push(...r.outcome.logs);
    }
  }
  return logs;
}

/**
 * Reads inner status from logs and receipt statuses.
 * @param {object} outcome
 * @returns {{ inner_status: 'Settled'|'Refunded'|'Rejected'|'Reserved'|'Unknown', inner_code?: string }}
 */
export function extractInnerStatus(outcome) {
  const logs = extractLogs(outcome);

  let settled = false;
  let refunded = false;
  let rejectedCode = null;
  let reserved = false;
  let errCode = null;

  for (const log of logs) {
    if (typeof log !== 'string') continue;
    if (log.startsWith('SCRIP_ERR:')) {
      errCode = log.slice('SCRIP_ERR:'.length).trim();
    }
    if (log.startsWith('EVENT_JSON:')) {
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev?.standard === 'scrip') {
          if (ev.event === 'settled') settled = true;
          else if (ev.event === 'refunded') refunded = true;
          else if (ev.event === 'rejected') {
            rejectedCode = ev.data?.[0]?.code ?? 'REJECTED';
          } else if (ev.event === 'reserved') {
            reserved = true;
          }
        }
      } catch {}
    }
  }

  // Also check PaymentResult in SuccessValue if available
  const receipts = outcome?.receipts_outcome ?? [];
  for (const r of receipts) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (typeof sv === 'string' && sv.length > 0) {
      try {
        const text = Buffer.from(sv, 'base64').toString('utf8');
        const parsed = JSON.parse(text);
        if (parsed?.Settled) settled = true;
        if (parsed?.Refunded) refunded = true;
        if (parsed?.Rejected?.code) rejectedCode = parsed.Rejected.code;
        if (parsed?.Reserved) reserved = true;
      } catch {}
    }
  }

  if (settled) return { inner_status: 'Settled' };
  if (refunded) return { inner_status: 'Refunded' };
  if (rejectedCode) return { inner_status: 'Rejected', inner_code: rejectedCode };
  if (errCode) return { inner_status: 'Rejected', inner_code: errCode };
  if (reserved) return { inner_status: 'Reserved' };
  return { inner_status: 'Unknown' };
}
