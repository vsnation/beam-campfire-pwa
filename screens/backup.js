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
 *   - "Someone could see my screen" -> words stay blurred until tapped, and blur again as soon as the
 *     app is left, so the app switcher's picture never shows them.
 *   - "Can I screenshot it?" -> we say no, and why (photos sync to the cloud).
 *   - "Where are my 12 words?" (imported) -> there are none here; the file and its password are the backup.
 *   - "What if this website disappears?" -> Export wallet.db: the file and the password open the wallet
 *     anywhere BEAM runs. Said plainly: file + password = the wallet, keep it private.
 *   - "My names, notes and history?" -> card "Move names, notes and history" (screens/wallet_data.js):
 *     BEAM's wallet data file, saved and brought in; the words bring back coins only.
 *   - "I run my own node" -> Show owner key (secondary, last): the key a node needs to find every
 *     payment, offline and max-privacy ones too; it sees, it cannot spend.
 *   - "Can it go to iCloud?" -> optional card "Keep a copy in iCloud Drive" (other platforms: "your
 *     cloud storage"): the same encrypted wallet.db, with a password of at least 12 characters (a
 *     file in the cloud can be attacked offline), and the exact taps to put it in iCloud Drive and to
 *     bring it back (Import wallet.db). Never offered unasked, never automatic.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, toast, focusSoon, onHidden } from '../lib/ui.js';
import { generatePhrase } from '../lib/engine.js';
import { isImported, openWithPasswordFor, markExported, isAdding } from '../lib/session.js';
import { prepareExport, deliverExport, cloudPlatform, CLOUD_MIN_PASSWORD } from '../lib/export.js';
import { passwordWeakness } from '../lib/password_strength.js';
import { NO_PHRASE_NOTICE, formatFileSize } from '../lib/wallet_file.js';
import { OWNER_KEY_TEXT } from '../lib/owner_key.js';
import { walletDataCard } from './wallet_data.js';
import { t, tNodes, dateLocale } from '../lib/i18n.js';

/**
 * Recovery words in a grid that stays blurred until tapped (no shoulder
 * surfing), and blurred again whenever the app goes out of sight (the app
 * switcher keeps a picture of the last screen). fill(words) puts them in;
 * onReveal runs each time they are shown; hide() blurs them; destroy() stops
 * watching (a grid taken off the page stops by itself). Also used for the
 * Ethereum wallet's words (screens/eth_words.js).
 */
export function wordReveal(onReveal) {
  const grid = h('div', { class: 'words hidden-words', 'data-testid': 'words' });
  const cover = h('div', { class: 'cover' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'reveal' }, icon('eye'), t('Tap to show the words')));
  const el = h('div', { class: 'reveal' }, grid, cover);
  cover.querySelector('button').addEventListener('click', () => {
    grid.classList.remove('hidden-words');
    cover.remove();
    onReveal();
  });
  const hide = () => {
    grid.classList.add('hidden-words');
    if (!cover.isConnected) el.appendChild(cover);
  };
  const off = onHidden(() => (el.isConnected ? hide() : off()));
  return {
    el,
    fill: (words) => put(grid, ...words.map((w, i) => h('div', { class: 'word' }, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: w })))),
    hide,
    destroy: off,
  };
}

