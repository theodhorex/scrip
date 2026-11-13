"use client";

// Wallet connection for the owner flow (testnet only), through near-connect: one picker for
// the NEAR wallets that support testnet (Meteor, Intear, Nightly, Ledger, ...). Loaded lazily so the rest of the app
// never ships it.
import { useCallback, useEffect, useState } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import type { WalletTx } from "./owner-flow";

let connectorPromise: Promise<NearConnector> | null = null;

function getConnector(): Promise<NearConnector> {
  if (!connectorPromise) {
    connectorPromise = import("@hot-labs/near-connect").then(({ NearConnector }) =>
      new NearConnector({ network: "testnet", features: { signAndSendTransactions: true, testnet: true }, footerBranding: null }),
    );
  }
  return connectorPromise;
}

export type WalletState = {
  accountId: string | null;
  ready: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  send: (tx: WalletTx) => Promise<unknown>;
  sendMany: (txs: WalletTx[]) => Promise<unknown[]>;
};

export function useWallet(): WalletState {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getConnector()
      .then(async (c) => {
        c.on("wallet:signIn", (e) => { if (alive) setAccountId(e.accounts[0]?.accountId ?? null); });
        c.on("wallet:signOut", () => { if (alive) setAccountId(null); });
        try {
          const { accounts } = await c.getConnectedWallet();
          if (alive) setAccountId(accounts[0]?.accountId ?? null);
        } catch {
          /* not signed in yet */
        }
      })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  const connect = useCallback(async () => {
    const c = await getConnector();
    const w = await c.connect();
    const accounts = await w.getAccounts({ network: "testnet" });
    setAccountId(accounts[0]?.accountId ?? null);
  }, []);

  const disconnect = useCallback(async () => {
    const c = await getConnector();
    await c.disconnect();
    setAccountId(null);
  }, []);

  const send = useCallback(async (tx: WalletTx) => {
    const c = await getConnector();
    const w = await c.wallet();
    return w.signAndSendTransaction({ network: "testnet", receiverId: tx.receiverId, actions: tx.actions as never });
  }, []);

  const sendMany = useCallback(async (txs: WalletTx[]) => {
    const c = await getConnector();
    const w = await c.wallet();
    return w.signAndSendTransactions({ network: "testnet", transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions as never })) });
  }, []);

  return { accountId, ready, connect, disconnect, send, sendMany };
}
