/* Restore (step 1 of 2)
 * Spec: ONE job: enter the 12 recovery words.
 *       Primary CTA: "Restore my wallet".
 *       Taps from app open: 1 (Welcome -> Restore), then typing or one paste.
 * Exit-intent reasons and answers:
 *   - "Typing 12 words on a phone is painful" -> paste all 12 into any box; they spread out.
 *   - "Which word is wrong?" -> each unknown word is marked as you go, with its number.
 *   - "Will my coins come back?" -> said up front: yes, after a one-time download.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { isAllowedWord, isValidPhrase, loadEngine } from '../lib/engine.js';

export default function restore(app) {
  const inputs = [];
  const boxes = [];
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary('Restore my wallet', submit, { disabled: true, 'data-testid': 'restore-submit' });
  let ready = false;
  loadEngine().then(() => {
    ready = true;
    validate();
  }, (e) => put(msg, notice('error', `The wallet engine did not start: ${e.message}. Reload the page to try again.`)));

  for (let i = 0; i < 12; i++) {
    const input = h('input', {
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      inputmode: 'text',
      enterkeyhint: i === 11 ? 'done' : 'next',
      'aria-label': `Word ${i + 1}`,
      'data-testid': `word-${i + 1}`,
    });
    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const parts = splitWords(text);
      if (parts.length > 1) {
        e.preventDefault();
        fill(i, parts);
      }
    });
    input.addEventListener('input', () => {
      const parts = splitWords(input.value);
      if (parts.length > 1) fill(i, parts);
      validate();
    });
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && i < 11) {
        e.preventDefault();
        inputs[i + 1].focus();
      }
    });
    inputs.push(input);
    boxes.push(h('label', { class: 'word-input' }, h('span', { class: 'n', text: String(i + 1) }), input));
  }

  function splitWords(t) {
    return String(t).toLowerCase().split(/[\s,;]+/).map((w) => w.replace(/^\d+[.)]?$/, '')).filter(Boolean);
  }

  function fill(start, parts) {
    const from = parts.length >= 12 ? 0 : start;
    parts.slice(0, 12 - from).forEach((w, k) => (inputs[from + k].value = w));
    const next = Math.min(11, from + parts.length);
    inputs[next].focus();
    validate();
  }

  let checkSeq = 0;
  async function validate() {
    if (!ready) return;
    const seq = ++checkSeq;
    const words = inputs.map((x) => x.value.trim().toLowerCase());
    let bad = [];
    for (let i = 0; i < 12; i++) {
      const w = words[i];
      const ok = w === '' ? null : await isAllowedWord(w);
      if (seq !== checkSeq) return;
      boxes[i].classList.toggle('bad', ok === false && document.activeElement !== inputs[i]);
      if (ok === false) bad.push(i + 1);
    }
    const complete = words.every(Boolean);
    if (bad.length) {
      put(msg, notice('warn', `Word${bad.length > 1 ? 's' : ''} #${bad.join(', #')} ${bad.length > 1 ? "aren't" : "isn't"} in BEAM's word list. Check the spelling.`));
      cta.disabled = true;
      return;
    }
    if (complete) {
      const valid = await isValidPhrase(words);
      if (seq !== checkSeq) return;
      if (!valid) {
        put(msg, notice('warn', "These words don't form a valid BEAM phrase. Check the order and each word."));
        cta.disabled = true;
        return;
      }
      put(msg, notice('success', 'All 12 words check out.'));
      cta.disabled = false;
      return;
    }
    put(msg);
    cta.disabled = true;
  }
  for (const x of inputs) x.addEventListener('blur', validate);

  async function submit() {
    const words = inputs.map((x) => x.value.trim().toLowerCase());
    if (!(await isValidPhrase(words))) return validate();
    app.setup = { mode: 'restore', words };
    for (const x of inputs) x.value = '';
    app.go('setPassword');
  }

  const el = screen(
    { title: 'Restore your wallet', back: () => app.go('welcome'), actions: [cta] },
    h('p', { class: 'step', text: 'Step 1 of 2' }),
    h('p', { class: 'lead', text: 'Enter your 12 words in order. You can paste all of them into the first box.' }),
    h('div', { class: 'words' }, ...boxes),
    msg,
    h('p', { class: 'small', text: 'Your coins come back after a one-time download of about 330 MB. The words never leave this device.' }),
  );
  return { el };
}
