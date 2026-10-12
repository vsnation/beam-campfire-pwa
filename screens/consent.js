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
  if (req.kind === 'send') return `Send ${pay[0]}`;
  // About: BEAM may still finish an approved swap at a slightly lower price (lib/dex.js rebuildFloor).
  if (req.intent && req.intent.action === 'swap' && pay.length === 1 && get.length === 1) return `Swap ${pay[0]} for ≈${get[0]}`;
  const own = intentLabel(req.intent, pay, get);
  if (own) return own;
  if (pay.length && get.length) return `Pay ${pay.join(' + ')}, get ${get.join(' + ')}`;
  if (pay.length) return `Pay ${pay.join(' + ')}`;
  if (get.length) return `Approve and get ${get.join(' + ')}`;
  return 'Approve';
}

/** The wallet's own features (names, airdrops) say what approving does in their words. */
function intentLabel(intent, pay, get) {
  if (!intent) return null;
  const one = (l) => (l.length === 1 ? l[0] : null);
  switch (intent.action) {
    case 'nameRegister':
      return pay.length === 1 && !get.length ? `Pay ${pay[0]} and register ${intent.name}` : null;
    case 'nameRenew':
      return pay.length === 1 && !get.length ? `Pay ${pay[0]} and renew ${intent.name}` : null;
    case 'namePay':
      return pay.length === 1 && !get.length ? `Send ${pay[0]} to ${intent.name}.beam` : null;
    case 'airdropCreate':
      return pay.length === 1 && !get.length ? `Lock ${pay[0]} in ${intent.count} ${intent.count === 1 ? 'code' : 'codes'}` : null;
    case 'airdropClaim':
      return one(get) && !pay.length ? `Claim ${get[0]}` : null;
    case 'airdropCancel':
      return one(get) && !pay.length ? `Take back ${get[0]}` : null;
    case 'poolAdd':
      return pay.length === 2 && get.length === 1 ? `Add ${pay.join(' + ')} to the pool` : null;
    case 'poolWithdraw':
      return one(pay) && get.length ? `Withdraw ${get.join(' + ')}` : null;
    case 'poolCreate':
      return one(pay) && !get.length ? `Lock ${pay[0]} and create the pool` : null;
    case 'tokenCreate':
      return one(pay) && !get.length ? `Pay ${pay[0]} and create ${intent.ticker}` : null;
    case 'tokenMint':
      return one(get) && !pay.length ? `Mint ${get[0]}` : null;
    case 'burn':
      return one(pay) && !get.length ? `Burn ${pay[0]} forever` : null;
    case 'nameTransfer':
      return !pay.length && !get.length ? `Transfer ${intent.name}` : null;
    case 'nameSell':
      return !pay.length && !get.length ? `List ${intent.name} for sale` : null;
    case 'nameUnlist':
      return !pay.length && !get.length ? `Stop selling ${intent.name}` : null;
    case 'nameBuy':
      return one(pay) && !get.length ? `Pay ${pay[0]} and buy ${intent.name}` : null;
    case 'nameClaim':
      return !pay.length && get.length ? (one(get) ? `Claim ${get[0]}` : 'Claim all') : null;
    default:
      return null;
  }
}

const TITLES = { nameRegister: 'Confirm your name', nameRenew: 'Confirm the renewal', namePay: 'Approve this payment', airdropCreate: 'Confirm your codes', airdropClaim: 'Confirm your claim', airdropCancel: 'Take back unclaimed codes', poolAdd: 'Confirm your deposit', poolWithdraw: 'Confirm your withdrawal', poolCreate: 'Confirm the new pool', tokenCreate: 'Confirm your new token', tokenMint: 'Confirm the mint', burn: 'Burn for good', nameTransfer: 'Confirm the transfer', nameSell: 'Confirm the listing', nameUnlist: 'Stop selling', nameBuy: 'Confirm your purchase', nameClaim: 'Confirm your claim' };

