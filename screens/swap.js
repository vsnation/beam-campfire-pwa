/* Swap
 * Spec: ONE job: swap one asset for another on BEAM's DEX.
 *       Primary CTA: "Swap 0.01 BEAM" (the approve sheet that follows shows both amounts and the fee).
 *       Taps from app open: 1 (Home -> Swap), type an amount, 2 ("Swap ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What will I get?" -> a live price 0.5 s after typing stops, from every pool for the pair; the best wins.
 *     "About X, at least Y": Y is what the swap is sure to get - the price protection, and then what
 *     BEAM may still take when it finishes an approved swap at a new price (lib/dex.js leastReceive).
 *   - "What does it cost?" -> the pool's fee and the 0.011 BEAM network fee are on screen before anything.
 *   - "Why is the button grey?" -> the reason is written right above it.
 *   - "What if the price moves?" -> "You get at least Y, or the swap stops and nothing is sent": a built swap whose
 *     worst case is below Y stops before it is shown.
 *   - "A small swap eaten by the fee" -> a warning when the network fee is a quarter or more of the swap.
 *   - "Can I earn from the pools instead?" -> "Pools" in the top bar: add coins to a pool, take them out.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, assetBadge } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { dexApp, loadPools } from '../lib/dex_pools.js';
import { DEX_CALL_FEE, DEFAULT_RECEIVE, KINDS, PROTECTION_BPS, PROTECTIONS, receivable, tradable, bestQuote, tradeArgs, swapExpectation, leastReceive, priceImpactBps, IMPACT_WARN_BPS, feeIsLarge, swapValue, feeShareBps, bpsText, DexError } from '../lib/dex.js';
import { shortAmount } from './consent.js';
import { hiddenIds } from '../lib/hidden_tokens.js';

/** Plain words for whatever stopped a quote or a swap. */
function problemText(e, payUnit, getUnit) {
  const code = e && e.code;
  if (code === 'noPool') return `There is no pool that swaps ${payUnit} for ${getUnit}. Pick another asset.`;
  if (code === 'poolEmpty') return `The ${payUnit}/${getUnit} pool is empty right now. Pick another asset.`;
  if (code === 'tooSmall') return `That amount is too small to get any ${getUnit}. Enter a larger amount.`;
  if (code === 'timeout') return 'The wallet did not answer in time. Check your connection and try again.';
  if (code === 'unexpected' || code === 'shader') return 'The DEX answered something this wallet cannot check, so the swap is off. Try again in a minute.';
  if (code === 'load' || code === 'mismatch') return `${e.message}`;
  return `The price could not be fetched: ${(e && e.message) || e}. Check your connection and try again.`;
}

