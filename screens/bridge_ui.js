// The bridge while BEAM Campfire is unlocked: one controller for this BEAM
// wallet and this Ethereum wallet (lib/bridge/controller.js), built from the
// app's own parts, plus the pieces the bridge screens share (the steps, a
// crossing's row, the CoinGecko question).
//
// * The crossings are sealed under the wallet's database password
//   (lib/bridge/store.js) and followed again on unlock (resumeAll), so a move
//   survives the page being closed or reloaded.
// * The controller polls only while the page is visible and the wallet
//   unlocked; locking stops it and forgets it, and remembers - without amount
//   or address - which bridge screen was open, so the unlock screen can say
//   "Unlock to follow" and go back to it.
// * Prices come from CoinGecko only after the person allowed it once
//   (prefs.bridgePrices === true): CoinGecko sees the IP address.

import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, secondary, textButton } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { store } from '../lib/store.js';
import { ethWallet, ethPrefs, forgetEthWallet } from '../lib/eth/wallet.js';
import { withEthKey } from '../lib/eth/vault.js';
import { EthPipe } from '../lib/bridge/eth_pipe.js';
import { BeamPipe } from '../lib/bridge/beam_pipe.js';
import { PriceFeed } from '../lib/bridge/prices.js';
import { BridgeController, beamSide } from '../lib/bridge/controller.js';
import { bridgeStoreFor } from '../lib/bridge/store.js';
import { setMoveBadge } from './eth_screens.js';
import { headline, crossingWords, lockedNote } from './bridge_words.js';
import { ago } from './bridge_text.js';

/** The bridge screens (registered in eth_screens.js). */
export const BRIDGE_SCREENS = new Set(['bridgeMove', 'bridgeCrossing', 'bridgeList']);

/** true: allowed; false: refused; null: not asked yet. */
export function pricesChoice(app) {
  const v = app && app.prefs ? app.prefs.bridgePrices : undefined;
  return v === true ? true : v === false ? false : null;
}

let session = null; // {key, app, ctl, eth, w, off}
let opening = null;
let hookInstalled = false;

function badge(ctl) {
  const open = ctl.crossings.filter((c) => !['paid', 'failed', 'claimed', 'lockFailed'].includes(c.state));
  if (open.some((c) => c.state === 'delivered')) return 'collect';
  return open.length ? 'open' : null;
}

function installLockHook(app) {
  if (hookInstalled) return;
  hookInstalled = true;
  app.lockHooks.add(() => {
    const s = session;
    // Which bridge screen to come back to, and where its move was (no amount, no address).
    if (BRIDGE_SCREENS.has(app.currentName)) {
      const c = s && app.currentName === 'bridgeCrossing' && app.params ? s.ctl.crossing(app.params.id) : null;
      app.afterUnlock = { name: app.currentName, params: { ...(app.params || {}) }, note: c ? lockedNote(c, { blocksLeft: s.ctl.blocksLeft(c) }) : null };
    } else app.afterUnlock = null;
    endSession();
    forgetEthWallet();
  });
}

function endSession() {
  const s = session;
  session = null;
  opening = null;
  if (!s) return;
  s.off();
  s.ctl.dispose();
}

/**
 * The bridge of the unlocked wallet, its crossings loaded and followed:
 * {ctl, eth, w} - or null when this device has no Ethereum wallet. Throws
 * when locked, or when the saved crossings do not open.
 */
export async function bridgeOf(app) {
  if (!app || !app.dbPass || !app.record) throw Object.assign(new Error('Unlock the wallet first.'), { code: 'locked' });
  installLockHook(app);
  const w = await ethWallet(app);
  if (!w) return null;
  const key = `${app.record.id}|${w.ethId}|${ethPrefs(app).rpcId}`;
  if (session && session.key === key && session.app === app) return session;
  if (opening && opening.key === key) return opening.promise;
  // Another Ethereum server was picked (or another wallet): start again on it.
  if (session) endSession();
  const promise = (async () => {
    const eth = new EthPipe({ rpc: w.rpc, owner: w.state.address, withKey: (fn) => withEthKey(app, fn) });
    const prices = new PriceFeed({ allowed: () => pricesChoice(app) === true });
    const ctl = new BridgeController({
      beam: beamSide({ pipe: new BeamPipe(), wallet }),
      eth,
      prices,
      store: bridgeStoreFor(app, store),
      beamWalletId: app.record.id,
      ethWalletId: w.ethId,
    });
    const activity = () => ctl.setActive({ visible: document.visibilityState === 'visible', unlocked: Boolean(app.dbPass) });
    document.addEventListener('visibilitychange', activity);
    const offChange = ctl.onChange(() => setMoveBadge(badge(ctl)));
    const s = {
      key,
      app,
      ctl,
      eth,
      w,
      off() {
        document.removeEventListener('visibilitychange', activity);
        offChange();
      },
    };
    try {
      await ctl.resumeAll();
    } catch (e) {
      s.off();
      ctl.dispose();
      throw e;
    }
    if (!app.dbPass) {
      s.off();
      ctl.dispose();
      throw Object.assign(new Error('Unlock the wallet first.'), { code: 'locked' });
    }
    activity();
    session = s;
    setMoveBadge(badge(ctl));
    return s;
  })();
  opening = { key, promise };
  try {
    return await promise;
  } finally {
    if (opening && opening.promise === promise) opening = null;
  }
}

