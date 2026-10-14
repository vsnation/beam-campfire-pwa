// An address's past transactions, from Stack Wallet's history index
// (GET /export on eth2.stackwallet.com, the desktop app's
// lib/services/ethereum/ethereum_api.dart), merged with what this device sent
// (lib/eth/outbox.js). Asked only while Settings -> Ethereum -> "History from
// Stack Wallet" is on; with it off, only this device's own transactions show.
//
// What the index answers is untrusted: every field is checked, anything that
// does not parse is dropped, and amounts are exact BigInts. The fee is
// gasUsed x effectiveGasPrice (both small integers), not the index's
// gasCost, which arrives as a JSON number and loses digits above 2^53 wei.
//
// The index answers at most PAGE transactions per request, oldest first;
// later pages start at the last block seen (firstBlock), as the desktop app
// does. Token movements come from one request per known token (`emitter`):
// only Transfer events naming this address, only for the tokens in
// lib/eth/tokens.js.

import { historyUrl } from './hosts.js';
import { ETH, TOKENS } from './tokens.js';
import { t } from '../i18n.js';

export const PAGE = 250;
export const MAX_PAGES = 8;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'network' | 'timeout' | 'http' | 'bad_response'
  }
}

function uint(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string' && /^\d{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  return null;
}

function blockNo(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function direction(from, to, me) {
  if (from === me && to === me) return 'self';
  return from === me ? 'out' : 'in';
}

/**
 * The index's transaction list for `address` -> [{hash, blockNumber,
 * timestamp, from, to, value, fee, failed, nonce, contractCall}], skipping
 * entries that do not name the address or do not parse.
 */
export function parseTransactions(json, address) {
  const me = address.toLowerCase();
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) throw new HistoryError('bad_response', t("The history index's answer has no list."));
  const out = [];
  for (const tx of list) {
    if (!tx || typeof tx !== 'object' || !HASH.test(tx.hash) || !ADDR.test(tx.from) || !(tx.to === null || ADDR.test(tx.to))) continue;
    const from = tx.from.toLowerCase();
    const to = tx.to ? tx.to.toLowerCase() : null;
    if (from !== me && to !== me) continue;
    const value = uint(tx.value);
    if (value === null) continue;
    const receipt = tx.receipt && typeof tx.receipt === 'object' ? tx.receipt : null;
    const gasUsed = uint(receipt && receipt.gasUsed != null ? receipt.gasUsed : tx.gasUsed);
    const price = uint(receipt && receipt.effectiveGasPrice != null ? receipt.effectiveGasPrice : tx.gasPrice);
    const blockNumber = blockNo(tx.blockNumber);
    out.push({
      hash: tx.hash.toLowerCase(),
      blockNumber,
      timestamp: Number.isSafeInteger(tx.timestamp) && tx.timestamp > 0 ? tx.timestamp : null,
      from,
      to,
      value,
      fee: gasUsed !== null && price !== null ? gasUsed * price : null,
      failed: Boolean(receipt && receipt.status === 0) || tx.isError === true,
      nonce: Number.isSafeInteger(tx.nonce) ? tx.nonce : null,
      contractCall: typeof tx.input === 'string' && tx.input.length > 2,
    });
  }
  return out;
}

