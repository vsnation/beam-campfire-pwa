// The running wallet as the screens see it: balances, transactions, sync
// state, and the few actions a person can take. One instance per page.

import { startWallet, nodeGuard, EngineError } from './engine.js';
import { assessSync } from './sync.js';
import { RANDOM_NODE, poolOrder, nextInOrder } from './nodes.js';
import { assessNodeHealth, hopAllowed } from './node_health.js';
import { toGroth, REGULAR_FEE, OFFLINE_FEE, toJsonNumber } from './amount.js';
import { assetLabel } from './meta.js';
import { bindSession, unbindSession } from './contracts.js';

const STATUS_EVERY_MS = 5000;
const TXS_EVERY_MS = 20000;
const PERSIST_EVERY_MS = 15000;
const CONNECT_GRACE_MS = 25000;

export const ADDRESS_COMMENT = 'BEAM Campfire';

/** How a payment to each address type goes out (mirrors BeamSendMode.forType). */
export function sendModeFor(type) {
  switch (type) {
    case 'regular':
    case 'regular_new':
      return { fee: REGULAR_FEE, offline: false, receiverMustBeOnline: true, label: 'Regular address', explanation: "The receiver's wallet has to come online within about 12 hours to accept it; until then it shows as waiting." };
    case 'offline':
      return { fee: OFFLINE_FEE, offline: true, receiverMustBeOnline: false, label: 'Offline address', explanation: "Arrives even while the receiver's wallet is closed. Costs a higher network fee (0.011 BEAM)." };
    case 'max_privacy':
      return { fee: OFFLINE_FEE, offline: false, receiverMustBeOnline: false, label: 'Max privacy address', explanation: 'Hidden among many other payments; the receiver can spend it after a while. Costs a higher network fee (0.011 BEAM).' };
    case 'public_offline':
      return { fee: OFFLINE_FEE, offline: false, receiverMustBeOnline: false, label: 'Public address', explanation: 'A reusable donation address: arrives while the receiver is offline. Costs a higher network fee (0.011 BEAM).' };
    default:
      return null;
  }
}

/** Plain-language wording for a transaction's state. */
export function txStatusText(tx) {
  const s = Number(tx.status);
  const income = Boolean(tx.income);
  if (isContractTx(tx)) {
    const swap = isSwapTx(tx);
    switch (s) {
      case 0:
        return 'Waiting';
      case 1:
        return swap ? 'Swapping' : 'In progress';
      case 2:
        return swap ? 'Swap cancelled' : 'Cancelled';
      case 3:
        return swap ? 'Swapped' : 'Done';
      case 4:
        return swap ? 'Swap failed' : 'Failed';
      case 5:
        return 'Confirming';
      default:
        return tx.status_string || 'Unknown';
    }
  }
  switch (s) {
    case 0:
      return income ? 'Waiting for the sender' : 'Waiting for the receiver';
    case 1:
      return income ? 'Receiving' : 'Sending';
    case 2:
      return 'Cancelled';
    case 3:
      return income ? 'Received' : 'Sent';
    case 4:
      return 'Failed';
    case 5:
      return 'Confirming';
    default:
      return tx.status_string || 'Unknown';
  }
}

export const CONTRACT_TX = 12;
const DEX_CONTRACT = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';

export function isContractTx(tx) {
  return Number(tx.tx_type) === CONTRACT_TX;
}

/** A contract call on BEAM's DEX. */
export function isSwapTx(tx) {
  return isContractTx(tx) && Array.isArray(tx.invoke_data) && tx.invoke_data.some((d) => d && d.contract_id === DEX_CONTRACT);
}

/**
 * What a contract call moved, per asset: spends left the wallet, receives
 * arrived (the engine's invoke_data: positive = spent, negative = received).
 */
