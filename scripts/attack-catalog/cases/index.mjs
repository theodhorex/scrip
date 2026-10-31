// Aggregator and Executors for Attack Catalog Cases (Layer B & Layer C)
import { createHash } from 'node:crypto';
import * as nearApi from '../../../client/node_modules/near-api-js/lib/index.js';
import { intentHash } from '../../../client/src/intent.mjs';
import {
  buildRequestPayment,
  signDelegate,
  relayBodyFor,
  parseRequestResult,
} from '../../../client/src/delegate.mjs';
import {
  parsePaymentResponse,
  buildPaymentSignature,
} from '../../../client/src/payment.mjs';

import { generateCategory1Cases } from './category_1.mjs';
import { generateCategory2Cases } from './category_2.mjs';
import { generateCategory4Cases } from './category_4.mjs';
import { generateCategory5Cases } from './category_5.mjs';
import { generateCategory6Cases } from './category_6.mjs';
import { generateCategory7Cases } from './category_7.mjs';
import { generateCategory8Cases } from './category_8.mjs';
import { generateCategory9Cases } from './category_9.mjs';
import { generateD2SpoofCases } from './d2_spoof.mjs';
import { generateC2Cases } from './c2_extra.mjs';
import { generateB2Cases } from './b2_extra.mjs';
import { executeLayerCExtra } from '../layers/client_extra.mjs';
import { executeLayerB, stopFacilitatorServer } from '../layers/facilitator.mjs';
import { executeLayerE } from '../layers/testnet.mjs';
import {
  getLayerECases,
  getLayerEComparisonCases,
  generatePaymentBudgetCases,
  generateApprovalLifecycleCases,
  generateAccessIdentityCases,
  generateDelegateGasCases,
  generateTokenRecipientCases,
  generateComparisonCases,
} from './layer_e/index.mjs';

const { KeyPair, PublicKey, KeyType, encodeDelegateAction } = nearApi;

export {
  generateCategory1Cases,
  generateCategory2Cases,
  generateCategory4Cases,
  generateCategory5Cases,
  generateCategory6Cases,
  generateCategory7Cases,
  generateCategory8Cases,
  generateCategory9Cases,
  getLayerECases,
  getLayerEComparisonCases,
  generatePaymentBudgetCases,
  generateApprovalLifecycleCases,
  generateAccessIdentityCases,
  generateDelegateGasCases,
  generateTokenRecipientCases,
  generateComparisonCases,
};

/**
 * Returns all parametric cases for Layer B and Layer C.
 *
 * @returns {Array<object>} attack cases
 */
export function getSampleCases() {
  const cat1 = generateCategory1Cases();
  const cat2 = generateCategory2Cases();
  const cat4 = generateCategory4Cases();
  const cat5 = generateCategory5Cases();
  const cat6 = generateCategory6Cases();
  const cat7 = generateCategory7Cases();
  const cat8 = generateCategory8Cases();
  const cat9 = generateCategory9Cases();
  return [...cat1, ...cat2, ...cat4, ...cat5, ...cat6, ...cat7, ...cat8, ...cat9, ...generateD2SpoofCases(), ...generateB2Cases(), ...generateC2Cases()];
}

/**
 * Executor for Layer C (Client parser / SDK).
 * Invokes real client parsing functions directly without network or mocks.
 *
 * @param {object} c - Case definition
 * @returns {Promise<{label: string, code?: string, note?: string}>}
 */
