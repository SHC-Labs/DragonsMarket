import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../base58";
import { connectEvm, connectSolana, watchEvmWallets, watchSolanaWallets, type EvmProvider, type EvmWallet, type SolanaWallet } from "../wallets";

const seed = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const publicKey = new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));

beforeEach(() => { vi.stubGlobal("window", new EventTarget()); });
afterEach(() => vi.unstubAllGlobals());

function evmProvider(address: string, signature: string) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: EvmProvider = { request: async args => { calls.push(args); return args.method === "personal_sign" ? signature : [address]; } };
  return { provider, calls };
}

describe("EVM wallets", () => {
  it("finds wallets that announce themselves under EIP-6963", () => {
    const { provider } = evmProvider("0xabc0000000000000000000000000000000000001", "0x");
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u1", name: "Test Wallet", icon: "data:image/svg+xml;base64,AAAA", rdns: "t.w" }, provider } }));
    });
    let found: EvmWallet[] = [];
    const stop = watchEvmWallets(wallets => { found = wallets; });
    expect(found.map(w => [w.id, w.name, w.icon])).toEqual([["rdns:t.w", "Test Wallet", "data:image/svg+xml;base64,AAAA"]]);
    stop();
  });
  it("drops an announced icon that is not a data image", () => {
    const { provider } = evmProvider("0xabc0000000000000000000000000000000000001", "0x");
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u2", name: "Odd", icon: "https://evil.example/x.png", rdns: "o" }, provider } }));
    });
    let found: EvmWallet[] = [];
    watchEvmWallets(wallets => { found = wallets; })();
    expect(found[0].icon).toBeNull();
  });
  it("falls back to window.ethereum", () => {
    const { provider } = evmProvider("0xabc0000000000000000000000000000000000001", "0x");
    (window as unknown as { ethereum: EvmProvider }).ethereum = provider;
    let found: EvmWallet[] = [];
    watchEvmWallets(wallets => { found = wallets; })();
    expect(found.map(w => w.id)).toEqual(["window.ethereum"]);
  });
  it("signs the payload text as hex personal_sign data for the connected address and normalises v", async () => {
    const address = "0xAbC0000000000000000000000000000000000001";
    const rs = "11".repeat(32) + "22".repeat(32);
    const { provider, calls } = evmProvider(address, `0x${rs}1c`);
    const connected = await connectEvm({ id: "u", remember: "u", name: "T", icon: null, provider });
    expect(connected?.account).toEqual({ chain: "evm", account: address.toLowerCase(), label: address });
    const signed = await connected!.sign('{"a":"é"}');
    const personal = calls.find(c => c.method === "personal_sign")!;
    expect(personal.params).toEqual([`0x${Buffer.from('{"a":"é"}').toString("hex")}`, address]);
    expect(signed).toEqual({ standard: "erc191", payload: '{"a":"é"}', signature: `secp256k1:${base58Encode(Uint8Array.from([...Buffer.from(rs, "hex"), 1]))}` });
  });
  it("refuses to sign once the wallet has switched account", async () => {
    let current = "0xabc0000000000000000000000000000000000001";
    const provider: EvmProvider = { request: async () => [current] };
    const connected = await connectEvm({ id: "u", remember: "u", name: "T", icon: null, provider });
    current = "0xdef0000000000000000000000000000000000002";
    await expect(connected!.sign("x")).rejects.toThrow("account changed");
  });
  it("reports a declined prompt in words", async () => {
    const provider: EvmProvider = { request: async ({ method }) => { if (method === "personal_sign") throw Object.assign(new Error("User rejected"), { code: 4001 }); return ["0xabc0000000000000000000000000000000000001"]; } };
    const connected = await connectEvm({ id: "u", remember: "u", name: "T", icon: null, provider });
    await expect(connected!.sign("x")).rejects.toThrow("You declined the request");
  });
});

function solanaWallet(overrides: { tamper?: boolean } = {}) {
  const account = { address: base58Encode(publicKey), publicKey, features: ["solana:signMessage"] };
  const wallet = {
    name: "Test Sol", icon: "data:image/png;base64,AAAA", chains: ["solana:mainnet"], accounts: [] as { address: string; publicKey: Uint8Array; features: string[] }[],
    features: {
      "standard:connect": { connect: async () => { wallet.accounts = [account]; return { accounts: [account] }; } },
      "solana:signMessage": { signMessage: async ({ message }: { message: Uint8Array }) => {
        const signed = overrides.tamper ? new TextEncoder().encode("prefix") : message;
        return [{ signedMessage: signed, signature: new Uint8Array(sign(null, Buffer.from(message), key)) }];
      } },
    },
  };
  return wallet;
}

