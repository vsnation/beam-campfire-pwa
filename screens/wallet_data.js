/* Move names, notes and history (a card on Settings -> Backup, issue #55)
 * Spec: ONE job: carry what the 12 words do not bring back (address names, payment notes, contacts,
 *       payment history) to another wallet of the same 12 words, as BEAM's desktop wallet does.
 *       Primary CTA: none on the card (Backup's primary is "Export wallet.db"); two outcome buttons,
 *       "Save wallet data" and "Bring in wallet data". In each sheet one primary: "Save the file" /
 *       "Bring it in".
 *       Taps from app open: Settings -> Backup (2) -> Save wallet data (3) -> password or Face ID ->
 *       Save the file (4). Bring in: Backup (2) -> Bring in wallet data (3) -> pick the file ->
 *       Bring it in (4).
 * Exit-intent reasons and answers:
 *   - "Is this my backup?" -> the first line says what the words do and do not bring back; the
 *     file holds no keys, so it is never the backup.
 *   - "Who can see this?" -> said on the card and again before saving: whoever gets the file sees
 *     every payment, amount, note and address; nobody can spend with it. Identity first.
 *   - "Will it mess up my wallet?" -> before bringing in, what the file holds and that nothing
 *     already here is changed; twice adds nothing; a file of other 12 words adds nothing and says so.
 *   - "Which file?" -> the problems name it: the file from "Save wallet data" (BEAM's desktop wallet
 *     calls it export….dat).
 *   - "Too big to save" -> said before anything stops, with the way that works: Export wallet.db.
 *   - "Did it work?" -> the counts that came in, and a way to see the payments.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, openSheet, toast, progressBar } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { isImported } from '../lib/session.js';
import { deliverExport } from '../lib/export.js';
import { formatFileSize } from '../lib/wallet_file.js';
import { DATA_TEXT as T, summaryRows, addedText, bookSkippedText, unfinishedText, planEmpty } from '../lib/wallet_data.js';
import { prepareDataExport, previewImport, runImport } from '../lib/wallet_data_io.js';
import { t } from '../lib/i18n.js';

const INPUT_ID = 'wallet-data-file-input';
// The import sheet on screen: a file picked from it replaces it (it stays while the picker is open,
// so cancelling the picker leaves the person where they were).
let openImport = null;

const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
// Buttons stay at the bottom of a sheet, in view on a small phone however long the sheet is.
const actions = (...b) => h('div', { class: 'sheet-actions' }, ...b);
const rowsCard = (counts, testid) => h('div', { class: 'card', 'data-testid': testid }, ...summaryRows(counts).map(([k, v]) => kv(k, v)));

/** A button that opens the file picker in the same tap (iOS opens it only for a direct tap). */
function chooseButton(cls, label, testid) {
  const b = h('label', { class: `btn ${cls}`, for: INPUT_ID, role: 'button', tabindex: '0', 'data-testid': testid }, icon('file'), h('span', { text: label }));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.getElementById(INPUT_ID)?.click();
    }
  });
  return b;
}

/** The card on Settings -> Backup. */
export function walletDataCard(app) {
  // No `accept` attribute: iOS greys out every file whose type it does not know (".dat" has none).
  // The file is checked after it is picked instead.
  const input = h('input', { type: 'file', id: INPUT_ID, class: 'file-input', tabindex: '-1', 'aria-hidden': 'true', 'data-testid': 'data-file' });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = ''; // the same file again still counts as a pick
    if (f) importSheet(app, f);
  });
  return h(
    'div',
    { class: 'card', 'data-testid': 'data-card' },
    h('h3', { text: t(T.title) }),
    h('p', { 'data-testid': 'data-lead', text: isImported(app) ? t(T.leadImported) : t(T.lead) }),
    h('p', { class: 'small', 'data-testid': 'data-reveals', text: t(T.reveals) }),
    h('button', { class: 'btn btn-secondary card-btn', onclick: () => exportFlow(app), 'data-testid': 'data-save' }, icon('download'), t(T.saveCta)),
    chooseButton('btn-secondary card-btn', t(T.importCta), 'data-import'),
    input,
  );
}

