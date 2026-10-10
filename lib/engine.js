// BEAM's own WebAssembly wallet engine (BeamMW/beam wasmclient, tag
// beam-7.5.14493 + Campfire patches), and the guard rails around it.
//
// - Node guard: the engine opens WebSockets itself, and besides the node you
//   chose it also tries BEAM's built-in peer list (eu-nodes and us-nodes on
//   port 8100, see wallet/core/default_peers.cpp). Every WebSocket this page
//   opens goes through the guard, which only lets the chosen node through.
//   That keeps your IP address away from every other server and keeps the CSP
//   console clean. The guard also tells the app whether the node is connected.
// - Persistence: wallet.db lives in IDBFS (/beam_wallet). The engine writes to
//   memory and only flushes on create/delete/mount, so this wrapper flushes
//   (FS.syncfs) after changes, every 15 s, and when the page is hidden.
// - Secrets: the database password is passed to the engine and nowhere else.

const ENGINE_SCRIPT = 'vendor/engine/wasm-client.js';
export const DB_DIR = '/beam_wallet';
export const DB_PATH = '/beam_wallet/wallet.db';
const RECOVERY_FS_PATH = '/recovery.bin'; // MEMFS root: never persisted to IndexedDB

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- node guard
// Per node (reset by setAllowed): attempts, failures (closed before opening),
// first open and last close - what lib/node_health.js judges a node by.
const guard = { allowed: null, allowedHost: null, open: 0, everOpen: false, attempts: 0, failures: 0, firstOpenAt: null, lastCloseAt: null, blocked: new Map(), listeners: new Set(), lastError: null };
const NativeWebSocket = globalThis.WebSocket;

/** "host:443" and "host" are one WebSocket host: compare as the URL parser writes it. */
function wsHost(node) {
  try {
    return new URL(`wss://${node}/`).host;
  } catch {
    return null;
  }
}

function notifyGuard() {
  for (const fn of guard.listeners) {
    try {
      fn({ open: guard.open, everOpen: guard.everOpen });
    } catch {
      /* listener errors are not the guard's problem */
    }
  }
}

if (NativeWebSocket && !NativeWebSocket.__campfireGuard) {
  class GuardedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      let host = '';
      let proto = '';
      try {
        const u = new URL(String(url));
        host = u.host;
        proto = u.protocol;
      } catch {
        /* falls through to refusal */
      }
      if (!guard.allowedHost || proto !== 'wss:' || host !== guard.allowedHost) {
        guard.blocked.set(host || String(url), (guard.blocked.get(host || String(url)) || 0) + 1);
        throw new DOMException(`BEAM Campfire only connects to the node you chose (${guard.allowed || 'none'})`, 'SecurityError');
      }
      super(url, protocols);
      const mine = guard.allowedHost;
      guard.attempts++;
      let opened = false;
      this.addEventListener('open', () => {
        if (guard.allowedHost !== mine) return;
        opened = true;
        guard.open++;
        guard.everOpen = true;
        if (!guard.firstOpenAt) guard.firstOpenAt = Date.now();
        guard.lastError = null;
        notifyGuard();
      });
      this.addEventListener('error', () => {
        if (guard.allowedHost === mine) guard.lastError = Date.now();
      });
      this.addEventListener('close', () => {
        if (guard.allowedHost !== mine) return;
        if (opened) {
          guard.open = Math.max(0, guard.open - 1);
          guard.lastCloseAt = Date.now();
        } else guard.failures++;
        notifyGuard();
      });
    }
  }
  GuardedWebSocket.__campfireGuard = true;
  globalThis.WebSocket = GuardedWebSocket;
}

export const nodeGuard = {
  setAllowed(node) {
    guard.allowed = node;
    guard.allowedHost = node ? wsHost(node) : null;
    guard.everOpen = false;
    guard.open = 0;
    guard.attempts = 0;
    guard.failures = 0;
    guard.firstOpenAt = null;
    guard.lastCloseAt = null;
  },
  get state() {
    return { allowed: guard.allowed, open: guard.open, everOpen: guard.everOpen, attempts: guard.attempts, failures: guard.failures, firstOpenAt: guard.firstOpenAt, lastCloseAt: guard.lastCloseAt, blocked: Object.fromEntries(guard.blocked), lastError: guard.lastError };
  },
  subscribe(fn) {
    guard.listeners.add(fn);
    return () => guard.listeners.delete(fn);
  },
};

// ---------------------------------------------------------------- engine log
const LOG_MAX = 400;
const logLines = [];
let rulesSignature = '';
let capturingRules = false;

