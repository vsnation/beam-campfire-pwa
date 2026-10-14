/* Transfer a name
 * Spec: ONE job: give this name to another wallet: exactly the one whose name key its owner gave you.
 *       Primary CTA: "Transfer alice" (then the approve sheet: the key's 16 characters again, and a tick that
 *       they were checked before its button works).
 *       Taps from app open: Names (1) -> alice (2) -> Transfer (3) -> Paste (4) -> "Transfer alice" (5) -> tick and
 *       approve. Long on purpose: it gives away a name worth $10-$320 a year and cannot be undone.
 * Exit-intent reasons and answers:
 *   - "Where do I get the key?" -> the first line: the receiving wallet shows it under BEAM names ->
 *     Receive a name.
 *   - "Did I paste the right thing?" -> 16 characters of the key (64 bits), large, to read out and compare
 *     with the other wallet; the approve sheet's button stays off until the box saying so is ticked.
 *   - "Can I undo it?" -> no, and that is said before the button, with what goes with it (the time left).
 *   - "What does it cost?" -> only the network fee, 0.011 BEAM.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { requireKey, checkCode, display, dateOf, STATUS, NAME_CALL_FEE } from '../lib/bans.js';
import { bans, day, nameProblemText } from './names.js';
import { pendingOf } from './name_parts.js';
import { syncReason } from '../lib/sync.js';
import { t } from '../lib/i18n.js';

export default function nameTransfer(app, params = {}) {
  const name = String(params.name || '');
  const pending = pendingOf(app);
  let key = null;
  let keyError = null;
  let myKey = null;
  let res = null;
  let busy = false;
  let msg = null;
  let alive = true;

  const input = h('textarea', { class: 'input mono', rows: '3', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: t("Paste the receiving wallet's name key"), 'aria-label': t('Name key of the receiving wallet'), 'data-testid': 'transfer-key' });
  const keyBox = h('div', { class: 'name-stack' });
  const notes = h('div', { class: 'name-stack' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'transfer-reason', 'aria-live': 'polite' });
  const cta = h('button', { class: 'btn btn-primary', 'data-testid': 'transfer-cta', disabled: true, onclick: transfer }, t('Transfer {name}', { name }));

  function readKey() {
    const typed = input.value.trim();
    key = null;
    keyError = null;
    msg = null;
    if (!typed) return render();
    try {
      key = requireKey(typed);
    } catch (e) {
      keyError = e.message;
    }
    if (key && myKey && key === myKey) {
      key = null;
      keyError = t("That is this wallet's own key. Paste the key of the wallet that should get {name}.", { name });
    }
    render();
  }

  function ctaState() {
    if (busy) return t('Building the transfer…');
    if (res && (!res.domain || res.ownerKey !== myKey)) return t('{name} is not in this wallet.', { name: display(name) });
    if (res && res.status === STATUS.availableAgain) return t('An expired name cannot be transferred until it is registered again.');
    if (!key) return t('Paste the key of the wallet that should get {name}.', { name });
    if (!wallet.state.sync.canSend) return t('Transferring is paused: {reason}.', { reason: syncReason(wallet.state.sync.title) });
    if (wallet.available(0) < NAME_CALL_FEE) return t('You need {fee} BEAM for the network fee. You have {have} BEAM.', { fee: formatAmount(NAME_CALL_FEE), have: formatAmount(wallet.available(0)) });
    return null;
  }

  /** "Only the new owner can give alice back." and, when known, what goes with it. */
  const finalText = (until) =>
    until ? t('Only the new owner can give {name} back. Its time left (until about {date}) goes with it.', { name, date: until }) : t('Only the new owner can give {name} back.', { name });

  function render() {
    if (!alive) return;
    const off = ctaState();
    cta.disabled = Boolean(off);
    cta.textContent = busy ? t('Preparing…') : t('Transfer {name}', { name });
    put(reason, off || '');
    reason.classList.toggle('hidden', !off);
    input.classList.toggle('bad', Boolean(keyError));
    const until = res && res.domain ? day(dateOf(res.domain.expireHeight, res)) : null;
    put(
      keyBox,
      keyError ? h('p', { class: 'hint bad', 'data-testid': 'transfer-key-error', text: keyError }) : null,
      key
        ? h(
            'div',
            { class: 'card check-card' },
            h('p', { class: 'small', text: t('New owner') }),
            h('p', { class: 'check-code mono', 'data-testid': 'transfer-check', text: checkCode(key) }),
            h('p', { class: 'small', text: t("Read all 16 characters to the receiving wallet's owner. Their Receive a name screen shows the same ones. If even one differs, stop: the key you pasted is not theirs.") }),
          )
        : null,
    );
    put(
      notes,
      key ? h('div', { 'data-testid': 'transfer-final' }, notice('warn', h('strong', { text: `${t("This can't be undone.")} ` }), finalText(until))) : null,
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'transfer-fee', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })), // i18n-ignore: an amount and its ticker
      msg ? h('div', { 'data-testid': 'transfer-msg', 'data-code': msg.code }, notice(msg.kind, msg.text)) : null,
    );
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = text.trim();
        readKey();
      }
    } catch {
      toast(t('Paste was not allowed. Press and hold the field, then Paste.'));
    }
  }

  async function transfer() {
    if (ctaState() || busy) return;
    busy = true;
    msg = null;
    render();
    try {
      const until = res && res.domain ? day(dateOf(res.domain.expireHeight, res)) : null;
      await bans().setOwner(name, key, {
        words: {
          rows: [[t('Name'), display(name)], [t('New owner'), checkCode(key)]],
          warn: `${t("This can't be undone.")} ${finalText(until)}`,
          ack: t('I checked all 16 characters with the new owner'),
        },
      });
      if (!alive) return;
      pending.set(name, { kind: 'transfer', at: Date.now() });
      busy = false;
      toast(t('Transfer of {name} sent. It leaves this wallet once the network confirms it, usually within 2 minutes.', { name: display(name) }), 6000);
      wallet.refreshTxs();
      app.go('names', {}, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      msg = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: nameProblemText(e, 'transfer') };
    }
    busy = false;
    render();
  }

  input.addEventListener('input', readKey);
  const off = wallet.onChange(() => render());
  Promise.all([bans().myKey(), bans().resolve(name)])
    .then(([k, r]) => {
      myKey = k;
      res = r;
      if (alive) readKey();
    })
    .catch((e) => {
      msg = { kind: 'error', code: e.code || 'error', text: t('{name} could not be read: {reason}', { name: display(name), reason: e.message }) };
      if (alive) render();
    });
  render();

  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small paste-btn', type: 'button', 'data-testid': 'transfer-paste', onclick: paste }, icon('paste'), h('span', { text: t('Paste') }));
  const el = screen(
    { title: t('Transfer {name}', { name }), back: () => app.back('names'), cls: 'names feature sticky-actions', actions: [reason, cta] },
    h('p', { class: 'lead', text: t('Give {name} to another wallet. Ask its owner for their name key: in BEAM Campfire it is under BEAM names → Receive a name.', { name: display(name) }) }),
    h('label', { class: 'field' }, t('Name key of the receiving wallet'), input),
    pasteBtn,
    keyBox,
    notes,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
