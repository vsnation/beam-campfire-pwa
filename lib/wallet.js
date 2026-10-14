// The running wallet as the screens see it: balances, transactions, sync
// state, and the few actions a person can take. One instance per page.

import { startWallet, nodeGuard, EngineError, currentWalletPath, engineLog } from './engine.js';
import { assessSync, reconnectView } from './sync.js';
import { RANDOM_NODE, poolOrder, nextInOrder, isPoolNode } from './nodes.js';
import { assessNodeHealth, hopAllowed } from './node_health.js';
import { toGroth, REGULAR_FEE, OFFLINE_FEE, toJsonNumber } from './amount.js';
import { assetLabel } from './meta.js';
import { bindSession, unbindSession, settleApps } from './contracts.js';
import { pickReceiveAddress } from './addresses.js';
import { isSplitTx, splitStatusText } from './coins.js';
import { t, tk } from './i18n.js';

const STATUS_EVERY_MS = 5000;
const TXS_EVERY_MS = 20000;
const PERSIST_EVERY_MS = 15000;
const CONNECT_GRACE_MS = 25000;
// BEAM's wallet database commits 50 ms after a change (WalletDB::onModified); a save waits this long.
const DB_COMMIT_MS = 150;
// A regular payment expires after about 12 hours, so a locked wallet never runs longer for one.
const LOCKED_RUN_MAX_MS = 12 * 3600 * 1000;

// Written into the wallet (an address's comment): never translated.
export const ADDRESS_COMMENT = 'BEAM Campfire';

/** How a payment to each address type goes out (mirrors BeamSendMode.forType). */
export function sendModeFor(type) {
  switch (type) {
    case 'regular':
    case 'regular_new':
      return { fee: REGULAR_FEE, offline: false, receiverMustBeOnline: true, label: t('Regular address'), explanation: t("The receiver's wallet has to come online within about 12 hours to accept it; until then it shows as waiting.") };
    case 'offline':
      return { fee: OFFLINE_FEE, offline: true, receiverMustBeOnline: false, label: t('Offline address'), explanation: t("Arrives even while the receiver's wallet is closed. Costs a higher network fee (0.011 BEAM).") };
    case 'max_privacy':
      return { fee: OFFLINE_FEE, offline: false, receiverMustBeOnline: false, label: t('Max privacy address'), explanation: t('Hidden among many other payments; the receiver can spend it after a while. Costs a higher network fee (0.011 BEAM).') };
    case 'public_offline':
      return { fee: OFFLINE_FEE, offline: false, receiverMustBeOnline: false, label: t('Public address'), explanation: t('A reusable donation address: arrives while the receiver is offline. Costs a higher network fee (0.011 BEAM).') };
    default:
      return null;
  }
}

/** Plain-language wording for a transaction's state. */
/**
 * A failed transaction whose coins the same wallet had already spent somewhere else (the node said
 * "Inputs missing": lib/engine.js). Said in place of the engine's "Failed to register transaction".
 * Shown with t(SPENT_ELSEWHERE).
 */
export const SPENT_ELSEWHERE = tk(
  "These coins were already spent from this wallet somewhere else, in another browser or on another device with the same wallet. Nothing more was sent from here. Rescan (in Settings) brings this wallet's balance up to date.",
);

/**
 * Whether failed transaction `tx` failed because its coins were already spent elsewhere. Simple
 * payments only (tx_type 0): BEAM fails one only after making sure it is not on chain
 * (simple_transaction.cpp), so "nothing more was sent" is true. A contract call can be sent again to
 * the next node after it was already mined, and that node then says "Inputs missing" about its own
 * coins (0.2.14 release audit B-3): there the engine's own words stay.
 */
export function spentElsewhere(tx, { inputsMissing = engineLog.inputsMissing } = {}) {
  return Boolean(tx && Number(tx.status) === 4 && Number(tx.tx_type) === 0 && inputsMissing(tx.txId));
}

