/* Airdrop: the codes of one batch
 * Spec: ONE job: get the codes out of this device to the people they are for, once they are safe to share.
 *       Primary CTA: "Copy all 10 codes", above the list (each code also has its own copy button; Share where
 *       the phone has it). Before a new batch's codes are checked there is no copy button: the screen says what
 *       it is waiting for. If the check fails: "Make new codes".
 *       Taps from app open: right after creating a batch (0 more), or Home -> Airdrop codes -> My batches -> Show codes (3).
 * Exit-intent reasons and answers:
 *   - "Where are my codes kept?" -> only on this device, encrypted in this wallet: said at the top.
 *   - "Did it work? Can I share them now?" -> a new batch shows its steps: sent, confirmed by the network
 *     (n of 3), every code checked (n of 10). The codes appear, ready to copy, only after that.
 *   - "Something went wrong" -> a failed check says plainly not to share these codes, that the funds are
 *     safe, and offers "Make new codes" (same amounts) and taking the batch back.
 *   - "Which ones were claimed?" -> each code shows what the network last said about it.
 *   - "I need them in a spreadsheet / somewhere safe" -> "Save as CSV" (the desktop's columns) to the share
 *     sheet or a download, with a word that the file holds the keys in plain text.
 *   - "Are they safe on the clipboard?" -> Copy says the clipboard is emptied after a minute (and at the lock).
 *   - "Someone could see them in the app switcher" -> the codes leave the screen while the app is out of
 *     sight and come back by themselves on return (copy, paste in a chat, come back for the next).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copySecret, toast, onHidden, onShown } from '../lib/ui.js';
import { batchTotal, CODE_STATUS, TX_STATUS } from '../lib/airdrop.js';
import { V3_CID, CONFIRMATIONS_BEFORE_CHECK, CHECK_PROBLEM_TEXT } from '../lib/airdrop_v3.js';
import { airdrop, amountText } from './airdrop.js';
import { csvFile } from '../lib/airdrop_csv.js';
import { deliverExport } from '../lib/export.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { evictionRisk } from '../lib/storage.js';
import { STORAGE_TEXT } from './storage_warning.js';
import { t, tn, tk, asSentence } from '../lib/i18n.js';

// What the network last said about a code, shown as t(STATUS_TEXT[status]).
const STATUS_TEXT = { [CODE_STATUS.available]: tk('Not claimed'), [CODE_STATUS.claimed]: tk('Claimed'), [CODE_STATUS.notFound]: tk('Not on the network'), [CODE_STATUS.takenBack]: tk('Taken back'), [CODE_STATUS.unknown]: '' };
const WAIT_MS = 10000;

export default function airdropCodes(app, p = {}) {
  let batch = null;
  let error = null;
  let alive = true;
  // A v3 batch: where its check stands (lib/airdrop_v3.js verifyBatch), and progress while checking.
  let v3 = null; // { state, confirmations?, problem?, mined?, onChain?, done?, total?, error? }
  let waitTimer = null;
  let checking = false;
  // Out of sight: the app switcher keeps a picture of the screen, so the codes are not on it.
  let away = false;
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  // Just created: the batch's "sent" note is not shown again by Back.
  const toBatches = () => app.go('airdropBatches', {}, { replace: Boolean(p.justCreated) });
  const isV3 = () => batch && batch.contractId === V3_CID;
  const n = () => batch.codes.length;

  function summaryLine() {
    const same = batch.codes.every((c) => c.value === batch.codes[0].value);
    // Not all the same: two codes or more, so English always says "codes".
    const text = same
      ? tn({ one: '{n} code · {amount} each', other: '{n} codes · {amount} each' }, n(), { amount: amountText(batch.assetId, BigInt(batch.codes[0].value)) })
      : tn({ one: '{n} code · {amount} in total', other: '{n} codes · {amount} in total' }, n(), { amount: amountText(batch.assetId, batchTotal(batch)) });
    return h('p', { class: 'lead', 'data-testid': 'codes-summary', text });
  }

  /** New codes for the same airdrop: same asset, amount per code, count and prepaid fee. */
  function makeNew() {
    const same = batch.codes.every((c) => c.value === batch.codes[0].value);
    app.go('airdropCreate', { again: { assetId: batch.assetId, value: same ? batch.codes[0].value : null, count: n(), gas: BigInt(batch.gasPerVoucher || '0') > 0n } });
  }

  function steps() {
    const mark = { done: 'check', active: 'clock', waiting: null, failed: 'close' };
    const st = v3 ? v3.state : 'waiting';
    // An error is shown at the step it happened in: confirming, or checking the codes.
    const failedAt = st === 'error' ? (v3.was && v3.was.state === 'checking' ? 2 : 1) : null;
    const at = st === 'error' ? v3.was || {} : v3 || {};
    const confirmed = st === 'checking' || failedAt === 2;
    const c = at.confirmations;
    const rows = [
      { mark: 'done', label: t('Batch sent') },
      { mark: confirmed ? 'done' : failedAt === 1 ? 'failed' : 'active', label: t('Confirmed by the network'), note: confirmed ? null : c == null ? t('waiting') : t('{n} of {total}', { n: Math.min(c, CONFIRMATIONS_BEFORE_CHECK), total: CONFIRMATIONS_BEFORE_CHECK }) },
      { mark: failedAt === 2 ? 'failed' : confirmed ? 'active' : 'waiting', label: t('Every code checked'), note: confirmed && at.total ? t('{n} of {total}', { n: at.done || 0, total: at.total }) : null },
    ];
    return h(
      'div',
      { class: 'card steps', 'data-testid': 'codes-steps', 'data-state': st },
      ...rows.map((r, i) => h('div', { class: `step-row ${r.mark}`, 'data-testid': `codes-step-${i}`, 'data-mark': r.mark }, h('span', { class: 'step-mark' }, mark[r.mark] ? icon(mark[r.mark]) : null), h('span', { class: 'grow', text: r.label }), r.note ? h('span', { class: 'small', text: r.note }) : null)),
    );
  }

  /** A v3 batch that is not ready to share: what it waits for, or what went wrong and what to do. */
  function renderV3NotReady() {
    const st = v3 ? v3.state : 'waiting';
    if (st === 'failed') {
      const why = CHECK_PROBLEM_TEXT[v3.problem] ? t(CHECK_PROBLEM_TEXT[v3.problem]) : t('A code did not check out.');
      const safe = v3.mined ? t('Your funds are safe: take this batch back in My batches to get them back, and make new codes.') : t('Your funds are safe: nothing more was locked, and make new codes.');
      const el = notice('error', h('strong', { text: `${t('Do not share these codes.')} ` }), `${why} ${t('Someone may have copied this batch while it was on its way, so the codes could point to empty vouchers.')} ${safe}`);
      el.dataset.testid = 'codes-check-failed';
      put(body, summaryLine(), el);
      put(actions, primary(t('Make new codes'), makeNew, { 'data-testid': 'codes-make-new' }), v3.mined ? secondary(t('Take the batch back'), toBatches, { 'data-testid': 'codes-take-back' }) : h('button', { class: 'btn btn-text', onclick: toBatches }, t('My batches')));
      return;
    }
    if (st === 'notSent') {
      const el = notice('info', h('strong', { text: `${t('This batch did not go through.')} ` }), v3.onChain ? t('The network turned it down, so nothing was locked and these codes hold nothing. Do not use them: make new codes.') : t('It was never sent, so nothing was locked and these codes hold nothing. They stay saved here anyway.'));
      el.dataset.testid = 'codes-not-sent';
      put(body, summaryLine(), el);
      put(actions, primary(t('Make new codes'), makeNew, { 'data-testid': 'codes-make-new' }), h('button', { class: 'btn btn-text', onclick: toBatches }, t('My batches')));
      return;
    }
    const parts = [
      p.justCreated ? notice('success', h('strong', { text: `${t('Batch sent.')} ` }), t('Wait a few minutes before sharing the codes.')) : null,
      summaryLine(),
      steps(),
      h('p', { class: 'small', 'data-testid': 'codes-wait-why' }, t('Before you share them, BEAM Campfire makes sure every code points to the batch you made, so nobody can swap them for empty ones. The codes appear here once that is done. You can leave this screen and come back.')),
    ];
    if (st === 'error') {
      const el = notice('error', `${t('The codes could not be checked: {reason} They are saved on this device.', { reason: v3.error.message })} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'codes-check-again', onclick: () => runCheck() }, t('Check again')));
      el.dataset.testid = 'codes-check-error';
      parts.push(el);
    }
    put(body, ...parts);
    put(actions, h('button', { class: 'btn btn-text', onclick: toBatches }, t('My batches')));
  }

  function render() {
    if (!alive) return;
    if (away) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'codes-away' }, icon('lock'), h('p', { class: 'small', text: t('Codes hidden while BEAM Campfire is in the background.') })));
      put(actions);
      return;
    }
    if (error) {
      put(body, notice('error', `${t('The saved codes could not be opened: {reason} They stay saved on this device.', { reason: error.message })} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: load }, t('Try again'))));
      put(actions, secondary(t('My batches'), toBatches));
      return;
    }
    if (!batch) {
      put(body, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: t('Opening your saved codes…') })));
      return;
    }
    if (isV3() && (!v3 || v3.state !== 'ready')) return renderV3NotReady();
    // A v3 batch shows its codes as the network has them now (verifyBatch): only the ones still claimable are
    // offered for sharing; once none is left, nothing is (release audit 0.2.16).
    const open = isV3() ? batch.codes.filter((c) => c.status !== CODE_STATUS.claimed && c.status !== CODE_STATUS.takenBack) : batch.codes;
    const all = open.map((c) => c.code).join('\n');
    const allCopied = tn({ one: '{n} code copied', other: '{n} codes copied' }, open.length);
    const codeCopied = t('Code copied');
    const copyAll = open.length ? primary(tn({ one: 'Copy all {n} code', other: 'Copy all {n} codes' }, open.length), () => copySecret(all, allCopied, { app }), { 'data-testid': 'codes-copy-all' }) : null;
    const gasPaid = BigInt(batch.gasPerVoucher || '0') > 0n;
    const readyText = open.length === batch.codes.length
      ? (gasPaid ? t('Every code is on the network in your batch, with its claim fee paid.') : t('Every code is on the network in your batch.'))
      : gasPaid
        ? tn({ one: '{n} code is still on the network in your batch, with its claim fee paid.', other: '{n} codes are still on the network in your batch, with their claim fees paid.' }, open.length)
        : tn({ one: '{n} code is still on the network in your batch.', other: '{n} codes are still on the network in your batch.' }, open.length);
    const ready = !isV3()
      ? null
      : open.length
        ? notice('success', h('strong', { text: asSentence(t('Ready to share.')) }), readyText)
        : notice('info', h('strong', { text: asSentence(t('Nothing left to share.')) }), t('Every code of this batch was claimed or taken back.'));
    const note = STORAGE_TEXT.codesNote[evictionRisk(app)];
    if (ready) ready.dataset.testid = 'codes-ready';
    put(
      body,
      ready ||
        (p.justCreated
          ? notice('success', h('strong', { text: `${t('Batch sent.')} ` }), t('The codes start working once the network confirms it, usually within 2 minutes.'))
          : batch.txStatus === TX_STATUS.broadcast || batch.txStatus === TX_STATUS.unconfirmed
            ? notice('info', t('This batch is waiting for the network. The codes start working once it is confirmed.'))
            : batch.txStatus === TX_STATUS.failed
              ? notice('info', t('This batch was never sent, so these codes hold nothing. They stay saved here anyway.'))
              : null),
      summaryLine(),
      batch.txStatus === TX_STATUS.failed
        ? null
        : notice(
            'warn',
            h('strong', { text: `${t('These codes are the only key to the locked funds.')} ` }),
            // The storage note is its own sentence, after a space (its key may still start with that space).
            `${t('Anyone who has a code can claim it, so send each one only to its person. They are kept only on this device, in this wallet: copy them or save the file somewhere safe.')}${note ? ` ${t(note)}` : ''}`,
          ),
      // Copying is the job: the button sits above the list, however long it is.
      open.length ? h('div', { class: 'btn-row' }, copyAll, typeof navigator.share === 'function' ? secondary(t('Share'), () => navigator.share({ text: all }).catch(() => {}), { 'data-testid': 'codes-share' }) : null) : null,
      h('button', { class: 'btn btn-text link-left', type: 'button', 'data-testid': 'codes-csv', onclick: () => saveCsv(batch) }, icon('download'), t('Save as CSV file')),
      h(
        'div',
        { class: 'card list codes-list', 'data-testid': 'codes-list' },
        ...batch.codes.map((c, i) =>
          h(
            'div',
            { class: 'row asset-row code-row' },
            h('span', { class: 'code-n', text: String(i + 1) }),
            h('span', { class: 'main' }, h('div', { class: 't mono code-text', 'data-testid': 'code', text: c.code }), STATUS_TEXT[c.status] ? h('div', { class: 's', text: t(STATUS_TEXT[c.status]) }) : null),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Copy code {n}', { n: i + 1 }), onclick: () => copySecret(c.code, codeCopied, { app }) }, icon('copy')),
          ),
        ),
      ),
    );
    put(actions, h('button', { class: 'btn btn-text', onclick: toBatches }, t('My batches')));
  }

  /** The codes as the desktop's CSV, to the share sheet (iPhone: Save to Files) or a download. Made on the tap, kept nowhere. */
  async function saveCsv(b) {
    try {
      const file = csvFile(b, { formatValue: (v) => formatAmount(v), assetLabel: wallet.label(b.assetId).unit });
      const how = await deliverExport(file, { title: t('Airdrop codes') });
      if (how === 'cancelled') return;
      toast(how === 'shared' ? t('Shared {file}. Anyone who opens it can claim the codes: keep it private.', { file: file.name }) : t('Saved {file}. Anyone who opens it can claim the codes: keep it private.', { file: file.name }), 6000);
    } catch {
      toast(t("Couldn't save the file. Try Copy all codes instead."));
    }
  }

  /** Where a v3 batch stands; waits and asks again while the network has not confirmed it enough. */
  async function runCheck() {
    clearTimeout(waitTimer);
    if (!alive || !isV3() || checking) return;
    checking = true;
    if (v3 && v3.state === 'error') {
      v3 = { state: 'waiting', confirmations: null };
      render();
    }
    try {
      const r = await airdrop(app).verifyBatch(batch.localId, {
        onProgress: (done, total) => {
          if (!alive) return;
          v3 = { state: 'checking', done, total };
          render();
        },
      });
      if (!alive) return;
      batch = r.batch;
      v3 = { state: r.state, confirmations: r.confirmations, problem: r.problem, mined: r.mined != null ? r.mined : r.batch.txStatus === TX_STATUS.confirmed, onChain: r.onChain };
    } catch (e) {
      if (!alive) return;
      v3 = { state: 'error', error: e, was: v3 };
    }
    checking = false;
    render();
    if (alive && v3.state === 'waiting') waitTimer = setTimeout(runCheck, WAIT_MS);
  }

  async function load() {
    error = null;
    render();
    try {
      const list = await airdrop(app).savedBatches();
      batch = list.find((b) => b.localId === p.localId) || null;
      if (!batch) error = new Error(t('This batch is not among the codes saved on this device.'));
    } catch (e) {
      error = e;
    }
    render();
    if (batch && isV3()) runCheck();
  }

  const offHidden = onHidden(() => {
    away = true;
    render();
  });
  // Back in sight with the wallet still open: shown again from memory, nothing asked again.
  const offShown = onShown(() => {
    if (!away || !app.dbPass) return;
    away = false;
    render();
  });

  load();
  const el = screen({ title: p.justCreated ? t('Your airdrop codes') : t('Airdrop codes'), back: () => app.back(p.justCreated ? 'airdrop' : 'airdropBatches'), cls: 'airdrop-codes feature' }, body);
  el.appendChild(actions);
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(waitTimer);
      offHidden();
      offShown();
    },
  };
}
