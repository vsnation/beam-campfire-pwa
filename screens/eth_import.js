/* Import Ethereum words (step 1 of 2)
 * Spec: ONE job: bring an Ethereum wallet here from its 12 or 24 words.
 *       Primary CTA: "Import Ethereum wallet" (enabled once the words check out).
 *       Taps from app open: 2 (Home -> Ethereum -> Import), then paste.
 * Exit-intent reasons and answers:
 *   - "Did I type it right?" -> checked as you type: the word count, which word is unknown, or
 *     that the words don't fit together - never "invalid".
 *   - "My wallet had a passphrase" -> under Advanced; most people never set one, so it is hidden.
 *   - "Will this show my coins?" -> the next screen says what the server sees, then the balance
 *     shows; a wrong passphrase opens another, empty wallet, which is said next to the field.
 *   - "Is it stored?" -> the words are not: only the key, locked with this wallet's password.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary } from '../lib/ui.js';
import { mnemonicProblem, normalizeMnemonic } from '../lib/eth/crypto.js';

/** What to say under the box: {text, cls}. Still typing is not an error. */
function hintFor(p, count) {
  if (!p) return { text: `${count} words. They check out.`, cls: 'good' };
  if (p.code === 'length') {
    if (count === 0) return { text: '', cls: '' };
    if (count < 12) return { text: `${count} of 12 words so far (or 24).`, cls: '' };
    return { text: `That's ${count} words. Ethereum words come in sets of 12 or 24.`, cls: 'bad' };
  }
  if (p.code === 'word') return { text: `Word #${p.position} isn't one of the words wallets use. Check its spelling on your paper.`, cls: 'bad' };
  return { text: "All the words are real ones, but they don't fit together: one may be mistyped or in the wrong place.", cls: 'bad' };
}

export default function ethImport(app) {
  if (!app.ethSetup || app.ethSetup.mode !== 'import') app.ethSetup = { mode: 'import', from: 'home' };
  const area = h('textarea', { class: 'input', rows: 4, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'word1 word2 word3 …', 'aria-label': 'Ethereum recovery words', 'data-testid': 'eth-words-input', 'data-autofocus': true });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Passphrase', placeholder: 'Passphrase', 'data-testid': 'eth-passphrase' });
  const hint = h('p', { class: 'hint', 'data-testid': 'eth-words-hint' });
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-paste' }, icon('paste'), 'Paste');
  const cta = primary('Import Ethereum wallet', go, { disabled: true, 'data-testid': 'eth-import-submit' });

  function check() {
    const words = normalizeMnemonic(area.value);
    const count = words ? words.split(' ').length : 0;
    const p = mnemonicProblem(words);
    const { text, cls } = hintFor(p, count);
    put(hint, text);
    hint.className = `hint${cls ? ` ${cls}` : ''}`;
    area.classList.toggle('bad', cls === 'bad');
    cta.disabled = Boolean(p);
    return p ? null : words;
  }

  function go() {
    const words = check();
    if (!words) return;
    app.ethSetup = { ...app.ethSetup, words: words.split(' '), passphrase: pass.value };
    area.value = '';
    pass.value = '';
    app.go('ethPrivacy', { setup: true });
  }

  area.addEventListener('input', check);
  pasteBtn.addEventListener('click', async () => {
    try {
      area.value = (await navigator.clipboard.readText()).trim();
      check();
    } catch {
      put(hint, 'Press and hold in the box, then tap Paste.');
      area.focus();
    }
  });
  check();

  const el = screen(
    {
      title: 'Import Ethereum words',
      back: () => {
        const from = app.ethSetup && app.ethSetup.from;
        app.ethSetup = null;
        app.go('ethStart', { from });
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: 'Step 1 of 2' }),
    h('p', { class: 'lead', text: 'Enter the 12 or 24 words of your Ethereum wallet, in order.' }),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Recovery words' }), pasteBtn), area),
    hint,
    h(
      'details',
      { class: 'more', 'data-testid': 'eth-advanced' },
      h('summary', { text: 'Advanced' }),
      h('label', { class: 'field' }, 'Passphrase (only if you set one)', pass),
      h('p', { class: 'small', text: 'A few wallets let you add a passphrase to the words. Leave this empty if you never set one: a wrong passphrase opens a different, empty wallet.' }),
    ),
    h('p', { class: 'small', text: 'The words are not stored. Only the key made from them is kept, locked with your BEAM Campfire password.' }),
  );
  return { el };
}
