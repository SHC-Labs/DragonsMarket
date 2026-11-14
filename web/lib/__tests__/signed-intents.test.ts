import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "../base58";
import { actionPayload, encodeEd25519, encodeErc191, PAYLOAD_LIFETIME_MS, transferIntent, type IntentsContext } from "../signed-intents";
import { evmAccount, nearAccount, signsWithRelay, solanaAccount } from "../wallet-account";
import { cleanEvidence } from "../signed-intents";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Independent decoder (big integer arithmetic) so the encoder is not checked against itself.
function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const hex = n === 0n ? "" : n.toString(16).padStart(2 * Math.ceil(n.toString(16).length / 2), "0");
  const body = Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

const ctx: IntentsContext = { verifier: "intents.near", collateral: "nep141:usdc.near", relayer: "relayer.near", relayFee: 20_000n };
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("base58", () => {
  it("matches published vectors", () => {
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(base58Encode(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(base58Encode(new Uint8Array())).toBe("");
  });
  it("round trips 64 random-looking bytes through an independent decoder", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});

describe("payload building", () => {
  it("builds the action transfer then the fee transfer, in a fixed key order", () => {
    const payload = actionPayload(ctx, "0xabc0000000000000000000000000000000000001", { to: "market.near", amount: 5_000_000n, msg: "buy:7:yes:4900000" }, NOW, NONCE);
    expect(payload).toBe(
      '{"signer_id":"0xabc0000000000000000000000000000000000001","verifying_contract":"intents.near",'
      + '"deadline":"2026-11-10T12:05:00.000Z","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",'
      + '"intents":[{"intent":"transfer","receiver_id":"market.near","tokens":{"nep141:usdc.near":"5000000"},"msg":"buy:7:yes:4900000"},'
      + '{"intent":"transfer","receiver_id":"relayer.near","tokens":{"nep141:usdc.near":"20000"}}]}',
    );
    expect(Date.parse(JSON.parse(payload).deadline) - NOW).toBe(PAYLOAD_LIFETIME_MS);
  });

  it("makes a first trade two payloads, register before buy, each with its own fee", () => {
    const signer = "0xabc0000000000000000000000000000000000001";
    const [a, b] = [
      actionPayload(ctx, signer, { to: "market.near", amount: 1_000_000n, msg: "register" }, NOW, NONCE),
      actionPayload(ctx, signer, { to: "market.near", amount: 5_000_000n, msg: "buy:7:yes:1" }, NOW, NONCE),
    ].map(p => JSON.parse(p));
    expect(a.intents[0].msg).toBe("register");
    expect(a.intents[0].tokens).toEqual({ "nep141:usdc.near": "1000000" });
    expect(b.intents[0].msg).toBe("buy:7:yes:1");
    for (const p of [a, b]) expect(p.intents[1]).toEqual(transferIntent("relayer.near", "nep141:usdc.near", 20_000n));
  });

  it("refuses a payload longer than the relay accepts", () => {
    expect(() => actionPayload(ctx, "x", { to: "m", amount: 1n, msg: "e".repeat(2100) })).toThrow("too long");
  });
  it("gives every payload its own random 32-byte nonce", () => {
    const one = JSON.parse(actionPayload(ctx, "x", { to: "m", amount: 1n, msg: "m" })).nonce;
    const two = JSON.parse(actionPayload(ctx, "x", { to: "m", amount: 1n, msg: "m" })).nonce;
    expect(one).not.toBe(two);
    expect(atob(one)).toHaveLength(32);
  });
});

describe("payload rules the relay enforces", () => {
  afterEach(() => vi.unstubAllGlobals());
  const signer = "0xabc0000000000000000000000000000000000001";
  const build = (msg = "register", now = NOW) => actionPayload(ctx, signer, { to: "market.near", amount: 1n, msg }, now);

  it("never carries min_gas", () => {
    expect(build()).not.toContain("min_gas");
  });
  it("puts the deadline in Date.toISOString form, between 60 seconds and 10 minutes ahead", () => {
    const deadline: string = JSON.parse(build()).deadline;
    expect(new Date(deadline).toISOString()).toBe(deadline);
    const ahead = Date.parse(deadline) - NOW;
    expect(ahead).toBeGreaterThanOrEqual(60_000);
    expect(ahead).toBeLessThanOrEqual(10 * 60_000);
  });
  it("is byte-equal to JSON.stringify of its own parse, unicode and escapes included", () => {
    for (const msg of ["register", "propose:m:1:yes:caf\u00e9 \u{1F409} \"q\" \\ \u2028 </script>"]) {
      const payload = build(msg);
      expect(JSON.stringify(JSON.parse(payload))).toBe(payload);
    }
  });
  it("draws a fresh nonce when the random bytes start with the versioned prefix 5628f6c6", () => {
    const calls: number[][] = [];
    const prefixed = [0x56, 0x28, 0xf6, 0xc6];
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => {
      const first = calls.length === 0;
      calls.push([...bytes.subarray(0, 4)]);
      bytes.fill(7);
      if (first) bytes.set(prefixed);
      return bytes;
    } });
    const nonce = JSON.parse(build()).nonce;
    expect(Buffer.from(nonce, "base64").subarray(0, 4).toString("hex")).not.toBe("5628f6c6");
    expect(Buffer.from(nonce, "base64")).toHaveLength(32);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("erc191 signature encoding", () => {
  const rs = "11".repeat(32) + "22".repeat(32);
  const expected = (v: number) => `secp256k1:${base58Encode(Uint8Array.from([...Buffer.from(rs, "hex"), v]))}`;

  it("maps v 27 and 28 to 0 and 1 and prefixes the base58 of r, s, v", () => {
    expect(encodeErc191("p", `0x${rs}1b`)).toEqual({ standard: "erc191", payload: "p", signature: expected(0) });
    expect(encodeErc191("p", `0x${rs}1c`)).toEqual({ standard: "erc191", payload: "p", signature: expected(1) });
  });
  it("keeps a v that is already 0 or 1", () => {
    expect((encodeErc191("p", `0x${rs}00`) as { signature: string }).signature).toBe(expected(0));
    expect((encodeErc191("p", `0x${rs}01`) as { signature: string }).signature).toBe(expected(1));
  });
  it("decodes back to 65 bytes ending in the normalised v", () => {
    const decoded = base58Decode((encodeErc191("p", `0x${rs}1c`) as { signature: string }).signature.slice("secp256k1:".length));
    expect(decoded).toHaveLength(65);
    expect(decoded[64]).toBe(1);
    expect(Buffer.from(decoded.slice(0, 64)).toString("hex")).toBe(rs);
  });
  it("refuses a bad v or a wrong length", () => {
    expect(() => encodeErc191("p", `0x${rs}1d`)).toThrow();
    expect(() => encodeErc191("p", `0x${rs}`)).toThrow();
    expect(() => encodeErc191("p", "not a signature")).toThrow();
  });
});

describe("raw_ed25519 signature encoding", () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const publicKey = new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));

  it("produces a signature the verifier's algorithm accepts over the exact payload bytes", () => {
    const payload = actionPayload(ctx, "0".repeat(64), { to: "market.near", amount: 1n, msg: "buy:1:no:1" }, NOW, NONCE);
    const signature = new Uint8Array(sign(null, Buffer.from(payload), key));
    const multi = encodeEd25519(payload, publicKey, signature);
    if (multi.standard !== "raw_ed25519") throw new Error("wrong standard");
    expect(multi.payload).toBe(payload);
    expect(multi.public_key).toMatch(/^ed25519:/);
    expect(multi.signature).toMatch(/^ed25519:/);
    const decodedKey = base58Decode(multi.public_key.slice("ed25519:".length));
    const decodedSignature = base58Decode(multi.signature.slice("ed25519:".length));
    expect(decodedKey).toEqual(publicKey);
    expect(decodedSignature).toEqual(signature);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decodedKey]);
    const publicObject = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(verify(null, Buffer.from(multi.payload), publicObject, decodedSignature)).toBe(true);
  });
  it("refuses keys and signatures of the wrong size", () => {
    expect(() => encodeEd25519("p", new Uint8Array(31), new Uint8Array(64))).toThrow();
    expect(() => encodeEd25519("p", publicKey, new Uint8Array(63))).toThrow();
  });
});