/** Save wallet data: who is asking -> make the file -> a fresh tap hands it out. */
async function exportFlow(app) {
  if (!(await confirmIdentity(app, { title: t(T.confirmTitle), detail: t(T.reveals), cta: t(T.confirmCta) }))) return;
  let st = { step: 'busy' };
  const sheet = openSheet((close) => {
    if (st.step === 'busy')
      return [h('h2', { text: t(T.confirmTitle) }), h('p', { class: 'small', 'data-testid': 'data-busy', text: t(T.preparing) }), progressBar(null)];
    if (st.step === 'error')
      return [
        h('h2', { text: st.code === 'too_big' ? t('Too much history for one file here') : t('The file could not be made') }),
        h('div', { 'data-testid': 'data-export-problem' }, notice(st.code === 'too_big' ? 'info' : 'error', st.message)),
        actions(h('button', { class: 'btn btn-primary', onclick: () => close() }, t('Done'))),
      ];
    const { file, summary, left } = st;
    return [
      h('h2', { text: t(T.readyTitle) }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'data-name', text: file.name }), h('div', { class: 's', 'data-testid': 'data-what', text: `${formatFileSize(file.size)} · ${addedText(summary)}` }))),
      notice('warn', t(T.keepPrivate)),
      ...left.map((line) => h('p', { class: 'small', text: line })),
      h('p', { class: 'small', text: t(T.opensIn) }),
      actions(
        h(
          'button',
          {
            class: 'btn btn-primary',
            'data-testid': 'data-save-file',
            onclick: async () => {
              const how = await deliverExport(file, { title: t('BEAM wallet data') });
              if (how === 'cancelled') return;
              toast(how === 'shared' ? t('Wallet data shared') : t('Wallet data saved to your downloads'));
              close();
            },
          },
          icon('download'),
          t(T.saveFile),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, t('Done')),
      ),
    ];
  }, { label: t(T.confirmTitle) });
  try {
    st = { step: 'ready', ...(await prepareDataExport(app)) };
  } catch (e) {
    st = { step: 'error', code: e.code, message: e.message || t('The wallet data could not be read. Try again.') };
  }
  if (!sheet.closed) sheet.rerender();
}

