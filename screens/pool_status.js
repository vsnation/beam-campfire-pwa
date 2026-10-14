/* A pool move on its way (after approving a deposit, a withdrawal or a new pool)
 * Spec: ONE job: follow this pool move until the blockchain has it.
 *       Primary CTA: "Done" (back to the pool, with the new share); once a new pool is confirmed,
 *       "Add the first coins".
 *       Taps from app open: right after approving (the 5th tap or so); nothing to do but wait.
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> the state in words, live: on its way, then done or failed.
 *   - "Where are my coins?" -> what left and what arrives, as the approve sheet said, then as the
 *     blockchain booked it; the LP token shows on the Wallet tab and the move in Activity.
 *   - "It failed - did I lose money?" -> says the plain reason and that the coins stayed.
 */
import { h, shorten, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { primary, secondary, notice, copyText } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, contractMoves, spentElsewhere } from '../lib/wallet.js';
import { spentElsewhereNotice } from './tx_status.js';
import { loadPools } from '../lib/dex_pools.js';
import { unit, poolParams } from './pool_parts.js';
import { t, tk } from '../lib/i18n.js';

// Shown with t(): this table is read before any language is known.
const WORDS = {
  add: { wait: tk('Adding to the pool'), done: tk('Added to the pool'), failed: tk('The deposit failed'), cancelled: tk('Deposit cancelled'), pays: tk('You add'), receives: [tk('You get'), tk('You got')] },
  withdraw: { wait: tk('Taking out of the pool'), done: tk('Taken out of the pool'), failed: tk('The withdrawal failed'), cancelled: tk('Withdrawal cancelled'), pays: tk('You return'), receives: [tk('You get back'), tk('You got back')] },
  create: { wait: tk('Creating the pool'), done: tk('Pool created'), failed: tk('The pool was not created'), cancelled: tk('Pool creation cancelled'), pays: tk('Deposit (locked)'), receives: [tk('You get'), tk('You got')] },
};

export default function poolTx(app, p) {
  const words = WORDS[p.action] || WORDS.add;
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  let tx = null;
  let doneSeen = false;

  const toPool = (extra = {}) => app.go('pool', poolParams(p, { fresh: true, ...extra }), { replace: true });

  function render() {
    const s = tx ? Number(tx.status) : 1;
    const done = s === 3;
    const failed = s === 4 || s === 2;
    const moved = tx && done ? contractMoves(tx) : null;
    const pays = moved && moved.spends.length ? moved.spends : p.pays;
    const receives = moved && moved.receives.length ? moved.receives : p.receives;
    const approx = done ? '' : '≈ ';
    const line = (k, a, sign, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: `${sign}${formatAmount(a.amount)} ${unit(a.assetId)}` }));
    put(
      body,
      h('div', { class: `status-icon ${done ? 'ok' : failed ? 'bad' : 'wait'}` }, icon(done ? 'check' : failed ? 'close' : 'clock')),
      h('h2', { class: 'title center', 'data-testid': 'pool-tx-title', 'data-status': String(s), text: t(done ? words.done : failed ? (s === 2 ? words.cancelled : words.failed) : words.wait) }),
      h(
        'div',
        { class: 'card', 'data-testid': 'pool-tx-card' },
        ...pays.map((a, i) => line(i === 0 ? t(words.pays) : '', a, '', `pool-tx-pay-${i}`)),
        ...receives.map((a, i) => line(i === 0 ? t(words.receives[done ? 1 : 0]) : '', a, approx, `pool-tx-get-${i}`)),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'pool-tx-fee', text: `${formatAmount(tx && tx.fee != null ? BigInt(tx.fee) : p.fee)} BEAM` })), // i18n-ignore: an amount and its ticker
        tx && tx.kernel && /[1-9a-f]/.test(tx.kernel)
          ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Kernel ID') }), h('button', { class: 'v mono btn-text', 'data-testid': 'pool-tx-kernel', 'data-kernel': tx.kernel, onclick: () => copyText(tx.kernel, t('Kernel ID copied')), text: shorten(tx.kernel, 10, 8) }))
          : null,
      ),
      done
        ? notice(
            'success',
            p.action === 'create'
              ? t('The pool is on the blockchain, empty. Add the first coins: they set its price.')
              : p.action === 'withdraw'
                ? t('The coins are back in your wallet. Your new balance is on the Wallet tab; the move is in Activity.')
                : t('Your share is in your wallet as {unit}. It is on the Wallet tab; the move is in Activity.', { unit: unit(p.lpToken) }),
          )
        : failed && spentElsewhere(tx)
          ? spentElsewhereNotice(app)
          : failed
          ? notice(s === 2 ? 'info' : 'error', s === 4 && tx.failure_reason ? t('{reason}. Nothing moved: your coins stay in your wallet.', { reason: String(tx.failure_reason) }) : t('Nothing moved: your coins stay in your wallet.'))
          : notice('info', t('On its way to the blockchain. This usually takes a minute or two; keep BEAM Campfire open until it is done.')),
    );
    if (done && p.action === 'create') {
      put(actions, primary(t('Add the first coins'), () => toPool({ mode: 'add' }), { 'data-testid': 'pool-tx-add-first' }), secondary(t('Done'), () => app.go('pools', {}, { replace: true }), { 'data-testid': 'pool-tx-done' }));
    } else {
      put(actions, primary(t('Done'), () => (p.action === 'create' ? app.go('pools', {}, { replace: true }) : toPool()), { 'data-testid': 'pool-tx-done' }));
    }
    if (done && !doneSeen) {
      doneSeen = true;
      // The new reserves and the LP balance, for the screens that come next.
      wallet.refreshStatus();
      loadPools(true).catch(() => {});
    }
  }

  async function poll() {
    try {
      const st = await wallet.txStatus(p.txId);
      tx = { ...(wallet.state.txs.find((x) => x.txId === p.txId) || {}), ...st };
      render();
    } catch {
      /* keep the last state */
    }
  }

  const timer = setInterval(poll, 3000);
  const off = wallet.onChange(() => {
    const found = wallet.state.txs.find((x) => x.txId === p.txId);
    if (found) {
      tx = { ...tx, ...found };
      render();
    }
  });
  render();
  poll();

  const el = h('main', { class: 'screen', 'data-testid': 'pool-tx', 'data-txid': p.txId }, h('header', { class: 'topbar' }, h('h1', { text: p.action === 'create' ? t('New pool') : t('Pool') })), body, actions);
  return {
    el,
    destroy() {
      clearInterval(timer);
      off();
    },
  };
}
