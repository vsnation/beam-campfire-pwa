/* Sell a name
 * Spec: ONE job: put this name up for sale at a price, knowing anyone can then buy it at once.
 *       Primary CTA: "List alice for 500 BEAM" (then the approve sheet: only the network fee is paid now).
 *       Taps from app open: Names (1) -> alice (2) -> Sell (3) -> price -> "List alice for …" (4), then approve.
 * Exit-intent reasons and answers:
 *   - "Will I have to approve each buyer?" -> no: anyone can buy it at once at this price; said first.
 *   - "Where does the money go?" -> it waits for you in BEAM names' vault and you claim it under BEAM
 *     names; said before listing.
 *   - "Can I change my mind?" -> yes, stop selling at any time until someone buys it.
 *   - "What does the buyer get?" -> the name with the time left on it, until a date shown here.
 */
import { h, put } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';
import { formatAmount, parseAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { display, dateOf, STATUS, NAME_CALL_FEE } from '../lib/bans.js';
import { bans, day, nameProblemText } from './names.js';
import { pendingOf } from './name_parts.js';

export default function nameSell(app, params = {}) {
  const name = String(params.name || '');
  const pending = pendingOf(app);
  let res = null;
  let myKey = null;
  let amount = null;
  let amountError = null;
  let assetId = 0;
  let busy = false;
  let msg = null;
  let alive = true;

  const input = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', 'aria-label': 'Price', 'data-testid': 'sell-amount' });
  const select = h('select', { class: 'input sell-asset', 'aria-label': 'Asset', 'data-testid': 'sell-asset' });
  const detail = h('div', { class: 'name-stack' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'sell-reason', 'aria-live': 'polite' });
  const cta = h('button', { class: 'btn btn-primary', 'data-testid': 'sell-cta', disabled: true, onclick: list }, `List ${name} for sale`);

  function fillAssets() {
    const ids = [0, ...[...wallet.state.totals.keys()].filter((id) => id !== 0).sort((a, b) => a - b)];
    if ([...select.options].map((o) => Number(o.value)).join() === ids.join()) return;
    put(select, ...ids.map((id) => h('option', { value: String(id), text: wallet.label(id).unit, selected: id === assetId })));
  }

  function readAmount() {
    amount = null;
    amountError = null;
    msg = null;
    const t = input.value.trim();
    if (t) {
      try {
        amount = parseAmount(t);
        if (amount === 0n) {
          amount = null;
          amountError = 'The price must be more than zero.';
        }
      } catch (e) {
        amountError = e.message;
      }
    }
    render();
  }

  const priceText = () => (amount == null ? '' : `${formatAmount(amount)} ${wallet.label(assetId).unit}`);

  function ctaState() {
    if (busy) return 'Building the listing…';
    if (res && (!res.domain || res.ownerKey !== myKey)) return `${display(name)} is not in this wallet.`;
    if (res && res.status === STATUS.availableAgain) return 'An expired name cannot be sold until it is registered again.';
    if (amount == null) return amountError || `Enter the price you want for ${name}.`;
    if (res && res.domain.salePrice && res.domain.salePrice.assetId === assetId && res.domain.salePrice.amount === amount) return 'That is already the price. Nothing to change.';
    if (!wallet.state.sync.canSend) return `Listing is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.`;
    if (wallet.available(0) < NAME_CALL_FEE) return `You need ${formatAmount(NAME_CALL_FEE)} BEAM for the network fee. You have ${formatAmount(wallet.available(0))} BEAM.`;
    return null;
  }

  function render() {
    if (!alive) return;
    fillAssets();
    const off = ctaState();
    cta.disabled = Boolean(off);
    cta.textContent = busy ? 'Preparing…' : amount == null ? `List ${name} for sale` : `List ${name} for ${priceText()}`;
    put(reason, off || '');
    reason.classList.toggle('hidden', !off);
    input.classList.toggle('bad', Boolean(amountError));
    const until = res && res.domain ? day(dateOf(res.domain.expireHeight, res)) : null;
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    put(
      detail,
      amountError ? h('p', { class: 'hint bad', 'data-testid': 'sell-amount-error', text: amountError }) : null,
      h('div', { class: 'card flat swap-details' }, kv('The buyer gets', until ? `${name} until about ${until}` : name, 'sell-buyer-gets'), kv('To list it', `${formatAmount(NAME_CALL_FEE)} BEAM network fee`, 'sell-fee'), res && res.domain && res.domain.salePrice ? kv('Listed now at', `${formatAmount(res.domain.salePrice.amount)} ${wallet.label(res.domain.salePrice.assetId).unit}`, 'sell-now') : null),
      h('p', { class: 'small', text: 'You can stop selling at any time until someone buys it.' }),
      msg ? h('div', { 'data-testid': 'sell-msg', 'data-code': msg.code }, notice(msg.kind, msg.text)) : null,
    );
  }

  async function list() {
    if (ctaState() || busy) return;
    busy = true;
    msg = null;
    render();
    const aid = assetId;
    const price = amount;
    try {
      const until = res && res.domain ? day(dateOf(res.domain.expireHeight, res)) : null;
      await bans().setPrice(name, aid, price, {
        words: {
          rows: [['Name', display(name)], ['Price', `${formatAmount(price)} ${wallet.label(aid).unit}`], until ? ['The buyer gets', `${name} until about ${until}`] : null].filter(Boolean),
          notes: [`Anyone can buy ${name} at this price at any moment, without asking you. The payment waits for you under BEAM names, where you claim it.`],
        },
      });
      if (!alive) return;
      pending.set(name, { kind: 'sell', at: Date.now(), assetId: aid, amount: price });
      busy = false;
      wallet.refreshTxs();
      app.go('nameDetail', { name, listed: `${formatAmount(price)} ${wallet.label(aid).unit}` }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      msg = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: nameProblemText(e, 'listing') };
    }
    busy = false;
    render();
  }

  input.addEventListener('input', readAmount);
  select.addEventListener('change', () => {
    assetId = Number(select.value) || 0;
    msg = null;
    render();
  });
  const off = wallet.onChange(() => render());
  Promise.all([bans().myKey(), bans().resolve(name)])
    .then(([k, r]) => {
      myKey = k;
      res = r;
      if (alive) render();
    })
    .catch((e) => {
      msg = { kind: 'error', code: e.code || 'error', text: `${display(name)} could not be read: ${e.message}` };
      if (alive) render();
    });
  render();

  const el = screen(
    { title: `Sell ${name}`, back: () => app.back('names'), cls: 'names feature sticky-actions', actions: [reason, cta] },
    h('p', { class: 'lead', 'data-testid': 'sell-lead', text: `Anyone can buy ${display(name)} at once at the price you set, without asking you. The payment waits for you under BEAM names, where you claim it.` }),
    h('label', { class: 'field' }, 'Price', h('div', { class: 'sell-fields' }, input, select)),
    detail,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
