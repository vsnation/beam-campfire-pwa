// Pieces the Ethereum screens share: token badges, amounts in words, the
// "server didn't answer" notice with its two ways out, and activity rows.
import { h, shorten, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { assetBadge, notice, openSheet, toast } from '../lib/ui.js';
import { formatUnits, isRoundedDown, DISPLAY_DECIMALS } from '../lib/eth/units.js';
import { ETH } from '../lib/eth/tokens.js';
import { compactUnits, percentText } from '../lib/compact.js';
import { ETH_RPC_HOSTS, DEFAULT_ETH_RPC, txExplorerUrl } from '../lib/eth/hosts.js';
import { ethPrefs, ethWallet } from '../lib/eth/wallet.js';
import { doubtOf, doubtNameParts, doubtNoun, doubtWayOut, mayForget, DOUBT_TITLE, DOUBT_WHY, FORGET_WARNING } from '../lib/eth/doubt.js';

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
/**
 * A network fee walletFees() refused (lib/eth/rpc.js 'bad_fees'), in words: {title, detail}. Far
 * above what BEAM Campfire pays ('high': Ethereum has been that dear, for minutes), or figures that
 * cannot be right ('jump'). Either way nothing was signed.
 */
export function badFeesWords(error, serverName) {
  if (error && error.data && error.data.problem === 'high') {
    return {
      title: 'The network fee is far above anything BEAM Campfire will pay. ',
      detail: `${serverName}'s Ethereum server says Ethereum is that expensive right now. It has been, but only for minutes at a time. Nothing was sent, and nothing was paid. Try again in a few minutes, or use another server.`,
    };
  }
  return { title: `${serverName}'s Ethereum server gave a network fee that can't be right. `, detail: 'Nothing was sent, and nothing was paid. Try again in a minute, or use another server.' };
}

export function serverProblem(app, error, { retry, switched }) {
  const cur = ethPrefs(app).host;
  const alt = ETH_RPC_HOSTS.find((x) => x.id === (cur.id === DEFAULT_ETH_RPC ? 'publicnode' : DEFAULT_ETH_RPC));
  // Network fee figures refused (lib/eth/rpc.js walletFees): never paid.
  const badFees = Boolean(error && error.code === 'bad_fees');
  const fees = badFees ? badFeesWords(error, cur.name) : null;
  // The server's own words (HTTP codes and the like) stay out of sight, for whoever debugs it.
  return h(
    'div',
    { 'data-testid': 'eth-server-problem', 'data-code': badFees ? 'bad_fees' : null, title: error && error.message ? error.message : '' },
    notice(
      'error',
      h('strong', { text: fees ? fees.title : `${cur.name}'s Ethereum server didn't answer. ` }),
      fees ? fees.detail : 'Your coins are safe on Ethereum; only this view is out of date.',
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

/**
 * A network fee that is a large share of what leaves (lib/eth/send.js isHighFee), said in words,
 * with the tick the send waits for: [notice, tick]. share: the fee as a share of the amount;
 * fee: the fee as text ("0.000273 ETH"); verb: 'send' | 'swap'.
 */
export function highFeeBlock({ share, fee, verb = 'send', ack, onAck, testid = 'eth-high-fee' }) {
  const part = share > 1 ? `is more than what you ${verb}` : `is ${percentText(share)} of what you ${verb}`;
  const n = notice('warn', h('strong', { text: `The network fee, about ${fee}, ${part}. ` }), "Ethereum charges it for every transaction, whatever the amount. If it looks wrong, wait a few minutes or pick another Ethereum server in Settings.");
  n.dataset.testid = testid;
  const box = h('input', { type: 'checkbox', 'data-testid': `${testid}-ack`, checked: ack });
  box.addEventListener('change', () => onAck(box.checked));
  const Verb = verb.charAt(0).toUpperCase() + verb.slice(1);
  return [n, h('label', { class: 'check-row' }, box, h('span', { text: `${Verb} anyway, paying about ${fee} in fees` }))];
}

/** Where a transaction of the outbox is followed: a swap's or permission's own screen, or a payment's. */
export function openEntry(app, entry) {
  app.go(entry.kind ? 'ethSwapTx' : 'ethTx', { hash: entry.hash });
}

/**
 * Why nothing new can be sent while `entry` is in doubt (lib/eth/doubt.js), with the ways out: see
 * it, or pick another server (or turn on History) in Settings; after a day of failed looks, forget
 * it (re-audit RE2-2). inSheet: words only (a sheet stays where it is; its screen behind shows the
 * buttons once it closes). onForgotten: the screen shows itself again once it is forgotten.
 */
export function doubtNotice(app, entry, { inSheet = false, testid = 'eth-doubt', onForgotten = null } = {}) {
  const { lead, address } = doubtNameParts(entry);
  const noun = doubtNoun(entry);
  const forgettable = !inSheet && mayForget(entry);
  const n = notice(
    'warn',
    h(
      'strong',
      {},
      `${lead.charAt(0).toUpperCase()}${lead.slice(1)} `,
      address ? h('span', { class: 'addr-inline', text: address }) : null,
      `${address ? ' ' : ''}is "${DOUBT_TITLE[doubtOf(entry)]}". `,
    ),
    `${DOUBT_WHY} ${doubtWayOut({ history: ethPrefs(app).history })}`,
    forgettable ? ` It has been like this for over a day: you can also forget it.` : '',
    inSheet
      ? null
      : h(
          'div',
          { class: 'btn-row prompt-actions' },
          h('button', { class: 'btn btn-secondary btn-small', onclick: () => openEntry(app, entry), 'data-testid': `${testid}-see` }, `See the ${noun}`),
          h('button', { class: 'btn btn-text btn-small', onclick: () => app.go('ethSettings'), 'data-testid': `${testid}-settings` }, 'Settings'),
        ),
    // Its own row: three buttons do not fit a phone's width.
    forgettable ? h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: () => forgetSheet(app, entry, onForgotten), 'data-testid': `${testid}-forget` }, `Forget this ${noun}`)) : null,
  );
  n.dataset.testid = testid;
  n.dataset.hash = entry.hash;
  if (forgettable) n.dataset.forgettable = 'true';
  return n;
}

/**
 * "Forget this payment", behind a plain warning (lib/eth/doubt.js FORGET_WARNING): that entry only
 * leaves this wallet's list, and sending opens up again. onDone() once it is forgotten (else the
 * screen is shown again).
 */
export function forgetSheet(app, entry, onDone = null) {
  const noun = doubtNoun(entry);
  let message = null;
  openSheet(
    (close, rerender) => [
      h('h2', { 'data-testid': 'eth-forget-title', text: `Forget this ${noun}?` }),
      notice('warn', h('strong', { 'data-testid': 'eth-forget-warning', text: FORGET_WARNING })),
      h('p', { class: 'lead', text: 'BEAM Campfire stops waiting for it, and you can send from this Ethereum wallet again. If it does go through, your balance shows it.' }),
      message,
      h(
        'div',
        { class: 'sheet-actions' },
        h(
          'button',
          {
            class: 'btn btn-danger',
            'data-testid': 'eth-forget-confirm',
            onclick: async () => {
              try {
                const w = await ethWallet(app);
                if (w) await w.forget(entry.hash);
                close();
                toast(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} forgotten`);
                if (onDone) onDone();
                else app.go(app.currentName, app.params, { replace: true });
              } catch (e) {
                message = notice('error', `It was not forgotten: ${e.message}`);
                rerender();
              }
            },
          },
          `Forget this ${noun}`,
        ),
        h('button', { class: 'btn btn-text', 'data-testid': 'eth-forget-keep', onclick: () => close() }, 'Keep waiting'),
      ),
    ],
    { label: `Forget this ${noun}` },
  );
}

/** Ethereum Home's one line above Send while a transaction is in doubt; tapping it opens that transaction. */
export function doubtLine(app, entry) {
  const n = notice('warn', h('span', { text: `Sending is paused: a ${doubtNoun(entry)} is "${DOUBT_TITLE[doubtOf(entry)]}". ` }), h('button', { class: 'btn btn-text btn-small inline', onclick: () => openEntry(app, entry), 'data-testid': 'eth-doubt-line-see' }, 'See it'));
  n.dataset.testid = 'eth-doubt-line';
  n.dataset.hash = entry.hash;
  return n;
}

/**
 * While the screen is open, visible and a transaction is in doubt: follow it every few seconds
 * (the same one look Ethereum Home takes), and call onChange when the doubt may have changed.
 * Returns stop().
 */
export function followDoubt(app, getWallet, onChange, { every = 4000 } = {}) {
  let busy = false;
  const t = setInterval(async () => {
    const w = getWallet();
    if (busy || !w || !app.dbPass || document.visibilityState !== 'visible' || !w.doubt()) return;
    busy = true;
    try {
      await w.followOpen();
    } catch {
      /* the next look tries again */
    } finally {
      busy = false;
    }
    onChange();
  }, every);
  return () => clearInterval(t);
}

/**
 * "Not sent" is one server's verdict after half an hour of refusals (lib/eth/send.js
 * REFUSAL_WATCH_MS), said as such, with Etherscan one tap away (release audit BM-2).
 */
export const NOT_SENT_NOTE =
  "Your Ethereum server refused it for half an hour and never showed it on Ethereum, so most likely it never left and nothing was spent. That is the server's word, not Ethereum's. BEAM Campfire looks for it again each time you open your Ethereum wallet.";

/**
 * Beside a verified "Replaced" that Stack Wallet's index lists in a block (re-audit RE2-5): both are
 * said, and "Replaced" stays until the chosen server shows this one's own receipt. said: {state,
 * blockNumber} (lib/eth/wallet.js indexSays); noun: 'payment' | 'swap' | 'permission'.
 */
export function indexSaysNotice(said, noun = 'payment') {
  const where = `in block ${Number(said.blockNumber).toLocaleString('en-US')}`;
  const n = notice(
    'warn',
    `Stack Wallet's history index says this ${noun} ${said.state === 'failed' ? `failed ${where}` : `is ${where}`}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this ${noun} in a block too. Etherscan can tell you which is right.`,
  );
  n.dataset.testid = 'eth-index-says';
  return n;
}

/** The "Not sent" notice of a payment's or swap's screen: NOT_SENT_NOTE, what the server said, and Etherscan. */
export function notSentNotice(hash, serverSaid = null) {
  const n = notice(
    'error',
    `${NOT_SENT_NOTE}${serverSaid ? ` The server said: ${serverSaid}` : ''}`,
    h('div', {}, h('a', { class: 'btn btn-text btn-small inline', href: txExplorerUrl(hash), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'eth-not-sent-explorer' }, 'Check it on Etherscan')),
  );
  n.dataset.testid = 'eth-not-sent';
  return n;
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
    (item.doubt === 'unsure' ? 'Not sure yet' : item.doubt === 'refused' ? 'Not sent yet' : null) ||
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
    h('span', { class: `end${bad ? '' : item.direction === 'in' ? ' in' : ' out'}`, text: `${sign}${amountText(item.amount, item.asset)}` }),
  );
}