export default function backup(app) {
  // A wallet already lives on this device: never make new words here, unless another is being made
  // (Add a wallet -> Create a new wallet).
  const adding = isAdding(app) && app.setup.mode === 'create';
  if (app.record && !adding) return existingBackup(app);
  const cta = primary(t('I wrote them down'), () => app.go('confirmWords'), { disabled: true, 'data-testid': 'wrote-down' });
  const reveal = wordReveal(() => (cta.disabled = false));
  const status = h('p', { class: 'small', text: t('Making your words…') });

  (async () => {
    try {
      if (!app.setup || app.setup.mode !== 'create') app.setup = { mode: 'create' };
      if (!app.setup.words) app.setup.words = await generatePhrase();
      reveal.fill(app.setup.words);
      status.textContent = '';
    } catch (e) {
      status.textContent = t('The wallet engine did not start: {reason}. Reload the page to try again.', { reason: e.message });
    }
  })();

  const el = screen(
    {
      title: t('Your 12 words'),
      back: () => {
        app.setup = null;
        app.go(adding ? 'addWallet' : 'welcome');
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: t('Step 1 of 3') }),
    h('p', { class: 'lead', text: t('These words are your wallet. With them you can open it on any device, even if this phone is lost.') }),
    notice('warn', ...tNodes('{warning} Anyone who sees them can take your money. No screenshots: photos sync to the cloud.', { warning: h('strong', { text: t('Write them on paper, in order.') }) })),
    reveal.el,
    status,
  );
  return { el, destroy: reveal.destroy };
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
    h('h3', { text: t('Export wallet.db') }),
    h('p', { text: t("A copy of this wallet as a file that opens with your BEAM Campfire password in BEAM Campfire desktop, BEAM's desktop wallet, Light Wallet or the BEAM CLI. It keeps working if this app's web address ever disappears.") }),
    h('p', { class: 'small', 'data-testid': 'export-last', text: app.record.exportedAt ? t('Last exported {date}.', { date: new Date(app.record.exportedAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('Not exported yet.') }),
  );
  const el = screen(
    { title: t('Backup'), back: () => app.back('settings'), actions: [primary(t('Export wallet.db'), () => exportSheet(app), { 'data-testid': 'export-start' })] },
    imported
      ? [
          h('div', { 'data-testid': 'no-recovery-phrase' }, notice('warn', t(NO_PHRASE_NOTICE))),
          h(
            'div',
            { class: 'card' },
            h('h3', { text: t('Keep both, somewhere other than this phone') }),
            h(
              'ol',
              { class: 'steps-list' },
              h('li', { text: t('The original wallet.db file, or one exported below.') }),
              h('li', { text: t('Its password: the original file opens with the password it had when you imported it; an exported copy opens with your BEAM Campfire password.') }),
            ),
          ),
        ]
      : [
          h('div', { 'data-testid': 'phrase-backup' }, notice('info', ...tNodes('{backup} With them you can restore it on any device.', { backup: h('strong', { text: t("Your 12 words are this wallet's backup.") }) }))),
          h('p', { class: 'small', text: t('BEAM Campfire does not keep a copy of the words, so it cannot show them again. Keep your paper safe and private.') }),
        ],
    exportCard,
    cloudCard(app),
    notice('warn', ...tNodes('{wallet} Anyone who has both can take your money. Keep the file somewhere private.', { wallet: h('strong', { text: t('The file and your password are your wallet.') }) })),
    walletDataCard(app),
    h(
      'div',
      { class: 'card', 'data-testid': 'owner-key-card' },
      h('h3', { text: t(OWNER_KEY_TEXT.backupTitle) }),
      h('p', { text: t(OWNER_KEY_TEXT.backupText) }),
      h('button', { class: 'btn btn-secondary card-btn', onclick: () => app.go('ownerKey'), 'data-testid': 'owner-key-start' }, icon('key'), t(OWNER_KEY_TEXT.backupCta)),
    ),
  );
  return { el };
}

/** Words for the cloud copy, per platform (cloudPlatform). Exported for the tests. */
export function cloudText(where) {
  const apple = where === 'ios' || where === 'mac';
  // Each sentence is written whole, per platform (word order differs between languages).
  return {
    title: apple ? t('Keep a copy in iCloud Drive') : t('Keep a copy in your cloud storage'),
    lead:
      where === 'mac'
        ? t('Optional. If this computer is lost, open BEAM Campfire anywhere, choose Import wallet.db and pick the copy in iCloud Drive.')
        : apple
          ? t('Optional. If this phone is lost, open BEAM Campfire anywhere, choose Import wallet.db and pick the copy in iCloud Drive.')
          : t('Optional. If this phone is lost, open BEAM Campfire anywhere, choose Import wallet.db and pick the copy in your cloud storage.'),
    lock: apple
      ? t('The copy is encrypted (AES-256) and opens only with its password. Apple cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {min} characters.', { min: CLOUD_MIN_PASSWORD })
      : t('The copy is encrypted (AES-256) and opens only with its password. The cloud service cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {min} characters.', { min: CLOUD_MIN_PASSWORD }),
    // choose: why the BEAM Campfire password is not used for the copy, and what to pick instead.
    choose: apple
      ? t('Your BEAM Campfire password is easy to guess, or too short for a file kept in iCloud Drive. Choose one of at least {min} characters, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.', { min: CLOUD_MIN_PASSWORD })
      : t('Your BEAM Campfire password is easy to guess, or too short for a file kept in your cloud storage. Choose one of at least {min} characters, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.', { min: CLOUD_MIN_PASSWORD }),
    cta: apple ? t('Save a copy to iCloud Drive') : t('Save a copy to the cloud'),
    save: where === 'ios' ? t('Save to iCloud Drive') : where === 'mac' ? t('Save the file') : t('Save to the cloud'),
    steps:
      where === 'ios'
        ? [t('Tap “Save to iCloud Drive”.'), t('In the list that opens, choose “Save to Files”.'), t('Choose iCloud Drive, then Save.')]
        : where === 'mac'
          ? [t('Tap “Save the file”: it goes to your Downloads folder.'), t('In Finder, move it into iCloud Drive.')]
          : [t('Tap “Save to the cloud”.'), t('Choose your cloud storage in the list (for example Google Drive), or open your downloads and move it there.')],
    // how: what deliverExport did ('shared' through the share sheet, or 'downloaded').
    done: (how) =>
      how === 'shared'
        ? where === 'ios'
          ? t('Saved. Check Files → iCloud Drive for the copy.')
          : t('Saved. Check your cloud storage for the copy.')
        : where === 'mac'
          ? t('Saved to Downloads. Move it into iCloud Drive in Finder.')
          : where === 'ios'
            ? t('Saved to your downloads. Move it into iCloud Drive in Files.')
            : t('Saved to your downloads. Move it to your cloud storage.'),
  };
}

/** Settings -> Backup: the optional card for a copy in the person's cloud. */
function cloudCard(app) {
  const words = cloudText(cloudPlatform());
  return h(
    'div',
    { class: 'card', 'data-testid': 'cloud-card' },
    h('h3', { text: words.title }),
    h('p', { text: words.lead }),
    h('p', { class: 'small', text: words.lock }),
    h('button', { class: 'btn btn-secondary card-btn', onclick: () => cloudSheet(app), 'data-testid': 'cloud-start' }, icon('cloud'), words.cta),
  );
}

/**
 * The cloud copy: BEAM Campfire password (who is asking) -> if it is shorter than
 * CLOUD_MIN_PASSWORD or easy to guess (lib/password_strength.js; a password set before those rules),
 * a stronger one for this copy only -> prepare -> a fresh tap to save it.
 */
function cloudSheet(app) {
  const where = cloudPlatform();
  const words = cloudText(where);
  let step = 'who';
  let filePw = null;
  let sameAsApp = false;
  let file = null;
  let busy = false;
  let message = null;
  // Not saved by the browser (any of them): a password kept in the same account as the copy, or in
  // the same browser profile as the wallet, would protect nothing.
  const field = (attrs) => h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs });
  const pw = field({ 'aria-label': t('BEAM Campfire password'), placeholder: t('Password'), 'data-testid': 'cloud-pw' });
  const pw1 = field({ 'aria-label': t('Password for the copy'), placeholder: t('At least {min} characters', { min: CLOUD_MIN_PASSWORD }), 'data-testid': 'cloud-pw1' });
  const pw2 = field({ 'aria-label': t('The same password again'), placeholder: t('The same password again'), 'data-testid': 'cloud-pw2' });
  openSheet((close, rerender) => {
    const prepare = async () => {
      busy = true;
      message = h('p', { class: 'small', 'data-testid': 'cloud-busy', text: t('Preparing the copy… (the wallet pauses for a moment)') });
      rerender();
      try {
        file = await prepareExport(app, filePw);
        filePw = null;
        message = null;
        step = 'save';
      } catch (e) {
        message = notice('error', t('The copy could not be prepared: {reason} Your wallet is unchanged.', { reason: e.message }));
      }
      busy = false;
      rerender();
    };
    const who = async () => {
      if (busy) return;
      if (!pw.value) {
        message = notice('warn', t('Enter your BEAM Campfire password.'));
        return rerender();
      }
      busy = true;
      rerender();
      try {
        await openWithPasswordFor(app, pw.value);
      } catch (e) {
        busy = false;
        message = notice('error', e.code === 'wrong_secret' ? t("That password didn't match. Try again.") : e.message);
        return rerender();
      }
      busy = false;
      message = null;
      if (!passwordWeakness(pw.value, { min: CLOUD_MIN_PASSWORD })) {
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
      const weak = passwordWeakness(pw1.value, { min: CLOUD_MIN_PASSWORD });
      if (weak) {
        message = notice('warn', weak.text);
        return rerender();
      }
      if (pw1.value !== pw2.value) {
        message = notice('warn', t("The two passwords don't match."));
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
    const cancel = h('button', { class: 'btn btn-text', onclick: () => close(), 'data-testid': 'cloud-cancel' }, t('Cancel'));
    if (step === 'who') {
      focusSoon(pw);
      return [
        h('h2', { text: words.cta }),
        h('p', { class: 'lead', text: t('Enter your BEAM Campfire password.') }),
        h('label', { class: 'field' }, t('Password'), pw),
        message,
        h('button', { class: 'btn btn-primary', onclick: who, disabled: busy, 'data-testid': 'cloud-continue' }, busy ? t('Checking…') : t('Continue')),
        cancel,
      ];
    }
    if (step === 'choose') {
      focusSoon(pw1);
      return [
        h('h2', { text: t('Choose a password for the copy') }),
        h('p', { class: 'lead', 'data-testid': 'cloud-choose-lead', text: words.choose }),
        h('label', { class: 'field' }, t('Password for the copy'), pw1),
        h('label', { class: 'field' }, t('Again'), pw2),
        message,
        h('button', { class: 'btn btn-primary', onclick: chosen, disabled: busy, 'data-testid': 'cloud-prepare' }, busy ? t('Preparing…') : t('Prepare the copy')),
        cancel,
      ];
    }
    return [
      h('h2', { text: t('Your copy is ready') }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'cloud-name', text: file.name }), h('div', { class: 's', 'data-testid': 'cloud-opens-with', text: sameAsApp ? t('{size} · opens with your BEAM Campfire password', { size: formatFileSize(file.size) }) : t('{size} · opens with the password you chose', { size: formatFileSize(file.size) }) }))),
      h('ol', { class: 'steps-list', 'data-testid': 'cloud-steps' }, ...words.steps.map((s) => h('li', { text: s }))),
      h(
        'button',
        {
          class: 'btn btn-primary',
          'data-testid': 'cloud-save',
          onclick: async () => {
            const how = await deliverExport(file, { download: where === 'mac' });
            if (how === 'cancelled') return;
            await markExported(app).catch(() => {});
            toast(words.done(how));
            close();
          },
        },
        icon('cloud'),
        words.save,
      ),
      h('button', { class: 'btn btn-text', onclick: () => close() }, t('Done')),
    ];
  }, { label: words.cta });
}

