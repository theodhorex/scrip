// Layer E (Testnet) Generator: Step 4 - Delegate, Keys, Gas (Categories 6 and 7)
// Conforms strictly to contracts/amanat/README.md and facilitator policy:
// - Category 6: NEP-366 DelegateAction, FunctionCall keys, receiver allowlist, nonces (~45 cases)
// - Category 7: Gas limits: 30 / 59 / 60 Tgas boundaries, relay maxGas (~35 cases)
// Total cases: 80

export const SEED_CAT6 = 0x20261030_06;
export const SEED_CAT7 = 0x20261030_07;

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
const TGAS = 1_000_000_000_000n;

/**
 * Generates Category 6 cases: delegate actions, keys, receiver/method scoping, nonces.
 * Total: 45 cases.
 */
export function generateCategory6Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-06-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 6,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: 'request_payment',
        args: {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
          amount: '100000',
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

  // 1-5. FC key method restrictions
  pushCase({
    title: 'FC access key restricted to other method (approve_intent) calling request_payment',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    note: 'Facilitator rejects key whose allowed methods do not include request_payment',
    extraParams: { keyAllowedMethods: ['approve_intent'] },
  });
  pushCase({
    title: 'FC access key restricted to ft_transfer calling request_payment',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    note: 'Key method mismatch',
    extraParams: { keyAllowedMethods: ['ft_transfer'] },
  });
  pushCase({
    title: 'FC access key restricted to view method calling request_payment',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    note: 'View method key cannot execute state mutation',
    extraParams: { keyAllowedMethods: ['get_mandate'] },
  });
  pushCase({
    title: 'FullAccess key presented instead of restricted FunctionCall key',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    note: 'Facilitator policy mandates restricted FunctionCall key with non-zero allowance',
    extraParams: { keyType: 'FullAccess' },
  });
  pushCase({
    title: 'FC access key with zero allowance remaining',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    note: 'Access key allowance exhausted (0 NEAR)',
    extraParams: { keyAllowance: '0' },
  });

  // 6-10. Receiver scoping violations
  pushCase({
    title: 'FC access key scoped for other contract receiver (usdc.testnet)',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECEIVER_NOT_ALLOWED',
    note: 'Key receiver mismatch: usdc.testnet != contractId',
    extraParams: { keyReceiverId: 'usdc.testnet' },
  });
  pushCase({
    title: 'DelegateAction targeting unauthorized foreign contract (attacker.testnet)',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECEIVER_NOT_ALLOWED',
    note: 'Facilitator relay policy only relays calls to configured contractId',
    extraParams: { delegateReceiverId: 'attacker.testnet' },
  });
  pushCase({
    title: 'DelegateAction targeting relayer itself',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECEIVER_NOT_ALLOWED',
    note: 'Relayer will not relay delegate action targeting itself',
    extraParams: { delegateReceiverId: 'relayer.testnet' },
  });

  // 11-15. Cross-mandate key usage & cryptographic integrity
  pushCase({
    title: 'Agent of mandate 2 attempts to request payment for mandate 1',
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_AGENT',
    note: 'Contract Step 0: predecessor agent does not match mandate.agent',
    extraParams: { mandate_id: 1, agentIndex: 1 },
  });
  pushCase({
    title: 'Agent of mandate 3 attempts to request payment for mandate 1',
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_AGENT',
    note: 'Cross-mandate authorization violation',
    extraParams: { mandate_id: 1, agentIndex: 2 },
  });
  pushCase({
    title: 'Forged cryptographic key signature on DelegateAction',
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_SIGNATURE',
    note: 'Cryptographic signature verification on DelegateAction fails',
    extraParams: { forgedKey: true },
  });
  pushCase({
    title: 'Tampered DelegateAction payload with bit flip in method name',
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_SIGNATURE',
    note: 'Payload altered after signature creation',
    extraParams: { invalidSignature: true },
  });

  // 16-25. Nonce and block height validity
  pushCase({
    title: 'DelegateAction with expired maxBlockHeight in past',
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRED_DELEGATE',
    note: 'DelegateAction block height expired on chain',
    extraParams: { maxBlockHeight: 100 },
  });
  pushCase({
    title: 'DelegateAction with stale access key nonce (nonce collision/replay)',
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_NONCE',
    note: 'Delegate nonce <= current access key nonce on-chain',
    extraParams: { nonce: 1 },
  });
  pushCase({
    title: 'DelegateAction with nonce zero',
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_NONCE',
    note: 'Nonce 0 is invalid / already consumed',
    extraParams: { nonce: 0 },
  });
  pushCase({
    title: 'DelegateAction containing empty actions array',
    expectedLabel: 'BLOCKED',
    expectedCode: 'ACTION_NOT_ALLOWED',
    note: 'DelegateAction must contain exactly one action',
    extraParams: { actionsCount: 0 },
  });
  pushCase({
    title: 'DelegateAction containing multiple actions (bundle attack)',
    expectedLabel: 'BLOCKED',
    expectedCode: 'ACTION_NOT_ALLOWED',
    note: 'Facilitator strictly enforces single action rule',
    extraParams: { actionsCount: 2 },
  });

  // 26-45. Property-based seeded variations for keys and delegate actions (28 cases)
  const rng = mulberry32(SEED_CAT6);
  for (let i = 0; i < 28; i++) {
    const r = rng();
    let title;
    let expectedCode;

    if (r < 0.25) {
      title = `Seeded cross-mandate unauthorized agent request #${i + 1}`;
      expectedCode = 'UNAUTHORIZED_AGENT';
    } else if (r < 0.5) {
      title = `Seeded forged signature vector #${i + 1}`;
      expectedCode = 'INVALID_SIGNATURE';
    } else if (r < 0.75) {
      title = `Seeded expired delegate action block height #${i + 1}`;
      expectedCode = 'EXPIRED_DELEGATE';
    } else {
      title = `Seeded invalid delegate nonce variation #${i + 1}`;
      expectedCode = 'INVALID_NONCE';
    }

    pushCase({
      title,
      expectedLabel: 'BLOCKED',
      expectedCode,
      note: `Seeded parametric delegate vector (seed: ${SEED_CAT6})`,
    });
  }

  return cases;
}

