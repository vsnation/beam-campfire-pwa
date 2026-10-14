/* Your buy (Buy BEAM -> "Get a … deposit address", or Your buys -> a buy)
 * Spec: ONE job: send exactly this much of this coin to this address; then see the buy go through
 *       until the BEAM is in the wallet.
 *       Primary CTA: "Copy address" while the payment is awaited; after it the one next step: back to
 *       the wallet, "See it in your wallet" once the wallet has the BEAM, "Start a new buy" when no
 *       payment came, "Contact buybeam.my support" when buybeam.my needs a look.
 *       Taps from app open: it opens by itself after Buy (1) -> BEAM (2) -> the form's button (3);
 *       later, Buy -> BEAM -> Your buys -> the buy (4).
 * Exit-intent reasons and answers:
 *   - "Which network? How much exactly?" -> the coin and its network are said above the address; the
 *     exact amount has its own copy button.
 *   - "Did it work?" -> four steps, each ticked as it happens; the screen updates by itself.
 *     "Arrived" is said only once this wallet has the BEAM transaction.
 *   - "Can I close this?" -> said: the buy keeps going; BEAM Campfire must be opened again within
 *     12 hours for the BEAM to arrive (a regular BEAM address needs the wallet online).
 *   - "It went wrong" -> what happened, where the coins are (sent back, or never taken), and the one
 *     next step.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { buyBeam, receivedInWallet } from '../lib/buy/wiring.js';
import { beamText, groth, buySteps } from '../lib/buy/words.js';
import { buySiteUrl } from '../lib/buy/hosts.js';
import { qrElement } from './receive.js';
import { coinBadge } from './buy_screens.js';
import { t, dateLocale } from '../lib/i18n.js';

// English's day and month ("9 Oct"; en-GB's own short month says "Sept"). Other languages: their own.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // i18n-ignore: English only; other languages use toLocaleDateString(dateLocale())

/** "14:05 today" or "14:05 on 9 Oct". */
export function untilText(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return t('{time} today', { time });
  const loc = dateLocale();
  return t('{time} on {date}', { time, date: loc ? d.toLocaleDateString(loc, { day: 'numeric', month: 'short' }) : `${d.getDate()} ${MONTHS[d.getMonth()]}` });
}

function kv(label, value, extra = {}) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value));
}

