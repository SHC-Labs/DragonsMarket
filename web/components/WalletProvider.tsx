"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import { usePathname } from "next/navigation";
import { config } from "@/lib/config";
import { backendEnabled, currentSession, signIn, signOut, signOutEverywhere } from "@/lib/backend";
import type { FunctionCall } from "@/lib/market";
import { createLegalAcceptance, legalAcceptanceKey, parseLegalAcceptance, readLegalAcceptance, saveLegalAcceptance } from "@/lib/legal";
import { TermsAcceptanceDialog } from "./TermsAcceptanceDialog";

// NEAR Connect, the connector NEAR's docs recommend. Keys stay in the user's wallet; this app only asks it to sign.
// Not verified with a real wallet yet: the sandbox has no wallet, so that check waits for the testnet deploy.
interface WalletState {
  account: string | null;
  walletAvailable: boolean;
  openConnect: () => void;
  disconnect: () => void;
  // The account the backend knows this browser as, or null. Signing in asks the wallet to sign one message and moves no money.
  backendAccount: string | null;
  signInToBackend: () => Promise<void>;
  signOutOnAllDevices: () => Promise<void>;
  send: (call: FunctionCall) => Promise<string>;
}

const Ctx = createContext<WalletState>({
  account: null,
  walletAvailable: false,
  openConnect: () => {},
  disconnect: () => {},
  backendAccount: null,
  signInToBackend: () => Promise.reject(new Error("wallet not ready")),
  signOutOnAllDevices: () => Promise.reject(new Error("wallet not ready")),
  send: () => Promise.reject(new Error("wallet not ready")),
});

export const useWallet = () => useContext(Ctx);

const noSubscription = () => () => {};
const nobody = () => null;
const subscribeToLegalAcceptance = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("legal-acceptance-change", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("legal-acceptance-change", notify);
  };
};

// The local test chain has no wallet. To look at account views, the page can pretend to be an account:
// open any page with ?as=<account id> once and it is remembered. Reads only; sending is refused.
function readDevAccount(): string | null {
  try {
    const asked = new URLSearchParams(window.location.search).get("as");
    if (asked) window.localStorage.setItem("pm-dev-account", asked);
    return asked ?? window.localStorage.getItem("pm-dev-account");
  } catch {
    return null;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const readingPolicy = /^\/(privacy|terms)(\/|$)/.test(pathname);
  const connector = useRef<NearConnector | null>(null);
  const [walletAccount, setAccount] = useState<string | null>(null);
  const [sessionFor, setSessionFor] = useState<string | null>(null);
  const walletAvailable = config.network !== "sandbox";
  const devAccount = useSyncExternalStore(noSubscription, walletAvailable ? nobody : readDevAccount, nobody);
  const acceptanceRaw = useSyncExternalStore(subscribeToLegalAcceptance, () => {
    try { return walletAccount ? localStorage.getItem(legalAcceptanceKey(walletAccount, config.network)) : null; }
    catch { return null; }
  }, nobody);
  const accepted = walletAccount ? parseLegalAcceptance(acceptanceRaw, walletAccount, config.network) !== null : false;
  const account = walletAvailable ? (accepted ? walletAccount : null) : devAccount;
  // A session only counts for the account that is connected right now.
  const backendAccount = account !== null && sessionFor === account ? account : null;

  useEffect(() => {
    if (!walletAvailable) return;
    let live = true;
    let c: NearConnector | null = null;
    const onIn = (p: { accounts: { accountId: string }[] }) => live && setAccount(p.accounts[0]?.accountId ?? null);
    const onOut = () => {
      if (!live) return;
      setAccount(null);
      setSessionFor(null);
      void signOut();
    };

    import("@hot-labs/near-connect").then(async ({ NearConnector }) => {
      if (!live) return;
      c = new NearConnector({
        network: config.network === "mainnet" ? "mainnet" : "testnet",
        features: { signAndSendTransaction: true, ...(backendEnabled() ? { signMessage: true } : {}) },
      });
      connector.current = c;
      c.on("wallet:signIn", onIn);
      c.on("wallet:signOut", onOut);
      try {
        const { accounts } = await c.getConnectedWallet();
        if (live) setAccount(accounts[0]?.accountId ?? null);
      } catch {
        // no saved session, stay signed out
      }
    });

    return () => {
      live = false;
      c?.off("wallet:signIn", onIn);
      c?.off("wallet:signOut", onOut);
    };
  }, [walletAvailable]);

  // A session left from an earlier visit counts only if it belongs to the account that is connected now.
  useEffect(() => {
    let live = true;
    if (!backendEnabled() || !walletAvailable || !account) return;
    currentSession().then(session => live && setSessionFor(session)).catch(() => live && setSessionFor(null));
    return () => { live = false; };
  }, [account, walletAvailable]);

  const openConnect = useCallback(() => {
    connector.current?.connect().catch(() => {
      // the person closed the wallet dialog
    });
  }, []);

  const disconnect = useCallback(() => {
    setAccount(null);
    setSessionFor(null);
    void signOut();
    connector.current?.disconnect().catch(() => {});
  }, []);

  const signOutOnAllDevices = useCallback(async () => {
    await signOutEverywhere();
    disconnect();
  }, [disconnect]);

  const acceptPolicies = () => {
    if (!walletAccount || !walletAvailable) throw new Error("Connect a wallet first.");
    saveLegalAcceptance(window.localStorage, createLegalAcceptance(walletAccount, config.network));
    window.dispatchEvent(new Event("legal-acceptance-change"));
  };

  const signInToBackend = useCallback(async () => {
    const c = connector.current;
    if (!c || !account) throw new Error("Connect a wallet first.");
    const wallet = await c.wallet();
    await signIn(account, ({ message, recipient, nonce }) =>
      wallet.signMessage({ message, recipient, nonce, signerId: account, network: config.network === "mainnet" ? "mainnet" : "testnet" }));
    setSessionFor(account);
  }, [account]);

  const send = useCallback(async (call: FunctionCall) => {
    const c = connector.current;
    if (!c) throw new Error("wallet not ready");
    if (!walletAccount || !readLegalAcceptance(window.localStorage, walletAccount, config.network)) throw new Error("Review and accept the current policies before continuing.");
    const wallet = await c.wallet();
    const connected = await wallet.getAccounts();
    if (connected[0]?.accountId !== walletAccount) throw new Error("Your wallet account changed. Connect again before continuing.");
    const result = await wallet.signAndSendTransaction({
      signerId: walletAccount,
      receiverId: call.receiverId,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: call.methodName, args: call.args, gas: call.gas, deposit: call.deposit },
        },
      ],
    });
    return result.transaction.hash;
  }, [walletAccount]);

  const value = useMemo(
    () => ({ account, walletAvailable, openConnect, disconnect, backendAccount, signInToBackend, signOutOnAllDevices, send }),
    [account, walletAvailable, openConnect, disconnect, backendAccount, signInToBackend, signOutOnAllDevices, send],
  );
  return <Ctx.Provider value={value}>{children}{!readingPolicy && walletAvailable && walletAccount && !accepted && <TermsAcceptanceDialog key={walletAccount} account={walletAccount} onAccept={acceptPolicies} onDismiss={disconnect} />}</Ctx.Provider>;
}
