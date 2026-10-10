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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05 today" or "14:05 on 9 Oct". */
export function untilText(ms, now = Date.now()) {
  const t = new Date(ms);
  const n = new Date(now);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (t.toDateString() === n.toDateString()) return `${hm} today`;
  return `${hm} on ${t.getDate()} ${MONTHS[t.getMonth()]}`;
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
    if (await copyText(text, amount ? 'Amount copied' : 'Address copied')) {
      if (amount) amountCopied = true;
      else copied = true;
      render();
    }
  };

  function payment(o) {
    return [
      notice('warn', h('span', { 'data-testid': 'buy-network-warning', text: `Send only ${o.symbol} on the ${o.chainName} network to this address.` })),
      h('div', { class: 'qr qr-small', 'data-testid': 'buy-qr' }, qrElement(o.depositAddress)),
      h(
        'div',
        { class: 'card address-box' },
        h('div', { class: 'banner' }, coinBadge(o.assetId, o.symbol, 'small'), h('span', { class: 'grow small', text: `${o.chainName} deposit address` }), h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-address', onclick: () => copy(o.depositAddress) }, icon('copy'), copied ? 'Copied' : 'Copy')),
        h('p', { class: 'mono', 'data-testid': 'buy-deposit-address', text: o.depositAddress }),
      ),
      h(
        'div',
        { class: 'card banner exact-amount' },
        h('div', { class: 'grow' }, h('div', { class: 'small', text: 'Send exactly' }), h('div', { class: 'big', 'data-testid': 'buy-exact-amount', text: `${o.sendAmount} ${o.symbol}` })),
        h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-amount', onclick: () => copy(o.sendAmount, true) }, icon('copy'), amountCopied ? 'Copied' : 'Copy'),
      ),
      o.deadline ? h('p', { class: 'small', 'data-testid': 'buy-deadline', text: `This address works until ${untilText(o.deadline)}.` }) : null,
    ];
  }

  function stateNotice(o, s, arrived) {
    const got = o.beamEstimate == null ? 'Your BEAM' : `≈\u00a0${beamText(groth(o.beamEstimate))}`;
    const n = (kind, key, title, detail) => {
      const el = notice(kind, h('strong', { text: `${title} ` }), detail || '');
      el.dataset.testid = key;
      return el;
    };
    switch (s) {
      case 'delivered':
        return arrived ? n('success', 'buy-arrived', 'Your BEAM has arrived.', `${got} is in your BEAM wallet.`) : n('info', 'buy-delivered', 'buybeam.my sent your BEAM.', `${got} shows in your BEAM wallet as soon as BEAM Campfire accepts it: keep it open.`);
      case 'refunded':
        return n('warn', 'buy-refunded', `Your payment was sent back to ${shorten(o.refundAddress, 6, 4)}.`, `buybeam.my couldn't buy the BEAM, so your ${o.symbol} went back to your ${o.chainName} address. There is nothing else to do.`);
      case 'expired':
        return n('warn', 'buy-expired', 'No payment arrived in time. Nothing was taken.', 'This address no longer takes payments. Start a new buy to get a new one.');
      case 'failed':
        return n('error', 'buy-failed', "The payment couldn't be processed.", 'Contact buybeam.my support with this order (copy it below). They can see where your coins are.');
      case 'attention':
        return n('warn', 'buy-attention', 'buybeam.my is checking this order.', 'Contact their support with this order (copy it below). BEAM Campfire keeps checking meanwhile.');
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
      kv(paid ? 'You paid' : 'You pay', `${o.sendAmount} ${o.symbol}`),
      o.beamEstimate != null ? kv(arrived ? 'You got' : 'You get', `≈ ${beamText(groth(o.beamEstimate))}`, { 'data-testid': 'buy-order-estimate' }) : null,
      kv('Arrives in', 'Your BEAM wallet'),
      kv('Refunds go to', shorten(o.refundAddress, 6, 4), { class: 'v mono' }),
      s !== 'awaiting_deposit' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Order' }), h('button', { class: 'v mono btn-text', 'data-testid': 'buy-copy-order', onclick: () => copy(o.depositAddress), text: shorten(o.depositAddress, 6, 4) })) : null,
      o.beamTxId ? kv('BEAM transaction', shorten(o.beamTxId, 6, 4), { class: 'v mono', 'data-testid': 'buy-beam-tx' }) : null,
    );
  }

  function render() {
    if (!alive) return;
    const o = c.order(deposit);
    if (!o) {
      put(body, c.loadError ? notice('error', `Your buys could not be opened: ${c.loadError.message}`) : h('p', { class: 'small', text: 'Loading your buy…' }));
      put(actions, primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'buy-order-cta' }));
      return;
    }
    const s = o.lastState || 'awaiting_deposit';
    const arrived = s === 'delivered' && receivedInWallet(o.beamTxId);
    titleEl.textContent = s === 'awaiting_deposit' ? `Send ${o.sendAmount} ${o.symbol}` : 'Buy BEAM';
    const pollError = c.pollError(deposit);
    put(
      body,
      o.sandbox ? notice('info', "buybeam.my's test mode: nothing to pay.") : null,
      stateNotice(o, s, arrived),
      ...(s === 'awaiting_deposit' ? payment(o) : []),
      steps(s, arrived),
      details(o, s, arrived),
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-keep-open', text: 'Keep BEAM Campfire open until your BEAM arrives. If you close it, open it again within 12 hours.' }) : null,
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-can-leave', text: 'You can leave this screen: your buy keeps going.' }) : null,
      pollError && o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-poll-error', text: pollError.unreachable ? "Couldn't reach buybeam.my just now. BEAM Campfire keeps checking." : "buybeam.my's last answer didn't make sense. BEAM Campfire keeps checking." }) : null,
    );
    let cta;
    if (s === 'awaiting_deposit') cta = primary(h('span', { text: copied ? 'Address copied' : 'Copy address' }), () => copy(o.depositAddress), { 'data-testid': 'buy-order-cta' });
    else if (s === 'delivered' && arrived) cta = primary('See it in your wallet', () => app.go('activity', { txId: o.beamTxId }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'expired') cta = primary('Start a new buy', () => app.go('buyBeam', {}, { replace: true }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'failed' || s === 'attention') cta = h('a', { class: 'btn btn-primary', href: buySiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'buy-order-cta' }, 'Contact buybeam.my support');
    else cta = primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'buy-order-cta' });
    if (s === 'awaiting_deposit') cta.prepend(icon('copy'));
    put(actions, cta);
    root.dataset.state = s;
  }

  const el = screen({ title: 'Buy BEAM', back: () => app.back(params.from === 'list' ? 'buyOrders' : 'home'), actions: [actions], cls: 'buy-order sticky-actions' }, body);
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