function onPrint(line, isErr) {
  const s = String(line);
  if (s.includes('Rules signature:')) {
    capturingRules = true;
    rulesSignature = s.slice(s.indexOf('Rules signature:') + 16).trim();
  } else if (capturingRules && s.startsWith('\t')) {
    rulesSignature += ' ' + s.trim();
  } else {
    capturingRules = false;
  }
  logLines.push((isErr ? 'E ' : '') + s);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  // Forward only what is useful to see in a console: the consensus rules and
  // warnings/errors. Ordinary lines can name coins and amounts.
  if (s.includes('Rules signature') || (capturingRules && s.startsWith('\t'))) console.info('[engine]', s);
  else if (isErr || / [WE] \d{4}-\d\d-\d\d/.test(s)) console.warn('[engine]', s);
}

export const engineLog = {
  lines: () => logLines.slice(),
  rulesSignature: () => rulesSignature,
};

// ---------------------------------------------------------------- module
let modulePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.BeamModule) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new EngineError('load', 'The wallet engine did not load. Check your connection and reload.'));
    document.head.appendChild(s);
  });
}

export function engineSupport() {
  const problems = [];
  if (!globalThis.WebAssembly) problems.push('WebAssembly');
  if (!globalThis.crossOriginIsolated) problems.push('cross-origin isolation');
  if (typeof SharedArrayBuffer === 'undefined') problems.push('SharedArrayBuffer');
  if (!globalThis.indexedDB) problems.push('IndexedDB');
  return { ok: problems.length === 0, problems };
}

// The engine's runtime aborted: it cannot run a wallet again in this page (a reload starts a new one).
let abortedWhy = null;
const abortListeners = new Set();

/** Runs fn(reason) once the engine's runtime has aborted. Returns a function that removes it. */
export function onEngineAbort(fn) {
  abortListeners.add(fn);
  if (abortedWhy) fn(abortedWhy);
  return () => abortListeners.delete(fn);
}

/** Loads the engine and mounts its file system (once per page). */
export function loadEngine() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const sup = engineSupport();
    if (!sup.ok) throw new EngineError('unsupported', `This browser is missing: ${sup.problems.join(', ')}.`);
    await loadScript(ENGINE_SCRIPT);
    const M = await globalThis.BeamModule({
      print: (t) => onPrint(t, false),
      printErr: (t) => onPrint(t, true),
      onAbort: (what) => {
        abortedWhy = String(what || 'aborted').slice(0, 300);
        for (const fn of abortListeners) {
          try {
            fn(abortedWhy);
          } catch {
            /* a listener's own problem */
          }
        }
      },
    });
    await new Promise((resolve, reject) => {
      M.WasmWalletClient.MountFS((err) => (err ? reject(new EngineError('mount', `Storage could not be opened: ${err}`)) : resolve()));
    });
    return M;
  })();
  modulePromise.catch(() => {
    modulePromise = null;
  });
  return modulePromise;
}

// ---------------------------------------------------------------- persistence
let syncing = null;
let syncAgain = false;
export function syncFS(M) {
  if (!M) return Promise.resolve();
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = new Promise((resolve) => {
    M.FS.syncfs(false, (err) => {
      if (err) console.warn('[campfire] saving wallet data failed', err);
      resolve(!err);
    });
  }).then((ok) => {
    syncing = null;
    if (syncAgain) {
      syncAgain = false;
      return syncFS(M);
    }
    return ok;
  });
  return syncing;
}

// ---------------------------------------------------------------- wallet ops
export async function walletExists() {
  const M = await loadEngine();
  return Boolean(M.WasmWalletClient.IsInitialized(DB_PATH));
}

/** File names in the wallet directory (names only: for the e2e and the self-test). */
export async function walletFiles() {
  const M = await loadEngine();
  try {
    return M.FS.readdir(DB_DIR).filter((n) => n !== '.' && n !== '..').sort();
  } catch {
    return [];
  }
}

export async function generatePhrase() {
  const M = await loadEngine();
  return M.WasmWalletClient.GeneratePhrase().trim().split(/\s+/);
}

export async function isAllowedWord(w) {
  const M = await loadEngine();
  return Boolean(M.WasmWalletClient.IsAllowedWord(String(w)));
}

export async function isValidPhrase(words) {
  const M = await loadEngine();
  return Boolean(M.WasmWalletClient.IsValidPhrase(words.join(' ')));
}

