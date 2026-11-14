import { UserFacingError } from "./errors";
import { encodeEd25519, encodeErc191, toHex, utf8, type MultiPayload } from "./signed-intents";
import { evmAccount, solanaAccount, type WalletAccount } from "./wallet-account";

// Browser wallets for EVM and Solana, found with the two discovery standards (EIP-6963 and Wallet Standard). This site never
// holds a key: it asks the wallet to sign one text message at a time and shows that text first.

export interface Connected {
  account: WalletAccount;
  sign: (payload: string) => Promise<MultiPayload>;
  // Calls `onSwitch` when the wallet moves to another account or disconnects this site. Returns the unsubscribe.
  watch: (onSwitch: () => void) => () => void;
}

// `id` is unique on this page. `remember` is the key kept across reloads to reconnect silently: EIP-6963 uuids change on every
// page load, and two wallets may share a name, so a reconnect only happens when exactly one wallet carries that key.
interface Described { id: string; remember: string; name: string; icon: string | null }

// Wallet names and icons come from whatever code announced them. Names are shown as text, so only direction overrides and
// control characters (which can reorder or hide what is read) are removed. Icons go into an <img>, which never runs scripts,
// and only data images of a sane size are kept so nothing is fetched from elsewhere.
const MAX_NAME = 40;
const MAX_ICON = 100_000;
export const cleanName = (name: string) =>
  name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, MAX_NAME) || "Wallet";
export const cleanIcon = (icon: unknown) =>
  typeof icon === "string" && icon.length <= MAX_ICON && /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : null;

// ---- EVM ---------------------------------------------------------------------------------

export interface EvmProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
}
export interface EvmWallet extends Described { provider: EvmProvider }

const isProvider = (value: unknown): value is EvmProvider =>
  typeof value === "object" && value !== null && typeof (value as EvmProvider).request === "function";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const declined = () => new UserFacingError("You declined the request in your wallet. Nothing was sent.");
const walletFailure = (error: unknown) => {
  const code = record(error) ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === 4001 || code === "ACTION_REJECTED" || /reject|declin|denied|cancel/i.test(message)) return declined();
  return new UserFacingError("The wallet could not sign this. Open it, then try again.");
};

// Wallets announce themselves after the request event. A page with no extension that follows EIP-6963 still has window.ethereum,
// which is listed only while nothing announced, since the announced wallet is usually the same one.
// A second announcement with an rdns already listed is ignored: either it is the same wallet again or something posing as it.
export function watchEvmWallets(onChange: (wallets: EvmWallet[]) => void): () => void {
  const announced = new Map<string, EvmWallet>();
  const emit = () => {
    const wallets = [...announced.values()];
    const injected = (window as { ethereum?: unknown }).ethereum;
    if (wallets.length === 0 && isProvider(injected)) {
      wallets.push({ id: "window.ethereum", remember: "window.ethereum", name: "Browser wallet", icon: null, provider: injected });
    }
    onChange(wallets);
  };
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!record(detail) || !record(detail.info) || !isProvider(detail.provider)) return;
    const { uuid, name, icon, rdns } = detail.info;
    if (typeof uuid !== "string" || uuid === "" || typeof name !== "string") return;
    const key = typeof rdns === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(rdns) ? `rdns:${rdns.toLowerCase()}` : `uuid:${uuid}`;
    const existing = announced.get(key);
    if (existing && existing.provider !== detail.provider) return;
    announced.set(key, { id: key, remember: key, name: cleanName(name), icon: cleanIcon(icon), provider: detail.provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // window.ethereum can arrive a moment after the page loads
  const late = setTimeout(emit, 500);
  emit();
  return () => { clearTimeout(late); window.removeEventListener("eip6963:announceProvider", onAnnounce); };
}

async function evmAddress(wallet: EvmWallet, method: "eth_requestAccounts" | "eth_accounts"): Promise<string | null> {
  const accounts = await wallet.provider.request({ method });
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
}

// `silent` asks only for an account the wallet already shared with this site, so reloading the page never opens a prompt.
export async function connectEvm(wallet: EvmWallet, silent = false): Promise<Connected | null> {
  let address: string | null;
  try { address = await evmAddress(wallet, silent ? "eth_accounts" : "eth_requestAccounts"); } catch (e) { if (silent) return null; throw walletFailure(e); }
  if (!address) return null;
  const account = evmAccount(address);
  return {
    account,
    watch(onSwitch) {
      const { on, removeListener } = wallet.provider;
      if (!on || !removeListener) return () => {};
      const listener = (accounts: unknown) => {
        const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
        if (first !== account.account) onSwitch();
      };
      on.call(wallet.provider, "accountsChanged", listener);
      return () => removeListener.call(wallet.provider, "accountsChanged", listener);
    },
    async sign(payload) {
      // The wallet may have switched accounts since connecting. Signing as another account would be refused later, so say so now.
      const current = await evmAddress(wallet, "eth_accounts").catch(() => null);
      if (current?.toLowerCase() !== account.account) throw new UserFacingError("Your wallet account changed. Connect again before continuing.");
      try {
        const signature = await wallet.provider.request({ method: "personal_sign", params: [toHex(utf8(payload)), current] });
        if (typeof signature !== "string") throw new Error("no signature");
        return encodeErc191(payload, signature);
      } catch (e) {
        throw e instanceof UserFacingError ? e : walletFailure(e);
      }
    },
  };
}

// ---- Solana (Wallet Standard) --------------------------------------------------------------

interface StandardAccount { address: string; publicKey: Uint8Array; features: readonly string[] }
interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}
interface ConnectFeature { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly StandardAccount[] }> }
interface EventsFeature { on: (event: "change", listener: (props: { accounts?: readonly StandardAccount[] }) => void) => () => void }
interface SignMessageFeature { signMessage: (input: { account: StandardAccount; message: Uint8Array }) => Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]> }

