// Layer E (Testnet) Generator: Step 1 - Payment and Budget (Categories 2 and 3)
// Conforms strictly to contracts/scrip/README.md error codes and PRD 3.3/3.6:
// - Category 2: Amounts, per_payment_cap boundaries, overflow checks (~75 cases)
// - Category 3: Budget depletion, small floods, split payments, MAX_OPEN overflow (~75 cases)
// Total cases: 150

export const SEED_CAT2 = 0x20261030_02;
export const SEED_CAT3 = 0x20261030_03;

/**
 * Deterministic pseudo-random number generator (Mulberry32)
 * Ensures reproducible parametric test generation across all runs.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_MANDATE_ID = 1;
const DEFAULT_CAP = 500_000n; // 0.50 USDC (6 decimals)
const DEFAULT_BUDGET = 1_250_000n; // 1.25 USDC
const MAX_OPEN = 32;

/**
 * Generates Category 2 cases: payment amounts and per-payment cap boundaries.
 * Total: 75 cases.
 */
export function generateCategory2Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, amount, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-02-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 2,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: 'request_payment',
        args: {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
          amount: String(amount),
          nonce: index,
        },
        ...extraParams,
      },
      expected: {
        label: expectedLabel,
        code: expectedCode,
      },
    });
    index++;
  };

  // 1. Zero amount (contract README: "OVER_PER_PAYMENT_CAP (also amount 0)")
  pushCase({
    title: 'Payment amount zero (0)',
    amount: '0',
    expectedLabel: 'BLOCKED',
    expectedCode: 'OVER_PER_PAYMENT_CAP',
    note: 'Contract rejects amount 0 with OVER_PER_PAYMENT_CAP',
  });

  // 2. Exact minimum positive amount
  pushCase({
    title: 'Payment amount 1 smallest unit',
    amount: '1',
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Minimal valid amount',
  });

  // 3-12. Standard typical valid amounts below cap
  const typicalAmounts = [
    2n, 10n, 100n, 1000n, 5000n, 10000n, 50000n, 100000n, 250000n, 400000n,
  ];
  for (const amt of typicalAmounts) {
    pushCase({
      title: `Valid payment amount ${amt} below cap`,
      amount: amt.toString(),
      expectedLabel: 'INERT',
      expectedCode: null,
      note: 'Normal payment within cap and budget',
    });
  }

  // 13. Exact cap boundary minus 1
  pushCase({
    title: 'Payment amount exactly at cap - 1 (499999)',
    amount: (DEFAULT_CAP - 1n).toString(),
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Boundary: cap - 1 is permitted',
  });

  // 14. Exact cap boundary
  pushCase({
    title: 'Payment amount exactly at cap (500000)',
    amount: DEFAULT_CAP.toString(),
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Boundary: exact cap is permitted',
  });

  // 15-20. Cap boundary violations (cap + 1, cap + 2, cap + 10, cap + 100, cap + 1000)
  const capExceeded = [1n, 2n, 5n, 10n, 100n, 1000n];
  for (const delta of capExceeded) {
    pushCase({
      title: `Payment amount cap + ${delta} (${DEFAULT_CAP + delta})`,
      amount: (DEFAULT_CAP + delta).toString(),
      expectedLabel: 'BLOCKED',
      expectedCode: 'OVER_PER_PAYMENT_CAP',
      note: 'Amount exceeds per_payment_cap',
    });
  }

  // 21-25. Mid-range amounts between cap and budget
  const overCapMid = [600000n, 750000n, 900000n, 1000000n, 1200000n];
  for (const amt of overCapMid) {
    pushCase({
      title: `Payment amount ${amt} between cap and budget`,
      amount: amt.toString(),
      expectedLabel: 'BLOCKED',
      expectedCode: 'OVER_PER_PAYMENT_CAP',
      note: 'Amount > cap, first check failure wins',
    });
  }

  // 26-28. Budget boundaries
  pushCase({
    title: 'Payment amount at budget - 1 (1249999)',
    amount: (DEFAULT_BUDGET - 1n).toString(),
    expectedLabel: 'BLOCKED',
    expectedCode: 'OVER_PER_PAYMENT_CAP',
    note: 'Amount > cap',
  });
  pushCase({
    title: 'Payment amount at exact budget (1250000)',
    amount: DEFAULT_BUDGET.toString(),
    expectedLabel: 'BLOCKED',
    expectedCode: 'OVER_PER_PAYMENT_CAP',
    note: 'Amount > cap',
  });
  pushCase({
    title: 'Payment amount at budget + 1 (1250001)',
    amount: (DEFAULT_BUDGET + 1n).toString(),
    expectedLabel: 'BLOCKED',
    expectedCode: 'OVER_PER_PAYMENT_CAP',
    note: 'Amount > cap and > budget',
  });

  // 29-35. Extreme and overflow amounts
  const extremes = [
    { title: 'Amount 2x budget (2500000)', amt: '2500000' },
    { title: 'Amount 10x budget (12500000)', amt: '12500000' },
    { title: 'Amount 1 billion', amt: '1000000000' },
    { title: 'Amount u64::MAX', amt: '18446744073709551615' },
    { title: 'Amount u64::MAX + 1', amt: '18446744073709551616' },
    { title: 'Amount u128::MAX - 1', amt: '340282366920938463463374607431768211454' },
    { title: 'Amount u128::MAX', amt: '340282366920938463463374607431768211455' },
  ];
  for (const ext of extremes) {
    pushCase({
      title: ext.title,
      amount: ext.amt,
      expectedLabel: 'BLOCKED',
      expectedCode: 'OVER_PER_PAYMENT_CAP',
      note: 'Extreme amount blocked by cap check',
    });
  }

  // 36-75. Property-based seeded random amounts around boundaries (40 cases)
  const rng = mulberry32(SEED_CAT2);
  for (let i = 0; i < 40; i++) {
    const r = rng();
    let amt;
    let expectedLabel;
    let expectedCode;

    if (r < 0.3) {
      // Valid amount between 1 and 500,000
      amt = BigInt(Math.floor(rng() * 499999) + 1);
      expectedLabel = 'INERT';
      expectedCode = null;
    } else if (r < 0.6) {
      // Amount exceeding cap by up to 100,000
      amt = DEFAULT_CAP + BigInt(Math.floor(rng() * 100000) + 1);
      expectedLabel = 'BLOCKED';
      expectedCode = 'OVER_PER_PAYMENT_CAP';
    } else if (r < 0.85) {
      // Amount between cap and budget
      amt = DEFAULT_CAP + 100000n + BigInt(Math.floor(rng() * 600000));
      expectedLabel = 'BLOCKED';
      expectedCode = 'OVER_PER_PAYMENT_CAP';
    } else {
      // Large randomized amounts > budget
      amt = DEFAULT_BUDGET + BigInt(Math.floor(rng() * 10000000) + 1);
      expectedLabel = 'BLOCKED';
      expectedCode = 'OVER_PER_PAYMENT_CAP';
    }

    pushCase({
      title: `Seeded parametric amount variation #${i + 1} (${amt})`,
      amount: amt.toString(),
      expectedLabel,
      expectedCode,
      note: `Seeded PRNG generated boundary test (seed: ${SEED_CAT2})`,
    });
  }

  return cases;
}

