// Ethereum JSON-RPC over one server the person chose from hosts.js, and no
// other: no fallback, because every server sees the IP address together with
// the Ethereum address it is asked about. (The one second opinion, a swap's
// price, asks another listed server no question about the address:
// lib/eth/second_opinion.js.)
//
// Requests carry no cookies or credentials (credentials:'omit'), skip the
// HTTP cache (cache:'no-store': balances and nonces must be fresh), refuse
// redirects, send no referrer, and time out. Results are checked before they
// are used: ids must match, quantities must be hex, a broadcast's hash must
// be keccak256 of the bytes sent. A port of the desktop app's
// lib/wallets/ethereum/uniswap/eth_rpc.dart, plus the wallet calls.

import { ETH_RPC_HOSTS, ethRpcHost, rpcUrl } from './hosts.js';
import { encodeCall, abiDecode } from './abi.js';
import { keccak256, normAddress } from './crypto.js';
import { MAINNET_CHAIN_ID } from './tx.js';
import { bytesToHex, hexToBytes, toBytes, toQuantity, fromQuantity, fromQuantityNumber, bigIntToBytes, toBigInt } from './hex.js';
import { t } from '../i18n.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const GWEI = 1000000000n;
/** The lowest tip walletFees() offers: 0.01 gwei. */
export const MIN_TIP_WEI = 10000000n;
/** A tip up to this is taken from the server as it is: 3 gwei (the bridge relayer's own ceiling). */
export const EASY_TIP_WEI = 3n * GWEI;
/** Never a higher tip than this, whatever the server says: 20 gwei. */
export const MAX_TIP_WEI = 20n * GWEI;
/**
 * A base fee above this is not paid: 1,000 gwei, far above anything Ethereum has charged for years.
 * Ethereum has passed it (over 8,000 gwei for a few blocks on 2022-05-01), so it is said as more than
 * BEAM Campfire will pay, not as impossible: a wait of minutes, never a loss.
 */
export const MAX_BASE_FEE_WEI = 1000n * GWEI;
/** Default widest eth_getLogs window; wider requests are refused before they are sent. */
export const MAX_LOG_RANGE = 10000;

