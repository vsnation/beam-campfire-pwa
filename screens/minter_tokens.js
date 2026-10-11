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

/** Minted as a share of the ceiling, 0..1, for the bar (no maximum: no bar). */
export function mintedShare(t) {
  if (unlimited(t.limit) || t.limit === 0n) return null;
  return Number((t.minted * 1000n) / t.limit) / 1000;
}

export default function minterTokens(app, p = {}) {
  forgetOnLock(app);
  let tokens = null;
  let error = null;
  let loading = false;
  let alive = true;
  let seenMinterTxs = null;
  const body = h('div', { class: 'content' });

  function card(t) {
    const share = mintedShare(t);
    const bar = h('div', { class: 'progress token-bar' }, h('div'));
    if (share != null) bar.firstChild.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
    const canMint = t.mintable > 0n;
    const mint = canMint
      ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': `token-mint-${t.assetId}`, disabled: !wallet.state.sync.canSend, onclick: () => app.go('minterMint', { assetId: t.assetId }) }, 'Mint more')
      : h('span', { class: 'small', text: 'All minted' });
    const head = tokenTitle(t.assetId, `${wallet.label(t.assetId).symbol} · #${t.assetId}`);
    const open = h('button', { class: 'token-open', type: 'button', 'data-testid': `token-open-${t.assetId}`, onclick: () => app.go('minterToken', { assetId: t.assetId }) }, head, h('span', { class: 'chev' }, icon('chevron')));
    return h(
      'div',
      { class: 'card token-card', 'data-testid': 'token-card', 'data-asset-id': String(t.assetId) },
      open,
      share != null ? bar : null,
      h(
        'div',
        { class: 'token-card-foot' },
        h('span', { class: 'small grow', 'data-testid': 'token-minted', text: unlimited(t.limit) ? `Minted ${tokenAmount(t.assetId, t.minted)} · no maximum` : `Minted ${formatAmount(t.minted)} of ${limitText(t.assetId, t.limit)}` }),
        mint,
      ),
    );
  }

  function pendingCards() {
    return pendingTokens(app)
      .filter((x) => x.status !== 'done' || !(tokens || []).some((t) => wallet.label(t.assetId).symbol === x.ticker))
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
              h('div', { class: 's wrap', text: x.status === 'failed' ? `${x.ticker} was not created. The network refused it, so the BEAM stays in your wallet.` : x.status === 'done' ? `${x.ticker} is confirmed. It shows here in a moment.` : `${x.ticker} is being created. It shows here once the network confirms it, usually within a few minutes.` }),
            ),
          ),
        ),
      );
  }

  function render() {
    if (!alive) return;
    const done = p.done
      ? (() => {
          const el = notice('success', h('strong', { text: 'Mint sent. ' }), `${tokenAmount(p.done.assetId, BigInt(p.done.value))} reach your wallet once the network confirms it, usually within a few minutes.`);
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
      error ? h('button', { class: 'btn btn-secondary', type: 'button', 'data-testid': 'tokens-retry', onclick: load }, 'Try again') : null,
      tokens == null && !error ? h('div', { class: 'card empty', 'data-testid': 'tokens-loading' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Looking up the tokens you created…' })) : null,
      ...pending,
      tokens && !list.length && !pending.length
        ? h(
            'div',
            { class: 'card empty', 'data-testid': 'tokens-empty' },
            icon('coins'),
            h('h3', { text: "You haven't created a token yet" }),
            h('p', { class: 'small', text: 'Create your own token on BEAM, then mint as much of it as you like, up to its maximum. A token you just created shows here once the network confirms it.' }),
          )
        : null,
      ...list.map(card),
      list.length && !wallet.state.sync.canSend ? h('p', { class: 'small center', text: `Minting is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` }) : null,
    );
  }

  async function load() {
    if (loading) return;
    loading = true;
    error = null;
    render();
    try {
      const t = await minter().owned();
      for (const x of t) rememberMetadata(x.assetId, x.metadata);
      if (!alive) return;
      tokens = t;
    } catch (e) {
      if (!alive) return;
      error = e;
    }
    loading = false;
    render();
  }

  // A token transaction that settles (created, minted) changes the list: read it again then.
  const minterSettled = () => wallet.state.txs.filter((t) => Number(t.status) === 3 && (t.invoke_data || []).some((d) => d && d.contract_id === MINTER_CID)).length;
  const off = wallet.onChange(() => {
    const n = minterSettled();
    if (seenMinterTxs != null && n !== seenMinterTxs && !loading) load();
    seenMinterTxs = n;
    render();
  });
  seenMinterTxs = minterSettled();

  const el = screen({ title: 'My tokens', back: () => app.back('home'), cls: 'minter-tokens feature sticky-actions' }, body);
  el.appendChild(h('div', { class: 'actions' }, primary('Create a token', () => app.go('minterCreate'), { 'data-testid': 'tokens-create' })));
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