/**
 * Generates Category 3 cases: budget exhaustion, small floods, split payments, MAX_OPEN queue.
 * Total: 75 cases.
 */
export function generateCategory3Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, amount, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-03-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 3,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: 'request_payment',
        args: {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
          amount: String(amount),
          nonce: index + 1000,
        },
        ...extraParams,
      },
      expected: {
        label: expectedLabel,
        code: expectedCode,
      },
    });
    index++;
  };

  // 1-15. Small floods (sequential small micro-payments of 1,000 units)
  for (let i = 1; i <= 15; i++) {
    pushCase({
      title: `Micro-flood payment sequence #${i} of 1000 units`,
      amount: '1000',
      expectedLabel: 'INERT',
      expectedCode: null,
      note: `Valid sequential micro-flood request ${i}/15`,
    });
  }

  // 16-25. Split payments (splitting large transfer into 10 chunks of 50,000 units)
  for (let i = 1; i <= 10; i++) {
    pushCase({
      title: `Split payment chunk #${i} of 50000 units`,
      amount: '50000',
      expectedLabel: 'INERT',
      expectedCode: null,
      note: `Split tranche ${i}/10`,
    });
  }

  // 26-30. Budget exhaustion simulation (amounts testing OVER_BUDGET when cap is higher or equal)
  const budgetTests = [
    { title: 'Payment exceeding remaining free budget by 1', amt: '100001', code: 'OVER_BUDGET' },
    { title: 'Payment exceeding remaining free budget by 1000', amt: '101000', code: 'OVER_BUDGET' },
    { title: 'Payment exceeding remaining free budget by 50000', amt: '150000', code: 'OVER_BUDGET' },
    { title: 'Payment on fully exhausted budget (zero remaining)', amt: '50000', code: 'OVER_BUDGET' },
    { title: 'Payment beyond deposited funds', amt: '300000', code: 'OVER_BUDGET' },
  ];
  for (const b of budgetTests) {
    pushCase({
      title: b.title,
      amount: b.amt,
      expectedLabel: 'BLOCKED',
      expectedCode: b.code,
      note: 'Budget depletion check enforced',
      extraParams: { remainingBudget: '100000' },
    });
  }

  // 31-36. MAX_OPEN queue overflow (contract README: "TOO_MANY_OPEN")
  // 32 open requests fill the queue, 33rd onwards must be rejected with TOO_MANY_OPEN
  for (let i = 1; i <= 3; i++) {
    pushCase({
      title: `Queue saturation near MAX_OPEN (${MAX_OPEN - 3 + i}/${MAX_OPEN})`,
      amount: '1000',
      expectedLabel: 'INERT',
      expectedCode: null,
      note: `In-flight pending request filling queue to slot ${MAX_OPEN - 3 + i}`,
      extraParams: { openRequestsCount: MAX_OPEN - 3 + i },
    });
  }
  for (let i = 1; i <= 3; i++) {
    pushCase({
      title: `Queue overflow beyond MAX_OPEN (${MAX_OPEN + i}/${MAX_OPEN})`,
      amount: '1000',
      expectedLabel: 'BLOCKED',
      expectedCode: 'TOO_MANY_OPEN',
      note: `Step 5 check: pending requests >= MAX_OPEN (${MAX_OPEN}) triggers TOO_MANY_OPEN`,
      extraParams: { openRequestsCount: MAX_OPEN + i },
    });
  }

  // 37-45. Concurrency & race variations (simultaneous payment requests with competing nonces)
  for (let i = 1; i <= 9; i++) {
    pushCase({
      title: `Concurrent payment request race condition variation #${i}`,
      amount: String(10000 * i),
      expectedLabel: i <= 5 ? 'INERT' : 'BLOCKED',
      expectedCode: i <= 5 ? null : 'OVER_BUDGET',
      note: `Simulated concurrent execution race ${i}`,
    });
  }

  // 46-75. Property-based seeded random payment streams (30 cases)
  const rng = mulberry32(SEED_CAT3);
  for (let i = 0; i < 30; i++) {
    const r = rng();
    let amt;
    let expectedLabel;
    let expectedCode;

    if (r < 0.5) {
      // Valid stream transaction
      amt = BigInt(Math.floor(rng() * 200000) + 1000);
      expectedLabel = 'INERT';
      expectedCode = null;
    } else if (r < 0.8) {
      // Over budget request
      amt = BigInt(Math.floor(rng() * 300000) + 200000);
      expectedLabel = 'BLOCKED';
      expectedCode = 'OVER_BUDGET';
    } else {
      // Queue congested request
      amt = 5000n;
      expectedLabel = 'BLOCKED';
      expectedCode = 'TOO_MANY_OPEN';
    }

    pushCase({
      title: `Seeded stream flood variation #${i + 1} (${amt} units)`,
      amount: amt.toString(),
      expectedLabel,
      expectedCode,
      note: `Deterministic pseudo-random concurrency stream (seed: ${SEED_CAT3})`,
    });
  }

  return cases;
}

/**
 * Combines Step 1 cases (Category 2 & Category 3).
 * Total: 150 cases.
 */
export function generatePaymentBudgetCases() {
  const cat2 = generateCategory2Cases();
  const cat3 = generateCategory3Cases();
  return [...cat2, ...cat3];
}