/** Why the bridge could not open, in words, with the way out. */
export function bridgeProblem(e, retry) {
  const sealed = e && ['wrong_secret', 'mismatch', 'malformed', 'weak'].includes(e.code);
  return h(
    'div',
    { 'data-testid': 'bridge-unavailable' },
    notice(
      'error',
      h('strong', { text: sealed ? "Your saved moves didn't open. " : "The bridge couldn't open. " }),
      sealed
        ? 'They were kept exactly as they were; nothing was changed or sent. Lock and unlock BEAM Campfire, then try again.'
        : `One of your wallets did not answer (${(e && e.message) || e}). This is not something you did, and nothing was sent.`,
      retry ? h('div', { class: 'btn-row prompt-actions' }, secondary('Try again', retry, { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-retry' })) : null,
    ),
  );
}

// ---------------------------------------------------------------- pieces

const MARKS = { done: 'check', active: 'clock', waiting: null, failed: 'close' };

/** The steps of a move, each marked done, under way, still to come, or failed. */
export function stepList(steps) {
  return h(
    'ol',
    { class: 'card bridge-steps', 'data-testid': 'bridge-steps' },
    ...steps.map((s, i) =>
      h(
        'li',
        { class: `bridge-step ${s.status}`, 'data-testid': `bridge-step-${i}`, 'data-status': s.status },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, MARKS[s.status] ? icon(MARKS[s.status]) : null),
        h('span', { class: 'label', text: s.label }),
        s.note ? h('span', { class: 'note', text: s.note }) : null,
        h('span', { class: 'sr', text: { done: ' (done)', active: ' (now)', waiting: ' (next)', failed: ' (did not happen)' }[s.status] }),
      ),
    ),
  );
}

/** One move in a list: where it goes, where it is, when it started. */
export function crossingRow(ctl, c, onclick) {
  const w = crossingWords(c, { blocksLeft: ctl.blocksLeft(c) });
  const cls = w.needsYou ? 'you' : `mood-${w.mood}`;
  return h(
    'button',
    { class: 'row bridge-row', onclick, 'data-testid': 'bridge-row', 'data-id': c.id, 'data-state': c.state },
    h('span', { class: `ico ${w.mood === 'error' ? 'fail' : w.mood === 'success' ? 'in' : 'swap'}` }, icon(w.mood === 'success' ? 'check' : w.mood === 'error' ? 'close' : 'clock')),
    h('span', { class: 'main' }, h('div', { class: 't', text: headline(c) }), h('div', { class: 's' }, h('span', { class: `bridge-short ${cls}`, 'data-testid': 'bridge-row-status', text: w.short }), ` · ${ago(c.createdAt)}`)),
    h('span', { class: 'chev' }, icon('chevron')),
  );
}

/**
 * The one-time question before any price is asked of CoinGecko. allow() and
 * refuse() store the answer; the screen re-renders.
 */
export function priceQuestion({ allow, refuse }) {
  return h(
    'div',
    { class: 'card bridge-ask', 'data-testid': 'bridge-prices-ask' },
    h('h3', { text: 'The bridge fee follows coin prices' }),
    h('p', { class: 'small', text: "To work it out, BEAM Campfire asks CoinGecko for the prices of ETH and of the coin you move, the same prices the bridge uses. CoinGecko sees your IP address, not your wallets. It is asked only while you use the bridge." }),
    h('div', { class: 'btn-row prompt-actions' }, secondary('Allow CoinGecko prices', allow, { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-prices-allow' }), textButton('Not now', refuse, { class: 'btn btn-text btn-small', 'data-testid': 'bridge-prices-refuse' })),
  );
}

/** Said when prices were refused and this move needs them: which move still works, and the way back. */
export function pricesOff({ allow, useWbeam }) {
  return h(
    'div',
    { 'data-testid': 'bridge-prices-off' },
    notice(
      'info',
      h('strong', { text: 'Prices are off, so this move cannot be priced. ' }),
      'Without prices only WBEAM → BEAM can move: its bridge fee is a fixed 0.02 WBEAM. Every other bridge fee follows CoinGecko prices.',
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        useWbeam ? secondary('Move WBEAM to BEAM', useWbeam, { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-use-wbeam' }) : null,
        textButton('Allow CoinGecko prices', allow, { class: 'btn btn-text btn-small', 'data-testid': 'bridge-prices-allow' }),
      ),
    ),
  );
}

/** Whether there is anything saved for the bridge on this device (cheap: one store read). */
export async function hasSavedCrossings() {
  return Boolean(await store.get('bridge'));
}
