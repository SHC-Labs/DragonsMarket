export const U64_MAX = 18446744073709551615n;
export const U128_MAX = 2n ** 128n - 1n;

/** A base58 NEAR block, receipt or transaction hash. */
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
/** A NEAR account id, as the chain defines it. */
export const isAccount = (value: unknown): value is string => typeof value === 'string' && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
/** A decimal string holding a u64, with no sign, no leading zeros and no exponent. */
export const isUint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 20 && BigInt(value) <= U64_MAX;
export const isUnits = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 39 && BigInt(value) <= U128_MAX;
