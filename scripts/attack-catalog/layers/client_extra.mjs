// Extended Layer C Executor for C2 Attack Cases (Offline Client and Parser)
// Supports Category 1, 2, 4, 6, 8, 12 and extended targets (custom bit-flip, public key mismatch, absurd out-of-scope).
import { createHash } from 'node:crypto';
import * as nearApi from '../../../client/node_modules/near-api-js/lib/index.js';
import { intentHash } from '../../../client/src/intent.mjs';
import {
  buildRequestPayment,
  signDelegate,
  parseRequestResult,
  relayBodyFor,
} from '../../../client/src/delegate.mjs';
import {
  parsePaymentResponse,
  buildPaymentSignature,
} from '../../../client/src/payment.mjs';
import { executeLayerC } from '../cases/index.mjs';

const { KeyPair, PublicKey, KeyType, encodeDelegateAction } = nearApi;

/**
 * Extended Layer C executor supporting Kat 12 and enhanced Kat 6 variations.
 *
 * @param {object} c - Case definition
 * @returns {Promise<{label: string, code?: string, note?: string}>}
 */
export async function executeLayerCExtra(c) {
  try {
    // Kat 12: Absurd and Out of Scope
    if (c.category === 12) {
      if (c.params.isOutOfScope || c.params.target === 'outOfScope') {
        return {
          label: 'OUT_OF_SCOPE',
          note: c.params.reason || 'Input scenario is outside client security guarantees',
        };
      }

      if (c.params.target === 'intentHash') {
        const hash = intentHash(c.params.input);
        return {
          label: 'INERT',
          note: `Parser accepted absurd input; generated hash: ${Buffer.from(hash).toString('hex').slice(0, 16)}...`,
        };
      }

      if (c.params.target === 'parsePaymentResponse') {
        const parsed = parsePaymentResponse(c.params.input);
        return {
          label: 'INERT',
          note: `Parsed payment response: ok=${parsed.ok}, success=${parsed.success}`,
        };
      }

      if (c.params.target === 'buildPaymentSignature') {
        const sig = await buildPaymentSignature(c.params.requirements, c.params.options);
        return {
          label: 'INERT',
          note: `Payment signature generated: len=${sig.base64.length}`,
        };
      }

      if (c.params.target === 'buildRequestPayment') {
        const action = buildRequestPayment(c.params.params);
        return {
          label: 'INERT',
          note: `Action built: ${action.functionCall.methodName}`,
        };
      }

      if (c.params.target === 'circularReference') {
        // Test JSON stringification of circular object
        JSON.stringify(c.params.input);
        return { label: 'INERT', note: 'Handled circular reference' };
      }

      return {
        label: 'OUT_OF_SCOPE',
        note: c.params.reason || 'Unmodeled absurd scenario',
      };
    }

    // Kat 8 extended parsing targets (relayBodyFor, parseRequestResult)
    if (c.category === 8) {
      const { target, input, requirements, options } = c.params;
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
    }

    // Kat 6 extended targets (custom bit flips, public key mismatch, etc.)
    if (c.category === 6 && c.params?.target === 'tamperedSignatureCustom') {
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

      if (typeof c.params.bitFlipByte === 'number') {
        const byteIdx = Math.max(0, Math.min(63, c.params.bitFlipByte));
        const bitMask = 1 << (c.params.bitFlipBit || 0);
        sigBytes[byteIdx] ^= bitMask;
      }

      let pkData = Uint8Array.from(da.publicKey.ed25519Key.data);
      if (c.params.tamperPublicKey) {
        const otherKey = KeyPair.fromRandom('ed25519');
        pkData = Uint8Array.from(otherKey.getPublicKey().data);
      }

      if (c.params.tamperReceiver) {
        hash[0] ^= 1;
      }

      const pk = new PublicKey({ keyType: KeyType.ED25519, data: pkData });
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

    // For all other categories, delegate to standard executeLayerC
    return await executeLayerC(c);
  } catch (err) {
    const code = err.name || 'Error';
    return {
      label: 'BLOCKED',
      code,
      note: err.message,
    };
  }
}
