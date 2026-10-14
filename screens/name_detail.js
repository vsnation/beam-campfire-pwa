/* One of my names
 * Spec: ONE job: keep this name: see until when it is mine and renew it. Transfer and selling are secondary.
 *       Primary CTA: "Renew alice for 1 year" (the approve sheet that follows shows the exact BEAM).
 *       Taps from app open: Home -> BEAM names (1) -> alice (2) -> "Renew alice for 1 year" (3), then approve.
 * Exit-intent reasons and answers:
 *   - "When does it run out?" -> the first line under the name, as a date (never a block height).
 *   - "Will I lose it if I miss the date?" -> the 90 days of grace are spelled out with their last day.
 *   - "What does renewing cost?" -> dollars, BEAM at today's rate and the network fee, before the button.
 *   - "What happens to money from a sale?" -> said under Sell, before listing.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, copyText, secondary, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { STATUS, usdPerPeriod, priceEstimate, maxExtendPeriods, expiryAfterExtend, holdEndHeight, dateOf, display, NAME_CALL_FEE } from '../lib/bans.js';
import { bans, usd, years, day, yearsStepper, nameProblemText } from './names.js';
import { statusWords, priceText, pendingOf, pendingWords } from './name_parts.js';
import { syncReason } from '../lib/sync.js';

const beamAbout = (g) => formatAmount(g, { maxDecimals: g >= 100000000n ? 0 : 4 });
const midpoint = (e) => (e.minGroth + e.maxGroth) / 2n;

export default function nameDetail(app, params = {}) {
  const name = String(params.name || '');
  const pending = pendingOf(app);
  let state = { phase: 'loading' }; // loading | error | notMine | ready
  let params0 = null;
  let years0 = 1;
  let busy = null; // 'renew' | 'unlist'
  // Back from Sell once the listing was sent: say so here.
  let msg = typeof params.listed === 'string' ? { kind: 'success', code: 'listed', text: `${display(name)} is being listed for ${params.listed}. Anyone can buy it once the network confirms it, usually within 2 minutes.` } : null;
  let alive = true;

  const body = h('div', { class: 'name-stack' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'name-reason', 'aria-live': 'polite' });
  const cta = h('button', { class: 'btn btn-primary', 'data-testid': 'name-renew-cta', disabled: true, onclick: renew }, 'Renew');

  async function load() {
    state = { phase: 'loading' };
    render();
    try {
      const [res, key] = await Promise.all([bans().resolve(name), bans().myKey()]);
      if (!alive) return;
      if (!res.domain || res.ownerKey !== key) state = { phase: 'notMine', res };
      else state = { phase: 'ready', res, key };
    } catch (e) {
      if (!alive) return;
      state = { phase: 'error', error: e };
    }
    render();
    if (!params0) {
      bans()
        .params()
        .then((p) => {
          params0 = p;
          if (alive) render();
        })
        .catch(() => {});
    }
  }

  const clock = () => ({ tipHeight: state.res.tipHeight, tipTime: state.res.tipTime });
  const domainNow = () => ({ ...state.res.domain, status: state.res.status });

  function ctaState() {
    if (state.phase !== 'ready') return { off: state.phase === 'loading' ? `Reading ${display(name)}…` : 'Nothing to renew here.', label: 'Renew' };
    const d = domainNow();
    const max = maxExtendPeriods({ expireHeight: d.expireHeight, tipHeight: state.res.tipHeight });
    const y = Math.max(1, Math.min(years0, Math.max(1, max)));
    const label = `Renew ${name} for ${years(y)}`;
    if (busy === 'renew') return { off: 'Building the renewal…', label };
    if (d.status === STATUS.availableAgain) return { off: `Its 90 days of grace are over, so it can no longer be renewed. Register it again under BEAM names before someone else does.`, label };
    if (max === 0) return { off: `Nothing to renew: ${name} is paid up to the 50-year limit.`, label: `Renew ${name}` };
    if (!wallet.state.sync.canSend) return { off: `Renewing is paused: ${syncReason(wallet.state.sync.title)}.`, label };
    if (!params0) return { off: 'Getting the BEAM price…', label };
    if (!params0.usdPerBeamText) return { off: 'The BEAM price feed is not updating right now, so names cannot be priced. Try again in a few minutes.', label };
    const e = priceEstimate({ usdPerPeriod: usdPerPeriod(name.length), periods: y, medianText: params0.usdPerBeamText });
    const have = wallet.available(0);
    if (have < e.minGroth + NAME_CALL_FEE) return { off: `Not enough BEAM. This costs about ${beamAbout(midpoint(e) + NAME_CALL_FEE)} BEAM, network fee included. You have ${formatAmount(have)} BEAM.`, label, receive: true };
    return { off: null, label, years: y, estimate: e };
  }

  function render() {
    if (!alive) return;
    const st = ctaState();
    cta.textContent = st.label;
    cta.disabled = Boolean(st.off);
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM') : null);
    reason.classList.toggle('hidden', !st.off);

    if (state.phase === 'loading') return put(body, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: `Reading ${display(name)} from the BEAM network…` })));
    if (state.phase === 'error') return put(body, notice('error', `${display(name)} could not be read: ${state.error.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, 'Try again')));
    if (state.phase === 'notMine') {
      return put(body, h('div', { 'data-testid': 'name-not-mine' }, notice('info', `${display(name)} is not in this wallet${state.res.domain ? ' any more' : ''}. If you just transferred or sold it, that is why.`)), secondary('Back to BEAM names', () => app.back('names')));
    }

    const d = domainNow();
    const c = clock();
    const w = statusWords(d, c);
    const p = pending.get(name);
    const gone = d.status === STATUS.availableAgain;
    const max = maxExtendPeriods({ expireHeight: d.expireHeight, tipHeight: c.tipHeight });
    const y = st.years || Math.max(1, Math.min(years0, Math.max(1, max)));
    const e = params0 && params0.usdPerBeamText ? priceEstimate({ usdPerPeriod: usdPerPeriod(name.length), periods: y, medianText: params0.usdPerBeamText }) : null;
    const kv = (k, v, testid, cls = '') => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v ${cls}`.trim(), 'data-testid': testid, text: v }));

    put(
      body,
      h(
        'div',
        { class: 'card name-head' },
        h('div', { class: 'name-line' }, h('h2', { class: 'name-title', 'data-testid': 'name-title', text: display(name) }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copy ${display(name)}`, onclick: () => copyText(display(name), 'Name copied') }, icon('copy'))),
        // The date is in the row below; here only what needs attention, or what is on its way.
        p || w.tone !== 'ok' ? h('p', { class: `small tone-${p ? 'soon' : w.tone}`, 'data-testid': 'name-status', text: pendingWords(p) || w.text }) : null,
      ),
      h(
        'div',
        { class: 'card flat swap-details' },
        kv(d.status === STATUS.onHold || gone ? 'Expired on' : 'Yours until', `≈ ${day(dateOf(d.expireHeight, c))}`, 'name-until'),
        d.status === STATUS.onHold ? kv('Renew by', `≈ ${day(dateOf(holdEndHeight(d.expireHeight), c))}`, 'name-renew-by', 'bad') : null,
        d.salePrice ? kv('For sale at', priceText(d.salePrice), 'name-price') : null,
      ),
      h('p', { class: 'small', text: gone ? 'Its 90 days of grace are over, so anyone can register it now.' : 'After it expires you have 90 days to renew it before anyone else can take it.' }),
      gone || max === 0
        ? null
        : h(
            'div',
            { class: 'card flat swap-details', 'data-testid': 'name-renew-box' },
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Renew for' }), yearsStepper(y, max, (v) => {
              years0 = v;
              msg = null;
              render();
            }, 'name-years')),
            kv('Price', usd(usdPerPeriod(name.length) * y), 'name-usd'),
            kv('In BEAM today', e ? `≈ ${beamAbout(midpoint(e))} BEAM` : '…', 'name-beam'),
            kv('Network fee', `${formatAmount(NAME_CALL_FEE)} BEAM`, 'name-fee'),
            kv('New end date', `about ${day(dateOf(expiryAfterExtend({ expireHeight: d.expireHeight, tipHeight: c.tipHeight, periods: y }), c))}`, 'name-new-end'),
          ),
      msg ? h('div', { 'data-testid': 'name-msg', 'data-code': msg.code }, notice(msg.kind, msg.text)) : null,
      h('p', { class: 'section-title', text: 'More' }),
      h(
        'div',
        { class: 'card list' },
        h('button', { class: 'row', type: 'button', 'data-testid': 'name-transfer', disabled: gone || Boolean(busy), onclick: () => app.go('nameTransfer', { name }) }, h('span', { class: 'ico' }, icon('send')), h('span', { class: 'main' }, h('div', { class: 't', text: 'Transfer to another wallet' }), h('div', { class: 's', text: 'Give it to a wallet by its name key' })), h('span', { class: 'chev' }, icon('chevron'))),
        d.salePrice
          ? h('button', { class: 'row', type: 'button', 'data-testid': 'name-unlist', disabled: gone || Boolean(busy), onclick: unlist }, h('span', { class: 'ico' }, icon('close')), h('span', { class: 'main' }, h('div', { class: 't', text: busy === 'unlist' ? 'Preparing…' : `Stop selling ${name}` }), h('div', { class: 's', text: `Listed at ${priceText(d.salePrice)}` })))
          : h('button', { class: 'row', type: 'button', 'data-testid': 'name-sell', disabled: gone || Boolean(busy), onclick: () => app.go('nameSell', { name }) }, h('span', { class: 'ico' }, icon('swap')), h('span', { class: 'main' }, h('div', { class: 't', text: `Sell ${name}` }), h('div', { class: 's', text: 'Set a price; anyone can buy it at once' })), h('span', { class: 'chev' }, icon('chevron'))),
      ),
      h('p', { class: 'small', text: gone ? 'An expired name cannot be transferred or sold until it is registered again.' : d.salePrice ? 'When someone buys it, the payment waits for you under BEAM names, where you claim it.' : 'Selling: anyone can buy it at your price without asking you; the payment waits for you to claim.' }),
    );
  }

  async function renew() {
    const st = ctaState();
    if (st.off || busy) return;
    busy = 'renew';
    msg = null;
    render();
    const before = state.res.domain.expireHeight;
    try {
      await bans().extend(name, st.years, { estimate: st.estimate });
      if (!alive) return;
      pending.set(name, { kind: 'renew', at: Date.now(), expireBefore: before });
      msg = { kind: 'success', code: 'sent', text: `Renewal of ${display(name)} sent. The new date shows once the network confirms it, usually within 2 minutes.` };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      msg = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: nameProblemText(e, 'renewal') };
      if (e.code === 'priceMoved') {
        params0 = null;
        bans()
          .params()
          .then((p) => {
            params0 = p;
            if (alive) render();
          })
          .catch(() => {});
      }
    }
    busy = null;
    render();
  }

  async function unlist() {
    if (busy || state.phase !== 'ready') return;
    if (!wallet.state.sync.canSend) {
      msg = { kind: 'info', code: 'paused', text: `Changing the sale is paused: ${syncReason(wallet.state.sync.title)}.` };
      return render();
    }
    busy = 'unlist';
    msg = null;
    render();
    try {
      await bans().setPrice(name, state.res.domain.salePrice.assetId, 0n, { words: { rows: [['Name', display(name)], ['Price', 'Not for sale']], notes: [`Nobody can buy ${name} after this.`] } });
      if (!alive) return;
      pending.set(name, { kind: 'unlist', at: Date.now() });
      toast(`${display(name)} comes off sale once the network confirms it, usually within 2 minutes.`, 5000);
      wallet.refreshTxs();
    } catch (e) {
      if (!alive) return;
      msg = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: nameProblemText(e, 'change') };
    }
    busy = null;
    render();
  }

  const off = wallet.onChange(() => render());
  load();

  const el = screen(
    { title: name, back: () => app.back('names'), cls: 'names feature sticky-actions', actions: [reason, cta] },
    body,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