export interface SolanaWallet extends Described { wallet: StandardWallet }

const CONNECT = "standard:connect";
const SIGN_MESSAGE = "solana:signMessage";
const EVENTS = "standard:events";
const usable = (wallet: StandardWallet) => record(wallet) && record(wallet.features) && Array.isArray(wallet.chains) && typeof wallet.name === "string"
  && CONNECT in wallet.features && SIGN_MESSAGE in wallet.features && wallet.chains.some(chain => chain.startsWith("solana:"));

// Wallet Standard: wallets dispatch "register-wallet" with a callback, and this page answers "app-ready" for the ones that loaded first.
export function watchSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  const registered = new Set<StandardWallet>();
  const ids = new WeakMap<StandardWallet, string>();
  let next = 0;
  const emit = () => onChange([...registered].filter(usable).map(wallet => {
    if (!ids.has(wallet)) ids.set(wallet, `solana:${next++}`);
    return { id: ids.get(wallet)!, remember: `name:${cleanName(wallet.name)}`, name: cleanName(wallet.name), icon: cleanIcon(wallet.icon), wallet };
  }));
  const api = {
    register(...wallets: StandardWallet[]) {
      wallets.forEach(w => registered.add(w));
      emit();
      return () => { wallets.forEach(w => registered.delete(w)); emit(); };
    },
  };
  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent).detail;
    if (typeof callback === "function") callback(api);
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
}

export async function connectSolana(entry: SolanaWallet, silent = false): Promise<Connected | null> {
  const { wallet } = entry;
  const feature = wallet.features[CONNECT] as ConnectFeature;
  let accounts: readonly StandardAccount[];
  try { accounts = (await feature.connect(silent ? { silent: true } : undefined)).accounts; } catch (e) { if (silent) return null; throw walletFailure(e); }
  const chosen = accounts.find(a => a.features.includes(SIGN_MESSAGE)) ?? accounts[0];
  if (!chosen) return null;
  const account = solanaAccount(chosen.publicKey, chosen.address);
  const stillChosen = (accounts: readonly StandardAccount[] | undefined) => Array.isArray(accounts) && accounts.some(a => a.address === chosen.address);
  return {
    account,
    watch(onSwitch) {
      const events = wallet.features[EVENTS] as EventsFeature | undefined;
      if (typeof events?.on !== "function") return () => {};
      return events.on("change", ({ accounts }) => { if (accounts !== undefined && !stillChosen(accounts)) onSwitch(); });
    },
    async sign(payload) {
      // Wallet Standard keeps `accounts` to the ones this site may use right now. A switch or disconnect removes the chosen one.
      if (!stillChosen(wallet.accounts)) throw new UserFacingError("Your wallet account changed. Connect again before continuing.");
      const message = utf8(payload);
      let signed: { signedMessage: Uint8Array; signature: Uint8Array } | undefined;
      try {
        [signed] = await (wallet.features[SIGN_MESSAGE] as SignMessageFeature).signMessage({ account: chosen, message });
      } catch (e) {
        throw walletFailure(e);
      }
      // A wallet that wraps the message in its own header signs something else, and the signature would not verify.
      if (!signed || !(signed.signedMessage instanceof Uint8Array) || signed.signedMessage.length !== message.length || signed.signedMessage.some((b, i) => b !== message[i])) {
        throw new UserFacingError("This wallet changed the message before signing, so the signature cannot be used. Try another wallet.");
      }
      if (!(signed.signature instanceof Uint8Array) || !(await ed25519Verifies(chosen.publicKey, message, signed.signature))) {
        throw new UserFacingError("The wallet's signature does not match the connected account. Connect again before continuing.");
      }
      return encodeEd25519(payload, chosen.publicKey, signed.signature);
    },
  };
}

// Checked here so a wrong key or a switched account is caught before anything is sent. Browsers without Ed25519 in WebCrypto
// skip the check; the relay's simulation refuses a bad signature before anything is spent.
async function ed25519Verifies(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return true;
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new Uint8Array(message));
}
