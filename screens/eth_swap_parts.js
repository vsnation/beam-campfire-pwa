/* The Uniswap sheets (over screens/eth_swap.js), ports of the desktop app's
 * lib/pages/eth/uniswap/uniswap_approve_view.dart, uniswap_review_view.dart and
 * uniswap_pools_view.dart.
 *
 * Allow-token sheet
 * Spec: ONE job: let Uniswap's Permit2 move this token, for exactly the amount being swapped,
 *       before the first swap of it.
 *       Primary CTA: "Allow 128.34 WBEAM" (then Face ID / password); the review follows by itself.
 *       Taps from app open: Ethereum (1) -> Buy WBEAM (2) -> Swap … (3) -> Allow … (4), once per
 *       token and amount.
 * Exit-intent: "Why another transaction?" answered in one line; "Is this unlimited?" no, the exact
 *   amount is named on the button; USDT's two steps are said before they happen; the fee is shown.
 *
 * Review sheet
 * Spec: ONE job: show exactly what the swap does before anything is signed.
 *       Primary CTA: "Swap 0.01 ETH" (then Face ID / password).
 *       Taps from app open: Ethereum (1) -> Buy WBEAM (2) -> Swap … (3) -> this button (4).
 * Exit-intent: "Is this a scam?" the contract is Uniswap's Universal Router, named with its address;
 *   "What if the price moves?" the least that arrives is on screen, "Ethereum enforces this";
 *   "What does it cost?" the network fee "about" and "at most". The buttons stay in sight.
 *
 * Pools list (beside the form from 900 px, a sheet on a phone) and price protection (a sheet):
 *   read-only and a four-way choice; one tap from the form.
 */
import { h, shorten } from '../lib/dom.js';
import { openSheet, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { percentText } from '../lib/compact.js';
import { NATIVE_ETH, ADDRESSES } from '../lib/eth/uniswap/constants.js';
import { UniV4Pool } from '../lib/eth/uniswap/models.js';
import { poolDepth } from '../lib/eth/uniswap/quoter.js';
import { SLIPPAGE_CHOICES, PERMIT_LIFE_SECONDS, UniGasChanged, UniRouteChanged } from '../lib/eth/uniswap/service.js';
import { EthRpcError } from '../lib/eth/rpc.js';
import { toChecksumAddress } from '../lib/eth/crypto.js';
import { signAndBroadcast, permitSigner, walletAsset } from '../lib/eth/uniswap_app.js';
import { ethBadge } from './eth_ui.js';

// ------------------------------------------------------------------ words

export { amt, amtShown, short, ethAbout, ethAtMost, bipsText, feeText, rateText, routeText, routeNote, poolCount } from '../lib/eth/uniswap_words.js';
import { amt, amtShown, ethAbout, ethAtMost, bipsText, feeText, rateText, routeText, routeNote, poolCount } from '../lib/eth/uniswap_words.js';

export function kv(label, value, extra = {}, note = null) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value, note ? h('div', { class: 'small', text: note }) : null));
}

/** A token's badge: ETH's diamond, WBEAM as BEAM, others as letters. */
export function tokenBadge(t, size = '') {
  return ethBadge(walletAsset(t) || { symbol: t.symbol }, size);
}

// ------------------------------------------------------------------ pools

/** Every Uniswap pool between a and b, live first, deepest first → [{pool, state}]. */
export async function loadPools(svc, a, b) {
  const d = svc.discovery;
  const byId = new Map();
  for (const x of a.poolCurrencies) for (const y of b.poolCurrencies) if (x !== y) for (const p of await d.poolsBetween(x, y)) byId.set(p.id, p);
  const states = await d.liveState([...byId.values()]);
  const live = (r) => Boolean(r.state && r.state.isLive);
  const cmp = (x, y) => (x > y ? -1 : x < y ? 1 : 0);
  return [...byId.values()].map((pool) => ({ pool, state: states.get(pool.id) || null })).sort((x, y) => (live(x) === live(y) ? (live(x) ? cmp(poolDepth(x.state), poolDepth(y.state)) : 0) : live(x) ? -1 : 1));
}

