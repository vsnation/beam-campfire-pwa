/* A pool: put coins in, or take yours out
 * Spec: ONE job: add coins to this pool, or take your share out.
 *       Primary CTA: "Add 0.01 BEAM + 371.76 FOMO" or, on the Withdraw tab, "Withdraw 0.01 BEAM + 371.76 FOMO"
 *       (only one is ever shown; the approve sheet that follows shows exactly what the wallet built).
 *       Taps from app open: Home -> Swap -> Pools -> the pool (3), an amount, the button (4), then approve.
 *       From Home an LP token opens its pool on the Withdraw tab: 1 tap, then the button (2).
 * Exit-intent reasons and answers:
 *   - "I have to work out the second amount" -> type either side; the pool itself (its shader, read-only)
 *     fills in the matching amount 0.5 s after typing stops. Max fits both balances.
 *   - "What is my share worth?" -> your share, what it is worth in BEAM and in each coin, at the top.
 *   - "What do I get, what does it cost?" -> the LP you get and your share after (or what comes back),
 *     and the 0.011 BEAM network fee, before the button.
 *   - "What if the price moves before I approve?" -> more than 1% and the wallet stops before showing
 *     anything; nothing is sent, and the new amounts appear.
 *   - "An empty pool: a first deposit sets a silly price" -> said before anything is typed, and the
 *     starting price is shown as both amounts are typed.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, assetBadge } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { loadPools } from '../lib/dex_pools.js';
import {
  LIQUIDITY_FEE, WITHDRAW_STEPS, findPool, isEmptyPool, shareOf, shareAfterAdd, positionAmounts, lpForPercent, maxDeposit, valueOf, poolSize, percentText, compact, beamWorth, ratioText, poolKey,
} from '../lib/dex_liquidity.js';
import { bpsText, PROTECTION_BPS } from '../lib/dex.js';
import { shortAmount } from './consent.js';
import { isVerified, unit, pairName, feeText, pairBadge, sideWarnings, flipButton, poolParams, liquidity, problemText, readProblemText } from './pool_parts.js';
import { syncReason } from '../lib/sync.js';
import { t } from '../lib/i18n.js';

/** An amount on the button: as the swap writes it, but a tiny one in four significant digits. */
const btn = (g) => (BigInt(g) >= 1000000n ? shortAmount(g) : compact(g));