/** What the rows call what leaves and what arrives, for the wallet's own DEX pool moves. */
const ROW_WORDS = { poolAdd: ['You add', 'You get'], poolWithdraw: ['You return', 'You get back'], poolCreate: ['Deposit (locked)', 'You receive'] };

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
    return notice('warn', h('strong', { text: `${formatAmount(BigInt(intent.issueFee) + BigInt(intent.deposit))} BEAM do not come back. ` }), `${formatAmount(BigInt(intent.issueFee))} BEAM go to the BEAM DAO as the issuance fee and ${formatAmount(BigInt(intent.deposit))} BEAM stay locked with the token, even if you never mint it.`);
  }
  if (intent.action === 'burn') return notice('error', h('strong', { text: 'Nobody can undo this. ' }), 'The tokens are locked in a contract that has no way to give anything back.');
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
  return ids.length ? ids.map(unit).join(' or ') : 'BEAM';
}

function title(req, bridge) {
  if (bridge) return bridge.kind === 'collect' ? 'Collect your coins' : 'Confirm your move';
  if (req.kind === 'send') return 'Approve this payment';
  if (req.intent && req.intent.action === 'swap') return 'Confirm your swap';
  if (req.intent && TITLES[req.intent.action]) return TITLES[req.intent.action];
  if (req.native && nameTitle(req.intent)) return nameTitle(req.intent);
  return 'Approve this request';
}

/** Shows one consent request. Resolves true only when the person approved and proved it is them. */
export function presentConsent(app, req) {
  // The bridge's words load only for a bridge request (the approve sheet is on every page).
  if (req.native && req.intent && req.intent.action === 'bridge') {
    return import('./bridge_text.js').then(
      (t) => showConsent(app, req, t.bridgeConsent(req), t),
      () => showConsent(app, req, null, null),
    );
  }
  return showConsent(app, req, null, null);
}

/** The bridge rows: what leaves, what arrives and where, every fee, and when. */
function bridgeCard(req, b, t) {
  const kv = (k, v, testid, note = null) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, h('span', { 'data-testid': testid, text: v }), note ? h('div', { class: 'small', text: note }) : null));
  const r = b.route;
  if (b.kind === 'collect') {
    return h(
      'div',
      { class: 'card bridge-card', 'data-testid': 'consent-bridge' },
      kv('You collect', `${formatAmount(b.amount)} ${r.beamSymbol}`, 'consent-get-0'),
      kv('From', "BEAM's official bridge", 'consent-bridge-from', b.msgId != null ? `transfer #${b.msgId}, from your Ethereum wallet` : 'from your Ethereum wallet'),
      kv('Network fee', `${formatAmount(req.fee)} BEAM`, 'consent-fee'),
      kv('Into', 'your BEAM wallet', 'consent-bridge-into'),
    );
  }
  const when = t.arrivesText(r, t.TO_ETHEREUM);
  return h(
    'div',
    { class: 'card bridge-card', 'data-testid': 'consent-bridge' },
    kv('You move', `${formatAmount(b.amount)} ${r.beamSymbol}`, 'consent-bridge-amount'),
    kv('Bridge fee', `${formatAmount(b.fee)} ${r.beamSymbol}`, 'consent-bridge-fee', 'paid to the bridge operator'),
    kv('Network fee', `${formatAmount(req.fee)} BEAM`, 'consent-fee'),
    kv('Leaves your BEAM wallet', r.isBeam ? `${formatAmount(b.out)} BEAM` : `${formatAmount(b.out)} ${r.beamSymbol} + ${formatAmount(req.fee)} BEAM`, 'consent-total'),
    kv('Arrives on Ethereum', `${t.exact(b.receives, r.ethDecimals)} ${r.ethSymbol}`, 'consent-bridge-receives'),
    h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'In your Ethereum wallet' }), h('span', { class: 'v mono addr-groups', 'data-testid': 'consent-bridge-to', 'data-address': b.receiver, text: t.grouped(b.receiver) })),
    kv('Arrives', when.replace(/;.*/, ''), 'consent-bridge-time', when.replace(/^[^;]*; /, '')),
  );
}