export class EthRpcError extends Error {
  /**
   * code: the server's JSON-RPC error code (a number), or one of 'network',
   * 'timeout', 'http', 'busy', 'bad_response', 'wrong_chain', 'range',
   * 'hash_mismatch', 'bad_fees' (network fee figures that cannot be
   * Ethereum's: walletFees) for problems found on this side.
   */
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }

  /** The server refused a log search because the block range is too long. */
  get isRangeTooLong() {
    if (this.code === 'range') return true;
    if (typeof this.code !== 'number') return false;
    const m = this.message.toLowerCase();
    return (
      m.includes('range') ||
      (m.includes('block') && (m.includes('limit') || m.includes('max'))) ||
      m.includes('too many') ||
      m.includes('exceed') ||
      m.includes('archive') ||
      m.includes('10000') ||
      m.includes('query returned more than')
    );
  }

  /** The largest range the message names ("max block range 100000", "up to a 10 block range"), if any. */
  get suggestedRange() {
    const ns = [...this.message.matchAll(/(\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isSafeInteger(n) && n >= 10 && n <= 5000000);
    return ns.length ? Math.min(...ns) : null;
  }
}

const TAGS = new Set(['latest', 'pending', 'safe', 'finalized', 'earliest']);

function blockParam(b) {
  if (typeof b === 'string' && TAGS.has(b)) return b;
  return toQuantity(b);
}

function txObject({ from, to, data, value }) {
  const o = {};
  if (from) o.from = normAddress(from);
  if (to) o.to = normAddress(to);
  if (data !== undefined) o.data = bytesToHex(toBytes(data));
  if (value !== undefined && toBigInt(value) > 0n) o.value = toQuantity(value);
  return o;
}

function dataResult(r, what) {
  if (typeof r !== 'string') throw new EthRpcError('bad_response', `${what}: expected hex data`); // i18n-ignore: a diagnostic naming the RPC field, for whoever debugs the server
  try {
    return hexToBytes(r);
  } catch {
    throw new EthRpcError('bad_response', `${what}: expected hex data`); // i18n-ignore: a diagnostic naming the RPC field, for whoever debugs the server
  }
}

function quantityResult(r, what) {
  try {
    return fromQuantity(r);
  } catch {
    throw new EthRpcError('bad_response', `${what}: expected a hex quantity`); // i18n-ignore: a diagnostic naming the RPC field, for whoever debugs the server
  }
}

function parseLog(l) {
  if (!l || typeof l.address !== 'string' || !Array.isArray(l.topics)) throw new EthRpcError('bad_response', 'bad log entry'); // i18n-ignore: a diagnostic for whoever debugs the server
  return {
    address: l.address.toLowerCase(),
    topics: l.topics.map((x) => String(x).toLowerCase()),
    data: dataResult(l.data, 'log data'), // i18n-ignore: the field a diagnostic names
    blockNumber: l.blockNumber == null ? null : fromQuantityNumber(l.blockNumber),
    transactionHash: l.transactionHash ? String(l.transactionHash).toLowerCase() : null,
    logIndex: l.logIndex == null ? null : fromQuantityNumber(l.logIndex),
    removed: l.removed === true,
  };
}

export class EthRpc {
  /**
   * host: an entry of ETH_RPC_HOSTS or its id. `fetch` and `timeoutMs` are
   * for tests and slow links; the URL can only come from the list.
   */
  constructor(host, { fetch: fetchImpl, timeoutMs = 20000, maxBatch = 25 } = {}) {
    this.host = typeof host === 'string' ? ethRpcHost(host) : host;
    if (!ETH_RPC_HOSTS.includes(this.host)) throw new Error('Not one of the listed Ethereum servers.'); // i18n-ignore: a programming error (hosts come from the list)
    this.url = rpcUrl(this.host);
    this.timeoutMs = timeoutMs;
    this.maxBatch = maxBatch;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._id = 0;
  }

  async _post(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await this._fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: ctrl.signal,
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new EthRpcError('timeout', t("{server} didn't answer in time.", { server: this.host.name }));
        throw new EthRpcError('network', t('{server} could not be reached.', { server: this.host.name }));
      }
      if (res.status === 429) throw new EthRpcError('busy', t('{server} is busy (too many requests).', { server: this.host.name }));
      let text;
      try {
        text = await res.text();
      } catch {
        throw new EthRpcError(ctrl.signal.aborted ? 'timeout' : 'network', t('{server} stopped answering.', { server: this.host.name }));
      }
      if (!text) throw new EthRpcError('http', t('Empty answer from {server} (HTTP {status}).', { server: this.host.name, status: res.status }));
      try {
        return JSON.parse(text);
      } catch {
        throw new EthRpcError('http', t('{server} did not answer with JSON (HTTP {status}).', { server: this.host.name, status: res.status }));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  static _result(m, id) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new EthRpcError('bad_response', t('Not a JSON-RPC answer.'));
    if (id !== undefined && m.id !== id) throw new EthRpcError('bad_response', t('The answer is for another request.'));
    if (m.error) {
      const e = m.error;
      // The server's own words pass through as they are. 'RPC error' stands in for a missing one and stays
      // English like them: code reads these messages (isRangeTooLong, suggestedRange, send.js).
      throw new EthRpcError(typeof e.code === 'number' ? e.code : -1, typeof e.message === 'string' ? e.message : 'RPC error', typeof e.data === 'string' ? e.data : null); // i18n-ignore: stands in for the server's own message, which code reads
    }
    if (!('result' in m)) throw new EthRpcError('bad_response', t('A JSON-RPC answer without a result.'));
    return m.result;
  }

  async call(method, params = []) {
    const id = ++this._id;
    return EthRpc._result(await this._post({ jsonrpc: '2.0', id, method, params }), id);
  }

  /**
   * Several requests in few round trips: [[method, params], …] → results in
   * order, each a value or an EthRpcError. Falls back to one by one when the
   * server does not take batches.
   */
  async batch(requests) {
    const out = [];
    for (let i = 0; i < requests.length; i += this.maxBatch) {
      const part = requests.slice(i, i + this.maxBatch);
      const first = this._id + 1;
      const payload = part.map(([method, params = []]) => ({ jsonrpc: '2.0', id: ++this._id, method, params }));
      const answer = await this._post(payload);
      if (!Array.isArray(answer)) {
        for (const [method, params] of part) out.push(await this.call(method, params).catch((e) => e));
        continue;
      }
      const byId = new Map(answer.filter((a) => a && typeof a === 'object').map((a) => [a.id, a]));
      part.forEach((_, j) => {
        const item = byId.get(first + j);
        if (!item) out.push(new EthRpcError('bad_response', t('No answer in the batch.')));
        else {
          try {
            out.push(EthRpc._result(item));
          } catch (e) {
            out.push(e);
          }
        }
      });
    }
    return out;
  }

  async chainId() {
    return quantityResult(await this.call('eth_chainId'), 'eth_chainId');
  }

  /** Asks the server again every time: call right before signing. */
  async assertMainnet() {
    const id = await this.chainId();
    if (id !== MAINNET_CHAIN_ID) throw new EthRpcError('wrong_chain', t('{server} is not Ethereum mainnet (chain id {id}).', { server: this.host.name, id }));
  }

  async blockNumber() {
    return fromQuantityNumber(await this.call('eth_blockNumber'));
  }

  async getBalance(address, block = 'latest') {
    return quantityResult(await this.call('eth_getBalance', [normAddress(address), blockParam(block)]), 'eth_getBalance');
  }

  /** The nonce for the next transaction: counts pending ones too, by default. */
  async getTransactionCount(address, block = 'pending') {
    return quantityResult(await this.call('eth_getTransactionCount', [normAddress(address), blockParam(block)]), 'eth_getTransactionCount');
  }

  async getCode(address, block = 'latest') {
    return dataResult(await this.call('eth_getCode', [normAddress(address), blockParam(block)]), 'eth_getCode');
  }

  /** eth_call → returned bytes. Reverts come back as EthRpcError with the revert data in .data. */
  async ethCall({ to, data, from, value }, block = 'latest') {
    return dataResult(await this.call('eth_call', [txObject({ from, to, data, value }), blockParam(block)]), 'eth_call');
  }

  async estimateGas({ from, to, data, value }) {
    return quantityResult(await this.call('eth_estimateGas', [txObject({ from, to, data, value })]), 'eth_estimateGas');
  }

  /**
   * Broadcasts signed bytes and returns their hash, which must be
   * keccak256(raw). Sending the same bytes twice is safe: a server that
   * already has them says so, and that counts as sent.
   */
  async sendRawTransaction(raw) {
    const bytes = toBytes(raw);
    const hash = bytesToHex(keccak256(bytes));
    let r;
    try {
      r = await this.call('eth_sendRawTransaction', [bytesToHex(bytes)]);
    } catch (e) {
      if (e instanceof EthRpcError && typeof e.code === 'number' && /already known|known transaction|already imported/i.test(e.message)) return hash;
      throw e;
    }
    if (typeof r !== 'string' || r.toLowerCase() !== hash) throw new EthRpcError('hash_mismatch', t('{server} answered with a different transaction hash.', { server: this.host.name }));
    return hash;
  }

  async getTransactionByHash(hash) {
    const r = await this.call('eth_getTransactionByHash', [bytesToHex(toBytes(hash))]);
    if (r !== null && (typeof r !== 'object' || String(r.hash).toLowerCase() !== String(hash).toLowerCase())) throw new EthRpcError('bad_response', t('The transaction answered is not the one asked for.'));
    return r;
  }

  /**
   * Block `block` (a number or a tag) with its transactions as objects (full) or hashes; null
   * when the server has no such block. What the transactions say is the server's word: check
   * them (tx.js verifyRpcTransaction) before acting on one.
   */
  async getBlockByNumber(block, full = false) {
    const r = await this.call('eth_getBlockByNumber', [blockParam(block), Boolean(full)]);
    if (r === null) return null;
    if (typeof r !== 'object' || !Array.isArray(r.transactions)) throw new EthRpcError('bad_response', t('The block answered has no transaction list.'));
    return r;
  }

  /** null while pending or unknown; else {status 1|0, blockNumber, gasUsed, effectiveGasPrice, logs, …}. */
  async getTransactionReceipt(hash) {
    const h = bytesToHex(toBytes(hash));
    const r = await this.call('eth_getTransactionReceipt', [h]);
    if (r === null) return null;
    if (typeof r !== 'object' || String(r.transactionHash).toLowerCase() !== h) throw new EthRpcError('bad_response', t('The receipt answered is not for this transaction.'));
    const status = quantityResult(r.status, 'receipt status'); // i18n-ignore: the field a diagnostic names
    if (status !== 0n && status !== 1n) throw new EthRpcError('bad_response', t('Bad receipt status.'));
    return {
      transactionHash: h,
      status: Number(status),
      blockNumber: fromQuantityNumber(r.blockNumber),
      blockHash: r.blockHash ? String(r.blockHash).toLowerCase() : null,
      from: r.from ? String(r.from).toLowerCase() : null,
      to: r.to ? String(r.to).toLowerCase() : null,
      gasUsed: quantityResult(r.gasUsed, 'gasUsed'),
      effectiveGasPrice: r.effectiveGasPrice == null ? null : quantityResult(r.effectiveGasPrice, 'effectiveGasPrice'),
      logs: Array.isArray(r.logs) ? r.logs.map(parseLog) : [],
    };
  }

  /** One 32-byte storage word. `slot` is a bigint or 32-byte hex. */
  async getStorageAt(address, slot, block = 'latest') {
    const key = typeof slot === 'bigint' || typeof slot === 'number' ? bigIntToBytes(toBigInt(slot), 32) : toBytes(slot);
    if (key.length !== 32) throw new EthRpcError('bad_response', 'A storage slot is 32 bytes.'); // i18n-ignore: a programming error (the app's own argument)
    const r = dataResult(await this.call('eth_getStorageAt', [normAddress(address), bytesToHex(key), blockParam(block)]), 'eth_getStorageAt');
    if (r.length > 32) throw new EthRpcError('bad_response', t('A storage word is 32 bytes.'));
    const out = new Uint8Array(32);
    out.set(r, 32 - r.length);
    return out;
  }

  async feeHistory(blockCount, newest = 'latest', percentiles = []) {
    const r = await this.call('eth_feeHistory', [toQuantity(blockCount), blockParam(newest), percentiles]);
    if (!r || !Array.isArray(r.baseFeePerGas)) throw new EthRpcError('bad_response', 'eth_feeHistory: no base fees.'); // i18n-ignore: a diagnostic naming the RPC method, for whoever debugs the server
    return r;
  }

  /**
   * eth_getLogs over fromBlock…toBlock (numbers). Refused here, without asking,
   * when the window is wider than maxRange: no unbounded searches.
   */
  async getLogs({ address, topics = [], fromBlock, toBlock }, { maxRange = MAX_LOG_RANGE } = {}) {
    // i18n-ignore: internal guards (the callers choose the range), never a person's words
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) throw new EthRpcError('range', 'A log search needs a block range.');
    if (toBlock - fromBlock + 1 > maxRange) throw new EthRpcError('range', `A log search covers at most ${maxRange} blocks.`); // i18n-ignore: an internal guard (the callers choose the range)
    const filter = { fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock), topics };
    if (address) filter.address = Array.isArray(address) ? address.map(normAddress) : normAddress(address);
    const r = await this.call('eth_getLogs', [filter]);
    if (!Array.isArray(r)) throw new EthRpcError('bad_response', 'eth_getLogs: expected a list.'); // i18n-ignore: a diagnostic naming the RPC method, for whoever debugs the server
    return r.map(parseLog);
  }

  /**
   * Logs of a long range in chunks the server accepts (from its own error
   * message, else 10,000 then 1,000 blocks), at most `maxRequests` requests.
   * Never throws for a refused range: returns what it found, with
   * `complete:false` and `scannedTo`, so a later search can carry on.
   */
  async getLogsChunked({ address, topics = [], fromBlock, toBlock }, { maxRequests = 40, range = MAX_LOG_RANGE } = {}) {
    const logs = [];
    let start = fromBlock;
    let size = Math.min(range, MAX_LOG_RANGE);
    let requests = 0;
    while (start <= toBlock) {
      if (requests >= maxRequests) return { logs, scannedTo: start - 1, complete: false, refused: null };
      const end = Math.min(toBlock, start + size - 1);
      requests++;
      try {
        logs.push(...(await this.getLogs({ address, topics, fromBlock: start, toBlock: end }, { maxRange: size })));
        start = end + 1;
      } catch (e) {
        if (!(e instanceof EthRpcError) || !e.isRangeTooLong) throw e;
        const suggested = e.suggestedRange;
        const next = suggested && suggested < size ? suggested : size > 1000 ? 1000 : 0;
        // A server that searches only a few blocks at a time cannot cover a
        // useful history; stop and let the caller say so.
        if (next < 1000) return { logs, scannedTo: start - 1, complete: false, refused: e };
        size = next;
      }
    }
    return { logs, scannedTo: toBlock, complete: true, refused: null };
  }

  /**
   * Read-only calls through Multicall3.aggregate3, each allowed to fail on
   * its own → [{success, data}] in order. `chunk` calls per eth_call keeps
   * each under the server's gas cap; `parallel` requests at a time.
   */
  async multicall(calls, { chunk = 40, parallel = 4, block = 'latest' } = {}) {
    const parts = [];
    for (let i = 0; i < calls.length; i += chunk) parts.push(calls.slice(i, i + chunk));
    const results = new Array(parts.length);
    const run = async (i) => {
      const data = encodeCall('aggregate3((address,bool,bytes)[])', [parts[i].map((c) => [c.to, true, toBytes(c.data)])]);
      const raw = await this.ethCall({ to: MULTICALL3, data }, block);
      const [decoded] = abiDecode('(bool,bytes)[]', raw);
      if (decoded.length !== parts[i].length) throw new EthRpcError('bad_response', t('Multicall3 answered a different number of calls.'));
      results[i] = decoded.map(([success, d]) => ({ success, data: d }));
    };
    for (let i = 0; i < parts.length; i += parallel) {
      const batch = [];
      for (let j = i; j < i + parallel && j < parts.length; j++) batch.push(run(j));
      await Promise.all(batch);
    }
    return results.flat();
  }
}

