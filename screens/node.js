/* Settings -> BEAM node
 * Spec: ONE job: choose how this wallet reaches the BEAM network: random BEAM nodes or your own node.
 *       Primary CTA: none (two choices, like Settings); tapping one switches, after Face ID or the password.
 *       Taps from app open: 2 (Settings -> BEAM node), 3 to switch.
 * Exit-intent reasons and answers:
 *   - "What if BEAM's node goes down?" -> random node moves to another BEAM node by itself; said on the choice.
 *   - "Which one do I need?" -> random works for everyone; your own node is for people who run one,
 *     and what each can receive is written on it (online only, or offline and max-privacy too with the owner key).
 *   - "Is my node actually working?" -> the card below says what the app sees right now, in words.
 *   - "My node is down and nothing works" -> said plainly, with "Use random nodes" one tap away; the app never
 *     falls back by itself, because that would show your IP address to nodes you chose not to use.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { wallet } from '../lib/wallet.js';
import { isOwnNode, useRandomNodes } from '../lib/own_node.js';

export const OWNER_KEY_LEAD = "Your node needs this wallet's owner key: ";
export const OWNER_KEY_PATH = 'Settings → Backup → Show owner key';

/** What the person's own node can receive, in words; from the engine once it has said. */
export function ownNodeKeyText(app, s) {
  const confirmed = s.connEvent && s.connEvent.node_connected ? s.connEvent.own_node === true : null;
  if (confirmed === true) return "It has this wallet's owner key: online, offline and max-privacy payments can be received.";
  if (confirmed === false && app.prefs.ownNodeKey) return "It doesn't know this wallet's owner key yet: online payments only. Check the key your node was started with.";
  if (app.prefs.ownNodeKey) return "Started with this wallet's owner key: offline and max-privacy payments too, once it connects.";
  return "Online payments only. With this wallet's owner key, it could also receive offline and max-privacy payments.";
}

/** Asks for Face ID or the password, then moves the wallet to random BEAM nodes. */
export async function switchToRandom(app) {
  const ok = await confirmIdentity(app, { title: 'Use random nodes?', detail: "Your wallet connects through BEAM's own nodes again. They can see your IP address.", cta: 'Use random nodes' });
  if (!ok) return false;
  toast('Connecting through random BEAM nodes…');
  try {
    await useRandomNodes(app);
    toast('Connected through random BEAM nodes');
    return true;
  } catch (e) {
    toast(`Couldn't switch: ${e.message}`);
    return false;
  }
}

export default function nodeSettings(app) {
  const own = isOwnNode(app.prefs.node);
  const statusBox = h('div', { class: 'node-status-box', 'aria-live': 'polite' });
  let busy = false;

  const choice = (on, title, text, onclick, testid) =>
    h(
      'button',
      { class: `row${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), onclick, 'data-testid': testid },
      h('span', { class: `radio${on ? ' on' : ''}` }),
      h('span', { class: 'main' }, h('div', { class: 't' }, title, on ? h('span', { class: 'tag private node-tag', text: 'In use' }) : null), h('div', { class: 's wrap', text })),
    );

  async function pickRandom() {
    if (!own || busy) return;
    busy = true;
    try {
      if (await switchToRandom(app)) app.go('nodeSettings');
    } finally {
      busy = false;
    }
  }

  const keyLine = () =>
    h('p', { class: 'small', 'data-testid': 'owner-key-line' }, OWNER_KEY_LEAD, h('button', { class: 'btn btn-text link-line', onclick: () => app.go('ownerKey', { from: 'nodeSettings' }), 'data-testid': 'owner-key-link' }, OWNER_KEY_PATH));

  function renderStatus(s) {
    const sync = s.sync || {};
    const connected = s.nodeConnected && s.everConnected;
    if (own) {
      const down = sync.state === 'offline';
      const confirmed = s.connEvent && s.connEvent.node_connected && s.connEvent.own_node === true;
      put(
        statusBox,
        down
          ? notice('error', h('strong', { text: "Can't reach your node. " }), "The app won't switch by itself: other nodes would see your IP address.", h('button', { class: 'btn btn-primary btn-small node-inline-btn', 'data-testid': 'node-use-random', onclick: pickRandom }, 'Use random nodes'))
          : null,
        h(
          'div',
          { class: 'card', 'data-testid': 'node-status' },
          h('h3', { 'data-testid': 'node-connection', text: down ? 'Your node' : connected ? 'Connected to your node' : 'Connecting to your node…' }),
          h('p', { class: 'mono', 'data-testid': 'node-address', text: app.prefs.node }),
          h('p', { class: 'small', 'data-testid': 'node-key-status', text: ownNodeKeyText(app, s) }),
        ),
        confirmed ? null : keyLine(),
        h('button', { class: 'btn btn-secondary', 'data-testid': 'node-change', onclick: () => app.go('ownNode', { edit: true }) }, 'Change address'),
      );
    } else {
      const title = sync.reconnecting ? 'Reconnecting to another node…' : connected ? 'Connected to' : s.node ? 'Connecting to' : 'Not connected';
      put(
        statusBox,
        h(
          'div',
          { class: 'card', 'data-testid': 'node-status' },
          h('h3', { 'data-testid': 'node-connection', text: title }),
          s.node && !sync.reconnecting ? h('p', { class: 'mono', 'data-testid': 'node-address', text: s.node }) : null,
        ),
      );
    }
  }

  const el = screen(
    { title: 'BEAM node', back: () => app.back('settings'), cls: 'settings node-screen' },
    h('p', { class: 'lead', text: 'How this wallet reaches the BEAM network.' }),
    h(
      'div',
      { class: 'card list', role: 'radiogroup', 'aria-label': 'BEAM node' },
      choice(!own, 'Random node', "BEAM's own nodes. If one stops answering, the app moves to another by itself. Receives online payments.", pickRandom, 'node-random'),
      choice(own, 'Your own node', "A BEAM node you run, and only that one. With this wallet's owner key it also receives offline and max-privacy payments.", () => app.go('ownNode', { edit: own }), 'node-own'),
    ),
    statusBox,
    h('p', { class: 'small', 'data-testid': 'node-ip-line' }, icon('shield', 'inline-icon'), ' The node you connect to can see your IP address.'),
  );
  renderStatus(wallet.state);
  const off = wallet.onChange((s) => renderStatus(s));
  return { el, destroy: off };
}
