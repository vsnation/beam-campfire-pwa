/* BEAM names
 * Spec: ONE job: get a short name people can pay instead of a long address, and keep it.
 *       Primary CTA: "Register alice for 1 year" (the approve sheet that follows shows the exact BEAM).
 *       Taps from app open: 1 (Home -> BEAM names), type a name, 2 ("Register ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What does a name cost?" -> the dollar prices by length are on screen before typing; the BEAM
 *     amount appears with the result, and the approve sheet shows it exactly.
 *   - "Is it free?" -> checked on the wallet's own node 0.4 s after typing stops, with when a taken
 *     name could become free.
 *   - "Am I about to lose my name?" -> My names shows each expiry, a warning once it lapsed, and Renew.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import {
  bansFor, tryName, normaliseName, nameProblem, describeNameProblem, usdPerPeriod, priceEstimate, STATUS, canRegister, holdEndHeight, dateOf, display,
  maxExtendPeriods, expiryAfterRegister, expiryAfterExtend, NAME_CALL_FEE, NAME_MAX, MAX_PERIODS,
} from '../lib/bans.js';

const LOOKUP_DEBOUNCE_MS = 400;

/** BANS for the running wallet (one per session). */
export function bans() {
  return bansFor(wallet.session, () => wallet.session.call('wallet_status', {}, { timeoutMs: 15000 }));
}

export const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;
export const years = (n) => (n === 1 ? '1 year' : `${n} years`);
export const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const beamAbout = (g) => formatAmount(g, { maxDecimals: g >= 100000000n ? 0 : 4 });
const midpoint = (e) => (e.minGroth + e.maxGroth) / 2n;

/** Plain words for whatever stopped a name transaction. */
export function nameProblemText(e, what) {
  const code = e && e.code;
  if (code === 'rejected') return 'Cancelled. Nothing was sent.';
  if (code === 'timeout') return 'The wallet did not answer in time. Check Activity before trying again.';
  if (code === 'load' || code === 'mismatch') return e.message;
  if (code === 'refused' || code === 'unexpected' || code === 'priceMoved' || code === 'ownerChanged' || code === 'invalidName' || code === 'notMine') return e.message;
  const m = String((e && e.message) || e || 'unknown error');
  return `The ${what} was not sent: ${m}${/\.$/.test(m) ? '' : '.'} Nothing left your wallet.`;
}

/** − 1 year + */
export function yearsStepper(value, max, onChange, testid = 'names-years') {
  const minus = h('button', { class: 'icon-btn stepper-btn', type: 'button', 'aria-label': 'One year less', 'data-testid': `${testid}-minus`, disabled: value <= 1, onclick: () => onChange(value - 1) }, h('span', { text: '−' }));
  const plus = h('button', { class: 'icon-btn stepper-btn', type: 'button', 'aria-label': 'One year more', 'data-testid': `${testid}-plus`, disabled: value >= max, onclick: () => onChange(value + 1) }, h('span', { text: '+' }));
  return h('div', { class: 'stepper' }, minus, h('span', { class: 'stepper-value', 'data-testid': testid, text: years(value) }), plus);
}

let hooked = false;
/** What Names keeps between visits is forgotten when the wallet locks. */
function forgetOnLock(app) {
  if (hooked || !app.lockHooks) return;
  hooked = true;
  app.lockHooks.add(() => {
    app.namesDraft = null;
    app.namesPending = null;
  });
}