function priceOf(r, a, b) {
  const p = r.state && r.state.price0to1;
  if (p == null) return '';
  const aSide = a.poolCurrencies.includes(r.pool.currency0) ? 0 : 1;
  const dec0 = aSide === 0 ? a.decimals : b.decimals;
  const dec1 = aSide === 0 ? b.decimals : a.decimals;
  let whole = p * 10 ** (dec0 - dec1);
  if (aSide === 1) whole = whole === 0 ? 0 : 1 / whole;
  if (!Number.isFinite(whole)) return '';
  const n = whole >= 1000 ? Math.round(whole).toLocaleString('en-US') : whole >= 1 ? whole.toFixed(4) : whole.toPrecision(4);
  return `1 ${a.symbol} = ${n} ${b.symbol}`;
}

/**
 * The pools list. state: {rows, error, a, b, quote}. Read-only: the swap is
 * shared between the pools that, together, give the most; the ones it uses say
 * how much of it each takes.
 */
export function poolsList({ rows, error, a, b, quote, retry }) {
  const intro = h('p', { class: 'small', text: `Every Uniswap pool between ${a.symbol} and ${b.symbol}, from Uniswap's own records (v2, v3 and v4).` });
  if (error) return [intro, notice('error', h('strong', { text: "Couldn't read the pools. " }), 'Your Ethereum server did not answer. Nothing was sent.', retry ? h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: retry }, 'Try again')) : null)];
  if (!rows) return [intro, h('p', { class: 'small', 'data-testid': 'uni-pools-loading', text: `Looking at every Uniswap pool between ${a.symbol} and ${b.symbol}…` }), h('div', { class: 'progress indeterminate' }, h('div'))];
  if (!rows.length) return [intro, notice('info', `No pool between ${a.symbol} and ${b.symbol}. The swap can still go through another token (ETH, USDC, USDT, DAI, WBTC or WBEAM) when both sides trade with it.`)];
  const samePair = quote && quote.tokenIn.sameAsset(a) && quote.tokenOut.sameAsset(b);
  const live = rows.filter((r) => r.state && r.state.isLive);
  const deepest = live.length ? poolDepth(live[0].state) : 0n;
  const shareOf = (pool) => {
    if (!samePair) return null;
    const part = quote.parts.find((p) => p.route.isDirect && p.route.hops[0].pool.id === pool.id);
    return part ? `${Math.max(1, Math.round(quote.shareOf(part) * 100))}%` : null;
  };
  const via = samePair ? quote.parts.filter((p) => !p.route.isDirect) : [];
  const viaShare = via.reduce((s, p) => s + quote.shareOf(p), 0);
  return [
    intro,
    h('p', { class: 'small', 'data-testid': 'uni-pools-summary', text: `${live.length} of ${rows.length} pools can trade now. Your swap is shared between the pools that, together, give you the most, so no one pool moves far.` }),
    via.length ? h('p', { class: 'small', 'data-testid': 'uni-pools-via', text: `Another ${Math.max(1, Math.round(viaShare * 100))}% of your swap goes through a second token, on pools not listed here.` }) : null,
    h(
      'div',
      { class: 'pool-list' },
      ...rows.slice(0, 40).map((r) => {
        const isLive = Boolean(r.state && r.state.isLive);
        const used = shareOf(r.pool);
        const bar = h('div', { class: 'depth' }, h('div'));
        if (isLive && deepest > 0n) bar.firstChild.style.setProperty('width', `${Math.max(2, Math.min(100, Number((poolDepth(r.state) * 1000n) / deepest) / 10))}%`);
        const hooks = r.pool instanceof UniV4Pool && r.pool.hasHooks;
        const weth = r.pool.version === 'v4' && r.pool.currency0 !== NATIVE_ETH && (a.isEthLike || b.isEthLike) ? ' · WETH' : '';
        return h(
          'div',
          { class: `card flat pool-row${used ? ' used' : ''}`, 'data-testid': 'uni-pool', 'data-pool': r.pool.id, 'data-share': used || '' },
          h('div', { class: 'banner' }, h('strong', { text: `Uniswap ${r.pool.version}` }), h('span', { class: 'small grow', text: `${feeText(r.pool.fee)} fee${hooks ? ' · hook' : ''}${weth}` }), used ? h('span', { class: 'share', text: `${used} of your swap` }) : isLive ? null : h('span', { class: 'small', text: 'empty' })),
          isLive ? h('div', { class: 'small', text: priceOf(r, a, b) }) : null,
          isLive ? bar : null,
        );
      }),
      rows.length > 40 ? h('p', { class: 'small', text: `…and ${rows.length - 40} more without liquidity.` }) : null,
    ),
  ];
}

