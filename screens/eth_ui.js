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
import { doubtOf, doubtHeadline, doubtNoun, doubtWayOut, mayForget, DOUBT_WHY, FORGET_WARNING } from '../lib/eth/doubt.js';
import { t, tk, tNodes } from '../lib/i18n.js';

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
  const txt = `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
  return approx && isRoundedDown(value, asset.decimals) ? `≈${txt}` : txt;
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
      title: `${t('The network fee is far above anything BEAM Campfire will pay.')} `,
      detail: t("{server}'s Ethereum server says Ethereum is that expensive right now. It has been, but only for minutes at a time. Nothing was sent, and nothing was paid. Try again in a few minutes, or use another server.", { server: serverName }),
    };
  }
  return { title: `${t("{server}'s Ethereum server gave a network fee that can't be right.", { server: serverName })} `, detail: t('Nothing was sent, and nothing was paid. Try again in a minute, or use another server.') };
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
      h('strong', { text: fees ? fees.title : `${t("{server}'s Ethereum server didn't answer.", { server: cur.name })} ` }),
      fees ? fees.detail : t('Your coins are safe on Ethereum; only this view is out of date.'),
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        h('button', { class: 'btn btn-secondary btn-small', onclick: retry, 'data-testid': 'eth-retry' }, t('Try again')),
        h('button', {
          class: 'btn btn-text btn-small',
          'data-testid': 'eth-use-other',
          onclick: async () => {
            await app.setPrefs({ ethRpc: alt.id });
            switched(alt);
          },
        }, t('Use {server} instead', { server: alt.name })),
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
  const swap = verb === 'swap';
  const percent = percentText(share);
  const head =
    share > 1
      ? swap
        ? t('The network fee, about {fee}, is more than what you swap.', { fee })
        : t('The network fee, about {fee}, is more than what you send.', { fee })
      : swap
        ? t('The network fee, about {fee}, is {percent} of what you swap.', { fee, percent })
        : t('The network fee, about {fee}, is {percent} of what you send.', { fee, percent });
  const n = notice('warn', ...tNodes('{lead} Ethereum charges it for every transaction, whatever the amount. If it looks wrong, wait a few minutes or pick another Ethereum server in Settings.', { lead: h('strong', { text: head }) }));
  n.dataset.testid = testid;
  const box = h('input', { type: 'checkbox', 'data-testid': `${testid}-ack`, checked: ack });
  box.addEventListener('change', () => onAck(box.checked));
  const label = swap ? t('Swap anyway, paying about {fee} in fees', { fee }) : t('Send anyway, paying about {fee} in fees', { fee });
  return [n, h('label', { class: 'check-row' }, box, h('span', { text: label }))];
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
// The words that name the kind of transaction in doubt (lib/eth/doubt.js doubtNoun), each whole.
const NOUN_WORDS = Object.freeze({
  payment: Object.freeze({ see: tk('See the payment'), forget: tk('Forget this payment'), ask: tk('Forget this payment?'), forgotten: tk('Payment forgotten'), paused: Object.freeze({ unsure: tk('Sending is paused: a payment is "Not sure yet".'), refused: tk('Sending is paused: a payment is "Not sent yet".') }) }),
  swap: Object.freeze({ see: tk('See the swap'), forget: tk('Forget this swap'), ask: tk('Forget this swap?'), forgotten: tk('Swap forgotten'), paused: Object.freeze({ unsure: tk('Sending is paused: a swap is "Not sure yet".'), refused: tk('Sending is paused: a swap is "Not sent yet".') }) }),
  permission: Object.freeze({ see: tk('See the permission'), forget: tk('Forget this permission'), ask: tk('Forget this permission?'), forgotten: tk('Permission forgotten'), paused: Object.freeze({ unsure: tk('Sending is paused: a permission is "Not sure yet".'), refused: tk('Sending is paused: a permission is "Not sent yet".') }) }),
});
const nounWords = (entry) => NOUN_WORDS[doubtNoun(entry)] || NOUN_WORDS.payment;

export function doubtNotice(app, entry, { inSheet = false, testid = 'eth-doubt', onForgotten = null } = {}) {
  const { key, params } = doubtHeadline(entry);
  const words = nounWords(entry);
  const forgettable = !inSheet && mayForget(entry);
  const n = notice(
    'warn',
    h('strong', {}, ...tNodes(key, params.address ? { ...params, address: h('span', { class: 'addr-inline', text: params.address }) } : params), ' '),
    `${t(DOUBT_WHY)} ${doubtWayOut({ history: ethPrefs(app).history })}`,
    forgettable ? ` ${t('It has been like this for over a day: you can also forget it.')}` : '',
    inSheet
      ? null
      : h(
          'div',
          { class: 'btn-row prompt-actions' },
          h('button', { class: 'btn btn-secondary btn-small', onclick: () => openEntry(app, entry), 'data-testid': `${testid}-see` }, t(words.see)),
          h('button', { class: 'btn btn-text btn-small', onclick: () => app.go('ethSettings'), 'data-testid': `${testid}-settings` }, t('Settings')),
        ),
    // Its own row: three buttons do not fit a phone's width.
    forgettable ? h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: () => forgetSheet(app, entry, onForgotten), 'data-testid': `${testid}-forget` }, t(words.forget))) : null,
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
  const words = nounWords(entry);
  let message = null;
  openSheet(
    (close, rerender) => [
      h('h2', { 'data-testid': 'eth-forget-title', text: t(words.ask) }),
      notice('warn', h('strong', { 'data-testid': 'eth-forget-warning', text: t(FORGET_WARNING) })),
      h('p', { class: 'lead', text: t('BEAM Campfire stops waiting for it, and you can send from this Ethereum wallet again. If it does go through, your balance shows it.') }),
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
                toast(t(words.forgotten));
                if (onDone) onDone();
                else app.go(app.currentName, app.params, { replace: true });
              } catch (e) {
                message = notice('error', t('It was not forgotten: {reason}', { reason: e.message }));
                rerender();
              }
            },
          },
          t(words.forget),
        ),
        h('button', { class: 'btn btn-text', 'data-testid': 'eth-forget-keep', onclick: () => close() }, t('Keep waiting')),
      ),
    ],
    { label: t(words.forget) },
  );
}

/** Ethereum Home's one line above Send while a transaction is in doubt; tapping it opens that transaction. */
export function doubtLine(app, entry) {
  const paused = nounWords(entry).paused[doubtOf(entry) === 'unsure' ? 'unsure' : 'refused'];
  const n = notice('warn', h('span', { text: `${t(paused)} ` }), h('button', { class: 'btn btn-text btn-small inline', onclick: () => openEntry(app, entry), 'data-testid': 'eth-doubt-line-see' }, t('See it')));
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
  const timer = setInterval(async () => {
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
  return () => clearInterval(timer);
}

/**
 * "Not sent" is one server's verdict after half an hour of refusals (lib/eth/send.js
 * REFUSAL_WATCH_MS), said as such, with Etherscan one tap away (release audit BM-2).
 */
export const NOT_SENT_NOTE = tk(
  "Your Ethereum server refused it for half an hour and never showed it on Ethereum, so most likely it never left and nothing was spent. That is the server's word, not Ethereum's. BEAM Campfire looks for it again each time you open your Ethereum wallet.",
);

/**
 * Beside a verified "Replaced" that Stack Wallet's index lists in a block (re-audit RE2-5): both are
 * said, and "Replaced" stays until the chosen server shows this one's own receipt. said: {state,
 * blockNumber} (lib/eth/wallet.js indexSays); noun: 'payment' | 'swap' | 'permission'.
 */
const INDEX_SAYS = Object.freeze({
  payment: Object.freeze({
    failed: tk('Stack Wallet\'s history index says this payment failed in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this payment in a block too. Etherscan can tell you which is right.'),
    mined: tk('Stack Wallet\'s history index says this payment is in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this payment in a block too. Etherscan can tell you which is right.'),
  }),
  swap: Object.freeze({
    failed: tk('Stack Wallet\'s history index says this swap failed in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this swap in a block too. Etherscan can tell you which is right.'),
    mined: tk('Stack Wallet\'s history index says this swap is in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this swap in a block too. Etherscan can tell you which is right.'),
  }),
  permission: Object.freeze({
    failed: tk('Stack Wallet\'s history index says this permission failed in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this permission in a block too. Etherscan can tell you which is right.'),
    mined: tk('Stack Wallet\'s history index says this permission is in block {block}. Your Ethereum server showed another transaction from this wallet in its place, so it stays "Replaced" here until your server shows this permission in a block too. Etherscan can tell you which is right.'),
  }),
});

export function indexSaysNotice(said, noun = 'payment') {
  const says = INDEX_SAYS[noun] || INDEX_SAYS.payment;
  const n = notice('warn', t(said.state === 'failed' ? says.failed : says.mined, { block: Number(said.blockNumber).toLocaleString('en-US') }));
  n.dataset.testid = 'eth-index-says';
  return n;
}

/** The "Not sent" notice of a payment's or swap's screen: NOT_SENT_NOTE, what the server said, and Etherscan. */
export function notSentNotice(hash, serverSaid = null) {
  const n = notice(
    'error',
    `${t(NOT_SENT_NOTE)}${serverSaid ? ` ${t('The server said: {reason}', { reason: serverSaid })}` : ''}`,
    h('div', {}, h('a', { class: 'btn btn-text btn-small inline', href: txExplorerUrl(hash), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'eth-not-sent-explorer' }, t('Check it on Etherscan'))),
  );
  n.dataset.testid = 'eth-not-sent';
  return n;
}

const STATE_TEXT = {
  signed: tk('Sending'),
  pending: tk('Waiting for Ethereum'),
  confirmed: null,
  failed: tk('Failed'),
  replaced: tk('Replaced'),
  rejected: tk('Not sent'),
};

/** A Uniswap swap's or approval's title in the activity list, or null for a payment. */
function swapTitle(item) {
  const open = item.state === 'signed' || item.state === 'pending';
  const failed = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  if (item.kind === 'swap') {
    const to = item.swapOut;
    if (open) return to ? t('Swapping to {symbol}', { symbol: to }) : t('Swapping to a token');
    if (failed) return t('Swap not done');
    return to ? t('Swapped to {symbol}', { symbol: to }) : t('Swapped to a token');
  }
  const symbol = item.asset.symbol;
  if (item.kind === 'approve') return open ? t('Allowing {symbol}', { symbol }) : failed ? t('{symbol} not allowed', { symbol }) : t('Allowed {symbol}', { symbol });
  if (item.kind === 'approveReset') return t('Reset the {symbol} permission', { symbol });
  return null;
}

/** One row of the Ethereum activity list. */
export function activityRow(item, onclick) {
  const open = item.state === 'signed' || item.state === 'pending';
  const bad = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  const symbol = item.asset.symbol;
  const title =
    (item.doubt === 'unsure' ? t('Not sure yet') : item.doubt === 'refused' ? t('Not sent yet') : null) ||
    swapTitle(item) ||
    (STATE_TEXT[item.state] ? t(STATE_TEXT[item.state]) : null) ||
    (item.direction === 'in' ? t('Received {symbol}', { symbol }) : item.direction === 'self' ? t('Sent {symbol} to yourself', { symbol }) : t('Sent {symbol}', { symbol }));
  const when = item.at ? fmtDate(Math.floor(item.at / 1000)) : null;
  const who = item.counterparty ? h('span', { class: 'nowrap', text: item.direction === 'in' ? t('from {address}', { address: shortAddress(item.counterparty) }) : t('to {address}', { address: shortAddress(item.counterparty) }) }) : null;
  const sub = [when, when && who ? ' · ' : null, who].filter(Boolean);
  const sign = item.direction === 'in' ? '+' : '−';
  if (item.kind === 'approve' || item.kind === 'approveReset') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': item.kind },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'check')),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr', text: when ? t('{when} · for Uniswap', { when }) : t('For Uniswap') })),
      h('span', { class: 'end small', title: amountText(item.amount, item.asset), text: item.kind === 'approve' ? `${compactUnits(item.amount, item.asset.decimals)} ${item.asset.symbol}` : '' }),
    );
  }
  if (item.kind === 'swap') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': 'swap' },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'swap')),
      // i18n-ignore: the date and a brand name, no words
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

