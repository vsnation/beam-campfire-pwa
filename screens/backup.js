/* Backup words (create, step 1 of 3) / Backup (Settings, for the wallet on this device)
 * Spec (create): ONE job: write down the 12 words.
 *       Primary CTA: "I wrote them down" (enabled after the words are shown).
 *       Taps from app open: 1 (Welcome -> Create).
 * Spec (Settings -> Backup): ONE job: say what brings this wallet back, and hand out a copy.
 *       Primary CTA: "Export wallet.db" (every wallet type): a file that opens with the BEAM Campfire
 *       password in BEAM Campfire desktop, BEAM's desktop wallet, LightWallet or the CLI - the way
 *       out that needs neither the web address nor the 12 words.
 *       Taps from app open: 2 (Settings -> Backup), 4 to a saved file (Export, password, Save).
 *       Words are never stored, so they are never shown again; an imported wallet has none and
 *       is told so (its wallet.db file and password are its backup). With a wallet on the device
 *       this screen never makes new words.
 * Exit-intent reasons and answers:
 *   - "Why do I need this?" -> one sentence: the words are the wallet; they bring it back on any device.
 *   - "Someone could see my screen" -> words stay blurred until tapped.
 *   - "Can I screenshot it?" -> we say no, and why (photos sync to the cloud).
 *   - "Where are my 12 words?" (imported) -> there are none here; the file and its password are the backup.
 *   - "What if this website disappears?" -> Export wallet.db: the file and the password open the wallet
 *     anywhere BEAM runs. Said plainly: file + password = the wallet, keep it private.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, toast } from '../lib/ui.js';
import { generatePhrase } from '../lib/engine.js';
import { isImported, openWithPasswordFor, markExported } from '../lib/session.js';
import { prepareExport, deliverExport } from '../lib/export.js';
import { NO_PHRASE_NOTICE, formatFileSize } from '../lib/wallet_file.js';

/**
 * Recovery words in a grid that stays blurred until tapped (no shoulder
 * surfing). fill(words) puts them in; onReveal runs once they are shown.
 * Also used for the Ethereum wallet's words (screens/eth_words.js).
 */
export function wordReveal(onReveal) {
  const grid = h('div', { class: 'words hidden-words', 'data-testid': 'words' });
  const cover = h('div', { class: 'cover' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'reveal' }, icon('eye'), 'Tap to show the words'));
  cover.querySelector('button').addEventListener('click', () => {
    grid.classList.remove('hidden-words');
    cover.remove();
    onReveal();
  });
  return {
    el: h('div', { class: 'reveal' }, grid, cover),
    fill: (words) => put(grid, ...words.map((w, i) => h('div', { class: 'word' }, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: w })))),
  };
}

export default function backup(app) {
  // A wallet already lives on this device: never make new words here.
  if (app.record) return existingBackup(app);
  const cta = primary('I wrote them down', () => app.go('confirmWords'), { disabled: true, 'data-testid': 'wrote-down' });
  const reveal = wordReveal(() => (cta.disabled = false));
  const status = h('p', { class: 'small', text: 'Making your words…' });

  (async () => {
    try {
      if (!app.setup || app.setup.mode !== 'create') app.setup = { mode: 'create' };
      if (!app.setup.words) app.setup.words = await generatePhrase();
      reveal.fill(app.setup.words);
      status.textContent = '';
    } catch (e) {
      status.textContent = `The wallet engine did not start: ${e.message}. Reload the page to try again.`;
    }
  })();

  const el = screen(
    {
      title: 'Your 12 words',
      back: () => {
        app.setup = null;
        app.go('welcome');
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: 'Step 1 of 3' }),
    h('p', { class: 'lead', text: 'These words are your wallet. With them you can open it on any device, even if this phone is lost.' }),
    notice('warn', h('strong', { text: 'Write them on paper, in order. ' }), 'Anyone who sees them can take your money. No screenshots: photos sync to the cloud.'),
    reveal.el,
    status,
  );
  return { el };
}

