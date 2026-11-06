export class UnitsError extends Error {}

const AMOUNT = /^(\d{1,30})(?:\.(\d{1,38}))?$/;

export function toUnits(amount: string, decimals: number): string {
  const match = AMOUNT.exec(amount);
  const fraction = match?.[2] ?? '';
  if (!match || fraction.length > decimals) {
    throw new UnitsError(`Amounts are decimals with at most ${decimals} places, such as 5 or 2.5.`);
  }
  const units = BigInt(`${match[1]}${fraction.padEnd(decimals, '0')}`);
  if (units === 0n) throw new UnitsError('The amount must be more than zero.');
  return units.toString();
}

export function fromUnits(units: unknown, decimals: number): string | null {
  if (typeof units !== 'string' || !/^\d{1,39}$/.test(units)) return null;
  const padded = units.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
