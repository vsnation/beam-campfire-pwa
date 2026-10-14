/* BEAM node (Settings -> BEAM node; also the signal bars on Home)
 * Spec: ONE job: choose how this wallet reaches the BEAM network: BEAM's public nodes (the app picks
 *       one and moves on by itself; zero taps), one of them in particular, or your own node.
 *       Primary CTA: none while BEAM's nodes work (nothing to do); "Use this one" on any public node
 *       that answers; "Use BEAM's public nodes" when your own node is in use or down.
 *       Taps from app open: 1 (the signal bars on Home), 2 to use a particular node.
 *       From Settings: 1 (BEAM node), 2 (Use this one).
 * Exit-intent reasons and answers:
 *   - "Is it connected?" -> the node in use and the newest block it gave, live, at the top.
 *   - "The one in use is dead" -> every public node with its newest block and how fast it answered,
 *     checked from this device when the screen opens; "Use this one" on any that answers. The wallet
 *     also moves on by itself when a node stops answering, even one picked here.
 *   - "Why are they all 'Not answering'?" -> said as it is: a node this browser cannot reach shows
 *     "Not answering", never a spinner that does not end (13 Oct 2026: BEAM's certificates lapsed);
 *     when none answers, one notice says the coins are safe, the wallet keeps trying, and links to
 *     your own node (the one thing that still works then).
 *   - "Who sees my IP?" -> one line: checking connects to each node, so they see your IP address;
 *     and the node in use sees it too. With your own node nothing is checked unless you tap.
 *   - "Will I lose anything?" -> no: moving to another public node keeps the wallet open, the balance
 *     on screen and payments under way (they resume on the new node).
 *   - "My node is down and nothing works" -> said plainly, with "Use BEAM's public nodes" one tap away;
 *     the app never falls back by itself, because that would show your IP address to nodes you chose
 *     not to use.
 * Rules not met (USER_PSYCHOLOGY.md 1.3): no single primary button while BEAM's nodes work; the job is
 * done with zero taps then, and the row buttons are equal choices.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice, secondary } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { wallet } from '../lib/wallet.js';
import { openPoolSocket } from '../lib/engine.js';
import { NODES, nodeName, isPoolNode } from '../lib/nodes.js';
import { isOwnNode, useRandomNodes, usePoolNode, forgetPoolNode } from '../lib/own_node.js';
import { syncLine } from './home.js';
import { nodeRowState } from '../lib/node_rows.js';

export const OWNER_KEY_LEAD = "Your node needs this wallet's owner key: ";
export const OWNER_KEY_PATH = 'Settings → Backup → Show owner key';
export const CHECK_IP_LINE = 'Checking connects to each node from this device, so they see your IP address.';
const CHECK_TIMEOUT_MS = 8000;
const fmt = (n) => Number(n).toLocaleString('en-US');
const withId = (id, el) => (el.setAttribute('data-testid', id), el);

/** What the person's own node can receive, in words; from the engine once it has said. */
export function ownNodeKeyText(app, s) {
  const confirmed = s.connEvent && s.connEvent.node_connected ? s.connEvent.own_node === true : null;
  if (confirmed === true) return "It has this wallet's owner key: online, offline and max-privacy payments can be received.";
  if (confirmed === false && app.prefs.ownNodeKey) return "It doesn't know this wallet's owner key yet: online payments only. Check the key your node was started with.";
  if (app.prefs.ownNodeKey) return "Started with this wallet's owner key: offline and max-privacy payments too, once it connects.";
  return "Online payments only. With this wallet's owner key, it could also receive offline and max-privacy payments.";
}

/** Asks for Face ID or the password, then moves the wallet from its own node to BEAM's public nodes. */
export async function switchToRandom(app, { first = null } = {}) {
  const ok = await confirmIdentity(app, {
    title: first ? `Use ${nodeName(first)}?` : "Use BEAM's public nodes?",
    detail: `Your wallet connects through BEAM's public nodes again${first ? `, starting with ${nodeName(first)}` : ''}. They can see your IP address.`,
    cta: first ? `Use ${nodeName(first)}` : "Use BEAM's public nodes",
  });
  if (!ok) return false;
  toast("Connecting through BEAM's public nodes…");
  try {
    await useRandomNodes(app, { first });
    toast("Connected through BEAM's public nodes");
    return true;
  } catch (e) {
    toast(`Couldn't switch: ${e.message}`);
    return false;
  }
}

