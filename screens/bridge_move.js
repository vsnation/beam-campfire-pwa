/* Move coins (the ⇄ beside BEAM | Ethereum on both Homes; "Move to BEAM" on Ethereum Home)
 * Spec: ONE job: choose how much to move between your own BEAM wallet and your own Ethereum wallet,
 *       and see what arrives, where, what it costs and when, before anything is signed.
 *       Primary CTA: the outcome, "Move 300 BEAM to Ethereum" / "Move 0.5 ETH to BEAM"; with no
 *       Ethereum wallet, "Create an Ethereum wallet".
 *       Taps from app open: ⇄ (1), type the amount, the button (2), then the review with Face ID or
 *       password (3).
 * Exit-intent reasons and answers:
 *   - "Where does it go?" -> the To box names your own wallet (and its address); no address is typed.
 *   - "What does it cost?" -> the bridge fee (paid to the bridge operator), each network fee and the
 *     limits are on screen before anything is typed; the line under "You receive" sums them up.
 *   - "How long?" -> about an hour to Ethereum (up to hours when Ethereum is busy), about 2 minutes to
 *     BEAM and then you collect it.
 *   - "Why is the button grey?" -> the reason is written right above it, and the way out (Receive
 *     BEAM, Receive ETH, Try again, Allow prices) is a button.
 *   - "Why does it want CoinGecko?" -> asked once, saying CoinGecko sees the IP; "Not now" still
 *     leaves WBEAM -> BEAM, which needs no price, and says so.
 *   - "Did my last move arrive?" -> an open move is one tap away at the top, with where it is.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast, assetBadge } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { ROUTES, routeById, SEND_FEE, CLAIM_FEE } from '../lib/bridge/routes.js';
import { ETH, tokenBySymbol } from '../lib/eth/tokens.js';
import { BLOCKS } from '../lib/bridge/quote.js';
import { isOpen } from '../lib/bridge/store.js';
import { ethBadge } from './eth_ui.js';
import { openBridgeReview } from './bridge_review.js';
import { bridgeOf, bridgeProblem, pricesChoice, priceQuestion, pricesOff } from './bridge_ui.js';
import { headline, crossingWords } from './bridge_words.js';
import {
  TO_ETHEREUM,
  TO_BEAM,
  coin,
  exact,
  rounded,
  roundedUp,
  feeText,
  parseBridgeAmount,
  moveLabel,
  limitsText,
  needsPrices,
  arrivesText,
  coinLabel,
  sourceSymbol,
  sourceDecimals,
  destinationSymbol,
  destinationDecimals,
  about,
  ABOUT_TO_ETHEREUM_MS,
  ABOUT_TO_BEAM_MS,
} from './bridge_text.js';

const QUOTE_DELAY_MS = 400;
/** A quote older than this is worked out again when the button is tapped. */
const QUOTE_FRESH_MS = 60000;

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "≈ $0.57" from the prices the fee was worked out with; null without them. */
function usd(prices, id, units, decimals) {
  const per = prices && prices.usd ? prices.usd[id] : null;
  if (!per) return null;
  const v = (Number(units) / 10 ** decimals) * per;
  if (!Number.isFinite(v)) return null;
  if (v < 0.01) return 'under $0.01';
  return `≈ $${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`;
}

