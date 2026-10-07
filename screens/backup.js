/* Backup words (create, step 1 of 3) / Backup (Settings, for the wallet on this device)
 * Spec (create): ONE job: write down the 12 words.
 *       Primary CTA: "I wrote them down" (enabled after the words are shown).
 *       Taps from app open: 1 (Welcome -> Create).
 * Spec (Settings -> Backup): ONE job: say what brings this wallet back.
 *       Primary CTA: none (information); Back returns to Settings.
 *       Taps from app open: 2 (Settings -> Backup).
 *       Words are never stored, so they are never shown again; an imported wallet has none and
 *       is told so (its wallet.db file and password are its backup). With a wallet on the device
 *       this screen never makes new words.
 * Exit-intent reasons and answers:
 *   - "Why do I need this?" -> one sentence: the words are the wallet; they bring it back on any device.
 *   - "Someone could see my screen" -> words stay blurred until tapped.
 *   - "Can I screenshot it?" -> we say no, and why (photos sync to the cloud).
 *   - "Where are my 12 words?" (imported) -> there are none here; the file and its password are the backup.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { generatePhrase } from '../lib/engine.js';
import { isImported } from '../lib/session.js';
import { NO_PHRASE_NOTICE } from '../lib/wallet_file.js';

export default function backup(app) {
  // A wallet already lives on this device: never make new words here.
  if (app.record) return existingBackup(app);
  const grid = h('div', { class: 'words hidden-words', 'data-testid': 'words' });
  const cta = primary('I wrote them down', () => app.go('confirmWords'), { disabled: true, 'data-testid': 'wrote-down' });
  const cover = h('div', { class: 'cover' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'reveal' }, icon('eye'), 'Tap to show the words'));
  const reveal = h('div', { class: 'reveal' }, grid, cover);
  const status = h('p', { class: 'small', text: 'Making your words…' });

  cover.querySelector('button').addEventListener('click', () => {
    grid.classList.remove('hidden-words');
    cover.remove();
    cta.disabled = false;
  });

  (async () => {
    try {
      if (!app.setup || app.setup.mode !== 'create') app.setup = { mode: 'create' };
      if (!app.setup.words) app.setup.words = await generatePhrase();
      put(grid, ...app.setup.words.map((w, i) => h('div', { class: 'word' }, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: w }))));
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
    reveal,
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
  const el = screen(
    { title: 'Backup', back: () => app.go('settings') },
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
              h('li', { text: 'The original wallet.db file (a copy on a computer, a USB stick or a cloud folder you trust).' }),
              h('li', { text: 'Its password: the one it had when you imported it. Changing the unlock password here does not change it.' }),
            ),
          ),
          h('p', { class: 'small', text: 'To bring the wallet back, import the file again with that password. Nobody can recover it without both, not even us.' }),
        ]
      : [
          h('div', { 'data-testid': 'phrase-backup' }, notice('info', h('strong', { text: 'Your 12 words are this wallet\'s backup. ' }), 'With them you can restore it on any device.')),
          h('p', { class: 'lead', text: 'BEAM Campfire does not keep a copy of the words, so it cannot show them again. Keep your paper safe and private.' }),
          h('p', { class: 'small', text: 'Lost the paper? Move the coins to a new wallet while this one still opens: create one on another device and send everything to it.' }),
        ],
  );
  return { el };
}