export default function swap(app) {
  const draft = (app.swapDraft = app.swapDraft || { pay: 0, receive: null, amount: '', protection: Number(PROTECTION_BPS) });
  const protection = () => BigInt(draft.protection ?? Number(PROTECTION_BPS));
  let pools = null;
  let poolsError = null;
  let quote = null;
  let quoting = false;
  let problem = null;
  let preparing = false;
  let result = null; // { kind, text, code, rpc }
  let seq = 0;
  let timer = null;
  let alive = true;

  const payInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount to pay', 'data-testid': 'swap-pay-amount' });
  payInput.value = draft.amount;
  const payAssetBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'swap-pay-asset', onclick: () => pick(true) });
  const getAssetBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'swap-get-asset', onclick: () => pick(false) });
  const getAmount = h('div', { class: 'swap-out', 'data-testid': 'swap-get-amount' });
  const payInfo = h('div', { class: 'swap-sub' });
  // 25% / 50% / 75% / Max of what can be paid (#83); the chip in use stays marked until the
  // amount is typed, the pair is flipped or another asset is chosen.
  const shareRow = h('div', { class: 'share-chips', role: 'group', 'aria-label': 'How much of it' });
  let share = null;
  const getInfo = h('div', { class: 'swap-sub' });
  const details = h('div', { class: 'card flat swap-details' });
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'swap-reason', 'aria-live': 'polite' });
  const cta = primary('Swap', doSwap, { disabled: true, 'data-testid': 'swap-cta' });
  const flipBtn = h('button', { class: 'swap-flip', type: 'button', 'aria-label': 'Swap the two assets', 'data-testid': 'swap-flip', onclick: flip }, icon('swap'));

  const unit = (id) => wallet.label(id).unit;

  function amountState() {
    const t = payInput.value.trim();
    if (!t) return { value: null, error: null };
    try {
      const v = parseAmount(t);
      return v > 0n ? { value: v, error: null } : { value: null, error: 'The amount must be more than zero.' };
    } catch (e) {
      return { value: null, error: e.message };
    }
  }

  function chooseReceive() {
    if (!pools) return;
    const list = receivable(pools, draft.pay);
    if (draft.receive != null && list.includes(draft.receive)) return;
    draft.receive = list.includes(DEFAULT_RECEIVE) ? DEFAULT_RECEIVE : list.find((id) => id !== draft.pay) ?? null;
  }

  // ------------------------------------------------------------ the button and its reason
  function ctaState() {
    const payU = unit(draft.pay);
    if (preparing) return { off: 'Building your swap…' };
    if (!wallet.state.sync.canSend) return { off: `Swaps are paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` };
    if (poolsError) return { off: 'Prices could not be loaded. Try again above.' };
    if (!pools) return { off: 'Loading prices…' };
    if (draft.receive == null) return { off: `Nothing can be bought with ${payU} right now. Pick another asset to pay with.` };
    const a = amountState();
    if (a.error) return { off: a.error };
    if (a.value == null) return { off: `Enter how much ${payU} to swap.` };
    const t = wallet.state.totals.get(draft.pay) || { available: 0n, receiving: 0n };
    if (a.value > t.available) {
      if (t.receiving > 0n && a.value <= t.available + t.receiving) return { off: `${formatAmount(t.receiving)} ${payU} is in a payment that hasn't finished yet; it's yours in about a minute.` };
      return { off: `Not enough ${payU}. You have ${formatAmount(t.available)} ${payU}.` };
    }
    if (problem) return { off: problemText(problem, payU, unit(draft.receive)) };
    if (quoting || !quote) return { off: 'Getting the best price…' };
    const beamOut = (draft.pay === 0 ? quote.pay : 0n) + DEX_CALL_FEE - (draft.receive === 0 ? quote.receive : 0n);
    const beam = wallet.available(0);
    if (beamOut > beam) {
      return {
        off:
          draft.pay === 0
            ? `Not enough BEAM. You need ${formatAmount(quote.pay + DEX_CALL_FEE)} BEAM, including the ${formatAmount(DEX_CALL_FEE)} BEAM network fee.`
            : `You need ${formatAmount(DEX_CALL_FEE)} BEAM for the network fee. You have ${formatAmount(beam)} BEAM.`,
      };
    }
    return { off: null };
  }

  function render() {
    if (!alive) return;
    const payU = unit(draft.pay);
    const payL = wallet.label(draft.pay);
    put(payAssetBtn, assetBadge(payL, { size: 'small' }), h('span', { text: payU }), icon('down'));
    const getL = draft.receive == null ? null : wallet.label(draft.receive);
    put(getAssetBtn, ...(getL ? [assetBadge(getL, { size: 'small' }), h('span', { text: getL.unit })] : [h('span', { text: 'Pick' })]), icon('down'));

    const t = wallet.state.totals.get(draft.pay) || { available: 0n };
    put(payInfo, h('span', { class: 'grow', text: `Available: ${formatAmount(t.available)} ${payU}` }));
    put(
      shareRow,
      ...[25, 50, 75, 100].map((p) =>
        h(
          'button',
          { class: `choice${share === p ? ' on' : ''}`, type: 'button', 'aria-pressed': String(share === p), 'data-testid': p === 100 ? 'swap-max' : `swap-share-${p}`, onclick: () => useShare(p) },
          p === 100 ? 'Max' : `${p}%`,
        ),
      ),
    );
    const a = amountState();
    const quoted = Boolean(quote && a.value != null && !quoting);
    const who = getL && !getL.verified && draft.receive !== 0 ? `${getL.name} · asset #${draft.receive}` : getL && getL.name !== getL.unit ? getL.name : '';
    const least = quoted ? leastReceive(quote, protection()) : null;
    put(
      getInfo,
      h('span', {}, h('span', { 'data-testid': 'swap-get-exact', text: quoted ? `About ${formatAmount(quote.receive)} ${getL.unit}` : who }), quoted ? h('span', { 'data-testid': 'swap-get-least', text: `, at least ${formatAmount(least)}` }) : null, quoted && who ? ` · ${who}` : null),
    );
    getAmount.textContent = quoted ? `≈ ${shortAmount(quote.receive)}` : quoting ? '…' : '0';
    getAmount.classList.toggle('muted', !(quote && !quoting));

    const rows = [];
    if (quote && !quoting) {
      const per = quote.pay > 0n ? (quote.receive * 100000000n) / quote.pay : 0n;
      rows.push(h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Price' }), h('span', { class: 'v', 'data-testid': 'swap-rate', text: `1 ${payU} ≈ ${shortAmount(per)} ${unit(draft.receive)}` })));
      rows.push(h('div', { class: 'kv' }, h('span', { class: 'k', text: `Pool fee (${KINDS[quote.kind].percent})` }), h('span', { class: 'v', 'data-testid': 'swap-pool-fee', text: `${formatAmount(quote.fee)} ${payU}` })));
    }
    rows.push(h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'swap-fee', text: `${formatAmount(DEX_CALL_FEE)} BEAM` })));
    rows.push(
      h(
        'div',
        { class: 'kv' },
        h('span', { class: 'k', text: 'Price protection' }),
        h('button', { class: 'v', type: 'button', 'data-testid': 'swap-protection', 'aria-label': `Price protection ${bpsText(protection())}, change`, onclick: pickProtection }, bpsText(protection())),
      ),
    );
    put(details, ...rows);

    const n = [];
    if (poolsError) {
      n.push(notice('error', `Prices could not be loaded: ${poolsError.message}. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'swap-retry', onclick: () => refreshPools(true) }, 'Try again')));
    }
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'swap-result';
      el.dataset.code = result.code || '';
      if (result.rpc != null) el.dataset.rpc = String(result.rpc);
      n.push(el);
    }
    if (quote && !quoting) {
      const impact = priceImpactBps(quote);
      if (impact >= IMPACT_WARN_BPS) n.push(notice('warn', `This swap moves the price by ${bpsText(impact)}: you get noticeably less than the current rate. A smaller amount gets a better price.`));
      const value = swapValue(quote, pools, (id) => wallet.label(id).verified);
      if (feeIsLarge(quote, DEX_CALL_FEE, value)) n.push(feeWarning(quote, value));
      // An asset worth a lot per smallest unit (bETH: about 0.0025 BEAM a satoshi) comes in whole units,
      // so the pool takes only what those cost: say so, as the button and the consent show that amount.
      if (a.value != null && quote.pay < a.value && (a.value - quote.pay) * 200n > a.value) {
        n.push(notice('info', h('span', { 'data-testid': 'swap-rounded', text: `${getL.unit} comes in steps of 0.00000001, so ${shortAmount(quote.receive)} ${getL.unit} costs ${formatAmount(quote.pay)} ${payU}, not the ${formatAmount(a.value)} you entered.` })));
      }
    }
    if (!n.length) n.push(h('p', { class: 'small', 'data-testid': 'swap-promise', text: quoted ? `You get at least ${formatAmount(least)} ${getL.unit}, or the swap stops and nothing is sent.` : `If the price gets more than ${bpsText(protection())} worse before you approve, the swap stops and nothing is sent.` }));
    put(notes, ...n);

    const st = ctaState();
    cta.disabled = Boolean(st.off);
    // Quoted: what the swap will really pay (the consent shows the same), which can be a little less
    // than what was typed when the other asset comes in large steps.
    cta.textContent = a.value == null || a.error ? 'Swap' : quoted ? `Swap ${formatAmount(quote.pay)} ${payU} for ≈${shortAmount(quote.receive)} ${getL.unit}` : `Swap ${shortAmount(a.value)} ${payU}`;
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
  }

  // ------------------------------------------------------------ quotes
  function onInput() {
    draft.amount = payInput.value;
    result = null;
    requoteSoon();
  }

  function requoteSoon(ms = 500) {
    clearTimeout(timer);
    seq++;
    quote = null;
    problem = null;
    const a = amountState();
    quoting = Boolean(a.value != null && pools && draft.receive != null);
    render();
    if (quoting) timer = setTimeout(requote, ms);
  }

  async function requote() {
    const a = amountState();
    if (a.value == null || !pools || draft.receive == null) return;
    const mine = ++seq;
    quoting = true;
    render();
    try {
      const { app: dex, shader } = await dexApp();
      const q = await bestQuote((args) => dex.view(args, shader), { pools, payAsset: draft.pay, receiveAsset: draft.receive, payAmount: a.value });
      if (!alive || mine !== seq) return;
      quote = q;
      problem = null;
    } catch (e) {
      if (!alive || mine !== seq) return;
      quote = null;
      problem = e;
    }
    quoting = false;
    render();
  }

  async function refreshPools(force = false) {
    poolsError = null;
    render();
    try {
      pools = await loadPools(force);
      if (!alive) return;
      const ok = tradable(pools);
      if (draft.pay !== 0 && !ok.has(draft.pay)) draft.pay = 0;
      chooseReceive();
    } catch (e) {
      if (!alive) return;
      poolsError = e;
    }
    requoteSoon(0);
  }

  // ------------------------------------------------------------ actions
  /** `percent` of what can be paid: the balance, less the network fee when paying with BEAM. */
  function useShare(percent) {
    const t = wallet.state.totals.get(draft.pay) || { available: 0n };
    const fee = draft.pay === 0 ? DEX_CALL_FEE : 0n;
    const base = t.available > fee ? t.available - fee : 0n;
    payInput.value = toInputString(percent === 100 ? base : (base * BigInt(percent)) / 100n);
    share = percent;
    onInput();
  }

  function flip() {
    if (draft.receive == null) return;
    share = null;
    const p = draft.pay;
    draft.pay = draft.receive;
    draft.receive = p;
    result = null;
    chooseReceive();
    requoteSoon(0);
  }

  /** "The network fee is 55% of what you swap", as the desktop words it. */
  function feeWarning(q, value) {
    const share = feeShareBps(value);
    const pct = bpsText(share);
    const title = share > 10000n ? 'The network fee is more than what you swap' : share > 5000n ? 'The network fee is more than half of what you swap' : `The network fee is ${pct} of what you swap`;
    const swapped = q.payAsset === 0 ? `the ${formatAmount(q.pay)} BEAM you swap` : `what you swap (worth about ${shortAmount(value)} BEAM)`;
    const el = notice('warn', h('strong', { text: `${title}. ` }), `Every swap costs ${formatAmount(DEX_CALL_FEE)} BEAM in network fees, whatever the amount. Here that is ${pct} of ${swapped}. A larger swap pays the same fee.`);
    el.dataset.testid = 'swap-fee-warning';
    return el;
  }

  function pickProtection() {
    const label = (b) => (b === 100n ? '1% — the most BEAM allows' : b === 10n ? '0.1% — strict; fails more often when others trade' : bpsText(b));
    openSheet(
      (close) => [
        h('h2', { text: 'Price protection' }),
        h('p', { text: 'If the price moves against you by more than this before your swap is built, BEAM Campfire stops and shows you the new price. Nothing is sent.' }),
        h('p', { class: 'small', text: 'After you approve, BEAM itself never accepts a result more than 1% worse: if someone trades first, it redoes your swap within 1% or cancels it. (Also called slippage tolerance.)' }),
        h(
          'div',
          { class: 'card list' },
          ...PROTECTIONS.map((b) =>
            h('button', { class: `row${b === protection() ? ' on' : ''}`, type: 'button', 'data-testid': `swap-protection-${b}`, 'aria-pressed': String(b === protection()), onclick: () => close(b) }, h('span', { class: 'main' }, h('div', { class: 't', text: label(b) }))),
          ),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ],
      { label: 'Price protection' },
    ).then((b) => {
      if (b == null || !alive) return;
      draft.protection = Number(b);
      render();
    });
  }

  function pick(paySide) {
    if (!pools) return;
    const lpFree = tradable(pools);
    const held = (id) => (wallet.state.totals.get(id) || { available: 0n }).available;
    let ids;
    if (paySide) {
      ids = [0, ...[...wallet.state.totals.keys()].filter((id) => id !== 0 && held(id) > 0n && lpFree.has(id))];
    } else {
      ids = receivable(pools, draft.pay);
    }
    // Tokens hidden from Wallet are left out (the desktop's dexTradableAssets), except the one already chosen.
    ids = ids.filter((id) => id === 0 || !hiddenIds(app).has(id) || id === (paySide ? draft.pay : draft.receive));
    openSheet((close, rerender) => {
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or number', 'aria-label': 'Search', autocomplete: 'off', 'data-testid': 'picker-search' });
      const list = h('div', { class: 'card list picker-list' });
      const fill = () => {
        const q = search.value.trim().toLowerCase().replace(/^#/, '');
        const shown = ids.filter((id) => {
          if (!q) return true;
          const l = wallet.label(id);
          return String(id) === q || l.unit.toLowerCase().includes(q) || l.name.toLowerCase().includes(q);
        });
        put(
          list,
          ...(shown.length
            ? shown.map((id) => {
                const l = wallet.label(id);
                const have = held(id);
                const current = id === (paySide ? draft.pay : draft.receive);
                return h(
                  'button',
                  { class: `row${current ? ' on' : ''}`, 'data-asset-id': String(id), onclick: () => close(id) },
                  assetBadge(l),
                  h('span', { class: 'main' }, h('div', { class: 't', text: l.unit }), h('div', { class: 's', text: l.verified ? l.name : `Not verified · ${l.name}` })),
                  have > 0n ? h('span', { class: 'end small', text: formatAmount(have) }) : null,
                );
              })
            : [h('p', { class: 'small center pad', text: paySide ? 'Only assets this wallet holds can be paid with.' : 'Nothing matches. Try another name or number.' })]),
        );
      };
      search.addEventListener('input', fill);
      fill();
      return [
        h('h2', { text: paySide ? 'You pay with' : 'You get' }),
        ids.length > 8 ? search : null,
        list,
        paySide && ids.length === 1 ? h('p', { class: 'small', text: 'Other assets show up here once this wallet holds some.' }) : null,
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ];
    }, { label: paySide ? 'You pay with' : 'You get' }).then((id) => {
      if (id == null || !alive) return;
      if (paySide) {
        if (id === draft.receive) draft.receive = draft.pay;
        if (id !== draft.pay) share = null;
        draft.pay = id;
        chooseReceive();
      } else {
        if (id === draft.pay) draft.pay = draft.receive;
        draft.receive = id;
      }
      result = null;
      requoteSoon(0);
    });
  }

  async function doSwap() {
    const q = quote;
    if (!q || preparing || ctaState().off) return;
    preparing = true;
    result = null;
    render();
    try {
      const { app: dex, shader } = await dexApp();
      const args = tradeArgs({ payAsset: q.payAsset, receiveAsset: q.receiveAsset, kind: q.kind, payAmount: q.pay, predictOnly: false });
      // The approve sheet repeats what the swap is sure to get: the engine's amount there can still shrink a little.
      const least = leastReceive(q, protection());
      const intent = { action: 'swap', payAsset: q.payAsset, receiveAsset: q.receiveAsset, rows: [['You get at least', `${formatAmount(least)} ${unit(q.receiveAsset)}`]] };
      const txId = await dex.transact(args, shader, { expect: swapExpectation(q, protection()), intent });
      if (!alive) return;
      app.swapDraft = null;
      wallet.refreshTxs();
      wallet.refreshStatus();
      app.go('txStatus', { txId, kind: 'swap', pay: { assetId: q.payAsset, amount: q.pay }, receive: { assetId: q.receiveAsset, amount: q.receive }, fee: DEX_CALL_FEE }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      const rpc = e && e.rpc ? e.rpc.code : null;
      if (e.code === 'rejected') result = { kind: 'info', code: 'rejected', rpc, text: 'Swap cancelled. Nothing was sent.' };
      else if (e.code === 'priceMoved') result = { kind: 'warn', code: 'priceMoved', rpc, text: `${e.message} Here is the new price.` };
      else if (e.code === 'timeout') result = { kind: 'error', code: 'timeout', rpc, text: 'The wallet did not answer in time. Check Activity before trying again.' };
      else if (e instanceof DexError || e.code === 'unexpected' || e.code === 'shader') result = { kind: 'error', code: e.code, rpc, text: e.code === 'unexpected' ? e.message : problemText(e, unit(q.payAsset), unit(q.receiveAsset)) };
      else result = { kind: 'error', code: e.code || 'error', rpc, text: `The swap was not sent: ${e.message}${/\.$/.test(e.message) ? '' : '.'} Nothing left your wallet.` };
    }
    preparing = false;
    const keep = result;
    if (keep && keep.code === 'priceMoved') {
      await refreshPools(true);
      result = keep;
    }
    render();
  }

  payInput.addEventListener('input', () => {
    share = null;
    onInput();
  });
  const off = wallet.onChange(() => render());
  wallet.loadAllAssets();
  render();
  refreshPools(false);

  const el = screen(
    {
      title: 'Swap',
      back: () => {
        app.swapDraft = null;
        app.back('home');
      },
      // Pools: add coins to a pool, or take them out (screens/pools.js).
      right: h('button', { class: 'btn btn-text btn-small pools-btn', type: 'button', 'data-testid': 'swap-pools', onclick: () => app.go('pools') }, 'Pools'),
      actions: [reason, cta],
      cls: 'swap',
    },
    h(
      'div',
      { class: 'swap-pair' },
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You pay' }), h('div', { class: 'swap-line' }, payInput, payAssetBtn), shareRow, payInfo),
      flipBtn,
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You get' }), h('div', { class: 'swap-line' }, getAmount, getAssetBtn), getInfo),
    ),
    details,
    notes,
  );
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      off();
    },
  };
}