export default function nodeSettings(app) {
  const own = isOwnNode(app.prefs.node);
  const statusBox = h('div', { class: 'node-status-box', 'aria-live': 'polite' });
  const nodesBox = h('div');
  const ownBox = h('div');
  const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'node-msg' });
  /** address -> {state: 'checking' | 'ok' | 'down', height?, ms?} */
  const checks = new Map();
  let busy = false;
  let checking = false;
  let gone = false;
  let lastNodes = '';

  async function leaveOwn(first = null) {
    if (busy) return;
    busy = true;
    try {
      if (await switchToRandom(app, { first })) app.go('nodeSettings', {}, { replace: true });
    } finally {
      busy = false;
    }
  }

  const keyLine = () =>
    h('p', { class: 'small', 'data-testid': 'owner-key-line' }, OWNER_KEY_LEAD, h('button', { class: 'btn btn-text link-line', onclick: () => app.go('ownerKey', { from: 'nodeSettings' }), 'data-testid': 'owner-key-link' }, OWNER_KEY_PATH));

  function renderStatus(s) {
    const sync = s.sync || {};
    const connected = s.nodeConnected && s.everConnected;
    const height = s.status ? Number(s.status.current_height) || 0 : 0;
    const blockLine = connected && height ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Newest block' }), h('span', { class: 'v', 'data-testid': 'node-height', text: fmt(height) })) : null;
    if (own) {
      const down = sync.state === 'offline';
      put(
        statusBox,
        down
          ? notice('error', h('strong', { text: "Can't reach your node. " }), "The app won't switch by itself: other nodes would see your IP address.", h('button', { class: 'btn btn-primary btn-small node-inline-btn', 'data-testid': 'node-use-random', onclick: () => leaveOwn() }, "Use BEAM's public nodes"))
          : null,
        h(
          'div',
          { class: 'card', 'data-testid': 'node-status' },
          h('h3', { 'data-testid': 'node-connection', text: down ? 'Your node' : connected ? 'Connected to your node' : 'Connecting to your node…' }),
          h('p', { class: 'mono', 'data-testid': 'node-address', text: app.prefs.node }),
          h('p', { class: 'small', 'data-testid': 'node-key-status', text: ownNodeKeyText(app, s) }),
          blockLine,
          syncLine(sync),
        ),
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
          blockLine,
          syncLine(sync),
        ),
      );
    }
    renderNodes(s);
    renderOwn(s);
  }

  function renderNodes(s) {
    if (gone) return;
    // "Behind" is measured against the wallet's own block only: the engine checks the chain it follows,
    // while a check only hears what a node says. One node claiming a huge height cannot make the
    // others look behind and steer a pick.
    const walletHeight = s.nodeConnected && s.status ? Number(s.status.current_height) || 0 : 0;
    const first = !own && isPoolNode(app.prefs.poolNode) ? app.prefs.poolNode : null;
    const views = NODES.map((a) => ({ a, ...nodeRowState(a, s, own, checks.get(a), walletHeight) }));
    // The wallet's state changes every few seconds: redraw only when a row would read differently.
    // None answers this browser (13 Oct 2026: BEAM's certificates lapsed): said once, with what still works.
    const allDown = !own && !checking && views.every((v) => v.cls === 'bad');
    const key = JSON.stringify([views, first, busy, checking, allDown]);
    if (key === lastNodes) return;
    lastNodes = key;
    const rows = views.map((v) => {
      const name = nodeName(v.a);
      return h(
        'div',
        { class: `row node-row${v.inUse ? ' on' : ''}`, 'data-testid': `node-${name}`, 'data-state': v.cls, 'data-in-use': String(v.inUse) },
        h('span', { class: 'ico' }, h('span', { class: `dot ${v.cls}` })),
        h(
          'span',
          { class: 'main' },
          h('div', { class: 't' }, name, v.inUse ? h('span', { class: 'tag private node-tag', 'data-testid': `node-${name}-in-use`, text: 'In use' }) : null),
          h('div', { class: 's', 'data-testid': `node-${name}-state`, text: v.text }),
        ),
        v.canUse ? h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: busy, 'data-testid': `node-${name}-use`, onclick: () => useNode(v.a) }, 'Use this one') : null,
      );
    });
    put(
      nodesBox,
      h(
        'div',
        { class: 'card list public-nodes', 'data-testid': 'public-nodes' },
        h('h3', {}, icon('globe', 'inline-icon'), " BEAM's public nodes"),
        h('p', { class: 'small', text: own ? 'Not in use: your wallet talks to your own node only.' : 'The wallet talks to one of these and moves to the next by itself when one stops answering.' }),
        allDown
          ? withId('nodes-all-down', notice(
              'warn',
              h('strong', { text: "None of BEAM's public nodes is answering this browser right now. " }),
              'Your coins are safe on the blockchain, and the wallet keeps trying by itself. If you run a BEAM node, you can ',
              h('button', { class: 'btn btn-text link-line', type: 'button', 'data-testid': 'nodes-all-down-own', onclick: () => app.go('ownNode', { edit: false }) }, 'use your own node'),
              '.',
            ))
          : null,
        first
          ? h('p', { class: 'small', 'data-testid': 'node-first' }, `It starts on ${nodeName(first)} each time it opens. `, h('button', { class: 'btn btn-text link-line', type: 'button', disabled: busy, 'data-testid': 'node-forget-first', onclick: forgetFirst }, 'Start on any node'))
          : null,
        ...rows,
        h(
          'div',
          { class: 'node-check' },
          own
            ? secondary(checking ? 'Checking…' : "Check BEAM's public nodes", () => checkAll(), { disabled: checking, 'data-testid': 'node-check' })
            : h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: checking, 'data-testid': 'node-check', onclick: () => checkAll() }, icon('refresh', 'inline-icon'), checking ? ' Checking…' : ' Check again'),
          h('p', { class: 'small', 'data-testid': 'node-check-line', text: CHECK_IP_LINE }),
        ),
      ),
    );
  }

  function renderOwn(s) {
    const confirmed = own && s.connEvent && s.connEvent.node_connected && s.connEvent.own_node === true;
    const down = own && (s.sync || {}).state === 'offline';
    put(
      ownBox,
      h(
        'div',
        { class: 'card list' },
        h(
          'button',
          { class: 'row', type: 'button', onclick: () => app.go('ownNode', { edit: own }), 'data-testid': 'node-own' },
          h('span', { class: 'ico' }, icon('shield')),
          h('span', { class: 'main' }, h('div', { class: 't' }, 'Your own node', own ? h('span', { class: 'tag private node-tag', text: 'In use' }) : null), h('div', { class: 's wrap', text: "A BEAM node you run, and only that one. With this wallet's owner key it also receives offline and max-privacy payments." })),
          h('span', { class: 'chev' }, icon('chevron')),
        ),
      ),
      own && !confirmed ? keyLine() : null,
      own ? h('button', { class: 'btn btn-secondary', 'data-testid': 'node-change', onclick: () => app.go('ownNode', { edit: true }) }, 'Change address') : null,
      // Down: the notice at the top carries this button.
      own && !down ? h('button', { class: 'btn btn-secondary', 'data-testid': 'node-use-public', onclick: () => leaveOwn() }, "Use BEAM's public nodes") : null,
    );
  }

  /** Every public node not in use, at once: its newest block and how fast it answered. */
  async function checkAll() {
    if (checking || gone) return;
    checking = true;
    const s = wallet.state;
    const todo = NODES.filter((a) => own || !(s.node === a && s.nodeConnected));
    for (const a of todo) checks.set(a, { state: 'checking' });
    renderNodes(wallet.state);
    try {
      const { checkTip } = await import('../lib/node_tip.js');
      await Promise.all(
        todo.map(async (a) => {
          const r = await checkTip(() => openPoolSocket(a), { timeoutMs: CHECK_TIMEOUT_MS });
          checks.set(a, r.ok ? { state: 'ok', height: r.height, ms: r.ms } : { state: 'down' });
          renderNodes(wallet.state);
        }),
      );
    } catch (e) {
      console.warn('[campfire] node check', e.message);
      for (const a of todo) if (checks.get(a).state === 'checking') checks.set(a, { state: 'down' });
    } finally {
      checking = false;
      renderNodes(wallet.state);
    }
  }

  async function useNode(address) {
    if (busy) return;
    if (own) return leaveOwn(address);
    busy = true;
    const name = nodeName(address);
    put(msg, notice('info', `Connecting to ${name}…`));
    renderNodes(wallet.state);
    try {
      await usePoolNode(app, address);
      if (gone) return;
      toast(`Using ${name}`);
      app.go('nodeSettings', {}, { replace: true });
    } catch (e) {
      busy = false;
      put(msg, notice('error', `It did not switch: ${e.message}`));
      renderNodes(wallet.state);
    }
  }

  async function forgetFirst() {
    if (busy) return;
    await forgetPoolNode(app);
    toast('Starts on any of the nodes from now on');
    lastNodes = '';
    renderNodes(wallet.state);
  }

  const el = screen(
    { title: 'BEAM node', back: () => app.back('settings'), cls: 'settings node-screen' },
    h('p', { class: 'lead', text: 'How this wallet reaches the BEAM network.' }),
    statusBox,
    msg,
    nodesBox,
    ownBox,
    h('p', { class: 'small', 'data-testid': 'node-ip-line' }, icon('shield', 'inline-icon'), ' The node you connect to can see your IP address.'),
  );
  renderStatus(wallet.state);
  const off = wallet.onChange((s) => renderStatus(s));
  // On BEAM's public nodes the wallet talks to them anyway: check them all as the screen opens.
  // Someone on their own node chose to talk to no one else: only on their tap.
  if (!own) checkAll();
  return {
    el,
    destroy() {
      gone = true;
      off();
    },
  };
}