export async function createWalletDb(words, dbPass) {
  const M = await loadEngine();
  if (M.WasmWalletClient.IsInitialized(DB_PATH)) throw new EngineError('exists', 'A wallet already exists on this device.');
  try {
    M.WasmWalletClient.CreateWallet(words.join(';'), DB_PATH, dbPass);
  } catch (e) {
    throw new EngineError('create', 'The wallet could not be created: ' + (e && e.message));
  }
  if (!M.WasmWalletClient.IsInitialized(DB_PATH)) throw new EngineError('create', 'The wallet could not be created.');
  await syncFS(M);
}

/** Removes wallet.db and its sqlite side files, then flushes to IndexedDB. */
export async function deleteWalletDb() {
  const M = await loadEngine();
  try {
    if (M.WasmWalletClient.IsInitialized(DB_PATH)) M.WasmWalletClient.DeleteWallet(DB_PATH);
  } catch {
    /* removed below */
  }
  try {
    for (const name of M.FS.readdir(DB_DIR)) {
      if (name === '.' || name === '..') continue;
      try {
        M.FS.unlink(`${DB_DIR}/${name}`);
      } catch {
        /* not a file */
      }
    }
  } catch {
    /* empty */
  }
  await syncFS(M);
}

// ---------------------------------------------------------------- import a wallet.db
// The picked file's bytes are written next to wallet.db as import.db (same
// IDBFS mount, so adopting it is a rename, not a second copy of a file that
// may be large). Nothing is flushed to IndexedDB until BEAM's own code has
// opened the file with its password: a wrong password, or a file that is not
// a wallet, is discarded and leaves nothing behind. The original file is
// only read (the browser hands over a copy of its bytes).
export const IMPORT_PATH = `${DB_DIR}/import.db`;
const IMPORT_NAME = 'import.db';

function removeImportFiles(M, { sideFilesOnly = false } = {}) {
  let names = [];
  try {
    names = M.FS.readdir(DB_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    // SQLCipher's format migration works through "<db>-migrated"; SQLite's journal is "<db>-journal".
    const side = name.startsWith(`${IMPORT_NAME}-`);
    if (!side && (sideFilesOnly || name !== IMPORT_NAME)) continue;
    try {
      M.FS.unlink(`${DB_DIR}/${name}`);
    } catch {
      /* already gone */
    }
  }
}

/** Puts the picked file's bytes where the engine can open them. The engine owns `bytes` afterwards. */
export async function stageImport(bytes) {
  const M = await loadEngine();
  removeImportFiles(M);
  M.FS.writeFile(IMPORT_PATH, bytes, { canOwn: true });
}

/**
 * Opens the staged file with the password through BEAM's own code
 * (WasmWalletClient.CheckPassword -> WalletDB::isValidPassword: sqlite open,
 * SQLCipher key, read the schema; older SQLCipher formats are migrated in
 * the copy). Runs on an engine thread; the password goes nowhere else.
 * @returns {Promise<boolean>} true when the password opens it.
 */
export async function checkImportPassword(password, { timeoutMs = 180000 } = {}) {
  const M = await loadEngine();
  if (!M.WasmWalletClient.IsInitialized(IMPORT_PATH)) throw new EngineError('missing', 'No file to check.');
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new EngineError('timeout', 'Checking the file took too long.'));
    }, timeoutMs);
    try {
      M.WasmWalletClient.CheckPassword(IMPORT_PATH, password, (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok === true);
      });
    } catch {
      done = true;
      clearTimeout(timer);
      reject(new EngineError('check', 'The file could not be checked.'));
    }
  });
}

/** The checked file becomes this device's wallet.db, and is saved to IndexedDB. */
export async function adoptImport() {
  const M = await loadEngine();
  if (M.WasmWalletClient.IsInitialized(DB_PATH)) throw new EngineError('exists', 'A wallet already exists on this device.');
  if (!M.WasmWalletClient.IsInitialized(IMPORT_PATH)) throw new EngineError('missing', 'No file to import.');
  removeImportFiles(M, { sideFilesOnly: true });
  M.FS.rename(IMPORT_PATH, DB_PATH);
  if (!(await syncFS(M))) {
    try {
      M.FS.unlink(DB_PATH);
    } catch {
      /* not there */
    }
    await syncFS(M);
    throw new EngineError('save', 'The wallet could not be saved on this device.');
  }
}

/** Forgets a staged file (wrong password, another file picked, screen left). Never touches wallet.db. */
export async function discardImport() {
  const M = await loadEngine();
  removeImportFiles(M);
}

