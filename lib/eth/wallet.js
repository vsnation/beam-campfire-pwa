// The Ethereum wallet while BEAM Campfire is unlocked: its address (read
// from the sealed key, which is zeroed again at once), its balances, what
// this device sent (the sealed outbox) and, when the person allows it, the
// history Stack Wallet's index keeps for the address.
//
// Nothing here runs by itself: the Ethereum screens call refresh() while
// they are open and visible. Every request goes to the one server picked in
// Settings (lib/eth/hosts.js), never another; the history index is Stack
// Wallet's whichever server is picked, and is asked only while
// "History from Stack Wallet" is on.
//
// Locking forgets the address, the derived data keys and this object
// (forgetEthWallet(), called from the app's lock hooks).

import { getEthRecord, withEthKey, removeEthKey, VaultError } from './vault.js';
import { EthRpc } from './rpc.js';
import { DEFAULT_ETH_RPC, ETH_RPC_HOSTS, HISTORY_HOST } from './hosts.js';
import { TOKENS } from './tokens.js';
import { encodeCall, abiDecode } from './abi.js';
import { loadOutbox, clearOutbox, isOpen, updateOutbox } from './outbox.js';
import { fetchHistory, mergeActivity, minedInIndex, indexBlockOf } from './history.js';
import { forgetDataKeys } from './sealed.js';
import { followOnce, minedPatch } from './send.js';
import { entryInDoubt, forgetInDoubt } from './doubt.js';
import { store } from '../store.js';
import { t } from '../i18n.js';

/** The person's Ethereum settings, with the defaults: Stack Wallet's server, history on. */
export function ethPrefs(app) {
  const p = (app && app.prefs) || {};
  const rpcId = ETH_RPC_HOSTS.some((x) => x.id === p.ethRpc) ? p.ethRpc : DEFAULT_ETH_RPC;
  return { rpcId, host: ETH_RPC_HOSTS.find((x) => x.id === rpcId), history: p.ethHistory !== false, historyHost: HISTORY_HOST };
}

class EthWallet {
  constructor(app, record, kv) {
    this.app = app;
    this.kv = kv;
    this.walletId = app.record.id;
    this.ethId = record.id;
    this.record = record;
    this.listeners = new Set();
    this._rpc = null;
    this.state = {
      address: null,
      eth: null, // wei, or null until asked
      tokens: new Map(), // symbol -> units (null when the token did not answer)
      block: null,
      checkedAt: null,
      loading: false,
      error: null, // the server's problem, in words
      outbox: [],
      history: { txs: [], transfers: [], error: null, at: null },
    };
  }

