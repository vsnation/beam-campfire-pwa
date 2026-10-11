// The token pieces other screens show: Home's token list (each row opens the
// token's page), the total across BEAM and the tokens, the one-time question
// before any price is asked of CoinGecko, and the Settings rows for prices and
// hidden tokens. The rules live in lib/tokens.js, lib/pricer.js and lib/fiat.js.
//
// Home's exit-intent reasons, for these parts:
//   - "What is all this worth?" -> the BEAM balance in dollars (once allowed) and a total with the tokens,
//     marked as an estimate; tokens without a price are left out and counted, never shown as 0.
//   - "Why does it want CoinGecko?" -> asked once, saying CoinGecko sees the IP address; "Not now" is
//     remembered, and Settings can turn it on later.
//   - "Spam airdrops clutter my list" -> a token can be hidden from its page; "Show N hidden tokens" under
//     the list (and Settings -> Hidden tokens) brings them back.
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { assetBadge, secondary, textButton, toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { tokenSubtitle, copyWarning } from '../lib/meta.js';
import { holdings, holdsAny, portfolio, beamEstimate, valueEstimate, tokensWord, NO_PRICE } from '../lib/tokens.js';
import { hiddenIds, hiddenLoaded, loadHidden } from '../lib/hidden_tokens.js';
import { fiatEstimate, fiatAllowed, fiatUnasked, currencyOf, currencyWords, FIAT_CURRENCIES } from '../lib/fiat.js';
import { marketPricer, refreshMarket, beamPrice } from '../lib/token_market.js';
import { maturingParts } from './coins_ui.js';

/** BEAM's price to show now ({price, currency}), asking CoinGecko in the background when due and allowed. */
export const priceNow = (app) => beamPrice(app).get();

/** "≈ $2.31" or the BEAM estimate, for a token row; "" while prices are unknown. */
function rowValue(app, hd, pricer, price) {
  if (!pricer) return '';
  if (hd.value == null) return NO_PRICE;
  const money = fiatEstimate(hd.value, price);
  return money ? `${money}${hd.sale ? ' if sold now' : ''}` : valueEstimate(hd.value, hd.sale);
}

/** The question before any price is asked: once, remembered either way. */
function priceQuestion(app, onAnswer) {
  const words = currencyWords(currencyOf(app.prefs));
  const answer = async (yes) => {
    await app.setPrefs({ fiatPrices: yes });
    if (yes) beamPrice(app).refresh({ force: true });
    else toast(`No prices are asked. Settings → Values in ${words} turns them on.`, 4000);
    onAnswer();
  };
  return h(
    'div',
    { class: 'card price-ask', 'data-testid': 'price-ask' },
    h('h3', { text: `Show values in ${words}?` }),
    h('p', { class: 'small', text: "This asks CoinGecko for BEAM's price; it sees your IP address, not your wallet. Token values come from BEAM's DEX and ask no one." }),
    h('div', { class: 'btn-row prompt-actions' }, secondary(`Show in ${words}`, () => answer(true), { class: 'btn btn-secondary btn-small', 'data-testid': 'price-allow' }), textButton('Not now', () => answer(false), { class: 'btn btn-text btn-small', 'data-testid': 'price-refuse' })),
  );
}

/**
 * Home's token parts. el: the price question and the token list (placed under
 * the buttons); fiatLine(s) and totalLines(s): what goes under BEAM's balance
 * (its value, the total with tokens); render(s): call on every wallet change.
 */
export function homeTokens(app) {
  const el = h('div', { class: 'token-home' });
  let showHidden = false;
  let last = null;

  /** BEAM's available balance in the person's currency, under the amount (null without a price). */
  function fiatLine(s) {
    if (!s.status || s.importing) return null;
    const beam = s.totals.get(0) || { available: 0n };
    const money = fiatEstimate(beam.available, priceNow(app));
    return money ? h('div', { class: 'fiat', 'data-testid': 'balance-fiat', text: money }) : null;
  }

  /** The total across BEAM and the tokens on Wallet, and which tokens it leaves out. */
  function totalLines(s) {
    if (!s.status || s.importing || !hiddenLoaded(app)) return [];
    const p = portfolio(s.totals, { hidden: hiddenIds(app), pricer: marketPricer() });
    if (!p) return [];
    const lines = [];
    if (p.priced) {
      const money = fiatEstimate(p.totalGroth, priceNow(app));
      lines.push(h('div', { class: 'pending total-line', 'data-testid': 'portfolio-total', text: `Total with tokens ${beamEstimate(p.totalGroth)}${money ? ` · ${money}` : ''}` }));
    } else {
      lines.push(h('div', { class: 'pending total-line', 'data-testid': 'portfolio-total', text: `Plus ${tokensWord(p.tokens)}` }));
    }
    if (p.unpriced) lines.push(h('div', { class: 'pending', 'data-testid': 'portfolio-note', text: `${tokensWord(p.unpriced)} ${p.unpriced === 1 ? 'has' : 'have'} no price and ${p.unpriced === 1 ? 'is' : 'are'} not counted.` }));
    return lines;
  }

  function render(s) {
    last = s;
    // The hidden list is read once per wallet (milliseconds): no flash of hidden spam before it.
    if (!hiddenLoaded(app)) return put(el);
    const hidden = hiddenIds(app);
    const known = Boolean(s.status) && !s.importing;
    const list = holdings(s.totals, { label: (id) => app.wallet.label(id), hidden, pricer: marketPricer() });
    const visible = list.filter((x) => !x.hidden);
    // Values need the DEX's pools: read when a token is shown (the read is cached a minute).
    if (visible.length) refreshMarket();
    const pricer = marketPricer();
    const price = priceNow(app);
    const hiddenHeld = list.length - visible.length;
    const shown = showHidden ? list : visible;
    const ask = known && fiatUnasked(app.prefs) && [...s.totals.values()].some(holdsAny) ? priceQuestion(app, () => last && render(last)) : null;
    put(
      el,
      ask,
      ...(list.length
        ? [
            h('p', { class: 'section-title', text: 'Tokens' }),
            shown.length
              ? h(
                  'div',
                  { class: 'card list', 'data-testid': 'tokens' },
                  ...shown.map((hd) => {
                    const { id, totals: t } = hd;
                    const l = app.wallet.label(id);
                    const pending = [];
                    if (t.receiving > 0n) pending.push(`+${formatAmount(t.receiving)} incoming`);
                    if (t.sending > 0n) pending.push(`−${formatAmount(t.sending)} outgoing`);
                    pending.push(...maturingParts(t));
                    const warning = copyWarning(l);
                    // Two held assets with one ticker (CHAD #187 and #190) show their numbers.
                    const sub = tokenSubtitle(l);
                    const shownSub = app.wallet.distinctUnit(id) !== l.unit && !sub.includes(`#${id}`) ? `${sub} · #${id}` : sub;
                    const value = rowValue(app, hd, pricer, price);
                    return h(
                      'button',
                      { class: `row asset-row tap${hd.hidden ? ' is-hidden' : ''}`, type: 'button', 'data-testid': 'token-row', 'data-asset-id': String(id), 'data-hidden': hd.hidden ? '1' : null, onclick: () => app.go('token', { assetId: id }) },
                      assetBadge(l),
                      h(
                        'span',
                        { class: 'main' },
                        h('div', { class: 't', 'data-testid': 'token-name', text: l.name }),
                        h('div', { class: 's', 'data-testid': 'token-sub', text: hd.hidden ? `Hidden · ${shownSub}` : shownSub }),
                        warning ? h('div', { class: 'warn-line', 'data-testid': 'token-warning', text: warning }) : null,
                      ),
                      h(
                        'span',
                        { class: 'end' },
                        h('div', { 'data-testid': 'token-balance', text: `${formatAmount(t.available)} ${l.pool ? 'LP' : l.symbol}` }),
                        pending.length ? h('div', { class: 'small', text: pending.join(' · ') }) : null,
                        value ? h('div', { class: 'small', 'data-testid': 'token-value', text: value }) : null,
                      ),
                    );
                  }),
                )
              : null,
            hiddenHeld
              ? h(
                  'button',
                  {
                    class: 'btn btn-text btn-small token-hidden-toggle',
                    type: 'button',
                    'data-testid': 'show-hidden-tokens',
                    onclick: () => {
                      showHidden = !showHidden;
                      render(last);
                    },
                  },
                  icon('eye'),
                  showHidden ? 'Hide them again' : `Show ${hiddenHeld === 1 ? '1 hidden token' : `${hiddenHeld} hidden tokens`}`,
                )
              : null,
          ]
        : []),
    );
  }

  return { el, render, fiatLine, totalLines };
}

/** Settings' rows: prices in the person's currency (with the currency), and the hidden tokens. */
export function tokenSettings(app) {
  const box = h('div');
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  function render() {
    const on = fiatAllowed(app.prefs);
    const cur = currencyOf(app.prefs);
    const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Values in ${currencyWords(cur)}`, 'data-testid': 'price-switch', checked: on });
    sw.addEventListener('change', async () => {
      await app.setPrefs({ fiatPrices: sw.checked });
      if (sw.checked) beamPrice(app).refresh({ force: true });
      else beamPrice(app).forget();
      toast(sw.checked ? `Values in ${currencyWords(cur)} are on` : 'Prices are off: nothing is asked of CoinGecko');
      render();
    });
    const sel = h('select', { class: 'inline', 'aria-label': 'Currency', 'data-testid': 'currency-select' }, ...FIAT_CURRENCIES.map(([code, name]) => h('option', { value: code, text: `${code} · ${name}` })));
    sel.value = cur;
    sel.addEventListener('change', async () => {
      await app.setPrefs({ fiatCurrency: sel.value });
      beamPrice(app).forget();
      beamPrice(app).refresh({ force: true });
      toast(`Values in ${sel.value}`);
      render();
    });
    const hiddenCount = hiddenIds(app).size;
    put(
      box,
      h('p', { class: 'section-title', text: 'Tokens and prices' }),
      h(
        'div',
        { class: 'card list' },
        h(
          'label',
          { class: 'row' },
          h('span', { class: 'ico' }, icon('globe')),
          h('span', { class: 'main' }, h('div', { class: 't', text: `Values in ${currencyWords(cur)}` }), h('div', { class: 's wrap', text: "BEAM's price from CoinGecko, which sees your IP address. Off: values in BEAM only." })),
          sw,
        ),
        on ? h('div', { class: 'row' }, h('span', { class: 'ico' }, icon('settings')), h('span', { class: 'main' }, h('div', { class: 't', text: 'Currency' })), sel) : null,
        row('eye', 'Hidden tokens', hiddenCount ? `${tokensWord(hiddenCount)} hidden from Wallet` : 'None', () => app.go('hiddenTokens'), { 'data-testid': 'hidden-tokens-row' }),
      ),
    );
  }
  render();
  loadHidden(app).then(() => box.isConnected && render());
  return box;
}
