/* Swap status (right after the swap review; also a swap or approval in Ethereum activity)
 * Spec: ONE job: follow this swap until Ethereum has it, then say what arrived.
 *       Primary CTA: "Done" (back to Ethereum Home); secondary: "View on Etherscan" (a link).
 *       Taps from app open: after Ethereum (1) -> Buy WBEAM (2) -> Swap … (3) -> Swap … in the review (4)
 *       and Face ID; 2 from the activity list.
 * Exit-intent reasons and answers:
 *   - "Did it work?" -> live status in words, then the result: "You received 256.67 WBEAM. Network
 *     fee 0.00012 ETH. Shared between 2 pools."
 *   - "It failed - is my money gone?" -> "Ethereum refused it, so nothing was swapped; only the
 *     network fee was spent."
 *   - "The app lost signal while sending" -> it was saved before sending; the same bytes go again by
 *     themselves, never a second swap.
 *   - "Can I check elsewhere?" -> the hash copies with a tap, and Etherscan is one tap.
 */
import { h, put, shorten, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { updateOutbox } from '../lib/eth/outbox.js';
import { entryFee } from '../lib/eth/send.js';
import { txExplorerUrl } from '../lib/eth/hosts.js';
import { ETH, tokenBySymbol, tokenByAddress } from '../lib/eth/tokens.js';
import { uniswapFor } from '../lib/eth/uniswap_app.js';
import { uniTokenOf, ETH_TOKEN } from '../lib/eth/uniswap/models.js';
import { exactUnits } from '../lib/compact.js';
import { ethAbout, ethAtMost, short, amtShown } from './eth_swap_parts.js';

const FOLLOW_MS = 4000;

export default function ethSwapTx(app, p = {}) {
  const body = h('div', { class: 'stack' });
  let w = null;
  let entry = null;
  let dead = false;
  let reading = false;

  const amt = (v, a) => `${exactUnits(v, a.decimals)} ${a.symbol}`;

  function render() {
    if (dead) return;
    if (!entry) {
      put(body, h('p', { class: 'small', text: 'Loading the swap…' }));
      return;
    }
    const swap = entry.kind === 'swap';
    const asset = entry.token ? tokenBySymbol(entry.asset) || tokenByAddress(entry.token) : ETH;
    const out = swap ? (entry.tokenOut ? tokenByAddress(entry.tokenOut) : ETH) : null;
    const state = entry.state;
    const fee = entryFee(entry);
    const received = entry.received != null ? BigInt(entry.received) : null;
    const pools = Number(entry.pools) || 0;
    let title;
    let cls;
    let ico;
    let lines = [];
    if (state === 'signed' || state === 'pending') {
      title = swap ? 'Swap sent: waiting for Ethereum…' : 'Waiting for Ethereum…';
      cls = 'wait';
      ico = 'clock';
      lines = [notice('info', state === 'signed' ? 'Saved on this device and being handed to Ethereum. If the connection drops, the same swap is sent again by itself, never twice.' : 'Usually under a minute. You can leave this screen; the swap carries on and shows in your Ethereum activity.')];
    } else if (state === 'confirmed') {
      cls = 'ok';
      ico = 'check';
      if (swap) {
        title = 'Swap done';
        const words = [received != null && out ? `You received ${short(received, out)}.` : 'Ethereum has it in a block.', `Network fee ${ethAbout(fee.wei)}.`, pools > 1 ? `Shared between ${pools} pools.` : null].filter(Boolean).join(' ');
        lines = [(() => {
          const n = notice('success', h('span', { 'data-testid': 'uni-tx-result', text: words }));
          return n;
        })()];
      } else {
        title = entry.kind === 'approveReset' ? `${asset.symbol} permission reset` : `Uniswap may move ${amt(BigInt(entry.amount), asset)}`;
        lines = [notice('success', 'Ethereum confirmed the permission. Nothing was swapped by it.')];
      }
    } else if (state === 'failed') {
      title = swap ? "The swap didn't go through" : "The permission didn't go through";
      cls = 'bad';
      ico = 'close';
      lines = [notice('error', h('span', { 'data-testid': 'uni-tx-result', text: swap ? `Ethereum refused it, so nothing was swapped; only the network fee of ${ethAbout(fee.wei)} was spent. Most often the price moved past your protection before it was mined.` : `Ethereum refused it, so nothing was approved; only the network fee of ${ethAbout(fee.wei)} was spent.` }))];
    } else if (state === 'replaced') {
      title = 'Replaced';
      cls = 'bad';
      ico = 'close';
      lines = [notice('info', 'Another transaction from this wallet, sent from another device with the same words, took its place. This swap will not happen, and nothing left for it.')];
    } else {
      title = 'Not sent';
      cls = 'bad';
      ico = 'close';
      lines = [notice('error', `Ethereum's server refused it, so it never left. Nothing was spent.${entry.error ? ` The server said: ${entry.error}` : ''}`)];
    }
    put(
      body,
      h('div', { class: `status-icon ${cls}` }, icon(ico)),
      h('h2', { class: 'title center', 'data-testid': 'uni-tx-title', 'data-state': state, text: title }),
      swap ? h('div', { class: 'swap-amounts', 'data-testid': 'uni-tx-amounts' }, h('span', { class: 'nowrap', text: short(BigInt(entry.amount), asset) }), h('span', { class: 'arrow', text: '→' }), h('span', { class: 'nowrap', 'data-testid': 'uni-tx-received', 'data-units': received == null ? '' : String(received), title: received != null && out ? amt(received, out) : null, text: received != null && out ? short(received, out) : out ? out.symbol : '' })) : null,
      ...lines,
      h(
        'div',
        { class: 'card flat swap-details' },
        swap ? h('div', { class: 'kv' }, h('span', { class: 'k', text: state === 'confirmed' ? 'You paid' : 'You pay' }), h('span', { class: 'v nowrap', text: amtShown(BigInt(entry.amount), asset) })) : null,
        swap && out && entry.minimumOut ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Ethereum enforced at least' }), h('span', { class: 'v nowrap', 'data-testid': 'uni-tx-minimum', title: amt(BigInt(entry.minimumOut), out), text: short(BigInt(entry.minimumOut), out) })) : null,
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'uni-tx-fee', 'data-wei': String(fee.wei), text: fee.final ? ethAbout(fee.wei) : `at most ${ethAtMost(fee.wei)}` })),
        entry.receipt ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Block' }), h('span', { class: 'v', text: Number(entry.receipt.blockNumber).toLocaleString('en-US') })) : null,
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Sent' }), h('span', { class: 'v', text: fmtDate(Math.floor(entry.createdAt / 1000)) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Transaction' }), h('button', { class: 'v mono btn-text', 'data-testid': 'uni-tx-hash', 'data-hash': entry.hash, onclick: () => copyText(entry.hash, 'Transaction hash copied'), text: shorten(entry.hash, 10, 8) })),
      ),
    );
  }

  /** What arrived, read once from the receipt (the token's Transfer logs, or the ETH balance change) and kept with the entry. */
  async function readResult() {
    if (reading || !entry || entry.kind !== 'swap' || entry.state !== 'confirmed' || entry.received != null) return;
    reading = true;
    try {
      const svc = await uniswapFor(w);
      const receipt = await w.rpc.getTransactionReceipt(entry.hash);
      if (!receipt) return;
      const t = entry.tokenOut ? tokenByAddress(entry.tokenOut) : null;
      const tokenOut = t ? uniTokenOf(t) : ETH_TOKEN;
      const out = await svc.readReceipt(receipt, { owner: entry.from, tokenOut });
      if (out.received == null) return;
      entry = (await updateOutbox(app, entry.hash, { received: String(out.received) }, { ethId: w.ethId, kv: w.kv })) || { ...entry, received: String(out.received) };
      render();
    } catch {
      /* the next look tries again */
    } finally {
      reading = false;
    }
  }

  async function follow() {
    if (dead || !w || !entry || document.visibilityState !== 'visible' || !app.dbPass) return;
    if (entry.state === 'signed' || entry.state === 'pending') {
      try {
        await w.followOpen();
        entry = w.state.outbox.find((e) => e.hash === p.hash) || entry;
        render();
      } catch {
        /* the next look tries again */
      }
    }
    await readResult();
  }

  const timer = setInterval(follow, FOLLOW_MS);
  const onVis = () => follow();
  document.addEventListener('visibilitychange', onVis);

  (async () => {
    w = await ethWallet(app).catch(() => null);
    if (!w || dead) return w ? null : app.go('ethHome');
    entry = w.state.outbox.find((e) => e.hash === p.hash) || null;
    if (!entry) {
      put(body, notice('info', 'This swap was not sent from this device, so only Etherscan has its details.'));
      return;
    }
    render();
    follow();
  })();
  render();

  const link = /^0x[0-9a-fA-F]{64}$/.test(p.hash || '') ? h('a', { class: 'btn btn-text', href: txExplorerUrl(p.hash), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'uni-tx-explorer' }, icon('external'), 'View on Etherscan') : null;
  const el = screen({ title: 'Swap on Uniswap', back: () => app.back('ethHome'), actions: [primary('Done', () => app.go('ethHome'), { 'data-testid': 'uni-tx-done' }), link] }, body);
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
