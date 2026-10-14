/* Airdrop: my batches
 * Spec: ONE job: see what my codes are doing, and take back what nobody claimed.
 *       Primary CTA: "Create new codes"; on a batch with unclaimed codes, "Take back 0.5 bETH".
 *       Taps from app open: 2 (Home -> Airdrop codes -> My batches), 3 to take a batch back, then approve.
 * Exit-intent reasons and answers:
 *   - "Did anyone claim my codes?" -> claimed, not claimed and taken back, per batch, from the network.
 *   - "Can I get my money back?" -> one button per batch with the amount that comes back (claim fees paid
 *     ahead included), and that batch's network fee said under it.
 *   - "Did the take-back work?" -> sent, then done once the network confirms it; if a code was claimed
 *     first, it says nothing changed and shows what is left to take back.
 *   - "Where are the codes?" -> Show codes on every batch whose codes are on this device; a batch
 *     whose codes are not here can still be taken back.
 *   - "My older codes?" -> batches on the earlier airdrop contract are listed and taken back as before.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { CANCEL_FEE, TX_STATUS, CHECK_STATE, batchTotal } from '../lib/airdrop.js';
import { V3_CID, cancelFee } from '../lib/airdrop_v3.js';
import { airdrop, amountText, dropProblemText } from './airdrop.js';
import { syncReason } from '../lib/sync.js';

const CANCEL_POLL_MS = 6000;

export default function airdropBatches(app) {
  let state = 'loading'; // loading | done | error
  let rows = [];
  let error = null;
  let savedError = null;
  let partError = null; // one contract's list could not be read
  let busyKey = null;
  let pending = null; // a take-back sent: { txId, key, what }
  let pollTimer = null;
  let result = null;
  let alive = true;
  const body = h('div', { class: 'content' });
  const keyOf = (contract, id) => `${contract}:${id}`;

  async function load() {
    state = 'loading';
    render();
    const svc = airdrop(app);
    try {
      savedError = null;
      partError = null;
      const [v3List, oldList, saved] = await Promise.all([
        svc.v3.myBatches().catch((e) => ({ error: e })),
        svc.old.myBatches().catch((e) => ({ error: e })),
        svc.savedBatches().catch((e) => {
          savedError = e;
          return [];
        }),
      ]);
      if (v3List.error && oldList.error) throw v3List.error;
      partError = v3List.error || oldList.error || null;
      const out = [];
      const matched = new Set();
      for (const b of v3List.error ? [] : v3List.batches) {
        const local = saved.find((s) => s.contractId === V3_CID && s.batchId === String(b.id)) || null;
        if (local) matched.add(local.localId);
        out.push({ kind: 'v3', batch: b, local });
      }
      for (const b of oldList.error ? [] : oldList) {
        let local = null;
        try {
          const vouchers = await svc.old.batchVouchers(b.id);
          const hashes = new Set(vouchers.map((v) => v.hash));
          local = saved.find((s) => s.contractId !== V3_CID && s.codes.some((c) => hashes.has(c.hash))) || null;
          if (local) matched.add(local.localId);
          b.unclaimedValue = vouchers.filter((v) => !v.redeemed).reduce((sum, v) => sum + v.value, 0n);
        } catch {
          /* the batch still shows; its codes are just not linked */
        }
        if (b.unclaimedValue == null) b.unclaimedValue = b.valuePerVoucher * BigInt(b.unclaimedCount);
        out.push({ kind: 'old', batch: b, local });
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

  /** A sent take-back counts once the network confirms it; one that fails changed nothing. */
  async function pollCancel() {
    clearTimeout(pollTimer);
    if (!alive || !pending) return;
    try {
      const t = await wallet.txStatus(pending.txId);
      const s = Number(t && t.status);
      if (!alive || !pending) return;
      if (s === 3 || s === 4 || s === 2) {
        result =
          s === 3
            ? { kind: 'success', code: 'done', text: `Taken back: ${pending.what} is back in your wallet.` }
            : { kind: 'info', code: 'cancelFailed', text: 'The take-back did not go through, so nothing changed and nothing left your wallet. If a code was claimed in the meantime, take back what is left now.' };
        pending = null;
        wallet.refreshTxs();
        wallet.refreshStatus();
        load();
        return;
      }
    } catch {
      /* asked again shortly */
    }
    pollTimer = setTimeout(pollCancel, CANCEL_POLL_MS);
  }

  async function takeBack(contract, b, what) {
    if (busyKey != null || pending) return;
    busyKey = keyOf(contract, b.id);
    result = null;
    render();
    try {
      const r = await airdrop(app).cancelBatch({ contract, batchId: b.id });
      if (!alive) return;
      result = { kind: 'success', code: 'sent', text: `Take-back sent. The ${r.count} unclaimed ${r.count === 1 ? 'code stops' : 'codes stop'} working and ${what} comes back once the network confirms it, usually within 2 minutes.` };
      pending = { txId: r.txId, key: busyKey, what };
      pollTimer = setTimeout(pollCancel, CANCEL_POLL_MS);
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      result = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: dropProblemText(e, 'take-back') };
      // A claim landed while it was prepared: read the batch again, so the button shows what is left.
      if (e.code === 'changed') {
        busyKey = null;
        return load();
      }
    }
    busyKey = null;
    render();
  }

  /** Show codes and the take-back button in one row, then the take-back's fee line, or why it may not work right now. */
  function batchActions(contract, b, local, { unclaimed, what, beamBack, fee }) {
    const key = keyOf(contract, b.id);
    const busy = busyKey === key;
    const sent = pending && pending.key === key;
    // The network fee is paid in BEAM; BEAM coming back pays it first.
    const feeShort = unclaimed > 0 && fee > beamBack && wallet.available(0) < fee - beamBack ? fee - beamBack : null;
    const show = local ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'batch-show', onclick: () => app.go('airdropCodes', { localId: local.localId }) }, 'Show codes') : null;
    if (!unclaimed) return show ? [h('div', { class: 'btn-row' }, show)] : [];
    return [
      h('div', { class: 'btn-row' }, show, h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'batch-cancel', disabled: busyKey != null || Boolean(pending) || !wallet.state.sync.canSend || feeShort != null, onclick: () => takeBack(contract, b, what) }, busy ? 'Preparing…' : sent ? 'Taking back…' : `Take back ${what}`)),
      feeShort != null
        ? h('p', { class: 'hint', 'data-testid': 'batch-fee-short' }, `Taking back needs ${formatAmount(feeShort)} BEAM for the network fee; this wallet has ${formatAmount(wallet.available(0))} BEAM. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM'))
        : !wallet.state.sync.canSend
          ? h('p', { class: 'hint', text: `Taking back is paused: ${syncReason(wallet.state.sync.title)}.` })
          : h('p', { class: 'hint', 'data-testid': 'batch-fee', text: `Network fee ${formatAmount(fee)} BEAM` }),
    ];
  }

  function v3Row({ batch: b, local }) {
    const u = (v) => amountText(b.assetId, v);
    const gasBack = b.gasPerVoucher * BigInt(b.unclaimed);
    const what = b.assetId === 0 ? u(b.valueUnclaimed + gasBack) : gasBack ? `${u(b.valueUnclaimed)} + ${formatAmount(gasBack)} BEAM` : u(b.valueUnclaimed);
    const each = local && local.codes.every((c) => c.value === local.codes[0].value) ? ` × ${u(BigInt(local.codes[0].value))}` : '';
    const counts = [`${b.redeemed} claimed`, `${b.unclaimed} not claimed`, ...(b.cancelled ? [`${b.cancelled} taken back`] : [])].join(' · ');
    return h(
      'div',
      { class: 'card batch', 'data-testid': 'batch', 'data-batch-id': String(b.id), 'data-contract': 'v3' },
      h('div', { class: 'batch-head' }, h('strong', { text: `${b.created} ${b.created === 1 ? 'code' : 'codes'}${each}` }), h('span', { class: 'small', text: `Batch ${b.id}` })),
      h('p', { class: 'small', 'data-testid': 'batch-counts', text: counts }),
      b.gasPerVoucher > 0n ? h('p', { class: 'small', text: 'Claim fees paid: people with an empty wallet can claim.' }) : null,
      local ? null : h('p', { class: 'small', text: b.unclaimed > 0 ? 'Its codes are not on this device, but you can still take back what nobody claimed.' : 'Nothing is left to claim.' }),
      ...batchActions('v3', b, local, { unclaimed: b.unclaimed, what, beamBack: gasBack + (b.assetId === 0 ? b.valueUnclaimed : 0n), fee: cancelFee(b.unclaimed) }),
    );
  }

  function oldRow({ batch: b, local }) {
    const u = (v) => amountText(b.assetId, v);
    return h(
      'div',
      { class: 'card batch', 'data-testid': 'batch', 'data-batch-id': String(b.id), 'data-contract': 'v2' },
      h('div', { class: 'batch-head' }, h('strong', { text: `${b.totalCount} ${b.totalCount === 1 ? 'code' : 'codes'} × ${u(b.valuePerVoucher)}` }), h('span', { class: 'small', text: `Earlier batch ${b.id}` })),
      h('p', { class: 'small', 'data-testid': 'batch-counts', text: `${b.redeemedCount} claimed · ${b.unclaimedCount} not claimed` }),
      local ? null : h('p', { class: 'small', text: b.unclaimedCount > 0 ? 'Its codes are not on this device, but you can still take back what nobody claimed.' : 'Every code was claimed.' }),
      ...batchActions('v2', b, local, { unclaimed: b.unclaimedCount, what: u(b.unclaimedValue), beamBack: b.assetId === 0 ? b.unclaimedValue : 0n, fee: CANCEL_FEE }),
    );
  }

  function localRow({ local: s }) {
    const n = s.codes.length;
    const v3 = s.contractId === V3_CID;
    const waiting = s.txStatus === TX_STATUS.broadcast || s.txStatus === TX_STATUS.unconfirmed;
    let text = waiting ? 'Waiting for the network. The codes start working once it is confirmed.' : 'Every code was claimed or taken back.';
    if (v3 && s.check && s.check.state === CHECK_STATE.failed) text = 'These codes did not pass the check: do not share them. Show codes says what to do.';
    else if (v3 && s.check && s.check.state === CHECK_STATE.ok) text = 'Checked and ready to share.';
    else if (v3) text = 'Being confirmed and checked before you share the codes. Show codes to see how far it is.';
    return h(
      'div',
      { class: 'card batch', 'data-testid': 'batch-local' },
      h('div', { class: 'batch-head' }, h('strong', { text: `${n} ${n === 1 ? 'code' : 'codes'} · ${amountText(s.assetId, batchTotal(s))}` }), h('span', { class: 'small', text: new Date(s.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) })),
      h('p', { class: 'small', 'data-testid': 'batch-local-state', text }),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'batch-show', onclick: () => app.go('airdropCodes', { localId: s.localId }) }, 'Show codes')),
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
      if (rows.some((r) => (r.kind === 'v3' && r.batch.unclaimed > 0) || (r.kind === 'old' && r.batch.unclaimedCount > 0))) parts.push(h('p', { class: 'small', text: 'Taking a batch back stops its unclaimed codes and returns their value, with any claim fees paid ahead.' }));
      parts.push(...rows.map((r) => (r.kind === 'v3' ? v3Row(r) : r.kind === 'old' ? oldRow(r) : localRow(r))));
    }
    if (state === 'done' && partError) parts.push(notice('warn', `Some batches could not be read just now: ${partError.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, 'Try again')));
    if (savedError) parts.push(notice('warn', `The codes saved on this device could not be opened: ${savedError.message}`));
    put(body, ...parts);
  }

  const off = wallet.onChange(() => {
    if (state === 'done') render();
  });
  load();
  const el = screen(
    { title: 'My batches', back: () => app.back('airdrop'), cls: 'airdrop-batches feature', actions: [primary('Create new codes', () => app.go('airdropCreate'), { 'data-testid': 'batches-create' })] },
    body,
  );
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(pollTimer);
      off();
    },
  };
}
