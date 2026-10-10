// Pieces the Ethereum screens share: token badges, amounts in words, the
// "server didn't answer" notice with its two ways out, and activity rows.
import { h, shorten, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { assetBadge, notice } from '../lib/ui.js';
import { formatUnits, isRoundedDown, DISPLAY_DECIMALS } from '../lib/eth/units.js';
import { ETH } from '../lib/eth/tokens.js';
import { compactUnits } from '../lib/compact.js';
import { ETH_RPC_HOSTS, DEFAULT_ETH_RPC } from '../lib/eth/hosts.js';
import { ethPrefs } from '../lib/eth/wallet.js';

// Fixed colours, never taken from a token contract.
const TOKEN_COLORS = { USDT: '#26a17b', USDC: '#2775ca', WBTC: '#f09242', DAI: '#f5ac37' };

/** ETH's diamond; WBEAM drawn as BEAM (it is BEAM on Ethereum, 1:1); the others as letters. */
export function ethBadge(asset, size = '') {
  if (asset === ETH) return h('span', { class: `asset-badge eth ${size}`.trim(), 'aria-hidden': 'true' }, h('img', { src: 'img/eth.svg', alt: '' }));
  if (asset.symbol === 'WBEAM') return assetBadge({ id: 0 }, { size });
  return assetBadge({ id: -1, unit: asset.symbol, color: TOKEN_COLORS[asset.symbol] }, { size });
}

/** "0.01 ETH"; "≈" when the display hides digits (full precision is on the review). */
export function amountText(value, asset, { approx = true } = {}) {
  const t = `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
  return approx && isRoundedDown(value, asset.decimals) ? `≈${t}` : t;
}

/**
 * A short balance for a list row, rounded as the activity rows and the desktop
 * round (compactUnits); "≈" when digits are hidden. The exact figure goes in
 * the row's title.
 */
export function compactAmountText(value, asset) {
  const v = BigInt(value);
  const shown = compactUnits(v, asset.decimals);
  const exact = formatUnits(v, asset.decimals, { maxDecimals: asset.decimals });
  return `${shown === exact ? '' : '≈'}${shown} ${asset.symbol}`;
}

/** The exact figure, every decimal: for the review and on tap. */
export function exactText(value, asset) {
  return `${formatUnits(value, asset.decimals, { maxDecimals: asset.decimals })} ${asset.symbol}`;
}

/** A fee "about" this much: rounded down, no "≈" (the word says it). */
export function ethText(wei) {
  return `${formatUnits(wei, ETH.decimals)} ETH`;
}

/** An "at most" figure: rounded UP at the shown precision, so the limit is never understated. */
export function ethMaxText(wei) {
  const v = BigInt(wei);
  const cut = 10n ** BigInt(ETH.decimals - DISPLAY_DECIMALS);
  const up = v % cut === 0n ? v : v + (cut - (v % cut));
  return `${formatUnits(up, ETH.decimals)} ETH`;
}

/** The address in groups of four, so it can be read out and compared. */
export function groupedAddress(address) {
  return `${address.slice(0, 2)} ${address.slice(2).match(/.{1,4}/g).join(' ')}`;
}

export function shortAddress(address) {
  return shorten(address, 6, 4);
}

/**
 * The server could not be asked: say who, and offer the two ways out. Never
 * switches by itself: another server is another party that sees the IP
 * address with the Ethereum address.
 */
export function serverProblem(app, error, { retry, switched }) {
  const cur = ethPrefs(app).host;
  const alt = ETH_RPC_HOSTS.find((x) => x.id === (cur.id === DEFAULT_ETH_RPC ? 'publicnode' : DEFAULT_ETH_RPC));
  // The server's own words (HTTP codes and the like) stay out of sight, for whoever debugs it.
  return h(
    'div',
    { 'data-testid': 'eth-server-problem', title: error && error.message ? error.message : '' },
    notice(
      'error',
      h('strong', { text: `${cur.name}'s Ethereum server didn't answer. ` }),
      'Your coins are safe on Ethereum; only this view is out of date.',
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        h('button', { class: 'btn btn-secondary btn-small', onclick: retry, 'data-testid': 'eth-retry' }, 'Try again'),
        h('button', {
          class: 'btn btn-text btn-small',
          'data-testid': 'eth-use-other',
          onclick: async () => {
            await app.setPrefs({ ethRpc: alt.id });
            switched(alt);
          },
        }, `Use ${alt.name} instead`),
      ),
    ),
  );
}

const STATE_TEXT = {
  signed: 'Sending',
  pending: 'Waiting for Ethereum',
  confirmed: null,
  failed: 'Failed',
  replaced: 'Replaced',
  rejected: 'Not sent',
};

/** A Uniswap swap's or approval's title in the activity list, or null for a payment. */
function swapTitle(item) {
  const open = item.state === 'signed' || item.state === 'pending';
  const failed = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  if (item.kind === 'swap') {
    const to = item.swapOut || 'a token';
    return open ? `Swapping to ${to}` : failed ? 'Swap not done' : `Swapped to ${to}`;
  }
  if (item.kind === 'approve') return open ? `Allowing ${item.asset.symbol}` : failed ? `${item.asset.symbol} not allowed` : `Allowed ${item.asset.symbol}`;
  if (item.kind === 'approveReset') return `Reset the ${item.asset.symbol} permission`;
  return null;
}

/** One row of the Ethereum activity list. */
export function activityRow(item, onclick) {
  const open = item.state === 'signed' || item.state === 'pending';
  const bad = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  const title =
    swapTitle(item) ||
    STATE_TEXT[item.state] ||
    (item.direction === 'in' ? `Received ${item.asset.symbol}` : item.direction === 'self' ? `Sent ${item.asset.symbol} to yourself` : `Sent ${item.asset.symbol}`);
  const when = item.at ? fmtDate(Math.floor(item.at / 1000)) : null;
  const who = item.counterparty ? h('span', { class: 'nowrap', text: `${item.direction === 'in' ? 'from' : 'to'} ${shortAddress(item.counterparty)}` }) : null;
  const sub = [when, when && who ? ' · ' : null, who].filter(Boolean);
  const sign = item.direction === 'in' ? '+' : '−';
  if (item.kind === 'approve' || item.kind === 'approveReset') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': item.kind },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'check')),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr', text: when ? `${when} · for Uniswap` : 'For Uniswap' })),
      h('span', { class: 'end small', title: amountText(item.amount, item.asset), text: item.kind === 'approve' ? `${compactUnits(item.amount, item.asset.decimals)} ${item.asset.symbol}` : '' }),
    );
  }
  if (item.kind === 'swap') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': 'swap' },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'swap')),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr', text: when ? `${when} · Uniswap` : 'Uniswap' })),
      h('span', { class: 'end', title: amountText(item.amount, item.asset), text: `−${compactUnits(item.amount, item.asset.decimals)} ${item.asset.symbol}` }),
    );
  }
  return h(
    'button',
    { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state },
    h('span', { class: `ico ${bad ? 'fail' : item.direction === 'in' ? 'in' : 'out'}` }, icon(open ? 'clock' : item.direction === 'in' ? 'receive' : 'send')),
    h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr' }, ...sub)),
    h('span', { class: `end${item.direction === 'in' && !bad ? ' in' : ''}`, text: `${sign}${amountText(item.amount, item.asset)}` }),
  );
}

