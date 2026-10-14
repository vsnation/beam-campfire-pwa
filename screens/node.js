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
import { t, tk, tNodes } from '../lib/i18n.js';

// One sentence with the way to the key as a button inside it ({path}); shown with tNodes(OWNER_KEY_LINE, { path })
// and t(OWNER_KEY_PATH), here and on Your own node.
export const OWNER_KEY_LINE = tk("Your node needs this wallet's owner key: {path}");
export const OWNER_KEY_PATH = tk('Settings → Backup → Show owner key');
export const CHECK_IP_LINE = tk('Checking connects to each node from this device, so they see your IP address.');
const CHECK_TIMEOUT_MS = 8000;
const fmt = (n) => Number(n).toLocaleString('en-US');
const withId = (id, el) => (el.setAttribute('data-testid', id), el);

/** What the person's own node can receive, in words; from the engine once it has said. */
export function ownNodeKeyText(app, s) {
  const confirmed = s.connEvent && s.connEvent.node_connected ? s.connEvent.own_node === true : null;
  if (confirmed === true) return t("It has this wallet's owner key: online, offline and max-privacy payments can be received.");
  if (confirmed === false && app.prefs.ownNodeKey) return t("It doesn't know this wallet's owner key yet: online payments only. Check the key your node was started with.");
  if (app.prefs.ownNodeKey) return t("Started with this wallet's owner key: offline and max-privacy payments too, once it connects.");
  return t("Online payments only. With this wallet's owner key, it could also receive offline and max-privacy payments.");
}

