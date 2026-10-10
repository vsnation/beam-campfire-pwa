/* Home
 * Spec: ONE job: see what I have and start a payment.
 *       Primary CTA: "Send" (when there is nothing to send yet: "Receive"); "Swap" and "Buy" sit beside them.
 *       Taps from app open: 0 after unlock.
 * Exit-intent reasons and answers:
 *   - "Is this number real / up to date?" -> sync line says Synced (and whether a second source
 *     confirmed the height), or exactly how far behind it is.
 *   - "Why can't I send?" -> the reason is written under the button, never a silent grey button.
 *   - "Where did my payment go?" -> recent payments with plain status right below.
 *   - "Empty wallet, now what?" -> the primary button becomes Receive; Buy is beside it.
 *   - "How do I get BEAM?" -> Buy opens a choice: BEAM in this wallet (buybeam.my) or WBEAM on Ethereum.
 *   - "Can I get a short name, or claim a code I was given?" -> BEAM names and Airdrop codes, on one line with
 *     dApps under the buttons, one tap each.
 *   - "What if this phone or this app's web address is gone?" -> a wallet imported from wallet.db has
 *     no 12 words: until it is exported once, a banner asks for a copy outside this device (one tap
 *     to Backup; "Later" for a week).
 */
import { h, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, primary, secondary, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, txStatusText, isPendingTx, isContractTx, contractMoves } from '../lib/wallet.js';
import { needsBackupPrompt } from '../lib/session.js';
import { chainSwitch } from './eth_screens.js';
import { openBuyChooser } from './buy_screens.js';
import { loaderBehind } from '../lib/loader.js';

export function syncLine(sync) {
  const cls = sync.state === 'synced' ? 'ok' : sync.state === 'offline' || sync.state === 'stalled' || sync.state === 'behind' ? 'bad' : 'wait';
  const pct = sync.state === 'syncing' && sync.percent != null ? ` (${sync.percent}%)` : '';
  return h('div', { class: 'syncline', 'data-testid': 'sync', 'data-state': sync.state, 'data-verified': String(Boolean(sync.verified)) }, h('span', { class: `dot ${cls}` }), h('span', { text: `${sync.title}${pct}` }));
}

function contractRow(app, tx, onclick) {
  const m = contractMoves(tx);
  const failed = Number(tx.status) === 4 || Number(tx.status) === 2;
  const get = m.receives[0];
  const pay = m.spends[0];
  const amt = (a, sign) => `${sign}${formatAmount(a.amount)} ${app.wallet.label(a.assetId).unit}`;
  const app2 = tx.appname && tx.appname !== 'BEAM Campfire' ? ` · ${tx.appname}` : '';
  return h(
    'button',
    { class: 'row', onclick, 'data-txid': tx.txId },
    h('span', { class: `ico ${failed ? 'fail' : 'swap'}` }, icon(isPendingTx(tx) ? 'clock' : 'swap')),
    h('span', { class: 'main' }, h('div', { class: 't', text: txStatusText(tx) }), h('div', { class: 's', text: `${fmtDate(tx.create_time)}${app2}` })),
    h(
      'span',
      { class: 'end' },
      get ? h('div', { class: failed ? '' : 'in', text: amt(get, '+') }) : pay ? h('div', { text: amt(pay, '−') }) : h('div', { text: `−${formatAmount(BigInt(tx.fee || 0))} BEAM` }),
      get && pay ? h('div', { class: 'small', text: amt(pay, '−') }) : null,
    ),
  );
}

export function txRow(app, tx, onclick) {
  if (isContractTx(tx)) return contractRow(app, tx, onclick);
  const label = app.wallet.label(tx.asset_id || 0);
  const income = Boolean(tx.income);
  const failed = Number(tx.status) === 4 || Number(tx.status) === 2;
  const value = BigInt(tx.value || 0);
  return h(
    'button',
    { class: 'row', onclick, 'data-txid': tx.txId },
    h('span', { class: `ico ${failed ? 'fail' : income ? 'in' : 'out'}` }, icon(isPendingTx(tx) ? 'clock' : income ? 'receive' : 'send')),
    h('span', { class: 'main' }, h('div', { class: 't', text: txStatusText(tx) }), h('div', { class: 's', text: fmtDate(tx.create_time) })),
    h('span', { class: `end${income && !failed ? ' in' : ''}`, text: `${income ? '+' : '−'}${formatAmount(value)} ${label.unit}` }),
  );
}

