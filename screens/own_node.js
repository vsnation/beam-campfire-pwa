/* Settings -> BEAM node -> Your own node
 * Spec: ONE job: connect this wallet through a BEAM node you run.
 *       Primary CTA: "Use this node" (it checks the node first; nothing is saved unless it answers,
 *       then Face ID or the password).
 *       Taps from app open: 3 (Settings -> BEAM node -> Your own node), then the address and 1.
 * Exit-intent reasons and answers:
 *   - "What do I type?" -> one field, an example in it, and a pasted wss://host:port is accepted as is.
 *   - "Did it work?" -> it is checked before anything is saved; a node that doesn't answer is said plainly
 *     ("needs a secure connection with a valid certificate") and nothing changes.
 *   - "Why did it ask to unlock again?" -> said under the button before it happens: the app reopens once
 *     so its security policy can allow this one node.
 *   - "What can my node receive?" -> the owner-key choice says it in BEAM's terms, in plain words.
 *   - "Who sees my IP now?" -> your node, said on the screen.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { normalizeNodeAddress, NODE_EXAMPLE } from '../lib/node_address.js';
import { probeNode, useOwnNode, isOwnNode, canUseOwnNode } from '../lib/own_node.js';
import { OWNER_KEY_LEAD, OWNER_KEY_PATH } from './node.js';

export const UNREACHABLE_TEXT = "Couldn't reach that node. It needs a secure connection (wss) with a valid certificate.";

export default function ownNode(app, params = {}) {
  const current = isOwnNode(app.prefs.node) ? app.prefs.node : null;
  const input = h('input', {
    class: 'input mono',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    placeholder: NODE_EXAMPLE,
    'aria-label': 'Node address',
    'data-testid': 'own-node-address',
  });
  if (params.edit && current) input.value = current;
  const hint = h('p', { class: 'hint', 'data-testid': 'own-node-hint', text: "Its host name or IP address, and the port it accepts wallets on." });
  const keyBox = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': "This node has my wallet's owner key", 'data-testid': 'own-node-key', checked: Boolean(app.prefs.ownNodeKey) });
  const keyText = h('div', { class: 's wrap', 'data-testid': 'own-node-key-text' });
  const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'own-node-msg' });
  const cta = primary('Use this node', submit, { 'data-testid': 'own-node-submit' });
  let busy = false;

  const setKeyText = () => {
    keyText.textContent = keyBox.checked ? 'Then offline and max-privacy payments can be received too.' : 'Without it: online payments only.';
  };
  keyBox.addEventListener('change', setKeyText);
  setKeyText();

  function check() {
    const v = input.value.trim();
    if (!v) {
      hint.className = 'hint';
      hint.textContent = "Its host name or IP address, and the port it accepts wallets on.";
      input.classList.remove('bad');
      return null;
    }
    const n = normalizeNodeAddress(v);
    hint.className = n.ok ? 'hint' : 'hint bad';
    hint.textContent = n.ok ? `Connects to wss://${n.address}` : n.error;
    input.classList.toggle('bad', !n.ok);
    return n.ok ? n : null;
  }
  input.addEventListener('input', () => {
    check();
    if (!busy) put(msg);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

  function setBusy(on, label = 'Use this node') {
    busy = on;
    cta.disabled = on;
    input.readOnly = on;
    keyBox.disabled = on;
    put(cta, on ? h('span', { class: 'spinner small' }) : null, label);
  }

  async function submit() {
    if (busy) return;
    const n = check();
    if (!n) {
      put(msg, notice('warn', input.value.trim() ? hint.textContent : `Type your node's address, for example ${NODE_EXAMPLE}.`));
      return;
    }
    input.value = n.address;
    setBusy(true, 'Checking the node…');
    put(msg, notice('info', `Connecting to ${n.address}…`));
    const r = await probeNode(n.address);
    if (!r.ok) {
      setBusy(false);
      put(msg, notice('error', h('strong', { text: `${UNREACHABLE_TEXT} ` }), r.code === 'timeout' ? 'It did not answer. ' : '', 'Nothing was saved.'));
      return;
    }
    put(msg, notice('success', `${n.address} answered.`));
    const ok = await confirmIdentity(app, { title: 'Use this node?', detail: `${n.address} becomes the only node this wallet uses.`, cta: 'Use this node' });
    if (!ok) {
      setBusy(false);
      put(msg, notice('info', 'Nothing was changed.'));
      return;
    }
    setBusy(true, 'Switching…');
    put(msg, notice('success', 'Your node answered. Reopening the wallet to connect through it…'));
    try {
      await new Promise((res) => setTimeout(res, 900));
      const how = await useOwnNode(app, n.address, { ownerKey: keyBox.checked });
      if (how === 'restarted') app.go('nodeSettings');
    } catch (e) {
      setBusy(false);
      put(msg, notice('error', `Couldn't switch: ${e.message}`));
    }
  }

  const blocked = !canUseOwnNode();
  if (blocked) {
    cta.disabled = true;
    put(msg, notice('warn', 'Your own node works in the installed app only.'));
  }

  const el = screen(
    { title: 'Your own node', back: () => app.go('nodeSettings'), cls: 'settings own-node', actions: [cta, h('p', { class: 'small center', text: 'Switching reopens the wallet: you unlock it once more.' })] },
    h('p', { class: 'lead', text: 'Connect through a BEAM node you run. It becomes the only node this wallet uses.' }),
    h('label', { class: 'field' }, 'Node address', input),
    hint,
    msg,
    h('div', { class: 'card list key-card' }, h('label', { class: 'row' }, h('span', { class: 'main' }, h('div', { class: 't wrap-t', text: "This node has my wallet's owner key" }), keyText), keyBox)),
    h('p', { class: 'small', 'data-testid': 'owner-key-line' }, OWNER_KEY_LEAD, h('button', { class: 'btn btn-text link-line', type: 'button', onclick: () => app.go('ownerKey', { from: 'ownNode' }), 'data-testid': 'owner-key-link' }, OWNER_KEY_PATH)),
    h('p', { class: 'small', 'data-testid': 'own-node-ip-line' }, icon('shield', 'inline-icon'), ' Your node can see your IP address, like any BEAM node.'),
  );
  if (input.value) check();
  else if (!blocked) setTimeout(() => input.focus(), 50);
  return { el };
}
