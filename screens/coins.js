/* Split coins (Home's balance -> "Coins", a private balance's line, Settings -> Coins)
 * Spec: ONE job: let the wallet send several payments at once, by splitting the coins its BEAM (or one
 *       token) sits in into several equal coins; each coin is listed under it.
 *       Primary CTA: the outcome, "Split into 5 coins" (the advised count already picked). It opens the
 *       review, which asks once more ("Split into 5 coins", then Face ID / password) before anything is signed.
 *       Taps from app open: 1 (Home -> Coins), 2 "Split into 5 coins", 3 on the review, then Face ID / password.
 * Exit-intent reasons and answers (BEAM Campfire's, lib/pages/beam/split/beam_split_view.dart):
 *   - "Is this sending my money somewhere?" -> the first lines say nothing leaves the wallet; the review
 *     says it again with the fee.
 *   - "What's a coin? Why would I want more?" -> the headline is the gain ("Send several payments at
 *     once"); the line under it says why in one breath.
 *   - "How many should I pick?" -> the advice's count is already selected.
 *   - "What will I end up with?" -> "5 coins of 0.17 BEAM", the change and the fee, before the button.
 *   - "Why is the button grey?" -> the reason is written right above it: not up to date, still getting
 *     ready, no BEAM for a token's fee, too little to split.
 *   - "Why can't I spend what I was sent privately?" -> each private coin says when it becomes spendable.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, openSheet, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { hiddenIds } from '../lib/hidden_tokens.js';
import { loadCoins, emptySummary, splitAdvice, countsFor, chosenCount, planEqual, SPLIT_TEXT as T } from '../lib/coins.js';
import { coinList } from './coins_ui.js';
import { syncReason } from '../lib/sync.js';
import { t } from '../lib/i18n.js';

export default function coins(app, params = {}) {
  let assetId = Number(params.assetId) > 0 ? Number(params.assetId) : 0;
  let all = null; // Map assetId -> summary
  let loadProblem = null;
  let picked = params.count != null ? Number(params.count) : null;
  let alive = true;
  let loading = false;
  let sig = null;

  const intro = h('div', { class: 'stack tight' }, h('h2', { class: 'title', 'data-testid': 'split-headline', text: t(T.headline) }), h('p', { class: 'lead', text: t(T.intro) }));
  const form = h('div', { class: 'stack' });
  const listBox = h('div', { class: 'stack' });

  const unitOf = (id) => {
    const l = wallet.label(id);
    return l.pool ? 'LP' : l.unit;
  };
  const summary = () => (all && all.get(assetId)) || emptySummary(assetId);
  const beamAvailable = () => (all && all.get(0) ? all.get(0).availableTotal : 0n);

  /** BEAM, then every other asset with a coin worth splitting; never a pool share (it goes back to its pool whole) or a hidden token. */
  function choices() {
    const hidden = hiddenIds(app);
    const out = [0];
    for (const [id, s] of all || []) if (id !== 0 && s.usable.length && !wallet.label(id).pool && !hidden.has(id)) out.push(id);
    return out.sort((a, b) => a - b);
  }

  async function load() {
    if (loading || !wallet.session) return;
    loading = true;
    try {
      all = await loadCoins(wallet.session);
      loadProblem = null;
      if (assetId !== 0 && !choices().includes(assetId) && !all.has(assetId)) assetId = 0;
    } catch (e) {
      loadProblem = e;
    }
    loading = false;
    if (alive) render(wallet.state);
  }

  function plan() {
    const n = chosenCount(summary(), picked);
    return n == null ? null : planEqual({ available: summary().availableTotal, count: n, assetId });
  }

  /** What keeps the button off besides the wallet's state: no coins, too little, no BEAM for a token's fee. */
  function fundsIssue(p) {
    if (!all) return null;
    const symbol = unitOf(assetId);
    if (summary().availableTotal === 0n) return T.noCoins(symbol);
    if (wallet.label(assetId).pool) return t(T.poolShare);
    if (!p) return t(T.tooLittle);
    if (assetId !== 0 && beamAvailable() < p.fee) return T.needBeam(p.fee, beamAvailable());
    return null;
  }

  function stateIssue(s) {
    if (s.importing) return t('Splitting turns on once the wallet has finished getting ready.');
    if (!s.sync.canSend) return t('Splitting is paused: {reason}.', { reason: syncReason(s.sync.title) });
    return null;
  }

  function pickAsset() {
    const ids = choices();
    openSheet(
      (close) => [
        h('h2', { text: t('Which coins to split') }),
        h(
          'div',
          { class: 'card list picker-list', 'data-testid': 'split-asset-list' },
          ...ids.map((id) => {
            const l = wallet.label(id);
            const s = all.get(id) || emptySummary(id);
            return h(
              'button',
              { class: `row${id === assetId ? ' on' : ''}`, 'data-asset-id': String(id), onclick: () => close(id) },
              assetBadge(l),
              h('span', { class: 'main' }, h('div', { class: 't', text: l.unit }), h('div', { class: 's', text: l.verified ? l.name : t('Not verified · {name}', { name: l.name }) })),
              h('span', { class: 'end small', text: formatAmount(s.availableTotal) }),
            );
          }),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close')),
      ],
      { label: t('Which coins to split') },
    ).then((id) => {
      if (id == null || !alive) return;
      assetId = id;
      picked = null;
      render(wallet.state);
    });
  }

  function render(s) {
    if (!alive) return;
    // Coins change with the balances: read them again when those move.
    const now = [...s.totals].map(([id, tot]) => `${id}:${tot.available}:${tot.receiving}:${tot.sending}:${tot.maturing}`).join('|');
    if (wallet.session && now !== sig && !loading) {
      sig = now;
      load();
    }
    const symbol = unitOf(assetId);
    const l = wallet.label(assetId);
    const height = s.status ? Number(s.status.current_height) : null;

    if (loadProblem && !all) {
      put(form, notice('error', t("Your coins couldn't be read: {reason}. Try again in a moment.", { reason: loadProblem.message })), secondary(t('Try again'), () => ((sig = null), load()), { 'data-testid': 'coins-retry' }));
      put(listBox);
      return;
    }
    if (!all) {
      put(form, h('div', { class: 'card empty', 'data-testid': 'coins-loading' }, h('div', { class: 'spinner' }), h('p', { text: s.importing ? t('Your coins appear once the wallet has finished getting ready.') : t('Reading your coins…') })));
      put(listBox);
      return;
    }

    const sum = summary();
    const p = plan();
    const issue = fundsIssue(p);
    const blocked = stateIssue(s);
    const many = choices().length > 1;
    const advice = splitAdvice(sum);
    const counts = countsFor(sum);
    const chosen = chosenCount(sum, picked);

    const assetCard = h(
      many ? 'button' : 'div',
      { class: `card row split-asset${many ? ' tap' : ''}`, type: many ? 'button' : null, 'data-testid': 'split-asset', onclick: many ? pickAsset : null },
      assetBadge(l),
      h('span', { class: 'main' }, h('div', { class: 't', text: l.pool ? l.name : l.unit }), h('div', { class: 's wrap', 'data-testid': 'split-now', text: T.now(sum, symbol) })),
      many ? h('span', { class: 'chev' }, icon('down')) : null,
    );

    const cta = primary(p ? T.cta(p.count) : t(T.title), () => app.go('splitReview', { assetId, count: p.count, size: String(p.size) }), {
      disabled: !(p && !issue && !blocked && wallet.session),
      'data-testid': 'split-cta',
    });

    put(
      form,
      h('p', { class: 'section-title', text: t('Now') }),
      assetCard,
      advice.urgency === 'none' && sum.usable.length > 1 && p ? notice('info', h('span', { 'data-testid': 'split-advice', text: T.spreadWell(sum.usable.length) })) : null,
      issue
        ? h(
            'div',
            { 'data-testid': 'split-funds' },
            notice('info', issue, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'split-receive', onclick: () => app.go('receive') }, t('Receive BEAM')))),
          )
        : null,
      p
        ? [
            h('p', { class: 'section-title', text: t(T.countLabel) }),
            h(
              'div',
              { class: 'split-counts', role: 'radiogroup', 'aria-label': t(T.countLabel) },
              ...counts.map((n) =>
                h('button', { class: `choice${n === chosen ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(n === chosen), 'data-testid': `split-count-${n}`, onclick: () => ((picked = n), render(wallet.state)) }, String(n)),
              ),
            ),
            h('p', { class: 'section-title', text: t('After') }),
            h(
              'div',
              { class: 'card flat split-after' },
              kv(t('You will have'), T.newCoins(p, symbol), 'split-new-coins'),
              kv(t('Network fee'), T.fee(p), 'split-fee'),
              p.change > 0n ? kv(t('Stays as change'), `${formatAmount(p.change)} ${symbol}`, 'split-change') : null,
            ),
          ]
        : null,
      blocked ? h('p', { class: 'hint center', 'data-testid': 'split-blocked', text: blocked }) : null,
      cta,
    );
    put(listBox, ...coinList(sum, symbol, height));
  }

  const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));

  const off = wallet.onChange(render);
  render(wallet.state);
  const el = screen({ title: t(T.title), back: () => app.back('home'), cls: 'coins' }, intro, form, listBox);
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
