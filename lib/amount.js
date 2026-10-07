// Amounts. BEAM and every Confidential Asset have 8 decimals; the engine
// speaks groth (1 BEAM = 100,000,000 groth). Everything here is BigInt, so
// there are no float errors anywhere between what the user types and what
// tx_send receives.

export const DECIMALS = 8;
export const GROTH_PER_COIN = 100000000n;
export const REGULAR_FEE = 100000n; // 0.001 BEAM
export const OFFLINE_FEE = 1100000n; // 0.011 BEAM (offline, max-privacy, public-offline)
// tx_send takes a JSON number, so an amount must stay exactly representable.
export const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class AmountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parses what a person typed into groth.
 * Accepts "1", "1.5", "1,5" (comma as the decimal mark), ".5", spaces
 * (including thin and no-break spaces) as group separators.
 * Rejects: empty, negative, letters, two decimal marks, more than 8 decimals.
 */
export function parseAmount(input) {
  if (typeof input !== 'string') throw new AmountError('empty', 'Enter an amount.');
  let s = input.replace(/[\s   ]/g, '');
  if (s === '') throw new AmountError('empty', 'Enter an amount.');
  if (s.startsWith('-')) throw new AmountError('negative', 'The amount must be more than zero.');
  const marks = s.match(/[.,]/g) || [];
  if (marks.length > 1) throw new AmountError('format', 'Use one decimal mark, like 1.25');
  s = s.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) throw new AmountError('format', 'Only digits and one decimal mark, like 1.25');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > DECIMALS) throw new AmountError('precision', 'BEAM has 8 decimal places at most.');
  const groth = BigInt(whole || '0') * GROTH_PER_COIN + BigInt((frac + '00000000').slice(0, DECIMALS) || '0');
  if (groth > MAX_SAFE) throw new AmountError('too_large', 'That amount is too large.');
  return groth;
}

/** groth → "1,234.5" (trailing zeros dropped, grouped thousands). */
export function formatAmount(groth, { group = true, minDecimals = 0, maxDecimals = DECIMALS } = {}) {
  let g = BigInt(groth);
  const neg = g < 0n;
  if (neg) g = -g;
  let whole = (g / GROTH_PER_COIN).toString();
  let frac = (g % GROTH_PER_COIN).toString().padStart(DECIMALS, '0');
  if (maxDecimals < DECIMALS) {
    // round half up to maxDecimals
    const cut = DECIMALS - maxDecimals;
    const unit = 10n ** BigInt(cut);
    let rounded = (g + unit / 2n) / unit; // in units of 10^-maxDecimals
    const base = 10n ** BigInt(maxDecimals);
    whole = (rounded / base).toString();
    frac = maxDecimals ? (rounded % base).toString().padStart(maxDecimals, '0') : '';
  }
  frac = frac.replace(/0+$/, '');
  while (frac.length < minDecimals) frac += '0';
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** groth → the plain decimal string an input field can hold ("1234.5"). */
export function toInputString(groth) {
  return formatAmount(groth, { group: false });
}

/** Parses an engine number or *_str field into BigInt groth. */
export function toGroth(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new AmountError('format', 'bad amount from wallet');
    return BigInt(v);
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new AmountError('format', 'bad amount from wallet');
}

/** The JSON number tx_send wants. */
export function toJsonNumber(groth) {
  if (groth < 0n || groth > MAX_SAFE) throw new AmountError('too_large', 'That amount is too large.');
  return Number(groth);
}
