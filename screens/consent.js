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
  if (req.intent && req.intent.action === 'swap' && pay.length === 1 && get.length === 1) return `Swap ${pay[0]} for ${get[0]}`;
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
    default:
      return null;
  }
}

const TITLES = { nameRegister: 'Confirm your name', nameRenew: 'Confirm the renewal', namePay: 'Approve this payment', airdropCreate: 'Confirm your codes', airdropClaim: 'Confirm your claim', airdropCancel: 'Take back unclaimed codes' };

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

function title(req) {
  if (req.kind === 'send') return 'Approve this payment';
  if (req.intent && req.intent.action === 'swap') return 'Confirm your swap';
  if (req.intent && TITLES[req.intent.action]) return TITLES[req.intent.action];
  return 'Approve this request';
}

/** Shows one consent request. Resolves true only when the person approved and proved it is them. */
export function presentConsent(app, req) {
  const wallet = app.wallet;
  const ids = [...new Set([0, ...req.spends.map((a) => a.assetId), ...req.receives.map((a) => a.assetId)])];
  for (const id of ids) if (id !== 0 && !wallet.assetNamed.has(id) && wallet.session) wallet.loadAsset(id);
  const unit = (id) => wallet.label(id).unit;
  let busy = false;

  return new Promise((resolve) => {
    const sheet = openSheet(
      (close, rerender) => {
        const native = req.native && req.appName === NATIVE_APP_NAME;
        const label = approveLabel(req, unit);
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
        const notListed = [...req.spends, ...req.receives].filter((a) => a.assetId !== 0 && !wallet.label(a.assetId).verified);

        const approve = async () => {
          if (busy) return;
          busy = true;
          const ok = await confirmIdentity(app, { title: 'Confirm it is you', detail: label, cta: 'Confirm' });
          busy = false;
          if (ok) close(true);
        };

        return h(
          'div',
          { class: 'consent', 'data-testid': 'consent', 'data-kind': req.kind },
          h('h2', { text: title(req) }),
          h(
            'div',
            { class: 'consent-app', 'data-testid': 'consent-app' },
            native ? h('img', { src: 'img/logo.svg', alt: '' }) : h('span', { class: 'app-dot' }, icon('globe')),
            h('span', { text: native ? 'BEAM Campfire, this wallet' : `${req.appName} asks you to approve` }),
          ),
          h(
            'div',
            { class: 'card' },
            ...req.spends.map((a, i) => row(req.kind === 'send' ? 'You send' : 'You pay', a, `consent-pay-${i}`, '')),
            ...req.receives.map((a, i) => row(req.intent && req.intent.action === 'swap' ? 'You get' : 'You receive', a, `consent-get-${i}`, '')),
            req.address ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono', text: shorten(req.address, 10, 8) })) : null,
            req.intent && req.intent.action === 'namePay' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v', 'data-testid': 'consent-to', text: `${req.intent.name}.beam` })) : null,
            h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'consent-fee', text: `${formatAmount(req.fee)} BEAM` })),
            showTotal ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total BEAM out' }), h('span', { class: 'v', 'data-testid': 'consent-total', text: `${formatAmount(beamOut)} BEAM` })) : null,
          ),
          !native && req.comment ? h('p', { class: 'small', text: `The app describes it as: “${req.comment}”` }) : null,
          notListed.length ? h('p', { class: 'small', 'data-testid': 'consent-unlisted', text: `${notListed.map((a) => `${unit(a.assetId)} is asset #${a.assetId}`).join('; ')}: not on BEAM Campfire's list of known assets. Check the number if the name matters to you.` }) : null,
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
            { class: 'actions' },
            enough ? h('button', { class: 'btn btn-primary wrap', 'data-testid': 'consent-approve', onclick: approve }, label) : null,
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
      { dismissable: false, label: title(req) },
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
