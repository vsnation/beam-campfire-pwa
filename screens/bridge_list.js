/* Your moves (Move coins -> History)
 * Spec: ONE job: find any move between BEAM and Ethereum and see where it is; the ones on their
 *       way first.
 *       Primary CTA: none (a row opens its move); with none yet, "Move coins".
 *       Taps from app open: ⇄ -> History (2); a row is 3.
 * Exit-intent reasons and answers:
 *   - "Empty, now what?" -> it says what the bridge does, and "Move coins" is the button.
 *   - "A row that only says pending" -> each says what it waits for: "34 blocks to go", "Collect".
 *   - "Where did an old one go?" -> every move this device started stays here, finished ones below.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary } from '../lib/ui.js';
import { isOpen } from '../lib/bridge/store.js';
import { bridgeOf, bridgeProblem, crossingRow } from './bridge_ui.js';

export default function bridgeList(app, params = {}) {
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'actions bridge-actions' });
  let s = null;
  let openError = null;
  let alive = true;
  let off = null;
  const back = () => app.go(params.back === 'bridgeMove' ? 'bridgeMove' : 'home');

  function render() {
    if (!alive) return;
    if (openError) {
      put(body, bridgeProblem(openError, () => open()));
      put(actions);
      return;
    }
    if (!s) {
      put(body, h('div', { class: 'center pad' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' })));
      put(actions);
      return;
    }
    const all = s.ctl.crossings;
    const going = all.filter(isOpen);
    const finished = all.filter((c) => !isOpen(c));
    const go = (c) => () => app.go('bridgeCrossing', { id: c.id, back: 'bridgeList' });
    if (!all.length) {
      put(
        body,
        h(
          'div',
          { class: 'card empty', 'data-testid': 'bridge-list-empty' },
          icon('bridge'),
          h('h3', { text: 'No moves yet' }),
          h('p', { class: 'small', text: 'Coins you move between your BEAM and Ethereum wallets show up here, with where each one is.' }),
        ),
      );
      put(actions, primary('Move coins', () => app.go('bridgeMove'), { 'data-testid': 'bridge-list-move' }));
      return;
    }
    put(
      body,
      going.length ? h('p', { class: 'section-title', text: 'On their way' }) : null,
      going.length ? h('div', { class: 'card list', 'data-testid': 'bridge-list-open' }, ...going.map((c) => crossingRow(s.ctl, c, go(c)))) : null,
      finished.length ? h('p', { class: 'section-title', text: 'Finished' }) : null,
      finished.length ? h('div', { class: 'card list', 'data-testid': 'bridge-list-done' }, ...finished.map((c) => crossingRow(s.ctl, c, go(c)))) : null,
    );
    put(actions);
  }

  async function open() {
    openError = null;
    render();
    try {
      s = await bridgeOf(app);
    } catch (e) {
      if (!alive || (e && e.code === 'locked')) return;
      openError = e;
      return render();
    }
    if (!alive) return;
    if (!s) return app.go('bridgeMove');
    off = s.ctl.onChange(render);
    render();
  }

  render();
  open();
  const el = screen({ title: 'Your moves', back, cls: 'bridge' }, body);
  el.appendChild(actions);
  return {
    el,
    destroy() {
      alive = false;
      if (off) off();
    },
  };
}
