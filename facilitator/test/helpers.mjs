// Test helpers: build real signed delegates offline with random ed25519 keys.
import { KeyPair, KeyPairSigner, buildDelegateAction, actions, encodeSignedDelegate } from 'near-api-js';

export const CONTRACT = 'amanat.testnet';
export const AGENT = 'agent1.testnet';

export const basePolicy = {
  network: 'testnet',
  contractId: CONTRACT,
  allowedMethods: ['request_payment'],
  allowedAgents: [AGENT],
  maxGas: '100000000000000',
  maxBlockHeightWindow: 200,
  minBlockHeightMargin: 5,
  rateLimit: { capacity: 3, refillPerSecond: 1 },
};

/** Returns { b64, signedDelegate, keyPair }. Overrides tweak each field. */
export async function makeSigned(o = {}) {
  const keyPair = o.keyPair ?? KeyPair.fromRandom('ed25519');
  const signer = new KeyPairSigner(keyPair);
  const delegateAction = buildDelegateAction({
    senderId: o.senderId ?? AGENT,
    receiverId: o.receiverId ?? CONTRACT,
    actions: o.actions ?? [
      actions.functionCall(
        o.method ?? 'request_payment',
        { mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 1 },
        o.gas ?? 60_000_000_000_000n,
        o.deposit ?? 0n,
      ),
    ],
    nonce: o.nonce ?? 7n,
    maxBlockHeight: o.maxBlockHeight ?? 1050n,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return { signedDelegate, keyPair, b64: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') };
}

/** Test double of the RPC only: viewAccessKey answers from a map, default = a proper FunctionCall key. */
export const goodPermission = (o = {}) => ({
  FunctionCall: { allowance: '1000000000000000000000000', receiver_id: CONTRACT, method_names: ['request_payment'], ...o },
});
export function fakeProvider({ height = 1000, permission = goodPermission(), onKey, mandate = { id: 1, token: 'usdc.testnet', owner: 'alice.testnet' }, onCallFunction } = {}) {
  const calls = { viewBlock: 0, viewAccessKey: 0, callFunction: 0 };
  return {
    calls,
    viewBlock: async () => (calls.viewBlock++, { header: { height } }),
    viewAccessKey: async (args) => {
      calls.viewAccessKey++;
      if (onKey) return onKey(args);
      return { nonce: 0n, permission };
    },
    callFunction: async (args) => {
      calls.callFunction++;
      if (onCallFunction) return onCallFunction(args);
      if (args?.method === 'get_mandate') {
        if (typeof mandate === 'function') return mandate(args);
        return mandate;
      }
      return null;
    },
  };
}