// ---------------------------------------------------------------- export wallet.db
// The live wallet.db is never re-keyed. Its bytes are read while the engine is
// stopped (so no write is half done), copied into the engine's memory file
// system outside IDBFS, re-keyed there by WasmWalletClient.RekeyFile (wasm patch
// 0105) to a password the person knows, read back and deleted.
const EXPORT_PATH = '/campfire-export.db'; // MEMFS root: never flushed to IndexedDB

/** wallet.db's bytes. The caller stops the wallet first. */
export async function readWalletDb() {
  const M = await loadEngine();
  if (!M.WasmWalletClient.IsInitialized(DB_PATH)) throw new EngineError('missing', 'There is no wallet on this device.');
  return M.FS.readFile(DB_PATH); // a copy
}

/** A re-keyed copy of `bytes` (opened with oldPass) that opens with newPass. */
export async function rekeyCopy(bytes, oldPass, newPass, { timeoutMs = 120000 } = {}) {
  const M = await loadEngine();
  if (typeof M.WasmWalletClient.RekeyFile !== 'function') throw new EngineError('engine', 'This engine build cannot export a wallet (it needs wasm patch 0105).');
  const clean = () => {
    for (const p of [EXPORT_PATH, `${EXPORT_PATH}-journal`]) {
      try {
        M.FS.unlink(p);
      } catch {
        /* not there */
      }
    }
  };
  clean();
  M.FS.writeFile(EXPORT_PATH, bytes, { canOwn: true });
  try {
    const ok = await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new EngineError('timeout', 'Preparing the file took too long.'));
        }
      }, timeoutMs);
      try {
        M.WasmWalletClient.RekeyFile(EXPORT_PATH, oldPass, newPass, (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(r === true);
        });
      } catch {
        done = true;
        clearTimeout(timer);
        reject(new EngineError('rekey', 'The file could not be prepared.'));
      }
    });
    if (!ok) throw new EngineError('rekey', 'The file could not be prepared.');
    return M.FS.readFile(EXPORT_PATH);
  } finally {
    clean();
  }
}

/**
 * A running wallet: JSON-RPC calls, events, stop.
 */
export class WalletSession {
  constructor(M, client) {
    this.M = M;
    this.client = client;
    this.nextId = 1;
    this.pending = new Map();
    // Requests the engine has not answered yet, whether or not their caller still waits (settle()).
    this.inflight = new Set();
    this.eventListeners = new Set();
    this.syncListeners = new Set();
    this.stopped = false;
    this.subKey = client.subscribe((s) => this.onMessage(s));
    client.setSyncHandler((done, total) => {
      for (const fn of this.syncListeners) fn(done, total);
    });
  }