export function contractMoves(tx) {
  const spends = new Map();
  const receives = new Map();
  for (const d of (tx && tx.invoke_data) || []) {
    for (const a of (d && d.amounts) || []) {
      let v;
      try {
        v = BigInt(a.amount);
      } catch {
        continue;
      }
      const id = Number(a.asset_id);
      if (v > 0n) spends.set(id, (spends.get(id) || 0n) + v);
      else if (v < 0n) receives.set(id, (receives.get(id) || 0n) - v);
    }
  }
  const list = (m) => [...m].map(([assetId, amount]) => ({ assetId, amount }));
  return { spends: list(spends), receives: list(receives) };
}

export function isPendingTx(tx) {
  const s = Number(tx.status);
  return s === 0 || s === 1 || s === 5;
}

export class Wallet {
  constructor() {
    this.session = null;
    this.listeners = new Set();
    this.timers = [];
    this.state = this.emptyState();
    this.assetMeta = new Map([[0, assetLabel(0)]]);
    this.assetNamed = new Set([0]);
    this.assetTried = new Map();
    this.allAssets = null;
    this.unsubGuard = null;
    this.persistTimer = null;
    this._onHidden = () => {
      if (document.visibilityState === 'hidden') this.persistNow();
    };
    this._onPageHide = () => this.persistNow();
  }

