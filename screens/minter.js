/* Tokens (a sheet over Home): create your own token, the ones you created, burn.
 * Spec: ONE job: pick what to do with tokens of your own.
 *       Primary CTA: none - three rows, one tap each ("Create a token", "My tokens", "Burn tokens"),
 *       as the desktop app's Tokens menu.
 *       Taps from app open: Tokens (1) -> a row (2).
 * Exit-intent reasons and answers:
 *   - "What is this?" -> each row says in one line what it does; creating says what it costs before any field.
 *   - "Is burning safe?" -> the row says it is for good; the burn screens say it twice more before anything is sent.
 *
 * Also what the token screens share: the Minter and the BlackHole of this session, a token's title,
 * plain words for what stopped an action, and the tokens this session just created.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, notice, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { assetLabel, tokenSubtitle, copyWarning } from '../lib/meta.js';
import { minterFor, minterProblem, unlimited } from '../lib/minter.js';
import { burnFor } from '../lib/burn.js';
import { syncReason } from '../lib/sync.js';

/** The Minter for the running wallet (one per session). */
export const minter = () => minterFor(wallet.session);
/** Burns for the running wallet (one per session). */
export const burner = () => burnFor(wallet.session);

/** "1,000 MYT", every digit; the ticker as money screens write it ("PEPE #94" for an unverified one). */
export const tokenAmount = (assetId, amount) => `${formatAmount(amount)} ${wallet.label(assetId).unit}`;

/** A ceiling as people read it: "1,000,000 MYT", or "No maximum". */
export const limitText = (assetId, limit) => (unlimited(limit) ? 'No maximum' : tokenAmount(assetId, limit));

/** Metadata the Minter printed for a token: every screen names it from now on. */
export function rememberMetadata(assetId, metadata) {
  if (typeof metadata !== 'string' || !assetId) return;
  if (wallet.assetNamed.has(assetId)) return;
  wallet.assetMeta.set(assetId, assetLabel(assetId, metadata));
  wallet.assetNamed.add(assetId);
}

/** The words and the notice for whatever stopped an action; `testid` and the error code go on the notice. */
export function problemNotice(e, testid, kind = null) {
  const p = minterProblem(e);
  const el = notice(kind || (e && e.code === 'rejected' ? 'info' : 'error'), h('strong', { text: `${p.title}. ` }), p.message);
  el.dataset.testid = testid;
  el.dataset.code = (e && e.code) || 'error';
  return el;
}

/** A token's badge, name and the line under it, with the copy warning where one applies. */
export function tokenTitle(assetId, sub = null) {
  const l = wallet.label(assetId);
  const warning = copyWarning(l);
  return h(
    'div',
    { class: 'row asset-row token-title' },
    assetBadge(l),
    h(
      'span',
      { class: 'main' },
      h('div', { class: 't', 'data-testid': 'token-title-name', text: l.name }),
      h('div', { class: 's', text: sub || tokenSubtitle(l) }),
      warning ? h('div', { class: 'warn-line', text: warning }) : null,
    ),
  );
}

/** "Creating a token is paused: syncing." when the wallet cannot spend right now, else null. */
export function pausedReason(what) {
  const s = wallet.state.sync;
  return s.canSend ? null : `${what} is paused: ${syncReason(s.title)}.`;
}

let hooked = false;
/** What the token screens keep between visits (a draft, tokens being created) is forgotten on lock. */
export function forgetOnLock(app) {
  if (hooked || !app.lockHooks) return;
  hooked = true;
  app.lockHooks.add(() => {
    app.minterDraft = null;
    app.minterPending = null;
    app.burnDraft = null;
  });
}

/** Tokens created in this session whose transaction has not settled: shown on My tokens until they do. */
export function pendingTokens(app) {
  const list = app.minterPending || [];
  const byId = new Map(wallet.state.txs.map((t) => [t.txId, t]));
  return list
    .map((p) => {
      const t = byId.get(p.txId);
      const status = t ? Number(t.status) : 0;
      return { ...p, status: status === 3 ? 'done' : status === 4 || status === 2 ? 'failed' : 'pending' };
    })
    .filter((p) => p.status !== 'done' || Date.now() - p.at < 30 * 60000);
}

/** The Tokens menu: the desktop's three tasks, each with what it does in one line. */
export function openTokensMenu(app) {
  const row = (testid, ico, title, detail, to) =>
    h(
      'button',
      {
        class: 'row tokens-menu-row',
        type: 'button',
        'data-testid': testid,
        onclick: () => {
          sheet.close(true);
          app.go(to);
        },
      },
      h('span', { class: 'ico out' }, icon(ico)),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's wrap', text: detail })),
      h('span', { class: 'chev' }, icon('chevron')),
    );
  const sheet = openSheet(
    (close) => [
      h('p', { class: 'overline', text: 'Tokens' }),
      h('h2', { 'data-testid': 'tokens-menu-title', text: 'Your own token on BEAM' }),
      h(
        'div',
        { class: 'card list', 'data-testid': 'tokens-menu' },
        row('tokens-create', 'buy', 'Create a token', 'Your own asset on BEAM, named by you', 'minterCreate'),
        row('tokens-mine', 'coins', 'My tokens', 'Tokens you created: see them, mint more', 'minterTokens'),
        row('tokens-burn', 'flame', 'Burn tokens', 'Destroy tokens you hold, for good', 'burn'),
      ),
      h('button', { class: 'btn btn-text', onclick: () => close(false), 'data-testid': 'tokens-menu-close' }, 'Not now'),
    ],
    { label: 'Tokens' },
  );
  return sheet;
}
