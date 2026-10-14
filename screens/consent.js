/* Approve (a sheet over whatever screen asked)
 * Spec: ONE job: decide whether this request may move money, seeing exactly what the wallet engine will do.
 *       Primary CTA: the outcome, e.g. "Swap 0.01 BEAM for 371.76 FOMO", "Pay 1,162 BEAM and register alice",
 *       "Claim 5 FOMO"; when the wallet holds too little there is no approve button, only "Add BEAM" and Cancel.
 *       Taps from app open: 2 for a swap (Home -> Swap -> "Swap ..." opens this), then this button and
 *       Face ID / password.
 * Exit-intent reasons and answers:
 *   - "What exactly happens?" -> what leaves, what arrives and the network fee, as the engine reported them.
 *   - "Who is asking?" -> the app's name, and for any app that is not the wallet itself a reminder that
 *     only a trusted app should be approved.
 *   - "Why can't I approve?" -> "Not enough BEAM" with how much is needed and one tap to add it.
 *   - "What if I leave?" -> closing, locking or leaving the screen is a No: nothing is sent.
 * The wallet's own token features read as themselves: "Pay 60 BEAM and create CFBC" (with what does not
 *   come back said above the button), "Mint 1,000 CFBC", and a burn: "Burn 5 FOMO forever", its row
 *   "Destroyed for good" and "Nobody can undo this".
 * A move through BEAM's bridge (the wallet's own request, intent.action 'bridge') reads as one:
 *   "Confirm your move" - what leaves, the bridge fee, the network fee, what arrives on Ethereum and
 *   in which wallet, about an hour, and that it is public on both chains - with the button
 *   "Move 300 BEAM to Ethereum"; collecting on BEAM is "Collect 0.5 bETH". The rows are used only
 *   when the engine's report agrees with the request to the groth.
 */