  onMessage(s) {
    let m;
    try {
      m = JSON.parse(s);
    } catch {
      return;
    }
    if (typeof m.id === 'string' && m.id.startsWith('ev_')) {
      for (const fn of this.eventListeners) fn(m.id, m.result);
      return;
    }
    this.inflight.delete(m.id);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) {
      const e = new EngineError('rpc', m.error.message || 'wallet error');
      e.rpc = m.error;
      p.reject(e);
    } else p.resolve(m.result);
  }

  call(method, params, { timeoutMs = 60000 } = {}) {
    if (this.stopped) return Promise.reject(new EngineError('stopped', 'The wallet is locked.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError('timeout', `The wallet did not answer (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const req = { jsonrpc: '2.0', id, method };
      if (params !== undefined) req.params = params;
      try {
        this.inflight.add(id);
        this.client.sendRequest(JSON.stringify(req));
      } catch (e) {
        clearTimeout(timer);
        this.inflight.delete(id);
        this.pending.delete(id);
        reject(new EngineError('rpc', String(e && e.message)));
      }
    });
  }

  onEvent(fn) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onSync(fn) {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  syncFS() {
    return syncFS(this.M);
  }

  /**
   * The owner key (wasm patch 0106), encrypted with `password` the way
   * `beam-wallet export_owner_key` does it: a node started with
   * --owner_key=<key> --pass=<password> reads it. `password` is the one the
   * person typed, never the database password. The key is handed to the
   * caller only: not logged, not kept here.
   */
  exportOwnerKey(password, { timeoutMs = 60000 } = {}) {
    if (this.stopped || !this.client) return Promise.reject(new EngineError('stopped', 'The wallet is locked.'));
    if (typeof this.client.exportOwnerKey !== 'function') return Promise.reject(new EngineError('engine', 'This engine build cannot show the owner key (it needs wasm patch 0106).'));
    if (!password) return Promise.reject(new EngineError('owner_key', 'Enter your password.'));
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (code, message) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new EngineError(code, message));
      };
      const timer = setTimeout(() => fail('timeout', 'The wallet did not answer. Try again.'), timeoutMs);
      try {
        this.client.exportOwnerKey(password, (key) => {
          if (done) return;
          if (typeof key !== 'string' || !key) return fail('owner_key', 'The owner key could not be read. Try again.');
          done = true;
          clearTimeout(timer);
          resolve(key);
        });
      } catch {
        fail('owner_key', 'The owner key could not be read. Try again.');
      }
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new EngineError('stopped', 'The wallet is locked.'));
    }
    this.pending.clear();
    await this.settle();
    await syncFS(this.M);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        if (this.client.isRunning()) this.client.stopWallet(finish);
        else finish();
      } catch {
        finish();
      }
      setTimeout(finish, 15000);
    });
    try {
      this.client.unsubscribe(this.subKey);
    } catch {
      /* already gone */
    }
    try {
      this.client.delete();
    } catch {
      /* embind object already released */
    }
    this.client = null;
    await syncFS(this.M);
  }

  /**
   * Waits until nothing is on its way from the engine to this page. BEAM's wasm
   * client holds itself in every answer and event it queues for the page, and
   * StopWallet asserts it holds the only reference: a stop with one still queued
   * aborts the whole WebAssembly runtime ("Assertion failed: wp.use_count() == 1
   * ... StopWallet"), and no wallet runs in this page again until it reloads - it
   * reaches no node and sees no payment. So: events off (that answer comes after
   * every event queued before it), every request answered, one more turn. At most
   * timeoutMs: an engine that stopped answering is stopped anyway.
   */
  async settle({ timeoutMs = 10000 } = {}) {
    let running = false;
    try {
      running = this.client.isRunning();
    } catch {
      running = false;
    }
    if (!running) return;
    const id = this.nextId++;
    const off = { ev_sync_progress: false, ev_system_state: false, ev_txs_changed: false, ev_addrs_changed: false, ev_utxos_changed: false, ev_assets_changed: false, ev_connection_changed: false };
    try {
      this.inflight.add(id);
      this.client.sendRequest(JSON.stringify({ jsonrpc: '2.0', id, method: 'ev_subunsub', params: off }));
    } catch {
      this.inflight.delete(id);
    }
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    while (this.inflight.size && Date.now() - t0 < timeoutMs) await tick();
    if (this.inflight.size) console.warn(`[campfire] stopping with ${this.inflight.size} request(s) unanswered`);
    await tick();
  }
}

/**
 * Starts the wallet. With `recovery` (the downloaded snapshot), the import runs
 * as the first thing the engine does; onImport(done, total) reports it.
 * bodyRequests=false (engine patch 0102) runs a wallet without scanning block
 * bodies: right for a freshly generated seed, which has no history. Such a
 * wallet sees the payments it negotiates itself, but not payments to
 * offline/max-privacy addresses or coins moved by another copy of the seed.
 * @returns {Promise<{session: WalletSession, imported: Promise<void>|null}>}
 */
export async function startWallet({ dbPass, node, recovery = null, onImport = null, bodyRequests = true }) {
  const M = await loadEngine();
  if (abortedWhy) throw new EngineError('aborted', 'The wallet engine stopped working in this page. Reload to start it again.');
  if (!M.WasmWalletClient.IsInitialized(DB_PATH)) throw new EngineError('missing', 'There is no wallet on this device.');
  nodeGuard.setAllowed(node);
  const client = new M.WasmWalletClient(DB_PATH, dbPass, node);
  if (typeof client.setBodyRequests === 'function') client.setBodyRequests(Boolean(bodyRequests || recovery));
  else if (!bodyRequests && !recovery) throw new EngineError('engine', 'This engine build cannot start a wallet without scanning (needs patch 0102).');
  const session = new WalletSession(M, client);
  let imported = null;
  if (recovery) {
    M.FS.writeFile(RECOVERY_FS_PATH, recovery, { canOwn: true });
    imported = new Promise((resolve, reject) => {
      client.importRecoveryFromFile(RECOVERY_FS_PATH, (err, done, total) => {
        if (onImport && !err) onImport(done, total);
        if (err || done === total) {
          try {
            M.FS.unlink(RECOVERY_FS_PATH);
          } catch {
            /* already gone */
          }
          if (err) reject(new EngineError('import', 'The snapshot could not be read. Try again; if it keeps failing, skip it and let the wallet scan instead.'));
          else resolve();
        }
      });
    });
  }
  try {
    client.startWallet();
  } catch (e) {
    throw new EngineError('start', 'The wallet did not start: ' + (e && e.message));
  }
  return { session, imported };
}