function topicAddress(topic) {
  if (typeof topic !== 'string' || !WORD.test(topic) || !/^0x0{24}/i.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * The index's logs of `token` about `address` -> its Transfer events that move
 * the token to or from the address: [{hash, blockNumber, timestamp, logIndex,
 * from, to, amount, token}]. Approvals and other events are skipped.
 */
export function parseTokenTransfers(json, address, token) {
  const me = address.toLowerCase();
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) throw new HistoryError('bad_response', t("The history index's answer has no list."));
  const out = [];
  for (const l of list) {
    if (!l || typeof l !== 'object' || !HASH.test(l.transactionHash) || typeof l.address !== 'string' || l.address.toLowerCase() !== token.address) continue;
    if (!Array.isArray(l.topics) || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    if (!from || !to || (from !== me && to !== me)) continue;
    if (typeof l.data !== 'string' || !WORD.test(l.data)) continue;
    out.push({
      hash: l.transactionHash.toLowerCase(),
      blockNumber: blockNo(l.blockNumber),
      timestamp: Number.isSafeInteger(l.timestamp) && l.timestamp > 0 ? l.timestamp : null,
      logIndex: Number.isSafeInteger(l.logIndex) ? l.logIndex : 0,
      from,
      to,
      amount: BigInt(l.data),
      token,
    });
  }
  return out;
}

/**
 * Outbox states that are one server's verdict, not Ethereum's: a block in the index outranks them
 * (release audit BM-2). Only 'rejected': 'replaced' was shown with evidence (the transaction that
 * took the nonce, signed by this wallet's key, with a receipt: send.js followOnce), and an index row
 * is a third party's word; it is shown beside it (indexSays) and settled only by the chosen server
 * serving this hash's own receipt (wallet.js recheckRejected; re-audit RE2-5).
 */
const OUTRANKED = new Set(['rejected']);

/** hash -> {blockNumber, failed, at} for every transaction the index shows in a block (a token transfer is one that succeeded). */
function minedRows(txs, transfers) {
  const out = new Map();
  for (const tx of txs) if (tx.blockNumber !== null) out.set(tx.hash, { blockNumber: tx.blockNumber, failed: tx.failed, at: tx.timestamp ? tx.timestamp * 1000 : null });
  for (const x of transfers) if (x.blockNumber !== null && !out.has(x.hash)) out.set(x.hash, { blockNumber: x.blockNumber, failed: false, at: x.timestamp ? x.timestamp * 1000 : null });
  return out;
}

/** What the index shows for `hash` in a block: {state: 'confirmed' | 'failed', blockNumber}, or null. */
export function indexBlockOf({ txs = [], transfers = [] }, hash) {
  const m = minedRows(txs, transfers).get(String(hash).toLowerCase());
  return m ? { state: m.failed ? 'failed' : 'confirmed', blockNumber: m.blockNumber } : null;
}

/**
 * Entries of `outbox` that one server ended as 'rejected' (never sent), while the
 * history index shows that very transaction in a block: [{hash, state: 'confirmed' | 'failed',
 * blockNumber}]. A transaction in a block was sent; the wallet writes it down (wallet.js
 * settleFromIndex) so it never reads "Not sent" again.
 */
export function minedInIndex({ outbox = [], txs = [], transfers = [] }) {
  const mined = minedRows(txs, transfers);
  const out = [];
  for (const e of outbox) {
    const m = OUTRANKED.has(e.state) ? mined.get(e.hash) : null;
    if (m) out.push({ hash: e.hash, state: m.failed ? 'failed' : 'confirmed', blockNumber: m.blockNumber });
  }
  return out;
}

/**
 * One list for the screen, newest first. Each item: {hash, at (ms or null),
 * blockNumber, direction 'in'|'out'|'self', asset (ETH or a token), amount,
 * counterparty, fee (wei, only what this address paid), state, local}.
 * state: 'confirmed' | 'failed' | an outbox state for what is still open.
 * A transaction this device sent is shown once: the outbox entry, completed
 * with what the index knows. A token transfer replaces its 0-ETH call. An
 * entry one server called 'rejected' or 'replaced' that the index shows in a
 * block is shown as mined (confirmed, or failed).
 */
export function mergeActivity({ address, outbox = [], txs = [], transfers = [] }) {
  const me = address.toLowerCase();
  const mined = minedRows(txs, transfers);
  const byHash = new Map();
  const fees = new Map();
  for (const tx of txs) {
    if (tx.from === me && tx.fee !== null) fees.set(tx.hash, tx.fee);
    if (tx.value === 0n && tx.contractCall) continue; // a contract call: shown through its token transfer, if any
    byHash.set(`${tx.hash}:eth`, {
      hash: tx.hash,
      at: tx.timestamp ? tx.timestamp * 1000 : null,
      blockNumber: tx.blockNumber,
      direction: direction(tx.from, tx.to, me),
      asset: ETH,
      amount: tx.value,
      counterparty: tx.from === me ? tx.to : tx.from,
      fee: tx.from === me ? tx.fee : null,
      state: tx.failed ? 'failed' : 'confirmed',
      local: false,
    });
  }
  for (const x of transfers) {
    byHash.set(`${x.hash}:${x.token.address}:${x.logIndex}`, {
      hash: x.hash,
      at: x.timestamp ? x.timestamp * 1000 : null,
      blockNumber: x.blockNumber,
      direction: direction(x.from, x.to, me),
      asset: x.token,
      amount: x.amount,
      counterparty: x.from === me ? x.to : x.from,
      fee: x.from === me ? fees.get(x.hash) ?? null : null,
      state: 'confirmed',
      local: false,
    });
  }
  // What this device sent replaces whatever the index said about the same hash.
  for (const e of outbox) {
    for (const k of [...byHash.keys()]) if (k.startsWith(`${e.hash}:`)) byHash.delete(k);
    const asset = e.token ? TOKENS.find((tok) => tok.address === e.token.toLowerCase()) || null : ETH;
    if (!asset) continue;
    const r = e.receipt;
    // One server's "never sent" or "replaced" against a block in the index: the block wins.
    const won = OUTRANKED.has(e.state) ? mined.get(e.hash) : null;
    // A verified "Replaced" the index contradicts: shown as replaced, with the index's word beside it.
    const said = e.state === 'replaced' ? mined.get(e.hash) : null;
    byHash.set(`${e.hash}:local`, {
      hash: e.hash,
      at: e.createdAt,
      blockNumber: won ? won.blockNumber : r ? r.blockNumber : null,
      direction: e.to.toLowerCase() === me ? 'self' : 'out',
      asset,
      amount: BigInt(e.amount),
      counterparty: e.to.toLowerCase(),
      // The index's fee only for what it outranks: a "Replaced" it contradicts paid nothing on our word.
      fee: r && r.gasUsed && r.effectiveGasPrice ? BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) : said ? null : fees.get(e.hash) ?? null,
      state: won ? (won.failed ? 'failed' : 'confirmed') : e.state,
      local: true,
      // A Uniswap swap or approval sent from this device (lib/eth/uniswap_app.js): what it was for.
      kind: typeof e.kind === 'string' ? e.kind : null,
      swapOut: typeof e.tokenOutSymbol === 'string' ? e.tokenOutSymbol : null,
      // Open but in doubt (lib/eth/send.js): 'unsure' (its nonce said used, nothing shown) or 'refused'.
      doubt: e.state !== 'signed' && e.state !== 'pending' ? null : e.unsureSince ? 'unsure' : e.refusedAt && e.state === 'signed' ? 'refused' : null,
      indexSays: said ? { state: said.failed ? 'failed' : 'confirmed', blockNumber: said.blockNumber } : null,
    });
  }
  const items = [...byHash.values()];
  // Open ones first, then by block (newest), then by time.
  const open = (i) => (i.state === 'signed' || i.state === 'pending' ? 1 : 0);
  items.sort((a, b) => open(b) - open(a) || (b.blockNumber ?? Infinity) - (a.blockNumber ?? Infinity) || (b.at ?? 0) - (a.at ?? 0));
  return items;
}

async function getJson(url, { fetch: fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl.signal });
    } catch {
      if (ctrl.signal.aborted) throw new HistoryError('timeout', t("Stack Wallet's history index didn't answer in time."));
      throw new HistoryError('network', t("Stack Wallet's history index could not be reached."));
    }
    if (!res.ok) throw new HistoryError('http', t("Stack Wallet's history index answered HTTP {status}.", { status: res.status }));
    const text = await res.text();
    // An address with nothing gets an empty body, not an empty list (as the desktop app notes).
    if (!text.trim()) return { data: [] };
    try {
      return JSON.parse(text);
    } catch {
      throw new HistoryError('bad_response', t("Stack Wallet's history index did not answer with JSON."));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything the index knows about `address`: {txs, transfers}. Throws a
 * HistoryError when the index cannot be asked; the caller still shows the
 * outbox.
 */
export async function fetchHistory(address, { fetch, timeoutMs, tokens = TOKENS } = {}) {
  const opts = { fetch, timeoutMs };
  const txs = [];
  const seen = new Set();
  let firstBlock = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await getJson(historyUrl(address, { firstBlock }), opts);
    const raw = Array.isArray(json && json.data) ? json.data.length : 0;
    let last = firstBlock;
    for (const tx of parseTransactions(json, address)) {
      if (tx.blockNumber !== null && tx.blockNumber > last) last = tx.blockNumber;
      if (seen.has(tx.hash)) continue;
      seen.add(tx.hash);
      txs.push(tx);
    }
    if (raw < PAGE || last === firstBlock) break;
    firstBlock = last;
  }
  const transfers = (await Promise.all(tokens.map(async (token) => parseTokenTransfers(await getJson(historyUrl(address, { emitter: token.address }), opts), address, token)))).flat();
  return { txs, transfers };
}