export default function buyOrderScreen(app, params = {}) {
  const c = buyBeam(app);
  const deposit = params.deposit;
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  let copied = false;
  let amountCopied = false;
  let alive = true;

  const copy = async (text, amount = false) => {
    if (await copyText(text, amount ? t('Amount copied') : t('Address copied'))) {
      if (amount) amountCopied = true;
      else copied = true;
      render();
    }
  };

  function payment(o) {
    return [
      notice('warn', h('span', { 'data-testid': 'buy-network-warning', text: t('Send only {symbol} on the {chain} network to this address.', { symbol: o.symbol, chain: o.chainName }) })),
      h('div', { class: 'qr qr-small', 'data-testid': 'buy-qr' }, qrElement(o.depositAddress)),
      h(
        'div',
        { class: 'card address-box' },
        h('div', { class: 'banner' }, coinBadge(o.assetId, o.symbol, 'small'), h('span', { class: 'grow small', text: t('{chain} deposit address', { chain: o.chainName }) }), h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-address', onclick: () => copy(o.depositAddress) }, icon('copy'), copied ? t('Copied') : t('Copy'))),
        h('p', { class: 'mono', 'data-testid': 'buy-deposit-address', text: o.depositAddress }),
      ),
      h(
        'div',
        { class: 'card banner exact-amount' },
        h('div', { class: 'grow' }, h('div', { class: 'small', text: t('Send exactly') }), h('div', { class: 'big', 'data-testid': 'buy-exact-amount', text: `${o.sendAmount} ${o.symbol}` })),
        h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-amount', onclick: () => copy(o.sendAmount, true) }, icon('copy'), amountCopied ? t('Copied') : t('Copy')),
      ),
      o.deadline ? h('p', { class: 'small', 'data-testid': 'buy-deadline', text: t('This address works until {time}.', { time: untilText(o.deadline) }) }) : null,
    ];
  }

  function stateNotice(o, s, arrived) {
    const got = o.beamEstimate == null ? null : `≈\u00a0${beamText(groth(o.beamEstimate))}`;
    const n = (kind, key, title, detail) => {
      const el = notice(kind, h('strong', { text: `${title} ` }), detail || '');
      el.dataset.testid = key;
      return el;
    };
    switch (s) {
      case 'delivered':
        if (arrived) return n('success', 'buy-arrived', t('Your BEAM has arrived.'), got ? t('{amount} is in your BEAM wallet.', { amount: got }) : t('Your BEAM is in your BEAM wallet.'));
        return n('info', 'buy-delivered', t('buybeam.my sent your BEAM.'), got ? t('{amount} shows in your BEAM wallet as soon as BEAM Campfire accepts it: keep it open.', { amount: got }) : t('Your BEAM shows in your BEAM wallet as soon as BEAM Campfire accepts it: keep it open.'));
      case 'refunded':
        return n('warn', 'buy-refunded', t('Your payment was sent back to {address}.', { address: shorten(o.refundAddress, 6, 4) }), t("buybeam.my couldn't buy the BEAM, so your {symbol} went back to your {chain} address. There is nothing else to do.", { symbol: o.symbol, chain: o.chainName }));
      case 'expired':
        return n('warn', 'buy-expired', t('No payment arrived in time. Nothing was taken.'), t('This address no longer takes payments. Start a new buy to get a new one.'));
      case 'failed':
        return n('error', 'buy-failed', t("The payment couldn't be processed."), t('Contact buybeam.my support with this order (copy it below). They can see where your coins are.'));
      case 'attention':
        return n('warn', 'buy-attention', t('buybeam.my is checking this order.'), t('Contact their support with this order (copy it below). BEAM Campfire keeps checking meanwhile.'));
      default:
        return null;
    }
  }

  function steps(s, arrived) {
    const mark = { done: 'check', active: 'clock', waiting: null, failed: 'close' };
    return h(
      'div',
      { class: 'card steps', 'data-testid': 'buy-steps' },
      ...buySteps(s, { arrived }).map((st, i) =>
        h('div', { class: `step-row ${st.mark}`, 'data-testid': `buy-step-${i}`, 'data-mark': st.mark }, h('span', { class: 'step-mark' }, mark[st.mark] ? icon(mark[st.mark]) : null), h('span', { class: 'grow', text: st.label }), st.note ? h('span', { class: 'small', text: st.note }) : null),
      ),
    );
  }

  function details(o, s, arrived) {
    const paid = !['awaiting_deposit', 'expired', 'failed'].includes(s);
    return h(
      'div',
      { class: 'card flat swap-details' },
      kv(paid ? t('You paid') : t('You pay'), `${o.sendAmount} ${o.symbol}`),
      o.beamEstimate != null ? kv(arrived ? t('You got') : t('You get'), `≈ ${beamText(groth(o.beamEstimate))}`, { 'data-testid': 'buy-order-estimate' }) : null,
      kv(t('Arrives in'), t('Your BEAM wallet')),
      kv(t('Refunds go to'), shorten(o.refundAddress, 6, 4), { class: 'v mono' }),
      s !== 'awaiting_deposit' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Order') }), h('button', { class: 'v mono btn-text', 'data-testid': 'buy-copy-order', onclick: () => copy(o.depositAddress), text: shorten(o.depositAddress, 6, 4) })) : null,
      o.beamTxId ? kv(t('BEAM transaction'), shorten(o.beamTxId, 6, 4), { class: 'v mono', 'data-testid': 'buy-beam-tx' }) : null,
    );
  }

  function render() {
    if (!alive) return;
    const o = c.order(deposit);
    if (!o) {
      put(body, c.loadError ? notice('error', t('Your buys could not be opened: {reason}', { reason: c.loadError.message })) : h('p', { class: 'small', text: t('Loading your buy…') }));
      put(actions, primary(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'buy-order-cta' }));
      return;
    }
    const s = o.lastState || 'awaiting_deposit';
    const arrived = s === 'delivered' && receivedInWallet(o.beamTxId);
    titleEl.textContent = s === 'awaiting_deposit' ? t('Send {amount}', { amount: `${o.sendAmount} ${o.symbol}` }) : t('Buy BEAM');
    const pollError = c.pollError(deposit);
    put(
      body,
      o.sandbox ? notice('info', t("buybeam.my's test mode: nothing to pay.")) : null,
      stateNotice(o, s, arrived),
      ...(s === 'awaiting_deposit' ? payment(o) : []),
      steps(s, arrived),
      details(o, s, arrived),
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-keep-open', text: t('Keep BEAM Campfire open until your BEAM arrives. If you close it, open it again within 12 hours.') }) : null,
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-can-leave', text: t('You can leave this screen: your buy keeps going.') }) : null,
      pollError && o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-poll-error', text: pollError.unreachable ? t("Couldn't reach buybeam.my just now. BEAM Campfire keeps checking.") : t("buybeam.my's last answer didn't make sense. BEAM Campfire keeps checking.") }) : null,
    );
    let cta;
    if (s === 'awaiting_deposit') cta = primary(h('span', { text: copied ? t('Address copied') : t('Copy address') }), () => copy(o.depositAddress), { 'data-testid': 'buy-order-cta' });
    else if (s === 'delivered' && arrived) cta = primary(t('See it in your wallet'), () => app.go('activity', { txId: o.beamTxId }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'expired') cta = primary(t('Start a new buy'), () => app.go('buyBeam', {}, { replace: true }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'failed' || s === 'attention') cta = h('a', { class: 'btn btn-primary', href: buySiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'buy-order-cta' }, t('Contact buybeam.my support'));
    else cta = primary(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'buy-order-cta' });
    if (s === 'awaiting_deposit') cta.prepend(icon('copy'));
    put(actions, cta);
    root.dataset.state = s;
  }

  const el = screen({ title: t('Buy BEAM'), back: () => app.back(params.from === 'list' ? 'buyOrders' : 'home'), actions: [actions], cls: 'buy-order sticky-actions' }, body);
  const titleEl = el.querySelector('.topbar h1');
  const root = el;
  const off = c.onChange(() => render());
  const offW = wallet.onChange(() => render());
  render();
  (async () => {
    await c.resumeAll();
    // Where it is now, not where it was when the app last looked.
    const o = c.order(deposit);
    if (o && o.isOpen && alive) await c.poll(deposit);
    render();
  })();
  return {
    el,
    destroy() {
      alive = false;
      off();
      offW();
    },
  };
}
