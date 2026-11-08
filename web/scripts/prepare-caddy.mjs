import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OPEN = "[[DM_CSP", CLOSE = "DM_CSP]]";
const action = (expression) => `${OPEN} ${expression} ${CLOSE}`;

// Wallet executors run in sandboxed srcdoc frames and use the connector's nonce
// API. They fetch their own HTTPS RPC/relay endpoints. Keep that transport
// compatibility without allowing arbitrary inline scripts or eval in the page.
export const policy = "default-src 'self'; script-src 'nonce-%s' 'strict-dynamic'; script-src-attr 'none'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; " +
  "connect-src 'self' https: wss:; frame-src 'self' https: hotwallet: intent: meteorwallet: meteorwalletdev: intear: near-mobile-wallet:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function prepareHtml(html) {
  // No request data or application text is ever interpreted as a template.
  // A separate delimiter prevents ordinary {{ examples }} from being evaluated.
  if (html.includes(OPEN) || html.includes(CLOSE)) throw new Error("Reserved Caddy template delimiter in exported HTML");
  const body = html.replace(/<(script|link)\b([^>]*)>/gi, (tag, name, attributes) => {
    if (name.toLowerCase() === "link" && !/\b(?:as="script"|rel="modulepreload")/i.test(attributes)) return tag;
    if (/\bnonce\s*=/i.test(attributes)) throw new Error("Export already has a script nonce");
    return `<${name} nonce="${action("$nonce")}"${attributes}>`;
  });
  if (!/^<!doctype html>/i.test(html)) throw new Error("Expected an exported HTML document");
  return action("$nonce := randAlphaNum 32") +
    action(`.RespHeader.Set "Content-Security-Policy" (printf ${JSON.stringify(policy)} $nonce)`) +
    action('.RespHeader.Set "Cache-Control" "no-store"') + body;
}

export async function prepareExport(input, output) {
  if (resolve(input) === resolve(output)) throw new Error("Keep the original static export separate");
  await rm(output, { recursive: true, force: true });
  await cp(input, output, { recursive: true });
  let count = 0;
  for (const name of await readdir(output, { recursive: true })) {
    if (!name.endsWith(".html")) continue;
    const path = resolve(output, name);
    await writeFile(path, prepareHtml(await readFile(path, "utf8")));
    count++;
  }
  if (!count) throw new Error("No exported HTML pages found");
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await prepareExport(new URL("../out/", import.meta.url).pathname,
    new URL("../out-caddy/", import.meta.url).pathname);
  console.log(`Prepared ${count} HTML pages for per-response Caddy nonces`);
}
