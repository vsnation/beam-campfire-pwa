/* Home
 * Spec: ONE job: see what I have and start a payment.
 *       Primary CTA: "Send" (when there is nothing to send yet: "Receive BEAM").
 *       Taps from app open: 0 after unlock.
 * Exit-intent reasons and answers:
 *   - "Is this number real / up to date?" -> sync line says Synced (and whether a second source
 *     confirmed the height), or exactly how far behind it is.
 *   - "Why can't I send?" -> the reason is written under the button, never a silent grey button.
 *   - "Where did my payment go?" -> recent payments with plain status right below.
 *   - "Empty wallet, now what?" -> the primary button becomes Receive.
 */
import { h, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, primary, secondary } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, txStatusText, isPendingTx } from '../lib/wallet.js';

export function syncLine(sync) {
  const cls = sync.state === 'synced' ? 'ok' : sync.state === 'offline' || sync.state === 'stalled' || sync.state === 'behind' ? 'bad' : 'wait';
  const pct = sync.state === 'syncing' && sync.percent != null ? ` (${sync.percent}%)` : '';
  return h('div', { class: 'syncline', 'data-testid': 'sync', 'data-state': sync.state, 'data-verified': String(Boolean(sync.verified)) }, h('span', { class: `dot ${cls}` }), h('span', { text: `${sync.title}${pct}` }));
}

export function txRow(app, tx, onclick) {
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

    const others = [...s.totals.entries()].filter(([id, t]) => id !== 0 && (t.available > 0n || t.receiving > 0n || t.sending > 0n));
    put(assetsBox, 
      ...(others.length
        ? [
            h('p', { class: 'section-title', text: 'Other assets' }),
            h(
              'div',
              { class: 'card list' },
              ...others.map(([id, t]) => {
                const l = app.wallet.label(id);
                return h('div', { class: 'row asset-row' }, h('span', { class: 'asset-badge', text: l.unit.startsWith('Asset ') ? 'CA' : l.unit.slice(0, 3) }), h('span', { class: 'main' }, h('div', { class: 't', text: l.name }), h('div', { class: 's', text: `Asset #${id}` })), h('span', { class: 'end' }, h('div', { text: formatAmount(t.available) }), h('div', { class: 'small', text: l.unit.startsWith('Asset ') ? '' : l.unit })));
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
    const why = !hasFunds ? null : !canSend ? h('p', { class: 'small center', text: s.sync.state === 'synced' ? '' : `Sending is paused: ${s.sync.title.toLowerCase()}.` }) : null;
    put(actionsBox, h('div', { class: 'btn-row' }, ...(hasFunds ? [sendBtn, recvBtn] : [recvBtn, sendBtn])), why);
  }

  function renderBanner() {
    const parts = [];
    if (app.updates.available) {
      parts.push(
        h('div', { class: 'notice info', 'data-testid': 'update-banner' }, icon('download'), h('div', { class: 'grow', text: `BEAM Campfire ${app.updates.available.version} is ready. It was checked against the release signature.` }), h('button', { class: 'btn btn-primary btn-small', onclick: () => app.updates.apply(), 'data-testid': 'update-apply' }, 'Update')),
      );
    }
    if (app.updates.refused) parts.push(notice('error', `An update was refused: ${app.updates.refused.reason} You are still on the version you had.`));
    if (app.loaderWarning) parts.push(notice('error', 'The server is offering app code that does not match the signed release. Don\'t enter your 12 words anywhere until this is explained.'));
    put(bannerBox, ...parts);
  }

  const off = wallet.onChange(render);
  const offU = app.updates.onChange(renderBanner);
  render(wallet.state);
  renderBanner();
  if (!app.loaderChecked) {
    app.loaderChecked = true;
    app.updates.loaderCheck().then((r) => {
      if (r.ok === false) {
        app.loaderWarning = true;
        renderBanner();
      }
    });
  }

  const el = screen(
    { brand: true, tabs: 'home', app, right: h('button', { class: 'icon-btn', 'aria-label': 'Lock', onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')) },
    bannerBox,
    balanceBox,
    actionsBox,
    assetsBox,
    txBox,
  );
  return {
    el,
    destroy() {
      off();
      offU();
    },
  };
}