describe("Solana wallets", () => {
  it("finds a wallet that registers after the page, and one registered before it, under Wallet Standard", () => {
    window.addEventListener("wallet-standard:app-ready", event => { (event as CustomEvent).detail.register(solanaWallet()); });
    let found: SolanaWallet[] = [];
    const stop = watchSolanaWallets(wallets => { found = wallets; });
    expect(found.map(w => w.name)).toEqual(["Test Sol"]);
    const late = { ...solanaWallet(), name: "Late" };
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: { register: (w: unknown) => void }) => api.register(late) }));
    expect(found.map(w => w.name)).toEqual(["Test Sol", "Late"]);
    stop();
  });
  it("ignores a wallet that cannot sign messages", () => {
    const broken = solanaWallet();
    delete (broken.features as Record<string, unknown>)["solana:signMessage"];
    window.addEventListener("wallet-standard:app-ready", event => { (event as CustomEvent).detail.register(broken); });
    let found: SolanaWallet[] = [{ id: "x", remember: "x", name: "x", icon: null, wallet: broken }];
    watchSolanaWallets(wallets => { found = wallets; })();
    expect(found).toEqual([]);
  });
  it("uses the public key hex as the account and signs the UTF-8 payload so ed25519 verifies it", async () => {
    const entry: SolanaWallet = { id: "Test Sol", remember: "name:Test Sol", name: "Test Sol", icon: null, wallet: solanaWallet() };
    const connected = await connectSolana(entry);
    expect(connected?.account.account).toBe(Buffer.from(publicKey).toString("hex"));
    expect(connected?.account.account).toHaveLength(64);
    const payload = '{"signer_id":"x"}';
    const signed = await connected!.sign(payload);
    if (signed.standard !== "raw_ed25519") throw new Error("wrong standard");
    expect(signed.public_key).toBe(`ed25519:${base58Encode(publicKey)}`);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
    const rawSignature = Buffer.from(sign(null, Buffer.from(payload), key));
    expect(signed.signature).toBe(`ed25519:${base58Encode(rawSignature)}`);
    expect(verify(null, Buffer.from(payload), createPublicKey({ key: spki, format: "der", type: "spki" }), rawSignature)).toBe(true);
  });
  it("refuses a wallet that wraps the message in its own header", async () => {
    const connected = await connectSolana({ id: "t", remember: "t", name: "t", icon: null, wallet: solanaWallet({ tamper: true }) });
    await expect(connected!.sign("hello")).rejects.toThrow("changed the message");
  });
});