describe("the account shape", () => {
  it("lowercases an EVM address and keeps the wallet's own spelling as the label", () => {
    expect(evmAccount("0xAbC0000000000000000000000000000000000001")).toEqual({ chain: "evm", account: "0xabc0000000000000000000000000000000000001", label: "0xAbC0000000000000000000000000000000000001" });
    expect(() => evmAccount("0x123")).toThrow();
  });
  it("uses the 64 hex characters of a Solana public key as the account", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(solanaAccount(key, "SomeBase58Address")).toEqual({ chain: "solana", account: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", label: "SomeBase58Address" });
    expect(() => solanaAccount(new Uint8Array(31), "x")).toThrow();
  });
  it("sends only EVM and Solana accounts through the relay", () => {
    expect(signsWithRelay(nearAccount("alice.near"))).toBe(false);
    expect(signsWithRelay(null)).toBe(false);
    expect(signsWithRelay(evmAccount("0xabc0000000000000000000000000000000000001"))).toBe(true);
  });
});

describe("evidence text in a signed proposal", () => {
  it("drops control characters the relay refuses and collapses whitespace", () => {
    expect(cleanEvidence("  see\tthis\u0007 \n https://x.example \u202e ")).toEqual({ text: "see this https://x.example", fits: true });
  });
  it("measures the limit in UTF-8 bytes like the relay, not in characters", () => {
    expect(cleanEvidence("\u{1F409}".repeat(128)).fits).toBe(true);
    expect(cleanEvidence("\u{1F409}".repeat(129)).fits).toBe(false);
  });
});
