/* Create a pool
 * Spec: ONE job: create a new, empty pool for two assets.
 *       Primary CTA: "Create the BEAM/XYZ pool" (the approve sheet that follows shows the 10 BEAM deposit
 *       and the fee, and needs a tick before it can be approved).
 *       Taps from app open: Home -> Swap -> Pools -> "Create a pool" (3), pick the second asset (4-5),
 *       the button (6), then the tick and approve. A secondary action: BEAM is pre-filled as the first
 *       asset and the usual 1% fee is pre-selected. The first coins are added next, on the pool's own
 *       screen, once the network has confirmed it.
 * Exit-intent reasons and answers:
 *   - "10 BEAM? I didn't see that coming" -> the locked deposit is the first thing on the screen, before
 *     anything is chosen, and again on the approve sheet with a tick box.
 *   - "This pool already exists" -> said as soon as the pair and fee are chosen, with "Open the pool".
 *   - "Three fees, which one?" -> 1% is pre-selected and each says who it is for.
 *   - "#557, is that the real one?" -> every asset is named from its metadata with its number; copies of
 *     verified names are flagged.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { loadPools } from '../lib/dex_pools.js';
import { POOL_CREATE_DEPOSIT, POOL_CREATE_FEE, KIND_CHOICES, findPool, creatableAssets, isEmptyPool } from '../lib/dex_liquidity.js';
import { tokenSubtitle, copyWarning } from '../lib/meta.js';
import { unit, sideName, feeText, poolParams, liquidity, problemText, readProblemText } from './pool_parts.js';
import { syncReason } from '../lib/sync.js';

export default function poolCreate(app, params = {}) {
  if (!app.poolCreateDraft) app.poolCreateDraft = { a: 0, b: null, kind: 2 };
  const draft = app.poolCreateDraft;
  if (params.aidA != null) draft.a = Number(params.aidA);
  if (params.aidB != null) draft.b = Number(params.aidB) === draft.a ? null : Number(params.aidB);

  let pools = null;
  let loadError = null;
  let preparing = false;
  let result = null;
  let alive = true;

  const pickA = h('button', { class: 'asset-pick wide', type: 'button', 'data-testid': 'create-asset-a', onclick: () => pick(true) });
  const pickB = h('button', { class: 'asset-pick wide', type: 'button', 'data-testid': 'create-asset-b', onclick: () => pick(false) });
  const warnA = h('div');
  const kindsBox = h('div', { class: 'card list', role: 'radiogroup', 'aria-label': 'Fee for every swap' });
  const statusBox = h('div');
  const costBox = h('div');
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'create-reason', 'aria-live': 'polite' });
  const cta = primary('Create pool', create, { disabled: true, class: 'btn btn-primary wrap', 'data-testid': 'create-cta' });

  const need = POOL_CREATE_DEPOSIT + POOL_CREATE_FEE;
  const existing = () => (pools && draft.b != null ? findPool(pools, { aid1: draft.a, aid2: draft.b, kind: draft.kind }) : null);
  const pairText = () => (draft.b == null ? null : draft.a < draft.b ? `${sideName(draft.a)}/${sideName(draft.b)}` : `${sideName(draft.b)}/${sideName(draft.a)}`);

  function ctaState() {
    if (preparing) return { off: 'Building the pool…' };
    if (!wallet.state.sync.canSend) return { off: `Creating a pool is paused: ${syncReason(wallet.state.sync.title)}.` };
    if (loadError && !pools) return { off: 'The pools could not be loaded. Try again above.' };
    if (!pools) return { off: 'Checking which pools exist…' };
    if (draft.b == null) return { off: 'Choose the second asset.' };
    if (existing()) return { off: 'This pool already exists: open it and add your coins there.' };
    const beam = wallet.available(0);
    if (need > beam) return { off: `Not enough BEAM. A new pool needs ${formatAmount(POOL_CREATE_DEPOSIT)} BEAM for the deposit plus about ${formatAmount(POOL_CREATE_FEE)} BEAM network fee. You have ${formatAmount(beam)} BEAM.` };
    return { off: null };
  }

  function chip(id) {
    if (id == null) return [h('span', { class: 'muted', text: 'Choose' }), icon('down')];
    const l = wallet.label(id);
    return [assetBadge(l, { size: 'small' }), h('span', { text: l.unit }), icon('down')];
  }

  function render() {
    if (!alive) return;
    put(pickA, ...chip(draft.a));
    put(pickB, ...chip(draft.b));
    put(warnA, ...[draft.a, draft.b].filter((id) => id != null).map((id) => copyWarning(wallet.label(id))).filter(Boolean).map((t) => h('p', { class: 'warn-line', 'data-testid': 'create-copy-warning', text: t })));
    put(
      kindsBox,
      ...KIND_CHOICES.map((c) => {
        const on = c.kind === draft.kind;
        const exists = pools && draft.b != null && findPool(pools, { aid1: draft.a, aid2: draft.b, kind: c.kind });
        return h(
          'button',
          { class: `row${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), 'data-testid': `create-kind-${c.kind}`, onclick: () => setKind(c.kind) },
          h('span', { class: `radio${on ? ' on' : ''}`, 'aria-hidden': 'true' }),
          h('span', { class: 'main' }, h('div', { class: 't', text: c.title }), h('div', { class: 's wrap', text: exists ? `${c.hint} This pool exists already.` : c.hint })),
        );
      }),
    );
    const ex = existing();
    const st = [];
    if (loadError && !pools) st.push(h('div', { 'data-testid': 'create-load-error' }, notice('error', readProblemText(loadError, 'check which pools exist'), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => load(true) }, 'Try again'))));
    if (ex) {
      st.push(
        h(
          'div',
          { 'data-testid': 'create-exists' },
          notice(
            'info',
            h('strong', { text: `The ${pairText()} pool with a ${feeText(ex.kind).replace(' fee', '')} fee already exists. ` }),
            isEmptyPool(ex) ? 'It is empty: add the first coins to it instead. ' : 'Add your coins to it instead, or pick another fee. ',
            h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'create-open-existing', onclick: () => app.go('pool', poolParams(ex, { mode: 'add' })) }, 'Open the pool'),
          ),
        ),
      );
    }
    put(statusBox, ...st);
    put(
      costBox,
      h(
        'div',
        { class: 'card flat swap-details', 'data-testid': 'create-costs' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Deposit (locked)' }), h('span', { class: 'v', 'data-testid': 'create-deposit', text: `${formatAmount(POOL_CREATE_DEPOSIT)} BEAM` })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'create-fee', text: `about ${formatAmount(POOL_CREATE_FEE)} BEAM` })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total BEAM out' }), h('span', { class: 'v', 'data-testid': 'create-total', text: `${formatAmount(need)} BEAM` })),
      ),
    );
    const n = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'create-result';
      el.dataset.code = result.code || '';
      if (result.rpc != null) el.dataset.rpc = String(result.rpc);
      n.push(el);
    }
    put(notes, ...n);
    const st2 = ctaState();
    cta.disabled = Boolean(st2.off);
    cta.textContent = draft.b == null ? 'Create pool' : `Create the ${pairText()} pool`;
    reason.textContent = st2.off || '';
    reason.classList.toggle('hidden', !st2.off);
  }

  function setKind(k) {
    draft.kind = k;
    result = null;
    render();
  }

  function pick(first) {
    if (!pools) return;
    const heldIds = [...wallet.state.totals.entries()].filter(([, t]) => t.available > 0n).map(([id]) => id);
    const ids = creatableAssets(pools, heldIds);
    const have = (id) => wallet.available(id);
    openSheet(
      (close) => {
        const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or number', 'aria-label': 'Search', autocomplete: 'off', 'data-testid': 'picker-search' });
        const list = h('div', { class: 'card list picker-list' });
        const fill = () => {
          const q = search.value.trim().toLowerCase().replace(/^#/, '');
          const shown = ids.filter((id) => {
            if (!q) return true;
            const l = wallet.label(id);
            return String(id) === q || l.unit.toLowerCase().includes(q) || l.name.toLowerCase().includes(q);
          });
          put(
            list,
            ...(shown.length
              ? shown.map((id) => {
                  const l = wallet.label(id);
                  const current = id === (first ? draft.a : draft.b);
                  return h(
                    'button',
                    { class: `row${current ? ' on' : ''}`, type: 'button', 'data-asset-id': String(id), onclick: () => close(id) },
                    assetBadge(l),
                    h('span', { class: 'main' }, h('div', { class: 't', text: l.unit }), h('div', { class: 's', text: l.verified ? l.name : tokenSubtitle(l) })),
                    have(id) > 0n ? h('span', { class: 'end small', text: formatAmount(have(id)) }) : null,
                  );
                })
              : [h('p', { class: 'small center pad', text: 'Nothing matches. Try another name or number.' })]),
          );
        };
        search.addEventListener('input', fill);
        fill();
        return [h('h2', { text: first ? 'First asset' : 'Second asset' }), ids.length > 8 ? search : null, list, h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close')];
      },
      { label: first ? 'First asset' : 'Second asset' },
    ).then((id) => {
      if (id == null || !alive) return;
      if (first) {
        if (id === draft.b) draft.b = draft.a;
        draft.a = id;
      } else if (id === draft.a) {
        draft.a = draft.b == null ? draft.a : draft.b;
        draft.b = draft.b == null ? null : id;
      } else draft.b = id;
      if (draft.a === draft.b) draft.b = null;
      result = null;
      render();
    });
  }

  async function create() {
    if (preparing || ctaState().off) return;
    preparing = true;
    result = null;
    render();
    const aidA = draft.a;
    const aidB = draft.b;
    const kind = draft.kind;
    const pair = pairText();
    try {
      const sent = await liquidity().create({
        aidA,
        aidB,
        kind,
        intent: {
          rows: [['New pool', `${pair} · ${feeText(kind)}`]],
          warn: `The ${formatAmount(POOL_CREATE_DEPOSIT)} BEAM deposit stays locked in the DEX until the pool is empty and you, its creator, close it. The new pool starts empty: once the network confirms it, add the first coins; they set its price.`,
          ack: `I understand the ${formatAmount(POOL_CREATE_DEPOSIT)} BEAM stays locked until the pool is empty`,
        },
      });
      if (!alive) return;
      app.poolCreateDraft = null;
      wallet.refreshTxs();
      wallet.refreshStatus();
      const [aid1, aid2] = aidA < aidB ? [aidA, aidB] : [aidB, aidA];
      const list = (mp) => [...mp].map(([assetId, amount]) => ({ assetId, amount }));
      app.go('poolTx', { txId: sent.txId, action: 'create', aid1, aid2, kind, lpToken: null, pays: list(sent.built.pays), receives: list(sent.built.receives), fee: sent.built.fee }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      const rpc = e && e.rpc ? e.rpc.code : null;
      result = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', rpc, text: problemText(e, { action: 'create' }) };
      if (e.code === 'poolExists') load(true);
    }
    preparing = false;
    render();
  }

  async function load(force = false) {
    loadError = null;
    render();
    try {
      const l = await loadPools(force);
      if (!alive) return;
      pools = l;
    } catch (e) {
      if (!alive) return;
      loadError = e;
    }
    render();
  }

  const off = wallet.onChange(() => render());
  wallet.loadAllAssets();
  render();
  load(false);

  const el = screen(
    { title: 'Create a pool', back: () => app.back('pools'), actions: [reason, cta], cls: 'swap pool-create sticky-actions' },
    h(
      'div',
      { 'data-testid': 'create-deposit-note' },
      notice('warn', h('strong', { text: `Creating a pool locks a ${formatAmount(POOL_CREATE_DEPOSIT)} BEAM deposit. ` }), 'You get it back only when the pool is empty and you close it. The pool starts empty: you add the first coins next, and they set its price.'),
    ),
    h('p', { class: 'section-title', text: 'Assets' }),
    h('div', { class: 'create-pair' }, pickA, h('span', { class: 'slash', text: '/' }), pickB),
    warnA,
    h('p', { class: 'section-title', text: 'Fee for every swap' }),
    kindsBox,
    statusBox,
    costBox,
    notes,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