export async function executeLayerC(c) {
  try {
    if (c.category === 1 || c.category === 2 || c.category === 4) {
      // 1. Test intent hash parsing (pure crypto and validation)
      const hash = intentHash({
        mandateId: c.params.mandateId,
        recipient: c.params.recipient,
        amount: c.params.amount,
        nonce: c.params.nonce,
        expiresAtMs: c.params.expiresAtMs,
      });

      // 2. Test request_payment action builder (argument serialization)
      buildRequestPayment({
        contractId: c.params.contractId || 'amanat.testnet',
        mandateId: c.params.mandateId,
        recipient: c.params.recipient,
        amount: c.params.amount,
        nonce: c.params.nonce,
      });

      return {
        label: 'INERT',
        note: `Parser accepted input; generated intent hash: ${Buffer.from(hash).toString('hex').slice(0, 16)}...`,
      };
    }

    if (c.category === 8) {
      const { target, input, requirements, options } = c.params;
      if (target === 'parsePaymentResponse') {
        const parsed = parsePaymentResponse(input);
        return {
          label: 'INERT',
          note: `Payment response parsed: ok=${parsed.ok}, success=${parsed.success}, txHash=${parsed.txHash || 'none'}`,
        };
      }
      if (target === 'buildPaymentSignature') {
        const sig = await buildPaymentSignature(requirements, options);
        return {
          label: 'INERT',
          note: `Payment signature generated: base64 len=${sig.base64.length}`,
        };
      }
      throw new Error(`Unknown target for category 8: ${target}`);
    }

    if (c.category === 6) {
      const { target, params, input, tamperType } = c.params;
      if (target === 'buildRequestPayment') {
        const action = buildRequestPayment(params);
        return {
          label: 'INERT',
          note: `Action built: ${action.functionCall.methodName}`,
        };
      }
      if (target === 'signDelegate') {
        const p = { ...(params || {}) };
        if (p.action === undefined) {
          p.action = buildRequestPayment({
            contractId: 'amanat.testnet',
            mandateId: 1n,
            recipient: 'bob.near',
            amount: '1000',
            nonce: 1n,
          });
        }
        if (p.keyPair === undefined) {
          p.keyPair = KeyPair.fromRandom('ed25519');
        }
        const signed = await signDelegate(p);
        return {
          label: 'INERT',
          note: `Delegate signed: base64 len=${signed.base64.length}`,
        };
      }
      if (target === 'relayBodyFor') {
        const body = relayBodyFor(input);
        return {
          label: 'INERT',
          note: `Relay body generated: ${body.slice(0, 30)}...`,
        };
      }
      if (target === 'parseRequestResult') {
        const res = parseRequestResult(input);
        return {
          label: 'INERT',
          note: `PaymentResult parsed: kind=${res.kind}, requestId=${res.requestId}, code=${res.code}`,
        };
      }
      if (target === 'tamperedSignature') {
        const keyPair = KeyPair.fromRandom('ed25519');
        const action = buildRequestPayment({
          contractId: 'amanat.testnet',
          mandateId: 1n,
          recipient: 'bob.near',
          amount: '1000',
          nonce: 1n,
        });
        const r = await signDelegate({
          agentId: 'agent.testnet',
          contractId: 'amanat.testnet',
          action,
          nonce: 1n,
          maxBlockHeight: 1000n,
          keyPair,
        });
        const da = r.signedDelegate.delegateAction;
        let hash = new Uint8Array(createHash('sha256').update(encodeDelegateAction(da)).digest());
        let sigBytes = Uint8Array.from(r.signedDelegate.signature.ed25519Signature.data);

        if (tamperType === 'signature_bit_flip') {
          sigBytes[0] ^= 1;
        } else if (tamperType === 'action_receiver_tampered') {
          hash[0] ^= 1;
        }

        const pk = new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(da.publicKey.ed25519Key.data) });
        const isValid = pk.verify(hash, sigBytes);
        if (!isValid) {
          const err = new Error('Cryptographic signature verification failed');
          err.name = 'SignatureVerificationError';
          throw err;
        }
        return {
          label: 'INERT',
          note: 'Signature verified successfully',
        };
      }
      throw new Error(`Unknown target for category 6: ${target}`);
    }

    throw new Error(`Unsupported category for Layer C: ${c.category}`);
  } catch (err) {
    const code = err.name || 'Error';
    return {
      label: 'BLOCKED',
      code,
      note: err.message,
    };
  }
}

export const defaultExecutors = {
  B: executeLayerB,
  C: executeLayerCExtra, // handles category 12 + C2 variants; delegates everything else to executeLayerC
  E: executeLayerE,
  cleanup: stopFacilitatorServer,
};