function showConsent(app, req, bridge, t) {
  const wallet = app.wallet;
  const ids = [...new Set([0, ...req.spends.map((a) => a.assetId), ...req.receives.map((a) => a.assetId)])];
  for (const id of ids) if (id !== 0 && !wallet.assetNamed.has(id) && wallet.session) wallet.loadAsset(id);
  const unit = (id) => wallet.label(id).unit;
  let busy = false;
  const extras = intentExtras(req);
  const words = (req.native && req.intent && ROW_WORDS[req.intent.action]) || null;
  let acked = !extras.ack;

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
          const ok = await confirmIdentity(app, { title: 'Confirm it is you', detail: label, cta: 'Confirm' });
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
            h('span', { text: native ? 'BEAM Campfire, this wallet' : `${req.appName} asks you to approve` }),
          ),
          !native && req.publisher
            ? h('p', { class: 'tag store', 'data-testid': 'consent-publisher', text: `From BEAM's DApp Store · published by ${req.publisher.name} (${req.publisher.key.slice(0, 8)}…${req.publisher.key.slice(-6)})` })
            : !native && req.unchecked
              ? h('p', { class: 'tag unchecked', 'data-testid': 'consent-unchecked', text: 'Installed from a file · not checked by BEAM Campfire' })
              : null,
          bridge
            ? bridgeCard(req, bridge, t)
            : h(
                'div',
                { class: 'card' },
                ...req.spends.map((a, i) => row(words ? (i ? '' : words[0]) : req.kind === 'send' ? 'You send' : req.intent && req.intent.action === 'burn' ? 'Destroyed for good' : 'You pay', a, `consent-pay-${i}`, '')),
                // A swap's amount is the engine's first build; BEAM may finish it a little lower ("You get at least" below).
                ...req.receives.map((a, i) => row(words ? (i ? '' : words[1]) : req.intent && req.intent.action === 'swap' ? 'You get about' : 'You receive', a, `consent-get-${i}`, '')),
                req.address ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono', text: shorten(req.address, 10, 8) })) : null,
                req.intent && req.intent.action === 'namePay' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v', 'data-testid': 'consent-to', text: `${req.intent.name}.beam` })) : null,
                h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'consent-fee', text: `${formatAmount(req.fee)} BEAM` })),
                showTotal ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total BEAM out' }), h('span', { class: 'v', 'data-testid': 'consent-total', text: `${formatAmount(beamOut)} BEAM` })) : null,
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
          bridge && bridge.kind === 'send' && enough ? h('div', { 'data-testid': 'consent-bridge-public' }, notice('info', t.PUBLIC_NOTE)) : null,
          native && req.intent && intentNote(req.intent) ? h('div', { 'data-testid': 'consent-intent-note' }, intentNote(req.intent)) : null,
          ...(extras.notes || []).map((t, i) => h('p', { class: 'small', 'data-testid': `consent-note-${i}`, text: t })),
          !native && req.comment ? h('p', { class: 'small', text: `The app describes it as: “${req.comment}”` }) : null,
          notListed.length ? h('p', { class: 'small', 'data-testid': 'consent-unlisted', text: `${notListed.map((a) => `${wallet.label(a.assetId).symbol} is asset #${a.assetId}`).join('; ')}: not on BEAM Campfire's list of known assets. Check the number if the name matters to you.` }) : null,
          !native ? notice('warn', `Only approve if you trust ${req.appName}. Approving lets it move what is listed above.`) : null,
          enough
            ? null
            : h(
                'div',
                { 'data-testid': 'consent-not-enough' },
                notice(
                  'error',
                  h('strong', { text: `Not enough ${short ? unit(short.assetId) : spentUnits(req, unit)}. ` }),
                  short
                    ? `You need ${formatAmount(short.need)} ${unit(short.assetId)}${short.includesFee && !req.spends.some((a) => a.assetId === 0) ? ' for the network fee' : short.includesFee ? `, including the ${formatAmount(req.fee)} BEAM network fee` : ''}. You have ${formatAmount(short.have)}. Add ${unit(short.assetId)} to this wallet${native ? '' : ' (Receive on the Wallet tab)'}, then try again.`
                    : `The wallet can't spend this much right now${req.fee > 0n ? ` (the ${formatAmount(req.fee)} BEAM network fee included)` : ''}. Part of the balance may be in a payment that has not finished: try again in a minute, or add more${native ? '' : ' on the Wallet tab (Receive)'}.`,
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
                  short ? `Add ${unit(short.assetId)}` : 'Add funds',
                )
              : null,
            h('button', { class: `btn ${enough || native ? 'btn-text' : 'btn-secondary'}`, 'data-testid': 'consent-cancel', onclick: () => close(false) }, 'Cancel'),
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
      toast('The request was withdrawn. Nothing was sent.');
    };
    sheet.then((v) => {
      off();
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
      // The wallet's own screens show a status page; inside a dApp this is the only sign it went.
      if (v === true && !req.native) toast('Approved and sent. It shows in Activity, usually within a minute.', 6000);
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