/** Asks for Face ID or the password, then moves the wallet from its own node to BEAM's public nodes. */
export async function switchToRandom(app, { first = null } = {}) {
  const ok = await confirmIdentity(app, {
    title: first ? t('Use {node}?', { node: nodeName(first) }) : t("Use BEAM's public nodes?"),
    detail: first
      ? t("Your wallet connects through BEAM's public nodes again, starting with {node}. They can see your IP address.", { node: nodeName(first) })
      : t("Your wallet connects through BEAM's public nodes again. They can see your IP address."),
    cta: first ? t('Use {node}', { node: nodeName(first) }) : t("Use BEAM's public nodes"),
  });
  if (!ok) return false;
  toast(t("Connecting through BEAM's public nodes…"));
  try {
    await useRandomNodes(app, { first });
    toast(t("Connected through BEAM's public nodes"));
    return true;
  } catch (e) {
    toast(t("Couldn't switch: {reason}", { reason: e.message }));
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
    h('p', { class: 'small', 'data-testid': 'owner-key-line' }, ...tNodes(OWNER_KEY_LINE, { path: h('button', { class: 'btn btn-text link-line', onclick: () => app.go('ownerKey', { from: 'nodeSettings' }), 'data-testid': 'owner-key-link' }, t(OWNER_KEY_PATH)) }));

  function renderStatus(s) {
    const sync = s.sync || {};
    const connected = s.nodeConnected && s.everConnected;
    const height = s.status ? Number(s.status.current_height) || 0 : 0;
    const blockLine = connected && height ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Newest block') }), h('span', { class: 'v', 'data-testid': 'node-height', text: fmt(height) })) : null;
    if (own) {
      const down = sync.state === 'offline';
      put(
        statusBox,
        down
          ? notice('error', h('strong', { text: `${t("Can't reach your node.")} ` }), t("The app won't switch by itself: other nodes would see your IP address."), h('button', { class: 'btn btn-primary btn-small node-inline-btn', 'data-testid': 'node-use-random', onclick: () => leaveOwn() }, t("Use BEAM's public nodes")))
          : null,
        h(
          'div',
          { class: 'card', 'data-testid': 'node-status' },
          h('h3', { 'data-testid': 'node-connection', text: down ? t('Your node') : connected ? t('Connected to your node') : t('Connecting to your node…') }),
          h('p', { class: 'mono', 'data-testid': 'node-address', text: app.prefs.node }),
          h('p', { class: 'small', 'data-testid': 'node-key-status', text: ownNodeKeyText(app, s) }),
          blockLine,
          syncLine(sync),
        ),
      );
    } else {
      // A heading over the node's address (the line under it).
      const title = sync.reconnecting ? t('Reconnecting to another node…') : connected ? t('Connected to') : s.node ? t('Connecting to') : t('Not connected');
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
          h('div', { class: 't' }, name, v.inUse ? h('span', { class: 'tag private node-tag', 'data-testid': `node-${name}-in-use`, text: t('In use') }) : null),
          h('div', { class: 's', 'data-testid': `node-${name}-state`, text: v.text }),
        ),
        v.canUse ? h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: busy, 'data-testid': `node-${name}-use`, onclick: () => useNode(v.a) }, t('Use this one')) : null,
      );
    });
    put(
      nodesBox,
      h(
        'div',
        { class: 'card list public-nodes', 'data-testid': 'public-nodes' },
        h('h3', {}, icon('globe', 'inline-icon'), ` ${t("BEAM's public nodes")}`),
        h('p', { class: 'small', text: own ? t('Not in use: your wallet talks to your own node only.') : t('The wallet talks to one of these and moves to the next by itself when one stops answering.') }),
        allDown
          ? withId('nodes-all-down', notice(
              'warn',
              h('strong', { text: `${t("None of BEAM's public nodes is answering this browser right now.")} ` }),
              ...tNodes('Your coins are safe on the blockchain, and the wallet keeps trying by itself. If you run a BEAM node, you can {own}.', {
                own: h('button', { class: 'btn btn-text link-line', type: 'button', 'data-testid': 'nodes-all-down-own', onclick: () => app.go('ownNode', { edit: false }) }, t('use your own node')),
              }),
            ))
          : null,
        first
          ? h('p', { class: 'small', 'data-testid': 'node-first' }, `${t('It starts on {node} each time it opens.', { node: nodeName(first) })} `, h('button', { class: 'btn btn-text link-line', type: 'button', disabled: busy, 'data-testid': 'node-forget-first', onclick: forgetFirst }, t('Start on any node')))
          : null,
        ...rows,
        h(
          'div',
          { class: 'node-check' },
          own
            ? secondary(checking ? t('Checking…') : t("Check BEAM's public nodes"), () => checkAll(), { disabled: checking, 'data-testid': 'node-check' })
            : h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: checking, 'data-testid': 'node-check', onclick: () => checkAll() }, icon('refresh', 'inline-icon'), ` ${checking ? t('Checking…') : t('Check again')}`),
          h('p', { class: 'small', 'data-testid': 'node-check-line', text: t(CHECK_IP_LINE) }),
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
          h('span', { class: 'main' }, h('div', { class: 't' }, t('Your own node'), own ? h('span', { class: 'tag private node-tag', text: t('In use') }) : null), h('div', { class: 's wrap', text: t("A BEAM node you run, and only that one. With this wallet's owner key it also receives offline and max-privacy payments.") })),
          h('span', { class: 'chev' }, icon('chevron')),
        ),
      ),
      own && !confirmed ? keyLine() : null,
      own ? h('button', { class: 'btn btn-secondary', 'data-testid': 'node-change', onclick: () => app.go('ownNode', { edit: true }) }, t('Change address')) : null,
      // Down: the notice at the top carries this button.
      own && !down ? h('button', { class: 'btn btn-secondary', 'data-testid': 'node-use-public', onclick: () => leaveOwn() }, t("Use BEAM's public nodes")) : null,
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
    put(msg, notice('info', t('Connecting to {node}…', { node: name })));
    renderNodes(wallet.state);
    try {
      await usePoolNode(app, address);
      if (gone) return;
      toast(t('Using {node}', { node: name }));
      app.go('nodeSettings', {}, { replace: true });
    } catch (e) {
      busy = false;
      put(msg, notice('error', t('It did not switch: {reason}', { reason: e.message })));
      renderNodes(wallet.state);
    }
  }

  async function forgetFirst() {
    if (busy) return;
    await forgetPoolNode(app);
    toast(t('Starts on any of the nodes from now on'));
    lastNodes = '';
    renderNodes(wallet.state);
  }

  const el = screen(
    { title: t('BEAM node'), back: () => app.back('settings'), cls: 'settings node-screen' },
    h('p', { class: 'lead', text: t('How this wallet reaches the BEAM network.') }),
    statusBox,
    msg,
    nodesBox,
    ownBox,
    h('p', { class: 'small', 'data-testid': 'node-ip-line' }, icon('shield', 'inline-icon'), ` ${t('The node you connect to can see your IP address.')}`),
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
