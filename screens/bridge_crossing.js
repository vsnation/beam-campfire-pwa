/* A move (opens by itself after the review; later from Move coins or History)
 * Spec: ONE job: know where the money is now, and what happens next.
 *       Primary CTA: none while it travels ("Done" closes it; it carries on); "Collect 0.5 bETH" once
 *       it is on BEAM, then the approve sheet and Face ID or the password. Nothing is collected by itself.
 *       Taps from app open: 0 after the review; later ⇄ -> the move at the top (2), or
 *       ⇄ -> History -> the move (3).
 * Exit-intent reasons and answers:
 *   - "Is it stuck?" -> the step under way is marked, with what it waits for in words ("34 BEAM blocks
 *     to go", "Waiting for Ethereum", "Ready to collect"), and slow is said to be normal when it is.
 *   - "Did it work?" -> the end state says where the coins are now.
 *   - "Can I close this?" -> said: it carries on, and BEAM Campfire picks it up again when unlocked.
 *   - "Something went wrong" -> what happened, that nothing was lost when that is so, and never a
 *     button that sends the same thing twice.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { routeById, BEAM_DECIMALS } from '../lib/bridge/routes.js';
import { DIRECTIONS, STATES, isOpen } from '../lib/bridge/store.js';
import { txExplorerUrl } from '../lib/eth/hosts.js';
import { bridgeOf, bridgeProblem, stepList } from './bridge_ui.js';
import { headline, crossingWords, crossingSteps, arrivesCoin } from './bridge_words.js';
import { coin, ago, collectLabel, sourceDecimals, sourceSymbol } from './bridge_text.js';
import { ethMaxText } from './eth_ui.js';

const MOOD = { progress: 'info', success: 'success', warning: 'warn', error: 'error' };
const ICON = { progress: ['clock', 'wait'], success: ['check', 'ok'], warning: ['alert', 'wait'], error: ['close', 'bad'] };

export default function bridgeCrossing(app, params = {}) {
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'actions bridge-actions' });
  let s = null;
  let openError = null;
  let alive = true;
  let off = null;
  let busy = false;
  let error = null;
  const back = () => app.go(params.back === 'bridgeMove' ? 'bridgeMove' : 'bridgeList', params.back === 'bridgeMove' ? {} : { back: 'home' });

  function render() {
    if (!alive) return;
    if (openError) {
      put(body, bridgeProblem(openError, () => open()));
      put(actions, primary('Done', back, { 'data-testid': 'bridge-crossing-done' }));
      return;
    }
    if (!s) {
      put(body, h('div', { class: 'center pad' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' })));
      put(actions);
      return;
    }
    const ctl = s.ctl;
    const c = ctl.crossing(params.id);
    if (!c) {
      put(body, h('div', { 'data-testid': 'bridge-crossing-missing' }, notice('info', h('strong', { text: 'This move is not on this device. ' }), 'It may belong to another pair of wallets. Your moves are under History.')));
      put(actions, primary('See your moves', () => app.go('bridgeList', { back: 'home' }), { 'data-testid': 'bridge-crossing-done' }));
      return;
    }
    const r = routeById(c.route);
    const toEth = c.direction === DIRECTIONS.toEthereum;
    const left = ctl.blocksLeft(c);
    const w = crossingWords(c, { blocksLeft: left });
    const [ico, cls] = ICON[w.mood];
    const srcDec = sourceDecimals(r, c.direction);
    const srcSym = sourceSymbol(r, c.direction);
    const done = c.state === STATES.paid || c.state === STATES.claimed;
    const kv = (k, v, tid = null) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), typeof v === 'string' ? h('span', { class: 'v', 'data-testid': tid, text: v }) : v);
    const collect = c.state === STATES.delivered;
    put(
      body,
      h('div', { class: `status-icon ${w.needsYou ? 'ok' : cls}` }, icon(w.needsYou ? 'download' : ico)),
      h('h2', { class: 'title center', 'data-testid': 'bridge-crossing-headline', text: headline(c) }),
      h(
        'div',
        { 'data-testid': 'bridge-crossing-status', 'data-state': c.state },
        notice(MOOD[w.mood] || 'info', h('strong', { 'data-testid': 'bridge-crossing-title', text: w.title }), w.detail ? h('div', { class: 'pre', text: w.detail }) : null),
      ),
      stepList(crossingSteps(c, { blocksLeft: left })),
      error ? h('div', { 'data-testid': 'bridge-crossing-error' }, notice('warn', error)) : null,
      h(
        'div',
        { class: 'card' },
        kv('You moved', coin(c.amount, srcDec, srcSym), 'bridge-crossing-amount'),
        kv(done ? 'Arrived' : 'Arrives', arrivesCoin(c), 'bridge-crossing-receive'),
        kv('Bridge fee', coin(c.relayerFee, srcDec, srcSym)),
        kv(toEth ? 'BEAM network fee' : 'BEAM network fee, to collect it', coin(c.beamNetworkFee, BEAM_DECIMALS, 'BEAM')),
        !toEth ? kv('Ethereum network fee', `up to ${ethMaxText(c.ethNetworkFee)}`) : null,
        kv('Your Ethereum wallet', `${c.ethAddress.slice(0, 6)}…${c.ethAddress.slice(-4)}`, 'bridge-crossing-eth'),
        c.msgId !== null ? kv('Bridge transfer', `#${c.msgId}`, 'bridge-crossing-number') : null,
        kv('Started', ago(c.createdAt), 'bridge-crossing-started'),
        c.lockHash
          ? kv('Ethereum transaction', h('button', { class: 'v mono btn-text', 'data-testid': 'bridge-crossing-lock', 'data-hash': c.lockHash, onclick: () => copyText(c.lockHash, 'Transaction hash copied'), text: `${c.lockHash.slice(0, 10)}…${c.lockHash.slice(-8)}` }))
          : null,
      ),
      c.lockHash ? h('a', { class: 'btn btn-text', href: txExplorerUrl(c.lockHash), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'bridge-crossing-explorer' }, icon('external'), 'See it on Etherscan') : null,
      isOpen(c) && !ctl.active ? h('p', { class: 'small center', text: 'BEAM Campfire looks again when it is back on screen.' }) : null,
    );
    put(
      actions,
      collect
        ? h('p', { class: 'hint center', 'data-testid': 'bridge-collect-fee', text: busy ? 'Collecting…' : `Network fee ${coin(c.beamNetworkFee, BEAM_DECIMALS, 'BEAM')}, from your BEAM wallet.` })
        : isOpen(c)
          ? h('p', { class: 'hint center', text: 'It carries on if you close this.' })
          : null,
      collect
        ? primary(collectLabel(r, c.receives), () => doCollect(c.id), { disabled: busy, 'data-testid': 'bridge-collect', class: 'btn btn-primary wrap' })
        : primary('Done', back, { 'data-testid': 'bridge-crossing-done' }),
    );
  }

  async function doCollect(id) {
    if (busy || !s) return;
    busy = true;
    error = null;
    render();
    try {
      // The claim is built, checked, and shown on the approve sheet; Face ID or the password follows there.
      await s.ctl.collect(id);
    } catch (e) {
      if (alive) error = e && e.code === 'rejected' ? 'You did not approve it, so nothing was collected. It is still waiting for you.' : `${e.message}${/\.$/.test(e.message || '') ? '' : '.'}`;
    }
    busy = false;
    render();
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
    // Where it is right now, not at the next tick.
    if (s.ctl.active) s.ctl.poll(params.id).catch(() => {});
  }

  render();
  open();
  const el = screen({ title: 'Your move', back, cls: 'bridge' }, body);
  el.appendChild(actions);
  return {
    el,
    destroy() {
      alive = false;
      if (off) off();
    },
  };
}