/**
 * Why a run of base fees (eth_feeHistory's baseFeePerGas, oldest first, the
 * next block's last) cannot be Ethereum's, in words, or null. The fee is one
 * server's number, so it is checked against what Ethereum allows: a base fee
 * moves by at most an eighth from one block to the next (EIP-1559; twice that
 * is let through here, so a rule change cannot stop every payment), and none
 * is above MAX_BASE_FEE_WEI.
 */
export function baseFeeProblem(bases) {
  for (let i = 0; i < bases.length; i++) {
    // English, for logs and baseFeeKind(); walletFees() says it to the person in whole sentences.
    if (bases[i] > MAX_BASE_FEE_WEI) return `a base fee of ${bases[i] / GWEI} gwei`; // i18n-ignore: an English finding (baseFeeKind() reads it); walletFees() words it whole
    if (i > 0) {
      const step = bases[i] > bases[i - 1] ? bases[i] - bases[i - 1] : bases[i - 1] - bases[i];
      if (step > bases[i - 1] / 4n + 1n) return 'base fees that jump more than Ethereum allows between blocks'; // i18n-ignore: an English finding; walletFees() words it whole
    }
  }
  return null;
}

/**
 * What baseFeeProblem() found: 'high' (above MAX_BASE_FEE_WEI: Ethereum can charge it, for minutes,
 * and BEAM Campfire will not pay it), 'jump' (moves Ethereum does not allow between blocks), or null.
 */
