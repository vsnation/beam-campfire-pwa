// The rules behind Home's token list, the token page and the total: which
// tokens show, what they are worth, which payments belong to a token, and the
// tokens the person hid. Pure (no DOM, no engine): test/unit/tokens.test.mjs.
//
// Ports of the desktop app's
//   lib/wallets/beam/assets/beam_hidden_assets.dart   (the hidden list),
//   lib/wallets/beam/assets/beam_asset_holdings.dart  (holdings and their value),
//   lib/widgets/beam/wallet_home/beam_home_text.dart  (BeamHomeText.portfolio: the total),
//   lib/wallets/beam/assets/beam_asset_text.dart      (beamEstimate, the value wording).

import { isContractTx, contractMoves } from './wallet.js';
import { formatAmount } from './amount.js';
import { t, tn, tk } from './i18n.js';

// ------------------------------------------------------------ hidden tokens

/**
 * The hidden list as stored (lib/hidden_tokens.js, per wallet): ids of tokens the person hid
 * from Home (spam airdrops, dust). Anything that is not a positive whole number
 * is ignored: BEAM (0) is the wallet itself and is never hidden.
 */
export function parseHidden(json) {
  if (!Array.isArray(json)) return [];
  return [...new Set(json.filter((e) => Number.isSafeInteger(e) && e > 0))].sort((a, b) => a - b);
}

/** The list with `assetId` hidden or shown again; unchanged for BEAM or nonsense. */
export function withHidden(list, assetId, hidden) {
  const ids = new Set(parseHidden(list));
  const id = Number(assetId);
  if (!Number.isSafeInteger(id) || id <= 0) return parseHidden(list);
  if (hidden) ids.add(id);
  else ids.delete(id);
  return [...ids].sort((a, b) => a - b);
}

// ------------------------------------------------------------ holdings

const ZERO = Object.freeze({ available: 0n, receiving: 0n, sending: 0n, maturing: 0n });

/** What the wallet has of an asset: available + receiving + maturing (sending is leaving). */
export const heldTotal = (tot) => (tot ? tot.available + tot.receiving + tot.maturing : 0n);

/** Anything at all of it: available, on its way in or out, or maturing. */
export const holdsAny = (tot) => Boolean(tot) && (tot.available > 0n || tot.receiving > 0n || tot.sending > 0n || tot.maturing > 0n);

/**
 * Every token (not BEAM) the wallet has anything of, in Home's order: verified
 * first (an LP token of two verified assets counts as verified), then by number.
 * Each: { id, totals, total, hidden, value (groth or null), sale }.
 * `label(id)` is the wallet's live label; `pricer` a lib/pricer.js AssetPricer or null.
 */
export function holdings(totals, { label, hidden = new Set(), pricer = null } = {}) {
  const out = [];
  for (const [id, tot] of totals || []) {
    if (Number(id) === 0 || !holdsAny(tot)) continue;
    const total = heldTotal(tot);
    const value = pricer ? pricer.valueInGroth(id, total) : null;
    out.push({ id: Number(id), totals: tot, total, hidden: hidden.has(Number(id)), value, sale: value != null && Boolean(pricer) && pricer.isSaleValue(id) });
  }
  const verified = (h) => Boolean(label && label(h.id).verified);
  return out.sort((a, b) => (verified(a) === verified(b) ? a.id - b.id : verified(a) ? -1 : 1));
}

/**
 * The total across BEAM and the tokens not hidden (BeamHomeText.portfolio):
 *   null                          no token held (nothing to add to BEAM)
 *   { tokens, priced: false }     prices not read yet, or no held token has a price
 *   { tokens, priced: true, totalGroth, beamGroth, unpriced }
 * `tokens` counts the visible tokens with a balance; `unpriced` those with no price
 * (left out of the total, never counted as 0).
 */
export function portfolio(totals, { hidden = new Set(), pricer = null } = {}) {
  const held = new Map();
  for (const [id, tot] of totals || []) {
    const n = Number(id);
    if (n === 0 || hidden.has(n)) continue;
    const total = heldTotal(tot);
    if (total > 0n) held.set(n, total);
  }
  if (!held.size) return null;
  const tokens = held.size;
  if (!pricer) return { tokens, priced: false, unpriced: 0 };
  const beam = heldTotal((totals && totals.get(0)) || ZERO);
  const v = pricer.portfolio(new Map([[0, beam], ...held]));
  const unpriced = v.unpriced.filter((id) => id !== 0).length;
  if (tokens - unpriced === 0) return { tokens, priced: false, unpriced };
  return { tokens, priced: true, totalGroth: v.totalGroth, beamGroth: beam, unpriced };
}

// ------------------------------------------------------------ history

/** Whether a payment or contract call moved `assetId` (a swap paying FOMO for BEAM moved both). */
export function txMovesAsset(tx, assetId) {
  const id = Number(assetId);
  if (isContractTx(tx)) {
    const m = contractMoves(tx);
    return m.spends.some((a) => a.assetId === id) || m.receives.some((a) => a.assetId === id);
  }
  return Number(tx.asset_id || 0) === id;
}

/**
 * The wallet's recent list (kept fresh by lib/wallet.js) with an older, longer read of it:
 * one entry per txId, the recent one winning (its status is newer).
 */
export function mergeTxs(recent, older) {
  const seen = new Set((recent || []).map((tx) => tx.txId));
  return [...(recent || []), ...(older || []).filter((tx) => !seen.has(tx.txId))];
}

/** A token's own history: its payments and the contract calls that moved it, newest first. */
export function tokenHistory(txs, assetId) {
  return (txs || []).filter((tx) => txMovesAsset(tx, assetId)).sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
}

// ------------------------------------------------------------ words

/**
 * "≈ 3.214 BEAM": a DEX estimate rounded down to what a person reads: 2
 * decimals from 100 BEAM, 3 from 1, 4 below; "< 0.0001 BEAM" for less (BeamAssetText.beamEstimate).
 */
export function beamEstimate(groth) {
  const g = BigInt(groth);
  if (g <= 0n) return '0 BEAM';
  const places = g >= 100n * 100000000n ? 2 : g >= 100000000n ? 3 : 4;
  const step = 10n ** BigInt(8 - places);
  const rounded = (g / step) * step;
  if (rounded === 0n) return '< 0.0001 BEAM';
  return `≈ ${formatAmount(rounded)} BEAM`;
}

/** An unverified asset's value is what its pool would pay: "≈ 12.5 BEAM if sold now". */
export const valueEstimate = (groth, sale) => (sale ? t('{amount} if sold now', { amount: beamEstimate(groth) }) : beamEstimate(groth));

// Shown with t(NO_PRICE).
export const NO_PRICE = tk('No price');

/** "3 tokens" / "1 token". */
export const tokensWord = (n) => tn({ one: '{n} token', other: '{n} tokens' }, n);

