/* Buy chooser (a sheet over Home)
 * Spec: ONE job: say which BEAM to buy - the private coin, or the token on Ethereum.
 *       Primary CTA: none - two equal cards, one tap each ("Buy BEAM", "Buy WBEAM").
 *       Taps from app open: Buy (1) -> a card (2) -> its form; its button is 3.
 * Exit-intent reasons and answers:
 *   - "What's the difference?" -> each card says in one line where the coin ends up, whether it is
 *     private or public, and what pays for it.
 *   - "I don't have that wallet" -> the WBEAM card says so and leads to creating the Ethereum
 *     wallet: never a dead end.
 *
 * Also the registry of the Buy BEAM screens, loaded only when one is opened.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, notice, screen, assetBadge } from '../lib/ui.js';
import { hasEthWallet } from '../lib/eth/record.js';

/** A screen whose module is imported on first use; a spinner until then. */
function lazyScreen(load) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' }));
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
        holder.replaceWith(screen({ title: 'Buy BEAM', back: () => app.back('home') }, notice('error', `This screen could not be opened: ${e.message}. Go back and try again.`)));
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

export const BUY_SCREENS = {
  buyBeam: lazyScreen(() => import('./buy_beam.js')),
  buyOrder: lazyScreen(() => import('./buy_order.js')),
  buyOrders: lazyScreen(() => import('./buy_orders.js')),
};

/** HSL (0-360, 0-1, 0-1) → "#rrggbb". */
function hslHex(hue, sat, light) {
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A coin from another chain: its letters on a colour made from its id (as the
 * desktop app's BuyCoinIcon does). No picture is downloaded, and a copy never
 * borrows a real coin's look.
 */
export function coinBadge(assetId, symbol, size = '') {
  let hue = 7;
  for (const ch of String(assetId)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const clean = String(symbol).replace(/[^A-Za-z0-9]/g, '');
  const letters = clean.slice(0, 3).toUpperCase() || '?';
  const el = h('span', { class: `asset-badge tinted coin${letters.length > 2 ? ' three' : ''} ${size}`.trim(), 'aria-hidden': 'true', text: letters });
  el.style.setProperty('--badge', hslHex(hue, 0.5, 0.42));
  el.style.setProperty('--badge-ink', '#ffffff');
  return el;
}

/** WBEAM's badge (drawn as BEAM: it is BEAM on Ethereum, 1:1) with a small Ethereum mark. */
export function wbeamBadge(size = '') {
  return h('span', { class: 'badge-pair' }, assetBadge({ id: 0 }, { size }), h('span', { class: 'badge-mark', 'aria-hidden': 'true' }, h('img', { src: 'img/eth.svg', alt: '' })));
}

function choiceCard({ testid, badge, title, tag, tagCls, text, action, onclick }) {
  return h(
    'button',
    { class: 'card choice-card', type: 'button', onclick, 'data-testid': testid },
    h('span', { class: 'choice-head' }, badge, h('span', { class: 'choice-title', text: title }), h('span', { class: `tag ${tagCls}`, text: tag })),
    h('span', { class: 'choice-text', text }),
    h('span', { class: 'choice-action' }, h('span', { text: action }), icon('chevron')),
  );
}

/** The chooser, as a sheet. Opens at once; the WBEAM card learns whether there is an Ethereum wallet a moment later. */
export function openBuyChooser(app) {
  let hasEth = null;
  const sheet = openSheet(
    (close) => [
      h('p', { class: 'overline', text: 'Buy' }),
      h('h2', { 'data-testid': 'buy-chooser-title', text: 'Both are BEAM. They live in different wallets.' }),
      choiceCard({
        testid: 'buy-choose-beam',
        badge: assetBadge({ id: 0 }),
        title: 'BEAM',
        tag: 'Private',
        tagCls: 'private',
        text: 'The private coin, in your BEAM wallet. Pay with Bitcoin, Ether, USDT or another coin.',
        action: 'Buy BEAM',
        onclick: () => {
          close(true);
          app.go('buyBeam');
        },
      }),
      choiceCard({
        testid: 'buy-choose-wbeam',
        badge: wbeamBadge(),
        title: 'WBEAM on Ethereum',
        tag: 'Public',
        tagCls: 'public',
        text: 'BEAM as a token on Ethereum, in your Ethereum wallet. Pay with ETH.',
        action: hasEth === false ? 'Create an Ethereum wallet first' : 'Buy WBEAM',
        onclick: () => {
          close(true);
          if (hasEth === false) app.go('ethStart', { from: 'buy' });
          else app.go('ethSwap');
        },
      }),
      h('button', { class: 'btn btn-text', onclick: () => close(false), 'data-testid': 'buy-chooser-close' }, 'Not now'),
    ],
    { label: 'What do you want to buy?' },
  );
  hasEthWallet()
    .then((v) => {
      hasEth = v;
      if (!sheet.closed) sheet.rerender();
    })
    .catch(() => {
      hasEth = null;
    });
  return sheet;
}