export default function bridgeMove(app, params = {}) {
  const draft = (app.bridgeDraft = app.bridgeDraft || { route: 'beam', dir: TO_ETHEREUM, amount: '' });
  if (params.dir === TO_ETHEREUM || params.dir === TO_BEAM) draft.dir = params.dir;
  if (params.route && ROUTES.some((r) => r.id === params.route)) draft.route = params.route;
  if (params.back === 'ethHome' || params.back === 'home') draft.back = params.back;
  const back = draft.back === 'ethHome' ? 'ethHome' : 'home';

  let s = null; // the bridge session (bridge_ui.js)
  let noEth = false;
  let openError = null;
  let cond = null; // conditions for draft.route/dir
  let condFor = null;
  let bal = null;
  let balFor = null;
  let quote = null;
  let quoting = false;
  let busy = false;
  let error = null; // {title, detail}
  let seq = 0;
  let timer = null;
  let alive = true;
  let offCtl = null;

  const route = () => routeById(draft.route);
  const toEth = () => draft.dir === TO_ETHEREUM;
  const key = () => `${draft.route}-${draft.dir}`;

  // ------------------------------------------------------------ elements
  const input = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount to move', 'data-testid': 'bridge-amount' });
  input.value = draft.amount;
  const openBox = h('div');
  const chips = h('div', { class: 'bridge-chips', role: 'radiogroup', 'aria-label': 'Coin' });
  const fromLabel = h('div', { class: 'swap-label' });
  const fromCoin = h('span', { class: 'asset-pick static' });
  const fromSub = h('div', { class: 'swap-sub' });
  const toLabel = h('div', { class: 'swap-label', 'data-testid': 'bridge-to' });
  const toAmount = h('div', { class: 'swap-out', 'data-testid': 'bridge-receive' });
  const toCoin = h('span', { class: 'asset-pick static' });
  const toSub = h('div', { class: 'swap-sub bridge-costs', 'data-testid': 'bridge-costs' });
  const limits = h('p', { class: 'hint', 'data-testid': 'bridge-limits' });
  const notes = h('div', { class: 'swap-notes' });
  const details = h('div', { class: 'card flat swap-details', 'data-testid': 'bridge-details' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'bridge-reason', 'aria-live': 'polite' });
  const cta = primary('Move', onMove, { disabled: true, 'data-testid': 'bridge-cta', class: 'btn btn-primary wrap' });
  const flipBtn = h('button', { class: 'swap-flip', type: 'button', 'aria-label': 'Change direction', 'data-testid': 'bridge-flip', onclick: flip }, icon('swap'));
  const history = h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'bridge-history', onclick: () => app.go('bridgeList', { back: 'bridgeMove' }) }, 'History');
  const body = h('div', { class: 'stack' });

  // ------------------------------------------------------------ state
  function amountState() {
    return parseBridgeAmount(input.value, route(), draft.dir);
  }

  function priceGate() {
    if (!needsPrices(route(), draft.dir)) return null;
    const c = pricesChoice(app);
    return c === true ? null : c === null ? 'ask' : 'off';
  }

  function ctaState() {
    const r = route();
    const sym = sourceSymbol(r, draft.dir);
    if (openError) return { off: "The bridge couldn't open. Try again above." };
    if (!s) return { off: 'Opening the bridge…' };
    if (busy) return { off: 'Getting it ready…' };
    if (toEth() && !wallet.state.sync.canSend) return { off: `Moving to Ethereum is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` };
    const gate = priceGate();
    if (gate === 'ask') return { off: 'Allow prices above to see the bridge fee.' };
    if (gate === 'off') return { off: 'Prices are off, so this move cannot be priced.' };
    const a = amountState();
    if (a.error) return { off: a.error };
    if (a.value == null || a.value <= 0n) return { off: `Enter how much ${sym} to move.` };
    if (quoting || !quote) return { off: 'Working out the fees…' };
    if (quote.block) return { off: quote.block.title.replace(/\.?$/, '.') };
    return { off: null };
  }

  // ------------------------------------------------------------ render
  function coinPill(onBeam) {
    const r = route();
    if (onBeam) return [assetBadge(wallet.label(r.beamAssetId), { size: 'small' }), h('span', { text: r.beamSymbol })];
    const t = r.isNativeEth ? ETH : tokenBySymbol(r.ethSymbol);
    return [ethBadge(t, 'small'), h('span', { text: r.ethSymbol })];
  }

  function render() {
    if (!alive) return;
    const r = route();
    const d = draft.dir;
    const srcSym = sourceSymbol(r, d);
    const srcDec = sourceDecimals(r, d);
    const dstSym = destinationSymbol(r, d);
    const dstDec = destinationDecimals(r, d);
    const ctl = s ? s.ctl : null;

    // An open move, one tap away.
    const open = ctl ? ctl.crossings.filter(isOpen) : [];
    history.textContent = open.length ? `History (${open.length})` : 'History';
    if (open.length) {
      const c = open[0];
      const w = crossingWords(c, { blocksLeft: ctl.blocksLeft(c) });
      put(
        openBox,
        h(
          'button',
          { class: 'card row bridge-open', 'data-testid': 'bridge-open-crossing', 'data-id': c.id, onclick: () => app.go('bridgeCrossing', { id: c.id, back: 'bridgeMove' }) },
          h('span', { class: 'ico swap' }, icon(w.needsYou ? 'download' : 'clock')),
          h('span', { class: 'main' }, h('div', { class: 't', text: headline(c) }), h('div', { class: 's' }, h('span', { class: `bridge-short ${w.needsYou ? 'you' : `mood-${w.mood}`}`, text: w.short }))),
          h('span', { class: 'chev' }, icon('chevron')),
        ),
      );
    } else put(openBox);

    put(
      chips,
      ...ROUTES.map((x) =>
        h(
          'button',
          { class: `choice${x.id === draft.route ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(x.id === draft.route), 'data-testid': `bridge-route-${x.id}`, onclick: () => pickRoute(x.id) },
          coinLabel(x),
        ),
      ),
    );

    // From
    const ethAddr = s ? s.w.state.address : null;
    fromLabel.textContent = toEth() ? 'From your BEAM wallet' : 'From your Ethereum wallet';
    put(fromCoin, ...coinPill(toEth()));
    const have = bal && balFor === key() ? bal.source : null;
    put(
      fromSub,
      h('span', { class: 'grow', 'data-testid': 'bridge-balance', text: have == null ? (s ? 'Available: …' : '') : `Available: ${rounded(have, srcDec, 8)} ${srcSym}` }),
      s ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'bridge-max', onclick: useMax }, 'Max') : null,
    );

    // To
    put(toLabel, toEth() ? 'To your Ethereum wallet' : 'To your BEAM wallet', ethAddr && toEth() ? h('span', { class: 'mono addr', text: ` ${shortAddr(ethAddr)}` }) : null);
    put(toCoin, ...coinPill(!toEth()));
    const a = amountState();
    const q = quote && !quoting && a.value != null && quote.route === r && quote.direction === d ? quote : null;
    const receives = q ? q.receives : null;
    toAmount.textContent = receives != null ? rounded(receives, dstDec, 8) : quoting ? '…' : '0';
    toAmount.title = receives != null ? coin(receives, dstDec, dstSym) : '';
    toAmount.classList.toggle('muted', receives == null);
    const fee = q ? q.fee : cond && condFor === key() ? cond.fee : null;
    const costs = [];
    if (q && q.fee != null) {
      if (toEth()) costs.push(`Plus ${feeText(q.fee, srcDec)} ${srcSym} bridge fee and ${coin(SEND_FEE, 8, 'BEAM')} network fee. ${about(ABOUT_TO_ETHEREUM_MS)}.`);
      else {
        const gas = q.plan ? `, up to ${roundedUp(q.plan.maxGasCost, 18, 6)} ETH network fee` : '';
        costs.push(`Plus ${feeText(q.fee, srcDec)} ${srcSym} bridge fee${gas}, and ${coin(CLAIM_FEE, 8, 'BEAM')} to collect it. ${about(ABOUT_TO_BEAM_MS)}.`);
      }
    }
    const worth = q ? usd(q.prices, r.coingeckoId, receives, dstDec) : null;
    put(toSub, h('span', { class: 'grow', text: costs[0] || (s ? `You receive ${dstSym}` : '') }), worth ? h('span', { class: 'nowrap', text: worth }) : null);

    // Limits, before anything is typed.
    // Once a quote prices it, the line under "You receive" says it with numbers.
    const lim = s && !(q && q.fee != null) ? limitsText(r, d, fee) : null;
    limits.textContent = lim || '';
    limits.classList.toggle('hidden', !lim);

    // Notices.
    const n = [];
    if (openError) n.push(bridgeProblem(openError, () => start()));
    if (error) n.push(h('div', { 'data-testid': 'bridge-error' }, notice('warn', h('strong', { text: `${error.title} ` }), error.detail || '')));
    if (s) {
      const gate = priceGate();
      if (gate === 'ask') n.push(priceQuestion({ allow: () => choosePrices(true), refuse: () => choosePrices(false) }));
      if (gate === 'off') n.push(pricesOff({ allow: () => choosePrices(true), useWbeam: () => pickRoute('beam', TO_BEAM) }));
      if (toEth() && !wallet.state.sync.canSend) n.push(notice('info', 'Your BEAM wallet is catching up with the network. Moving to Ethereum works once it is up to date.'));
      // Collecting on BEAM needs BEAM: said before typing, not after.
      if (!toEth() && bal && balFor === key() && bal.beam < CLAIM_FEE && !(q && q.block && q.block.code === BLOCKS.noClaimFee)) {
        n.push(blockNotice({ code: BLOCKS.noClaimFee, title: `Your BEAM wallet needs ${coin(CLAIM_FEE, 8, 'BEAM')} to collect it`, detail: `Coins moved to BEAM are collected with a BEAM transaction. Your BEAM wallet has ${coin(bal.beam, 8, 'BEAM')}. Receive a little BEAM first, then move.` }));
      }
      const b = q ? q.block : !gate && cond && condFor === key() && cond.block && cond.block.code !== BLOCKS.noAmount ? cond.block : null;
      if (b && b.code !== BLOCKS.noAmount) n.push(blockNotice(b));
      for (const w of q ? q.warnings : []) n.push(h('div', { 'data-testid': `bridge-warning-${w.code}` }, notice('warn', h('strong', { text: `${w.title}. ` }), w.detail)));
    }
    put(notes, ...n);

    // Details.
    const rows = [];
    const row = (k, v, tid, note = null) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, h('span', { 'data-testid': tid, text: v }), note ? h('div', { class: 'small', text: note }) : null));
    rows.push(row('Bridge fee', fee == null ? (priceGate() ? '—' : s ? '…' : '—') : `${feeText(fee, srcDec)} ${srcSym}`, 'bridge-fee', 'paid to the bridge operator'));
    rows.push(row('BEAM network fee', coin(toEth() ? SEND_FEE : CLAIM_FEE, 8, 'BEAM'), 'bridge-beam-fee', toEth() ? null : 'when you collect it'));
    if (!toEth()) rows.push(row('Ethereum network fee', q && q.plan ? `up to ${roundedUp(q.plan.maxGasCost, 18, 6)} ETH` : 'priced once you type an amount', 'bridge-eth-fee'));
    rows.push(row('Arrives', arrivesText(r, d).replace(/;.*/, ''), 'bridge-time', toEth() ? arrivesText(r, d).replace(/^[^;]*; /, '') : null));
    put(details, ...rows);

    const st = ctaState();
    cta.disabled = Boolean(st.off);
    cta.textContent = moveLabel(r, d, a.value);
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
  }

  function blockNotice(b) {
    const way = {
      [BLOCKS.noClaimFee]: ['Receive BEAM', () => app.go('receive')],
      [BLOCKS.noBeamForFee]: ['Receive BEAM', () => app.go('receive')],
      [BLOCKS.noEthForGas]: ['Receive ETH', () => app.go('ethReceive')],
      [BLOCKS.network]: ['Try again', () => refresh(true)],
      [BLOCKS.noPrice]: ['Try again', () => refresh(true)],
    }[b.code];
    const el = notice(
      b.code === BLOCKS.frozen ? 'error' : 'warn',
      h('strong', { text: `${b.title.replace(/\.?$/, '.')} ` }),
      b.detail || '',
      way ? h('div', { class: 'btn-row prompt-actions' }, secondary(way[0], way[1], { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-block-action' })) : null,
    );
    return h('div', { 'data-testid': 'bridge-block', 'data-code': b.code }, el);
  }

  // ------------------------------------------------------------ reading
  async function loadSide() {
    if (!s) return;
    const k = key();
    const r = route();
    const d = draft.dir;
    const gate = priceGate();
    try {
      const b = await s.ctl.balances(r, d);
      if (!alive || k !== key()) return;
      bal = b;
      balFor = k;
    } catch {
      if (!alive || k !== key()) return;
      bal = null;
    }
    render();
    if (gate) return;
    try {
      const c = await s.ctl.conditions(r, d);
      if (!alive || k !== key()) return;
      cond = c;
      condFor = k;
    } catch {
      /* the quote says why */
    }
    render();
  }

  function requoteSoon(ms = QUOTE_DELAY_MS) {
    clearTimeout(timer);
    seq++;
    quote = null;
    const a = amountState();
    quoting = Boolean(s && a.value != null && a.value > 0n && !priceGate());
    render();
    if (quoting) timer = setTimeout(requote, ms);
  }

  async function requote() {
    const a = amountState();
    if (!s || a.value == null || a.value <= 0n || priceGate()) return null;
    const mine = ++seq;
    quoting = true;
    render();
    let q = null;
    try {
      q = await s.ctl.quote(route(), draft.dir, a.value);
    } catch (e) {
      q = null;
      if (alive && mine === seq) error = { title: "Couldn't work out the fees.", detail: `${e.message} Nothing was sent; try again in a minute.` };
    }
    if (!alive || mine !== seq) return null;
    quote = q;
    quoting = false;
    render();
    return q;
  }

  async function refresh(force = false) {
    if (!s) return;
    error = null;
    if (force) {
      try {
        await s.ctl.conditions(route(), draft.dir, { refresh: true });
      } catch {
        /* shown by the quote */
      }
    }
    await loadSide();
    requoteSoon(0);
  }

  // ------------------------------------------------------------ actions
  function pickRoute(id, dir = draft.dir) {
    draft.route = id;
    draft.dir = dir;
    // Decimals differ per coin: an amount typed for one is not carried to another.
    input.value = '';
    draft.amount = '';
    quote = null;
    error = null;
    render();
    loadSide();
  }

  function flip() {
    draft.dir = toEth() ? TO_BEAM : TO_ETHEREUM;
    input.value = '';
    draft.amount = '';
    quote = null;
    error = null;
    render();
    loadSide();
  }

  async function choosePrices(allowed) {
    await app.setPrefs({ bridgePrices: allowed });
    if (!alive) return;
    toast(allowed ? 'Bridge prices from CoinGecko are on' : 'Bridge prices are off');
    refresh(false);
  }

  async function useMax() {
    if (!s) return;
    const k = key();
    try {
      const max = await s.ctl.maxAmount(route(), draft.dir);
      if (!alive || k !== key()) return;
      input.value = max > 0n ? exact(max, sourceDecimals(route(), draft.dir)).replace(/,/g, '') : '0';
      draft.amount = input.value;
      error = null;
      requoteSoon(0);
    } catch (e) {
      error = { title: "Couldn't work out the most you can move.", detail: e.message };
      render();
    }
  }

  async function onMove() {
    if (busy || ctaState().off) return;
    let q = quote;
    busy = true;
    error = null;
    render();
    try {
      // Numbers older than a minute are worked out again; a changed fee is shown before anything is sent.
      if (Date.now() - q.at > QUOTE_FRESH_MS) {
        busy = false;
        const fresh = await requote();
        if (!alive) return;
        if (!fresh || fresh.block || fresh.fee !== q.fee || fresh.receives !== q.receives) {
          error = { title: 'The fees changed.', detail: 'Check the new numbers, then move.' };
          render();
          return;
        }
        q = fresh;
        busy = true;
        render();
      }
      const p = await s.ctl.prepare(q);
      if (!alive) return;
      if (!toEth()) {
        busy = false;
        render();
        openBridgeReview(app, s, p, {
          onStarted: (c) => {
            app.bridgeDraft = { ...draft, amount: '' };
            app.go('bridgeCrossing', { id: c.id, back: 'bridgeMove', justStarted: true });
          },
        });
        return;
      }
      // To Ethereum the wallet's approve sheet is the review: it shows what the BEAM wallet will do.
      const c = await s.ctl.start(p);
      if (!alive) return;
      busy = false;
      if (c.state === 'failed') {
        error = { title: 'Nothing was sent.', detail: c.lastError || '' };
        render();
        return;
      }
      app.bridgeDraft = { ...draft, amount: '' };
      app.go('bridgeCrossing', { id: c.id, back: 'bridgeMove', justStarted: true });
    } catch (e) {
      if (!alive) return;
      busy = false;
      error = { title: 'Nothing was sent.', detail: `${e.message}${/\.$/.test(e.message || '') ? '' : '.'}` };
      render();
    }
  }

  input.addEventListener('input', () => {
    draft.amount = input.value;
    error = null;
    requoteSoon();
  });
  const offWallet = wallet.onChange(() => render());

  async function start() {
    openError = null;
    render();
    try {
      s = await bridgeOf(app);
    } catch (e) {
      if (!alive) return;
      if (e && e.code === 'locked') return;
      openError = e;
      render();
      return;
    }
    if (!alive) return;
    if (!s) {
      noEth = true;
      return paint();
    }
    if (offCtl) offCtl();
    offCtl = s.ctl.onChange(() => render());
    if (params.created) toast(params.created === 'import' ? 'Ethereum wallet imported' : 'Ethereum wallet ready');
    await loadSide();
    requoteSoon(0);
  }

  // ------------------------------------------------------------ the screen
  const intro = h('p', { class: 'small', text: "Between your own BEAM and Ethereum wallets, through BEAM's official bridge." });
  const form = [
    openBox,
    chips,
    h(
      'div',
      { class: 'swap-pair' },
      h('div', { class: 'card swap-box' }, fromLabel, h('div', { class: 'swap-line' }, input, fromCoin), fromSub),
      flipBtn,
      h('div', { class: 'card swap-box pair-to' }, toLabel, h('div', { class: 'swap-line' }, toAmount, toCoin), toSub),
    ),
    limits,
    notes,
    details,
  ];

  function paint() {
    if (noEth) {
      put(
        body,
        intro,
        h(
          'div',
          { class: 'card empty', 'data-testid': 'bridge-no-eth' },
          icon('bridge'),
          h('h3', { text: 'Add an Ethereum wallet to use the bridge' }),
          h('p', { class: 'small', text: 'The bridge moves coins between your own BEAM wallet and your own Ethereum wallet, so you need one of each. An Ethereum wallet takes a minute to add, here in BEAM Campfire; then you come back here.' }),
        ),
      );
      put(actions, primary('Create an Ethereum wallet', () => app.go('ethStart', { from: 'bridge' }), { 'data-testid': 'bridge-add-eth' }));
      history.classList.add('hidden');
      return;
    }
    put(body, intro, ...form);
    put(actions, reason, cta);
  }

  const actions = h('div', { class: 'actions bridge-actions' }, reason, cta);
  paint();
  render();
  start();

  const el = screen({ title: 'Move coins', back: () => app.go(back), right: history, cls: 'swap bridge' }, body);
  el.appendChild(actions);
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      offWallet();
      if (offCtl) offCtl();
    },
  };
}