// ------------------------------------------------------------------ price protection

const SLIPPAGE_WORDS = {
  50: '0.5%: strict; fails more often when others trade',
  100: '1%: a good default',
  300: '3%: for small pools that move a lot',
  500: '5%: only for very thin pools',
};

/** The price protection choices → the bips chosen, or undefined. */
export function pickSlippage(current) {
  return new Promise((resolve) => {
    openSheet(
      (close) => [
        h('h2', { text: 'Price protection' }),
        h('p', { class: 'lead', text: 'If the price moves against you by more than this before your swap is mined, Ethereum cancels the swap and you keep your coins (only the network fee is spent). Also called slippage.' }),
        h(
          'div',
          { class: 'card list' },
          ...SLIPPAGE_CHOICES.map((b) =>
            h('button', { class: `row${b === current ? ' on' : ''}`, role: 'radio', 'aria-checked': String(b === current), 'data-testid': `uni-slippage-${b}`, onclick: () => close(b) }, h('span', { class: `radio${b === current ? ' on' : ''}` }), h('span', { class: 'main' }, h('div', { class: 't', text: SLIPPAGE_WORDS[b] }))),
          ),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ],
      { label: 'Price protection' },
    ).then(resolve);
  });
}

// ------------------------------------------------------------------ allow

/**
 * The allow-token sheet: Permit2 may move exactly approval.amount of the
 * token, before the first swap of it. One extra step, once per token and
 * amount. Resolves true once Ethereum has confirmed the approval.
 */
export function openAllowSheet(app, { w, svc, approval }) {
  const t = approval.token;
  const asset = walletAsset(t);
  const twoSteps = approval.kind === 'resetThenApprove';
  let txs = null;
  let phase = 'choose'; // choose | sending | waiting | failed
  let error = null;
  let hash = null;
  return new Promise((resolve) => {
    const sheet = openSheet(
      (close, rerender) => {
        const busy = phase === 'sending' || phase === 'waiting';
        const likely = txs ? txs.reduce((s, x) => s + x.expectedGasCost, 0n) : null;
        const most = txs ? txs.reduce((s, x) => s + x.maxGasCost, 0n) : null;
        const allow = async () => {
          if (busy || !txs) return;
          const ok = await confirmIdentity(app, { title: `Allow ${t.symbol}`, detail: `Uniswap may move exactly ${amt(approval.amount, t)}`, cta: 'Confirm' });
          if (!ok) return;
          phase = 'sending';
          error = null;
          rerender();
          try {
            for (const tx of txs) {
              const r = await signAndBroadcast(app, w, tx, { kind: tx.kind, asset, amount: tx.kind === 'approveReset' ? 0n : approval.amount, extra: { spender: ADDRESSES.permit2 } });
              if (!r.sent && r.entry.state === 'rejected') throw new Error(`Ethereum's server refused it: ${r.error && r.error.message}`);
              hash = r.entry.hash;
              phase = 'waiting';
              rerender();
              const done = await svc.waitForReceipt(hash, { every: 2000 });
              await w.followOpen().catch(() => {});
              if (!done) throw new Error('Ethereum has not confirmed it yet. It may still go through; try the swap again in a minute.');
              if (!done.success) throw new Error('Ethereum refused it. Nothing was approved.');
            }
            close(true);
          } catch (e) {
            phase = 'failed';
            error = e instanceof EthRpcError ? `Your Ethereum server said: "${e.message}". Nothing was approved.` : e.message;
            rerender();
          }
        };
        return [
          h('h2', { text: `Allow ${t.symbol}` }),
          h('p', { class: 'lead', text: `Before ${t.symbol} can be swapped, Ethereum needs your permission for Uniswap to move it. This is its own transaction; nothing is swapped yet, and the swap comes right after.` }),
          h('p', { class: 'small', 'data-testid': 'uni-approve-explain', text: `Exactly what this swap uses: ${amt(approval.amount, t)}. The next swap of ${t.symbol} asks again.` }),
          twoSteps ? notice('info', h('strong', { text: `${t.symbol} takes two steps. ` }), `${t.symbol} only changes a permission from zero, so BEAM Campfire first sets the old one to 0, then to the new amount: two transactions, one confirmation.`) : null,
          h(
            'div',
            { class: 'card flat swap-details' },
            kv('Token', h('span', {}, `${t.symbol} `, h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(t.address), 6, 4)})` }))),
            kv('Allowed to move it', h('span', {}, 'Uniswap Permit2 ', h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(ADDRESSES.permit2), 6, 4)})` }))),
            kv('Network fee', likely === null ? '…' : `about ${ethAbout(likely)}`, { 'data-testid': 'uni-approve-fee' }, most === null ? null : `at most ${ethAtMost(most)}`),
          ),
          phase === 'waiting' ? notice('info', h('strong', { text: 'Waiting for Ethereum to confirm… ' }), 'Usually under a minute. The swap review opens by itself.') : null,
          phase === 'failed' && error ? (() => {
            const n = notice('error', h('strong', { text: "The permission didn't go through. " }), error);
            n.dataset.testid = 'uni-approve-failed';
            return n;
          })() : null,
          h(
            'div',
            { class: 'sheet-actions' },
            h('button', { class: 'btn btn-primary', onclick: allow, disabled: busy || !txs, 'data-testid': 'uni-approve-cta' }, phase === 'sending' ? 'Sending…' : phase === 'waiting' ? 'Waiting for Ethereum…' : `Allow ${amt(approval.amount, t)}`),
            h('button', { class: 'btn btn-text', onclick: () => close(false), disabled: busy, 'data-testid': 'uni-approve-cancel' }, 'Not now'),
          ),
        ];
      },
      { label: `Allow ${t.symbol}`, dismissable: false },
    );
    sheet.then((v) => resolve(v === true));
    svc
      .approvalTxs(approval, w.state.address)
      .then((list) => {
        txs = list;
        if (!sheet.closed) sheet.rerender();
      })
      .catch((e) => {
        phase = 'failed';
        error = `The permission could not be prepared: ${e.message}`;
        if (!sheet.closed) sheet.rerender();
      });
  });
}

