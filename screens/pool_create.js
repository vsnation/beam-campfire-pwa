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
import { unit, sideName, feeText, feePercent, poolParams, liquidity, problemText, readProblemText } from './pool_parts.js';
import { syncReason } from '../lib/sync.js';
import { t } from '../lib/i18n.js';

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
  const kindsBox = h('div', { class: 'card list', role: 'radiogroup', 'aria-label': t('Fee for every swap') });
  const statusBox = h('div');
  const costBox = h('div');
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'create-reason', 'aria-live': 'polite' });
  const cta = primary(t('Create pool'), create, { disabled: true, class: 'btn btn-primary wrap', 'data-testid': 'create-cta' });

  const need = POOL_CREATE_DEPOSIT + POOL_CREATE_FEE;
  const existing = () => (pools && draft.b != null ? findPool(pools, { aid1: draft.a, aid2: draft.b, kind: draft.kind }) : null);
  const pairText = () => (draft.b == null ? null : draft.a < draft.b ? `${sideName(draft.a)}/${sideName(draft.b)}` : `${sideName(draft.b)}/${sideName(draft.a)}`);

  function ctaState() {
    if (preparing) return { off: t('Building the pool…') };
    if (!wallet.state.sync.canSend) return { off: t('Creating a pool is paused: {state}.', { state: syncReason(wallet.state.sync.title) }) };
    if (loadError && !pools) return { off: t('The pools could not be loaded. Try again above.') };
    if (!pools) return { off: t('Checking which pools exist…') };
    if (draft.b == null) return { off: t('Choose the second asset.') };
    if (existing()) return { off: t('This pool already exists: open it and add your coins there.') };
    const beam = wallet.available(0);
    if (need > beam) return { off: t('Not enough BEAM. A new pool needs {deposit} BEAM for the deposit plus about {fee} BEAM network fee. You have {balance} BEAM.', { deposit: formatAmount(POOL_CREATE_DEPOSIT), fee: formatAmount(POOL_CREATE_FEE), balance: formatAmount(beam) }) };
    return { off: null };
  }

  function chip(id) {
    if (id == null) return [h('span', { class: 'muted', text: t('Choose') }), icon('down')];
    const l = wallet.label(id);
    return [assetBadge(l, { size: 'small' }), h('span', { text: l.unit }), icon('down')];
  }

  function render() {
    if (!alive) return;
    put(pickA, ...chip(draft.a));
    put(pickB, ...chip(draft.b));
    put(warnA, ...[draft.a, draft.b].filter((id) => id != null).map((id) => copyWarning(wallet.label(id))).filter(Boolean).map((w) => h('p', { class: 'warn-line', 'data-testid': 'create-copy-warning', text: w })));
    put(
      kindsBox,
      ...KIND_CHOICES.map((c) => {
        const on = c.kind === draft.kind;
        const exists = pools && draft.b != null && findPool(pools, { aid1: draft.a, aid2: draft.b, kind: c.kind });
        return h(
          'button',
          { class: `row${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), 'data-testid': `create-kind-${c.kind}`, onclick: () => setKind(c.kind) },
          h('span', { class: `radio${on ? ' on' : ''}`, 'aria-hidden': 'true' }),
          h('span', { class: 'main' }, h('div', { class: 't', text: t(c.title) }), h('div', { class: 's wrap', text: exists ? `${t(c.hint)} ${t('This pool exists already.')}` : t(c.hint) })),
        );
      }),
    );
    const ex = existing();
    const st = [];
    if (loadError && !pools) st.push(h('div', { 'data-testid': 'create-load-error' }, notice('error', readProblemText(loadError, 'exist'), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => load(true) }, t('Try again')))));
    if (ex) {
      st.push(
        h(
          'div',
          { 'data-testid': 'create-exists' },
          notice(
            'info',
            h('strong', { text: `${t('The {pair} pool with a {percent} fee already exists.', { pair: pairText(), percent: feePercent(ex.kind) })} ` }),
            isEmptyPool(ex) ? `${t('It is empty: add the first coins to it instead.')} ` : `${t('Add your coins to it instead, or pick another fee.')} `,
            h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'create-open-existing', onclick: () => app.go('pool', poolParams(ex, { mode: 'add' })) }, t('Open the pool')),
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
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Deposit (locked)') }), h('span', { class: 'v', 'data-testid': 'create-deposit', text: `${formatAmount(POOL_CREATE_DEPOSIT)} BEAM` })), // i18n-ignore: an amount and its ticker
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'create-fee', text: t('about {amount} BEAM', { amount: formatAmount(POOL_CREATE_FEE) }) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Total BEAM out') }), h('span', { class: 'v', 'data-testid': 'create-total', text: `${formatAmount(need)} BEAM` })), // i18n-ignore: an amount and its ticker
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
    cta.textContent = draft.b == null ? t('Create pool') : t('Create the {pair} pool', { pair: pairText() });
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
        const search = h('input', { class: 'input', type: 'search', placeholder: t('Search by name or number'), 'aria-label': t('Search'), autocomplete: 'off', 'data-testid': 'picker-search' });
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
              : [h('p', { class: 'small center pad', text: t('Nothing matches. Try another name or number.') })]),
          );
        };
        search.addEventListener('input', fill);
        fill();
        return [h('h2', { text: first ? t('First asset') : t('Second asset') }), ids.length > 8 ? search : null, list, h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close'))];
      },
      { label: first ? t('First asset') : t('Second asset') },
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
          rows: [[t('New pool'), `${pair} · ${feeText(kind)}`]],
          warn: t('The {amount} BEAM deposit stays locked in the DEX until the pool is empty and you, its creator, close it. The new pool starts empty: once the network confirms it, add the first coins; they set its price.', { amount: formatAmount(POOL_CREATE_DEPOSIT) }),
          ack: t('I understand the {amount} BEAM stays locked until the pool is empty', { amount: formatAmount(POOL_CREATE_DEPOSIT) }),
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
    { title: t('Create a pool'), back: () => app.back('pools'), actions: [reason, cta], cls: 'swap pool-create sticky-actions' },
    h(
      'div',
      { 'data-testid': 'create-deposit-note' },
      notice('warn', h('strong', { text: `${t('Creating a pool locks a {amount} BEAM deposit.', { amount: formatAmount(POOL_CREATE_DEPOSIT) })} ` }), t('You get it back only when the pool is empty and you close it. The pool starts empty: you add the first coins next, and they set its price.')),
    ),
    h('p', { class: 'section-title', text: t('Assets') }),
    h('div', { class: 'create-pair' }, pickA, h('span', { class: 'slash', text: '/' }), pickB),
    warnA,
    h('p', { class: 'section-title', text: t('Fee for every swap') }),
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
