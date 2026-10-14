// What the DEX pool screens share: names, badges, prices, the liquidity service
// for this session, and the words for what went wrong.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { assetBadge } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { VERIFIED, copyWarning } from '../lib/meta.js';
import { KINDS } from '../lib/dex.js';
import { dexApp } from '../lib/dex_pools.js';
import { createLiquidity, ratioText } from '../lib/dex_liquidity.js';
import { t } from '../lib/i18n.js';

/** Campfire's own list decides what is "verified" for pricing (as the desktop's pricer). */
export const isVerified = (id) => Boolean(VERIFIED[Number(id)]);

/** The ticker as money is written: "FOMO", "PEPE #94", "BEAM/FOMO LP". */
export const unit = (id) => wallet.label(id).unit;

/** One side of a pool's name: an LP token's pair goes in brackets. */
export const sideName = (id) => {
  const l = wallet.label(id);
  return l.pool ? `(${l.label})` : l.unit;
};

/** "BEAM / FOMO" (or "BEAM/FOMO" with sep '/'). */
export const pairName = (p, sep = ' / ') => `${sideName(p.aid1)}${sep}${sideName(p.aid2)}`;

/** "1%". */
export const feePercent = (kind) => (KINDS[kind] ? KINDS[kind].percent : '?');

/** "1% fee". */
export const feeText = (kind) => t('{percent} fee', { percent: feePercent(kind) });

/** The pool's two icons in one badge. */
export const pairBadge = (p, size = '') => assetBadge({ id: -1, pool: { aid1: p.aid1, aid2: p.aid2 } }, { size });

/** "1 BEAM ≈ 8.1443 FOMO", or the other way round. */
export function rateText(p, flipped = false) {
  const [base, quote, rb, rq] = flipped ? [p.aid2, p.aid1, p.tok2, p.tok1] : [p.aid1, p.aid2, p.tok1, p.tok2];
  if (rb <= 0n || rq <= 0n) return t('No price yet');
  return `1 ${unit(base)} ≈ ${ratioText(rq, rb)} ${unit(quote)}`;
}

/** The red line under a side that copies a verified asset's name. */
export function sideWarnings(p) {
  return [p.aid1, p.aid2]
    .map((id) => copyWarning(wallet.label(id)))
    .filter(Boolean)
    .map((w) => h('span', { class: 'warn-line', 'data-testid': 'pool-copy-warning', text: w }));
}

/** A tap target that flips a price. */
export function flipButton(p, { testid = 'pool-rate', cls = 'pool-rate', start = false, onFlip = null } = {}) {
  let flipped = start;
  const text = h('span', { text: rateText(p, flipped) });
  const btn = h(
    'button',
    {
      class: cls,
      type: 'button',
      'data-testid': testid,
      'aria-label': t('Price, tap to show it the other way round'),
      onclick: () => {
        flipped = !flipped;
        text.textContent = rateText(p, flipped);
        btn.dataset.flipped = String(flipped);
        if (onFlip) onFlip(flipped);
      },
    },
    text,
    icon('swap'),
  );
  btn.dataset.flipped = String(flipped);
  return btn;
}

/** A pool's key for app.go('pool', ...). */
export const poolParams = (p, extra = {}) => ({ aid1: p.aid1, aid2: p.aid2, kind: p.kind, ...extra });

let current = { session: null, liq: null };

/** Liquidity over the running wallet's own app and the pinned AMM shader (one per session). */
export function liquidity() {
  if (!current.liq || current.session !== wallet.session) {
    current = {
      session: wallet.session,
      liq: createLiquidity({
        view: async (args) => {
          const { app, shader } = await dexApp();
          return app.view(args, shader);
        },
        transact: async (args, opts) => {
          const { app, shader } = await dexApp();
          return app.transact(args, shader, opts);
        },
      }),
    };
  }
  return current.liq;
}

/** Plain words for whatever stopped a pool move or its quote. Never the person's fault. */
export function problemText(e, { action = 'add' } = {}) {
  const code = e && e.code;
  switch (code) {
    case 'rejected':
      return t('Cancelled. Nothing was sent.');
    case 'priceMoved':
      return t('{reason} Here are the new amounts.', { reason: String(e.message) });
    case 'timeout':
      return t('The wallet did not answer in time. Check Activity before trying again.');
    case 'ratioMismatch':
      return t("Those amounts do not match the pool's price. Type one side and the other is filled in for you.");
    case 'needBoth':
      return t('This pool is empty: enter both amounts. They set its starting price.');
    case 'noPool':
      return t('This pool is not on the DEX yet. A pool just created shows up once the network confirms it.');
    case 'poolEmpty':
      return t('This pool is empty right now.');
    case 'poolExists':
      return t('This pool already exists. Open it from the pools list and add your coins there.');
    case 'tooSmall':
      return action === 'withdraw' ? t('That is too little to take out: one of the coins would come back as nothing. Take out more.') : t('That amount is too small for this pool. Enter a larger amount.');
    case 'busy':
    case 'unexpected':
      return e.message;
    case 'shader':
      // The DEX's own words, as its shader printed them.
      return t('The DEX would not do this. It said: "{reason}". Nothing was sent.', { reason: String(e.message) });
    case 'load':
    case 'mismatch':
      return e.message;
    default: {
      // The wallet's own words: a sentence (with its full stop) or a short reason.
      const m = (e && e.message) || '';
      const reason = String((e && e.message) || e);
      return /\.$/.test(m) ? t('It was not sent: {reason} Nothing left your wallet.', { reason }) : t('It was not sent: {reason}. Nothing left your wallet.', { reason });
    }
  }
}

/**
 * Words for a failed read (pools, a quote): what happened, and that it is not the person's doing.
 * what: 'pool' (one pool), 'exist' (which pools exist) or 'pools' (the pools list, which says
 * "Couldn't load the pools." in bold before these words).
 */
export function readProblemText(e, what) {
  if (e && (e.code === 'load' || e.code === 'mismatch')) return e.message;
  const late = Boolean(e && e.code === 'timeout');
  const reason = String((e && e.message) || e);
  if (what === 'pool') return late ? t("Couldn't load the pool: the wallet didn't answer in time. This is not something you did.") : t("Couldn't load the pool: {reason}. This is not something you did.", { reason });
  if (what === 'exist') return late ? t("Couldn't check which pools exist: the wallet didn't answer in time. This is not something you did.") : t("Couldn't check which pools exist: {reason}. This is not something you did.", { reason });
  return late ? t("the wallet didn't answer in time. This is not something you did.") : t('{reason}. This is not something you did.', { reason });
}