import { h, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, notice, assetBadge, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { setConsentPresenter, NATIVE_APP_NAME } from '../lib/contracts.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { t, tn, tk } from '../lib/i18n.js';

/** "371.76" for the button; the rows above it carry every digit. */
export function shortAmount(groth) {
  const g = BigInt(groth);
  if (g >= 100000000n) return formatAmount(g, { maxDecimals: 2 });
  if (g >= 1000000n) return formatAmount(g, { maxDecimals: 4 });
  return formatAmount(g);
}

/** The primary button's words for a request: what approving does. */
export function approveLabel(req, unit) {
  const pay = req.spends.map((a) => `${shortAmount(a.amount)} ${unit(a.assetId)}`);
  const get = req.receives.map((a) => `${shortAmount(a.amount)} ${unit(a.assetId)}`);
  if (req.kind === 'send') return t('Send {amount}', { amount: pay[0] });
  // About: BEAM may still finish an approved swap at a slightly lower price (lib/dex.js rebuildFloor).
  if (req.intent && req.intent.action === 'swap' && pay.length === 1 && get.length === 1) return t('Swap {pay} for ≈{get}', { pay: pay[0], get: get[0] });
  const own = intentLabel(req.intent, pay, get, req);
  if (own) return own;
  if (pay.length && get.length) return t('Pay {pay}, get {get}', { pay: pay.join(' + '), get: get.join(' + ') });
  if (pay.length) return t('Pay {amount}', { amount: pay.join(' + ') });
  if (get.length) return t('Approve and get {amount}', { amount: get.join(' + ') });
  return t('Approve');
}

/** Amount texts with BEAM's last: the voucher's asset first, the BEAM for fees after it ("5 bETH + 0.044 BEAM"). */
function beamLast(texts, list) {
  if (!list || list.length !== texts.length) return texts;
  return texts.map((text, i) => [text, list[i].assetId === 0]).sort((a, b) => Number(a[1]) - Number(b[1])).map(([text]) => text);
}

/** The wallet's own features (names, airdrops) say what approving does in their words. */
function intentLabel(intent, pay, get, req = null) {
  if (!intent) return null;
  const one = (l) => (l.length === 1 ? l[0] : null);
  switch (intent.action) {
    case 'nameRegister':
      return pay.length === 1 && !get.length ? t('Pay {amount} and register {name}', { amount: pay[0], name: intent.name }) : null;
    case 'nameRenew':
      return pay.length === 1 && !get.length ? t('Pay {amount} and renew {name}', { amount: pay[0], name: intent.name }) : null;
    case 'namePay':
      return pay.length === 1 && !get.length ? t('Send {amount} to {name}', { amount: pay[0], name: `${intent.name}.beam` }) : null;
    // Airdrop v3 also moves BEAM for claim fees paid ahead: locked with the codes, released by a claim
    // (to pay its fee), returned by a take-back. The button names the voucher's asset first.
    case 'airdropCreate':
      return pay.length >= 1 && pay.length <= 2 && !get.length ? tn({ one: 'Lock {amount} in {n} code', other: 'Lock {amount} in {n} codes' }, intent.count, { amount: beamLast(pay, req && req.spends).join(' + ') }) : null;
    case 'airdropClaim': {
      if (pay.length || !get.length || get.length > 2) return null;
      const i = req && intent.assetId != null ? req.receives.findIndex((a) => a.assetId === intent.assetId) : 0;
      return t('Claim {amount}', { amount: get[i >= 0 ? i : 0] });
    }
    case 'airdropCancel':
      return get.length >= 1 && get.length <= 2 && !pay.length ? t('Take back {amount}', { amount: beamLast(get, req && req.receives).join(' + ') }) : null;
    case 'poolAdd':
      return pay.length === 2 && get.length === 1 ? t('Add {amount} to the pool', { amount: pay.join(' + ') }) : null;
    case 'poolWithdraw':
      return one(pay) && get.length ? t('Withdraw {amount}', { amount: get.join(' + ') }) : null;
    case 'poolCreate':
      return one(pay) && !get.length ? t('Lock {amount} and create the pool', { amount: pay[0] }) : null;
    case 'tokenCreate':
      return one(pay) && !get.length ? t('Pay {amount} and create {ticker}', { amount: pay[0], ticker: intent.ticker }) : null;
    case 'tokenMint':
      return one(get) && !pay.length ? t('Mint {amount}', { amount: get[0] }) : null;
    case 'burn':
      return one(pay) && !get.length ? t('Burn {amount} forever', { amount: pay[0] }) : null;
    case 'nameTransfer':
      return !pay.length && !get.length ? t('Transfer {name}', { name: intent.name }) : null;
    case 'nameSell':
      return !pay.length && !get.length ? t('List {name} for sale', { name: intent.name }) : null;
    case 'nameUnlist':
      return !pay.length && !get.length ? t('Stop selling {name}', { name: intent.name }) : null;
    case 'nameBuy':
      return one(pay) && !get.length ? t('Pay {amount} and buy {name}', { amount: pay[0], name: intent.name }) : null;
    case 'nameClaim':
      return !pay.length && get.length ? (one(get) ? t('Claim {amount}', { amount: get[0] }) : t('Claim all')) : null;
    default:
      return null;
  }
}

// The sheet's title for the wallet's own features (tk: shown with t()).
const TITLES = { nameRegister: tk('Confirm your name'), nameRenew: tk('Confirm the renewal'), namePay: tk('Approve this payment'), airdropCreate: tk('Confirm your codes'), airdropClaim: tk('Confirm your claim'), airdropCancel: tk('Take back unclaimed codes'), poolAdd: tk('Confirm your deposit'), poolWithdraw: tk('Confirm your withdrawal'), poolCreate: tk('Confirm the new pool'), tokenCreate: tk('Confirm your new token'), tokenMint: tk('Confirm the mint'), burn: tk('Burn for good'), nameTransfer: tk('Confirm the transfer'), nameSell: tk('Confirm the listing'), nameUnlist: tk('Stop selling'), nameBuy: tk('Confirm your purchase'), nameClaim: tk('Confirm your claim') };

/** What the rows call what leaves and what arrives, for the wallet's own DEX pool moves (tk: shown with t()). */
const ROW_WORDS = { poolAdd: [tk('You add'), tk('You get')], poolWithdraw: [tk('You return'), tk('You get back')], poolCreate: [tk('Deposit (locked)'), tk('You receive')] };

/**
 * The wallet's own features may add to the sheet (native requests only; a dApp's
 * intent is always null): rows [[label, text]] under the fee, a warning, a
 * statement the person must tick before the approve button works, and notes
 * (plain lines under the card).
 */
export function intentExtras(req) {
  const i = req && req.native ? req.intent : null;
  if (!i) return { rows: [], warn: null, ack: null };
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : null);
  const rows = Array.isArray(i.rows) ? i.rows.filter((r) => Array.isArray(r) && text(r[0]) && text(r[1])).slice(0, 4).map((r) => [text(r[0]), text(r[1])]) : [];
  const notes = Array.isArray(i.notes) ? i.notes.map(text).filter(Boolean).slice(0, 4) : [];
  return notes.length ? { rows, warn: text(i.warn), ack: text(i.ack), notes } : { rows, warn: text(i.warn), ack: text(i.ack) };
}

