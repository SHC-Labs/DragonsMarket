import { describe, expect, it } from "vitest";
import { DEEP_LINKS, deviceOf, insideWalletBrowser, walletPage } from "../deep-links";

const page = "https://dragons.example/market?id=7&side=yes";
const iphone = { mobile: true, android: false };
const android = { mobile: true, android: true };
const link = (id: string, device = iphone) => DEEP_LINKS.find(l => l.id === id)!.href(page, device);
const loc = (href: string) => { const u = new URL(href); return { protocol: u.protocol, host: u.host, pathname: u.pathname, search: u.search }; };

describe("phone wallet deep links", () => {
  it("opens the page in MetaMask with the scheme dropped", () => {
    expect(link("metamask")).toBe("https://link.metamask.io/dapp/dragons.example/market?id=7&side=yes");
  });
  it("opens the page in Phantom with url and ref both encoded, on the phantom.com domain its docs give", () => {
    expect(link("phantom")).toBe("https://phantom.com/ul/browse/https%3A%2F%2Fdragons.example%2Fmarket%3Fid%3D7%26side%3Dyes?ref=https%3A%2F%2Fdragons.example");
  });
  it("opens Phantom on Android through an intent that falls back to the universal link", () => {
    const universal = link("phantom");
    expect(link("phantom", android)).toBe("intent://browse/https%3A%2F%2Fdragons.example%2Fmarket%3Fid%3D7%26side%3Dyes?ref=https%3A%2F%2Fdragons.example"
      + `#Intent;scheme=phantom;package=app.phantom;S.browser_fallback_url=${encodeURIComponent(universal)};end`);
  });
  it("opens the page in Solflare with the v1 browse path", () => {
    expect(link("solflare")).toBe("https://solflare.com/ul/v1/browse/https%3A%2F%2Fdragons.example%2Fmarket%3Fid%3D7%26side%3Dyes?ref=https%3A%2F%2Fdragons.example");
  });
  it("opens the page in Trust Wallet on the EVM coin", () => {
    expect(link("trust")).toBe("https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fdragons.example%2Fmarket%3Fid%3D7%26side%3Dyes");
  });
  it("opens the page in Coinbase Wallet with the url encoded", () => {
    expect(link("coinbase")).toBe("https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fdragons.example%2Fmarket%3Fid%3D7%26side%3Dyes");
  });
  it("offers these five and no Rabby link", () => {
    expect(DEEP_LINKS.map(l => l.name)).toEqual(["MetaMask", "Phantom", "Solflare", "Trust Wallet", "Coinbase Wallet"]);
  });
});

describe("the page a deep link opens", () => {
  it("is this page on this origin, without the fragment or any credentials", () => {
    expect(walletPage(loc("https://user:pw@dragons.example/market?id=7#top"))).toBe("https://dragons.example/market?id=7");
  });
  it("cannot be steered to another host by a crafted path or query", () => {
    for (const href of ["https://dragons.example//evil.example/x", "https://dragons.example/market?next=https://evil.example", "https://dragons.example/@evil.example", "https://dragons.example/%2F%2Fevil.example"]) {
      const target = walletPage(loc(href))!;
      expect(new URL(target).host, href).toBe("dragons.example");
      for (const l of DEEP_LINKS) {
        for (const device of [iphone, android]) {
          const out = l.href(target, device);
          const host = out.startsWith("intent://") ? null : new URL(out).host;
          if (host) expect(["link.metamask.io", "phantom.com", "solflare.com", "link.trustwallet.com", "go.cb-w.com"]).toContain(host);
          const embedded = decodeURIComponent(out.match(/(?:browse\/|url=|cb_url=)([^?&#]+)/)?.[1] ?? "") || `https://${out.split("/dapp/")[1]}`;
          expect(new URL(embedded).host, `${l.id} ${href}`).toBe("dragons.example");
        }
      }
    }
  });
  it("is refused for anything but http and https", () => {
    expect(walletPage({ protocol: "file:", host: "", pathname: "/x", search: "" })).toBeNull();
    expect(walletPage({ protocol: "javascript:", host: "", pathname: "alert(1)", search: "" })).toBeNull();
  });
});

describe("devices", () => {
  it("tells phones from desktops, and counts an iPad that reports a Mac user agent as a phone by its coarse pointer", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", true)).toEqual({ mobile: true, android: false });
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8)", true)).toEqual({ mobile: true, android: true });
    expect(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", true)).toEqual({ mobile: true, android: false });
    expect(deviceOf("Mozilla/5.0 (X11; Linux x86_64) Chrome/130", false)).toEqual({ mobile: false, android: false });
  });
  it("knows it is already inside a wallet's browser from any injected wallet global, with no wait", () => {
    expect(insideWalletBrowser({})).toBe(false);
    for (const key of ["ethereum", "phantom", "solflare", "coinbaseWalletExtension"]) expect(insideWalletBrowser({ [key]: {} }), key).toBe(true);
    expect(insideWalletBrowser({ ethereum: null })).toBe(false);
  });
});
