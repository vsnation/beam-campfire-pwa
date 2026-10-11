/* Review split
 * Spec: ONE job: show exactly what the split does before it is signed (like a payment's review): the
 *       coins now, the coins after, the fee, and that nothing leaves the wallet.
 *       Primary CTA: "Split into 5 coins", then Face ID / password.
 *       Taps from app open: 3 (Home -> Coins -> "Split into 5 coins" -> here), then Face ID / password.
 * Exit-intent reasons and answers (BEAM Campfire's beam_split_confirm_view.dart):
 *   - "Is money leaving?" -> the first notice and the last line both say only the fee does.
 *   - "Can I back out?" -> Back and "Change"; nothing is signed until Face ID / the password.
 *   - "Did it go?" -> the screen turns into "Splitting into 5 coins" with when they are ready.
 *   - "My coins changed meanwhile" -> the split is checked against the coins again here; if they no longer
 *     cover it, it says so and offers going back, never a different split than the one shown.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { tokenSubtitle } from '../lib/meta.js';
import { wallet } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { loadCoins, emptySummary, planSized, splitCoins, SplitError, SPLIT_TEXT as T } from '../lib/coins.js';

export default function splitReview(app, p = {}) {
  const assetId = Number(p.assetId) || 0;
  const count = Number(p.count);
  let size = 0n;
  try {
    size = BigInt(p.size);
  } catch {
    size = 0n;
  }
  if (!Number.isInteger(count) || size <= 0n) {
    queueMicrotask(() => app.go('coins', { assetId }, { replace: true }));
    return { el: h('div') };
  }

  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'actions' });
  const l = wallet.label(assetId);
  const symbol = l.pool ? 'LP' : l.unit;
  let before = null; // this asset's coins now
  let beam = 0n;
  let plan = null;
  let problem = null; // { title, text }
  let spent = false; // handed to the engine (or may have been): never offered again here
  let busy = false;
  let authing = false; // the Face ID / password sheet is open
  let doneTx = null;
  const hand = {}; // the tx id once handed over (lib/coins.js splitCoins)
  let alive = true;

  /** Checks the split against the coins the wallet holds now. Never signs or sends anything. */
  async function prepare() {
    try {
      if (!wallet.session) throw new Error('The wallet is still starting.');
      const all = await loadCoins(wallet.session);
      before = all.get(assetId) || emptySummary(assetId);
      beam = all.get(0) ? all.get(0).availableTotal : 0n;
      plan = planSized({ available: before.availableTotal, count, size, assetId });
      if (!plan) problem = { title: 'Your coins changed', text: T.changed };
      else if (assetId !== 0 && beam < plan.fee) problem = { title: 'Not enough BEAM for the fee', text: T.needBeam(plan.fee, beam) };
    } catch (e) {
      problem = { title: "Your coins couldn't be read", text: `${e.message} Go back and try again.` };
    }
    render();
  }

  async function confirm() {
    if (busy || authing || !plan) return;
    if (!wallet.state.sync.canSend) {
      problem = { title: 'Not up to date yet', text: `${wallet.state.sync.title}. Splitting is paused until the wallet is up to date.` };
      return render();
    }
    authing = true;
    render();
    const ok = await confirmIdentity(app, { title: 'Confirm the split', detail: T.authReason(plan, symbol), cta: 'Split' });
    authing = false;
    if (!ok || !alive) return render();
    busy = true;
    render();
    try {
      doneTx = await splitCoins(wallet.session, plan, hand);
      await wallet.persistNow();
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      const unknown = e instanceof SplitError && e.code === 'unknown';
      problem = { title: unknown ? 'Not sure the split started' : 'The coins were not split', text: e instanceof SplitError ? e.message : `The coins were not split: ${e.message}. Nothing left your wallet.` };
      // Once handed over (or maybe), it is never offered again here: Activity shows what happened.
      spent = Boolean(hand.txId) || unknown;
    }
    busy = false;
    if (alive) render();
  }

  const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));

  function render() {
    if (doneTx) {
      put(
        body,
        h('div', { class: 'status-icon ok' }, icon('check')),
        h('h2', { class: 'title center', 'data-testid': 'split-done', text: T.doneTitle(plan.count) }),
        h('p', { class: 'lead center', text: T.doneMessage }),
      );
      put(actions, primary('Done', () => app.go('home'), { 'data-testid': 'split-done-cta' }), textButton('See it in Activity', () => app.go('activity', { txId: doneTx }), { 'data-testid': 'split-done-activity' }));
      return;
    }
    if (!before) {
      put(body, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { text: 'Checking your coins…' })));
      put(actions);
      return;
    }
    const coinsNow = before.available.length;
    put(
      body,
      h('div', { 'data-testid': 'split-review-note' }, notice('info', h('strong', { text: 'Nothing leaves your wallet. ' }), T.reviewNote(symbol, assetId !== 0))),
      h('div', { class: 'card row split-asset' }, assetBadge(l), h('span', { class: 'main' }, h('div', { class: 't', text: l.pool ? l.name : l.unit }), assetId === 0 ? null : h('div', { class: 's', text: tokenSubtitle(l) }))),
      plan
        ? h(
            'div',
            { class: 'card flat split-after' },
            kv('Now', `${formatAmount(before.availableTotal)} ${symbol} in ${coinsNow} ${coinsNow === 1 ? 'coin' : 'coins'}`, 'split-review-now'),
            kv('New coins', T.newCoins(plan, symbol), 'split-review-new'),
            plan.change > 0n ? kv('Stays as change', `${formatAmount(plan.change)} ${symbol}`, 'split-review-change') : null,
            kv('Network fee', T.fee(plan), 'split-review-fee'),
            h('div', { class: 'kv total' }, h('span', { class: 'k', text: 'Leaves your wallet' }), h('span', { class: 'v', 'data-testid': 'split-review-leaves', text: T.fee(plan) })),
          )
        : null,
      problem ? h('div', { 'data-testid': 'split-review-problem' }, notice('error', h('strong', { text: `${problem.title}. ` }), problem.text)) : null,
    );
    if (spent || !plan || (problem && problem.title === 'Not enough BEAM for the fee')) {
      put(actions, primary('Back', () => app.back('coins'), { 'data-testid': 'split-review-back' }), spent ? textButton('Open Activity', () => app.go('activity'), { 'data-testid': 'split-review-activity' }) : null);
      return;
    }
    const sync = wallet.state.sync;
    put(
      actions,
      !sync.canSend ? h('p', { class: 'hint center', 'data-testid': 'split-review-paused', text: `Splitting is paused: ${sync.title.toLowerCase().replace(/[.…]+$/, '')}.` }) : null,
      primary(busy ? 'Splitting…' : T.cta(plan.count), confirm, { disabled: busy || authing || !sync.canSend, 'data-testid': 'split-confirm-cta' }),
      textButton('Change', () => app.back('coins'), { 'data-testid': 'split-review-change-btn' }),
    );
  }

  const off = wallet.onChange(() => !doneTx && !busy && !authing && before && render());
  render();
  prepare();
  const el = screen({ title: T.reviewTitle, back: () => (busy ? null : app.back('coins')), cls: 'coins' }, body, actions);
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