export default function names(app) {
  forgetOnLock(app);
  const draft = (app.namesDraft = app.namesDraft || { text: '', years: 1 });
  const pending = (app.namesPending = app.namesPending || new Map()); // name -> { at, kind }
  let lookup = { state: 'idle' }; // idle | checking | done | error
  let params = null;
  let paramsError = null;
  let mine = { state: 'loading', list: [], tip: null };
  let preparing = false;
  let result = null; // { kind, text, code }
  let seq = 0;
  let timer = null;
  let alive = true;

  const input = h('input', { class: 'input name-input', type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: String(NAME_MAX + 5), placeholder: 'alice', 'aria-label': 'Name', 'data-testid': 'names-input' });
  input.value = draft.text;
  const hint = h('p', { class: 'hint', 'data-testid': 'names-hint' });
  const resultBox = h('div', { 'aria-live': 'polite' });
  const quoteBox = h('div');
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'names-reason', 'aria-live': 'polite' });
  const cta = primary('Register a name', register, { disabled: true, 'data-testid': 'names-cta' });
  const mineBox = h('div');
  const lead = h('p', { class: 'lead', text: 'A name lets people pay you as alice.beam instead of a long address.' });

  const name = () => tryName(input.value);
  const estimateFor = (n, y) => (params && params.usdPerBeamText ? priceEstimate({ usdPerPeriod: usdPerPeriod(n.length), periods: y, medianText: params.usdPerBeamText }) : null);
  const tipOf = () => {
    const st = wallet.state.status;
    return st && st.current_height ? { tipHeight: Number(st.current_height), tipTime: Number(st.current_state_timestamp) || Math.floor(Date.now() / 1000) } : null;
  };

  // ------------------------------------------------------------ what the button says
  function ctaState() {
    const n = name();
    if (preparing) return { off: 'Building the registration…' };
    if (!n) return { off: input.value.trim() ? describeNameProblem(nameProblem(normaliseName(input.value))) : 'Type the name you want above.' };
    if (lookup.state === 'checking' || lookup.name !== n) return { off: `Checking ${display(n)}…` };
    if (lookup.state === 'error') return { off: `${display(n)} could not be checked. Try again above.` };
    const res = lookup.res;
    if (!canRegister(res.status)) {
      if (res.ownerKey && mine.key && res.ownerKey === mine.key) return { off: `${display(n)} is already yours. Renew it under My names.` };
      return { off: `${display(n)} is taken. Try another name.` };
    }
    if (!wallet.state.sync.canSend) return { off: `Registering is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` };
    if (paramsError || !params) return { off: paramsError ? 'The BEAM price could not be read. Try again in a minute.' : 'Getting the BEAM price…' };
    if (!params.usdPerBeamText) return { off: 'The BEAM price feed is not updating right now, so names cannot be priced. Try again in a few minutes.' };
    const e = estimateFor(n, draft.years);
    const need = e.minGroth + NAME_CALL_FEE;
    const have = wallet.available(0);
    if (have < need) return { off: `Not enough BEAM. ${display(n)} costs about ${beamAbout(midpoint(e) + NAME_CALL_FEE)} BEAM for ${years(draft.years)}, network fee included. You have ${formatAmount(have)} BEAM.`, receive: true };
    return { off: null };
  }

  function resultCard() {
    const n = name();
    const typed = input.value.trim();
    if (!typed) return null;
    if (!n) return null;
    if (lookup.name !== n || lookup.state === 'checking') {
      return h('div', { class: 'card name-result', 'data-testid': 'names-result', 'data-state': 'checking' }, h('div', { class: 'name-line' }, h('span', { class: 'spinner small' }), h('span', { text: `Checking ${display(n)}…` })));
    }
    if (lookup.state === 'error') {
      return h(
        'div',
        { 'data-testid': 'names-result', 'data-state': 'error' },
        notice('error', `${display(n)} could not be checked: ${lookup.error.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => lookupNow() }, 'Try again')),
      );
    }
    const res = lookup.res;
    const clock = { tipHeight: res.tipHeight, tipTime: res.tipTime };
    const card = (state, title, detail, good) =>
      h(
        'div',
        { class: `card name-result ${good ? 'good' : 'taken'}`, 'data-testid': 'names-result', 'data-state': state },
        h('div', { class: 'name-line' }, icon(good ? 'check' : 'close', 'name-ico'), h('strong', { 'data-testid': 'names-result-title', text: title })),
        detail ? h('p', { class: 'small', text: detail }) : null,
        res.inSync ? null : h('p', { class: 'small', text: 'Your wallet was still catching up when this was checked, so it may be out of date.' }),
      );
    const isMine = res.ownerKey && mine.key && res.ownerKey === mine.key;
    switch (res.status) {
      case STATUS.available:
        return card('available', `${display(n)} is available`, null, true);
      case STATUS.availableAgain:
        return card('available', `${display(n)} is available`, 'Its last owner let it expire, so anyone can register it now.', true);
      case STATUS.onHold:
        return isMine
          ? card('mine', `${display(n)} is yours, but it expired`, `Renew it by ${day(dateOf(holdEndHeight(res.domain.expireHeight), clock))} under My names, or anyone can take it.`, false)
          : card('taken', `${display(n)} is taken`, `Its registration lapsed, but its owner can still renew it until ${day(dateOf(holdEndHeight(res.domain.expireHeight), clock))}. After that anyone can register it.`, false);
      default:
        if (isMine) return card('mine', `${display(n)} is already yours`, `Registered until ${day(dateOf(res.domain.expireHeight, clock))}.`, false);
        return card(
          'taken',
          `${display(n)} is taken`,
          `Registered until ${day(dateOf(res.domain.expireHeight, clock))}. If it is not renewed, anyone can register it after ${day(dateOf(holdEndHeight(res.domain.expireHeight), clock))}.${res.status === STATUS.forSale ? ' Its owner has listed it for sale; buying names is not in BEAM Campfire yet.' : ''}`,
          false,
        );
    }
  }

  function quote() {
    const n = name();
    if (!n || lookup.name !== n || lookup.state !== 'done' || !canRegister(lookup.res.status)) return null;
    const e = estimateFor(n, draft.years);
    const rows = [
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'How long' }), yearsStepper(draft.years, MAX_PERIODS, (v) => {
        draft.years = v;
        result = null;
        render();
      })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Price' }), h('span', { class: 'v', 'data-testid': 'names-usd', text: `${usd(usdPerPeriod(n.length) * draft.years)}` })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'In BEAM today' }), h('span', { class: 'v', 'data-testid': 'names-beam', text: e ? `≈ ${beamAbout(midpoint(e))} BEAM` : paramsError ? 'Unavailable right now' : '…' })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'names-fee', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })),
    ];
    const tip = tipOf();
    return h(
      'div',
      { class: 'name-quote' },
      h('div', { class: 'card flat swap-details' }, ...rows),
      h(
        'p',
        { class: 'small', 'data-testid': 'names-price-note' },
        `${usd(usdPerPeriod(n.length))} a year for ${n.length} characters, paid in BEAM at today's rate${params && params.usdPerBeamText ? ` (1 BEAM ≈ $${params.usdPerBeamText})` : ''}. The approve sheet shows the exact amount.${tip ? ` Until about ${day(dateOf(expiryAfterRegister({ tipHeight: tip.tipHeight, periods: draft.years }), tip))}.` : ''}`,
      ),
    );
  }

  function render() {
    if (!alive) return;
    const n = name();
    const typed = input.value.trim();
    if (!typed) {
      hint.textContent = 'Names cost $10 a year for 5 or more characters, $120 for 4 and $320 for 3, paid in BEAM. Use a-z, 0-9, - _ ~.';
      hint.className = 'hint';
    } else if (!n) {
      hint.textContent = describeNameProblem(nameProblem(normaliseName(typed)));
      hint.className = 'hint bad';
    } else {
      hint.textContent = `${n.length} characters: ${usd(usdPerPeriod(n.length))} a year.`;
      hint.className = 'hint';
    }
    input.classList.toggle('bad', Boolean(typed && !n));
    lead.classList.toggle('hidden', Boolean(typed));
    put(resultBox, resultCard());
    put(quoteBox, quote());

    const st = ctaState();
    const sheetNotes = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'names-notice';
      el.dataset.code = result.code || '';
      sheetNotes.push(el);
    }
    put(notes, ...sheetNotes);
    cta.disabled = Boolean(st.off);
    cta.textContent = n && lookup.name === n && lookup.state === 'done' && canRegister(lookup.res.status) ? `Register ${n} for ${years(draft.years)}` : 'Register a name';
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'names-receive', onclick: () => app.go('receive') }, 'Receive BEAM') : null);
    reason.classList.toggle('hidden', !st.off);
    renderMine();
  }

  function renderMine() {
    const tip = mine.tip;
    const rows = [];
    for (const [pn, p] of pending) {
      if (mine.list.some((d) => d.name === pn && (p.kind === 'register' || d.expireHeight > p.expireBefore))) continue;
      rows.push(h('div', { class: 'row asset-row', 'data-testid': 'names-pending' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'main' }, h('div', { class: 't', text: display(pn) }), h('div', { class: 's', text: p.kind === 'register' ? 'Registering: shows here once confirmed, usually within 2 minutes' : 'Renewing: the new date shows once confirmed' }))));
    }
    for (const d of mine.list) {
      const lapsed = d.status === STATUS.onHold;
      const gone = d.status === STATUS.availableAgain;
      const sub = !tip
        ? ''
        : gone
          ? `Expired on ${day(dateOf(d.expireHeight, tip))}; anyone can register it now`
          : lapsed
            ? `Expired. Renew by ${day(dateOf(holdEndHeight(d.expireHeight), tip))} to keep it`
            : `Until ${day(dateOf(d.expireHeight, tip))}`;
      rows.push(
        h(
          'div',
          { class: 'row asset-row', 'data-testid': 'names-mine-row', 'data-name': d.name },
          h('span', { class: `ico ${lapsed || gone ? 'fail' : 'in'}` }, icon(lapsed || gone ? 'alert' : 'check')),
          h('span', { class: 'main' }, h('div', { class: 't', text: display(d.name) }), h('div', { class: 's', text: sub })),
          gone ? null : h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'names-renew', onclick: () => renew(d) }, 'Renew'),
        ),
      );
    }
    let body;
    if (mine.state === 'loading' && !rows.length) body = h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Reading your names from the BEAM network…' }));
    else if (mine.state === 'error' && !rows.length) body = notice('error', `Your names could not be read: ${mine.error.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: loadMine }, 'Try again'));
    else if (!rows.length) body = h('p', { class: 'small', 'data-testid': 'names-mine-empty', text: 'Names you register show here, with when to renew them.' });
    else body = h('div', { class: 'card list', 'data-testid': 'names-mine' }, ...rows);
    put(mineBox, h('p', { class: 'section-title', text: 'My names' }), body, mine.list.length > 1 ? h('p', { class: 'small', text: 'Every name in this wallet shares one key, so anyone can see they belong together.' }) : null);
  }

  // ------------------------------------------------------------ lookups
  function onInput() {
    // Names are lower case on chain: typing Alice shows alice.
    if (/[A-Z]/.test(input.value)) {
      const at = input.selectionStart;
      input.value = input.value.replace(/[A-Z]/g, (c) => c.toLowerCase());
      input.setSelectionRange(at, at);
    }
    draft.text = input.value;
    result = null;
    clearTimeout(timer);
    seq++;
    const n = name();
    lookup = n ? { state: 'checking', name: n } : { state: 'idle' };
    render();
    if (n) timer = setTimeout(lookupNow, LOOKUP_DEBOUNCE_MS);
  }

  async function lookupNow() {
    const n = name();
    if (!n) return;
    const mineSeq = ++seq;
    lookup = { state: 'checking', name: n };
    render();
    try {
      const res = await bans().resolve(n);
      if (!alive || mineSeq !== seq) return;
      lookup = { state: 'done', name: n, res };
    } catch (e) {
      if (!alive || mineSeq !== seq) return;
      lookup = { state: 'error', name: n, error: e };
    }
    render();
  }

  async function loadParams() {
    paramsError = null;
    try {
      params = await bans().params();
    } catch (e) {
      paramsError = e;
    }
    if (alive) render();
  }

  async function loadMine() {
    mine = { ...mine, state: 'loading' };
    renderMine();
    try {
      const r = await bans().myNames();
      if (!alive) return;
      mine = { state: 'done', list: r.names.slice().sort((a, b) => a.expireHeight - b.expireHeight), key: r.key, tip: { tipHeight: r.tipHeight, tipTime: r.tipTime } };
      for (const [pn, p] of [...pending]) if (r.names.some((d) => d.name === pn && (p.kind === 'register' || d.expireHeight > p.expireBefore))) pending.delete(pn);
    } catch (e) {
      if (!alive) return;
      mine = { ...mine, state: 'error', error: e };
    }
    render();
  }

  // ------------------------------------------------------------ actions
  async function register() {
    const n = name();
    if (!n || preparing || ctaState().off) return;
    const y = draft.years;
    const e = estimateFor(n, y);
    preparing = true;
    result = null;
    render();
    try {
      await bans().register(n, y, { estimate: e });
      if (!alive) return;
      pending.set(n, { kind: 'register', at: Date.now() });
      result = { kind: 'success', code: 'sent', text: `${display(n)} is on its way to you. It shows under My names once the network confirms it, usually within 2 minutes.` };
      input.value = '';
      draft.text = '';
      lookup = { state: 'idle' };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (err) {
      if (!alive) return;
      result = { kind: err.code === 'rejected' ? 'info' : 'error', code: err.code || 'error', text: nameProblemText(err, 'registration') };
      if (err.code === 'priceMoved') loadParams();
    }
    preparing = false;
    render();
  }

  function renew(d) {
    const tip = mine.tip || tipOf();
    if (!tip) return;
    const max = Math.max(1, maxExtendPeriods({ expireHeight: d.expireHeight, tipHeight: tip.tipHeight }));
    let y = 1;
    let busy = false;
    let msg = null;
    openSheet(
      (close, rerender) => {
        const e = params && params.usdPerBeamText ? priceEstimate({ usdPerPeriod: usdPerPeriod(d.name.length), periods: y, medianText: params.usdPerBeamText }) : null;
        const need = e ? e.minGroth + NAME_CALL_FEE : null;
        const short = need != null && wallet.available(0) < need;
        const paused = !wallet.state.sync.canSend;
        const off = busy ? 'Building the renewal…' : paused ? `Renewing is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` : !e ? 'Getting the BEAM price…' : short ? `Not enough BEAM. This costs about ${beamAbout(midpoint(e) + NAME_CALL_FEE)} BEAM, network fee included. You have ${formatAmount(wallet.available(0))} BEAM.` : null;
        const go = async () => {
          if (off) return;
          busy = true;
          msg = null;
          rerender();
          try {
            await bans().extend(d.name, y, { estimate: e });
            pending.set(d.name, { kind: 'renew', at: Date.now(), expireBefore: d.expireHeight });
            close(true);
            toast(`Renewal of ${display(d.name)} sent. The new date shows once confirmed.`);
            wallet.refreshTxs();
            render();
            return;
          } catch (err) {
            msg = nameProblemText(err, 'renewal');
            if (err.code === 'priceMoved') await loadParams();
          }
          busy = false;
          rerender();
        };
        return [
          h('h2', { text: `Renew ${display(d.name)}` }),
          h('p', { class: 'small', text: d.status === STATUS.onHold ? `It expired; renewing now keeps it.` : `Registered until ${day(dateOf(d.expireHeight, tip))}. Years are added to that date.` }),
          h(
            'div',
            { class: 'card flat swap-details' },
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'How long' }), yearsStepper(y, max, (v) => {
              y = v;
              rerender();
            }, 'renew-years')),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Price' }), h('span', { class: 'v', text: usd(usdPerPeriod(d.name.length) * y) })),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'In BEAM today' }), h('span', { class: 'v', 'data-testid': 'renew-beam', text: e ? `≈ ${beamAbout(midpoint(e))} BEAM` : '…' })),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'New end date' }), h('span', { class: 'v', text: `about ${day(dateOf(expiryAfterExtend({ expireHeight: d.expireHeight, tipHeight: tip.tipHeight, periods: y }), tip))}` })),
          ),
          msg ? notice('error', msg) : null,
          off ? h('p', { class: 'hint center', 'data-testid': 'renew-reason', text: off }) : null,
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn btn-primary', 'data-testid': 'renew-cta', disabled: Boolean(off), onclick: go }, `Renew ${d.name} for ${years(y)}`),
            h('button', { class: 'btn btn-text', onclick: () => close(false) }, 'Close'),
          ),
        ];
      },
      { label: `Renew ${display(d.name)}` },
    );
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') register();
  });
  const off = wallet.onChange(() => render());
  render();
  loadParams();
  loadMine();
  if (name()) lookupNow();

  const el = screen(
    {
      title: 'BEAM names',
      back: () => {
        app.namesDraft = null;
        app.back('home');
      },
      cls: 'names feature',
    },
    lead,
    h('label', { class: 'field' }, 'Find a name', h('div', { class: 'input-wrap suffix' }, input, h('span', { class: 'suffix-text', 'aria-hidden': 'true', text: '.beam' }))),
    hint,
    resultBox,
    quoteBox,
    notes,
    h('div', { class: 'actions inline-actions' }, reason, cta),
    mineBox,
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
