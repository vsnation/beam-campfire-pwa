/* Import a wallet.db
 * Spec: ONE job: bring a BEAM wallet you already have as a wallet.db file (and its password)
 *       onto this device, with no recovery phrase needed.
 *       Primary CTA: "Choose wallet.db"; once a file is chosen, "Import my wallet".
 *       Taps from app open: Welcome -> Import (1) -> Choose wallet.db (2) -> pick it in Files
 *       -> password -> Import my wallet (3). Then Face ID (or skip) and Connect, like any new wallet.
 * Exit-intent reasons and answers:
 *   - "Will this change or break my original file?" -> first line: BEAM Campfire makes its own copy;
 *     your file is not changed.
 *   - "Does my file go to a server?" -> it is read on this device only; nothing is uploaded (the
 *     line under the button says the file stays here).
 *   - "Which password?" -> the field says: the one set in the BEAM wallet the file comes from.
 *   - "How do I get wallet.db onto my phone?" -> said under the button: AirDrop, iCloud Drive, Files.
 *   - "What if I lose it later?" -> said before importing: no 12 words here; the original file and
 *     its password are the backup.
 *   - "The copy is old" -> said once, before choosing: copy it with the other app closed; a newer
 *     copy fixes payments that fail because coins were spent elsewhere.
 *   - "It failed" -> each problem says what to do next and never blames; on any failure nothing
 *     is added to this device.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { stageImport, checkImportPassword, discardImport } from '../lib/engine.js';
import { prepareImport, importWallet } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { checkWalletFile, importPasswordProblem, formatFileSize, IMPORT_TEXT, IMPORT_PROBLEM } from '../lib/wallet_file.js';

const INPUT_ID = 'import-file-input';

export default function importWalletScreen(app) {
  if (app.record) {
    queueMicrotask(() => app.go('unlock'));
    return { el: h('div') };
  }
  let file = null; // the File chosen
  let staged = null; // the File whose bytes the engine holds as import.db
  let plain = false;
  let busy = false;
  let destroyed = false;

  // No `accept` attribute: iOS greys out every file whose type it does not know, and ".db" has no
  // registered type there. The file is checked after it is picked instead.
  const input = h('input', { type: 'file', id: INPUT_ID, class: 'file-input', 'data-testid': 'import-file', tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = ''; // picking the same file again still counts as a pick
    if (f) picked(f);
  });

  const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'import-msg' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': IMPORT_TEXT.passwordLabel, 'data-testid': 'import-pw' });
  const showBtn = h('button', { class: 'btn btn-text btn-small inside', type: 'button', 'aria-label': 'Show password' }, icon('eye'));
  showBtn.addEventListener('click', () => {
    pw.type = pw.type === 'password' ? 'text' : 'password';
    showBtn.setAttribute('aria-label', pw.type === 'password' ? 'Show password' : 'Hide password');
  });
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  pw.addEventListener('input', () => {
    if (!busy) cta.disabled = !pw.value;
  });

  const cta = primary(IMPORT_TEXT.cta, () => submit(), { disabled: true, 'data-testid': 'import-submit' });
  const chooseBtn = h('label', { class: 'btn btn-primary', for: INPUT_ID, role: 'button', tabindex: '0', 'data-testid': 'import-choose' }, icon('file'), h('span', { text: IMPORT_TEXT.choose }));
  const changeBtn = h('label', { class: 'btn btn-text btn-small', for: INPUT_ID, role: 'button', tabindex: '0', 'aria-label': IMPORT_TEXT.change, 'data-testid': 'import-change', text: 'Change' });
  for (const b of [chooseBtn, changeBtn]) b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()));

  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  const el = screen({ title: IMPORT_TEXT.title, back: () => app.go('welcome') });
  // screen() made an empty .content; this screen re-renders its own body and actions.
  el.querySelector('.content').replaceWith(body);
  el.appendChild(actions);
  el.appendChild(input);

  function render() {
    if (destroyed) return;
    if (!file) {
      put(body,
        h('p', { class: 'lead', text: IMPORT_TEXT.intro }),
        notice('warn', IMPORT_TEXT.copyWarning),
        msg,
      );
      put(actions, chooseBtn, h('p', { class: 'small', text: IMPORT_TEXT.where }));
      return;
    }
    // Once a file is chosen the screen is about the password: the file, the field, what went wrong
    // (right under the field), the backup warning, and the button - all above the fold at 375 x 667.
    put(body,
      h('div', { class: 'card file-card' },
        h('span', { class: 'ico' }, icon('file')),
        h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'import-file-name', text: file.name || 'wallet.db' }), h('div', { class: 's', text: `${formatFileSize(file.size)} · ${IMPORT_TEXT.untouched}` })),
        changeBtn,
      ),
      h('label', { class: 'field' }, IMPORT_TEXT.passwordLabel, h('div', { class: 'input-wrap' }, pw, showBtn)),
      h('p', { class: 'hint', text: IMPORT_TEXT.passwordHelper }),
      msg,
      notice('warn', IMPORT_TEXT.noPhrase),
    );
    put(actions, cta);
  }

  function problem(text, kind = 'error') {
    put(msg, h('div', { 'data-testid': 'import-problem' }, notice(kind, text)));
  }

  function setBusy(text) {
    busy = Boolean(text);
    cta.disabled = busy || !pw.value;
    cta.textContent = text || IMPORT_TEXT.cta;
    changeBtn.classList.toggle('disabled', busy);
    if (text) put(msg, h('p', { class: 'small', 'aria-live': 'polite', text }));
  }

  async function forgetStaged() {
    if (!staged) return;
    staged = null;
    await discardImport().catch(() => {});
  }

  async function picked(f) {
    if (busy) return;
    put(msg);
    let head = null;
    try {
      head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
    } catch {
      /* checked again when the whole file is read */
    }
    const c = checkWalletFile({ size: f.size, head });
    if (staged && staged !== f) await forgetStaged();
    if (!c.ok) {
      file = null;
      render();
      problem(c.problem, c.code === 'notDatabase' || c.code === 'tooBig' ? 'warn' : 'error');
      return;
    }
    file = f;
    plain = c.plainSqlite;
    pw.value = '';
    cta.disabled = true;
    render();
    setTimeout(() => pw.focus(), 50);
  }

  async function submit() {
    if (busy || !file) return;
    const p = importPasswordProblem(pw.value);
    if (p) return problem(p, 'warn');
    const password = pw.value;
    try {
      if (staged !== file) {
        setBusy(IMPORT_TEXT.reading);
        await prepareImport(app);
        let bytes;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
        } catch {
          throw Object.assign(new Error('read'), { code: 'gone' });
        }
        const c = checkWalletFile({ size: bytes.length, head: bytes.subarray(0, 16) });
        if (!c.ok) throw Object.assign(new Error('file'), { code: 'file', problem: c.problem });
        await stageImport(bytes); // the engine owns the bytes now
        bytes = null;
        staged = file;
        if (destroyed) return void (await forgetStaged());
      }
      setBusy(IMPORT_TEXT.checking);
      const ok = await checkImportPassword(password);
      if (destroyed) return;
      if (!ok) {
        setBusy(null);
        problem(plain ? `${IMPORT_PROBLEM.wrongPassword} This file is an ordinary database, and BEAM wallets are encrypted.` : IMPORT_PROBLEM.wrongPassword);
        pw.select();
        return;
      }
      setBusy(IMPORT_TEXT.saving);
      await importWallet(app, password);
      staged = null;
      pw.value = '';
      if (destroyed) return;
      if (await passkeyAvailable()) app.go('passkeySetup', { first: true }, { reset: true });
      else app.go(app.prefs.ipAck ? 'fastStart' : 'ipNotice', { first: true }, { reset: true });
    } catch (e) {
      if (destroyed) return;
      setBusy(null);
      const code = e && e.code;
      if (code !== 'exists') await forgetStaged();
      // Fixed texts only: nothing from the file or the engine, and never the password.
      problem(code === 'exists' ? IMPORT_PROBLEM.exists : code === 'gone' ? IMPORT_PROBLEM.gone : code === 'file' ? e.problem : code === 'timeout' ? IMPORT_PROBLEM.slow : IMPORT_PROBLEM.failed);
    }
  }

  render();
  return {
    el,
    destroy() {
      destroyed = true;
      pw.value = '';
      // Leaving before the wallet was added: the staged copy goes too.
      if (staged && !app.record) discardImport().catch(() => {});
    },
  };
}
