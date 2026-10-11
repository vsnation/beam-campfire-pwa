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
 *   - "I run my own node" -> Show owner key (secondary, last): the key a node needs to find every
 *     payment, offline and max-privacy ones too; it sees, it cannot spend.
 *   - "Can it go to iCloud?" -> optional card "Keep a copy in iCloud Drive" (other platforms: "your
 *     cloud storage"): the same encrypted wallet.db, with a password of at least 12 characters (a
 *     file in the cloud can be attacked offline), and the exact taps to put it in iCloud Drive and to
 *     bring it back (Import wallet.db). Never offered unasked, never automatic.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, toast, focusSoon } from '../lib/ui.js';
import { generatePhrase } from '../lib/engine.js';
import { isImported, openWithPasswordFor, markExported } from '../lib/session.js';
import { prepareExport, deliverExport, cloudPlatform, CLOUD_MIN_PASSWORD } from '../lib/export.js';
import { NO_PHRASE_NOTICE, formatFileSize } from '../lib/wallet_file.js';
import { OWNER_KEY_TEXT } from '../lib/owner_key.js';

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
    { title: 'Backup', back: () => app.back('settings'), actions: [primary('Export wallet.db', () => exportSheet(app), { 'data-testid': 'export-start' })] },
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
    cloudCard(app),
    notice('warn', h('strong', { text: 'The file and your password are your wallet. ' }), 'Anyone who has both can take your money. Keep the file somewhere private.'),
    h(
      'div',
      { class: 'card', 'data-testid': 'owner-key-card' },
      h('h3', { text: OWNER_KEY_TEXT.backupTitle }),
      h('p', { text: OWNER_KEY_TEXT.backupText }),
      h('button', { class: 'btn btn-secondary card-btn', onclick: () => app.go('ownerKey'), 'data-testid': 'owner-key-start' }, icon('key'), OWNER_KEY_TEXT.backupCta),
    ),
  );
  return { el };
}

/** Words for the cloud copy, per platform (cloudPlatform). Exported for the tests. */
export function cloudText(where) {
  const apple = where === 'ios' || where === 'mac';
  const place = apple ? 'iCloud Drive' : 'your cloud storage';
  return {
    place,
    title: apple ? 'Keep a copy in iCloud Drive' : 'Keep a copy in your cloud storage',
    lead: `Optional. If this ${where === 'mac' ? 'computer' : 'phone'} is lost, open BEAM Campfire anywhere, choose Import wallet.db and pick the copy in ${place}.`,
    lock: `The copy is encrypted (AES-256) and opens only with its password. ${apple ? 'Apple' : 'The cloud service'} cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least ${CLOUD_MIN_PASSWORD} characters.`,
    cta: apple ? 'Save a copy to iCloud Drive' : 'Save a copy to the cloud',
    save: where === 'ios' ? 'Save to iCloud Drive' : where === 'mac' ? 'Save the file' : 'Save to the cloud',
    steps:
      where === 'ios'
        ? [`Tap “Save to iCloud Drive”.`, 'In the list that opens, choose “Save to Files”.', 'Choose iCloud Drive, then Save.']
        : where === 'mac'
          ? ['Tap “Save the file”: it goes to your Downloads folder.', 'In Finder, move it into iCloud Drive.']
          : ['Tap “Save to the cloud”.', 'Choose your cloud storage in the list (for example Google Drive), or open your downloads and move it there.'],
    // how: what deliverExport did ('shared' through the share sheet, or 'downloaded').
    done: (how) =>
      how === 'shared'
        ? where === 'ios'
          ? 'Saved. Check Files → iCloud Drive for the copy.'
          : 'Saved. Check your cloud storage for the copy.'
        : where === 'mac'
          ? 'Saved to Downloads. Move it into iCloud Drive in Finder.'
          : where === 'ios'
            ? 'Saved to your downloads. Move it into iCloud Drive in Files.'
            : 'Saved to your downloads. Move it to your cloud storage.',
  };
}

/** Settings -> Backup: the optional card for a copy in the person's cloud. */
function cloudCard(app) {
  const t = cloudText(cloudPlatform());
  return h(
    'div',
    { class: 'card', 'data-testid': 'cloud-card' },
    h('h3', { text: t.title }),
    h('p', { text: t.lead }),
    h('p', { class: 'small', text: t.lock }),
    h('button', { class: 'btn btn-secondary card-btn', onclick: () => cloudSheet(app), 'data-testid': 'cloud-start' }, icon('cloud'), t.cta),
  );
}

/**
 * The cloud copy: BEAM Campfire password (who is asking) -> if it is shorter than
 * CLOUD_MIN_PASSWORD, a longer one for this copy only -> prepare -> a fresh tap to save it.
 */
