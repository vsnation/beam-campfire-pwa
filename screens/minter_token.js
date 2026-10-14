/* A token you created (its page)
 * Spec: ONE job: see one token of yours as the chain has it: how much exists, how much more can, what it says.
 *       Primary CTA: "Mint more" (when it can still be minted); "Burn" beside it when this wallet holds some.
 *       Taps from app open: Tokens (1) -> My tokens (2) -> the token (3).
 * Exit-intent reasons and answers:
 *   - "Is this mine / can I mint it?" -> said in words, from the Minter itself (this wallet's key).
 *   - "What did I write when I made it?" -> its description, colour and website as stored on the chain.
 *   - "It didn't load" -> what happened, nothing was sent, and Try again.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { unlimited, metadataFields } from '../lib/minter.js';
import { cleanText } from '../lib/meta.js';
import { minter, tokenAmount, limitText, rememberMetadata, problemNotice, tokenTitle, forgetOnLock } from './minter.js';
import { mintedShare } from './minter_tokens.js';
import { syncReason } from '../lib/sync.js';

export default function minterToken(app, p = {}) {
  forgetOnLock(app);
  const assetId = Number(p.assetId);
  let token = null;
  let missing = false;
  let error = null;
  let alive = true;
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });

  function render() {
    if (!alive) return;
    if (error || missing) {
      put(body, problemNotice(error || { code: 'noSuchToken' }, 'token-problem'));
      put(actions, primary('Try again', load, { 'data-testid': 'token-retry' }));
      return;
    }
    if (!token) {
      put(body, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { class: 'small', text: 'Reading the token from the Minter…' })));
      put(actions);
      return;
    }
    const t = token;
    title.textContent = wallet.label(assetId).unit;
    const f = metadataFields(t.metadata) || {};
    const held = wallet.available(assetId);
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    const stack = (k, v, testid) => h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: k }), h('span', { class: 'v plain', 'data-testid': testid, text: v }));
    const share = mintedShare(t);
    const bar = h('div', { class: 'progress token-bar' }, h('div'));
    if (share != null) bar.firstChild.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
    // Chain text is untrusted: printable characters only, and never a link.
    const text = (v, max) => (v == null ? null : cleanText(v, max));
    const desc = text(f.OPT_SHORT_DESC, 128);
    const long = text(f.OPT_LONG_DESC, 1024);
    const site = text(f.OPT_SITE_URL, 512);
    const color = /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(f.OPT_COLOR || '') ? f.OPT_COLOR.toUpperCase() : null;
    put(
      body,
      h('div', { class: 'card' }, tokenTitle(assetId, `${wallet.label(assetId).symbol} · #${assetId}`), share != null ? bar : null),
      h(
        'div',
        { class: 'card flat swap-details', 'data-testid': 'token-facts' },
        kv('Minted so far', tokenAmount(assetId, t.minted), 'token-minted'),
        kv('Maximum supply', limitText(assetId, t.limit), 'token-limit'),
        unlimited(t.limit) ? null : kv('Can still be minted', tokenAmount(assetId, t.mintable), 'token-mintable'),
        kv('In this wallet', tokenAmount(assetId, held), 'token-held'),
        kv('Who can mint it', t.isOwner ? 'This wallet' : t.ownerCid ? 'A contract' : 'Another wallet', 'token-owner'),
      ),
      desc || long || color || site
        ? h(
            'div',
            { class: 'card flat swap-details', 'data-testid': 'token-details' },
            desc ? stack('Description', desc, 'token-desc') : null,
            long ? stack('More about it', long, 'token-long-desc') : null,
            color ? kv('Colour', color, 'token-color') : null,
            site ? stack('Website (as written by its creator)', site, 'token-site') : null,
          )
        : null,
      h('p', { class: 'small', text: 'Created with BEAM’s Minter. These details are on the chain for good.' }),
    );
    const canMint = t.isOwner && t.mintable > 0n;
    const why = canMint && !wallet.state.sync.canSend ? h('p', { class: 'hint center', text: `Minting is paused: ${syncReason(wallet.state.sync.title)}.` }) : null;
    put(
      actions,
      why,
      canMint ? primary('Mint more', () => app.go('minterMint', { assetId }), { disabled: !wallet.state.sync.canSend, 'data-testid': 'token-mint' }) : null,
      held > 0n ? (canMint ? secondary : primary)(`Burn ${wallet.label(assetId).unit}`, () => app.go('burn', { assetId }), { 'data-testid': 'token-burn' }) : null,
      !canMint && held === 0n ? h('p', { class: 'small center', text: t.isOwner ? `Every ${wallet.label(assetId).unit} that can exist was minted.` : 'Only the wallet that created this token can mint it.' }) : null,
    );
  }

  async function load() {
    error = null;
    missing = false;
    token = null;
    render();
    try {
      const t = await minter().token(assetId);
      if (!alive) return;
      if (!t) missing = true;
      else {
        rememberMetadata(assetId, t.metadata);
        token = t;
        if (!wallet.assetNamed.has(assetId)) wallet.loadAsset(assetId);
      }
    } catch (e) {
      if (!alive) return;
      error = e;
    }
    render();
  }

  const off = wallet.onChange(() => render());
  const el = screen({ title: wallet.label(assetId).unit, back: () => app.back('minterTokens'), cls: 'minter-token feature sticky-actions' }, body);
  const title = el.querySelector('.topbar h1');
  el.appendChild(actions);
  render();
  load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}