export function baseFeeKind(bases) {
  const p = baseFeeProblem(bases);
  if (!p) return null;
  return bases.some((b) => b > MAX_BASE_FEE_WEI) && /^a base fee of/.test(p) ? 'high' : 'jump';
}

/**
 * EIP-1559 fees for a transaction this wallet sends, as the desktop app's
 * walletFees(): eth_feeHistory(5, latest, [50]); the next block's base fee
 * (the last entry), the median of the five 50th-percentile tips (at least
 * 0.01 gwei), and room for the base fee to double before it is mined:
 * maxFeePerGas = 2 × base + tip.
 *
 * Everything here is the one server's word, and the tip is paid in full to
 * whoever builds the block, so it is bounded: at most 3 gwei, or 3 × the base
 * fee when Ethereum is that busy, and never above MAX_TIP_WEI. A run of base
 * fees Ethereum could not have produced (baseFeeProblem) is refused
 * ('bad_fees') rather than paid.
 */
export async function walletFees(rpc) {
  const r = await rpc.feeHistory(5, 'latest', [50]);
  const bases = r.baseFeePerGas.map((b) => quantityResult(b, 'baseFeePerGas'));
  if (!bases.length) throw new EthRpcError('bad_response', 'eth_feeHistory: no base fees.'); // i18n-ignore: a diagnostic naming the RPC method, for whoever debugs the server
  const problem = baseFeeProblem(bases);
  if (problem) {
    const server = rpc.host ? rpc.host.name : null;
    const kind = baseFeeKind(bases);
    let message;
    if (kind === 'high') {
      // The first base fee above the limit: the one baseFeeProblem() names.
      const gwei = String(bases.find((b) => b > MAX_BASE_FEE_WEI) / GWEI);
      message = server
        ? t("{server} says Ethereum's network fee is a base fee of {gwei} gwei, far above anything BEAM Campfire will pay.", { server, gwei })
        : t("The Ethereum server says Ethereum's network fee is a base fee of {gwei} gwei, far above anything BEAM Campfire will pay.", { gwei });
    } else {
      message = server
        ? t('{server} gave network fee figures Ethereum cannot have (base fees that jump more than Ethereum allows between blocks).', { server })
        : t('The Ethereum server gave network fee figures Ethereum cannot have (base fees that jump more than Ethereum allows between blocks).');
    }
    throw new EthRpcError('bad_fees', message, { problem: kind });
  }
  const next = bases[bases.length - 1];
  const tips = (Array.isArray(r.reward) ? r.reward : [])
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => quantityResult(row[0], 'reward'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = tips.length ? tips[Math.floor(tips.length / 2)] : MIN_TIP_WEI;
  if (tip < MIN_TIP_WEI) tip = MIN_TIP_WEI;
  const busy = next * 3n;
  const cap = busy > EASY_TIP_WEI ? (busy < MAX_TIP_WEI ? busy : MAX_TIP_WEI) : EASY_TIP_WEI;
  if (tip > cap) tip = cap;
  return { baseFee: next, maxPriorityFeePerGas: tip, maxFeePerGas: next * 2n + tip };
}

/** A gas limit for an estimate: a quarter more, and at least 20,000 more (the desktop app's gasWithHeadroom). */
export function gasWithHeadroom(estimate) {
  const e = toBigInt(estimate);
  const more = (e * 125n) / 100n;
  return more - e < 20000n ? e + 20000n : more;
}
