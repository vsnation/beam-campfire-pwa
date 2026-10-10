/* Airdrop: the codes of one batch
 * Spec: ONE job: get the codes out of this device to the people they are for.
 *       Primary CTA: "Copy all 10 codes", above the list (each code also has its own copy button; Share where the phone has it).
 *       Taps from app open: right after creating a batch (0 more), or Home -> Airdrop codes -> My batches -> Show codes (3).
 * Exit-intent reasons and answers:
 *   - "Where are my codes kept?" -> only on this device, encrypted in this wallet: said at the top.
 *   - "Did it work?" -> right after creating: sent, and the codes start working once confirmed.
 *   - "Which ones were claimed?" -> each code shows what the network last said about it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText } from '../lib/ui.js';
import { batchTotal, CODE_STATUS, TX_STATUS } from '../lib/airdrop.js';
import { airdrop, amountText } from './airdrop.js';

const STATUS_TEXT = { [CODE_STATUS.available]: 'Not claimed', [CODE_STATUS.claimed]: 'Claimed', [CODE_STATUS.notFound]: 'Not on the network', [CODE_STATUS.unknown]: '' };

export default function airdropCodes(app, p = {}) {
  let batch = null;
  let error = null;
  let alive = true;
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });

  function render() {
    if (!alive) return;
    if (error) {
      put(body, notice('error', `The saved codes could not be opened: ${error.message} They stay saved on this device. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, 'Try again')));
      put(actions, secondary('My batches', () => app.go('airdropBatches')));
      return;
    }
    if (!batch) {
      put(body, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Opening your saved codes…' })));
      return;
    }
    const same = batch.codes.every((c) => c.value === batch.codes[0].value);
    const all = batch.codes.map((c) => c.code).join('\n');
    const n = batch.codes.length;
    const copyAll = primary(`Copy all ${n} ${n === 1 ? 'code' : 'codes'}`, () => copyText(all, `${n} ${n === 1 ? 'code' : 'codes'} copied`), { 'data-testid': 'codes-copy-all' });
    put(
      body,
      p.justCreated
        ? notice('success', h('strong', { text: 'Batch sent. ' }), 'The codes start working once the network confirms it, usually within 2 minutes.')
        : batch.txStatus === TX_STATUS.broadcast || batch.txStatus === TX_STATUS.unconfirmed
          ? notice('info', 'This batch is waiting for the network. The codes start working once it is confirmed.')
          : batch.txStatus === TX_STATUS.failed
            ? notice('info', 'This batch was never sent, so these codes hold nothing. They stay saved here anyway.')
            : null,
      h('p', { class: 'lead', 'data-testid': 'codes-summary', text: same ? `${n} ${n === 1 ? 'code' : 'codes'} · ${amountText(batch.assetId, BigInt(batch.codes[0].value))} each` : `${n} codes · ${amountText(batch.assetId, batchTotal(batch))} in total` }),
      batch.txStatus === TX_STATUS.failed
        ? null
        : notice('warn', h('strong', { text: 'These codes are the only key to the locked funds. ' }), 'Anyone who has a code can claim it, so send each one only to its person. They are kept only on this device, in this wallet: copy them somewhere safe.'),
      // Copying is the job: the button sits above the list, however long it is.
      h('div', { class: 'btn-row' }, copyAll, typeof navigator.share === 'function' ? secondary('Share', () => navigator.share({ text: all }).catch(() => {}), { 'data-testid': 'codes-share' }) : null),
      h(
        'div',
        { class: 'card list codes-list', 'data-testid': 'codes-list' },
        ...batch.codes.map((c, i) =>
          h(
            'div',
            { class: 'row asset-row code-row' },
            h('span', { class: 'code-n', text: String(i + 1) }),
            h('span', { class: 'main' }, h('div', { class: 't mono code-text', 'data-testid': 'code', text: c.code }), STATUS_TEXT[c.status] ? h('div', { class: 's', text: STATUS_TEXT[c.status] }) : null),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copy code ${i + 1}`, onclick: () => copyText(c.code, 'Code copied') }, icon('copy')),
          ),
        ),
      ),
    );
    put(actions, h('button', { class: 'btn btn-text', onclick: () => app.go('airdropBatches') }, 'My batches'));
  }

  async function load() {
    error = null;
    render();
    try {
      const list = await airdrop(app).savedBatches();
      batch = list.find((b) => b.localId === p.localId) || null;
      if (!batch) error = new Error('This batch is not among the codes saved on this device.');
    } catch (e) {
      error = e;
    }
    render();
  }

  load();
  const el = screen({ title: p.justCreated ? 'Your airdrop codes' : 'Airdrop codes', back: () => app.go(p.justCreated ? 'airdrop' : 'airdropBatches'), cls: 'airdrop-codes feature' }, body);
  el.appendChild(actions);
  return {
    el,
    destroy() {
      alive = false;
    },
  };
}