/** Why a failed transaction failed, in words: SPENT_ELSEWHERE, or the engine's own reason (null if none). */
export function txFailureText(tx, opts = {}) {
  if (!tx || Number(tx.status) !== 4) return null;
  if (spentElsewhere(tx, opts)) return t(SPENT_ELSEWHERE);
  return tx.failure_reason || null; // the engine's own words
}

export function txStatusText(tx) {
  // Split coins: the wallet's own coins split into new ones (BEAM Campfire's "Split into coins").
  if (isSplitTx(tx)) return splitStatusText(tx);
  const s = Number(tx.status);
  const income = Boolean(tx.income);
  if (isContractTx(tx)) {
    const swap = isSwapTx(tx);
    switch (s) {
      case 0:
        return t('Waiting');
      case 1:
        return swap ? t('Swapping') : t('In progress');
      case 2:
        return swap ? t('Swap cancelled') : t('Cancelled');
      case 3:
        return swap ? t('Swapped') : t('Done');
      case 4:
        return swap ? t('Swap failed') : t('Failed');
      case 5:
        return t('Confirming');
      default:
        return tx.status_string || t('Unknown'); // status_string: the engine's own words
    }
  }
  switch (s) {
    case 0:
      return income ? t('Waiting for the sender') : t('Waiting for the receiver');
    case 1:
      return income ? t('Receiving') : t('Sending');
    case 2:
      return t('Cancelled');
    case 3:
      return income ? t('Received') : t('Sent');
    case 4:
      return t('Failed');
    case 5:
      return t('Confirming');
    default:
      return tx.status_string || t('Unknown'); // status_string: the engine's own words
  }
}

export const CONTRACT_TX = 12;
const DEX_CONTRACT = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';

export function isContractTx(tx) {
  return Number(tx.tx_type) === CONTRACT_TX;
}

// The contracts BEAM Campfire knows by id (lib/widgets/beam/tx/beam_tx_view.dart, BeamContractKind).
const CONTRACT_KINDS = {
  [DEX_CONTRACT]: 'dex',
  af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e: 'names',
  // BEAM names' vault (view_params "vault"): payments to a name go in, and are claimed out of it.
  a3385e50cf33afc9f769ee1d82d56b73046d680d343977f36d9a303d7bcdc4da: 'namesVault',
  '8737e0d39575d7015fdea259fa091e41fc293e6c3d54e80d529033c349b5b18e': 'airdrop',
  // Airdrop v3 (lib/airdrop_v3.js V3_CID): every batch made since 0.2.16.
  ac85d74b88aca36a8033f19b00b89df55e9c75a45c8a567c0ee158e9c11aeffe: 'airdrop',
  '295fe749dc12c55213d1bd16ced174dc8780c020f59cb17749e900bb0c15d868': 'minter',
  '5ab408982b148210e88f180114f10222a2235eafeede0a3a224fda0e523e17b7': 'burn',
};

// BEAM's bridge to Ethereum: one pipe contract per asset. The same ids as lib/bridge/routes.js
// (a unit test keeps them equal); not imported from there, so the bridge code loads only when
// the bridge is opened.
export const BRIDGE_PIPES = new Set([
  'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835',
  '8872509d36a8e2aa7a60839a1828c372af47c0a5309f3f6186379cddec847369',
  '7c66181ba4625202aae6e46afe89acbf1f839523344b0b371fc7988ac2e8c056',
  '8af23fe6338e3e67574f4548c9acf3d269756ae9b25ab025fd4268a07b8a3c29',
  '02fb908e55a59ab5acc5bf6f1707a8dcdb70a944d6f2a7bff3c7af18c8e278da',
]);

/** Which known contract a contract call talked to: dex, names, namesVault, airdrop, minter, burn, bridge, or other. */
export function contractKind(tx) {
  for (const d of (tx && tx.invoke_data) || []) {
    const k = d && (CONTRACT_KINDS[d.contract_id] || (BRIDGE_PIPES.has(d.contract_id) ? 'bridge' : null));
    if (k) return k;
  }
  return 'other';
}

