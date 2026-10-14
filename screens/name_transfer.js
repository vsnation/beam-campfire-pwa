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

  const input = h('textarea', { class: 'input mono', rows: '3', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: "Paste the receiving wallet's name key", 'aria-label': 'Name key of the receiving wallet', 'data-testid': 'transfer-key' });
  const keyBox = h('div', { class: 'name-stack' });
  const notes = h('div', { class: 'name-stack' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'transfer-reason', 'aria-live': 'polite' });
  const cta = h('button', { class: 'btn btn-primary', 'data-testid': 'transfer-cta', disabled: true, onclick: transfer }, `Transfer ${name}`);

  function readKey() {
    const t = input.value.trim();
    key = null;
    keyError = null;
    msg = null;
    if (!t) return render();
    try {
      key = requireKey(t);
    } catch (e) {
      keyError = e.message;
    }
    if (key && myKey && key === myKey) {
      key = null;
      keyError = `That is this wallet's own key. Paste the key of the wallet that should get ${name}.`;
    }
    render();
  }

  function ctaState() {
    if (busy) return 'Building the transfer…';
    if (res && (!res.domain || res.ownerKey !== myKey)) return `${display(name)} is not in this wallet.`;
    if (res && res.status === STATUS.availableAgain) return 'An expired name cannot be transferred until it is registered again.';
    if (!key) return `Paste the key of the wallet that should get ${name}.`;
    if (!wallet.state.sync.canSend) return `Transferring is paused: ${syncReason(wallet.state.sync.title)}.`;
    if (wallet.available(0) < NAME_CALL_FEE) return `You need ${formatAmount(NAME_CALL_FEE)} BEAM for the network fee. You have ${formatAmount(wallet.available(0))} BEAM.`;
    return null;
  }

  function render() {
    if (!alive) return;
    const off = ctaState();
    cta.disabled = Boolean(off);
    cta.textContent = busy ? 'Preparing…' : `Transfer ${name}`;
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
            h('p', { class: 'small', text: 'New owner' }),
            h('p', { class: 'check-code mono', 'data-testid': 'transfer-check', text: checkCode(key) }),
            h('p', { class: 'small', text: "Read all 16 characters to the receiving wallet's owner. Their Receive a name screen shows the same ones. If even one differs, stop: the key you pasted is not theirs." }),
          )
        : null,
    );
    put(
      notes,
      key ? h('div', { 'data-testid': 'transfer-final' }, notice('warn', h('strong', { text: "This can't be undone. " }), `Only the new owner can give ${name} back.${until ? ` Its time left (until about ${until}) goes with it.` : ''}`)) : null,
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'transfer-fee', text: `${formatAmount(NAME_CALL_FEE)} BEAM` })),
      msg ? h('div', { 'data-testid': 'transfer-msg', 'data-code': msg.code }, notice(msg.kind, msg.text)) : null,
    );
  }

  async function paste() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) {
        input.value = t.trim();
        readKey();
      }
    } catch {
      toast('Paste was not allowed. Press and hold the field, then Paste.');
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
          rows: [['Name', display(name)], ['New owner', checkCode(key)]],
          warn: `This can't be undone. Only the new owner can give ${name} back.${until ? ` Its time left (until about ${until}) goes with it.` : ''}`,
          ack: 'I checked all 16 characters with the new owner',
        },
      });
      if (!alive) return;
      pending.set(name, { kind: 'transfer', at: Date.now() });
      busy = false;
      toast(`Transfer of ${display(name)} sent. It leaves this wallet once the network confirms it, usually within 2 minutes.`, 6000);
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
      msg = { kind: 'error', code: e.code || 'error', text: `${display(name)} could not be read: ${e.message}` };
      if (alive) render();
    });
  render();

  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small paste-btn', type: 'button', 'data-testid': 'transfer-paste', onclick: paste }, icon('paste'), h('span', { text: 'Paste' }));
  const el = screen(
    { title: `Transfer ${name}`, back: () => app.back('names'), cls: 'names feature sticky-actions', actions: [reason, cta] },
    h('p', { class: 'lead', text: `Give ${display(name)} to another wallet. Ask its owner for their name key: in BEAM Campfire it is under BEAM names → Receive a name.` }),
    h('label', { class: 'field' }, 'Name key of the receiving wallet', input),
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
