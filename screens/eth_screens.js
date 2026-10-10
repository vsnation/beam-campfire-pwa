// The Ethereum screens, loaded only when one is opened: the Ethereum code
// (noble-curves, keccak, BIP39...) is about half a megabyte that a BEAM-only
// session never needs, so nothing here imports it statically. Also the
// BEAM / Ethereum switcher both Homes show, with the bridge's way in (⇄).
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, screen } from '../lib/ui.js';
import { store } from '../lib/store.js';
import { hasEthWallet } from '../lib/eth/record.js';

let lockHookInstalled = false;

/** On lock: forget the address, the derived data keys and any words still in memory. */
async function ensureEthLockHook(app) {
  if (lockHookInstalled) return;
  lockHookInstalled = true;
  const { forgetEthWallet } = await import('../lib/eth/wallet.js');
  app.lockHooks.add(() => {
    forgetEthWallet();
    if (app.ethSetup && Array.isArray(app.ethSetup.words)) app.ethSetup.words.fill('');
    app.ethSetup = null;
  });
}

/** A screen whose module is imported on first use; a spinner until then. */
function lazyScreen(load) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' }));
    let inner = null;
    let dead = false;
    load()
      .then(async (m) => {
        await ensureEthLockHook(app);
        if (dead) return;
        inner = m.default(app, params) || {};
        holder.replaceWith(inner.el || inner);
        const focus = document.querySelector('#app [data-autofocus]');
        if (focus) focus.focus();
      })
      .catch((e) => {
        if (dead) return;
        console.error(e);
        holder.replaceWith(screen({ title: 'Ethereum', back: () => app.go('home') }, notice('error', `This screen could not be opened: ${e.message}. Go back and try again.`)));
      });
    return {
      el: holder,
      destroy() {
        dead = true;
        if (inner && inner.destroy) inner.destroy();
      },
    };
  };
}

export const ETH_SCREENS = {
  ethStart: lazyScreen(() => import('./eth_start.js')),
  ethWords: lazyScreen(() => import('./eth_words.js')),
  ethConfirm: lazyScreen(() => import('./eth_confirm.js')),
  ethImport: lazyScreen(() => import('./eth_import.js')),
  ethPrivacy: lazyScreen(() => import('./eth_privacy.js')),
  ethHome: lazyScreen(() => import('./eth_home.js')),
  ethReceive: lazyScreen(() => import('./eth_receive.js')),
  ethSend: lazyScreen(() => import('./eth_send.js')),
  ethTx: lazyScreen(() => import('./eth_tx.js')),
  ethSettings: lazyScreen(() => import('./eth_settings.js')),
  ethSwap: lazyScreen(() => import('./eth_swap.js')),
  ethSwapTx: lazyScreen(() => import('./eth_swap_tx.js')),
  bridgeMove: lazyScreen(() => import('./bridge_move.js')),
  bridgeCrossing: lazyScreen(() => import('./bridge_crossing.js')),
  bridgeList: lazyScreen(() => import('./bridge_list.js')),
};

let moveButton = null;
let moveBadge = null;

/** The ⇄ button's dot: 'collect' (a move waits for you), 'open' (one is on its way) or null. */
export function setMoveBadge(state) {
  moveBadge = state || null;
  if (moveButton) {
    moveButton.dataset.badge = moveBadge || '';
    moveButton.setAttribute('aria-label', moveBadge === 'collect' ? 'Move coins between BEAM and Ethereum (a move is ready to collect)' : moveBadge === 'open' ? 'Move coins between BEAM and Ethereum (a move is on its way)' : 'Move coins between BEAM and Ethereum');
  }
}

/**
 * After unlock: when this device has saved bridge moves (and an Ethereum
 * wallet), load the bridge and follow them. Nothing Ethereum is loaded otherwise.
 */
export async function resumeBridgeIfAny(app) {
  try {
    // 'bridge' is lib/bridge/store.js BRIDGE_RECORD_KEY (not imported here: it pulls in the Ethereum code).
    if (!app.dbPass || !(await store.get('bridge')) || !(await hasEthWallet())) return;
    await ensureEthLockHook(app);
    const { bridgeOf } = await import('./bridge_ui.js');
    if (app.dbPass) await bridgeOf(app);
  } catch (e) {
    console.warn('[campfire] bridge resume', e && e.message);
  }
}

/** Ethereum Home's way to the bridge: a row under its buttons. */
export function bridgeEntry(app) {
  return h(
    'button',
    { class: 'card row bridge-entry', onclick: () => app.go('bridgeMove', { dir: 'toBeam', back: 'ethHome' }), 'data-testid': 'eth-move-to-beam' },
    h('span', { class: 'ico' }, icon('bridge')),
    h('span', { class: 'main' }, h('div', { class: 't', text: 'Move to BEAM' }), h('div', { class: 's', text: "Through BEAM's official bridge" })),
    h('span', { class: 'chev' }, icon('chevron')),
  );
}

/**
 * One compact row at the top of both Homes: which wallet is on screen.
 * Ethereum opens its Home, which offers to create one when there is none.
 */
export function chainSwitch(app, active) {
  const opt = (id, label, go) =>
    h('button', { class: `chain-opt${active === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active === id), 'data-testid': `chain-${id}`, onclick: active === id ? null : go }, label);
  moveButton = h(
    'button',
    { class: 'chain-move', 'data-testid': 'chain-move', title: 'Move coins between BEAM and Ethereum', onclick: () => app.go('bridgeMove', { dir: active === 'eth' ? 'toBeam' : 'toEthereum', back: active === 'eth' ? 'ethHome' : 'home' }) },
    icon('bridge'),
  );
  setMoveBadge(moveBadge);
  return h(
    'div',
    { class: 'chain-row' },
    h('div', { class: 'chain-switch', role: 'tablist', 'aria-label': 'Wallet' }, opt('beam', 'BEAM', () => app.go('home')), opt('eth', 'Ethereum', () => app.go('ethHome'))),
    moveButton,
  );
}