/** What the wallet's own token features say before approving: where the BEAM goes, and that a burn is forever. */
function intentNote(intent) {
  if (!intent) return null;
  if (intent.action === 'tokenCreate' && intent.issueFee != null && intent.deposit != null) {
    return notice(
      'warn',
      h('strong', { text: `${t('{amount} BEAM do not come back.', { amount: formatAmount(BigInt(intent.issueFee) + BigInt(intent.deposit)) })} ` }),
      t('{fee} BEAM go to the BEAM DAO as the issuance fee and {deposit} BEAM stay locked with the token, even if you never mint it.', { fee: formatAmount(BigInt(intent.issueFee)), deposit: formatAmount(BigInt(intent.deposit)) }),
    );
  }
  if (intent.action === 'burn') return notice('error', h('strong', { text: `${t('Nobody can undo this.')} ` }), t('The tokens are locked in a contract that has no way to give anything back.'));
  return null;
}

/**
 * Which asset is short, measured against this wallet's balances: the words for
 * the engine's "not enough", and for the wallet's own features also the check
 * that the network fee is covered (the engine's isEnough leaves it out). What
 * the request itself brings in of an asset counts towards it.
 */
export function shortfall(req, available) {
  const need = new Map();
  for (const a of req.spends) need.set(a.assetId, (need.get(a.assetId) || 0n) + a.amount);
  need.set(0, (need.get(0) || 0n) + req.fee);
  for (const a of req.receives) if (need.has(a.assetId)) need.set(a.assetId, need.get(a.assetId) - a.amount);
  for (const [assetId, n] of need) {
    const have = available(assetId);
    if (n > 0n && have < n) return { assetId, need: n, have, includesFee: assetId === 0 && req.fee > 0n };
  }
  return null;
}

/** "BEAM", or "FOMO or BEAM": what a request spends, the fee's BEAM included. */
export function spentUnits(req, unit) {
  const ids = [...new Set([...req.spends.map((a) => a.assetId), ...(req.fee > 0n ? [0] : [])])];
  return ids.length ? ids.map(unit).reduce((first, second) => t('{first} or {second}', { first, second })) : 'BEAM';
}

function title(req, bridge) {
  if (bridge) return bridge.kind === 'collect' ? t('Collect your coins') : t('Confirm your move');
  if (req.kind === 'send') return t('Approve this payment');
  if (req.intent && req.intent.action === 'swap') return t('Confirm your swap');
  if (req.intent && TITLES[req.intent.action]) return t(TITLES[req.intent.action]);
  return t('Approve this request');
}

/** Shows one consent request. Resolves true only when the person approved and proved it is them. */
export function presentConsent(app, req) {
  // The bridge's words load only for a bridge request (the approve sheet is on every page).
  if (req.native && req.intent && req.intent.action === 'bridge') {
    return import('./bridge_text.js').then(
      (bt) => showConsent(app, req, bt.bridgeConsent(req), bt),
      () => showConsent(app, req, null, null),
    );
  }
  return showConsent(app, req, null, null);
}