/** Settings -> Backup: what brings the wallet on this device back. Shows no words, ever. */
function existingBackup(app) {
  if (!app.dbPass) {
    queueMicrotask(() => app.go('unlock'));
    return { el: h('div') };
  }
  const imported = isImported(app);
  const exportCard = h(
    'div',
    { class: 'card', 'data-testid': 'export-card' },
    h('h3', { text: 'Export wallet.db' }),
    h('p', { text: "A copy of this wallet as a file that opens with your BEAM Campfire password in BEAM Campfire desktop, BEAM's desktop wallet, Light Wallet or the BEAM CLI. It keeps working if this app's web address ever disappears." }),
    h('p', { class: 'small', 'data-testid': 'export-last', text: app.record.exportedAt ? `Last exported ${new Date(app.record.exportedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'Not exported yet.' }),
  );
  const el = screen(
    { title: 'Backup', back: () => app.go('settings'), actions: [primary('Export wallet.db', () => exportSheet(app), { 'data-testid': 'export-start' })] },
    imported
      ? [
          h('div', { 'data-testid': 'no-recovery-phrase' }, notice('warn', NO_PHRASE_NOTICE)),
          h(
            'div',
            { class: 'card' },
            h('h3', { text: 'Keep both, somewhere other than this phone' }),
            h(
              'ol',
              { class: 'steps-list' },
              h('li', { text: 'The original wallet.db file, or one exported below.' }),
              h('li', { text: 'Its password: the original file opens with the password it had when you imported it; an exported copy opens with your BEAM Campfire password.' }),
            ),
          ),
        ]
      : [
          h('div', { 'data-testid': 'phrase-backup' }, notice('info', h('strong', { text: 'Your 12 words are this wallet\'s backup. ' }), 'With them you can restore it on any device.')),
          h('p', { class: 'small', text: 'BEAM Campfire does not keep a copy of the words, so it cannot show them again. Keep your paper safe and private.' }),
        ],
    exportCard,
    notice('warn', h('strong', { text: 'The file and your password are your wallet. ' }), 'Anyone who has both can take your money. Keep the file somewhere private.'),
  );
  return { el };
}

/** Password (it also becomes the file's password) -> prepare -> a fresh tap to save it. */
function exportSheet(app) {
  let file = null;
  let busy = false;
  let message = null;
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'BEAM Campfire password', placeholder: 'Password', 'data-testid': 'export-pw' });
  openSheet((close, rerender) => {
    const prepare = async () => {
      if (busy) return;
      if (!pw.value) {
        message = notice('warn', 'Enter your BEAM Campfire password.');
        return rerender();
      }
      busy = true;
      message = h('p', { class: 'small', 'data-testid': 'export-busy', text: 'Preparing the file… (the wallet pauses for a moment)' });
      rerender();
      try {
        await openWithPasswordFor(app, pw.value);
      } catch (e) {
        busy = false;
        message = notice('error', e.code === 'wrong_secret' ? "That password didn't match. Try again." : e.message);
        return rerender();
      }
      try {
        file = await prepareExport(app, pw.value);
        pw.value = '';
        message = null;
      } catch (e) {
        message = notice('error', `The file could not be prepared: ${e.message} Your wallet is unchanged.`);
      }
      busy = false;
      rerender();
    };
    pw.onkeydown = (e) => e.key === 'Enter' && prepare();
    if (!file) {
      setTimeout(() => pw.focus(), 50);
      return [
        h('h2', { text: 'Export wallet.db' }),
        h('p', { class: 'lead', text: 'Enter your BEAM Campfire password. The exported file will open with it.' }),
        h('label', { class: 'field' }, 'Password', pw),
        message,
        h('button', { class: 'btn btn-primary', onclick: prepare, disabled: busy, 'data-testid': 'export-prepare' }, busy ? 'Preparing…' : 'Prepare the file'),
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Cancel'),
      ];
    }
    return [
      h('h2', { text: 'Your wallet.db is ready' }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'export-name', text: file.name }), h('div', { class: 's', text: `${formatFileSize(file.size)} · opens with your BEAM Campfire password` }))),
      notice('warn', 'Keep it private: this file and your password are your wallet.'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          'data-testid': 'export-save',
          onclick: async () => {
            const how = await deliverExport(file);
            if (how === 'cancelled') return;
            await markExported(app).catch(() => {});
            toast(how === 'shared' ? 'wallet.db shared' : 'wallet.db saved to your downloads');
            close();
          },
        },
        icon('download'),
        'Save wallet.db',
      ),
      h('button', { class: 'btn btn-text', onclick: () => close() }, 'Done'),
    ];
  }, { label: 'Export wallet.db' });
}
