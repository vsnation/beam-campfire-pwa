/* My tokens
 * Spec: ONE job: see the tokens this wallet created, and mint more of them.
 *       Primary CTA: "Create a token" (each token has its own "Mint more"; a tap on it opens its page).
 *       Taps from app open: Tokens (1) -> My tokens (2); Mint more is 1 more, then the amount and approve.
 * Exit-intent reasons and answers:
 *   - "Where is my token?" -> one created in this session shows as "being created" until the network
 *     confirms it; the empty state says a new token shows here once confirmed.
 *   - "How much can I still mint?" -> minted and maximum on each card, with a bar.
 *   - "The list didn't load" -> what happened, nothing was sent, and Try again.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { unlimited, MINTER_CID } from '../lib/minter.js';
import { minter, tokenAmount, limitText, rememberMetadata, problemNotice, tokenTitle, pendingTokens, forgetOnLock } from './minter.js';
import { syncReason } from '../lib/sync.js';
import { t } from '../lib/i18n.js';

/** Minted as a share of the ceiling, 0..1, for the bar (no maximum: no bar). */
export function mintedShare(tok) {
  if (unlimited(tok.limit) || tok.limit === 0n) return null;
  return Number((tok.minted * 1000n) / tok.limit) / 1000;
}

export default function minterTokens(app, p = {}) {
  forgetOnLock(app);
  let tokens = null;
  let error = null;
  let loading = false;
  let alive = true;
  let seenMinterTxs = null;
  const body = h('div', { class: 'content' });

  function card(tok) {
    const share = mintedShare(tok);
    const bar = h('div', { class: 'progress token-bar' }, h('div'));
    if (share != null) bar.firstChild.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
    const canMint = tok.mintable > 0n;
    const mint = canMint
      ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': `token-mint-${tok.assetId}`, disabled: !wallet.state.sync.canSend, onclick: () => app.go('minterMint', { assetId: tok.assetId }) }, t('Mint more'))
      : h('span', { class: 'small', text: t('All minted') });
    const head = tokenTitle(tok.assetId, `${wallet.label(tok.assetId).symbol} · #${tok.assetId}`);
    const open = h('button', { class: 'token-open', type: 'button', 'data-testid': `token-open-${tok.assetId}`, onclick: () => app.go('minterToken', { assetId: tok.assetId }) }, head, h('span', { class: 'chev' }, icon('chevron')));
    return h(
      'div',
      { class: 'card token-card', 'data-testid': 'token-card', 'data-asset-id': String(tok.assetId) },
      open,
      share != null ? bar : null,
      h(
        'div',
        { class: 'token-card-foot' },
        h('span', { class: 'small grow', 'data-testid': 'token-minted', text: unlimited(tok.limit) ? t('Minted {amount} · no maximum', { amount: tokenAmount(tok.assetId, tok.minted) }) : t('Minted {amount} of {limit}', { amount: formatAmount(tok.minted), limit: limitText(tok.assetId, tok.limit) }) }),
        mint,
      ),
    );
  }

  function pendingCards() {
    return pendingTokens(app)
      .filter((x) => x.status !== 'done' || !(tokens || []).some((tok) => wallet.label(tok.assetId).symbol === x.ticker))
      .map((x) =>
        h(
          'div',
          { class: 'card token-card', 'data-testid': 'token-pending', 'data-state': x.status },
          h(
            'div',
            { class: 'row asset-row token-title' },
            h('span', { class: `ico ${x.status === 'failed' ? 'fail' : 'wait'}` }, icon(x.status === 'failed' ? 'alert' : 'clock')),
            h(
              'span',
              { class: 'main' },
              h('div', { class: 't', text: x.name || x.ticker }),
              h('div', { class: 's wrap', text: x.status === 'failed' ? t('{ticker} was not created. The network refused it, so the BEAM stays in your wallet.', { ticker: x.ticker }) : x.status === 'done' ? t('{ticker} is confirmed. It shows here in a moment.', { ticker: x.ticker }) : t('{ticker} is being created. It shows here once the network confirms it, usually within a few minutes.', { ticker: x.ticker }) }),
            ),
          ),
        ),
      );
  }

  function render() {
    if (!alive) return;
    const done = p.done
      ? (() => {
          const el = notice('success', h('strong', { text: `${t('Mint sent.')} ` }), t('{amount} reach your wallet once the network confirms it, usually within a few minutes.', { amount: tokenAmount(p.done.assetId, BigInt(p.done.value)) }));
          el.dataset.testid = 'tokens-done';
          return el;
        })()
      : null;
    const pending = pendingCards();
    const list = tokens || [];
    put(
      body,
      done,
      error ? problemNotice(error, 'tokens-problem') : null,
      error ? h('button', { class: 'btn btn-secondary', type: 'button', 'data-testid': 'tokens-retry', onclick: load }, t('Try again')) : null,
      tokens == null && !error ? h('div', { class: 'card empty', 'data-testid': 'tokens-loading' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: t('Looking up the tokens you created…') })) : null,
      ...pending,
      tokens && !list.length && !pending.length
        ? h(
            'div',
            { class: 'card empty', 'data-testid': 'tokens-empty' },
            icon('coins'),
            h('h3', { text: t("You haven't created a token yet") }),
            h('p', { class: 'small', text: t('Create your own token on BEAM, then mint as much of it as you like, up to its maximum. A token you just created shows here once the network confirms it.') }),
          )
        : null,
      ...list.map(card),
      list.length && !wallet.state.sync.canSend ? h('p', { class: 'small center', text: t('Minting is paused: {state}.', { state: syncReason(wallet.state.sync.title) }) }) : null,
    );
  }

  async function load() {
    if (loading) return;
    loading = true;
    error = null;
    render();
    try {
      const owned = await minter().owned();
      for (const x of owned) rememberMetadata(x.assetId, x.metadata);
      if (!alive) return;
      tokens = owned;
    } catch (e) {
      if (!alive) return;
      error = e;
    }
    loading = false;
    render();
  }

  // A token transaction that settles (created, minted) changes the list: read it again then.
  const minterSettled = () => wallet.state.txs.filter((tx) => Number(tx.status) === 3 && (tx.invoke_data || []).some((d) => d && d.contract_id === MINTER_CID)).length;
  const off = wallet.onChange(() => {
    const n = minterSettled();
    if (seenMinterTxs != null && n !== seenMinterTxs && !loading) load();
    seenMinterTxs = n;
    render();
  });
  seenMinterTxs = minterSettled();

  const el = screen({ title: t('My tokens'), back: () => app.back('home'), cls: 'minter-tokens feature sticky-actions' }, body);
  el.appendChild(h('div', { class: 'actions' }, primary(t('Create a token'), () => app.go('minterCreate'), { 'data-testid': 'tokens-create' })));
  render();
  load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
