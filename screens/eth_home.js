/* Ethereum Home (Home's switcher -> Ethereum)
 * Spec: ONE job: see what the Ethereum wallet holds, and buy WBEAM with its ETH.
 *       Primary CTA: "Buy WBEAM" when there is ETH, otherwise "Receive ETH"; Send and Receive beside it.
 *       Taps from app open: 1 (Home -> Ethereum); Buy WBEAM, Send or Receive is 2.
 * Exit-intent reasons and answers:
 *   - "Is this balance real / current?" -> the server's name and the block it answered at, or, when
 *     it didn't answer, who failed and two ways out (try again, or pick another server yourself).
 *   - "Where did my payment go?" -> what this device sent shows at once, with its status in words,
 *     before any history index knows of it. One marked "Not sent" is looked for again on every opening.
 *   - "Empty, now what?" -> the primary button becomes Receive ETH; the empty list says so.
 *   - "How do I get WBEAM?" -> Buy WBEAM is the primary as soon as there is ETH to pay with.
 *   - "I have BTC, not ETH" -> "Pay with BTC, ZEC or LTC" under the buttons (NEAR Intents), which also
 *     shows a swap still on its way.
 *   - "Where's my BEAM?" -> the switcher at the top is one tap back.
 *   - "Why no history?" -> when History from Stack Wallet is off, a line says so and where to turn it on.
 *   - "Why won't it let me send?" -> while a payment, swap or permission is "Not sure yet" or "Not sent
 *     yet", one line above Send says sending is paused, and opens that transaction (lib/eth/doubt.js).
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast, copyText } from '../lib/ui.js';
import { ethWallet, ethPrefs } from '../lib/eth/wallet.js';
import { TOKENS } from '../lib/eth/tokens.js';
import { formatUnits } from '../lib/eth/units.js';
import { chainSwitch, bridgeEntry } from './eth_screens.js';
import { payWithCoinEntry } from './near_intents_entry.js';
import { intentsFor, openSwaps } from '../lib/intents/wiring.js';
import { ethBadge, compactAmountText, exactText, serverProblem, activityRow, doubtLine } from './eth_ui.js';
import { rememberNearSwaps } from '../lib/notify.js';
import { t, tNodes } from '../lib/i18n.js';

const REFRESH_MS = 30000;
const FOLLOW_MS = 4000;

export default function ethHome(app, params = {}) {
  const balanceBox = h('div');
  const problemBox = h('div');
  const actionsBox = h('div', { class: 'actions eth-actions' });
  const tokensBox = h('div');
  const activityBox = h('div');
  // NEAR Intents: nothing is asked of it here; the row reads this device's swaps under way.
  const intentsBox = h('div', {}, payWithCoinEntry(app, { testid: 'eth-pay-other-coin', swaps: intentsFor(app).then((c) => (c ? openSwaps(c.store) : [])).then((l) => (rememberNearSwaps(l), l)) }));
  let w = null;
  let off = null;
  let dead = false;

  function render(s) {
    if (dead) return;
    const pref = ethPrefs(app);
    const known = s.eth !== null;
    const server = pref.host.name;
    const status = s.loading && !known ? { cls: 'wait', text: t('Asking {server}…', { server }) } : s.error ? { cls: 'bad', text: t("{server} didn't answer", { server }) } : known ? { cls: 'ok', text: t('{server} · block {block}', { server, block: s.block.toLocaleString('en-US') }) } : { cls: 'wait', text: t('Not checked yet') };
    put(
      balanceBox,
      h(
        'div',
        { class: 'card balance' },
        h('div', { class: 'label', text: t('Ethereum · available') }),
        h('div', { class: 'amount', 'data-testid': 'eth-balance', 'data-wei': known ? String(s.eth) : '' }, known ? formatUnits(s.eth, 18) : '—', h('span', { class: 'unit', text: 'ETH' })), // i18n-ignore: a ticker
        h(
          'button',
          { class: 'addr-chip', onclick: () => copyText(s.address, t('Address copied')), 'data-testid': 'eth-address', 'data-address': s.address, 'aria-label': t('Copy address') },
          h('span', { class: 'mono', text: shorten(s.address, 6, 4) }),
          icon('copy'),
        ),
        h('div', { class: 'syncline', 'data-testid': 'eth-status', 'data-state': status.cls }, h('span', { class: `dot ${status.cls}` }), h('span', { text: status.text })),
      ),
    );
    put(problemBox, s.error ? serverProblem(app, s.error, { retry: refresh, switched: (alt) => { toast(t('Using {server}', { server: alt.name })); refresh(); } }) : null);

    const tokens = TOKENS.map((tok) => [tok, s.tokens.get(tok.symbol)]).filter(([, v]) => v != null && v > 0n);
    const hasFunds = (known && s.eth > 0n) || tokens.length > 0;
    const hasEth = known && s.eth > 0n;
    const buyBtn = (hasEth ? primary : secondary)(h('span', {}, t('Buy WBEAM')), () => app.go('ethSwap'), { 'data-testid': 'eth-buy-wbeam' });
    buyBtn.prepend(icon('buy'));
    const sendBtn = secondary(h('span', {}, t('Send')), () => app.go('ethSend'), { disabled: !hasFunds, 'data-testid': 'eth-send' });
    sendBtn.prepend(icon('send'));
    const recvBtn = (hasEth ? secondary : primary)(h('span', {}, hasEth ? t('Receive') : t('Receive ETH')), () => app.go('ethReceive'), { 'data-testid': 'eth-receive' });
    recvBtn.prepend(icon('receive'));
    // A transaction in doubt holds back the next one (lib/eth/doubt.js): said above Send, not after a tap.
    const doubt = w ? w.doubt() : null;
    put(actionsBox, doubt ? doubtLine(app, doubt) : null, h('div', { class: 'btn-row three' }, ...(hasEth ? [buyBtn, sendBtn, recvBtn] : [recvBtn, sendBtn, buyBtn])));

    put(
      tokensBox,
      ...(tokens.length
        ? [
            h('p', { class: 'section-title', text: t('Tokens') }),
            h(
              'div',
              { class: 'card list', 'data-testid': 'eth-tokens' },
              ...tokens.map(([tok, v]) =>
                h(
                  'div',
                  { class: 'row asset-row', 'data-testid': 'eth-token-row', 'data-symbol': tok.symbol },
                  ethBadge(tok),
                  h('span', { class: 'main' }, h('div', { class: 't', text: tok.name }), h('div', { class: 's', text: tok.symbol === 'WBEAM' ? t('BEAM on Ethereum') : tok.symbol })),
                  h('span', { class: 'end', 'data-testid': 'eth-token-balance', 'data-units': String(v), title: exactText(v, tok), text: compactAmountText(v, tok) }),
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
      h('p', { class: 'section-title', text: t('Recent activity') }),
      items.length
        ? h('div', { class: 'card list', 'data-testid': 'eth-activity' }, ...items.map((i) => activityRow(i, () => app.go(i.kind ? 'ethSwapTx' : 'ethTx', { hash: i.hash, item: i }))))
        : h('div', { class: 'card empty', 'data-testid': 'eth-activity-empty' }, icon('activity'), h('p', { text: known ? t('Nothing yet. Payments to and from this address show up here.') : t('Payments show up here once the server has answered.') })),
      !pref.history
        ? h('p', { class: 'small', 'data-testid': 'eth-history-off' }, ...tNodes('Only what this device sent is shown: History from Stack Wallet is off. {settings}', { settings: h('button', { class: 'btn-link', onclick: () => app.go('ethSettings') }, t('Settings')) }))
        : hist.error
          ? h('p', { class: 'small', 'data-testid': 'eth-history-error', text: t('Older payments could not be loaded: {reason} What this device sent is shown.', { reason: hist.error }) })
          : null,
    );
  }

  let busy = false;
  let rechecked = false;
  async function refresh() {
    if (!w || busy || dead || !app.dbPass) return;
    busy = true;
    try {
      await w.refresh();
      if (!dead && app.dbPass) await w.followOpen().catch(() => {});
      // "Not sent" is one server's word: once per opening, its receipt is asked again (release audit BM-2).
      if (!rechecked && !dead && app.dbPass) {
        rechecked = true;
        await w.recheckRejected().catch(() => {});
      }
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
      put(problemBox, notice('error', t('The Ethereum wallet could not be opened: {reason}', { reason: e.message })));
      return;
    }
    if (dead) return;
    if (!w) return app.go('ethStart');
    off = w.onChange(render);
    render(w.state);
    if (params.created) toast(params.created === 'import' ? t('Ethereum wallet imported') : t('Ethereum wallet ready'));
    refresh();
  })();

  const el = screen(
    { brand: true, tabs: 'home', app, cls: 'eth-home', right: h('button', { class: 'icon-btn', 'aria-label': t('Lock'), onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')) },
    chainSwitch(app, 'eth'),
    balanceBox,
    problemBox,
    actionsBox,
    bridgeEntry(app),
    intentsBox,
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

