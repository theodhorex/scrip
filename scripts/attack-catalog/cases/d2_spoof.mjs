// D2: Header-spoof cases with GENUINE (valid) delegates.
// Goal: prove spoofed identity headers (x-forwarded-for, x-real-ip, forwarded,
// host, origin) do not change the facilitator's decision, and cannot bypass the
// per-IP rate limit. Every case uses a correctly signed delegate (same pattern as
// the already-passing Layer B cases); no fake payload bodies.
// Expectations were designed and documented in CORRECTIONS_D2.md *before* this
// file was first executed (see the D2 report).

export function generateD2SpoofCases() {
  const cases = [];

  // --- Controls (the "same result without spoofed headers" baselines) ---
  cases.push({
    id: 'KAT-B-05-210',
    category: 5,
    layer: 'B',
    title: 'Control: valid delegate, no spoofed headers (allowed flow)',
    params: {
      method: 'POST',
      path: '/relay',
      delegate: { nonce: 210n },
    },
    expected: { label: 'INERT' },
  });
  cases.push({
    id: 'KAT-B-05-211',
    category: 5,
    layer: 'B',
    title: 'Control: valid delegate with expired maxBlockHeight, no spoofed headers (blocked flow)',
    params: {
      method: 'POST',
      path: '/relay',
      delegate: { nonce: 211n, maxBlockHeight: 2400n },
    },
    expected: { label: 'BLOCKED', code: 'EXPIRES_TOO_FAR' },
  });

  // --- Single-request spoof probes: decision unchanged vs the matching control ---
  const spoofVariations = [
    { num: 212, headers: { 'x-forwarded-for': '9.20.30.42' }, expired: false },
    { num: 213, headers: { 'x-real-ip': '4.4.4.4' }, expired: false },
    { num: 214, headers: { forwarded: 'for=4.4.4.4;proto=https' }, expired: false },
    { num: 215, headers: { host: 'evil.example.net' }, expired: false },
    { num: 216, headers: { origin: 'https://evil.example.net' }, expired: false },
    { num: 217, headers: { 'x-forwarded-for': '9.20.30.47' }, expired: true },
    { num: 218, headers: { 'x-real-ip': '4.4.4.7' }, expired: true },
    { num: 219, headers: { forwarded: 'for=4.4.4.7;proto=https' }, expired: true },
    { num: 220, headers: { host: 'evil.example.net' }, expired: true },
    { num: 221, headers: { origin: 'https://evil.example.net' }, expired: true },
  ];

  spoofVariations.forEach((item) => {
    const hdr = Object.keys(item.headers)[0];
    cases.push({
      id: `KAT-B-05-${item.num}`,
      category: 5,
      layer: 'B',
      title: `Spoofed '${hdr}' must not change the ${item.expired ? 'blocked' : 'allowed'} flow outcome for a valid delegate`,
      params: {
        method: 'POST',
        path: '/relay',
        headers: item.headers,
        delegate: item.expired
          ? { nonce: item.num, maxBlockHeight: 2400n }
          : { nonce: item.num },
      },
      expected: item.expired
        ? { label: 'BLOCKED', code: 'EXPIRES_TOO_FAR' }
        : { label: 'INERT' },
    });
  });

  // --- Per-IP rate limit probes: spoofed headers cannot bypass the IP limiter ---
  cases.push({
    id: 'KAT-B-05-222',
    category: 5,
    layer: 'B',
    title: 'Flood 25 valid delegates with constant spoofed x-forwarded-for, final request must stay IP_RATE_LIMITED',
    params: {
      method: 'POST',
      path: '/relay',
      headers: { 'x-forwarded-for': '10.20.30.42' },
      delegate: { nonce: 222n },
      floodCount: 25,
    },
    expected: { label: 'BLOCKED', code: 'IP_RATE_LIMITED' },
  });
  cases.push({
    id: 'KAT-B-05-223',
    category: 5,
    layer: 'B',
    title: 'Flood 25 valid delegates with constant spoofed x-forwarded-for plus ignored headers claiming a fresh IP (x-real-ip, forwarded, origin)',
    params: {
      method: 'POST',
      path: '/relay',
      headers: {
        'x-forwarded-for': '10.20.30.43',
        'x-real-ip': '4.3.3.4',
        forwarded: 'for=4.3.3.4;proto=https',
        origin: 'https://evil.example.net',
      },
      delegate: { nonce: 223n },
      floodCount: 25,
    },
    expected: { label: 'BLOCKED', code: 'IP_RATE_LIMITED' },
  });
  cases.push({
    id: 'KAT-B-05-224',
    category: 5,
    layer: 'B',
    title: 'Flood 25 valid delegates with constant spoofed x-forwarded-for plus spoofed host and origin',
    params: {
      method: 'POST',
      path: '/relay',
      headers: {
        'x-forwarded-for': '10.20.30.44',
        host: 'evil.example.net',
        origin: 'https://evil.example.net',
      },
      delegate: { nonce: 224n },
      floodCount: 25,
    },
    expected: { label: 'BLOCKED', code: 'IP_RATE_LIMITED' },
  });
  cases.push({
    id: 'KAT-B-05-225',
    category: 5,
    layer: 'B',
    title: 'Flood 25 genuine x402 payloads on /verify with constant spoofed x-forwarded-for, final request must stay IP_RATE_LIMITED',
    params: {
      method: 'POST',
      path: '/verify',
      headers: { 'x-forwarded-for': '10.20.30.45' },
      paymentSignature: true,
      floodCount: 25,
    },
    expected: { label: 'BLOCKED', code: 'IP_RATE_LIMITED' },
  });

  return cases;
}
