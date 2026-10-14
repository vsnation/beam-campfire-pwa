/* BEAM names
 * Spec: ONE job: get a short name people can pay instead of a long address, and keep it.
 *       Primary CTA: "Register alice for 1 year" ("Buy alice for 500 BEAM" when its owner sells it);
 *       the approve sheet that follows shows the exact BEAM.
 *       Taps from app open: 1 (Home -> BEAM names), type a name, 2 ("Register ..."), then approve.
 *       A name of mine: 2 (its row), where Renew, Transfer and Sell are.
 * Exit-intent reasons and answers:
 *   - "What does a name cost?" -> the dollar prices by length are on screen before typing; the BEAM
 *     amount appears with the result, and the approve sheet shows it exactly.
 *   - "Is it free?" -> checked on the wallet's own node 0.4 s after typing stops, with when a taken
 *     name could become free; a name its owner sells shows its price and Buy.
 *   - "Am I about to lose my name?" -> My names shows each expiry, a warning 30 days before and once it
 *     lapsed, with Renew one tap away.
 *   - "Someone paid my name (or bought it): where is the money?" -> a card at the top with what waits
 *     and Claim; when this version cannot see it, that is said plainly with what can be checked.
 *   - "How do I get a name someone gives me?" -> "Receive a name from another wallet" shows the key.
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
import { isEmpty, VISIBILITY, amountsText, balanceChange } from '../lib/bans_inbox.js';
import { nameInbox, runClaim, setNamesHint } from './names_claim.js';
import { statusWords, pendingWords, pendingDone, priceText, needsRenewal, daysBetween } from './name_parts.js';
import { rememberNames } from '../lib/notify.js';
import { syncReason } from '../lib/sync.js';
import { t, tn, dateLocale } from '../lib/i18n.js';

const PENDING_FORGET_MS = 30 * 60000;

const LOOKUP_DEBOUNCE_MS = 400;

/** BANS for the running wallet (one per session). */
export function bans() {
  return bansFor(wallet.session, () => wallet.session.call('wallet_status', {}, { timeoutMs: 15000 }));
}

export const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;
export const years = (n) => tn({ one: '{n} year', other: '{n} years' }, n);
export const day = (ms) => new Date(ms).toLocaleDateString(dateLocale('en-GB'), { day: 'numeric', month: 'short', year: 'numeric' });
const beamAbout = (g) => formatAmount(g, { maxDecimals: g >= 100000000n ? 0 : 4 });
const midpoint = (e) => (e.minGroth + e.maxGroth) / 2n;

/** "The registration was not sent: {reason} Nothing left your wallet.", one whole sentence per kind. */
function notSentText(what, reason) {
  switch (what) {
    case 'registration':
      return t('The registration was not sent: {reason} Nothing left your wallet.', { reason });
    case 'renewal':
      return t('The renewal was not sent: {reason} Nothing left your wallet.', { reason });
    case 'purchase':
      return t('The purchase was not sent: {reason} Nothing left your wallet.', { reason });
    case 'transfer':
      return t('The transfer was not sent: {reason} Nothing left your wallet.', { reason });
    case 'listing':
      return t('The listing was not sent: {reason} Nothing left your wallet.', { reason });
    case 'change':
      return t('The change was not sent: {reason} Nothing left your wallet.', { reason });
    case 'claim':
      return t('The claim was not sent: {reason} Nothing left your wallet.', { reason });
    case 'payment':
      return t('The payment was not sent: {reason} Nothing left your wallet.', { reason });
    default:
      return t('The transaction was not sent: {reason} Nothing left your wallet.', { reason });
  }
}

/**
 * Plain words for whatever stopped a name transaction. what: 'registration', 'renewal', 'purchase',
 * 'transfer', 'listing', 'change', 'claim' or 'payment' (screens/review.js).
 */
