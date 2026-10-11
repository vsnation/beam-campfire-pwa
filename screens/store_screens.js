// The registry of BEAM's DApp Store screens (screens/dapp_store.js). Their code, the store's reader
// and the IPFS hash load only when one is opened: dApps and Home stay as light as they were.
import { h } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';

/** A screen from dapp_store.js imported on first use; a spinner until then. */
function lazyScreen(name, title) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' }));
    let inner = null;
    let dead = false;
    import('./dapp_store.js')
      .then((m) => {
        if (dead) return;
        inner = m[name](app, params) || {};
        holder.replaceWith(inner.el || inner);
      })
      .catch((e) => {
        if (dead) return;
        console.error(e);
        holder.replaceWith(screen({ title, back: () => app.back('dapps') }, notice('error', `This screen could not be opened: ${e.message}. Go back and try again.`)));
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

export const STORE_SCREENS = Object.freeze({
  dappStore: lazyScreen('dappStore', "BEAM's DApp Store"),
  dappStoreItem: lazyScreen('dappStoreItem', 'DApp Store'),
  dappPublisher: lazyScreen('dappPublisher', 'Publisher'),
  dappPublishers: lazyScreen('dappPublishers', 'Publishers'),
});