/**
 * What a contract call was, as BEAM Campfire titles it (BeamTxText.contractLabel): a swap, a
 * pool move, a claim... An unknown contract shows the dApp that made it, else "Contract call".
 */
export function contractLabel(tx) {
  const { spends, receives } = contractMoves(tx);
  const out = spends.length;
  const inn = receives.length;
  switch (contractKind(tx)) {
    case 'dex':
      if (out === 1 && inn === 1) return t('DEX swap');
      if (out >= 2 && inn <= 1) return t('Added to a DEX pool');
      if (inn >= 2 && out <= 1) return t('Taken from a DEX pool');
      return t('DEX');
    case 'names':
      return out || inn ? t('Name payment') : t('Name change'); // a transfer or listing moves no funds
    case 'namesVault':
      if (inn > 0 && out === 0) return t('Name payment claimed');
      return t('Paid to a name');
    case 'airdrop':
      if (inn > 0 && out === 0) return t('Airdrop claim');
      if (out > 0 && inn === 0) return t('Airdrop created');
      return t('Airdrop');
    case 'minter':
      return t('Token minter');
    case 'burn':
      return t('Burn');
    case 'bridge':
      // Into the pipe: on its way to Ethereum; out of it: arrived from Ethereum.
      if (out > 0 && inn === 0) return t('Moved to Ethereum');
      if (inn > 0 && out === 0) return t('Moved from Ethereum');
      return t('Bridge');
    default:
      // A dApp's own name (what its publisher wrote) is never translated.
      return tx && tx.appname && tx.appname !== ADDRESS_COMMENT ? tx.appname : t('Contract call');
  }
}