export function nameProblemText(e, what) {
  const code = e && e.code;
  if (code === 'rejected') return t('Cancelled. Nothing was sent.');
  if (code === 'timeout') return t('The wallet did not answer in time. Check Activity before trying again.');
  if (code === 'load' || code === 'mismatch') return e.message;
  if (code === 'refused' || code === 'unexpected' || code === 'priceMoved' || code === 'ownerChanged' || code === 'nameChanged' || code === 'wrongVault' || code === 'invalidName' || code === 'notMine' || code === 'invalidKey' || code === 'claimUnsupported') return e.message;
  const m = String((e && e.message) || e || t('unknown error'));
  return notSentText(what, `${m}${/\.$/.test(m) ? '' : '.'}`);
}

/** − 1 year + */
export function yearsStepper(value, max, onChange, testid = 'names-years') {
  const minus = h('button', { class: 'icon-btn stepper-btn', type: 'button', 'aria-label': t('One year less'), 'data-testid': `${testid}-minus`, disabled: value <= 1, onclick: () => onChange(value - 1) }, h('span', { text: '−' }));
  const plus = h('button', { class: 'icon-btn stepper-btn', type: 'button', 'aria-label': t('One year more'), 'data-testid': `${testid}-plus`, disabled: value >= max, onclick: () => onChange(value + 1) }, h('span', { text: '+' }));
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
  const inbox = nameInbox();
  let claiming = false;
  let claimMsg = null; // { ok, code, text }
  const moneyBox = h('div', { 'aria-live': 'polite' });

  const input = h('input', { class: 'input name-input', type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: String(NAME_MAX + 5), placeholder: 'alice', 'aria-label': t('Name'), 'data-testid': 'names-input' });
  input.value = draft.text;
  const hint = h('p', { class: 'hint', 'data-testid': 'names-hint' });
  const resultBox = h('div', { 'aria-live': 'polite' });
  const quoteBox = h('div');
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'names-reason', 'aria-live': 'polite' });
  const cta = primary(t('Register a name'), () => primaryAction(), { disabled: true, 'data-testid': 'names-cta' });
  const mineBox = h('div', { class: 'names-mine-box' });
  const lead = h('p', { class: 'lead', text: t('A name lets people pay you as alice.beam instead of a long address.') });

  const name = () => tryName(input.value);
  const estimateFor = (n, y) => (params && params.usdPerBeamText ? priceEstimate({ usdPerPeriod: usdPerPeriod(n.length), periods: y, medianText: params.usdPerBeamText }) : null);
  const tipOf = () => {
    const st = wallet.state.status;
    return st && st.current_height ? { tipHeight: Number(st.current_height), tipTime: Number(st.current_state_timestamp) || Math.floor(Date.now() / 1000) } : null;
  };

  // ------------------------------------------------------------ what the button says
  function ctaState() {
    const n = name();
    if (preparing) return { off: t('Building the registration…') };
    if (!n) return { off: input.value.trim() ? describeNameProblem(nameProblem(normaliseName(input.value))) : t('Type the name you want above.') };
    if (lookup.state === 'checking' || lookup.name !== n) return { off: t('Checking {name}…', { name: display(n) }) };
    if (lookup.state === 'error') return { off: t('{name} could not be checked. Try again above.', { name: display(n) }) };
    const res = lookup.res;
    if (!canRegister(res.status)) {
      if (res.ownerKey && mine.key && res.ownerKey === mine.key) return { off: t('{name} is already yours. Renew it under My names.', { name: display(n) }) };
      const price = forSale(res);
      if (price) {
        const label = t('Buy {name} for {price}', { name: n, price: priceText(price) });
        if (preparing) return { off: t('Building the purchase…'), label };
        if (!wallet.state.sync.canSend) return { off: t('Buying is paused: {reason}.', { reason: pausedWhy() }), label };
        const need = price.assetId === 0 ? price.amount + NAME_CALL_FEE : price.amount;
        const have = wallet.available(price.assetId);
        if (have < need) {
          const unitName = wallet.label(price.assetId).unit;
          const why = price.assetId === 0
            ? t('Not enough {unit}. {name} costs {price}, plus the 0.011 BEAM network fee. You have {have} {unit}.', { unit: unitName, name: display(n), price: priceText(price), have: formatAmount(have) })
            : t('Not enough {unit}. {name} costs {price}. You have {have} {unit}.', { unit: unitName, name: display(n), price: priceText(price), have: formatAmount(have) });
          return { off: why, receive: true, label };
        }
        if (price.assetId !== 0 && wallet.available(0) < NAME_CALL_FEE) return { off: t('You need {fee} BEAM for the network fee. You have {have} BEAM.', { fee: formatAmount(NAME_CALL_FEE), have: formatAmount(wallet.available(0)) }), receive: true, label };
        return { off: null, buy: price, label };
      }
      return { off: t('{name} is taken. Try another name.', { name: display(n) }) };
    }
    if (!wallet.state.sync.canSend) return { off: t('Registering is paused: {reason}.', { reason: pausedWhy() }) };
    if (paramsError || !params) return { off: paramsError ? t('The BEAM price could not be read. Try again in a minute.') : t('Getting the BEAM price…') };
    if (!params.usdPerBeamText) return { off: t('The BEAM price feed is not updating right now, so names cannot be priced. Try again in a few minutes.') };
    const e = estimateFor(n, draft.years);
    const need = e.minGroth + NAME_CALL_FEE;
    const have = wallet.available(0);
    if (have < need) {
      return {
        off: tn(
          { one: 'Not enough BEAM. {name} costs about {amount} BEAM for {n} year, network fee included. You have {have} BEAM.', other: 'Not enough BEAM. {name} costs about {amount} BEAM for {n} years, network fee included. You have {have} BEAM.' },
          draft.years,
          { name: display(n), amount: beamAbout(midpoint(e) + NAME_CALL_FEE), have: formatAmount(have) },
        ),
        receive: true,
      };
    }
    return { off: null };
  }

  /** Why sending is paused, as the sync line says it, for "… is paused: {reason}." */
  function pausedWhy() {
    return syncReason(wallet.state.sync.title);
  }

  /** The price of a name someone else sells (still theirs, not long expired), or null. */
  function forSale(res) {
    const d = res && res.domain;
    if (!d || !d.salePrice || res.status === STATUS.availableAgain) return null;
    if (mine.key && res.ownerKey === mine.key) return null;
    return d.salePrice;
  }

  function resultCard() {
    const n = name();
    const typed = input.value.trim();
    if (!typed) return null;
    if (!n) return null;
    if (lookup.name !== n || lookup.state === 'checking') {
      return h('div', { class: 'card name-result', 'data-testid': 'names-result', 'data-state': 'checking' }, h('div', { class: 'name-line' }, h('span', { class: 'spinner small' }), h('span', { text: t('Checking {name}…', { name: display(n) }) })));
    }
    if (lookup.state === 'error') {
      return h(
        'div',
        { 'data-testid': 'names-result', 'data-state': 'error' },
        notice('error', t('{name} could not be checked: {reason}', { name: display(n), reason: lookup.error.message }), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => lookupNow() }, t('Try again'))),
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
        res.inSync ? null : h('p', { class: 'small', text: t('Your wallet was still catching up when this was checked, so it may be out of date.') }),
      );
    const isMine = res.ownerKey && mine.key && res.ownerKey === mine.key;
    const price = forSale(res);
    if (price) {
      return h(
        'div',
        { class: 'card name-result good', 'data-testid': 'names-result', 'data-state': 'forSale' },
        h('div', { class: 'name-line' }, icon('swap', 'name-ico'), h('strong', { 'data-testid': 'names-result-title', text: t('{name} is for sale: {price}', { name: display(n), price: priceText(price) }) })),
        h(
          'p',
          { class: 'small', 'data-testid': 'names-sale-detail', text: res.status === STATUS.onHold ? t('Its registration lapsed. Buying does not renew it: renew it by {date} or anyone can take it.', { date: day(dateOf(holdEndHeight(res.domain.expireHeight), clock)) }) : t('Buying it gives you the time left on it, until {date}. It does not renew it.', { date: day(dateOf(res.domain.expireHeight, clock)) }) },
        ),
        res.inSync ? null : h('p', { class: 'small', text: t('Your wallet was still catching up when this was checked, so it may be out of date.') }),
      );
    }
    switch (res.status) {
      case STATUS.available:
        return card('available', t('{name} is available', { name: display(n) }), null, true);
      case STATUS.availableAgain:
        return card('available', t('{name} is available', { name: display(n) }), t('Its last owner let it expire, so anyone can register it now.'), true);
      case STATUS.onHold:
        return isMine
          ? card('mine', t('{name} is yours, but it expired', { name: display(n) }), t('Renew it by {date} under My names, or anyone can take it.', { date: day(dateOf(holdEndHeight(res.domain.expireHeight), clock)) }), false)
          : card('taken', t('{name} is taken', { name: display(n) }), t('Its registration lapsed, but its owner can still renew it until {date}. After that anyone can register it.', { date: day(dateOf(holdEndHeight(res.domain.expireHeight), clock)) }), false);
      default:
        if (isMine) {
          const c = card('mine', t('{name} is already yours', { name: display(n) }), t('Registered until {date}.', { date: day(dateOf(res.domain.expireHeight, clock)) }), false);
          c.appendChild(h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'names-manage', onclick: () => app.go('nameDetail', { name: n }) }, t('Manage {name}', { name: n })));
          return c;
        }
        return card(
          'taken',
          t('{name} is taken', { name: display(n) }),
          t('Registered until {date}. If it is not renewed, anyone can register it after {after}.', { date: day(dateOf(res.domain.expireHeight, clock)), after: day(dateOf(holdEndHeight(res.domain.expireHeight), clock)) }),
          false,
        );
    }
  }

  function quote() {
    const n = name();
    if (!n || lookup.name !== n || lookup.state !== 'done' || !canRegister(lookup.res.status)) return null;
    const e = estimateFor(n, draft.years);
    const rows = [
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('How long') }), yearsStepper(draft.years, MAX_PERIODS, (v) => {
        draft.years = v;
        result = null;
        render();
      })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Price') }), h('span', { class: 'v', 'data-testid': 'names-usd', text: `${usd(usdPerPeriod(n.length) * draft.years)}` })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('In BEAM today') }), h('span', { class: 'v', 'data-testid': 'names-beam', text: e ? `≈ ${beamAbout(midpoint(e))} BEAM` : paramsError ? t('Unavailable right now') : '…' })), // i18n-ignore: an amount and its ticker
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'names-fee', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })), // i18n-ignore: an amount and its ticker
    ];
    const tip = tipOf();
    const perYear = usd(usdPerPeriod(n.length));
    // Two or three whole sentences: the price (with today's rate when known), the approve sheet, the end date.
    const priceNote = params && params.usdPerBeamText
      ? tn({ one: "{price} a year for {n} character, paid in BEAM at today's rate (1 BEAM ≈ {rate}).", other: "{price} a year for {n} characters, paid in BEAM at today's rate (1 BEAM ≈ {rate})." }, n.length, { price: perYear, rate: `$${params.usdPerBeamText}` })
      : tn({ one: "{price} a year for {n} character, paid in BEAM at today's rate.", other: "{price} a year for {n} characters, paid in BEAM at today's rate." }, n.length, { price: perYear });
    return h(
      'div',
      { class: 'name-quote' },
      h('div', { class: 'card flat swap-details' }, ...rows),
      h(
        'p',
        { class: 'small', 'data-testid': 'names-price-note' },
        [priceNote, t('The approve sheet shows the exact amount.'), tip ? t('Until about {date}.', { date: day(dateOf(expiryAfterRegister({ tipHeight: tip.tipHeight, periods: draft.years }), tip)) }) : null].filter(Boolean).join(' '),
      ),
    );
  }

  function render() {
    if (!alive) return;
    const n = name();
    const typed = input.value.trim();
    if (!typed) {
      hint.textContent = t('Names cost $10 a year for 5 or more characters, $120 for 4 and $320 for 3, paid in BEAM. Use a-z, 0-9, - _ ~.');
      hint.className = 'hint';
    } else if (!n) {
      hint.textContent = describeNameProblem(nameProblem(normaliseName(typed)));
      hint.className = 'hint bad';
    } else {
      hint.textContent = tn({ one: '{n} character: {price} a year.', other: '{n} characters: {price} a year.' }, n.length, { price: usd(usdPerPeriod(n.length)) });
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
    cta.textContent = st.label || (n && lookup.name === n && lookup.state === 'done' && canRegister(lookup.res.status) ? tn({ one: 'Register {name} for {n} year', other: 'Register {name} for {n} years' }, draft.years, { name: n }) : t('Register a name'));
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'names-receive', onclick: () => app.go('receive') }, t('Receive BEAM')) : null);
    reason.classList.toggle('hidden', !st.off);
    renderMine();
    renderMoney();
  }

  // ------------------------------------------------------------ money waiting for my names
  function renderMoney() {
    if (!alive) return;
    const s = inbox.latest;
    const fmt = (g) => formatAmount(g);
    const unit = (id) => wallet.label(id).unit;
    const msg = claimMsg ? h('div', { 'data-testid': 'names-claim-msg', 'data-code': claimMsg.code }, notice(claimMsg.ok ? 'success' : claimMsg.calm || claimMsg.code === 'nothing' ? 'info' : 'error', claimMsg.text)) : null;
    if (inbox.claiming) {
      const r = inbox.claiming.receives;
      return put(moneyBox, msg || notice('info', t('Claim on its way: {amounts}. It shows in your balance once confirmed.', { amounts: [...r.keys()].map((id) => `+${fmt(r.get(id))} ${unit(id)}`).join(', ') })));
    }
    if (s && s.visibility === VISIBILITY.unsupported) {
      return put(
        moneyBox,
        h(
          'div',
          { 'data-testid': 'names-claim-unsupported' },
          notice(
            'info',
            h('strong', { text: `${t("This version can't see payments to your names yet.")} ` }),
            `${t('They are safe in the BEAM vault. Money from a name you sold can be claimed now.')} `,
            h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'names-check-sale', disabled: claiming, onclick: checkSale }, claiming ? t('Checking…') : t('Check for money from a sale')),
          ),
        ),
        msg,
      );
    }
    if (!s || isEmpty(s)) return put(moneyBox, msg);
    const amounts = amountsText(s.totals, fmt, unit);
    const title = s.paymentCount && s.saleCount ? t('{amounts} is waiting for your names', { amounts }) : s.paymentCount ? t('People paid your names: {amounts} is waiting', { amounts }) : t('You sold a name: {amounts} is waiting for you', { amounts });
    const detail = s.names.length ? t('Sent to {names}. Claim it to move it into your balance.', { names: s.names.map(display).join(', ') }) : t('Claim it to move it into your balance.');
    const one = s.totals.size === 1 ? t('Claim {amount}', { amount: amounts }) : t('Claim all');
    put(
      moneyBox,
      h(
        'div',
        { class: 'card names-money', 'data-testid': 'names-money' },
        h('div', { class: 'name-line' }, icon('gift', 'name-ico'), h('strong', { 'data-testid': 'names-money-title', text: title })),
        h('p', { class: 'small', text: detail }),
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'names-claim', disabled: claiming, onclick: claim }, claiming ? t('Preparing…') : one),
      ),
      msg,
    );
  }

  async function claim() {
    if (claiming) return;
    claiming = true;
    claimMsg = null;
    renderMoney();
    const r = await runClaim(app, inbox);
    claiming = false;
    if (!alive) return;
    claimMsg = r;
    renderMoney();
  }

  /** Where the inbox cannot be read: building a claim of sale proceeds shows whether anything waits. */
  async function checkSale() {
    if (claiming) return;
    claiming = true;
    claimMsg = null;
    renderMoney();
    const assets = [...new Set([0, ...mine.list.filter((d) => d.salePrice).map((d) => d.salePrice.assetId)])];
    let done = { ok: false, code: 'nothing', text: t('Nothing from a name sale is waiting for this wallet.') };
    for (const aid of assets) {
      try {
        await bans().claimSaleProceeds(aid, {
          words: (b) => ({
            rows: [[t('From'), t('A name you sold')], [t('Your balance changes by'), balanceChange(b.receives, b.fee, (g) => formatAmount(g), (id) => wallet.label(id).unit)]],
            notes: [aid === 0 ? t('Pays its own fee: it comes out of the BEAM you are claiming.') : t("The fee is paid from this wallet's BEAM.")],
          }),
        });
        done = { ok: true, code: 'sent', text: t('Claim sent. It shows in your balance once the network confirms it, usually within a few minutes.') };
        wallet.refreshTxs();
        break;
      } catch (e) {
        if (e && (e.refusal === 'noFunds' || e.refusal === 'nothingToClaim')) continue;
        done = { ok: false, code: (e && e.code) || 'error', text: e && e.code === 'rejected' ? t('Cancelled. Nothing was claimed; it is still waiting for you.') : nameProblemText(e, 'claim') };
        break;
      }
    }
    claiming = false;
    if (!alive) return;
    claimMsg = done;
    renderMoney();
  }

  async function loadInbox() {
    await inbox.refresh({ force: true });
    const s = inbox.latest;
    if (s && s.visibility === VISIBILITY.visible) setNamesHint(app, s.owns || !isEmpty(s) || mine.list.length > 0);
    if (alive) renderMoney();
  }

  function renderMine() {
    const tip = mine.tip;
    // When each name expires, for the reminders 7 days and 1 day before (lib/notify.js).
    if (tip) rememberNames(mine.list.map((d) => ({ name: d.name, expiresAt: dateOf(d.expireHeight, tip) })));
    const rows = [];
    for (const [pn, p] of pending) {
      if (Date.now() - p.at > PENDING_FORGET_MS) continue;
      if (mine.list.some((d) => d.name === pn)) continue; // shown on its own row below
      if (p.kind !== 'register' && p.kind !== 'buy') continue;
      rows.push(h('div', { class: 'row asset-row', 'data-testid': 'names-pending' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'main' }, h('div', { class: 't', text: display(pn) }), h('div', { class: 's', text: pendingWords(p) }))));
    }
    for (const d of mine.list) {
      const lapsed = d.status === STATUS.onHold;
      const gone = d.status === STATUS.availableAgain;
      const p = pending.get(d.name);
      const w = tip ? statusWords(d, tip) : null;
      const sub = p && Date.now() - p.at <= PENDING_FORGET_MS ? pendingWords(p) : !tip ? '' : gone ? t('Expired on {date}; anyone can register it now', { date: day(dateOf(d.expireHeight, tip)) }) : lapsed ? t('Expired. Renew by {date} to keep it', { date: day(dateOf(holdEndHeight(d.expireHeight), tip)) }) : w.text;
      const open = () => app.go('nameDetail', { name: d.name });
      rows.push(
        h(
          'div',
          {
            class: 'row asset-row name-row',
            role: 'button',
            tabindex: '0',
            'aria-label': t('{name}: details, renew, transfer or sell', { name: display(d.name) }),
            'data-testid': 'names-mine-row',
            'data-name': d.name,
            onclick: open,
            onkeydown: (ev) => {
              if (ev.key === 'Enter') open();
            },
          },
          h('span', { class: `ico ${lapsed || gone ? 'fail' : 'in'}` }, icon(lapsed || gone ? 'alert' : 'check')),
          h('span', { class: 'main' }, h('div', { class: 't', text: display(d.name) }), h('div', { class: 's', 'data-testid': 'names-mine-status', text: sub }), d.salePrice && !p ? h('div', { class: 's sale', 'data-testid': 'names-mine-sale', text: t('For sale at {price}', { price: priceText(d.salePrice) }) }) : null),
          gone
            ? h('span', { class: 'chev' }, icon('chevron'))
            : h(
                'button',
                {
                  class: 'btn btn-secondary btn-small',
                  type: 'button',
                  'data-testid': 'names-renew',
                  onclick: (ev) => {
                    ev.stopPropagation();
                    renew(d);
                  },
                },
                t('Renew'),
              ),
        ),
      );
    }
    let body;
    if (mine.state === 'loading' && !rows.length) body = h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: t('Reading your names from the BEAM network…') }));
    else if (mine.state === 'error' && !rows.length) body = notice('error', t('Your names could not be read: {reason}', { reason: mine.error.message }), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: loadMine }, t('Try again')));
    else if (!rows.length) body = h('p', { class: 'small', 'data-testid': 'names-mine-empty', text: t('Names you register, buy or receive show here, with when to renew them.') });
    else body = h('div', { class: 'card list', 'data-testid': 'names-mine' }, ...rows);
    put(
      mineBox,
      renewWarning(),
      h('p', { class: 'section-title', text: t('My names') }),
      body,
      mine.list.length > 1 ? h('p', { class: 'small', text: t('Every name in this wallet shares one key, so anyone can see they belong together.') }) : null,
      h('button', { class: 'btn btn-text btn-small names-receive-link', type: 'button', 'data-testid': 'names-receive-name', onclick: () => app.go('nameKey') }, t('Receive a name from another wallet')),
    );
  }

  /**
   * "alice has expired.", "alice expires in 12 days (and 2 more).": the soonest name to renew, when, and
   * how many others are due (more: 0 for none). One whole sentence for each case.
   */
  function dueText(name, lapsed, days, more) {
    if (lapsed) return more ? t('{name} has expired (and {more} more).', { name, more }) : t('{name} has expired.', { name });
    if (days <= 0) return more ? t('{name} expires today (and {more} more).', { name, more }) : t('{name} expires today.', { name });
    if (days === 1) return more ? t('{name} expires tomorrow (and {more} more).', { name, more }) : t('{name} expires tomorrow.', { name });
    return more
      ? tn({ one: '{name} expires in {n} day (and {more} more).', other: '{name} expires in {n} days (and {more} more).' }, days, { name, more })
      : tn({ one: '{name} expires in {n} day.', other: '{name} expires in {n} days.' }, days, { name });
  }

  /** The soonest name to renew (expired, or within 30 days), with Renew one tap away. */
  function renewWarning() {
    const tip = mine.tip;
    if (!tip) return null;
    const due = mine.list.filter((d) => needsRenewal(d, tip.tipHeight) && !pending.has(d.name)).sort((a, b) => a.expireHeight - b.expireHeight);
    if (!due.length) return null;
    const d = due[0];
    const lapsed = d.status === STATUS.onHold;
    return h(
      'div',
      { 'data-testid': 'names-renew-warning' },
      notice(
        'warn',
        h('strong', { text: `${dueText(d.name, lapsed, daysBetween(tip.tipHeight, d.expireHeight), due.length - 1)} ` }),
        `${lapsed ? t('Renew it by {date} to keep it. After that anyone can take it.', { date: day(dateOf(holdEndHeight(d.expireHeight), tip)) }) : t('Renew it to keep it. After it expires you still have 90 days.')} `,
        h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'names-renew-warning-action', onclick: () => renew(d) }, t('Renew {name}', { name: d.name })),
      ),
    );
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
      for (const [pn, p] of [...pending]) if (pendingDone(p, pn, r.names) || Date.now() - p.at > PENDING_FORGET_MS) pending.delete(pn);
      if (r.names.length) setNamesHint(app, true);
    } catch (e) {
      if (!alive) return;
      mine = { ...mine, state: 'error', error: e };
    }
    render();
  }

  // ------------------------------------------------------------ actions
  /** The primary button: Register, or Buy when the name is for sale. */
  function primaryAction() {
    const st = ctaState();
    if (st.off) return;
    if (st.buy) buy(st.buy);
    else register();
  }

  async function buy(price) {
    const n = name();
    if (!n || preparing) return;
    const res = lookup.res;
    const until = day(dateOf(res.domain.expireHeight, { tipHeight: res.tipHeight, tipTime: res.tipTime }));
    preparing = true;
    result = null;
    render();
    try {
      await bans().buy(n, {
        expectedPrice: price,
        words: { rows: [[t('Name'), display(n)], [t('Yours until'), t('about {date}', { date: until })]], notes: [t('Buying does not renew the name: you get the time left on it. Renew it under BEAM names to keep it longer.')] },
      });
      if (!alive) return;
      pending.set(n, { kind: 'buy', at: Date.now() });
      setNamesHint(app, true);
      result = { kind: 'success', code: 'sent', text: t('{name} is on its way to you. It shows under My names once the network confirms it, usually within 2 minutes.', { name: display(n) }) };
      input.value = '';
      draft.text = '';
      lookup = { state: 'idle' };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (err) {
      if (!alive) return;
      result = { kind: err.code === 'rejected' ? 'info' : 'error', code: err.code || 'error', text: nameProblemText(err, 'purchase') };
      if (err.code === 'priceMoved') lookupNow();
    }
    preparing = false;
    render();
  }

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
      setNamesHint(app, true);
      result = { kind: 'success', code: 'sent', text: t('{name} is on its way to you. It shows under My names once the network confirms it, usually within 2 minutes.', { name: display(n) }) };
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
        const off = busy
          ? t('Building the renewal…')
          : paused
            ? t('Renewing is paused: {reason}.', { reason: pausedWhy() })
            : !e
              ? t('Getting the BEAM price…')
              : short
                ? t('Not enough BEAM. This costs about {amount} BEAM, network fee included. You have {have} BEAM.', { amount: beamAbout(midpoint(e) + NAME_CALL_FEE), have: formatAmount(wallet.available(0)) })
                : null;
        const go = async () => {
          if (off) return;
          busy = true;
          msg = null;
          rerender();
          try {
            await bans().extend(d.name, y, { estimate: e });
            pending.set(d.name, { kind: 'renew', at: Date.now(), expireBefore: d.expireHeight });
            close(true);
            toast(t('Renewal of {name} sent. The new date shows once confirmed.', { name: display(d.name) }));
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
          h('h2', { text: t('Renew {name}', { name: display(d.name) }) }),
          h('p', { class: 'small', text: d.status === STATUS.onHold ? t('It expired; renewing now keeps it.') : t('Registered until {date}. Years are added to that date.', { date: day(dateOf(d.expireHeight, tip)) }) }),
          h(
            'div',
            { class: 'card flat swap-details' },
            h('div', { class: 'kv' }, h('span', { class: 'k', text: t('How long') }), yearsStepper(y, max, (v) => {
              y = v;
              rerender();
            }, 'renew-years')),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Price') }), h('span', { class: 'v', text: usd(usdPerPeriod(d.name.length) * y) })),
            h('div', { class: 'kv' }, h('span', { class: 'k', text: t('In BEAM today') }), h('span', { class: 'v', 'data-testid': 'renew-beam', text: e ? `≈ ${beamAbout(midpoint(e))} BEAM` : '…' })), // i18n-ignore: an amount and its ticker
            h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })), // i18n-ignore: an amount and its ticker
            h('div', { class: 'kv' }, h('span', { class: 'k', text: t('New end date') }), h('span', { class: 'v', text: t('about {date}', { date: day(dateOf(expiryAfterExtend({ expireHeight: d.expireHeight, tipHeight: tip.tipHeight, periods: y }), tip)) }) })),
          ),
          msg ? notice('error', msg) : null,
          off ? h('p', { class: 'hint center', 'data-testid': 'renew-reason', text: off }) : null,
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn btn-primary', 'data-testid': 'renew-cta', disabled: Boolean(off), onclick: go }, tn({ one: 'Renew {name} for {n} year', other: 'Renew {name} for {n} years' }, y, { name: d.name })),
            h('button', { class: 'btn btn-text', onclick: () => close(false) }, t('Close')),
          ),
        ];
      },
      { label: t('Renew {name}', { name: display(d.name) }) },
    );
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') primaryAction();
  });
  const off = wallet.onChange(() => render());
  const offInbox = inbox.onChange(() => renderMoney());
  render();
  loadParams();
  loadMine();
  loadInbox();
  if (name()) lookupNow();

  const el = screen(
    {
      title: t('BEAM names'),
      back: () => {
        app.namesDraft = null;
        app.back('home');
      },
      cls: 'names feature',
    },
    moneyBox,
    lead,
    h('label', { class: 'field' }, t('Find a name'), h('div', { class: 'input-wrap suffix' }, input, h('span', { class: 'suffix-text', 'aria-hidden': 'true', text: '.beam' }))), // i18n-ignore: '.beam', the end of every BEAM name
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
      offInbox();
    },
  };
}
