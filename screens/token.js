/* A token's page (FOMO, BEAM/FOMO LP, PEPE #94...)
 * Spec: ONE job: how much of this token do I have, what is it worth, what happened to it, and move it.
 *       Primary CTA: "Send" with the token chosen (nothing of it available yet: "Receive"); Swap beside them,
 *       or the token's pool for a DEX liquidity token.
 *       Taps from app open: 1 (the token on Home), 2 to its Send.
 * Exit-intent reasons and answers:
 *   - "Is this the real FOMO?" -> verified tokens say so; any other says it is unverified, with its number,
 *     and a copy of a verified token carries the red warning naming the real one.
 *   - "What is it worth?" -> BEAM's DEX estimate, labelled as one ("if sold now" for a token anyone could
 *     price), in dollars once allowed; "No price" when no pool values it, never 0.
 *   - "Where did my payment go?" -> this token's own history: its payments and the contract calls (swaps,
 *     pool moves, claims) that moved it, newest first; tap one for its details, as in Activity.
 *   - "Why can't I send it?" -> the reason is written under the buttons.
 *   - "This is spam" -> "Hide from Wallet": gone from Home and the total, kept in the wallet, one tap back.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, assetBadge, primary, secondary, textButton, notice, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { tokenSubtitle, copyWarning } from '../lib/meta.js';
import { KINDS, tradable } from '../lib/dex.js';
import { heldTotal, tokenHistory, mergeTxs, valueEstimate } from '../lib/tokens.js';
import { fiatEstimate } from '../lib/fiat.js';
import { marketPricer, marketPools, marketError, refreshMarket } from '../lib/token_market.js';
import { hiddenIds, setTokenHidden, loadHidden } from '../lib/hidden_tokens.js';
import { priceNow } from './token_ui.js';
import { txRow } from './home.js';
import activity from './activity.js';
import { privateLine } from './coins_ui.js';
import { syncReason } from '../lib/sync.js';
import { t, tn } from '../lib/i18n.js';

const ZERO = { available: 0n, receiving: 0n, sending: 0n, maturing: 0n };

/** The page's title: an unverified token always carries its number, so a copy never titles itself like the real one. */
export function tokenTitle(l) {
  if (l.verified || l.pool || l.name.includes(`#${l.id}`)) return l.name;
  return `${l.name} #${l.id}`;
}

/** What the token is, under its name: verified, a pool share, or unverified with its number. */
export function tokenNote(l) {
  if (l.pool) {
    const pair = l.name.replace(/ LP$/, '');
    const k = KINDS[l.pool.kind];
    return k ? t('Your share of the {pair} pool ({fee} fee).', { pair, fee: k.percent }) : t('Your share of the {pair} pool.', { pair });
  }
  if (l.verified) return t('Verified asset #{id}.', { id: l.id });
  return t('Unverified asset #{id}. Anyone can create an asset with any name; check the number with the sender.', { id: l.id });
}

/** How many payments lib/wallet.js keeps (its tx_list count): a list this long may be cut short. */
const RECENT = 100;
/** How far back the token page reads when the wallet's list is cut short. */
const OLDER = 2000;
// That read, kept a minute for this session: moving between token pages reads it once.
let olderCache = { session: null, at: 0, txs: null };

/**
 * A payment's details over this page, exactly as Activity shows them: Activity's own sheet, opened
 * by its txId and built at once. A payment older than the wallet's recent list is put in it for
 * that moment only, so the sheet finds it.
 */
function openTxDetail(app, tx) {
  const saved = wallet.state.txs;
  if (!saved.some((x) => x.txId === tx.txId)) wallet.state.txs = [...saved, tx];
  try {
    const view = activity(app, { txId: tx.txId });
    if (view && view.destroy) view.destroy();
  } finally {
    wallet.state.txs = saved;
  }
}