/** Password (it also becomes the file's password) -> prepare -> a fresh tap to save it. */
function exportSheet(app) {
  let file = null;
  let busy = false;
  let message = null;
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t('BEAM Campfire password'), placeholder: t('Password'), 'data-testid': 'export-pw' });
  openSheet((close, rerender) => {
    const prepare = async () => {
      if (busy) return;
      if (!pw.value) {
        message = notice('warn', t('Enter your BEAM Campfire password.'));
        return rerender();
      }
      busy = true;
      message = h('p', { class: 'small', 'data-testid': 'export-busy', text: t('Preparing the file… (the wallet pauses for a moment)') });
      rerender();
      try {
        await openWithPasswordFor(app, pw.value);
      } catch (e) {
        busy = false;
        message = notice('error', e.code === 'wrong_secret' ? t("That password didn't match. Try again.") : e.message);
        return rerender();
      }
      try {
        file = await prepareExport(app, pw.value);
        pw.value = '';
        message = null;
      } catch (e) {
        message = notice('error', t('The file could not be prepared: {reason} Your wallet is unchanged.', { reason: e.message }));
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
        h('h2', { text: t('Export wallet.db') }),
        h('p', { class: 'lead', text: t('Enter your BEAM Campfire password. The exported file will open with it.') }),
        h('label', { class: 'field' }, t('Password'), pw),
        message,
        h('button', { class: 'btn btn-primary', onclick: prepare, disabled: busy, 'data-testid': 'export-prepare' }, busy ? t('Preparing…') : t('Prepare the file')),
        h('button', { class: 'btn btn-text', onclick: () => close() }, t('Cancel')),
      ];
    }
    return [
      h('h2', { text: t('Your wallet.db is ready') }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'export-name', text: file.name }), h('div', { class: 's', text: t('{size} · opens with your BEAM Campfire password', { size: formatFileSize(file.size) }) }))),
      notice('warn', t('Keep it private: this file and your password are your wallet.')),
      h(
        'button',
        {
          class: 'btn btn-primary',
          'data-testid': 'export-save',
          onclick: async () => {
            const how = await deliverExport(file);
            if (how === 'cancelled') return;
            await markExported(app).catch(() => {});
            toast(how === 'shared' ? t('wallet.db shared') : t('wallet.db saved to your downloads'));
            close();
          },
        },
        icon('download'),
        t('Save wallet.db'),
      ),
      h('button', { class: 'btn btn-text', onclick: () => close() }, t('Done')),
    ];
  }, { label: t('Export wallet.db') });
}
