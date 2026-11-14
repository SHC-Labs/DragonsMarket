// Phones have no wallet extensions. Each wallet app has its own browser, and a link of the right shape opens this page in it,
// where the wallet is injected like an extension.
//   Phantom          https://phantom.com/ul/browse/<url>?ref=<ref>, both URL-encoded (docs.phantom.com, read 2026-11-09).
//                    Android browsers often do not hand universal links to the app, so Android gets an intent:// link to the
//                    phantom scheme with the universal link as its fallback. The intent form is not in Phantom's docs.
//   Solflare         https://solflare.com/ul/v1/browse/<url>?ref=<ref>, both URL-encoded (docs.solflare.com, read 2026-11-09)
//   MetaMask         https://link.metamask.io/dapp/{dappUrl}
//   Trust Wallet     https://link.trustwallet.com/open_url?coin_id=60&url=<url>
//   Coinbase Wallet  https://go.cb-w.com/dapp?cb_url=<url>, percent-encoded
// The MetaMask, Trust and Coinbase formats could not be re-read in their current docs on 2026-11-09 (pages moved or no longer
// list them). All three are https links, so a wrong one opens a web page, never something on the phone.
// Rabby publishes no link of this kind, so it gets a copy-the-link hint instead.
export interface Device { mobile: boolean; android: boolean }

export interface DeepLink {
  id: "metamask" | "phantom" | "solflare" | "trust" | "coinbase";
  name: string;
  href: (page: string, device: Device) => string;
}

const enc = encodeURIComponent;
const originOf = (page: string) => new URL(page).origin;
const phantomUniversal = (page: string) => `https://phantom.com/ul/browse/${enc(page)}?ref=${enc(originOf(page))}`;

export const DEEP_LINKS: DeepLink[] = [
  { id: "metamask", name: "MetaMask", href: page => `https://link.metamask.io/dapp/${page.replace(/^https?:\/\//, "")}` },
  { id: "phantom", name: "Phantom", href: (page, device) => device.android
    ? `intent://browse/${enc(page)}?ref=${enc(originOf(page))}#Intent;scheme=phantom;package=app.phantom;S.browser_fallback_url=${enc(phantomUniversal(page))};end`
    : phantomUniversal(page) },
  { id: "solflare", name: "Solflare", href: page => `https://solflare.com/ul/v1/browse/${enc(page)}?ref=${enc(originOf(page))}` },
  { id: "trust", name: "Trust Wallet", href: page => `https://link.trustwallet.com/open_url?coin_id=60&url=${enc(page)}` },
  { id: "coinbase", name: "Coinbase Wallet", href: page => `https://go.cb-w.com/dapp?cb_url=${enc(page)}` },
];

// The page a deep link opens: this page on this origin, rebuilt from its parts so no fragment or credentials ride along.
// A path that starts with two slashes is collapsed, because the MetaMask form drops the scheme and "//host" would read as a host.
export function walletPage(location: { protocol: string; host: string; pathname: string; search: string }): string | null {
  if (location.protocol !== "https:" && location.protocol !== "http:") return null;
  return `${location.protocol}//${location.host}${location.pathname.replace(/^\/+/, "/")}${location.search}`;
}

// iPadOS reports a Mac user agent, so a coarse primary pointer also counts as a phone or tablet.
export function deviceOf(userAgent: string, coarsePointer: boolean): Device {
  const android = /Android/i.test(userAgent);
  return { mobile: android || /iPhone|iPad|iPod/i.test(userAgent) || coarsePointer, android };
}

// Wallet browsers inject these before the page runs. Checked at once, so the "Open in" links never flash while discovery runs.
const INJECTED = ["ethereum", "phantom", "solflare", "coinbaseWalletExtension"] as const;
export const insideWalletBrowser = (win: Record<string, unknown>) =>
  INJECTED.some(key => typeof win[key] === "object" && win[key] !== null);