/** The bridge rows: what leaves, what arrives and where, every fee, and when. bt: screens/bridge_text.js. */
function bridgeCard(req, b, bt) {
  const kv = (k, v, testid, note = null) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, h('span', { 'data-testid': testid, text: v }), note ? h('div', { class: 'small', text: note }) : null));
  const r = b.route;
  if (b.kind === 'collect') {
    return h(
      'div',
      { class: 'card bridge-card', 'data-testid': 'consent-bridge' },
      kv(t('You collect'), `${formatAmount(b.amount)} ${r.beamSymbol}`, 'consent-get-0'),
      kv(t('From'), t("BEAM's official bridge"), 'consent-bridge-from', b.msgId != null ? t('transfer #{id}, from your Ethereum wallet', { id: b.msgId }) : t('from your Ethereum wallet')),
      kv(t('Network fee'), `${formatAmount(req.fee)} BEAM`, 'consent-fee'),
      kv(t('Into'), t('your BEAM wallet'), 'consent-bridge-into'),
    );
  }
  // When it arrives, and under it how long it can take when Ethereum is busy.
  const when = bt.arrivesParts(r, bt.TO_ETHEREUM);
  return h(
    'div',
    { class: 'card bridge-card', 'data-testid': 'consent-bridge' },
    kv(t('You move'), `${formatAmount(b.amount)} ${r.beamSymbol}`, 'consent-bridge-amount'),
    kv(t('Bridge fee'), `${formatAmount(b.fee)} ${r.beamSymbol}`, 'consent-bridge-fee', t('paid to the bridge operator')),
    kv(t('Network fee'), `${formatAmount(req.fee)} BEAM`, 'consent-fee'),
    kv(t('Leaves your BEAM wallet'), r.isBeam ? `${formatAmount(b.out)} BEAM` : `${formatAmount(b.out)} ${r.beamSymbol} + ${formatAmount(req.fee)} BEAM`, 'consent-total'),
    kv(t('Arrives on Ethereum'), `${bt.exact(b.receives, r.ethDecimals)} ${r.ethSymbol}`, 'consent-bridge-receives'),
    h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('In your Ethereum wallet') }), h('span', { class: 'v mono addr-groups', 'data-testid': 'consent-bridge-to', 'data-address': b.receiver, text: bt.grouped(b.receiver) })),
    kv(t('Arrives'), when.time, 'consent-bridge-time', when.slow || when.time),
  );
}