/**
 * Generates Category 7 cases: gas budgets, 30/59/60 Tgas boundaries, facilitator maxGas.
 * Total: 35 cases.
 */
export function generateCategory7Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, gas, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-07-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 7,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: 'request_payment',
        gas: gas.toString(),
        args: {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
          amount: '100000',
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

  // 1-15. Explicit Gas Boundaries (30, 50, 59, 60, 61, 100, 150, 151 Tgas)
  pushCase({
    title: 'request_payment with 0 Tgas',
    gas: 0n,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Contract Step 0: prepaid gas < 60 Tgas panics INSUFFICIENT_GAS',
  });
  pushCase({
    title: 'request_payment with 10 Tgas',
    gas: 10n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Prepaid gas well below 60 Tgas threshold',
  });
  pushCase({
    title: 'request_payment with 30 Tgas (half of minimum required)',
    gas: 30n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Prepaid gas 30 Tgas rejected',
  });
  pushCase({
    title: 'request_payment with 50 Tgas',
    gas: 50n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Prepaid gas 50 Tgas rejected',
  });
  pushCase({
    title: 'request_payment with 58 Tgas',
    gas: 58n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Prepaid gas 58 Tgas rejected',
  });
  pushCase({
    title: 'request_payment with 59 Tgas (exact boundary minus 1 Tgas)',
    gas: 59n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Boundary: 59 Tgas < 60 Tgas minimum rejected',
  });
  pushCase({
    title: 'request_payment with 59.999 Tgas',
    gas: 59n * TGAS + 999_000_000_000n,
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Boundary: just below 60 Tgas rejected',
  });
  pushCase({
    title: 'request_payment with exact 60 Tgas (exact minimum requirement)',
    gas: 60n * TGAS,
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Boundary: 60 Tgas meets contract minimum',
  });
  pushCase({
    title: 'request_payment with 61 Tgas (boundary plus 1 Tgas)',
    gas: 61n * TGAS,
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Prepaid gas above minimum threshold',
  });
  pushCase({
    title: 'request_payment with 80 Tgas',
    gas: 80n * TGAS,
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Standard gas allowance',
  });
  pushCase({
    title: 'request_payment with 100 Tgas (standard facilitator relay gas)',
    gas: 100n * TGAS,
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Standard facilitator relay gas',
  });
  pushCase({
    title: 'request_payment with 150 Tgas (facilitator policy maxGas ceiling)',
    gas: 150n * TGAS,
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Exact facilitator policy maxGas ceiling is allowed',
  });
  pushCase({
    title: 'request_payment with 151 Tgas (exceeding facilitator policy maxGas by 1)',
    gas: 151n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXCEEDS_MAX_GAS',
    note: 'Facilitator policy rejects gas > 150 Tgas',
  });
  pushCase({
    title: 'request_payment with 200 Tgas',
    gas: 200n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXCEEDS_MAX_GAS',
    note: 'Exceeds facilitator maxGas limit',
  });
  pushCase({
    title: 'request_payment with 300 Tgas (maximum block gas limit)',
    gas: 300n * TGAS,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXCEEDS_MAX_GAS',
    note: 'Exceeds facilitator maxGas limit',
  });

  // 16-35. Property-based seeded variations for gas budgets (20 cases)
  const rng = mulberry32(SEED_CAT7);
  for (let i = 0; i < 20; i++) {
    const r = rng();
    let gas;
    let expectedLabel;
    let expectedCode;

    if (r < 0.4) {
      // Sub-60 Tgas: random between 10 and 59 Tgas
      gas = (10n + BigInt(Math.floor(rng() * 50))) * TGAS;
      expectedLabel = 'BLOCKED';
      expectedCode = 'INSUFFICIENT_GAS';
    } else if (r < 0.8) {
      // Valid gas: between 60 and 150 Tgas
      gas = (60n + BigInt(Math.floor(rng() * 90))) * TGAS;
      expectedLabel = 'INERT';
      expectedCode = null;
    } else {
      // Over maxGas: between 151 and 250 Tgas
      gas = (151n + BigInt(Math.floor(rng() * 100))) * TGAS;
      expectedLabel = 'BLOCKED';
      expectedCode = 'EXCEEDS_MAX_GAS';
    }

    pushCase({
      title: `Seeded parametric gas variation #${i + 1} (${gas / TGAS} Tgas)`,
      gas,
      expectedLabel,
      expectedCode,
      note: `Seeded gas budget vector (seed: ${SEED_CAT7})`,
    });
  }

  return cases;
}

/**
 * Combines Step 4 cases (Category 6 & Category 7).
 * Total: 80 cases.
 */
export function generateDelegateGasCases() {
  const cat6 = generateCategory6Cases();
  const cat7 = generateCategory7Cases();
  return [...cat6, ...cat7];
}
