/* Receive a name (this wallet's name key)
 * Spec: ONE job: show this wallet's name key so another wallet can transfer a name to it.
 *       Primary CTA: "Copy my name key".
 *       Taps from app open: Names (1) -> Receive a name from another wallet (2) -> Copy (3).
 * Exit-intent reasons and answers:
 *   - "Is it safe to share?" -> yes: it cannot move money; the one thing it tells (which names this
 *     wallet holds) is said plainly.
 *   - "How do I know the name comes to me?" -> the sender reads out 16 characters and this screen shows
 *     the same ones, large.
 *   - "It takes long" -> a spinner with what is happening; an error says what to tap.
 */
import { h, put, svg } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, copyText } from '../lib/ui.js';
import { encodeQr, qrSvgPath } from '../lib/qr.js';
import { checkCode } from '../lib/bans.js';
import { bans } from './names.js';

function qrOf(text) {
  const qr = encodeQr(text, { ecl: 'M' });
  const n = qr.size + 8;
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code of the name key' }, svg('rect', { width: n, height: n, fill: '#ffffff' }), svg('path', { d: qrSvgPath(qr, 4), fill: '#000000' }));
}

export default function nameKey(app) {
  let key = null;
  let alive = true;
  const box = h('div', { class: 'name-stack' });
  const cta = h('button', { class: 'btn btn-primary', 'data-testid': 'name-key-copy', disabled: true, onclick: () => key && copyText(key, 'Name key copied') }, icon('copy'), h('span', { text: 'Copy my name key' }));

  async function load() {
    put(box, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Reading your name key…' })));
    try {
      key = await bans().myKey();
    } catch (e) {
      if (!alive) return;
      put(box, notice('error', `Your name key could not be read: ${e.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, 'Try again')));
      return;
    }
    if (!alive) return;
    cta.disabled = false;
    put(
      box,
      h(
        'div',
        { class: 'card key-card' },
        h('div', { class: 'qr' }, qrOf(key)),
        h('p', { class: 'check-code mono center', 'data-testid': 'name-key-check', text: checkCode(key) }),
        h('p', { class: 'small center', 'data-testid': 'name-key-hint', text: 'Whoever gives you a name reads out 16 characters. They must match these, every one.' }),
        h('p', { class: 'mono small center', 'data-testid': 'name-key', text: key }),
      ),
    );
  }

  load();
  const el = screen(
    { title: 'Receive a name', back: () => app.back('names'), cls: 'names feature sticky-actions', actions: [cta] },
    h('p', { class: 'lead', text: "To move a name into this wallet, give its current owner this key. They paste it under the name's Transfer." }),
    box,
    h('p', { class: 'small', 'data-testid': 'name-key-safe', text: 'Sharing it is safe: it cannot move money. Anyone who has it can see which names belong to this wallet.' }),
  );
  return {
    el,
    destroy() {
      alive = false;
    },
  };
}
