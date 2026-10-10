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
import { loadOutbox, clearOutbox, isOpen } from './outbox.js';
import { fetchHistory, mergeActivity } from './history.js';
import { forgetDataKeys } from './sealed.js';
import { followOnce } from './send.js';
import { store } from '../store.js';

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
      const calls = TOKENS.map((t) => ({ to: t.address, data: encodeCall('balanceOf(address)', [address]) }));
      const [eth, block, tokens] = await Promise.all([rpc.getBalance(address), rpc.blockNumber(), rpc.multicall(calls)]);
      this.state.eth = eth;
      this.state.block = block;
      const map = new Map();
      TOKENS.forEach((t, i) => {
        const r = tokens[i];
        map.set(t.symbol, r && r.success && r.data.length === 32 ? abiDecode('uint256', r.data)[0] : null);
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
    } catch {
      /* keep what we had: locked mid-way */
    }
    this.state.loading = false;
    this.emit();
    return this.state;
  }

  /** One look at every open transaction this device sent. */
  async followOpen() {
    let changed = false;
    for (const e of this.state.outbox.filter(isOpen)) {
      const next = await followOnce(this.app, this.rpc, e, { ethId: this.ethId, kv: this.kv });
      if (next.state !== e.state || next.receipt !== e.receipt) changed = true;
    }
    if (changed) await this.reloadOutbox();
    return changed;
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
  if (!app || !app.dbPass || !app.record) throw new VaultError('locked', 'Unlock the wallet first.');
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
