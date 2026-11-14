"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ConnectorAction, NearConnector } from "@hot-labs/near-connect";
import { usePathname } from "next/navigation";
import { config, relayEnabled } from "@/lib/config";
import { UserFacingError } from "@/lib/errors";
import { signAndRelay, type RelayedItem } from "@/lib/relay";
import { sendCrossChainCashOut } from "@/lib/cross-chain-cash-out";
import type { CrossChainQuote } from "@/lib/cross-chain-quote";
import type { Action } from "@/lib/signed-intents";
import { connectEvm, connectSolana, watchEvmWallets, watchSolanaWallets, type Connected, type EvmWallet, type SolanaWallet } from "@/lib/wallets";
import { nearAccount, signsWithRelay, type Chain, type WalletAccount } from "@/lib/wallet-account";
import { backendEnabled, currentSession, signIn, signOut, signOutEverywhere } from "@/lib/backend";
import type { OwnerSigner } from "@/lib/agents";
import type { FunctionCall } from "@/lib/market";
import { createLegalAcceptance, legalAcceptanceKey, parseLegalAcceptance, readLegalAcceptance, saveLegalAcceptance } from "@/lib/legal";
import { sandboxSend } from "@/lib/rpc";
import { TermsAcceptanceDialog } from "./TermsAcceptanceDialog";
import { ConnectDialog } from "./ConnectDialog";

// NEAR Connect, the connector NEAR's docs recommend. Keys stay in the user's wallet; this app only asks it to sign.
// Not verified with a real wallet yet: the sandbox has no wallet, so that check waits for the testnet deploy.
export const NEAR_ONLY = "This is available with a NEAR wallet for now.";

export interface Discovered { evm: EvmWallet[]; solana: SolanaWallet[] }

interface WalletState {
  // The id the verifier, market and oracle know the person by. For an EVM or Solana wallet it is the 0x address or the 64 hex characters.
  account: string | null;
  // The same account with the chain it signs on. Null whenever `account` is.
  identity: WalletAccount | null;
  walletAvailable: boolean;
  // True when this build lets EVM and Solana wallets sign and the backend relay them.
  relayAvailable: boolean;
  // Signs each action in turn with the connected EVM or Solana wallet, then sends them together to the relay.
  signRelayed: (actions: Action[], shownFee: bigint) => Promise<{ hashes: string[]; items: RelayedItem[] }>;
  cashOut: (quote: CrossChainQuote) => Promise<void>;
  openConnect: () => void;
  disconnect: () => void;
  // The account the backend knows this browser as, or null. Signing in asks the wallet to sign one message and moves no money.
  backendAccount: string | null;
  signInToBackend: () => Promise<void>;
  signOutOnAllDevices: () => Promise<void>;
  send: (call: FunctionCall) => Promise<string>;
  sendTransaction: (receiverId: string, actions: ConnectorAction[]) => Promise<string>;
  signer: () => Promise<OwnerSigner>;
}