function parsed(text) {
  const s = String(text || '').trim();
  if (!s) return { value: null, error: null };
  try {
    const v = parseAmount(s);
    return v > 0n ? { value: v, error: null } : { value: null, error: t('The amount must be more than zero.') };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

export default function pool(app, params = {}) {
  const key = { aid1: Number(params.aid1), aid2: Number(params.aid2), kind: Number(params.kind) };
  const id = poolKey(key);
  if (!app.poolDraft || app.poolDraft.id !== id) app.poolDraft = { id, mode: 'add', a1: '', a2: '', edited: null, pct: 100, exact: '' };
  const draft = app.poolDraft;
  if (params.mode === 'withdraw' || params.mode === 'add') draft.mode = params.mode;

  let pools = null;
  let pl = null; // this pool, from the latest list
  let loadError = null;
  let addQ = null;
  let wdQ = null;
  let quoting = false;
  let problem = null; // a quote's problem
  let preparing = false;
  let result = null; // { kind, code, text }
  let seq = 0;
  let timer = null;
  let alive = true;
  let priceFlipped = false;
  let titleEl = null;

  const in1 = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'data-testid': 'pool-add-1' });
  const in2 = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'data-testid': 'pool-add-2' });
  in1.value = draft.a1;
  in2.value = draft.a2;
  const exact = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Exact amount of LP to return'), 'data-testid': 'pool-withdraw-exact' });
  exact.value = draft.exact;

  const headBox = h('div');
  const positionBox = h('div');
  const modeBox = h('div');
  const formBox = h('div', { class: 'stack' });
  const detailsBox = h('div');
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'pool-reason', 'aria-live': 'polite' });
  const cta = primary(t('Add liquidity'), act, { disabled: true, class: 'btn btn-primary wrap', 'data-testid': 'pool-cta' });

  const held = () => (pl && pl.lpToken != null ? wallet.available(pl.lpToken) : 0n);
  const spendable = (aid) => {
    const a = wallet.available(aid);
    const v = aid === 0 ? a - LIQUIDITY_FEE : a;
    return v > 0n ? v : 0n;
  };
  const empty = () => Boolean(pl) && isEmptyPool(pl);
  const mode = () => (held() > 0n ? draft.mode : 'add');

  // ------------------------------------------------------------ add: amounts
  function given() {
    const v1 = parsed(in1.value).value;
    const v2 = parsed(in2.value).value;
    if (empty()) return { amount1: v1, amount2: v2 };
    return draft.edited === 2 ? { amount2: v2 } : { amount1: v1 };
  }

  function wantsAddQuote() {
    if (!pl) return false;
    const g = given();
    if (empty()) return g.amount1 != null && g.amount2 != null;
    return draft.edited != null && (draft.edited === 1 ? g.amount1 != null : g.amount2 != null);
  }

  function onAddInput(side) {
    if (!empty()) {
      draft.edited = side;
      // The other side is the pool's to fill in.
      (side === 1 ? in2 : in1).value = '';
    }
    draft.a1 = in1.value;
    draft.a2 = in2.value;
    result = null;
    requoteSoon();
  }

  function useMax(side) {
    if (!pl) return;
    const aid = side === 1 ? pl.aid1 : pl.aid2;
    const v = maxDeposit(pl, side, spendable(pl.aid1), spendable(pl.aid2));
    (side === 1 ? in1 : in2).value = v > 0n ? toInputString(v) : '';
    if (v <= 0n) {
      result = { kind: 'info', code: 'nothing', text: aid === 0 ? t('There is no {unit} to add after the 0.011 BEAM network fee.', { unit: unit(aid) }) : t('There is no {unit} to add.', { unit: unit(aid) }) };
    }
    onAddInput(side);
  }

  // ------------------------------------------------------------ withdraw: amounts
  function lpToBurn() {
    if (draft.exact.trim()) return parsed(draft.exact);
    const v = lpForPercent(held(), draft.pct ?? 100);
    return { value: v > 0n ? v : null, error: null };
  }

  function setPct(p) {
    draft.pct = p;
    draft.exact = '';
    exact.value = '';
    result = null;
    requoteSoon(0);
  }

  function setMode(m) {
    if (draft.mode === m) return;
    draft.mode = m;
    result = null;
    requoteSoon(0);
  }

  // ------------------------------------------------------------ quotes
  function requoteSoon(ms = 500) {
    clearTimeout(timer);
    seq++;
    addQ = null;
    wdQ = null;
    problem = null;
    if (mode() === 'add') quoting = wantsAddQuote();
    else {
      const lp = lpToBurn();
      quoting = Boolean(pl && lp.value != null && lp.value <= held());
    }
    render();
    if (quoting) timer = setTimeout(requote, ms);
  }

  async function requote() {
    if (!pl) return;
    const mine = ++seq;
    const m = mode();
    quoting = true;
    render();
    try {
      if (m === 'add') {
        if (!wantsAddQuote()) {
          quoting = false;
          return render();
        }
        const q = await liquidity().quoteAdd(pl, given());
        if (!alive || mine !== seq) return;
        addQ = q;
        if (!empty()) {
          if (draft.edited === 1) in2.value = toInputString(q.amount2);
          else in1.value = toInputString(q.amount1);
          draft.a1 = in1.value;
          draft.a2 = in2.value;
        }
      } else {
        const lp = lpToBurn().value;
        if (lp == null) {
          quoting = false;
          return render();
        }
        const q = await liquidity().quoteWithdraw(pl, lp);
        if (!alive || mine !== seq) return;
        wdQ = q;
      }
      problem = null;
    } catch (e) {
      if (!alive || mine !== seq) return;
      problem = e;
    }
    quoting = false;
    render();
  }

  // ------------------------------------------------------------ the button and its reason
  function ctaState() {
    if (preparing) return { off: mode() === 'add' ? t('Building your deposit…') : t('Building your withdrawal…') };
    if (!wallet.state.sync.canSend) return { off: t('Pool moves are paused: {state}.', { state: syncReason(wallet.state.sync.title) }) };
    if (loadError && !pl) return { off: t('The pool could not be loaded. Try again above.') };
    if (!pools) return { off: t('Loading the pool…') };
    if (!pl) return { off: t('This pool is not on the DEX yet.') };
    const beam = wallet.available(0);
    if (mode() === 'withdraw') {
      const lp = lpToBurn();
      if (lp.error) return { off: lp.error };
      if (lp.value == null) return { off: t('Choose how much of your share to take out.') };
      if (lp.value > held()) return { off: t('You hold {amount} LP of this pool. Enter that much or less.', { amount: formatAmount(held()) }) };
      if (problem) return { off: problemText(problem, { action: 'withdraw' }) };
      if (quoting || !wdQ) return { off: t('Working out what you get back…') };
      const back = pl.aid1 === 0 ? wdQ.amount1 : 0n;
      if (LIQUIDITY_FEE > beam + back) return { off: t('You need {fee} BEAM for the network fee. You have {balance} BEAM.', { fee: formatAmount(LIQUIDITY_FEE), balance: formatAmount(beam) }) };
      return { off: null };
    }
    const p1 = parsed(in1.value);
    const p2 = parsed(in2.value);
    const err = (draft.edited === 2 && !empty() ? p2.error : p1.error) || (empty() ? p2.error : null);
    if (err) return { off: err };
    if (!wantsAddQuote()) return { off: empty() ? t("Enter both amounts. They set the pool's starting price.") : t('Enter how much {unit1} or {unit2} to add.', { unit1: unit(pl.aid1), unit2: unit(pl.aid2) }) };
    if (problem) return { off: problemText(problem, { action: 'add' }) };
    if (quoting || !addQ) return { off: empty() ? t('Checking the amounts…') : t('Working out the matching amount…') };
    for (const [aid, need] of [[pl.aid1, addQ.amount1], [pl.aid2, addQ.amount2]]) {
      const tot = wallet.state.totals.get(aid) || { available: 0n, receiving: 0n };
      if (need > tot.available) {
        if (tot.receiving > 0n && need <= tot.available + tot.receiving) return { off: t("{amount} {unit} is in a payment that hasn't finished yet; it's yours in about a minute.", { amount: formatAmount(tot.receiving), unit: unit(aid) }) };
        return { off: t('Not enough {unit}. You need {need}, you have {balance}.', { unit: unit(aid), need: formatAmount(need), balance: formatAmount(tot.available) }) };
      }
    }
    const beamOut = (pl.aid1 === 0 ? addQ.amount1 : 0n) + LIQUIDITY_FEE;
    if (beamOut > beam) {
      return { off: pl.aid1 === 0 ? t('Not enough BEAM. You need {amount} BEAM, including the {fee} BEAM network fee.', { amount: formatAmount(beamOut), fee: formatAmount(LIQUIDITY_FEE) }) : t('You need {fee} BEAM for the network fee. You have {balance} BEAM.', { fee: formatAmount(LIQUIDITY_FEE), balance: formatAmount(beam) }) };
    }
    return { off: null };
  }

  // ------------------------------------------------------------ drawing
  // A row: label, value (a string, or lines), and a quieter note under it.
  const kv = (k, v, testid, note = null) =>
    h(
      'div',
      { class: 'kv' },
      h('span', { class: 'k', text: k }),
      h(
        'span',
        { class: 'v' },
        Array.isArray(v) ? h('span', { 'data-testid': testid }, ...v.map((line) => h('span', { class: 'line', text: line }))) : h('span', { 'data-testid': testid, text: v }),
        note ? h('div', { class: 'small', 'data-testid': testid ? `${testid}-note` : null }, ...[].concat(note).map((line) => h('span', { class: 'line', text: line }))) : null,
      ),
    );

  function renderHead() {
    if (!pl) {
      put(
        headBox,
        loadError
          ? h('div', { 'data-testid': 'pool-load-error' }, notice('error', readProblemText(loadError, 'pool'), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => load(true) }, t('Try again'))))
          : pools
            ? h('div', { 'data-testid': 'pool-missing' }, notice('info', h('strong', { text: `${t('This pool is not on the DEX yet.')} ` }), `${t('A pool just created shows up once the network confirms it, usually within a minute or two.')} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => load(true) }, t('Check again'))))
            : h('div', { class: 'loading-line', 'data-testid': 'pool-loading' }, h('span', { class: 'spinner small' }), h('span', { text: t('Loading the pool from the BEAM network…') })),
      );
      return;
    }
    const size = poolSize(pools, pl, isVerified);
    put(
      headBox,
      h(
        'div',
        { class: 'card pool-head', 'data-testid': 'pool-head' },
        h('div', { class: 'pool-title big' }, pairBadge(pl), h('span', { class: 'name', 'data-testid': 'pool-name', text: pairName(pl) }), h('span', { class: 'fee-chip', 'data-testid': 'pool-fee', text: feeText(pl.kind) })),
        ...sideWarnings(pl),
        empty()
          ? h('div', { 'data-testid': 'pool-is-empty' }, notice('warn', h('strong', { text: `${t('This pool is empty.')} ` }), t('The first coins added set its price. Enter both amounts at the price you believe is fair.')))
          : h(
              'div',
              { class: 'kvs' },
              h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Price') }), flipButton(pl, { testid: 'pool-price', cls: 'v rate-btn', start: priceFlipped, onFlip: (on) => (priceFlipped = on) })),
              h(
                'div',
                { class: 'kv' },
                h('span', { class: 'k', text: t('In the pool') }),
                h(
                  'span',
                  { class: 'v', 'data-testid': 'pool-reserves' },
                  h('span', { class: 'line', text: `${compact(pl.tok1)} ${unit(pl.aid1)}` }),
                  h('span', { class: 'line', text: `${compact(pl.tok2)} ${unit(pl.aid2)}` }),
                  h('span', { class: 'small line', 'data-testid': 'pool-size', text: size == null ? t('No price') : t('Pool size {worth}', { worth: beamWorth(size) }) }),
                ),
              ),
            ),
      ),
    );
  }

  function renderPosition() {
    const lp = held();
    if (!pl || lp <= 0n) {
      put(positionBox);
      put(modeBox);
      return;
    }
    const share = shareOf(pl, lp);
    const est = positionAmounts(pl, lp);
    const value = valueOf(pools, pl.lpToken, lp, isVerified);
    put(
      positionBox,
      h(
        'div',
        { class: 'card flat pool-position', 'data-testid': 'pool-position' },
        h(
          'div',
          { class: 'kv' },
          h('span', { class: 'k', text: t('Your share of the pool') }),
          h('span', { class: 'v' }, h('span', { class: 'mine', 'data-testid': 'pool-my-share', text: percentText(share.num, share.den) }), h('div', { class: 'small', 'data-testid': 'pool-my-lp', text: t('{amount} LP', { amount: formatAmount(lp) }) })),
        ),
        kv(t('Worth about'), value == null ? t('No price yet') : beamWorth(value).replace(/^≈ /, ''), 'pool-my-value', [`${compact(est.amount1)} ${unit(pl.aid1)} +`, `${compact(est.amount2)} ${unit(pl.aid2)}`]),
      ),
    );
    const tab = (m, label) => h('button', { class: `choice${mode() === m ? ' on' : ''}`, type: 'button', 'aria-pressed': String(mode() === m), 'data-testid': `pool-mode-${m}`, onclick: () => setMode(m) }, label);
    put(modeBox, h('div', { class: 'choices', role: 'group', 'aria-label': t('Add or withdraw') }, tab('add', t('Add')), tab('withdraw', t('Withdraw'))));
  }

  // The two amount boxes and the withdraw form are built once: re-drawing them
  // would take the focus out of the field being typed in.
  function makeSide(side) {
    const input = side === 1 ? in1 : in2;
    const label = h('div', { class: 'swap-label' });
    const chip = h('span', { class: 'asset-pick static', 'data-testid': `pool-side-${side}-asset` });
    const bal = h('span', { class: 'grow', 'data-testid': `pool-side-${side}-balance` });
    const el = h(
      'div',
      { class: 'card swap-box', 'data-testid': `pool-side-${side}` },
      label,
      h('div', { class: 'swap-line' }, input, chip),
      h('div', { class: 'swap-sub' }, bal, h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': `pool-max-${side}`, onclick: () => useMax(side) }, t('Max'))),
    );
    return {
      el,
      update() {
        const aid = side === 1 ? pl.aid1 : pl.aid2;
        const l = wallet.label(aid);
        const computed = !empty() && draft.edited != null && draft.edited !== side;
        el.classList.toggle('computed', computed);
        label.textContent = computed ? t('Matching amount') : t('You add');
        input.setAttribute('aria-label', t('Amount of {unit} to add', { unit: l.unit }));
        input.placeholder = computed && quoting ? '…' : '0';
        const shown = chip.dataset.asset === String(aid) && chip.dataset.unit === l.unit;
        if (!shown) {
          put(chip, assetBadge(l, { size: 'small' }), h('span', { text: l.unit }));
          chip.dataset.asset = String(aid);
          chip.dataset.unit = l.unit;
        }
        bal.textContent = t('Balance: {amount} {unit}', { amount: formatAmount(wallet.available(aid)), unit: l.unit });
      },
    };
  }
  const side1 = makeSide(1);
  const side2 = makeSide(2);
  const addForm = h('div', { class: 'stack hidden', 'data-testid': 'pool-add-form' }, side1.el, side2.el);
  const pctBox = h('div', { class: 'choices four', role: 'group', 'aria-label': t('Part of your share') });
  const heldHint = h('span', { class: 'hint', 'data-testid': 'pool-held-hint' });
  const wdForm = h(
    'div',
    { class: 'stack hidden', 'data-testid': 'pool-withdraw-form' },
    h('p', { class: 'section-title', text: t('How much of your share to take out') }),
    pctBox,
    h('label', { class: 'field' }, t('Or exactly'), h('div', { class: 'input-wrap suffix' }, exact, h('span', { class: 'suffix-text', text: t('LP') })), heldHint),
  );
  put(formBox, addForm, wdForm);

  function renderForm() {
    addForm.classList.toggle('hidden', !pl || mode() !== 'add');
    wdForm.classList.toggle('hidden', !pl || mode() !== 'withdraw');
    if (!pl) return;
    if (mode() === 'add') {
      side1.update();
      side2.update();
      return;
    }
    const on = (p) => !draft.exact.trim() && draft.pct === p;
    put(pctBox, ...WITHDRAW_STEPS.map((p) => h('button', { class: `choice${on(p) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on(p)), 'data-testid': `pool-pct-${p}`, onclick: () => setPct(p) }, `${p}%`)));
    heldHint.textContent = t('You hold {amount} LP', { amount: formatAmount(held()) });
  }

  function renderDetails() {
    if (!pl) {
      put(detailsBox);
      return;
    }
    const rows = [];
    if (mode() === 'add') {
      if (addQ && !quoting) {
        const after = shareAfterAdd(pl, addQ.lpMinted, held());
        rows.push(kv(t('You get'), `≈ ${compact(addQ.lpMinted)} ${unit(pl.lpToken)}`, 'pool-get-lp'));
        rows.push(kv(t('Your share of the pool after'), percentText(after.num, after.den), 'pool-share-after'));
        if (empty()) rows.push(kv(t('Starting price'), `1 ${unit(pl.aid1)} ≈ ${ratioText(addQ.amount2, addQ.amount1)} ${unit(pl.aid2)}`, 'pool-start-price'));
      }
      rows.push(kv(t('Network fee'), `${formatAmount(LIQUIDITY_FEE)} BEAM`, 'pool-fee-network'));
      if (addQ && !quoting && pl.aid1 === 0) rows.push(kv(t('Total BEAM out'), `${formatAmount(addQ.amount1 + LIQUIDITY_FEE)} BEAM`, 'pool-total-beam'));
    } else {
      if (wdQ && !quoting) {
        const v1 = valueOf(pools, pl.aid1, wdQ.amount1, isVerified);
        const v2 = valueOf(pools, pl.aid2, wdQ.amount2, isVerified);
        rows.push(kv(t('You get back'), [`${formatAmount(wdQ.amount1)} ${unit(pl.aid1)} +`, `${formatAmount(wdQ.amount2)} ${unit(pl.aid2)}`], 'pool-get-back', v1 == null || v2 == null ? t('No price') : beamWorth(v1 + v2)));
        rows.push(kv(t('You return'), t('{amount} LP', { amount: formatAmount(wdQ.lpBurned) }), 'pool-return-lp'));
      }
      rows.push(kv(t('Network fee'), `${formatAmount(LIQUIDITY_FEE)} BEAM`, 'pool-fee-network'));
    }
    put(detailsBox, h('div', { class: 'card flat swap-details', 'data-testid': 'pool-details' }, ...rows));
  }

  function renderNotes() {
    const n = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'pool-result';
      el.dataset.code = result.code || '';
      if (result.rpc != null) el.dataset.rpc = String(result.rpc);
      n.push(el);
    }
    if (pl && !result) {
      if (mode() === 'add' && !empty()) n.push(h('p', { class: 'small', text: t("Your coins earn a share of the fee on every swap. What you take out later follows the pool's price then, so it can be more of one coin and less of the other. If the price moves more than {percent} before you approve, nothing is sent.", { percent: bpsText(PROTECTION_BPS) }) }));
      if (mode() === 'withdraw') n.push(h('p', { class: 'small', text: t('If the pool changes by more than {percent} before you approve, nothing is sent and you see the new amounts.', { percent: bpsText(PROTECTION_BPS) }) }));
    }
    put(notes, ...n);
  }

  function render() {
    if (!alive) return;
    renderHead();
    renderPosition();
    renderForm();
    renderDetails();
    renderNotes();
    const st = ctaState();
    cta.disabled = Boolean(st.off);
    if (mode() === 'add') {
      const g = { a1: parsed(in1.value).value, a2: parsed(in2.value).value };
      cta.textContent =
        pl && addQ && !quoting
          ? t('Add {amount1} {unit1} + {amount2} {unit2}', { amount1: btn(addQ.amount1), unit1: unit(pl.aid1), amount2: btn(addQ.amount2), unit2: unit(pl.aid2) })
          : pl && g.a1 && g.a2 && empty()
            ? t('Add {amount1} {unit1} + {amount2} {unit2}', { amount1: btn(g.a1), unit1: unit(pl.aid1), amount2: btn(g.a2), unit2: unit(pl.aid2) })
            : t('Add liquidity');
    } else {
      cta.textContent = pl && wdQ && !quoting ? t('Withdraw {amount1} {unit1} + {amount2} {unit2}', { amount1: btn(wdQ.amount1), unit1: unit(pl.aid1), amount2: btn(wdQ.amount2), unit2: unit(pl.aid2) }) : t('Withdraw');
    }
    // The pair in the title once the pool is known: "BEAM/FOMO pool".
    if (titleEl && pl) titleEl.textContent = t('{pair} pool', { pair: pairName(pl, '/') });
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
  }

  // ------------------------------------------------------------ loading
  async function load(force = false) {
    loadError = null;
    render();
    try {
      const list = await loadPools(force);
      if (!alive) return;
      pools = list;
      pl = findPool(list, key);
    } catch (e) {
      if (!alive) return;
      loadError = e;
    }
    requoteSoon(0);
  }

  // ------------------------------------------------------------ sending
  async function act() {
    if (preparing || ctaState().off || !pl) return;
    const m = mode();
    preparing = true;
    result = null;
    render();
    const pair = `${pairName(pl, '/')} · ${feeText(pl.kind)}`;
    try {
      let sent;
      if (m === 'add') {
        const q = addQ;
        const after = shareAfterAdd(pl, q.lpMinted, held());
        sent = await liquidity().add(pl, { ...given(), quote: q, intent: { rows: [[t('Pool'), pair], [t('Your share after'), percentText(after.num, after.den)]] } });
      } else {
        const q = wdQ;
        sent = await liquidity().withdraw(pl, { lp: q.lpBurned, quote: q, intent: { rows: [[t('Pool'), pair]] } });
      }
      if (!alive) return;
      app.poolDraft = null;
      wallet.refreshTxs();
      wallet.refreshStatus();
      const list = (mp) => [...mp].map(([assetId, amount]) => ({ assetId, amount }));
      app.go('poolTx', { txId: sent.txId, action: m, ...poolParams(pl), lpToken: pl.lpToken, pays: list(sent.built.pays), receives: list(sent.built.receives), fee: sent.built.fee }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      const rpc = e && e.rpc ? e.rpc.code : null;
      const kind = e.code === 'rejected' ? 'info' : e.code === 'priceMoved' ? 'warn' : 'error';
      result = { kind, code: e.code || 'error', rpc, text: problemText(e, { action: m }) };
    }
    preparing = false;
    if (result && result.code === 'priceMoved') {
      const keep = result;
      await load(true);
      result = keep;
    }
    render();
  }

  in1.addEventListener('input', () => onAddInput(1));
  in2.addEventListener('input', () => onAddInput(2));
  exact.addEventListener('input', () => {
    draft.exact = exact.value;
    result = null;
    requoteSoon();
  });
  let lastHeld = null;
  const off = wallet.onChange(() => {
    // A share that arrives or leaves while the screen is open changes the tabs and the quote.
    const now = held();
    if (lastHeld !== null && now !== lastHeld && mode() === 'withdraw') requoteSoon(0);
    else render();
    lastHeld = now;
  });
  render();
  load(Boolean(params.fresh));

  const el = screen(
    {
      title: t('Pool'),
      back: () => app.back('pools'),
      actions: [reason, cta],
      cls: 'swap pool sticky-actions',
    },
    headBox,
    positionBox,
    modeBox,
    formBox,
    detailsBox,
    notes,
  );
  titleEl = el.querySelector('.topbar h1');
  render();
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      off();
    },
  };
}
