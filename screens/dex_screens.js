// The registry of the DEX pool screens (pools list, a pool, create a pool, a
// pool move on its way). Their code (screens/pool*.js, lib/dex_liquidity.js)
// loads only when one is opened: Home and Swap stay as light as they were.
import { h } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';
import { t, tk } from '../lib/i18n.js';

/** A screen whose module is imported on first use; a spinner until then. `title` is a tk() text. */
function lazyScreen(load, title) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('Opening') }));
    let inner = null;
    let dead = false;
    load()
      .then((m) => {
        if (dead) return;
        inner = m.default(app, params) || {};
        holder.replaceWith(inner.el || inner);
      })
      .catch((e) => {
        if (dead) return;
        console.error(e);
        holder.replaceWith(screen({ title: t(title), back: () => app.back('home') }, notice('error', t('This screen could not be opened: {reason}. Go back and try again.', { reason: String(e.message) }))));
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

export const DEX_SCREENS = {
  pools: lazyScreen(() => import('./pools.js'), tk('Pools')),
  pool: lazyScreen(() => import('./pool.js'), tk('Pool')),
  poolCreate: lazyScreen(() => import('./pool_create.js'), tk('Create a pool')),
  poolTx: lazyScreen(() => import('./pool_status.js'), tk('Pool')),
};
