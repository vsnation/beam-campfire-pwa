/* Pools
 * Spec: ONE job: find a pool to put coins into, or to take yours out of.
 *       Primary CTA: none - each pool card opens its pool in one tap; the one button, "Create a pool",
 *       is secondary (an empty list makes it the primary).
 *       Taps from app open: 2 (Home -> Swap -> Pools); a pool is the 3rd. From Home, an LP token is 1 tap.
 * Exit-intent reasons and answers:
 *   - "What is a pool?" -> one plain sentence on top: add coins, earn a share of the fee on every swap.
 *   - "~95 pools of tokens I don't know" -> the pools you hold a share of come first, then by how much
 *     they hold; a search by name, ticker or #id.
 *   - "Is that the real FOMO?" -> an asset Campfire does not vouch for keeps its #id; a copy of a
 *     verified name says so in red.
 *   - "Is this pool worth my time?" -> each card says what it holds, its size in BEAM, its fee, and its
 *     price (tap the price to see it the other way round).
 *   - "Nothing loads" -> what happened, that it is not the person's doing, and Try again.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, primary, secondary } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { loadPools } from '../lib/dex_pools.js';
import { lpVersion } from '../lib/lp_tokens.js';
import { arrangePools, poolMatches, poolSize, isEmptyPool, shareOf, percentText, compact, beamWorth, poolKey } from '../lib/dex_liquidity.js';
import { isVerified, unit, pairName, feeText, pairBadge, sideWarnings, flipButton, poolParams, readProblemText } from './pool_parts.js';

export default function pools(app) {
  let list = null;
  let error = null;
  let alive = true;
  let lastShape = '';
  const flipped = new Set();

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name, ticker or #id', 'aria-label': 'Search pools', autocomplete: 'off', 'data-testid': 'pools-search' });
  const searchBox = h('div', { class: 'hidden' }, search);
  const status = h('div', { 'data-testid': 'pools-status' });
  const body = h('div', { class: 'pool-list', 'data-testid': 'pools-list' });
  const createBtn = secondary('Create a pool', () => app.go('poolCreate'), { 'data-testid': 'pools-create' });

  const held = (lp) => wallet.available(lp);

  function card(p) {
    const empty = isEmptyPool(p);
    const mine = p.lpToken != null ? held(p.lpToken) : 0n;
    const size = empty ? null : poolSize(list, p, isVerified);
    const share = mine > 0n ? shareOf(p, mine) : null;
    return h(
      'div',
      { class: 'card pool-card', 'data-testid': 'pool-card', 'data-pool': poolKey(p), 'data-lp': String(p.lpToken) },
      h(
        'button',
        { class: 'pool-open', type: 'button', 'data-testid': 'pool-open', 'aria-label': `${pairName(p)} pool, ${feeText(p.kind)}`, onclick: () => app.go('pool', poolParams(p)) },
        pairBadge(p),
        h(
          'span',
          { class: 'main' },
          h('span', { class: 'pool-title' }, h('span', { class: 'name', 'data-testid': 'pool-name', text: pairName(p) }), h('span', { class: 'fee-chip', text: feeText(p.kind) })),
          h('span', { class: 'line', 'data-testid': 'pool-reserves', text: empty ? 'Empty: nobody has added coins yet' : `${compact(p.tok1)} ${unit(p.aid1)} · ${compact(p.tok2)} ${unit(p.aid2)}` }),
          empty ? null : h('span', { class: 'line', 'data-testid': 'pool-size', text: size == null ? 'Pool size: no price' : `Pool size ${beamWorth(size)}` }),
          ...sideWarnings(p),
          share ? h('span', { class: 'mine', 'data-testid': 'pool-share', text: `Your share of the pool: ${percentText(share.num, share.den)}` }) : null,
        ),
        h('span', { class: 'chev' }, icon('chevron')),
      ),
      empty ? null : flipButton(p, { start: flipped.has(poolKey(p)), onFlip: (on) => (on ? flipped.add(poolKey(p)) : flipped.delete(poolKey(p))) }),
    );
  }

  function render() {
    if (!alive) return;
    if (!list) {
      searchBox.classList.add('hidden');
      put(
        status,
        error
          ? h(
              'div',
              { 'data-testid': 'pools-error' },
              notice('error', h('strong', { text: "Couldn't load the pools. " }), readProblemText(error, 'reach the DEX').replace(/^Couldn't reach the DEX: /, ''), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'pools-retry', onclick: () => load(true) }, 'Try again')),
            )
          : h('div', { class: 'loading-line', 'data-testid': 'pools-loading' }, h('span', { class: 'spinner small' }), h('span', { text: 'Loading pools from the BEAM network…' })),
      );
      put(body);
      return;
    }
    const q = search.value;
    const { mine, rest } = arrangePools(list, { held, isVerified, matches: (p) => poolMatches(p, q, (id) => wallet.label(id)) });
    const anyLive = list.some((p) => !isEmptyPool(p));
    const st = [];
    if (error) st.push(h('p', { class: 'small', 'data-testid': 'pools-stale', text: 'Showing the pools loaded a moment ago; the latest could not be fetched.' }));
    if (!anyLive && !mine.length) {
      // Nothing to search: the way forward is to make the first pool.
      searchBox.classList.add('hidden');
      st.push(h('div', { 'data-testid': 'pools-empty' }, notice('info', h('strong', { text: 'No pools have coins yet. ' }), 'Create the first pool and earn the fee on every swap it makes.')));
      put(status, ...st);
      put(body, primary('Create a pool', () => app.go('poolCreate'), { 'data-testid': 'pools-empty-create' }));
      createBtn.classList.add('hidden');
      return;
    }
    createBtn.classList.remove('hidden');
    searchBox.classList.remove('hidden');
    if (!mine.length && !rest.length) {
      st.push(
        h(
          'div',
          { 'data-testid': 'pools-no-match' },
          notice('info', h('strong', { text: `No pool matches "${q.trim()}". ` }), 'Search by name, ticker or #id, or ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('poolCreate') }, 'create the pool'), '.'),
        ),
      );
    }
    put(status, ...st);
    // Rebuilt only when something on the cards changed: a balance, a name, the list or the search.
    const shape = `${q}|${list.length}|${mine.map(poolKey).join()}|${rest.length}|${mine.map((p) => String(held(p.lpToken))).join()}|${wallet.assetNamed.size}|${lpVersion()}`;
    if (shape === lastShape && body.childElementCount) return;
    lastShape = shape;
    put(
      body,
      ...(mine.length ? [h('p', { class: 'section-title', 'data-testid': 'pools-mine-title', text: 'Your pools' }), ...mine.map(card)] : []),
      ...(rest.length ? [h('p', { class: 'section-title', 'data-testid': 'pools-all-title', text: `All pools · ${rest.length}` }), ...rest.map(card)] : []),
    );
  }

  async function load(force = false) {
    error = null;
    render();
    try {
      const l = await loadPools(force);
      if (!alive) return;
      list = l;
      lastShape = '';
    } catch (e) {
      if (!alive) return;
      error = e;
    }
    render();
  }

  search.addEventListener('input', () => render());
  // Names arrive as the asset list loads; balances as the wallet syncs.
  const off = wallet.onChange(() => render());
  wallet.loadAllAssets();
  render();
  load(false);

  const el = screen(
    { title: 'Pools', back: () => app.back('swap'), actions: [createBtn], cls: 'pools sticky-actions' },
    h('p', { class: 'lead small', text: 'Add your coins to a pool and earn a share of the fee on every swap it makes. Take them out whenever you like.' }),
    searchBox,
    status,
    body,
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
