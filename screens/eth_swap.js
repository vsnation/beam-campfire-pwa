/* Buy WBEAM (Ethereum Home -> Buy WBEAM, or Buy -> WBEAM on Ethereum)
 * Spec: ONE job: swap ETH for WBEAM (or back, or between the wallet's Ethereum tokens) on Uniswap,
 *       from this wallet, directly on Uniswap's own contracts.
 *       Primary CTA: the outcome, "Swap 0.01 ETH for ≈256.7 WBEAM"; "Allow 128.34 WBEAM" comes first,
 *       once, for a token Uniswap may not move yet; then the review sheet and Face ID / password.
 *       Taps from app open: Ethereum (1) -> Buy WBEAM (2) -> type an amount -> the button (3).
 * Exit-intent reasons and answers:
 *   - "Why is the button grey?" -> every disabled state says why right above it (no amount, not
 *     enough of the token, not enough ETH for the network fee, no pool, still pricing).
 *   - "Is it still working?" -> "Getting the best price from every Uniswap pool…" while the pools
 *     are read; the route that wins is named ("ETH → WBEAM · v4 · 1%").
 *   - "Will I get a bad price?" -> the rate in plain words, the price change from the swap (amber
 *     from 3%, a tick box from 10%), and "at least …" under the price protection.
 *   - "What does it cost?" -> the network fee in ETH before anything is signed.
 *   - "I wanted BEAM in my BEAM wallet" -> one link at the top.
 *   - "Which pools?" -> beside the form on a wide screen; one tap away on a phone.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { parseUnits, toInputString } from '../lib/eth/units.js';
import { compactUnits, percentText } from '../lib/compact.js';
import { UniswapNoRoute } from '../lib/eth/uniswap/quoter.js';
import { DEFAULT_SLIPPAGE, IMPACT_WARNING, IMPACT_BLOCK, PERMIT_GAS, UniPriceMoved, UniRouteChanged } from '../lib/eth/uniswap/service.js';
import { EthRpcError } from '../lib/eth/rpc.js';
import { SWAP_TOKENS, WBEAM_TOKEN, uniswapFor, walletAsset } from '../lib/eth/uniswap_app.js';
import { serverProblem } from './eth_ui.js';
import { amtShown, short, ethAbout, bipsText, rateText, routeText, routeNote, kv, tokenBadge, loadPools, poolsList, pickSlippage, openAllowSheet, openReviewSheet, impactBlock } from './eth_swap_parts.js';

const QUOTE_DELAY_MS = 500;
const WIDE = '(min-width: 900px)';

const bySymbol = (s) => SWAP_TOKENS.find((t) => t.symbol === s) || null;

export default function ethSwap(app, params = {}) {
  const draft = (app.uniDraft = app.uniDraft || { pay: 'ETH', receive: 'WBEAM', amount: '', slippage: DEFAULT_SLIPPAGE });
  if (params.pay && bySymbol(params.pay)) draft.pay = params.pay;
  if (params.receive && bySymbol(params.receive)) draft.receive = params.receive;
  let w = null;
  let svc = null;
  let fees = null;
  let quote = null;
  let quoting = false;
  let problem = null; // {code, detail}
  let message = null; // a notice after a refused review
  let impactAck = false;
  let busy = null; // what the button is waiting for, in words
  let loadError = null;
  let pools = { key: null, rows: null, error: null };
  let seq = 0;
  let timer = null;
  let alive = true;

  const pay = () => bySymbol(draft.pay);
  const receive = () => bySymbol(draft.receive);

  const payInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount to pay', 'data-testid': 'uni-pay-amount' });
  payInput.value = draft.amount;
  const payBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'uni-pay-token', onclick: () => pickToken(true) });
  const getBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'uni-receive-token', onclick: () => pickToken(false) });
  const getAmount = h('div', { class: 'swap-out', 'data-testid': 'uni-receive-amount' });
  const paySub = h('div', { class: 'swap-sub' });
  const getSub = h('div', { class: 'swap-sub' });
  const flipBtn = h('button', { class: 'swap-flip', type: 'button', 'aria-label': 'Swap the two tokens', 'data-testid': 'uni-flip', onclick: flip }, icon('swap'));
  const notesBox = h('div', { class: 'swap-notes' });
  const detailsBox = h('div');
  const reason = h('p', { class: 'hint center', 'data-testid': 'uni-reason', 'aria-live': 'polite' });
  const cta = primary('Swap', swapNow, { disabled: true, class: 'btn btn-primary wrap', 'data-testid': 'uni-swap-cta' });
  const poolsPanel = h('div', { class: 'stack', 'data-testid': 'uni-pools-panel' });
  const poolsBtn = h('button', { class: 'btn btn-text btn-small pools-btn', type: 'button', 'data-testid': 'uni-open-pools', onclick: openPools }, 'Pools');
  const wide = window.matchMedia(WIDE);

  // ------------------------------------------------------------ amounts
  function amountState() {
    const t = payInput.value.trim();
    if (!t) return { value: null, error: null };
    try {
      const v = parseUnits(t, pay().decimals, { symbol: pay().symbol });
      return v > 0n ? { value: v, error: null } : { value: null, error: 'The amount must be more than zero.' };
    } catch (e) {
      return { value: null, error: e.message };
    }
  }

  const balanceOf = (t) => {
    if (!w) return null;
    if (t.isEth) return w.state.eth;
    const v = w.state.tokens.get(t.symbol);
    return v === undefined ? null : v;
  };

  /** The network fee the swap will most likely cost (the review measures it exactly). */
  function expectedFee(q) {
    if (!fees) return null;
    return (q.gasEstimate + (pay().isEth ? 0n : PERMIT_GAS)) * (fees.baseFee + fees.maxPriorityFeePerGas);
  }

  /** ETH to keep for the swap's network fee: twice a usual swap at today's fees, never under 0.0005 ETH. */
  function gasReserve() {
    const floor = 5n * 10n ** 14n;
    if (!fees) return floor;
    const v = 600000n * fees.maxFeePerGas;
    return v > floor ? v : floor;
  }

  // ------------------------------------------------------------ the button
  function ctaState() {
    const p = pay();
    if (loadError) return { off: '' };
    if (busy) return { off: busy };
    if (!w || !svc) return { off: 'Opening your Ethereum wallet…' };
    const a = amountState();
    if (a.error) return { off: a.error };
    if (a.value == null) return { off: `Enter how much ${p.symbol} to swap.` };
    const have = balanceOf(p);
    if (have != null && a.value > have) return { off: `Not enough ${p.symbol}. You have ${short(have, p)}.` };
    if (problem) return { off: '' };
    if (quoting || !quote) return { off: 'Getting the best price from every Uniswap pool…' };
    const fee = expectedFee(quote);
    const eth = w.state.eth;
    if (fee != null && eth != null) {
      const need = (p.isEth ? a.value : 0n) + fee;
      if (need > eth) return { off: p.isEth ? `Not enough ETH. You need about ${ethAbout(need)} with the network fee.` : `You need about ${ethAbout(fee)} for the network fee. You have ${ethAbout(eth)}.` };
    }
    if ((quote.priceImpact ?? 0) >= IMPACT_BLOCK && !impactAck) return { off: 'Tick the box to accept the price change.' };
    return { off: null };
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!alive) return;
    const p = pay();
    const r = receive();
    titleEl.textContent = r === WBEAM_TOKEN ? 'Buy WBEAM' : 'Swap on Uniswap';
    put(payBtn, tokenBadge(p, 'small'), h('span', { text: p.symbol }), icon('down'));
    put(getBtn, tokenBadge(r, 'small'), h('span', { text: r.symbol }), icon('down'));
    const have = balanceOf(p);
    put(paySub, h('span', { class: 'grow', 'data-testid': 'uni-pay-balance', text: have == null ? 'Balance …' : `Balance ${short(have, p)}` }), h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'uni-max', onclick: useMax, disabled: have == null }, 'Max'));
    const a = amountState();
    const quoted = Boolean(quote && !quoting && a.value != null);
    getAmount.textContent = quoted ? `≈ ${compactUnits(quote.amountOut, r.decimals)}` : quoting ? '…' : '0';
    getAmount.classList.toggle('muted', !quoted);
    getAmount.dataset.units = quoted ? String(quote.amountOut) : '';
    const haveR = balanceOf(r);
    put(getSub, h('span', { class: 'grow', text: quoted ? `${amtShown(quote.amountOut, r).replace(/^≈/, 'About ')} at today's price` : haveR == null ? '' : `Balance ${short(haveR, r)}` }));

    const n = [];
    if (loadError) n.push(loadError);
    if (w && w.state.eth === 0n) {
      // Never a dead end: a swap is paid for, and its network fee always is, in ETH.
      const none = notice('info', h('strong', { text: 'This wallet has no ETH yet. ' }), 'Swaps on Ethereum are paid in ETH, and so is their network fee.', h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'uni-receive-eth', onclick: () => app.go('ethReceive') }, 'Receive ETH')));
      none.dataset.testid = 'uni-no-eth';
      n.push(none);
    }
    if (message) n.push(message);
    if (problem) n.push(problemNotice());
    if (quoted && (quote.priceImpact ?? 0) >= IMPACT_WARNING) n.push(...impactNotice(quote));
    put(notesBox, ...n);
    put(detailsBox, quoted ? details(quote) : null);

    const st = ctaState();
    cta.disabled = st.off !== null;
    // The outcome, rounded to what people read (every digit is on the review).
    cta.textContent = a.value == null || a.error ? 'Swap' : quoted ? `Swap ${compactUnits(a.value, p.decimals)} ${p.symbol} for ≈${compactUnits(quote.amountOut, r.decimals)} ${r.symbol}` : `Swap ${compactUnits(a.value, p.decimals)} ${p.symbol}`;
    payInput.classList.toggle('long', payInput.value.length > 9);
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
    renderPools();
  }

  function details(q) {
    const fee = expectedFee(q);
    const min = q.minimumOut(draft.slippage);
    return h(
      'div',
      { class: 'card flat swap-details', 'data-testid': 'uni-details' },
      kv('Rate', rateText(q), { 'data-testid': 'uni-rate' }),
      h('button', { class: 'kv kv-tap', type: 'button', onclick: openPools, 'data-testid': 'uni-route' }, h('span', { class: 'k', text: 'Route' }), h('span', { class: 'v' }, routeText(q), h('div', { class: 'small', 'data-testid': 'uni-route-pools', text: routeNote(q) }))),
      kv('Price change from your swap', q.priceImpact == null ? 'Unknown' : percentText(q.priceImpact), { 'data-testid': 'uni-impact', class: `v${(q.priceImpact ?? 0) >= IMPACT_WARNING ? ' bad' : ''}` }),
      h(
        'button',
        { class: 'kv kv-tap', type: 'button', onclick: chooseSlippage, 'data-testid': 'uni-protection', title: 'Also called slippage tolerance' },
        h('span', { class: 'k' }, 'Price protection ', icon('info', 'inline-icon')),
        h('span', { class: 'v' }, h('span', { 'data-testid': 'uni-protection-value', text: bipsText(draft.slippage) }), h('div', { class: 'small', 'data-testid': 'uni-minimum', text: `At least ${short(min, q.tokenOut)}` })),
      ),
      kv('Network fee', fee == null ? 'Measured on the next step' : `about ${ethAbout(fee)}`, { 'data-testid': 'uni-network-fee' }),
    );
  }

  function impactNotice(q) {
    return impactBlock(q, q.priceImpact >= IMPACT_BLOCK, impactAck, (v) => {
      impactAck = v;
      render();
    });
  }

  function problemNotice() {
    const p = pay().symbol;
    const r = receive().symbol;
    let el;
    switch (problem.code) {
      case 'sameAsset':
        el = notice('info', h('strong', { text: `${p} and ${r} are the same coin. ` }), 'Pick something else to receive.');
        break;
      case 'tooSmall':
        el = notice('info', h('strong', { text: `Too small to get any ${r}. ` }), 'After the pool fee nothing is left. Try a larger amount.');
        break;
      case 'noPool':
        el = notice('info', h('strong', { text: `No Uniswap pool trades ${p} for ${r}. ` }), 'BEAM Campfire looked at every Uniswap pool between them, and at routes through ETH, USDC, USDT, DAI, WBTC and WBEAM. Pick another token.');
        break;
      default:
        el = notice('error', h('strong', { text: "Couldn't reach Uniswap. " }), `Your Ethereum server did not answer${problem.detail ? ` ("${problem.detail}")` : ''}. This is not something you did, and nothing was sent.`, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'uni-retry', onclick: () => requoteSoon(0) }, 'Try again')));
    }
    el.dataset.testid = `uni-problem-${problem.code}`;
    return el;
  }

  // ------------------------------------------------------------ quotes
  function requoteSoon(ms = QUOTE_DELAY_MS) {
    clearTimeout(timer);
    seq++;
    quote = null;
    problem = null;
    impactAck = false;
    const a = amountState();
    quoting = Boolean(a.value != null && svc);
    render();
    if (quoting) timer = setTimeout(requote, ms);
  }

  async function requote() {
    const a = amountState();
    if (a.value == null || !svc) return;
    const mine = ++seq;
    quoting = true;
    render();
    try {
      const q = await svc.quote({ tokenIn: pay(), tokenOut: receive(), amountIn: a.value, owner: w.state.address });
      if (!alive || mine !== seq) return;
      quote = q;
      problem = null;
    } catch (e) {
      if (!alive || mine !== seq) return;
      quote = null;
      problem = e instanceof UniswapNoRoute ? { code: e.reason } : { code: 'failed', detail: e instanceof EthRpcError ? e.message : null };
    }
    quoting = false;
    render();
  }

  // ------------------------------------------------------------ pools
  function poolsKey() {
    return `${pay().symbol}>${receive().symbol}`;
  }

  async function refreshPools() {
    if (!svc) return;
    const key = poolsKey();
    pools = { key, rows: null, error: null };
    renderPools();
    try {
      const rows = await loadPools(svc, pay(), receive());
      if (!alive || pools.key !== key) return;
      pools = { key, rows, error: null };
    } catch (e) {
      if (!alive || pools.key !== key) return;
      pools = { key, rows: null, error: e };
    }
    renderPools();
    if (poolsSheet && !poolsSheet.closed) poolsSheet.rerender();
  }

  function poolsView() {
    return poolsList({ rows: pools.rows, error: pools.error, a: pay(), b: receive(), quote, retry: refreshPools });
  }

  function renderPools() {
    if (!wide.matches) return put(poolsPanel);
    if (pools.key !== poolsKey() && svc) {
      refreshPools();
      return;
    }
    put(poolsPanel, h('h2', { class: 'panel-title', text: 'Uniswap pools' }), ...poolsView());
  }

  let poolsSheet = null;
  function openPools() {
    if (wide.matches) return;
    if (pools.key !== poolsKey()) refreshPools();
    poolsSheet = openSheet((close) => [h('h2', { text: 'Uniswap pools' }), h('div', { class: 'stack pools-sheet', 'data-testid': 'uni-pools-sheet' }, ...poolsView()), h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close')], { label: 'Uniswap pools' });
  }

  // ------------------------------------------------------------ actions
  function useMax() {
    const p = pay();
    let max = balanceOf(p) ?? 0n;
    if (p.isEth) {
      const reserve = gasReserve();
      max = max > reserve ? max - reserve : 0n;
    }
    payInput.value = toInputString(max, p.decimals);
    draft.amount = payInput.value;
    message = null;
    requoteSoon(0);
  }

  function flip() {
    const p = draft.pay;
    draft.pay = draft.receive;
    draft.receive = p;
    message = null;
    requoteSoon(0);
    refreshBalances();
  }

  function pickToken(paySide) {
    const current = paySide ? pay() : receive();
    openSheet(
      (close) => [
        h('h2', { text: paySide ? 'You pay with' : 'You receive' }),
        h(
          'div',
          { class: 'card list picker-list' },
          ...SWAP_TOKENS.map((t) => {
            const bal = balanceOf(t);
            const asset = walletAsset(t);
            return h('button', { class: `row${t === current ? ' on' : ''}`, 'data-testid': 'uni-token-row', 'data-symbol': t.symbol, onclick: () => close(t.symbol) }, tokenBadge(t), h('span', { class: 'main' }, h('div', { class: 't', text: t.symbol }), h('div', { class: 's', text: t.symbol === 'WBEAM' ? 'BEAM on Ethereum' : asset ? asset.name : t.symbol })), bal != null && bal > 0n ? h('span', { class: 'end small', text: compactUnits(bal, t.decimals) }) : null);
          }),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ],
      { label: paySide ? 'You pay with' : 'You receive' },
    ).then((sym) => {
      if (!sym || !alive) return;
      if (paySide) {
        if (sym === draft.receive) draft.receive = draft.pay;
        draft.pay = sym;
      } else {
        if (sym === draft.pay) draft.pay = draft.receive;
        draft.receive = sym;
      }
      message = null;
      requoteSoon(0);
      refreshBalances();
    });
  }

  async function chooseSlippage() {
    const b = await pickSlippage(draft.slippage);
    if (b && alive) {
      draft.slippage = b;
      render();
    }
  }

  async function swapNow() {
    const q = quote;
    if (!q || busy || ctaState().off !== null) return;
    message = null;
    busy = 'Checking what Uniswap may take…';
    render();
    try {
      const approval = await svc.approvalFor(q, w.state.address);
      if (!alive) return;
      if (approval.kind !== 'none') {
        busy = null;
        render();
        const ok = await openAllowSheet(app, { w, svc, approval });
        if (!ok || !alive) return;
        refreshBalances();
      }
      busy = 'Checking the price again…';
      render();
      const review = await svc.reviewSwap({ quote: q, slippageBips: draft.slippage, owner: w.state.address });
      if (!alive) return;
      busy = null;
      render();
      const hash = await openReviewSheet(app, { w, svc, review, acceptImpact: impactAck });
      if (!alive) return;
      if (hash) {
        app.uniDraft = { ...draft, amount: '' };
        app.go('ethSwapTx', { hash });
        return;
      }
      // Back without swapping: the price is minutes old by now.
      requoteSoon(0);
    } catch (e) {
      if (!alive) return;
      busy = null;
      if (e instanceof UniRouteChanged) {
        quote = e.quote;
        message = notice('info', 'The best-looking pool would not actually trade, so BEAM Campfire left it out. Here is the next best price; nothing was sent.');
      } else if (e instanceof UniPriceMoved) {
        quote = e.fresh;
        message = notice('warn', `The price moved ${percentText(e.moved)} since your quote, more than your ${bipsText(draft.slippage)} price protection. Here is the new price; nothing was sent.`);
        message.dataset.testid = 'uni-price-moved';
      } else {
        problem = { code: 'failed', detail: e instanceof EthRpcError ? e.message : e.message };
      }
    } finally {
      if (alive && busy) {
        busy = null;
      }
      if (alive) render();
    }
  }

  async function refreshBalances() {
    if (!w) return;
    await w.refresh().catch(() => {});
    if (alive) render();
  }

  payInput.addEventListener('input', () => {
    draft.amount = payInput.value;
    message = null;
    requoteSoon();
  });
  const onWide = () => render();
  wide.addEventListener('change', onWide);

  const intro = h('p', { class: 'small', text: "Straight to Uniswap's own contracts, priced through your Ethereum server. No middleman." });
  const wantBeam = h('button', { class: 'btn btn-text link-left', 'data-testid': 'uni-buy-native-beam', onclick: () => app.go('buyBeam', { from: 'eth' }) }, 'Want BEAM in your BEAM wallet instead?');
  const form = h(
    'div',
    { class: 'uni-form' },
    intro,
    wantBeam,
    h(
      'div',
      { class: 'swap-pair' },
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You pay' }), h('div', { class: 'swap-line' }, payInput, payBtn), paySub),
      flipBtn,
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You receive' }), h('div', { class: 'swap-line' }, getAmount, getBtn), getSub),
    ),
    notesBox,
    detailsBox,
    h('div', { class: 'actions' }, reason, cta),
  );
  const el = screen(
    {
      title: 'Buy WBEAM',
      back: () => {
        app.uniDraft = null;
        app.go('ethHome');
      },
      right: poolsBtn,
      cls: 'swap uni sticky-actions',
    },
    h('div', { class: 'uni-split' }, form, h('aside', { class: 'uni-pools' }, poolsPanel)),
  );
  const titleEl = el.querySelector('.topbar h1');

  (async () => {
    try {
      w = await ethWallet(app);
    } catch (e) {
      loadError = notice('error', `The Ethereum wallet could not be opened: ${e.message}`);
      return render();
    }
    if (!alive) return;
    if (!w) return app.go('ethStart');
    try {
      svc = await uniswapFor(w);
    } catch (e) {
      loadError = notice('error', `Uniswap's pool list could not be loaded: ${e.message}. Go back and try again.`);
      return render();
    }
    if (!alive) return;
    render();
    requoteSoon(0);
    refreshBalances();
    try {
      fees = await svc.fees();
    } catch (e) {
      loadError = serverProblem(app, e, { retry: () => app.go('ethSwap'), switched: () => app.go('ethSwap') });
    }
    if (alive) render();
  })();
  render();

  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      wide.removeEventListener('change', onWide);
    },
  };
}
