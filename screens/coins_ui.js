// Coin pieces other screens show: the "Coins" link on Home's balance, the line for a private
// (max-privacy) balance BEAM still holds back, a split in the payment lists, and one asset's
// coin list. The words are lib/coins.js's.
import { h, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, isPendingTx } from '../lib/wallet.js';
import { loadCoins, privateBalanceText, COIN_TEXT, coinStatusText, coinKind, splitStatusText } from '../lib/coins.js';
import { t } from '../lib/i18n.js';

/** Home's balance: one tap to the coins and Split coins. */
export function coinsLink(app) {
  return h('button', { class: 'btn btn-text btn-small coins-link', type: 'button', 'data-testid': 'open-coins', onclick: () => app.go('coins') }, h('span', { text: t('Coins') }), icon('chevron'));
}

// The coins behind a private balance, read once per change of the balances (get_utxo).
let cache = { session: null, sig: null, coins: null, loading: false };

const sigOf = (s) => [...s.totals].map(([id, tot]) => `${id}:${tot.maturing}:${tot.maturingMp || 0n}:${tot.available}`).join('|');

/** The private coins of assetId BEAM is holding back, or null until they are read. Each read re-renders through the wallet's change event. */
export function privateCoins(assetId) {
  const session = wallet.session;
  if (!session) return null;
  const sig = sigOf(wallet.state);
  if ((cache.session !== session || cache.sig !== sig) && !cache.loading) {
    cache = { ...cache, loading: true };
    loadCoins(session).then(
      (coins) => {
        cache = { session, sig, coins, loading: false };
        if (wallet.session === session) wallet.emit();
      },
      () => {
        // Not now: tried again when the balances change.
        cache = { session, sig, coins: cache.session === session ? cache.coins : null, loading: false };
      },
    );
  }
  if (cache.session !== session || !cache.coins) return null;
  const c = cache.coins.get(Number(assetId));
  return c ? c.privateMaturing : [];
}

/** The parts of a "maturing" amount for a one-line summary: regular coins, then private ones. */
export function maturingParts(tot, { withPrivate = true } = {}) {
  if (!tot || !(tot.maturing > 0n)) return [];
  const mp = tot.maturingMp || 0n;
  const regular = tot.maturing - mp;
  const out = [];
  if (regular > 0n) out.push(t('{amount} maturing', { amount: formatAmount(regular) }));
  if (withPrivate && mp > 0n) out.push(t('{amount} private, not yet spendable', { amount: formatAmount(mp) }));
  return out;
}

/** Under a balance: a private amount BEAM still holds back, and when it can be spent. One tap shows each coin. */
export function privateLine(app, s, assetId = 0, unit = null) {
  const tot = s.totals.get(Number(assetId));
  if (!tot || !(tot.maturingMp > 0n)) return null;
  const coins = privateCoins(assetId);
  const u = unit || wallet.label(assetId).unit;
  const height = s.status ? Number(s.status.current_height) : null;
  return h(
    'button',
    { class: 'private-line', type: 'button', 'data-testid': 'private-maturing', onclick: () => app.go('coins', { assetId: Number(assetId) }) },
    icon('shield'),
    h('span', { text: privateBalanceText(tot.maturingMp, u, coins, height) }),
    icon('chevron'),
  );
}

// ---------------------------------------------------------------- a split in the history

/** A split in Activity, on Home and on a token's page: what was split, and the fee (all that left). */
export function splitRow(app, tx, onclick) {
  const unit = wallet.label(tx.asset_id || 0).unit;
  const failed = Number(tx.status) === 4 || Number(tx.status) === 2;
  return h(
    'button',
    { class: 'row', onclick, 'data-txid': tx.txId, 'data-split': '1' },
    h('span', { class: `ico ${failed ? 'fail' : 'swap'}` }, icon(isPendingTx(tx) ? 'clock' : 'coins')),
    h('span', { class: 'main' }, h('div', { class: 't', text: splitStatusText(tx) }), h('div', { class: 's', text: `${fmtDate(tx.create_time)} · ${formatAmount(BigInt(tx.value || 0))} ${unit}` })),
    h('span', { class: 'end', text: `−${formatAmount(BigInt(tx.fee || 0))} BEAM` }), // i18n-ignore: an amount and the ticker
  );
}

/** A split's details (Activity's sheet). */
export function splitDetail(app, tx, close, kv) {
  const unit = wallet.label(tx.asset_id || 0).unit;
  return [
    h('h2', { 'data-testid': 'tx-detail-title', text: splitStatusText(tx) }),
    h('div', { class: 'big-amount', text: `${formatAmount(BigInt(tx.value || 0))} ${unit}` }),
    h(
      'div',
      { class: 'card' },
      kv(t('Status'), splitStatusText(tx)),
      kv(t('Date'), fmtDate(tx.create_time)),
      kv(t('What happened'), t('Split into new coins in this wallet')),
      kv(t('Network fee'), `${formatAmount(BigInt(tx.fee || 0))} BEAM`),
      tx.kernel && /[1-9a-f]/.test(tx.kernel) ? kv(t('Kernel ID'), `${tx.kernel.slice(0, 10)}…${tx.kernel.slice(-8)}`, { copy: tx.kernel }) : null,
      tx.failure_reason ? kv(t('Reason'), tx.failure_reason) : null, // failure_reason: the engine's own words
    ),
    h('p', { class: 'small', text: t('Nothing left your wallet but the network fee.') }),
    h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close')),
  ];
}

// ---------------------------------------------------------------- one asset's coins

/** Each coin of one asset: what it holds, its kind (private, change), and whether it can be spent now. */
export function coinList(summary, symbol, height) {
  const rows = [...summary.available, ...summary.locked];
  const anyPrivate = rows.some((c) => c.shielded);
  return [
    h('p', { class: 'section-title', 'data-testid': 'coin-list-title', text: COIN_TEXT.title(symbol) }),
    rows.length
      ? h(
          'div',
          { class: 'card list coin-list', 'data-testid': 'coin-list' },
          h('p', { class: 'small coin-summary', 'data-testid': 'coin-list-summary', text: COIN_TEXT.summary(summary) }),
          ...rows.map((c) => {
            const kind = coinKind(c);
            return h(
              'div',
              { class: `row coin-row${c.status === 'available' ? '' : ' waiting'}`, 'data-testid': 'coin-row', 'data-type': c.type, 'data-status': c.status },
              h('span', { class: `ico${c.shielded ? ' private' : ''}` }, icon(c.shielded ? 'shield' : c.status === 'available' ? 'coins' : 'clock')),
              h(
                'span',
                { class: 'main' },
                h('div', { class: 't' }, h('span', { text: `${c.exact ? '' : '≈ '}${formatAmount(c.amount)} ${symbol}` }), kind ? h('span', { class: `tag coin-tag${c.shielded ? ' private' : ''}`, text: kind }) : null),
                h('div', { class: 's wrap', 'data-testid': 'coin-status', text: coinStatusText(c, height) }),
              ),
            );
          }),
        )
      : h('div', { class: 'card empty', 'data-testid': 'coin-list-empty' }, icon('coins'), h('p', { text: t(COIN_TEXT.empty) })),
    rows.length ? h('p', { class: 'small', text: t(COIN_TEXT.note) }) : null,
    anyPrivate ? h('p', { class: 'small', 'data-testid': 'coin-private-note', text: COIN_TEXT.privateNote() }) : null,
  ];
}