export default function home(app) {
  const balanceBox = h('div');
  const assetsBox = h('div');
  const txBox = h('div');
  const bannerBox = h('div');
  const actionsBox = h('div', { class: 'actions' });

  function render(s) {
    const beam = s.totals.get(0) || { available: 0n, receiving: 0n, sending: 0n, maturing: 0n };
    const pend = [];
    if (beam.receiving > 0n) pend.push(`+${formatAmount(beam.receiving)} incoming`);
    if (beam.sending > 0n) pend.push(`−${formatAmount(beam.sending)} outgoing`);
    if (beam.maturing > 0n) pend.push(`${formatAmount(beam.maturing)} maturing`);
    const known = Boolean(s.status) && !s.importing;
    put(balanceBox, 
      h(
        'div',
        { class: 'card balance' },
        h('div', { class: 'label', text: 'Available' }),
        h('div', { class: 'amount', 'data-testid': 'balance' }, known ? formatAmount(beam.available) : '—', h('span', { class: 'unit', text: 'BEAM' })),
        pend.length ? h('div', { class: 'pending', text: pend.join(' · ') }) : null,
        syncLine(s.sync),
        h('p', { class: 'small', 'data-testid': 'sync-detail', text: s.sync.detail }),
      ),
    );

    // Every other asset this wallet has anything of: available, on its way, or maturing.
    const others = [...s.totals.entries()]
      .filter(([id, t]) => id !== 0 && (t.available > 0n || t.receiving > 0n || t.sending > 0n || t.maturing > 0n))
      .map(([id, t]) => [id, t, app.wallet.label(id)])
      .sort(([a, , la], [b, , lb]) => (la.verified === lb.verified ? a - b : la.verified ? -1 : 1));
    put(assetsBox,
      ...(others.length
        ? [
            h('p', { class: 'section-title', text: 'Tokens' }),
            h(
              'div',
              { class: 'card list', 'data-testid': 'tokens' },
              ...others.map(([id, t, l]) => {
                const named = !l.unit.startsWith('Asset #');
                const sub = !named ? `Asset #${id}` : l.verified ? l.unit : `${l.unit} · asset #${id}`;
                const pending = [];
                if (t.receiving > 0n) pending.push(`+${formatAmount(t.receiving)} incoming`);
                if (t.sending > 0n) pending.push(`−${formatAmount(t.sending)} outgoing`);
                if (t.maturing > 0n) pending.push(`${formatAmount(t.maturing)} maturing`);
                return h(
                  'div',
                  { class: 'row asset-row', 'data-testid': 'token-row', 'data-asset-id': String(id) },
                  assetBadge(l),
                  h('span', { class: 'main' }, h('div', { class: 't', text: named ? l.name : 'Unnamed asset' }), h('div', { class: 's', text: sub })),
                  h('span', { class: 'end' }, h('div', { 'data-testid': 'token-balance', text: `${formatAmount(t.available)}${named ? ` ${l.unit}` : ''}` }), pending.length ? h('div', { class: 'small', text: pending.join(' · ') }) : null),
                );
              }),
            ),
          ]
        : []),
    );

    const recent = s.txs.slice(0, 5);
    put(txBox, 
      h('p', { class: 'section-title', text: 'Recent payments' }),
      recent.length
        ? h('div', { class: 'card list', 'data-testid': 'recent' }, ...recent.map((t) => txRow(app, t, () => app.go('activity', { txId: t.txId }))), s.txs.length > 5 ? h('button', { class: 'btn btn-text', onclick: () => app.go('activity') }, 'See all') : null)
        : h('div', { class: 'card empty' }, icon('activity'), h('p', { text: known ? 'No payments yet.' : 'Payments show up here once the wallet is up to date.' })),
    );

    const hasFunds = [...s.totals.values()].some((t) => t.available > 0n);
    const canSend = s.sync.canSend;
    const sendBtn = (hasFunds ? primary : secondary)(h('span', {}, 'Send'), () => app.go('send'), { disabled: !canSend || !hasFunds, 'data-testid': 'send' });
    sendBtn.prepend(icon('send'));
    const recvBtn = (hasFunds ? secondary : primary)(h('span', {}, 'Receive'), () => app.go('receive'), { 'data-testid': 'receive' });
    recvBtn.prepend(icon('receive'));
    const swapBtn = secondary(h('span', {}, 'Swap'), () => app.go('swap'), { disabled: !canSend, 'data-testid': 'swap' });
    swapBtn.prepend(icon('swap'));
    const buyBtn = secondary(h('span', {}, 'Buy'), () => openBuyChooser(app), { 'data-testid': 'buy' });
    buyBtn.prepend(icon('buy'));
    const why = !canSend && s.sync.state !== 'synced' ? h('p', { class: 'small center', text: `${hasFunds ? 'Sending and swaps are' : 'Swaps are'} paused: ${s.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` }) : null;
    put(actionsBox, h('div', { class: 'btn-row three four' }, ...(hasFunds ? [sendBtn, recvBtn, swapBtn, buyBtn] : [recvBtn, sendBtn, swapBtn, buyBtn])), why);
  }

  function renderBanner() {
    const parts = [];
    if (app.updates.available) {
      parts.push(
        h('div', { class: 'notice info', 'data-testid': 'update-banner' }, icon('download'), h('div', { class: 'grow', text: `BEAM Campfire ${app.updates.available.version} is ready. It was checked against the release signature.` }), h('button', { class: 'btn btn-primary btn-small', onclick: () => app.updates.apply(), 'data-testid': 'update-apply' }, 'Update')),
      );
    }
    if (needsBackupPrompt(app)) {
      parts.push(
        h(
          'div',
          { class: 'notice warn', 'data-testid': 'backup-prompt' },
          icon('alert'),
          h(
            'div',
            { class: 'grow' },
            h('strong', { text: 'Keep a copy of this wallet outside this phone. ' }),
            "It has no 12 words: if this phone is lost or this app's web address stops working, only a wallet.db copy brings it back.",
            h(
              'div',
              { class: 'btn-row prompt-actions' },
              h('button', { class: 'btn btn-primary btn-small', onclick: () => app.go('backup'), 'data-testid': 'backup-prompt-export' }, 'Export wallet.db'),
              h('button', { class: 'btn btn-text btn-small', 'data-testid': 'backup-prompt-later', onclick: async () => {
                await app.setPrefs({ backupPromptSnoozedUntil: Date.now() + 7 * 86400000 });
                renderBanner();
              } }, 'Later'),
            ),
          ),
        ),
      );
    }
    if (app.updates.refused) parts.push(notice('error', `An update was refused: ${app.updates.refused.reason} You are still on the version you had.`));
    // Normally the move to a new loader takes seconds after an Update; only a
    // move still pending after that is worth a word.
    if (loaderBehind() && performance.now() > 10000) {
      parts.push(
        h(
          'div',
          { class: 'notice warn', 'data-testid': 'update-finishing' },
          icon('alert'),
          h(
            'div',
            { class: 'grow' },
            h('strong', { text: 'One step left to finish the update. ' }),
            'Until then Buy, Ethereum and dApps cannot connect. You unlock again after it.',
            h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-primary btn-small', 'data-testid': 'update-finish', onclick: () => location.reload() }, 'Finish now')),
          ),
        ),
      );
    }
    put(bannerBox, ...parts);
  }
  const bannerLater = setTimeout(() => renderBanner(), 11000);
  const onController = () => renderBanner();
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', onController);

  const off = wallet.onChange(render);
  const offU = app.updates.onChange(renderBanner);
  // Buys still on their way are followed while the wallet is open (one store read when there are none).
  import('../lib/buy/wiring.js').then((m) => m.followBuys(app)).catch(() => {});
  render(wallet.state);
  renderBanner();

  // dApps, BEAM names and airdrop codes share one line, no taller than the dApps row it took over:
  // Home scrolls no further than before. Each is one tap away.
  const tile = (testid, ico, text, to, label = null) =>
    h('button', { class: 'tile', type: 'button', onclick: () => app.go(to), 'data-testid': testid, 'aria-label': label }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 't', text }));
  const moreRow = h(
    'div',
    { class: 'card more-entry' },
    tile('open-dapps', 'apps', 'dApps', 'dapps', 'dApps: Beam DEX, NFT Gallery and more'),
    tile('names', 'at', 'BEAM names', 'names'),
    tile('airdrop', 'gift', 'Airdrop codes', 'airdrop'),
  );

  const el = screen(
    { brand: true, tabs: 'home', app, right: h('button', { class: 'icon-btn', 'aria-label': 'Lock', onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')) },
    chainSwitch(app, 'beam'),
    bannerBox,
    balanceBox,
    actionsBox,
    moreRow,
    assetsBox,
    txBox,
  );
  return {
    el,
    destroy() {
      off();
      offU();
      clearTimeout(bannerLater);
      if (navigator.serviceWorker) navigator.serviceWorker.removeEventListener('controllerchange', onController);
    },
  };
}