// ------------------------------------------------------------------ review

/** The price-change warning from 3 %, and from 10 % the box to tick before the swap can be sent. */
export function impactBlock(q, block, ack, onAck) {
  const warn = notice(block ? 'error' : 'warn', h('strong', { text: `This swap moves the price ${percentText(q.priceImpact)}. ` }), 'The pools are small for this amount, so you get noticeably less than the current rate. A smaller amount gets a better price.');
  warn.dataset.testid = 'uni-impact-warning';
  if (!block) return [warn];
  const box = h('input', { type: 'checkbox', 'data-testid': 'uni-impact-ack', checked: ack });
  box.addEventListener('change', () => onAck(box.checked));
  return [warn, h('label', { class: 'check-row' }, box, h('span', { text: `I accept getting ${percentText(q.priceImpact)} less` }))];
}

/**
 * The review sheet: exactly what the swap does before anything is signed.
 * After the person confirms: the Permit2 signature (for a token), the router
 * call built and simulated, then signed, saved and broadcast. Resolves the
 * transaction hash once it has left (or may have), null when the person went
 * back without swapping.
 */
export function openReviewSheet(app, { w, svc, review: first, acceptImpact }) {
  let review = first;
  let busy = false;
  let error = null;
  let ack = Boolean(acceptImpact);
  return new Promise((resolve) => {
    const sheet = openSheet(
      (close, rerender) => {
        const q = review.quote;
        const swap = async () => {
          if (busy || (review.impact === 'block' && !ack)) return;
          const ok = await confirmIdentity(app, { title: 'Confirm the swap', detail: `${amtShown(q.amountIn, q.tokenIn)} for at least ${amtShown(review.minimumOut, q.tokenOut, { floor: true })}`, cta: 'Confirm' });
          if (!ok) return;
          busy = true;
          error = null;
          rerender();
          let prepared;
          try {
            prepared = await svc.finalizeSwap({ review, signPermit: permitSigner(app, w), acceptImpact: ack });
          } catch (e) {
            busy = false;
            if (e instanceof UniGasChanged) {
              review = Object.freeze({ ...review, gasLimit: e.gasLimit, maxGasCost: e.gasLimit * review.fees.maxFeePerGas, expectedGasCost: e.gasLimit * (review.fees.baseFee + review.fees.maxPriorityFeePerGas) });
              error = 'The swap needs a little more gas than first measured. The network fee below is updated; nothing was sent.';
            } else if (e instanceof UniRouteChanged) error = 'One of the pools on this route would not actually trade, so BEAM Campfire left it out. Go back for the next best price.';
            else if (e instanceof EthRpcError && (e.code === 3 || /revert/i.test(e.message))) error = 'Ethereum would refuse this swap now, most often because the price moved past your protection since this review. Nothing was sent. Tap Change for a new price.';
            else if (e instanceof EthRpcError) error = `Your Ethereum server would not build it: "${e.message}". Nothing was sent.`;
            else error = `Couldn't build the swap: ${e.message} Nothing was sent.`;
            return rerender();
          }
          try {
            const r = await signAndBroadcast(app, w, prepared.tx, {
              kind: 'swap',
              asset: walletAsset(q.tokenIn),
              amount: q.amountIn,
              extra: { tokenOut: q.tokenOut.isEth ? null : q.tokenOut.address, tokenOutSymbol: q.tokenOut.symbol, quotedOut: String(q.amountOut), minimumOut: String(prepared.minimumOut), pools: poolCount(q) },
            });
            if (!r.sent && r.entry.state === 'rejected') {
              busy = false;
              error = `Nothing was sent. Ethereum's server refused it: ${r.error && r.error.message}`;
              return rerender();
            }
            close(r.entry.hash);
          } catch (e) {
            busy = false;
            error = `Nothing was sent. ${e.message}`;
            rerender();
          }
        };
        const hooked = q.pools.some((p) => p instanceof UniV4Pool && p.hasHooks);
        return [
          h('h2', { text: 'Check before swapping' }),
          h(
            'div',
            { class: 'card review-amounts' },
            h('div', { class: 'review-line' }, tokenBadge(q.tokenIn), h('div', { class: 'grow' }, h('div', { class: 'small', text: 'You pay' }), h('div', { class: 'big', 'data-testid': 'uni-review-pay', title: amt(q.amountIn, q.tokenIn), text: amtShown(q.amountIn, q.tokenIn) }), h('div', { class: 'small', 'data-testid': 'uni-review-total', text: `+ the network fee, about ${ethAbout(review.expectedGasCost)}` }))),
            h('div', { class: 'review-line' }, tokenBadge(q.tokenOut), h('div', { class: 'grow' }, h('div', { class: 'small', text: 'You receive about' }), h('div', { class: 'big', 'data-testid': 'uni-review-receive', title: amt(q.amountOut, q.tokenOut), text: amtShown(q.amountOut, q.tokenOut) }))),
            notice('success', h('strong', { 'data-testid': 'uni-review-minimum', text: `You receive at least ${amtShown(review.minimumOut, q.tokenOut, { floor: true })}. Ethereum enforces this. ` }), `If the price moves more than ${bipsText(review.slippageBips)} first, Ethereum cancels the swap and only the network fee is spent.`),
          ),
          h(
            'div',
            { class: 'card flat swap-details' },
            kv('Rate', rateText(q)),
            kv('Route', routeText(q), {}, routeNote(q)),
            kv('Price change from your swap', q.priceImpact == null ? 'Unknown' : percentText(q.priceImpact), { class: `v${review.impact === 'none' ? '' : ' bad'}` }),
            h(
              'button',
              {
                class: 'kv kv-tap',
                type: 'button',
                title: 'Also called slippage tolerance',
                'data-testid': 'uni-review-protection',
                disabled: busy,
                onclick: async () => {
                  const b = await pickSlippage(review.slippageBips);
                  if (!b || b === review.slippageBips || sheet.closed) return;
                  // Only the minimum changes: the gas and the route are the same.
                  review = Object.freeze({ ...review, slippageBips: b, minimumOut: review.quote.minimumOut(b) });
                  rerender();
                },
              },
              h('span', { class: 'k', text: 'Price protection' }),
              h('span', { class: 'v' }, bipsText(review.slippageBips), h('div', { class: 'small', text: 'Tap to change' })),
            ),
            kv('Network fee', `about ${ethAbout(review.expectedGasCost)}`, { 'data-testid': 'uni-review-fee' }, `at most ${ethAtMost(review.maxGasCost)}`),
            h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'Sent to' }), h('span', { class: 'v', 'data-testid': 'uni-review-router' }, 'Uniswap Universal Router ', h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(ADDRESSES.universalRouter), 6, 4)})` }))),
            review.needsPermit ? kv('You also sign', `Uniswap may take exactly ${amt(q.amountIn, q.tokenIn)}, for ${PERMIT_LIFE_SECONDS / 60} minutes`, { 'data-testid': 'uni-review-permit' }) : null,
          ),
          ...(review.impact === 'none' ? [] : impactBlock(q, review.impact === 'block', ack, (v) => {
            ack = v;
            rerender();
          })),
          hooked ? notice('warn', h('strong', { text: 'This route uses a pool with a hook. ' }), 'A hook is extra code its creator added to the pool. Your minimum above is still enforced by Uniswap.') : null,
          h('p', { class: 'small', text: 'Ethereum swaps cannot be undone once sent, and anyone can see them.' }),
          error ? (() => {
            const n = notice('warn', error);
            n.dataset.testid = 'uni-review-error';
            return n;
          })() : null,
          h(
            'div',
            { class: 'sheet-actions' },
            h('button', { class: 'btn btn-primary', onclick: swap, disabled: busy || (review.impact === 'block' && !ack), 'data-testid': 'uni-review-cta' }, busy ? 'Signing and sending…' : `Swap ${amtShown(q.amountIn, q.tokenIn)}`),
            h('button', { class: 'btn btn-text', onclick: () => close(null), disabled: busy, 'data-testid': 'uni-review-change' }, 'Change'),
          ),
        ];
      },
      { label: 'Check before swapping', dismissable: false },
    );
    sheet.then((v) => resolve(typeof v === 'string' ? v : null));
  });
}

