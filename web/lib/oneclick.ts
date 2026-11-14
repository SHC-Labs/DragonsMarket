import { UserFacingError } from "./errors";

export const ONECLICK_URL = "https://1click.chaindefuser.com/v0";

export async function readOneClickResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty swap service response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024) throw new Error("Swap service response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function oneClick(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${ONECLICK_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(15_000), redirect: "error", credentials: "omit", cache: "no-store",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UserFacingError(response.status === 401 || response.status === 403
      ? "The swap service refused access. Keep this request and check its status before trying again."
      : "The swap service could not confirm this request. Check its status before trying again.");
  }
  return readOneClickResponse(response);
}
