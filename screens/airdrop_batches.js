/* Airdrop: my batches
 * Spec: ONE job: see what my codes are doing, and take back what nobody claimed.
 *       Primary CTA: "Create new codes"; on a batch with unclaimed codes, "Take back 0.5 FOMO".
 *       Taps from app open: 2 (Home -> Airdrop codes -> My batches), 3 to take a batch back, then approve.
 * Exit-intent reasons and answers:
 *   - "Did anyone claim my codes?" -> claimed and not claimed, per batch, from the network.
 *   - "Can I get my money back?" -> one button per batch with the amount that comes back, and the
 *     0.181 BEAM network fee said before it.
 *   - "Where are the codes?" -> Show codes on every batch whose codes are on this device; a batch
 *     whose codes are not here can still be taken back.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { CANCEL_FEE, TX_STATUS, batchTotal } from '../lib/airdrop.js';
import { airdrop, amountText, dropProblemText } from './airdrop.js';

export default function airdropBatches(app) {
  let state = 'loading'; // loading | done | error
  let rows = [];
  let error = null;
  let savedError = null;
  let busyId = null;
  let result = null;
  let alive = true;
  const body = h('div', { class: 'content' });

  async function load() {
    state = 'loading';
    render();
    const svc = airdrop(app);
    try {
      savedError = null;
      const [chain, saved] = await Promise.all([
        svc.myBatches(),
        svc.savedBatches().catch((e) => {
          savedError = e;
          return [];
        }),
      ]);
      const out = [];
      const matched = new Set();
      for (const b of chain) {
        let local = null;
        try {
          const vouchers = await svc.batchVouchers(b.id);
          const hashes = new Set(vouchers.map((v) => v.hash));
          local = saved.find((s) => s.codes.some((c) => hashes.has(c.hash))) || null;
          if (local) matched.add(local.localId);
          b.unclaimedValue = vouchers.filter((v) => !v.redeemed).reduce((sum, v) => sum + v.value, 0n);
        } catch {
          /* the batch still shows; its codes are just not linked */
        }
        if (b.unclaimedValue == null) b.unclaimedValue = b.valuePerVoucher * BigInt(b.unclaimedCount);
        out.push({ kind: 'chain', batch: b, local });
      }
      for (const s of saved) {
        if (matched.has(s.localId) || s.txStatus === TX_STATUS.failed) continue;
        out.push({ kind: 'local', local: s });
      }
      rows = out;
      state = 'done';
    } catch (e) {
      error = e;
      state = 'error';
    }
    if (alive) render();
  }

  async function takeBack(b) {
    if (busyId != null) return;
    busyId = b.id;
    result = null;
    render();
    try {
      const r = await airdrop(app).cancelBatch(b.id);
      if (!alive) return;
      result = { kind: 'success', code: 'sent', text: `Cancel sent. The ${r.count} unclaimed ${r.count === 1 ? 'code stops' : 'codes stop'} working and ${amountText(b.assetId, r.total)} comes back once the network confirms it, usually within 2 minutes.` };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      result = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: dropProblemText(e, 'cancel') };
    }
    busyId = null;
    render();
  }

  function chainRow({ batch: b, local }) {
    const u = (v) => amountText(b.assetId, v);
    const busy = busyId === b.id;
    // The network fee is paid in BEAM; BEAM coming back pays it first.
    const back = b.assetId === 0 ? b.unclaimedValue : 0n;
    const feeShort = b.unclaimedCount > 0 && CANCEL_FEE > back && wallet.available(0) < CANCEL_FEE - back ? CANCEL_FEE - back : null;
    return h(
      'div',
      { class: 'card batch', 'data-testid': 'batch', 'data-batch-id': String(b.id) },
      h('div', { class: 'batch-head' }, h('strong', { text: `${b.totalCount} ${b.totalCount === 1 ? 'code' : 'codes'} × ${u(b.valuePerVoucher)}` }), h('span', { class: 'small', text: `Batch ${b.id}` })),
      h('p', { class: 'small', 'data-testid': 'batch-counts', text: `${b.redeemedCount} claimed · ${b.unclaimedCount} not claimed` }),
      local ? null : h('p', { class: 'small', text: b.unclaimedCount > 0 ? 'Its codes are not on this device, but you can still take back what nobody claimed.' : 'Every code was claimed.' }),
      h(
        'div',
        { class: 'btn-row' },
        local ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'batch-show', onclick: () => app.go('airdropCodes', { localId: local.localId }) }, 'Show codes') : null,
        b.unclaimedCount > 0
          ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'batch-cancel', disabled: busyId != null || !wallet.state.sync.canSend || feeShort != null, onclick: () => takeBack(b) }, busy ? 'Preparing…' : `Take back ${u(b.unclaimedValue)}`)
          : null,
      ),
      feeShort != null
        ? h('p', { class: 'hint', 'data-testid': 'batch-fee-short' }, `Taking back needs ${formatAmount(feeShort)} BEAM for the network fee; this wallet has ${formatAmount(wallet.available(0))} BEAM. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM'))
        : b.unclaimedCount > 0 && !wallet.state.sync.canSend
          ? h('p', { class: 'hint', text: `Taking back is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` })
          : null,
    );
  }

  function localRow({ local: s }) {
    const n = s.codes.length;
    const waiting = s.txStatus === TX_STATUS.broadcast || s.txStatus === TX_STATUS.unconfirmed;
    return h(
      'div',
      { class: 'card batch', 'data-testid': 'batch-local' },
      h('div', { class: 'batch-head' }, h('strong', { text: `${n} ${n === 1 ? 'code' : 'codes'} · ${amountText(s.assetId, batchTotal(s))}` }), h('span', { class: 'small', text: new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) })),
      h('p', { class: 'small', text: waiting ? 'Waiting for the network. The codes start working once it is confirmed.' : 'Every code was claimed or taken back.' }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => app.go('airdropCodes', { localId: s.localId }) }, 'Show codes')),
    );
  }

  function render() {
    if (!alive) return;
    const parts = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'batches-result';
      el.dataset.code = result.code || '';
      parts.push(el);
    }
    if (state === 'loading' && !rows.length) parts.push(h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Checking your codes on the network…' })));
    else if (state === 'error') parts.push(notice('error', `Your batches could not be read: ${error.message} Your saved codes are safe on this device. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, 'Try again')));
    else if (!rows.length) parts.push(h('div', { class: 'card empty', 'data-testid': 'batches-empty' }, icon('share'), h('p', { text: 'No airdrop codes yet.' }), h('p', { class: 'small', text: 'Create codes to give tokens to people. Each code can be claimed once.' })));
    else {
      if (rows.some((r) => r.kind === 'chain' && r.batch.unclaimedCount > 0)) parts.push(h('p', { class: 'small', text: `Taking a batch back stops its unclaimed codes and returns their value. Network fee ${formatAmount(CANCEL_FEE)} BEAM.` }));
      parts.push(...rows.map((r) => (r.kind === 'chain' ? chainRow(r) : localRow(r))));
    }
    if (savedError) parts.push(notice('warn', `The codes saved on this device could not be opened: ${savedError.message}`));
    put(body, ...parts);
  }

  const off = wallet.onChange(() => {
    if (state === 'done') render();
  });
  load();
  const el = screen(
    { title: 'My batches', back: () => app.go('airdrop'), cls: 'airdrop-batches feature', actions: [primary('Create new codes', () => app.go('airdropCreate'), { 'data-testid': 'batches-create' })] },
    body,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