function showConsent(app, req, bridge, bt) {
  const wallet = app.wallet;
  const ids = [...new Set([0, ...req.spends.map((a) => a.assetId), ...req.receives.map((a) => a.assetId)])];
  for (const id of ids) if (id !== 0 && !wallet.assetNamed.has(id) && wallet.session) wallet.loadAsset(id);
  const unit = (id) => wallet.label(id).unit;
  let busy = false;
  const extras = intentExtras(req);
  const words = (req.native && req.intent && ROW_WORDS[req.intent.action]) || null;
  let acked = !extras.ack;
  // Not enough: what is missing, what there is, and where to add it; three sentences, each whole.
  const shortText = (short, native) => {
    const amount = `${formatAmount(short.need)} ${unit(short.assetId)}`;
    const need =
      short.includesFee && !req.spends.some((a) => a.assetId === 0)
        ? t('You need {amount} for the network fee.', { amount })
        : short.includesFee
          ? t('You need {amount}, including the {fee} BEAM network fee.', { amount, fee: formatAmount(req.fee) })
          : t('You need {amount}.', { amount });
    const add = native ? t('Add {unit} to this wallet, then try again.', { unit: unit(short.assetId) }) : t('Add {unit} to this wallet (Receive on the Wallet tab), then try again.', { unit: unit(short.assetId) });
    return `${need} ${t('You have {amount}.', { amount: formatAmount(short.have) })} ${add}`;
  };
  const cantSpendText = (native) => {
    const now = req.fee > 0n ? t("The wallet can't spend this much right now (the {fee} BEAM network fee included).", { fee: formatAmount(req.fee) }) : t("The wallet can't spend this much right now.");
    const later = native ? t('Part of the balance may be in a payment that has not finished: try again in a minute, or add more.') : t('Part of the balance may be in a payment that has not finished: try again in a minute, or add more on the Wallet tab (Receive).');
    return `${now} ${later}`;
  };

  return new Promise((resolve) => {
    const sheet = openSheet(
      (close, rerender) => {
        const native = req.native && req.appName === NATIVE_APP_NAME;
        const label = bridge ? bridge.label : approveLabel(req, unit);
        // The engine's isEnough counts what a call spends, not its network fee: a claim that only
        // brings tokens in reads as enough on a wallet with no BEAM, and would fail once approved.
        // For the wallet's own features this wallet's balance must cover the fee as well.
        const lacking = shortfall(req, (id) => wallet.available(id));
        const enough = req.isEnough && !(native && lacking);
        const short = enough ? null : lacking;
        const row = (k, a, testid, sign) => {
          const l = wallet.label(a.assetId);
          return h(
            'div',
            { class: 'kv consent-row' },
            h('span', { class: 'k', text: k }),
            h('span', { class: 'v asset-v' }, assetBadge(l, { size: 'small' }), h('span', { 'data-testid': testid, text: `${sign}${formatAmount(a.amount)} ${l.unit}` })),
          );
        };
        const beamOut = req.spends.filter((a) => a.assetId === 0).reduce((s, a) => s + a.amount, 0n) + req.fee;
        const showTotal = req.spends.some((a) => a.assetId === 0) && req.fee > 0n;
        // A bridge asset is named by the bridge's own registry, not by its metadata.
        const notListed = bridge ? [] : [...req.spends, ...req.receives].filter((a) => a.assetId !== 0 && !wallet.label(a.assetId).verified);

        const approve = async () => {
          if (busy || !acked) return;
          busy = true;
          const ok = await confirmIdentity(app, { title: t('Confirm it is you'), detail: label, cta: t('Confirm') });
          busy = false;
          if (ok) close(true);
        };

        return h(
          'div',
          { class: 'consent', 'data-testid': 'consent', 'data-kind': req.kind, 'data-bridge': bridge ? bridge.kind : null },
          h('h2', { text: title(req, bridge) }),
          h(
            'div',
            { class: 'consent-app', 'data-testid': 'consent-app' },
            native ? h('img', { src: 'img/logo.svg', alt: '' }) : h('span', { class: 'app-dot' }, icon('globe')),
            h('span', { text: native ? t('BEAM Campfire, this wallet') : t('{name} asks you to approve', { name: req.appName }) }),
          ),
          !native && req.publisher
            ? h('p', { class: 'tag store', 'data-testid': 'consent-publisher', text: t("From BEAM's DApp Store · published by {publisher} ({key})", { publisher: req.publisher.name, key: `${req.publisher.key.slice(0, 8)}…${req.publisher.key.slice(-6)}` }) })
            : !native && req.unchecked
              ? h('p', { class: 'tag unchecked', 'data-testid': 'consent-unchecked', text: t('Installed from a file · not checked by BEAM Campfire') })
              : null,
          bridge
            ? bridgeCard(req, bridge, bt)
            : h(
                'div',
                { class: 'card' },
                ...req.spends.map((a, i) => row(words ? (i ? '' : t(words[0])) : req.kind === 'send' ? t('You send') : req.intent && req.intent.action === 'burn' ? t('Destroyed for good') : t('You pay'), a, `consent-pay-${i}`, '')),
                // A swap's amount is the engine's first build; BEAM may finish it a little lower ("You get at least" below).
                ...req.receives.map((a, i) => row(words ? (i ? '' : t(words[1])) : req.intent && req.intent.action === 'swap' ? t('You get about') : t('You receive'), a, `consent-get-${i}`, '')),
                req.address ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v mono', text: shorten(req.address, 10, 8) })) : null,
                req.intent && req.intent.action === 'namePay' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v', 'data-testid': 'consent-to', text: `${req.intent.name}.beam` })) : null, // i18n-ignore: a BEAM name
                h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'consent-fee', text: `${formatAmount(req.fee)} BEAM` })), // i18n-ignore: an amount and its ticker
                showTotal ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Total BEAM out') }), h('span', { class: 'v', 'data-testid': 'consent-total', text: `${formatAmount(beamOut)} BEAM` })) : null, // i18n-ignore: an amount and its ticker
                ...extras.rows.map(([k, v], i) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': `consent-extra-${i}`, text: v }))),
              ),
          extras.warn ? h('div', { 'data-testid': 'consent-warn' }, notice('warn', extras.warn)) : null,
          extras.ack && enough
            ? h(
                'label',
                { class: 'check-row', 'data-testid': 'consent-ack' },
                h('input', {
                  type: 'checkbox',
                  'data-testid': 'consent-ack-box',
                  checked: acked,
                  onchange: (e) => {
                    acked = e.target.checked;
                    const b = e.target.closest('.consent').querySelector('[data-testid="consent-approve"]');
                    if (b) b.disabled = !acked;
                  },
                }),
                h('span', { text: extras.ack }),
              )
            : null,
          // Said before approving; when it cannot be approved, what is missing comes first.
          bridge && bridge.kind === 'send' && enough ? h('div', { 'data-testid': 'consent-bridge-public' }, notice('info', t(bt.PUBLIC_NOTE))) : null,
          native && req.intent && intentNote(req.intent) ? h('div', { 'data-testid': 'consent-intent-note' }, intentNote(req.intent)) : null,
          ...(extras.notes || []).map((note, i) => h('p', { class: 'small', 'data-testid': `consent-note-${i}`, text: note })),
          !native && req.comment ? h('p', { class: 'small', text: t('The app describes it as: “{comment}”', { comment: req.comment }) }) : null,
          notListed.length ? h('p', { class: 'small', 'data-testid': 'consent-unlisted', text: t("{assets}: not on BEAM Campfire's list of known assets. Check the number if the name matters to you.", { assets: notListed.map((a) => t('{symbol} is asset #{id}', { symbol: wallet.label(a.assetId).symbol, id: a.assetId })).join('; ') }) }) : null,
          !native ? notice('warn', t('Only approve if you trust {name}. Approving lets it move what is listed above.', { name: req.appName })) : null,
          enough
            ? null
            : h(
                'div',
                { 'data-testid': 'consent-not-enough' },
                notice(
                  'error',
                  h('strong', { text: `${t('Not enough {unit}.', { unit: short ? unit(short.assetId) : spentUnits(req, unit) })} ` }),
                  short ? shortText(short, native) : cantSpendText(native),
                ),
              ),
          h(
            'div',
            // A move's sheet is long: its button stays in sight.
            { class: bridge ? 'actions sheet-actions' : 'actions' },
            enough ? h('button', { class: 'btn btn-primary wrap', 'data-testid': 'consent-approve', onclick: approve, disabled: !acked }, label) : null,
            // The wallet's own swap: the way out of "not enough" is one tap away. (A dApp stays open; its text says where.)
            !enough && native
              ? h(
                  'button',
                  {
                    class: 'btn btn-primary',
                    'data-testid': 'consent-receive',
                    onclick: () => {
                      close(false);
                      app.go('receive');
                    },
                  },
                  short ? t('Add {unit}', { unit: unit(short.assetId) }) : t('Add funds'),
                )
              : null,
            h('button', { class: `btn ${enough || native ? 'btn-text' : 'btn-secondary'}`, 'data-testid': 'consent-cancel', onclick: () => close(false) }, t('Cancel')),
          ),
        );
      },
      { dismissable: false, label: title(req, bridge) },
    );

    const labels = () => ids.map((id) => wallet.label(id).unit).join('|');
    let seen = labels();
    const off = wallet.onChange(() => {
      const now = labels();
      if (now !== seen && !sheet.closed) {
        seen = now;
        sheet.rerender();
      }
    });
    const onAbort = () => {
      if (sheet.closed) return;
      sheet.close(false);
      toast(t('The request was withdrawn. Nothing was sent.'));
    };
    sheet.then((v) => {
      off();
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
      // The wallet's own screens show a status page; inside a dApp this is the only sign it went.
      if (v === true && !req.native) toast(t('Approved and sent. It shows in Activity, usually within a minute.'), 6000);
      resolve(v === true);
    });
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Plugs the consent sheet into lib/contracts.js for this page. */
export function installConsent(app) {
  return setConsentPresenter((req) => presentConsent(app, req));
}