function cloudSheet(app) {
  const where = cloudPlatform();
  const t = cloudText(where);
  let step = 'who';
  let filePw = null;
  let sameAsApp = false;
  let file = null;
  let busy = false;
  let message = null;
  const field = (attrs) => h('input', { class: 'input', type: 'password', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs });
  const pw = field({ autocomplete: 'current-password', 'aria-label': 'BEAM Campfire password', placeholder: 'Password', 'data-testid': 'cloud-pw' });
  // Not saved by the browser: a password kept in the same account as the copy would protect nothing.
  const pw1 = field({ autocomplete: 'off', 'aria-label': 'Password for the copy', placeholder: `At least ${CLOUD_MIN_PASSWORD} characters`, 'data-testid': 'cloud-pw1' });
  const pw2 = field({ autocomplete: 'off', 'aria-label': 'The same password again', placeholder: 'The same password again', 'data-testid': 'cloud-pw2' });
  openSheet((close, rerender) => {
    const prepare = async () => {
      busy = true;
      message = h('p', { class: 'small', 'data-testid': 'cloud-busy', text: 'Preparing the copy… (the wallet pauses for a moment)' });
      rerender();
      try {
        file = await prepareExport(app, filePw);
        filePw = null;
        message = null;
        step = 'save';
      } catch (e) {
        message = notice('error', `The copy could not be prepared: ${e.message} Your wallet is unchanged.`);
      }
      busy = false;
      rerender();
    };
    const who = async () => {
      if (busy) return;
      if (!pw.value) {
        message = notice('warn', 'Enter your BEAM Campfire password.');
        return rerender();
      }
      busy = true;
      rerender();
      try {
        await openWithPasswordFor(app, pw.value);
      } catch (e) {
        busy = false;
        message = notice('error', e.code === 'wrong_secret' ? "That password didn't match. Try again." : e.message);
        return rerender();
      }
      busy = false;
      message = null;
      if (pw.value.length >= CLOUD_MIN_PASSWORD) {
        filePw = pw.value;
        sameAsApp = true;
        pw.value = '';
        return prepare();
      }
      pw.value = '';
      step = 'choose';
      rerender();
    };
    const chosen = () => {
      if (busy) return;
      if (pw1.value.length < CLOUD_MIN_PASSWORD) {
        message = notice('warn', `Use at least ${CLOUD_MIN_PASSWORD} characters.`);
        return rerender();
      }
      if (pw1.value !== pw2.value) {
        message = notice('warn', "The two passwords don't match.");
        return rerender();
      }
      filePw = pw1.value;
      pw1.value = '';
      pw2.value = '';
      prepare();
    };
    // A block body: an on… property handler that returns false cancels the key, so every letter but
    // Enter was dropped ("I can't type there, only Paste").
    pw.onkeydown = (e) => {
      if (e.key === 'Enter') who();
    };
    pw2.onkeydown = (e) => {
      if (e.key === 'Enter') chosen();
    };
    const cancel = h('button', { class: 'btn btn-text', onclick: () => close(), 'data-testid': 'cloud-cancel' }, 'Cancel');
    if (step === 'who') {
      focusSoon(pw);
      return [
        h('h2', { text: t.cta }),
        h('p', { class: 'lead', text: 'Enter your BEAM Campfire password.' }),
        h('label', { class: 'field' }, 'Password', pw),
        message,
        h('button', { class: 'btn btn-primary', onclick: who, disabled: busy, 'data-testid': 'cloud-continue' }, busy ? 'Checking…' : 'Continue'),
        cancel,
      ];
    }
    if (step === 'choose') {
      focusSoon(pw1);
      return [
        h('h2', { text: 'Choose a password for the copy' }),
        h('p', { class: 'lead', 'data-testid': 'cloud-choose-lead', text: `Your BEAM Campfire password is short for a file kept in ${t.place}. Choose one of at least ${CLOUD_MIN_PASSWORD} characters for this copy. You need it to open the copy, so write it down, not in the same account as the copy.` }),
        h('label', { class: 'field' }, 'Password for the copy', pw1),
        h('label', { class: 'field' }, 'Again', pw2),
        message,
        h('button', { class: 'btn btn-primary', onclick: chosen, disabled: busy, 'data-testid': 'cloud-prepare' }, busy ? 'Preparing…' : 'Prepare the copy'),
        cancel,
      ];
    }
    return [
      h('h2', { text: 'Your copy is ready' }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'cloud-name', text: file.name }), h('div', { class: 's', 'data-testid': 'cloud-opens-with', text: `${formatFileSize(file.size)} · opens with ${sameAsApp ? 'your BEAM Campfire password' : 'the password you chose'}` }))),
      h('ol', { class: 'steps-list', 'data-testid': 'cloud-steps' }, ...t.steps.map((s) => h('li', { text: s }))),
      h(
        'button',
        {
          class: 'btn btn-primary',
          'data-testid': 'cloud-save',
          onclick: async () => {
            const how = await deliverExport(file, { download: where === 'mac' });
            if (how === 'cancelled') return;
            await markExported(app).catch(() => {});
            toast(t.done(how));
            close();
          },
        },
        icon('cloud'),
        t.save,
      ),
      h('button', { class: 'btn btn-text', onclick: () => close() }, 'Done'),
    ];
  }, { label: t.cta });
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
    // A block body: returning false from an on… property handler cancels the key (see cloudSheet).
    pw.onkeydown = (e) => {
      if (e.key === 'Enter') prepare();
    };
    if (!file) {
      focusSoon(pw);
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