  emptyState() {
    return {
      running: false,
      node: null,
      importing: false,
      importProgress: null,
      status: null,
      totals: new Map(),
      txs: [],
      progress: null,
      explorer: null,
      nodeConnected: false,
      everConnected: false,
      connectFailed: false,
      startedAt: 0,
      lastError: null,
      connEvent: null,
      scanning: true,
      // 'random' (the pool, with failover) or 'own' (the person's node, nothing else).
      nodeMode: null,
      // A hop to another pool node in progress: {from, to, reason, at}.
      switching: null,
      // Every hop this session: {from, to, reason, at}.
      switchLog: [],
      sync: assessSync({ status: null, nodeConnected: false, explorer: null, now: Date.now() / 1000 }),
    };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    const s = this.state;
    s.sync = assessSync({
      status: s.status,
      nodeConnected: s.nodeConnected,
      everConnected: s.everConnected,
      connectFailed: s.connectFailed,
      explorer: s.explorer,
      now: Date.now() / 1000,
      progress: s.progress,
      importing: s.importing,
      reconnecting: Boolean(s.switching),
      ownNode: s.nodeMode === 'own' ? s.node : null,
    });
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        console.error(e);
      }
    }
  }

  label(assetId) {
    return this.assetMeta.get(Number(assetId)) || assetLabel(assetId);
  }

  /**
   * Starts the engine with the database password. node: RANDOM_NODE (the pool:
   * a random start, and the next node whenever this one fails or stalls) or the
   * person's own node "host:port" (only that node, never a fallback).
   */
  async start({ dbPass, node, recovery = null, onImport = null, bodyRequests = true }) {
    if (this.session) throw new EngineError('running', 'The wallet is already open.');
    this.gen = (this.gen || 0) + 1;
    this.state = this.emptyState();
    const random = !node || node === RANDOM_NODE;
    this.plan = { random, order: random ? poolOrder() : [node], bestHeight: 0, emptyHops: 0, staleHops: 0, lastHopAt: 0 };
    this.state.node = this.plan.order[0];
    this.state.nodeMode = random ? 'random' : 'own';
    this.state.scanning = Boolean(bodyRequests || recovery);
    this.state.startedAt = Date.now();
    // Kept while the wallet runs, like app.dbPass, so a hop restarts the same wallet; dropped by stop().
    this.run = { dbPass, bodyRequests: Boolean(bodyRequests || recovery) };
    this.resetNodeWatch();
    this.watchGuard();
    const { session, imported } = await startWallet({
      dbPass,
      node: this.state.node,
      recovery,
      bodyRequests,
      onImport: (d, t) => {
        this.state.importProgress = { done: d, total: t };
        this.emit();
      },
    });
    this.attach(session);
    this.state.running = true;
    this.state.importing = Boolean(imported);
    document.addEventListener('visibilitychange', this._onHidden);
    window.addEventListener('pagehide', this._onPageHide);
    this.emit();
    if (imported) {
      try {
        await imported;
      } finally {
        this.state.importing = false;
        this.state.importProgress = null;
        this.persistSoon();
        this.emit();
      }
    }
    await this.afterStart();
    return imported;
  }

  /** Two signals: the WebSocket guard (socket open) and, with engine patch 0104,
   *  ev_connection_changed (the node actually answered). The event wins once seen. */
  watchGuard() {
    if (this.unsubGuard) this.unsubGuard();
    this.unsubGuard = nodeGuard.subscribe(({ open, everOpen }) => {
      if (this.state.connEvent == null) this.state.nodeConnected = open > 0;
      // Without the engine's event (patch 0104) a lost socket is the only sign of a lost node.
      if (this.state.connEvent == null && open === 0) this.markConnected(false);
      this.state.everConnected = this.state.everConnected || everOpen;
      if (open > 0) this.state.connectFailed = false;
      this.emit();
      // A failed attempt can be the one that decides: judge now, not at the next 5 s tick.
      if (!everOpen) queueMicrotask(() => this.checkHealth());
    });
  }

  /** Contract calls (lib/contracts.js) and their consent belong to this session. */
  attach(session) {
    this.session = session;
    bindSession(session);
    session.onEvent((id, result) => this.onEvent(id, result));
    session.onSync((done, total) => {
      this.state.progress = { done, total };
      this.noteSyncProgress(done);
      this.emit();
    });
  }

  async subscribeEvents() {
    try {
      await this.session.call('ev_subunsub', {
        ev_sync_progress: true,
        ev_system_state: true,
        ev_txs_changed: true,
        ev_addrs_changed: true,
        ev_utxos_changed: true,
        ev_assets_changed: true,
        ev_connection_changed: true,
      });
    } catch (e) {
      console.warn('[campfire] events not available', e.message);
    }
  }

  async afterStart() {
    await this.subscribeEvents();
    this.every(STATUS_EVERY_MS, () => this.refreshStatus());
    this.every(TXS_EVERY_MS, () => this.refreshTxs());
    this.every(PERSIST_EVERY_MS, () => this.persistNow());
    this.every(5000, () => this.checkConnection());
    this.refreshStatus();
    this.refreshTxs();
    // No explorer: the installed app asks nothing of its web address (docs/beam/PWA.md,
    // "Without the domain"). Sync honesty rests on the node's own tip (lib/sync.js).
  }

  // ------------------------------------------------------------ node health (random node)
  resetNodeWatch() {
    this.nodeWatch = { startedAt: Date.now(), answered: false, answeredAt: null, connected: false, lostAt: null, lastProgressAt: null, height: null, tipTs: null, syncDone: null };
  }

  /** The node answered (BEAM handshake done) or went away again. */
  markConnected(on) {
    const w = this.nodeWatch;
    if (!w) return;
    if (on) {
      if (!w.answered) {
        w.answered = true;
        w.answeredAt = Date.now();
        if (this.plan) this.plan.emptyHops = 0;
      }
      w.connected = true;
      w.lostAt = null;
    } else if (w.connected) {
      w.connected = false;
      w.lostAt = Date.now();
    }
  }

  /** A new block, a new tip or sync progress from the current node. */
  markProgress() {
    if (!this.nodeWatch) return;
    this.nodeWatch.lastProgressAt = Date.now();
    // Without the engine's connection event (patch 0104), progress is the only sign the node answered.
    if (!this.nodeWatch.answered && this.state.connEvent == null) this.markConnected(true);
  }

  /** Sync progress counts only when requests to the node were answered (done went up). */
  noteSyncProgress(done) {
    const w = this.nodeWatch;
    if (!w) return;
    const d = Number(done) || 0;
    if (w.syncDone != null && d > w.syncDone) this.markProgress();
    w.syncDone = d;
  }

  noteStatus(st) {
    const w = this.nodeWatch;
    if (!w || !st) return;
    const height = Number(st.current_height) || 0;
    const ts = Number(st.current_state_timestamp) || 0;
    if (w.height !== null && (height !== w.height || ts !== w.tipTs)) this.markProgress();
    w.height = height;
    w.tipTs = ts;
    if (this.plan && height > this.plan.bestHeight) {
      if (this.plan.bestHeight) this.plan.staleHops = 0;
      this.plan.bestHeight = height;
    }
    if (this.state.switching && this.state.nodeConnected) {
      this.state.switching = null;
    }
  }

  checkHealth() {
    const p = this.plan;
    if (!p || !p.random || p.order.length < 2 || !this.session || this.hopping) return;
    const now = Date.now();
    const w = this.nodeWatch;
    const v = assessNodeHealth({ now, startedAt: w.startedAt, guard: nodeGuard.state, answered: w.answered, answeredAt: w.answeredAt, connected: w.connected, lostAt: w.lostAt, lastProgressAt: w.lastProgressAt, importing: this.state.importing });
    if (!v.switch) return;
    if (!hopAllowed({ reason: v.reason, now, poolSize: p.order.length, emptyHops: p.emptyHops, lastHopAt: p.lastHopAt, staleHops: p.staleHops })) return;
    this.hop(v.reason);
  }

  /**
   * Moves a random-node wallet to the next pool node: the same wallet.db, the
   * same settings. The engine stops cleanly (wallet.db is flushed first) and
   * starts again on the next node; payments in progress are kept in wallet.db
   * and resumed by the engine on start (WalletClient: ResumeAllTransactions),
   * exactly as after unlocking. Balances and the payment list stay on screen.
   */
  async hop(reason) {
    const p = this.plan;
    const from = this.state.node;
    const to = nextInOrder(p.order, from);
    const gaveNothing = !this.nodeWatch.answered;
    p.emptyHops = gaveNothing ? p.emptyHops + 1 : 0;
    if (reason === 'stalled') p.staleHops++;
    p.lastHopAt = Date.now();
    this.hopping = true;
    const gen = this.gen;
    const current = () => this.gen === gen && this.run;
    const entry = { from, to, reason, at: p.lastHopAt };
    this.state.switchLog.push(entry);
    this.state.switching = entry;
    console.info(`[campfire] node ${from} ${reason}; moving to ${to}`);
    this.emit();
    try {
      unbindSession();
      this.allAssets = null;
      const old = this.session;
      this.session = null;
      if (old) await old.stop();
      if (!current()) return; // locked or restarted meanwhile
      nodeGuard.setAllowed(null);
      const s = this.state;
      s.node = to;
      s.nodeConnected = false;
      s.everConnected = false;
      s.connectFailed = false;
      s.connEvent = null;
      this.resetNodeWatch();
      this.watchGuard();
      const { session } = await startWallet({ dbPass: this.run.dbPass, node: to, bodyRequests: this.run.bodyRequests });
      if (!current()) {
        await session.stop();
        return;
      }
      this.attach(session);
      this.emit();
      await this.subscribeEvents();
      this.refreshStatus();
      this.refreshTxs();
    } catch (e) {
      console.warn('[campfire] node switch', e.message);
      // The engine did not start on that node: try the next one shortly.
      setTimeout(() => current() && !this.session && !this.hopping && this.hop('unreachable'), 5000);
    } finally {
      this.hopping = false;
    }
  }

  every(ms, fn) {
    this.timers.push(setInterval(fn, ms));
  }

  checkConnection() {
    const s = this.state;
    const since = Date.now() - s.startedAt;
    const failed = !s.importing && !s.nodeConnected && since > CONNECT_GRACE_MS;
    if (failed !== s.connectFailed) {
      s.connectFailed = failed;
      this.emit();
    }
    // A hop that has waited out a whole unreachable round shows "offline", not "reconnecting".
    if (s.switching && failed && this.plan && this.plan.emptyHops >= this.plan.order.length) {
      s.switching = null;
      this.emit();
    }
    this.checkHealth();
  }

  onEvent(id, result) {
    if (id === 'ev_connection_changed' && result) {
      this.state.connEvent = result;
      this.state.nodeConnected = result.node_connected === true;
      if (result.node_connected) {
        this.state.everConnected = true;
        this.state.connectFailed = false;
        this.state.switching = null;
      }
      this.markConnected(result.node_connected === true);
      this.emit();
    } else if (id === 'ev_sync_progress' && result) {
      this.state.progress = { done: result.sync_requests_done, total: result.sync_requests_total };
      this.noteSyncProgress(result.sync_requests_done);
      this.emit();
    } else if (id === 'ev_system_state') {
      this.refreshStatus();
    } else if (id === 'ev_txs_changed') {
      this.refreshTxs();
      this.refreshStatus();
      this.persistSoon();
    } else if (id === 'ev_utxos_changed' || id === 'ev_assets_changed') {
      this.refreshStatus();
      this.persistSoon();
    } else if (id === 'ev_addrs_changed') {
      this.persistSoon();
    }
  }

  async refreshStatus() {
    if (!this.session || this.state.importing) return;
    try {
      const st = await this.session.call('wallet_status', { nz_totals: true }, { timeoutMs: 15000 });
      this.state.status = st;
      this.noteStatus(st);
      const totals = new Map();
      for (const t of st.totals || []) {
        const id = Number(t.asset_id);
        const g = (k) => {
          const v = t[`${k}_str`] ?? t[k];
          return v === undefined ? 0n : toGroth(v);
        };
        totals.set(id, { available: g('available'), receiving: g('receiving'), sending: g('sending'), maturing: g('maturing') });
      }
      if (!totals.has(0)) {
        totals.set(0, {
          available: toGroth(st.available || 0),
          receiving: toGroth(st.receiving || 0),
          sending: toGroth(st.sending || 0),
          maturing: toGroth(st.maturing || 0),
        });
      }
      this.state.totals = totals;
      // Metadata can arrive after the coins (the engine confirms assets lazily): retry every 30 s until it does.
      for (const id of totals.keys()) {
        if (id === 0 || this.assetNamed.has(id)) continue;
        if (Date.now() - (this.assetTried.get(id) || 0) > 30000) this.loadAsset(id);
      }
      this.state.lastError = null;
      this.emit();
    } catch (e) {
      if (e.code !== 'stopped') this.state.lastError = e.message;
    }
  }

  async loadAsset(id) {
    this.assetTried.set(id, Date.now());
    if (!this.assetMeta.has(id)) this.assetMeta.set(id, assetLabel(id)); // placeholder until the metadata arrives
    try {
      const info = await this.session.call('get_asset_info', { asset_id: id }, { timeoutMs: 20000 });
      if (info && info.metadata) {
        this.assetMeta.set(id, assetLabel(id, info.metadata));
        this.assetNamed.add(id);
        this.emit();
      }
    } catch {
      /* placeholder stays; retried later */
    }
  }

  async refreshTxs() {
    if (!this.session || this.state.importing) return;
    try {
      const txs = await this.session.call('tx_list', { count: 100, skip: 0 }, { timeoutMs: 20000 });
      // Payments - simple (0) and offline/max-privacy push (7) - and contract
      // calls (12: swaps and the like). Asset admin is not something this app makes.
      this.state.txs = (Array.isArray(txs) ? txs : [])
        .filter((t) => [0, 7, 12].includes(Number(t.tx_type)))
        .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
      this.emit();
    } catch {
      /* next round */
    }
  }

  /**
   * Names for every asset on the chain (assets_list with refresh asks the node
   * once; ~200 assets). Once per session, on demand: the swap screen needs names
   * for assets this wallet has never held. Also lets get_asset_info answer for them.
   */
  loadAllAssets() {
    if (this.allAssets) return this.allAssets;
    const session = this.session;
    if (!session) return Promise.resolve(false);
    this.allAssets = session
      .call('assets_list', { refresh: true }, { timeoutMs: 60000 })
      .then((r) => {
        if (this.session !== session) return false;
        for (const a of (r && r.assets) || []) {
          const id = Number(a.asset_id);
          if (!Number.isInteger(id) || id <= 0 || typeof a.metadata !== 'string') continue;
          this.assetMeta.set(id, assetLabel(id, a.metadata));
          this.assetNamed.add(id);
        }
        this.emit();
        return true;
      })
      .catch((e) => {
        if (this.session === session) this.allAssets = null; // try again next time
        console.warn('[campfire] asset list', e.message);
        return false;
      });
    return this.allAssets;
  }

  /** What can be spent now, in groth. */
  available(assetId) {
    const t = this.state.totals.get(Number(assetId));
    return t ? t.available : 0n;
  }

  persistSoon() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 1200);
  }

  persistNow() {
    if (this.session) return this.session.syncFS();
    return Promise.resolve();
  }

  // ------------------------------------------------------------ actions
  async validateAddress(address) {
    return this.session.call('validate_address', { address }, { timeoutMs: 15000 });
  }

  async receiveAddress({ fresh = false } = {}) {
    if (!fresh) {
      const list = await this.session.call('addr_list', { own: true }, { timeoutMs: 20000 });
      const mine = (list || [])
        .filter((a) => a.own && !a.expired && a.type === 'regular' && a.comment === ADDRESS_COMMENT)
        .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
      if (mine.length) return mine[0].address;
    }
    const addr = await this.session.call('create_address', { type: 'regular', expiration: 'never', comment: ADDRESS_COMMENT }, { timeoutMs: 20000 });
    await this.persistNow();
    return addr;
  }

  async send({ address, amount, assetId = 0, mode }) {
    const params = { address, value: toJsonNumber(amount), fee: toJsonNumber(mode.fee) };
    if (Number(assetId) !== 0) params.asset_id = Number(assetId);
    if (mode.offline) params.offline = true;
    const r = await this.session.call('tx_send', params, { timeoutMs: 60000 });
    await this.persistNow();
    this.refreshTxs();
    this.refreshStatus();
    return r.txId;
  }

  async txStatus(txId) {
    return this.session.call('tx_status', { txId }, { timeoutMs: 20000 });
  }

  async cancelTx(txId) {
    const r = await this.session.call('tx_cancel', { txId }, { timeoutMs: 20000 });
    await this.persistNow();
    this.refreshTxs();
    return r;
  }

  /** The owner key, encrypted with the password the person typed (WalletSession.exportOwnerKey). */
  async ownerKey(password) {
    if (!this.session) throw new EngineError('stopped', 'The wallet is not open yet. Go back to Home, then try again.');
    return this.session.exportOwnerKey(password);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.persistTimer);
    document.removeEventListener('visibilitychange', this._onHidden);
    window.removeEventListener('pagehide', this._onPageHide);
    if (this.unsubGuard) this.unsubGuard();
    this.unsubGuard = null;
    // Every open app and pending consent ends before the engine does.
    unbindSession();
    this.allAssets = null;
    const s = this.session;
    this.session = null;
    this.run = null;
    this.plan = null;
    this.gen = (this.gen || 0) + 1;
    if (s) await s.stop();
    nodeGuard.setAllowed(null);
    this.state = this.emptyState();
    this.emit();
  }
}

export const wallet = new Wallet();