/** A contract call's state under its title: "Completed", or what is still happening. */
export function contractStatusText(tx) {
  return Number(tx.status) === 3 ? t('Completed') : txStatusText(tx);
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
    this.lockedRun = null;
    // Leaving: save at once (the page may not get another turn), then again after the commit.
    const leaving = () => {
      this.persistNow({ afterCommit: false });
      this.persistNow();
    };
    this._onHidden = () => {
      if (document.visibilityState === 'hidden') leaving();
    };
    this._onPageHide = leaving;
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
      // The payment list has been read at least once this run (lib/payment_notice.js: the first read is history).
      txsLoaded: false,
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
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const hop = reconnectView({ switching: s.switching, emptyHops: this.plan ? this.plan.emptyHops : 0, connectFailed: s.connectFailed, online });
    s.sync = assessSync({
      status: s.status,
      // Mid-hop no engine is open: never "connected" then, whatever the last event said (release audit 0.2.15).
      nodeConnected: s.nodeConnected && !s.switching,
      everConnected: s.everConnected,
      connectFailed: hop.connectFailed,
      explorer: s.explorer,
      now: Date.now() / 1000,
      progress: s.progress,
      importing: s.importing,
      reconnecting: hop.reconnecting,
      ownNode: s.nodeMode === 'own' ? s.node : null,
      online,
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
   * The asset's ticker where assets are picked by it, with its number when another asset this
   * wallet holds has the same ticker: two different CHADs (#187, #190) must not look alike in Send.
   */
  distinctUnit(assetId) {
    const id = Number(assetId);
    const unit = this.label(id).unit;
    if (/#\d+$/.test(unit)) return unit;
    for (const other of this.state.totals.keys()) {
      if (other !== id && this.label(other).unit === unit) return `${unit} #${id}`;
    }
    return unit;
  }

  /**
   * Starts the engine with the database password. node: RANDOM_NODE (the pool:
   * a random start, and the next node whenever this one fails or stalls), one of
   * the pool's addresses (the same, starting on that node: lib/nodes.js
   * walletNode) or the person's own node "host:port" (only that node, never a
   * fallback).
   */
  async start({ dbPass, node, recovery = null, onImport = null, bodyRequests = true, rescan = false }) {
    if (this.session) throw new EngineError('running', t('The wallet is already open.'));
    this.gen = (this.gen || 0) + 1;
    this.state = this.emptyState();
    const random = !node || node === RANDOM_NODE || isPoolNode(node);
    this.plan = { random, order: random ? poolOrder(Math.random, node) : [node], bestHeight: 0, emptyHops: 0, staleHops: 0, lastHopAt: 0 };
    this.state.node = this.plan.order[0];
    this.state.nodeMode = random ? 'random' : 'own';
    this.state.scanning = Boolean(bodyRequests || recovery);
    this.state.startedAt = Date.now();
    // Kept while the wallet runs, like app.dbPass, so a hop restarts the same wallet; dropped by stop().
    // dbPath: which wallet's database (lib/wallets.js), fixed for this run whichever wallet is selected later.
    this.run = { dbPass, dbPath: currentWalletPath(), bodyRequests: Boolean(bodyRequests || recovery) };
    this.resetNodeWatch();
    this.watchGuard();
    const { session, imported } = await startWallet({
      dbPass,
      dbPath: this.run.dbPath,
      node: this.state.node,
      recovery,
      bodyRequests,
      rescan,
      onImport: (d, total) => {
        this.state.importProgress = { done: d, total };
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
    // Locked (keepRunningLocked): no contract calls until it is unlocked again.
    if (!this.lockedRun) bindSession(session);
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
    return this.moveTo(to, reason);
  }

  /**
   * "Use this one" on the node screen: a wallet on BEAM's pool moves to `address` now and keeps
   * the other pool nodes behind it, so it still moves on by itself when that one stops answering
   * (lib/nodes.js poolOrder). The same restart as a hop: wallet.db flushed, payments under way
   * resumed by the engine, balances and payments stay on screen. The sync line says "Connecting…"
   * (it is the person's choice, not a failure); a node that does not answer is then left by the
   * usual rules. Resolves once the engine runs on the new node.
   */
  async useNode(address) {
    const p = this.plan;
    if (!isPoolNode(address)) throw new EngineError('node', t("That is not one of BEAM's public nodes."));
    if (!p || !p.random || !this.session) throw new EngineError('node', t("The wallet is not running on BEAM's public nodes."));
    if (this.state.importing) throw new EngineError('busy', t('The wallet is still getting ready. Try again when it is done.'));
    if (this.hopping) throw new EngineError('busy', t('The wallet is moving to another node right now. Try again in a moment.'));
    p.order = poolOrder(Math.random, address);
    p.emptyHops = 0;
    p.staleHops = 0;
    p.lastHopAt = Date.now();
    if (this.state.node === address) return;
    await this.moveTo(address, 'chosen');
  }

  /** Stops the engine and starts it again on `to`: a hop (reason from lib/node_health.js) or the person's choice ('chosen'). */
  async moveTo(to, reason) {
    const from = this.state.node;
    const chosen = reason === 'chosen';
    this.hopping = true;
    const gen = this.gen;
    const current = () => this.gen === gen && this.run;
    const entry = { from, to, reason, at: Date.now() };
    this.state.switchLog.push(entry);
    // A hop says "Reconnecting to another node…"; a choice is a fresh start on that node ("Connecting…").
    this.state.switching = chosen ? null : entry;
    if (chosen) {
      // No engine runs until the new one is attached: never "Synced" meanwhile (release audit 0.2.16).
      this.state.startedAt = Date.now();
      this.state.nodeConnected = false;
      this.state.everConnected = false;
    }
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
      const { session } = await startWallet({ dbPass: this.run.dbPass, dbPath: this.run.dbPath, node: to, bodyRequests: this.run.bodyRequests });
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
      for (const tot of st.totals || []) {
        const id = Number(tot.asset_id);
        const g = (k) => {
          const v = tot[`${k}_str`] ?? tot[k];
          return v === undefined ? 0n : toGroth(v);
        };
        // maturingMp: the part of maturing that is private coins BEAM still holds back (max privacy, lib/coins.js).
        totals.set(id, { available: g('available'), receiving: g('receiving'), sending: g('sending'), maturing: g('maturing'), maturingMp: g('maturing_mp') });
      }
      if (!totals.has(0)) {
        totals.set(0, {
          available: toGroth(st.available || 0),
          receiving: toGroth(st.receiving || 0),
          sending: toGroth(st.sending || 0),
          maturing: toGroth(st.maturing || 0),
          maturingMp: 0n,
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
        .filter((tx) => [0, 7, 12].includes(Number(tx.tx_type)))
        .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
      this.state.txsLoaded = true;
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
    const tot = this.state.totals.get(Number(assetId));
    return tot ? tot.available : 0n;
  }

  persistSoon() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 1200);
  }

  /**
   * Saves wallet.db to the browser's storage. BEAM's wallet database commits a
   * change 50 ms after making it (WalletDB::onModified), so a save right after an
   * action waits for that commit first: otherwise the saved copy could miss the
   * payment just made, and a phone that closes the app then loses it.
   */
  async persistNow({ afterCommit = true } = {}) {
    if (afterCommit && this.session) await new Promise((r) => setTimeout(r, DB_COMMIT_MS));
    if (this.session) return this.session.syncFS();
  }

  // ------------------------------------------------------------ actions
  async validateAddress(address) {
    return this.session.call('validate_address', { address }, { timeoutMs: 15000 });
  }

  /** preferred: the address the person chose to show (Your addresses), used while it can be paid. */
  async receiveAddress({ fresh = false, preferred = null } = {}) {
    if (!fresh) {
      const list = await this.session.call('addr_list', { own: true }, { timeoutMs: 20000 });
      const picked = pickReceiveAddress(list, { preferred, label: ADDRESS_COMMENT });
      if (picked) return picked;
    }
    const addr = await this.session.call('create_address', { type: 'regular', expiration: 'never', comment: ADDRESS_COMMENT }, { timeoutMs: 20000 });
    await this.persistNow();
    return addr;
  }

  /** comment: the person's note, kept with the payment in this wallet only (lib/payments.js). */
  async send({ address, amount, assetId = 0, mode, comment = '' }) {
    if (!this.session) throw new EngineError('stopped', t('The wallet is not open yet. Go back to Home, then try again.'));
    const params = { address, value: toJsonNumber(amount), fee: toJsonNumber(mode.fee) };
    if (comment) params.comment = comment;
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
    if (!this.session) throw new EngineError('stopped', t('The wallet is not open yet. Go back to Home, then try again.'));
    return this.session.exportOwnerKey(password);
  }

  /** A payment or contract call is under way: waiting, in progress or registering. */
  paymentUnderWay() {
    return Boolean(this.session) && this.state.txs.some(isPendingTx);
  }

  /**
   * Locked while a payment is under way. BEAM finishes a payment only while both
   * wallets are online, so the engine keeps running behind the lock screen - with no
   * dApps and no consent - and stops by itself once nothing is under way, or after
   * 12 hours. unlockedAgain() carries on with it.
   */
  keepRunningLocked() {
    unbindSession();
    const since = Date.now();
    const check = () => {
      if (!this.lockedRun) return;
      if (Date.now() - since >= LOCKED_RUN_MAX_MS) return this.stop();
      // Moving to another node leaves no session for a moment: that is not "nothing under way".
      if (this.hopping || !this.session) return;
      if (!this.paymentUnderWay()) this.stop();
    };
    this.lockedRun = { off: this.onChange(check), timer: setInterval(check, 15000) };
  }

  /** Unlocked while kept running: true, and carries on, when it is the same wallet (same database file and password). */
  unlockedAgain(dbPass, dbPath = currentWalletPath()) {
    if (!this.lockedRun || !this.session || !this.run || this.run.dbPath !== dbPath || this.run.dbPass !== dbPass) return false;
    this.endLockedRun();
    bindSession(this.session);
    this.emit();
    return true;
  }

  endLockedRun() {
    const l = this.lockedRun;
    if (!l) return;
    this.lockedRun = null;
    l.off();
    clearInterval(l.timer);
  }

  async stop() {
    // What an app already asked the engine is answered before its handle goes (contracts.js settleApps).
    await settleApps();
    this.endLockedRun();
    for (const tmr of this.timers) clearInterval(tmr);
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
