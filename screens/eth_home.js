/* Ethereum Home (Home's switcher -> Ethereum)
 * Spec: ONE job: see what the Ethereum wallet holds, and buy WBEAM with its ETH.
 *       Primary CTA: "Buy WBEAM" when there is ETH, otherwise "Receive ETH"; Send and Receive beside it.
 *       Taps from app open: 1 (Home -> Ethereum); Buy WBEAM, Send or Receive is 2.
 * Exit-intent reasons and answers:
 *   - "Is this balance real / current?" -> the server's name and the block it answered at, or, when
 *     it didn't answer, who failed and two ways out (try again, or pick another server yourself).
 *   - "Where did my payment go?" -> what this device sent shows at once, with its status in words,
 *     before any history index knows of it.
 *   - "Empty, now what?" -> the primary button becomes Receive ETH; the empty list says so.
 *   - "How do I get WBEAM?" -> Buy WBEAM is the primary as soon as there is ETH to pay with.
 *   - "Where's my BEAM?" -> the switcher at the top is one tap back.
 *   - "Why no history?" -> when History from Stack Wallet is off, a line says so and where to turn it on.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast, copyText } from '../lib/ui.js';
import { ethWallet, ethPrefs } from '../lib/eth/wallet.js';
import { TOKENS } from '../lib/eth/tokens.js';
import { formatUnits } from '../lib/eth/units.js';
import { chainSwitch, bridgeEntry } from './eth_screens.js';
import { ethBadge, compactAmountText, exactText, serverProblem, activityRow } from './eth_ui.js';

const REFRESH_MS = 30000;
const FOLLOW_MS = 4000;

export default function ethHome(app, params = {}) {
  const balanceBox = h('div');
  const problemBox = h('div');
  const actionsBox = h('div', { class: 'actions eth-actions' });
  const tokensBox = h('div');
  const activityBox = h('div');
  let w = null;
  let off = null;
  let dead = false;

  function render(s) {
    if (dead) return;
    const pref = ethPrefs(app);
    const known = s.eth !== null;
    const status = s.loading && !known ? { cls: 'wait', text: `Asking ${pref.host.name}…` } : s.error ? { cls: 'bad', text: `${pref.host.name} didn't answer` } : known ? { cls: 'ok', text: `${pref.host.name} · block ${s.block.toLocaleString('en-US')}` } : { cls: 'wait', text: 'Not checked yet' };
    put(
      balanceBox,
      h(
        'div',
        { class: 'card balance' },
        h('div', { class: 'label', text: 'Ethereum · available' }),
        h('div', { class: 'amount', 'data-testid': 'eth-balance', 'data-wei': known ? String(s.eth) : '' }, known ? formatUnits(s.eth, 18) : '—', h('span', { class: 'unit', text: 'ETH' })),
        h(
          'button',
          { class: 'addr-chip', onclick: () => copyText(s.address, 'Address copied'), 'data-testid': 'eth-address', 'data-address': s.address, 'aria-label': 'Copy address' },
          h('span', { class: 'mono', text: shorten(s.address, 6, 4) }),
          icon('copy'),
        ),
        h('div', { class: 'syncline', 'data-testid': 'eth-status', 'data-state': status.cls }, h('span', { class: `dot ${status.cls}` }), h('span', { text: status.text })),
      ),
    );
    put(problemBox, s.error ? serverProblem(app, s.error, { retry: refresh, switched: (alt) => { toast(`Using ${alt.name}`); refresh(); } }) : null);

    const tokens = TOKENS.map((t) => [t, s.tokens.get(t.symbol)]).filter(([, v]) => v != null && v > 0n);
    const hasFunds = (known && s.eth > 0n) || tokens.length > 0;
    const hasEth = known && s.eth > 0n;
    const buyBtn = (hasEth ? primary : secondary)(h('span', {}, 'Buy WBEAM'), () => app.go('ethSwap'), { 'data-testid': 'eth-buy-wbeam' });
    buyBtn.prepend(icon('buy'));
    const sendBtn = secondary(h('span', {}, 'Send'), () => app.go('ethSend'), { disabled: !hasFunds, 'data-testid': 'eth-send' });
    sendBtn.prepend(icon('send'));
    const recvBtn = (hasEth ? secondary : primary)(h('span', {}, hasEth ? 'Receive' : 'Receive ETH'), () => app.go('ethReceive'), { 'data-testid': 'eth-receive' });
    recvBtn.prepend(icon('receive'));
    put(actionsBox, h('div', { class: 'btn-row three' }, ...(hasEth ? [buyBtn, sendBtn, recvBtn] : [recvBtn, sendBtn, buyBtn])));

    put(
      tokensBox,
      ...(tokens.length
        ? [
            h('p', { class: 'section-title', text: 'Tokens' }),
            h(
              'div',
              { class: 'card list', 'data-testid': 'eth-tokens' },
              ...tokens.map(([t, v]) =>
                h(
                  'div',
                  { class: 'row asset-row', 'data-testid': 'eth-token-row', 'data-symbol': t.symbol },
                  ethBadge(t),
                  h('span', { class: 'main' }, h('div', { class: 't', text: t.name }), h('div', { class: 's', text: t.symbol === 'WBEAM' ? 'BEAM on Ethereum' : t.symbol })),
                  h('span', { class: 'end', 'data-testid': 'eth-token-balance', 'data-units': String(v), title: exactText(v, t), text: compactAmountText(v, t) }),
                ),
              ),
            ),
          ]
        : []),
    );

    const items = w ? w.activity().slice(0, 10) : [];
    const hist = s.history;
    put(
      activityBox,
      h('p', { class: 'section-title', text: 'Recent activity' }),
      items.length
        ? h('div', { class: 'card list', 'data-testid': 'eth-activity' }, ...items.map((i) => activityRow(i, () => app.go(i.kind ? 'ethSwapTx' : 'ethTx', { hash: i.hash, item: i }))))
        : h('div', { class: 'card empty', 'data-testid': 'eth-activity-empty' }, icon('activity'), h('p', { text: known ? 'Nothing yet. Payments to and from this address show up here.' : 'Payments show up here once the server has answered.' })),
      !pref.history
        ? h('p', { class: 'small', 'data-testid': 'eth-history-off' }, 'Only what this device sent is shown: History from Stack Wallet is off. ', h('button', { class: 'btn-link', onclick: () => app.go('ethSettings') }, 'Settings'))
        : hist.error
          ? h('p', { class: 'small', 'data-testid': 'eth-history-error', text: `Older payments could not be loaded: ${hist.error} What this device sent is shown.` })
          : null,
    );
  }

  let busy = false;
  async function refresh() {
    if (!w || busy || dead || !app.dbPass) return;
    busy = true;
    try {
      await w.refresh();
      if (!dead && app.dbPass) await w.followOpen().catch(() => {});
    } finally {
      busy = false;
    }
  }

  // Only while this screen is visible and the wallet unlocked.
  const visible = () => document.visibilityState === 'visible' && app.dbPass && !dead;
  const timer = setInterval(() => visible() && refresh(), REFRESH_MS);
  const follower = setInterval(() => {
    if (visible() && w && w.state.outbox.some((e) => e.state === 'signed' || e.state === 'pending')) w.followOpen().catch(() => {});
  }, FOLLOW_MS);
  const onVis = () => visible() && refresh();
  document.addEventListener('visibilitychange', onVis);

  (async () => {
    try {
      w = await ethWallet(app);
    } catch (e) {
      put(problemBox, notice('error', `The Ethereum wallet could not be opened: ${e.message}`));
      return;
    }
    if (dead) return;
    if (!w) return app.go('ethStart');
    off = w.onChange(render);
    render(w.state);
    if (params.created) toast(params.created === 'import' ? 'Ethereum wallet imported' : 'Ethereum wallet ready');
    refresh();
  })();

  const el = screen(
    { brand: true, tabs: 'home', app, cls: 'eth-home', right: h('button', { class: 'icon-btn', 'aria-label': 'Lock', onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')) },
    chainSwitch(app, 'eth'),
    balanceBox,
    problemBox,
    actionsBox,
    bridgeEntry(app),
    tokensBox,
    activityBox,
  );
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      clearInterval(follower);
      document.removeEventListener('visibilitychange', onVis);
      if (off) off();
    },
  };
}