export default function token(app, params = {}) {
  const id = Number(params.assetId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    queueMicrotask(() => app.go('home', {}, { replace: true }));
    return { el: screen({ title: '', back: () => app.back('home') }) };
  }
  const head = h('div', { class: 'card token-head', 'data-testid': 'token-head' });
  const actions = h('div', { class: 'token-actions' });
  const breakdown = h('div', { class: 'card flat token-balances', 'data-testid': 'token-balances' });
  const history = h('div');
  const hideBox = h('div', { class: 'token-hide' });
  const titleEl = h('h1');
  // The wallet keeps its latest 100 payments; a token's older ones are read once, here.
  let older = null;
  let olderState = 'idle'; // idle | loading | done | failed

  async function loadOlder() {
    const session = wallet.session;
    if (!session || olderState !== 'idle') return;
    if (olderCache.session === session && Date.now() - olderCache.at < 60000) {
      // Read a moment ago (another token's page): the render that asked goes on with it.
      older = olderCache.txs;
      olderState = 'done';
      return;
    }
    olderState = 'loading';
    try {
      const txs = await session.call('tx_list', { count: OLDER, skip: 0 }, { timeoutMs: 60000 });
      olderCache = { session, at: Date.now(), txs: (Array.isArray(txs) ? txs : []).filter((x) => [0, 7, 12].includes(Number(x.tx_type))) };
      older = olderCache.txs;
      olderState = 'done';
    } catch {
      olderState = 'failed';
    }
    if (alive) render(wallet.state);
  }
  let alive = true;

  function valueLine(s, total, available) {
    const pricer = marketPricer();
    if (!pricer) {
      if (s.sync.state !== 'synced') return t('Prices load once the wallet is up to date.');
      return marketError() ? t('Prices could not be read from the DEX. They are tried again shortly.') : t('Getting the price from the DEX…');
    }
    const v = pricer.valueInGroth(id, total);
    // Begins like NO_PRICE (lib/tokens.js), as one sentence.
    if (v == null) return t('No price: no DEX pool with enough BEAM values it.');
    const sale = pricer.isSaleValue(id);
    const money = fiatEstimate(v, priceNow(app));
    // Valued like the desktop: everything held, so what is still arriving or maturing counts too.
    const value = `${valueEstimate(v, sale)}${money ? ` · ${money}` : ''}`;
    return total !== available ? t('{value}, with what is on its way', { value }) : value;
  }

  /** Under the name; with the number when the wallet holds another token of that ticker (CHAD #187 and #190). */
  function sub(l) {
    const text = tokenSubtitle(l);
    return wallet.distinctUnit(id) !== l.unit && !text.includes(`#${id}`) ? `${text} · #${id}` : text;
  }

  function render(s) {
    const l = wallet.label(id);
    const tot = s.totals.get(id) || ZERO;
    const total = heldTotal(tot);
    const unit = l.pool ? 'LP' : l.symbol;
    refreshMarket();
    titleEl.textContent = tokenTitle(l);
    const warning = copyWarning(l);
    put(
      head,
      h('div', { class: 'token-id' }, assetBadge(l, { size: 'large' }), h('div', { class: 'main' }, h('div', { class: 't', 'data-testid': 'token-page-name', text: l.name }), h('div', { class: 's', 'data-testid': 'token-page-sub', text: sub(l) }))),
      h('div', { class: 'label', text: t('Available') }),
      h('div', { class: 'amount', 'data-testid': 'token-available' }, s.status ? formatAmount(tot.available) : '—', h('span', { class: 'unit', text: unit })),
      h('div', { class: 'token-value', 'data-testid': 'token-value' }, valueLine(s, total, tot.available)),
      h('p', { class: `token-note${l.verified && !l.pool ? ' ok' : ''}`, 'data-testid': 'token-note' }, l.verified && !l.pool ? icon('check') : null, tokenNote(l)),
      warning ? h('p', { class: 'warn-line', 'data-testid': 'token-copy-warning', text: warning }) : null,
    );

    // Send with this token chosen, Receive, and Swap from it (or its pool, for a liquidity token).
    const canSend = s.sync.canSend;
    const has = tot.available > 0n;
    const sendBtn = (has ? primary : secondary)(h('span', {}, t('Send')), () => {
      app.sendDraft = { address: '', amount: '', assetId: id };
      app.go('send');
    }, { disabled: !canSend || !has, 'data-testid': 'token-send' });
    sendBtn.prepend(icon('send'));
    const recvBtn = (has ? secondary : primary)(h('span', {}, t('Receive')), () => app.go('receive', { assetId: id }), { 'data-testid': 'token-receive' });
    recvBtn.prepend(icon('receive'));
    let third = null;
    if (l.pool) {
      if (typeof app.has === 'function' && app.has('pool')) {
        third = secondary(h('span', {}, t('Pool')), () => app.go('pool', { aid1: l.pool.aid1, aid2: l.pool.aid2, kind: l.pool.kind, mode: 'withdraw' }), { 'data-testid': 'token-pool' });
        third.prepend(icon('apps'));
      }
    } else {
      const pools = marketPools();
      if (!pools || tradable(pools).has(id)) {
        third = secondary(h('span', {}, t('Swap')), () => {
          app.swapDraft = { ...(app.swapDraft || {}), pay: id, receive: 0, amount: '' };
          app.go('swap');
        }, { disabled: !canSend, 'data-testid': 'token-swap' });
        third.prepend(icon('swap'));
      }
    }
    const buttons = has ? [sendBtn, recvBtn, third] : [recvBtn, sendBtn, third];
    let why = null;
    if (!canSend && s.sync.state !== 'synced') why = t('Sending is paused: {reason}.', { reason: syncReason(s.sync.title) });
    else if (!has && (tot.receiving > 0n || tot.maturing > 0n)) why = t('Nothing to send yet: {amount} is still on its way to you.', { amount: `${formatAmount(tot.receiving + tot.maturing)} ${unit}` });
    else if (!has) why = t('This wallet has no {token} to send.', { token: l.label });
    put(actions, h('div', { class: `btn-row three${third ? '' : ' two'}` }, ...buttons.filter(Boolean)), why ? h('p', { class: 'small center', 'data-testid': 'token-why', text: why }) : null);

    const kv = (k, v, testid, cls = '') => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v${cls}`, 'data-testid': testid, text: v }));
    put(
      breakdown,
      kv(t('Available'), `${formatAmount(tot.available)} ${unit}`, 'token-bal-available'),
      kv(t('Incoming'), tot.receiving > 0n ? `+${formatAmount(tot.receiving)} ${unit}` : '0', 'token-bal-incoming', tot.receiving > 0n ? ' in' : ' muted'),
      kv(t('Outgoing'), tot.sending > 0n ? `−${formatAmount(tot.sending)} ${unit}` : '0', 'token-bal-outgoing', tot.sending > 0n ? '' : ' muted'),
      kv(t('Maturing'), tot.maturing > 0n ? `${formatAmount(tot.maturing)} ${unit}` : '0', 'token-bal-maturing', tot.maturing > 0n ? '' : ' muted'),
      privateLine(app, s, id, unit),
    );

    const cut = s.txs.length >= RECENT;
    if (cut && olderState === 'idle') loadOlder();
    const txs = tokenHistory(cut && older ? mergeTxs(s.txs, older) : s.txs, id);
    const searching = cut && olderState === 'loading';
    const histNote = searching
      ? t('Looking through older payments…')
      : cut && olderState === 'failed'
        ? t('Older payments could not be read; this is what the latest 100 hold.')
        : cut && older && older.length >= OLDER
          ? tn({ one: 'What the latest {n} payment holds.', other: 'What the latest {n} payments hold.' }, OLDER, { n: OLDER.toLocaleString('en-US') })
          : null;
    put(
      history,
      h('p', { class: 'section-title', text: t('History') }),
      txs.length
        ? h('div', { class: 'card list', 'data-testid': 'token-history' }, ...txs.map((tx) => txRow(app, tx, () => openTxDetail(app, tx))))
        : h('div', { class: 'card empty', 'data-testid': 'token-history-empty' }, icon('activity'), h('p', { text: !s.status ? t('Payments show up here once the wallet is up to date.') : searching ? t('Looking for {token} payments…', { token: l.label }) : t('No {token} payments yet. What you send or receive shows here.', { token: l.label }) })),
      histNote && txs.length ? h('p', { class: 'small center', 'data-testid': 'token-history-note', text: histNote }) : null,
    );

    const hidden = hiddenIds(app).has(id);
    put(
      hideBox,
      hidden
        ? h(
            'div',
            { 'data-testid': 'token-hidden-note' },
            notice('info', t('Hidden from Wallet and its total. It stays in this wallet, and you can still send it from here.'), h('div', { class: 'btn-row prompt-actions' }, secondary(t('Show on Wallet'), () => toggle(false), { class: 'btn btn-secondary btn-small', 'data-testid': 'token-unhide' }))),
          )
        : textButton(h('span', {}, t('Hide from Wallet')), () => toggle(true), { 'data-testid': 'token-hide' }),
    );
    const hideBtn = hideBox.querySelector('[data-testid="token-hide"]');
    if (hideBtn) hideBtn.prepend(icon('eye'));
  }

  async function toggle(hide) {
    const l = wallet.label(id);
    await setTokenHidden(app, id, hide);
    toast(hide ? t('{token} is hidden from Wallet. Show it again here or in Settings.', { token: l.label }) : t('{token} is back on Wallet', { token: l.label }), 3500);
  }

  const off = wallet.onChange(render);
  render(wallet.state);
  loadHidden(app);
  const el = screen({ title: '', back: () => app.back('home'), cls: 'token-page' }, head, actions, breakdown, history, hideBox);
  // The title is the token's name, kept current as names arrive.
  const bar = el.querySelector('.topbar h1');
  if (bar) bar.replaceWith(titleEl);
  return {
    el,
    destroy: () => {
      alive = false;
      off();
    },
  };
}
