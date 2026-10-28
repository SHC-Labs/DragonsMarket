const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text: string): Buffer {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) throw new Error('invalid_base58');
  let value = 0n;
  for (const c of text) value = value * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes: number[] = [];
  while (value) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  while (value) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