describe("hostile EVM providers", () => {
  const announce = (info: Record<string, unknown>, provider: EvmProvider) =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
  const watch = () => { let found: EvmWallet[] = []; const stop = watchEvmWallets(w => { found = w; }); return { get: () => found, stop }; };

  it("lists a wallet once when a second provider claims the same rdns", () => {
    const real = evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider;
    const fake = evmProvider("0xdef0000000000000000000000000000000000002", "0x").provider;
    const seen = watch();
    announce({ uuid: "u1", name: "MetaMask", icon: null, rdns: "io.metamask" }, real);
    announce({ uuid: "u2", name: "MetaMask", icon: null, rdns: "io.metamask" }, fake);
    expect(seen.get().map(w => w.provider)).toEqual([real]);
    seen.stop();
  });
  it("drops the window.ethereum row once any EIP-6963 wallet announced", () => {
    const injected = evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider;
    const other = evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider;
    (window as unknown as { ethereum: EvmProvider }).ethereum = injected;
    const seen = watch();
    announce({ uuid: "u1", name: "Rabby", icon: null, rdns: "io.rabby" }, other);
    expect(seen.get().map(w => w.name)).toEqual(["Rabby"]);
    seen.stop();
  });
  it("remembers a wallet by rdns, which survives a reload, not by its per-page uuid", () => {
    const seen = watch();
    announce({ uuid: "6f1c", name: "Rabby", icon: null, rdns: "io.rabby" }, evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider);
    expect(seen.get()[0].remember).toBe("rdns:io.rabby");
    seen.stop();
  });
  it("keeps only raster or svg data images as icons and drops script, remote and oversized ones", () => {
    const seen = watch();
    const icons = ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", " data:image/png;base64,AAAA", "data:image/png;base64," + "A".repeat(200_000), "data:image/svg+xml;base64,AAAA"];
    icons.forEach((icon, i) => announce({ uuid: `u${i}`, name: `W${i}`, icon, rdns: `w${i}.example` }, evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider));
    expect(seen.get().map(w => w.icon)).toEqual([null, null, null, null, "data:image/svg+xml;base64,AAAA"]);
    seen.stop();
  });
  it("strips direction overrides and control characters from a wallet name and caps its length", () => {
    const seen = watch();
    announce({ uuid: "u1", name: "Meta\u202eksaMat\u0000" + "x".repeat(80), icon: null, rdns: "a.b" }, evmProvider("0xabc0000000000000000000000000000000000001", "0x").provider);
    const name = seen.get()[0].name;
    expect(name.startsWith("MetaksaMat")).toBe(true);
    expect(name).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/);
    expect(name.length).toBeLessThanOrEqual(40);
    seen.stop();
  });
  it("names smart-contract wallets plainly when they return a signature that is not 65 bytes", async () => {
    const { provider } = evmProvider("0xabc0000000000000000000000000000000000001", `0x${"ab".repeat(300)}`);
    const connected = await connectEvm({ id: "u", remember: "u", name: "Safe", icon: null, provider });
    await expect(connected!.sign("x")).rejects.toThrow("Smart-contract wallets");
  });
  it("always sends personal_sign the hex of the UTF-8 text, even when the text itself looks like hex", async () => {
    const { provider, calls } = evmProvider("0xabc0000000000000000000000000000000000001", `0x${"11".repeat(64)}1b`);
    const connected = await connectEvm({ id: "u", remember: "u", name: "T", icon: null, provider });
    await connected!.sign("0xdeadbeef");
    expect(calls.find(c => c.method === "personal_sign")!.params![0]).toBe(`0x${Buffer.from("0xdeadbeef").toString("hex")}`);
  });
  it("reports an account switch in the wallet to whoever watches the connection", async () => {
    let listener: ((accounts: unknown) => void) | null = null;
    const provider = {
      request: async () => ["0xabc0000000000000000000000000000000000001"],
      on: (event: string, fn: (accounts: unknown) => void) => { if (event === "accountsChanged") listener = fn; },
      removeListener: () => { listener = null; },
    };
    const connected = await connectEvm({ id: "u", remember: "u", name: "T", icon: null, provider });
    let changed = 0;
    const stop = connected!.watch(() => changed++);
    listener!(["0xABC0000000000000000000000000000000000001"]);
    expect(changed).toBe(0);
    listener!(["0xdef0000000000000000000000000000000000002"]);
    expect(changed).toBe(1);
    stop();
    expect(listener).toBeNull();
  });
});

describe("hostile Solana wallets", () => {
  const otherSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
  const otherKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), otherSeed]), format: "der", type: "pkcs8" });

  it("refuses a signature that does not verify for the connected key", async () => {
    const wallet = solanaWallet();
    (wallet.features as Record<string, unknown>)["solana:signMessage"] = { signMessage: async ({ message }: { message: Uint8Array }) =>
      [{ signedMessage: message, signature: new Uint8Array(sign(null, Buffer.from(message), otherKey)) }] };
    const connected = await connectSolana({ id: "t", remember: "t", name: "t", icon: null, wallet });
    await expect(connected!.sign("hello")).rejects.toThrow("does not match");
  });
  it("refuses to sign after the wallet switched to another account", async () => {
    const wallet = solanaWallet();
    const connected = await connectSolana({ id: "t", remember: "t", name: "t", icon: null, wallet });
    (wallet as { accounts: unknown[] }).accounts = [{ address: "Other", publicKey: new Uint8Array(32), features: ["solana:signMessage"] }];
    await expect(connected!.sign("hello")).rejects.toThrow("account changed");
  });
  it("hears standard:events change and reports a switch away from the connected account", async () => {
    let listener: ((props: { accounts?: unknown[] }) => void) | null = null;
    const wallet = solanaWallet();
    (wallet.features as Record<string, unknown>)["standard:events"] = { on: (_: string, fn: typeof listener) => { listener = fn; return () => { listener = null; }; } };
    const connected = await connectSolana({ id: "t", remember: "t", name: "t", icon: null, wallet });
    let changed = 0;
    const stop = connected!.watch(() => changed++);
    listener!({ accounts: wallet.accounts });
    expect(changed).toBe(0);
    listener!({ accounts: [] });
    expect(changed).toBe(1);
    stop();
    expect(listener).toBeNull();
  });
  it("gives two wallets with the same name different ids and remembers neither as unique", () => {
    window.addEventListener("wallet-standard:app-ready", event => {
      const api = (event as CustomEvent).detail;
      api.register(solanaWallet());
      api.register(solanaWallet());
    });
    let found: SolanaWallet[] = [];
    watchSolanaWallets(wallets => { found = wallets; })();
    expect(found).toHaveLength(2);
    expect(found[0].id).not.toBe(found[1].id);
    expect(found[0].remember).toBe("name:Test Sol");
  });
});
