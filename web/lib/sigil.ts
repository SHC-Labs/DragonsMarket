// A unique emblem for each market, drawn from the rule fingerprint. Same fingerprint, same emblem, always.
// Pure functions here; components/Sigil.tsx draws the result.

export interface SigilSpec {
  rings: { r: number; dash: string; opacity: number }[];
  sides: number;
  polyR: number;
  rotation: number;
  spokes: number;
  dots: { x: number; y: number }[];
  primary: string;
  secondary: string;
  glow: { x: number; y: number };
}

const PRIMARY = ["var(--brand)", "var(--yes)", "var(--no)"];
const SECONDARY = ["var(--no)", "var(--text-muted)", "var(--brand)"];

// cyrb53: a small, well-mixed 53-bit string hash. Good enough to spread similar ids (same prefix) across a sigil.
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Short strings (an account id) get stretched into a stable 64-character hex digest so they can seed a sigil too.
export function seedHex(text: string): string {
  let out = "";
  for (let i = 0; i < 32; i++) out += (cyrb53(text, i) & 0xff).toString(16).padStart(2, "0");
  return out;
}

function bytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-f]/gi, "").padEnd(64, "0");
  const out: number[] = [];
  for (let i = 0; i < clean.length - 1; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

export function sigilSpec(hash: string): SigilSpec {
  const b = bytes(hash);
  const ringCount = 3 + (b[2] % 3);
  const rings = Array.from({ length: ringCount }, (_, i) => ({
    r: 14 + (i + 1) * (32 / (ringCount + 0.5)),
    dash: i % 2 === 0 ? "none" : `${2 + (b[4 + i] % 6)} ${3 + (b[8 + i] % 7)}`,
    opacity: 0.85 - i * 0.14,
  }));
  const dots = Array.from({ length: 5 }, (_, i) => {
    const angle = (b[10 + i] / 255) * Math.PI * 2;
    const r = rings[rings.length - 1].r;
    return { x: 50 + Math.cos(angle) * r, y: 50 + Math.sin(angle) * r };
  });
  return {
    rings,
    sides: 3 + (b[3] % 6),
    polyR: 24 + (b[5] % 12),
    rotation: (b[6] / 255) * 360,
    spokes: 2 + (b[7] % 5),
    dots,
    primary: PRIMARY[b[0] % 3],
    secondary: SECONDARY[(b[1] + (b[0] % 3 === b[1] % 3 ? 1 : 0)) % 3],
    glow: { x: 30 + (b[15] % 40), y: 30 + (b[16] % 40) },
  };
}

export function polygonPoints(sides: number, radius: number, rotationDeg: number): string {
  return Array.from({ length: sides }, (_, i) => {
    const a = ((rotationDeg + (360 / sides) * i) * Math.PI) / 180;
    return `${(50 + Math.cos(a) * radius).toFixed(2)},${(50 + Math.sin(a) * radius).toFixed(2)}`;
  }).join(" ");
}