const Ctx = createContext<WalletState>({
  account: null,
  identity: null,
  walletAvailable: false,
  relayAvailable: false,
  signRelayed: () => Promise.reject(new Error("wallet not ready")),
  cashOut: () => Promise.reject(new Error("wallet not ready")),
  openConnect: () => {},
  disconnect: () => {},
  backendAccount: null,
  signInToBackend: () => Promise.reject(new Error("wallet not ready")),
  signOutOnAllDevices: () => Promise.reject(new Error("wallet not ready")),
  send: () => Promise.reject(new Error("wallet not ready")),
  sendTransaction: () => Promise.reject(new Error("wallet not ready")),
  signer: () => Promise.reject(new Error("wallet not ready")),
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
// open any page with ?as=<account id> once and it is remembered. Sends go to the mock chain, which applies them;
// a real sandbox refuses them.
function readDevAccount(): string | null {
  try {
    const asked = new URLSearchParams(window.location.search).get("as");
    if (asked) window.localStorage.setItem("pm-dev-account", asked);
    return asked ?? window.localStorage.getItem("pm-dev-account");
  } catch {
    return null;
  }
}

const REMEMBER_KEY = "dragons-market:wallet";
type Remembered = { chain: Chain; id: string } | null;
const readRemembered = (): Remembered => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null");
    return value && typeof value === "object" && "chain" in value && "id" in value && typeof value.id === "string"
      && (value.chain === "near" || value.chain === "evm" || value.chain === "solana") ? { chain: value.chain, id: value.id } : null;
  } catch { return null; }
};
const remember = (value: Remembered) => {
  try { if (value) localStorage.setItem(REMEMBER_KEY, JSON.stringify(value)); else localStorage.removeItem(REMEMBER_KEY); } catch { /* the choice is not kept */ }
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const readingPolicy = /^\/(privacy|terms)(\/|$)/.test(pathname);
  const connector = useRef<NearConnector | null>(null);
  const signing = useRef<Connected | null>(null);
  const unwatch = useRef<(() => void) | null>(null);
  const [connected, setConnected] = useState<WalletAccount | null>(null);
  const [sessionFor, setSessionFor] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered>({ evm: [], solana: [] });
  const walletAvailable = config.network !== "sandbox";
  const relayAvailable = walletAvailable && relayEnabled;
  const walletAccount = connected?.account ?? null;
  const devAccount = useSyncExternalStore(noSubscription, walletAvailable ? nobody : readDevAccount, nobody);
  const acceptanceRaw = useSyncExternalStore(subscribeToLegalAcceptance, () => {
    try { return walletAccount ? localStorage.getItem(legalAcceptanceKey(walletAccount, config.network)) : null; }
    catch { return null; }
  }, nobody);
  const accepted = walletAccount ? parseLegalAcceptance(acceptanceRaw, walletAccount, config.network) !== null : false;
  const account = walletAvailable ? (accepted ? walletAccount : null) : devAccount;
  const identity = walletAvailable ? (accepted ? connected : null) : devAccount ? nearAccount(devAccount) : null;
  // A session only counts for the account that is connected right now.
  const backendAccount = account !== null && sessionFor === account ? account : null;

  useEffect(() => {
    if (!walletAvailable) return;
    let live = true;
    let c: NearConnector | null = null;
    const onIn = (p: { accounts: { accountId: string }[] }) => {
      const id = p.accounts[0]?.accountId;
      if (!live) return;
      if (!id) { setConnected(current => (current?.chain === "near" ? null : current)); return; }
      unwatch.current?.();
      unwatch.current = null;
      signing.current = null;
      remember({ chain: "near", id });
      setConnected(nearAccount(id));
    };
    const onOut = () => {
      if (!live) return;
      // Leaving NEAR to connect another chain also signs the NEAR wallet out. That must not clear the new account.
      setConnected(current => (current?.chain === "near" ? null : current));
      setSessionFor(null);
      void signOut();
    };

    import("@hot-labs/near-connect").then(async ({ NearConnector }) => {
      if (!live) return;
      c = new NearConnector({
        // Caddy gives each HTML response a fresh nonce. The connector applies it
        // to scripts in its sandboxed wallet frames, which inherit the page CSP.
        cspNonce: document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined,
        network: config.network === "mainnet" ? "mainnet" : "testnet",
        features: { signAndSendTransaction: true, ...(backendEnabled() ? { signMessage: true } : {}) },
      });
      connector.current = c;
      c.on("wallet:signIn", onIn);
      c.on("wallet:signOut", onOut);
      try {
        const { accounts } = await c.getConnectedWallet();
        const last = relayAvailable ? readRemembered() : null;
        // The person last used an EVM or Solana wallet: that one comes back, not an older NEAR session.
        if (live && accounts[0] && (!last || last.chain === "near")) setConnected(nearAccount(accounts[0].accountId));
      } catch {
        // no saved session, stay signed out
      }
    });

    return () => {
      live = false;
      c?.off("wallet:signIn", onIn);
      c?.off("wallet:signOut", onOut);
    };
  }, [walletAvailable, relayAvailable]);

  useEffect(() => {
    if (!relayAvailable) return;
    const stopEvm = watchEvmWallets(evm => setDiscovered(d => ({ ...d, evm })));
    const stopSolana = watchSolanaWallets(solana => setDiscovered(d => ({ ...d, solana })));
    return () => { stopEvm(); stopSolana(); };
  }, [relayAvailable]);

  // The wallet signing for the connected account. A switch to another account in the wallet drops the connection, so nothing is
  // shown or signed for an account the wallet no longer has selected.
  const forgetSigner = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    signing.current = null;
  }, []);
  const adopt = useCallback((next: Connected, rememberAs: string) => {
    forgetSigner();
    signing.current = next;
    unwatch.current = next.watch(() => {
      if (signing.current !== next) return;
      forgetSigner();
      setConnected(current => (current?.account === next.account.account ? null : current));
      setSessionFor(null);
    });
    remember({ chain: next.account.chain, id: rememberAs });
    setConnected(next.account);
    setSessionFor(null);
  }, [forgetSigner]);
  useEffect(() => forgetSigner, [forgetSigner]);

  // Reconnect the wallet used last time, without a prompt, once discovery has found it. Only when exactly one wallet carries the
  // remembered key, so a second wallet announcing the same name or rdns is never picked silently. The account is read fresh.
  const restored = useRef(false);
  useEffect(() => {
    if (!relayAvailable || restored.current) return;
    const last = readRemembered();
    if (!last || last.chain === "near") return;
    const matches = (last.chain === "evm" ? discovered.evm : discovered.solana).filter(w => w.remember === last.id);
    if (matches.length !== 1) return;
    restored.current = true;
    const attempt = last.chain === "evm" ? connectEvm(matches[0] as EvmWallet, true) : connectSolana(matches[0] as SolanaWallet, true);
    attempt.then(next => { if (next) adopt(next, last.id); }).catch(() => {});
  }, [relayAvailable, discovered, adopt]);

  // A session left from an earlier visit counts only if it belongs to the account that is connected now.
  useEffect(() => {
    let live = true;
    if (!backendEnabled() || !walletAvailable || !account) return;
    currentSession().then(session => live && setSessionFor(session)).catch(() => live && setSessionFor(null));
    return () => { live = false; };
  }, [account, walletAvailable]);

  const connectNear = useCallback(() => {
    connector.current?.connect().catch(() => {
      // the person closed the wallet dialog
    });
  }, []);

  const openConnect = useCallback(() => {
    if (relayAvailable) setChooserOpen(true);
    else connectNear();
  }, [relayAvailable, connectNear]);

  const connectBrowserWallet = useCallback(async (kind: "evm" | "solana", id: string) => {
    const entry = kind === "evm" ? discovered.evm.find(w => w.id === id) : discovered.solana.find(w => w.id === id);
    if (!entry) throw new UserFacingError("That wallet is no longer available. Reload the page and try again.");
    const next = kind === "evm" ? await connectEvm(entry as EvmWallet) : await connectSolana(entry as SolanaWallet);
    if (!next) throw new UserFacingError("The wallet did not share an account. Unlock it and try again.");
    if (connected?.chain === "near") connector.current?.disconnect().catch(() => {});
    adopt(next, entry.remember);
  }, [discovered, connected, adopt]);

  const disconnect = useCallback(() => {
    const wasNear = connected?.chain === "near";
    forgetSigner();
    remember(null);
    setConnected(null);
    setSessionFor(null);
    void signOut();
    if (wasNear || !connected) connector.current?.disconnect().catch(() => {});
  }, [connected, forgetSigner]);

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
    if (connected?.chain !== "near") throw new UserFacingError(NEAR_ONLY);
    const wallet = await c.wallet();
    await signIn(account, ({ message, recipient, nonce }) =>
      wallet.signMessage({ message, recipient, nonce, signerId: account, network: config.network === "mainnet" ? "mainnet" : "testnet" }));
    setSessionFor(account);
  }, [account, connected]);

  const connectedWallet = useCallback(async () => {
    const c = connector.current;
    if (!c) throw new Error("wallet not ready");
    if (connected && connected.chain !== "near") throw new UserFacingError(NEAR_ONLY);
    if (!walletAccount || !readLegalAcceptance(window.localStorage, walletAccount, config.network)) throw new Error("Review and accept the current policies before continuing.");
    const wallet = await c.wallet();
    const accounts = await wallet.getAccounts();
    if (accounts[0]?.accountId !== walletAccount) throw new Error("Your wallet account changed. Connect again before continuing.");
    return { wallet, signerId: walletAccount };
  }, [walletAccount, connected]);

  const signRelayed = useCallback(async (actions: Action[], shownFee: bigint) => {
    const signer = signing.current;
    if (!signer || !signsWithRelay(connected) || signer.account.account !== connected.account) throw new UserFacingError("Connect your wallet again before continuing.");
    if (!readLegalAcceptance(window.localStorage, connected.account, config.network)) throw new UserFacingError("Review and accept the current policies before continuing.");
    const ctx = { verifier: config.verifierId, collateral: config.collateralTokenId, relayer: config.relayerId };
    return signAndRelay({ sign: signer.sign, ctx, signerId: connected.account, actions, shownFee });
  }, [connected]);

  const cashOut = useCallback((quote: CrossChainQuote) => {
    const signer = signing.current;
    if (!signer || !signsWithRelay(connected) || signer.account.account !== connected.account
      || quote.identity.account !== connected.account || quote.identity.chain !== connected.chain) {
      return Promise.reject(new UserFacingError("Connect your wallet again before continuing."));
    }
    const check = () => {
      if (signing.current !== signer
        || !readLegalAcceptance(window.localStorage, connected.account, config.network)) {
        throw new UserFacingError("Your wallet or policy acceptance changed. Connect again before continuing.");
      }
    };
    check();
    return sendCrossChainCashOut(quote, async payload => {
      check();
      const signed = await signer.sign(payload);
      check();
      return signed;
    }, window.localStorage);
  }, [connected]);

  const sendTransaction = useCallback(async (receiverId: string, actions: ConnectorAction[]) => {
    if (!walletAvailable) {
      if (!devAccount) throw new Error("wallet not ready");
      return sandboxSend(devAccount, receiverId, actions);
    }
    const { wallet, signerId } = await connectedWallet();
    const result = await wallet.signAndSendTransaction({ signerId, receiverId, actions });
    return result.transaction.hash;
  }, [connectedWallet, walletAvailable, devAccount]);

  const send = useCallback((call: FunctionCall) => {
    const { methodName, args, gas, deposit } = call;
    return sendTransaction(call.receiverId, [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }]);
  }, [sendTransaction]);

  const signer = useCallback(() => connectedWallet().then(({ wallet, signerId }): OwnerSigner => {
    const network = config.network === "mainnet" ? "mainnet" : "testnet";
    return {
      accountId: signerId,
      signMessage: (params) => wallet.signMessage({ ...params, signerId, network }),
      signDelegateActions: (params) => (wallet.manifest.features?.signDelegateActions
        ? wallet.signDelegateActions({ ...params, signerId, network })
        : Promise.reject(new Error(`${wallet.manifest.name} cannot sign this: it does not sign NEAR delegate actions. Connect a wallet that does.`))),
    };
  }), [connectedWallet]);

  const value = useMemo(
    () => ({ account, identity, walletAvailable, relayAvailable, signRelayed, cashOut, openConnect, disconnect, backendAccount, signInToBackend, signOutOnAllDevices, send, sendTransaction, signer }),
    [account, identity, walletAvailable, relayAvailable, signRelayed, cashOut, openConnect, disconnect, backendAccount, signInToBackend, signOutOnAllDevices, send, sendTransaction, signer],
  );
  return <Ctx.Provider value={value}>{children}
    {chooserOpen && <ConnectDialog wallets={discovered} onClose={() => setChooserOpen(false)}
      onNear={() => { setChooserOpen(false); connectNear(); }}
      onBrowserWallet={async (kind, id) => { await connectBrowserWallet(kind, id); setChooserOpen(false); }} />}
    {!readingPolicy && walletAvailable && walletAccount && !accepted && <TermsAcceptanceDialog key={walletAccount} account={walletAccount} onAccept={acceptPolicies} onDismiss={disconnect} />}</Ctx.Provider>;
}