/** Bring in wallet data: read and plan -> what it holds -> bring it in -> what came in. */
function importSheet(app, file) {
  if (openImport && !openImport.closed) openImport.close();
  let st = { step: 'reading' };
  let sheet = null;
  const show = (next) => {
    st = next;
    if (sheet && !sheet.closed) sheet.rerender();
  };
  const start = async () => {
    const p = st.preview;
    show({ step: 'importing', preview: p, progress: null });
    let r;
    try {
      r = await runImport(app, p, { onProgress: (progress) => show({ step: 'importing', preview: p, progress }) });
    } catch (e) {
      r = { added: { own: 0, contacts: 0, txs: 0, book: 0, people: 0, hiddenTokens: 0 }, refused: { own: 0, contacts: 0, txs: 0 }, otherWallet: false, stopped: e.message };
    }
    show({ step: 'done', preview: p, result: r });
    if (sheet.closed) toast(r.otherWallet ? t('Nothing was added: that file is from another wallet.') : t('Added {list}.', { list: addedText(r.added) }), 5000);
  };
  sheet = openSheet((close) => {
    const other = () => chooseButton('btn-secondary', t(T.chooseOther), 'data-choose-other');
    const cancel = (label = t('Cancel')) => h('button', { class: 'btn btn-text', onclick: () => close(), 'data-testid': 'data-close' }, label);
    if (st.step === 'reading') return [h('h2', { text: t(T.importCta) }), h('p', { class: 'small', text: t(T.reading) }), progressBar(null)];
    if (st.step === 'problem')
      return [h('h2', { text: t('This file can’t be brought in') }), h('div', { 'data-testid': 'data-problem' }, notice('warn', st.message)), actions(chooseButton('btn-primary', t(T.chooseOther), 'data-choose-other'), cancel())];
    const p = st.preview;
    const fileLine = h('p', { class: 'small', 'data-testid': 'data-file-line', text: `${p.name} · ${formatFileSize(p.size)}` });
    if (st.step === 'preview') {
      const empty = planEmpty(p.plan);
      const skipped = bookSkippedText(p.plan.book.skipped);
      return [
        h('h2', { text: empty ? t('Already in this wallet') : t(T.previewTitle) }),
        fileLine,
        rowsCard(p.summary, 'data-summary'),
        empty
          ? h('div', { 'data-testid': 'data-all-here' }, notice('info', p.plan.unfinished ? t('Everything else in this file is already in this wallet.') : t(T.allHere)))
          : h('p', { 'data-testid': 'data-new', text: `${t('New here: {list}.', { list: addedText(p.plan.counts) })} ${t(T.nothingChanged)}` }),
        p.bookBlocked ? h('p', { class: 'small', text: t('Your address book could not be opened here, so contacts from the file are left out.') }) : null,
        skipped ? h('p', { class: 'small', 'data-testid': 'data-book-skipped', text: skipped }) : null,
        unfinishedText(p.plan.unfinished) ? h('p', { class: 'small', 'data-testid': 'data-unfinished', text: unfinishedText(p.plan.unfinished) }) : null,
        actions(
          empty
            ? h('button', { class: 'btn btn-primary', onclick: () => close(), 'data-testid': 'data-done' }, t('Done'))
            : h('button', { class: 'btn btn-primary', onclick: start, 'data-testid': 'data-bring' }, icon('download'), t(T.bringIn)),
          other(),
          empty ? null : cancel(),
        ),
      ];
    }
    if (st.step === 'importing') {
      const pr = st.progress;
      const what = pr && pr.step === 'txs' ? t('Payments: {done} of {total}', { done: pr.done.toLocaleString('en-US'), total: pr.total.toLocaleString('en-US') }) : pr && pr.step === 'book' ? t('Contacts…') : t('Addresses…');
      return [h('h2', { text: t(T.bringing) }), fileLine, h('p', { class: 'small', 'data-testid': 'data-progress', text: what }), progressBar(pr && pr.total ? pr.done / pr.total : null)];
    }
    // done
    const r = st.result;
    if (r.otherWallet)
      return [h('h2', { 'data-testid': 'data-result-title', text: t(T.otherWalletTitle) }), fileLine, h('div', { 'data-testid': 'data-other-wallet' }, notice('error', t(T.otherWallet))), actions(chooseButton('btn-primary', t(T.chooseOther), 'data-choose-other'), cancel(t('Done')))];
    const refusedAll = r.refused.own + r.refused.contacts + r.refused.txs;
    const any = Object.values(r.added).some(Boolean);
    const part = refusedAll > 0 || Boolean(r.stopped);
    return [
      h('h2', { 'data-testid': 'data-result-title', text: part ? (any ? t(T.partTitle) : t('Nothing came in')) : t(T.doneTitle) }),
      fileLine,
      h('div', { 'data-testid': 'data-result' }, notice(any ? 'success' : 'warn', any ? `${t('Added {list}.', { list: addedText(r.added) })} ${t(T.nothingChanged)}` : t('Nothing was added.'))),
      refusedAll ? h('div', { 'data-testid': 'data-refused' }, notice('warn', t('BEAM did not take {list}: they belong to another wallet or are damaged. The rest is in.', { list: addedText({ own: r.refused.own, people: r.refused.contacts, txs: r.refused.txs }) }))) : null,
      r.stopped ? h('div', { 'data-testid': 'data-stopped' }, notice('warn', t('It stopped part way: {reason}. Bring the same file in again; what is already here is skipped.', { reason: r.stopped.replace(/\.$/, '') }))) : null,
      actions(
        r.added.txs
          ? h('button', { class: 'btn btn-primary', onclick: () => { close(); app.go('activity'); }, 'data-testid': 'data-see-activity' }, t(T.seeActivity))
          : h('button', { class: 'btn btn-primary', onclick: () => close(), 'data-testid': 'data-done' }, t('Done')),
        r.added.txs ? cancel(t('Done')) : null,
      ),
    ];
  }, { label: t(T.importCta) });
  openImport = sheet;
  previewImport(app, file).then(
    (preview) => show({ step: 'preview', preview }),
    (e) => show({ step: 'problem', message: e.message || t('This file could not be read. Choose it again.') }),
  );
}
