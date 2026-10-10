// The Ethereum screens, loaded only when one is opened: the Ethereum code
// (noble-curves, keccak, BIP39...) is about half a megabyte that a BEAM-only
// session never needs, so nothing here imports it statically. Also the
// BEAM / Ethereum switcher both Homes show.
import { h } from '../lib/dom.js';
import { notice, screen } from '../lib/ui.js';

let lockHookInstalled = false;

/** A screen whose module is imported on first use; a spinner until then. */
function lazyScreen(load) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' }));
    let inner = null;
    let dead = false;
    load()
      .then(async (m) => {
        if (!lockHookInstalled) {
          lockHookInstalled = true;
          const { forgetEthWallet } = await import('../lib/eth/wallet.js');
          // On lock: forget the address, the derived data keys and any words still in memory.
          app.lockHooks.add(() => {
            forgetEthWallet();
            if (app.ethSetup && Array.isArray(app.ethSetup.words)) app.ethSetup.words.fill('');
            app.ethSetup = null;
          });
        }
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
};

/**
 * One compact row at the top of both Homes: which wallet is on screen.
 * Ethereum opens its Home, which offers to create one when there is none.
 */
export function chainSwitch(app, active) {
  const opt = (id, label, go) =>
    h('button', { class: `chain-opt${active === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active === id), 'data-testid': `chain-${id}`, onclick: active === id ? null : go }, label);
  return h(
    'div',
    { class: 'chain-switch', role: 'tablist', 'aria-label': 'Wallet' },
    opt('beam', 'BEAM', () => app.go('home')),
    opt('eth', 'Ethereum', () => app.go('ethHome')),
  );
}
