/* Hidden tokens (Settings)
 * Spec: ONE job: bring back a token I hid from Wallet.
 *       Primary CTA: "Show" on the token's row (one per token); none hidden: "Back to Wallet".
 *       Taps from app open: 2 (Settings -> Hidden tokens), 3 to show one again.
 * Exit-intent reasons and answers:
 *   - "Did hiding delete my tokens?" -> said at the top: hidden tokens stay in the wallet, only Wallet's list
 *     and its total leave them out; each row shows what the wallet holds of it.
 *   - "Where did my token go?" -> every hidden token is listed here, held or not, with its number.
 *   - "Nothing here" -> says how a token is hidden, and goes back to Wallet in one tap.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, assetBadge, primary, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { tokenSubtitle } from '../lib/meta.js';
import { hiddenIds, hiddenLoaded, setTokenHidden } from '../lib/hidden_tokens.js';

export default function hiddenTokens(app) {
  const body = h('div', { class: 'content-inner' });

  function render(s) {
    if (!hiddenLoaded(app)) return put(body);
    const ids = [...hiddenIds(app)].sort((a, b) => a - b);
    if (!ids.length) {
      return put(
        body,
        h('div', { class: 'card empty', 'data-testid': 'hidden-tokens-empty' }, icon('eye'), h('p', { text: 'No hidden tokens. To hide one, tap it on Wallet, then "Hide from Wallet".' }), primary('Back to Wallet', () => app.go('home'), { 'data-testid': 'hidden-tokens-home' })),
      );
    }
    put(
      body,
      h('p', { class: 'small', text: 'These stay in your wallet; Wallet just leaves them out of its list and its total. Tap a token to open it.' }),
      h(
        'div',
        { class: 'card list', 'data-testid': 'hidden-tokens' },
        ...ids.map((id) => {
          const l = wallet.label(id);
          const t = s.totals.get(id);
          const have = t ? t.available + t.receiving + t.maturing : 0n;
          return h(
            'div',
            { class: 'row asset-row', 'data-testid': 'hidden-token-row', 'data-asset-id': String(id) },
            h('button', { class: 'row-open', type: 'button', 'aria-label': `Open ${l.label}`, onclick: () => app.go('token', { assetId: id }) }, assetBadge(l), h('span', { class: 'main' }, h('div', { class: 't', text: l.name }), h('div', { class: 's', text: `${tokenSubtitle(l)} · ${have > 0n ? `${formatAmount(have)} ${l.pool ? 'LP' : l.symbol}` : 'none held'}` }))),
            h(
              'button',
              {
                class: 'btn btn-secondary btn-small',
                type: 'button',
                'data-testid': 'hidden-token-show',
                onclick: async () => {
                  await setTokenHidden(app, id, false);
                  toast(`${l.label} is back on Wallet`);
                },
              },
              'Show',
            ),
          );
        }),
      ),
    );
  }

  const off = wallet.onChange(render);
  render(wallet.state);
  const el = screen({ title: 'Hidden tokens', back: () => app.back('settings') }, body);
  return { el, destroy: () => off() };
}
