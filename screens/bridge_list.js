/* Your moves (Move coins -> History)
 * Spec: ONE job: find any move between BEAM and Ethereum and see where it is; the ones on their
 *       way first.
 *       Primary CTA: none (a row opens its move); with none yet, "Move coins".
 *       Taps from app open: ⇄ -> History (2); a row is 3.
 * Exit-intent reasons and answers:
 *   - "Empty, now what?" -> it says what the bridge does, and "Move coins" is the button.
 *   - "A row that only says pending" -> each says what it waits for: "34 blocks to go", "Collect".
 *   - "Where did an old one go?" -> every move this device started stays here, finished ones below.
 *   - "My coins never showed up" -> the bridge itself is asked, on every coin, for what it holds on
 *     BEAM for this wallet, whatever this device remembers: "Waiting for you on BEAM" with a Collect
 *     button each, or "Nothing (else) is waiting for this wallet on the bridge", and "Check again".
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { isOpen } from '../lib/bridge/store.js';
import { CLAIM_FEE, BEAM_DECIMALS } from '../lib/bridge/routes.js';
import { bridgeOf, bridgeProblem, crossingRow } from './bridge_ui.js';
import { coin, collectLabel } from './bridge_text.js';

export default function bridgeList(app, params = {}) {
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'actions bridge-actions' });
  let s = null;
  let openError = null;
  let alive = true;
  let off = null;
  // What the bridge holds on BEAM for this wallet (controller.js waiting()), asked on opening.
  let waiting = null; // {items, failed} once asked
  let checking = false;
  let collecting = null; // the msgId being collected
  let waitError = null;
  const back = () => app.back(params.back === 'bridgeMove' ? 'bridgeMove' : 'home');

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
    const found = waitingView();
    if (!all.length) {
      put(
        body,
        found,
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
      waitingItems().length ? found : null,
      going.length ? h('p', { class: 'section-title', text: 'On their way' }) : null,
      going.length ? h('div', { class: 'card list', 'data-testid': 'bridge-list-open' }, ...going.map((c) => crossingRow(s.ctl, c, go(c)))) : null,
      finished.length ? h('p', { class: 'section-title', text: 'Finished' }) : null,
      finished.length ? h('div', { class: 'card list', 'data-testid': 'bridge-list-done' }, ...finished.map((c) => crossingRow(s.ctl, c, go(c)))) : null,
      waitingItems().length ? null : found,
    );
    put(actions);
  }

  /** Messages for this wallet on BEAM that no move of this device follows. */
  function waitingItems() {
    return waiting ? waiting.items.filter((i) => i.crossingId === null) : [];
  }

  /** "Waiting for you on BEAM" with a Collect button each; or, when nothing is, one quiet line. */
  function waitingView() {
    const items = waitingItems();
    const again = h('button', { class: 'btn btn-text btn-small', disabled: checking || collecting !== null, onclick: checkWaiting, 'data-testid': 'bridge-waiting-check' }, 'Check again');
    const problem = waitError ? h('div', { 'data-testid': 'bridge-waiting-error' }, notice('warn', waitError)) : null;
    if (!items.length) {
      const failed = waiting && waiting.failed.length ? ` BEAM did not answer for ${waiting.failed.length === 1 ? 'one coin' : `${waiting.failed.length} coins`}.` : '';
      const line = checking ? 'Checking the bridge for coins waiting for this wallet…' : waiting ? `Nothing ${s && s.ctl.crossings.length ? 'else ' : ''}is waiting for this wallet on the bridge.${failed}` : null;
      if (!line && !problem) return null;
      return h('div', { class: 'stack', 'data-testid': 'bridge-waiting', 'data-count': '0' }, problem, line ? h('p', { class: 'small center', 'data-testid': 'bridge-waiting-none' }, h('span', { text: `${line} ` }), checking ? null : again) : null);
    }
    return h(
      'div',
      { class: 'stack', 'data-testid': 'bridge-waiting', 'data-count': String(items.length) },
      h('p', { class: 'section-title', text: 'Waiting for you on BEAM' }),
      h('p', { class: 'small', text: `The bridge holds these for this wallet. Collecting one is a BEAM transaction with a ${coin(CLAIM_FEE, BEAM_DECIMALS, 'BEAM')} network fee.` }),
      problem,
      h(
        'div',
        { class: 'card list' },
        ...items.map((i) =>
          h(
            'div',
            { class: 'row', 'data-testid': 'bridge-waiting-row', 'data-route': i.route.id, 'data-msg': String(i.msgId) },
            h('span', { class: 'ico in' }, icon('download')),
            h('span', { class: 'main' }, h('div', { class: 't', text: coin(i.amount, BEAM_DECIMALS, i.route.beamSymbol) }), h('div', { class: 's', text: `Bridge transfer #${i.msgId}` })),
            h('button', { class: 'btn btn-secondary btn-small', disabled: collecting !== null, onclick: () => collectOne(i), 'aria-label': collectLabel(i.route, i.amount), 'data-testid': 'bridge-waiting-collect' }, collecting === i.msgId ? 'Collecting…' : 'Collect'),
          ),
        ),
      ),
      h('p', { class: 'small center' }, again),
    );
  }

  async function checkWaiting() {
    if (!s || checking) return;
    checking = true;
    waitError = null;
    render();
    try {
      waiting = await s.ctl.waiting();
    } catch {
      waitError = "Couldn't ask the bridge on BEAM right now. Nothing is lost: try again in a minute.";
    }
    checking = false;
    render();
  }

  async function collectOne(i) {
    if (!s || collecting !== null) return;
    collecting = i.msgId;
    waitError = null;
    render();
    try {
      // Built, checked and shown on the approve sheet, as any Collect; then followed as a move.
      const c = await s.ctl.collectWaiting(i.route.id, i.msgId);
      collecting = null;
      if (alive) return app.go('bridgeCrossing', { id: c.id, back: 'bridgeList' });
    } catch (e) {
      collecting = null;
      waitError = e && e.code === 'rejected' ? 'You did not approve it, so nothing was collected. It is still waiting for you.' : `${e.message}${/\.$/.test(e.message || '') ? '' : '.'}`;
    }
    if (alive) await checkWaiting();
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
    if (!s) return app.go('bridgeMove', {}, { replace: true });
    off = s.ctl.onChange(render);
    render();
    checkWaiting();
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