  /** The client for the server picked now (a new one when the choice changes). */
  get rpc() {
    const { rpcId } = ethPrefs(this.app);
    if (!this._rpc || this._rpc.host.id !== rpcId) this._rpc = new EthRpc(rpcId);
    return this._rpc;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async open() {
    if (!this.state.address) {
      this.state.address = await withEthKey(this.app, async ({ address }) => address, this.kv);
      this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    }
    return this;
  }

  /** {eth, ...symbol} as prepareSend() wants them. */
  balances() {
    const b = { eth: this.state.eth };
    for (const [k, v] of this.state.tokens) b[k] = v;
    return b;
  }

  async reloadOutbox() {
    this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    this.emit();
    return this.state.outbox;
  }

  /** Balances (one server, three requests), then history when allowed. */
  async refresh() {
    if (this.state.loading) return this.state;
    const address = this.state.address;
    const rpc = this.rpc;
    this.state.loading = true;
    this.emit();
    try {
      const calls = TOKENS.map((tok) => ({ to: tok.address, data: encodeCall('balanceOf(address)', [address]) }));
      const [eth, block, tokens] = await Promise.all([rpc.getBalance(address), rpc.blockNumber(), rpc.multicall(calls)]);
      this.state.eth = eth;
      this.state.block = block;
      const map = new Map();
      TOKENS.forEach((tok, i) => {
        const r = tokens[i];
        map.set(tok.symbol, r && r.success && r.data.length === 32 ? abiDecode('uint256', r.data)[0] : null);
      });
      this.state.tokens = map;
      this.state.checkedAt = Date.now();
      this.state.error = null;
    } catch (e) {
      this.state.error = { host: rpc.host, message: e.message, code: e.code };
    }
    if (ethPrefs(this.app).history) {
      try {
        const h = await fetchHistory(address);
        this.state.history = { ...h, error: null, at: Date.now() };
      } catch (e) {
        this.state.history = { ...this.state.history, error: e.message };
      }
    } else this.state.history = { txs: [], transfers: [], error: null, at: null };
    try {
      this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
      await this.settleFromIndex();
    } catch {
      /* keep what we had: locked mid-way */
    }
    this.state.loading = false;
    this.emit();
    return this.state;
  }

  /**
   * Hashes that may have taken `e`'s nonce, from what this wallet already holds: another
   * transaction of the outbox with the same nonce, and the history index's. Each is still checked
   * on the server before it counts (send.js findNonceTaker).
   */
  nonceTwins(e) {
    const me = e.from.toLowerCase();
    const out = this.state.outbox.filter((o) => o.hash !== e.hash && o.from.toLowerCase() === me && o.nonce === e.nonce).map((o) => o.hash);
    for (const tx of this.state.history.txs) if (tx.from === me && tx.nonce !== null && String(tx.nonce) === e.nonce && tx.hash !== e.hash) out.push(tx.hash);
    return out;
  }

  /**
   * What the history index shows in a block was sent, whatever one server's refusals ended it as
   * ('rejected'): such an entry is written down as mined (release audit BM-2). Not a 'replaced'
   * one: that was shown with evidence, and only the chosen server's receipt of this hash settles
   * it (recheckRejected; re-audit RE2-5). Returns whether any changed.
   */
  async settleFromIndex() {
    const h = this.state.history;
    const found = minedInIndex({ outbox: this.state.outbox, txs: h.txs, transfers: h.transfers });
    for (const f of found) {
      const patch = { state: f.state, unsureSince: null, refusedAt: null, replacedBy: null, replacedIn: null, receipt: { blockNumber: f.blockNumber, status: f.state === 'confirmed' ? 1 : 0, gasUsed: null, effectiveGasPrice: null } };
      await updateOutbox(this.app, f.hash, patch, { ethId: this.ethId, kv: this.kv });
    }
    if (found.length) this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    return found.length > 0;
  }

  /** What the history index shows for `hash` in a block ({state, blockNumber}), or null. */
  indexSays(hash) {
    return indexBlockOf(this.state.history, hash);
  }

  /**
   * 'rejected' is one server's word after half an hour of refusals, not Ethereum's: each look
   * (Ethereum Home opening, the transaction's own screen) asks for the receipts of the newest
   * `limit` such entries, once, and one mined after all becomes confirmed (or failed). An entry
   * settled from the index (no fee figures yet) gets its receipt the same way, and so does a
   * 'replaced' one the index shows in a block (re-audit RE2-5): it becomes mined only when the
   * chosen server serves this hash's own receipt. Returns whether any changed.
   */
  async recheckRejected({ hash = null, limit = 10 } = {}) {
    const rpc = this.rpc;
    const fromIndex = (e) => (e.state === 'confirmed' || e.state === 'failed') && e.receipt && e.receipt.gasUsed == null;
    const contested = (e) => e.state === 'replaced' && this.indexSays(e.hash) !== null;
    const list = this.state.outbox.filter((e) => (e.state === 'rejected' || fromIndex(e) || contested(e)) && (hash === null || e.hash === hash)).slice(0, limit);
    let changed = false;
    for (const e of list) {
      const r = await rpc.getTransactionReceipt(e.hash).catch(() => null);
      if (!r) continue;
      // Our hash has a receipt: it was mined, so nothing took its nonce.
      const patch = e.state === 'replaced' ? { ...minedPatch(r), replacedBy: null, replacedIn: null } : minedPatch(r);
      await updateOutbox(this.app, e.hash, patch, { ethId: this.ethId, kv: this.kv });
      changed = true;
    }
    if (changed) await this.reloadOutbox();
    return changed;
  }

  /** One look at every open transaction this device sent. */
  async followOpen() {
    let changed = false;
    for (const e of this.state.outbox.filter(isOpen)) {
      const next = await followOnce(this.app, this.rpc, e, { ethId: this.ethId, kv: this.kv, candidates: this.nonceTwins(e) });
      if (next.state !== e.state || next.receipt !== e.receipt || next.unsureSince !== e.unsureSince || next.refusedAt !== e.refusedAt || next.doubtLookAt !== e.doubtLookAt) changed = true;
    }
    if (changed) await this.reloadOutbox();
    return changed;
  }

  /** The newest transaction this device sent whose fate is in doubt (lib/eth/doubt.js), as last loaded; or null. */
  doubt() {
    return entryInDoubt(this.state.outbox);
  }

  /** Forgets the transaction `hash` in doubt (lib/eth/doubt.js forgetInDoubt: after a day of failed looks, that one only). */
  async forget(hash) {
    await forgetInDoubt(this.app, hash, { ethId: this.ethId, kv: this.kv });
    await this.reloadOutbox();
  }

  /** doubt(), from the outbox as stored now: what decides before anything is signed. */
  async freshDoubt() {
    await this.reloadOutbox();
    return this.doubt();
  }

  activity() {
    const h = this.state.history;
    return mergeActivity({ address: this.state.address, outbox: this.state.outbox, txs: h.txs, transfers: h.transfers });
  }
}

let current = null;

/**
 * The Ethereum wallet of the unlocked BEAM wallet, opened; null when this
 * device has none. Throws VaultError('locked') when locked.
 */
export async function ethWallet(app, { kv = store } = {}) {
  if (!app || !app.dbPass || !app.record) throw new VaultError('locked', t('Unlock the wallet first.'));
  const record = await getEthRecord(kv);
  if (!record) {
    current = null;
    return null;
  }
  if (!current || current.app !== app || current.walletId !== app.record.id || current.ethId !== record.id) current = new EthWallet(app, record, kv);
  return current.open();
}

/** On lock: the address, the derived data keys and the cached wallet are forgotten. */
export function forgetEthWallet() {
  current = null;
  forgetDataKeys();
}

/** Removes the Ethereum wallet from this device: the sealed key and what it sent. The coins stay on Ethereum. */
export async function removeEthWallet(kv = store) {
  await clearOutbox(kv);
  await removeEthKey(kv);
  forgetEthWallet();
}
