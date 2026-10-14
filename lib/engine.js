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
// - One tab at a time (lib/one_tab.js): this page's copy of the mount is written back over
//   IndexedDB, and IDBFS deletes what the copy lacks, so two pages would undo each other. The
//   engine loads and a wallet starts only in the page that holds the lock, and every flush - the
//   app's and the engine's own (FS.syncfs in CreateWallet and DeleteWallet) - goes through
//   guardSyncfs(), which refuses once this page no longer holds it.
import { oneTab, OtherTabError, needThisTab } from './one_tab.js';
import { isPoolNode } from './nodes.js';
import { t } from './i18n.js';

const ENGINE_SCRIPT = 'vendor/engine/wasm-client.js';
export const DB_DIR = '/beam_wallet';
export const DB_PATH = '/beam_wallet/wallet.db';

// Several wallets (lib/wallets.js): the wallet in the first slot keeps /beam_wallet/wallet.db (where a
// single-wallet version keeps it); every other wallet has its own folder, /beam_wallet/<id>/wallet.db,
// in the same IDBFS mount. The functions below work on the selected wallet's file unless given a path.
let walletPath = DB_PATH;

/** The database every function below uses by default (lib/wallets.js sets it with the selected wallet). */
export function useWalletPath(p) {
  walletPath = typeof p === 'string' && p ? p : DB_PATH;
}

export function currentWalletPath() {
  return walletPath;
}

/** A wallet database path this app may touch: the first slot's, or <DB_DIR>/<16 hex>/wallet.db. */
export function isWalletPath(p) {
  return p === DB_PATH || new RegExp(`^${DB_DIR}/[0-9a-f]{16}/wallet\\.db$`).test(String(p));
}

function dirOf(p) {
  return p.slice(0, p.lastIndexOf('/'));
}

function ensureDir(M, dir) {
  if (dir === DB_DIR) return;
  try {
    M.FS.mkdir(dir);
  } catch {
    /* already there */
  }
}

function checkPath(p) {
  if (!isWalletPath(p)) throw new EngineError('path', 'Not a wallet file of this app.'); // i18n-ignore: an invariant (the app passes only its own paths), never shown
  return p;
}
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

/**
 * A WebSocket to one of BEAM's public nodes for the node screen's check (lib/node_tip.js): the
 * browser's own, past the node guard, so it is not counted as the wallet's connection and does not
 * disturb what lib/node_health.js judges the node in use by. Only POOL addresses, all of which are
 * in every page's connect-src already: a check can reach no host the wallet could not.
 */
export function openPoolSocket(address) {
  if (!isPoolNode(address)) throw new DOMException("Only BEAM's public nodes can be checked", 'SecurityError');
  return new NativeWebSocket(`wss://${address}/`);
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

// A transaction the node refused because coins it spends no longer exist. The node answers its
// registration with InvalidInput and "Inputs missing" (node/processor.cpp), which the engine logs as
// the warning "Extra info: Inputs missing", without the transaction's id (the line that has it,
// "register status", is a debug line, compiled out of a release engine). The transaction then fails
// with "Failed to register transaction", which the engine logs as "[<txid>] Failed. ..." (an error
// line, BaseTransaction::OnFailed). So each such warning is matched to the next transaction that
// fails to register within INPUTS_MISSING_WINDOW_MS. On a wallet whose coins are right, the coins
// are gone because the same wallet spent them elsewhere (another browser or device with its words
// or file). Its status says only "Failed to register transaction", so the txid is kept here for the
// screens (lib/wallet.js txFailureText). Memory only, for this session.
const INPUTS_MISSING_LINE = 'Extra info: Inputs missing'; // i18n-ignore: an engine log line it is matched against
const FAILED_TO_REGISTER = /\[([0-9a-f]{32})\](?:\[\d+\])? Failed\. Failed to register transaction/;
export const INPUTS_MISSING_WINDOW_MS = 10 * 60000;
const INPUTS_MISSING_MAX = 50;
const inputsMissing = new Map(); // txid -> when its failure was matched
const missingSaid = []; // when the node said "Inputs missing", not matched to a failure yet

/** Reads one engine log line for a refusal of missing inputs. Exported for the unit tests. */
export function noteEngineLine(s, now = Date.now()) {
  if (s.includes(INPUTS_MISSING_LINE)) {
    missingSaid.push(now);
    if (missingSaid.length > INPUTS_MISSING_MAX) missingSaid.shift();
    return;
  }
  const f = FAILED_TO_REGISTER.exec(s);
  if (!f) return;
  while (missingSaid.length && now - missingSaid[0] > INPUTS_MISSING_WINDOW_MS) missingSaid.shift();
  if (!missingSaid.length) return;
  missingSaid.shift();
  inputsMissing.set(f[1], now);
  if (inputsMissing.size > INPUTS_MISSING_MAX) inputsMissing.delete(inputsMissing.keys().next().value);
}

function onPrint(line, isErr) {
  const s = String(line);
  if (s.includes('Inputs missing') || s.includes('Failed to register')) noteEngineLine(s);
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
  /** Whether the node refused transaction `txId` because the coins it spends are gone. */
  inputsMissing: (txId) => typeof txId === 'string' && inputsMissing.has(txId.toLowerCase()),
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
    s.onerror = () => reject(new EngineError('load', t('The wallet engine did not load. Check your connection and reload.')));
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

/** Loads the engine and mounts its file system (once per page). Only in the page that holds the wallet. */
export function loadEngine() {
  if (!oneTab().canOpen()) return Promise.reject(new OtherTabError());
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const sup = engineSupport();
    if (!sup.ok) throw new EngineError('unsupported', t('This browser is missing: {features}.', { features: sup.problems.join(', ') }));
    await loadScript(ENGINE_SCRIPT);
    const M = await globalThis.BeamModule({
      print: (line) => onPrint(line, false),
      printErr: (line) => onPrint(line, true),
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
    guardSyncfs(M);
    await new Promise((resolve, reject) => {
      M.WasmWalletClient.MountFS((err) => (err ? reject(new EngineError('mount', t('Storage could not be opened: {reason}', { reason: String(err) }))) : resolve()));
    });
    return M;
  })();
  modulePromise.catch(() => {
    modulePromise = null;
  });
  return modulePromise;
}

// ---------------------------------------------------------------- persistence
// Flushes this page refused because another tab holds the wallet now (the e2e reads it).
export const tabGuard = { refused: 0 };

/**
 * Every FS.syncfs - this file's and the engine's own - first asks lib/one_tab.js whether this page
 * still holds the wallet (looked up in the browser's lock manager). A page that let go, or whose
 * lock was taken while it was frozen, writes nothing: its copy is older than the other tab's, and
 * IDBFS would write it over the newer files and delete the files it does not have.
 */
export function guardSyncfs(M, tab = oneTab()) {
  const FS = M && M.FS;
  if (!FS || typeof FS.syncfs !== 'function' || FS.syncfs.__oneTab) return;
  const original = FS.syncfs;
  const guarded = function syncfs(populate, callback) {
    if (typeof populate === 'function') {
      callback = populate;
      populate = false;
    }
    const done = typeof callback === 'function' ? callback : () => {};
    tab.confirmWrite().then(
      (ok) => {
        if (!ok) {
          tabGuard.refused++;
          return done(new OtherTabError('Not saved: BEAM Campfire is open in another tab.')); // i18n-ignore: a refused flush, only logged (syncFS answers true or false)
        }
        original.call(FS, populate, done);
      },
      (e) => done(e),
    );
  };
  guarded.__oneTab = true;
  FS.syncfs = guarded;
}

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

/** Saves the mount now if the engine was loaded in this page (the hand-over to another tab). */
export async function flushEngine() {
  if (!modulePromise) return true;
  let M;
  try {
    M = await modulePromise;
  } catch {
    return true;
  }
  return syncFS(M);
}

// ---------------------------------------------------------------- wallet ops
export async function walletExists(path = walletPath) {
  const M = await loadEngine();
  return Boolean(M.WasmWalletClient.IsInitialized(checkPath(path)));
}

/**
 * File names in the wallet directory, and in each wallet's folder as "<id>/<name>" (names only:
 * for the e2e and the self-test).
 */
export async function walletFiles() {
  const M = await loadEngine();
  const out = [];
  let names = [];
  try {
    names = M.FS.readdir(DB_DIR);
  } catch {
    return [];
  }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    let dir = false;
    try {
      dir = M.FS.isDir(M.FS.stat(`${DB_DIR}/${n}`).mode);
    } catch {
      /* gone */
    }
    if (!dir) {
      out.push(n);
      continue;
    }
    try {
      for (const f of M.FS.readdir(`${DB_DIR}/${n}`)) if (f !== '.' && f !== '..') out.push(`${n}/${f}`);
    } catch {
      /* gone */
    }
  }
  return out.sort();
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

export async function createWalletDb(words, dbPass, path = walletPath) {
  const M = await loadEngine();
  checkPath(path);
  if (M.WasmWalletClient.IsInitialized(path)) throw new EngineError('exists', t('A wallet already exists on this device.'));
  ensureDir(M, dirOf(path));
  try {
    M.WasmWalletClient.CreateWallet(words.join(';'), path, dbPass);
  } catch (e) {
    throw new EngineError('create', t('The wallet could not be created: {reason}', { reason: String(e && e.message) }));
  }
  if (!M.WasmWalletClient.IsInitialized(path)) throw new EngineError('create', t('The wallet could not be created.'));
  // Stored, or undone (as adoptImport): a file that did not reach IndexedDB must not get a record,
  // or after the next load the wallet is listed with nothing to open (re-audit RE1-4).
  if (!(await syncFS(M))) {
    removeWalletFiles(M.FS, path);
    await syncFS(M);
    throw new EngineError('save', t('The browser did not store it. Try again.'));
  }
}

/**
 * Removes one wallet's database and its sqlite side files, then flushes to IndexedDB. The first
 * slot's (/beam_wallet/wallet.db): every plain file in /beam_wallet, as a single-wallet version
 * did, and never a folder (each other wallet is a folder). Any other wallet's: its own folder.
 * Nothing else is touched.
 */
export async function deleteWalletDb(path = walletPath) {
  const M = await loadEngine();
  removeWalletFiles(M.FS, checkPath(path));
  await syncFS(M);
  if (M.WasmWalletClient.IsInitialized(path)) throw new EngineError('delete', t('The wallet file could not be removed.'));
}

/**
 * A first-slot wallet.db (and its sqlite side files) left without a record by an interrupted
 * setup: it cannot be opened (its database password is gone). Only those files: a staged
 * import.db beside them stays.
 */
export async function removeStrayDb() {
  const M = await loadEngine();
  let names = [];
  try {
    names = M.FS.readdir(DB_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== 'wallet.db' && !name.startsWith('wallet.db-')) continue;
    try {
      M.FS.unlink(`${DB_DIR}/${name}`);
    } catch {
      /* gone */
    }
  }
  await syncFS(M);
}

/** The file part of deleteWalletDb (an Emscripten FS, or a stand-in in the unit tests). Returns the paths removed. */
export function removeWalletFiles(FS, path) {
  checkPath(path);
  const dir = dirOf(path);
  const removed = [];
  let names = [];
  try {
    names = FS.readdir(dir);
  } catch {
    /* already gone */
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    try {
      if (FS.isDir(FS.stat(full).mode)) continue;
      FS.unlink(full);
      removed.push(full);
    } catch {
      /* not a file, or gone */
    }
  }
  if (dir !== DB_DIR) {
    try {
      FS.rmdir(dir);
      removed.push(dir);
    } catch {
      /* not there, or not empty */
    }
  }
  return removed;
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
  if (!M.WasmWalletClient.IsInitialized(IMPORT_PATH)) throw new EngineError('missing', t('No file to check.'));
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new EngineError('timeout', t('Checking the file took too long.')));
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
      reject(new EngineError('check', t('The file could not be checked.')));
    }
  });
}

/** The checked file becomes the wallet's database at `path` (the same mount: a rename), and is saved to IndexedDB. */
export async function adoptImport(path = walletPath) {
  const M = await loadEngine();
  checkPath(path);
  if (M.WasmWalletClient.IsInitialized(path)) throw new EngineError('exists', t('A wallet already exists on this device.'));
  if (!M.WasmWalletClient.IsInitialized(IMPORT_PATH)) throw new EngineError('missing', t('No file to import.'));
  removeImportFiles(M, { sideFilesOnly: true });
  ensureDir(M, dirOf(path));
  M.FS.rename(IMPORT_PATH, path);
  if (!(await syncFS(M))) {
    try {
      M.FS.unlink(path);
    } catch {
      /* not there */
    }
    if (dirOf(path) !== DB_DIR) {
      try {
        M.FS.rmdir(dirOf(path));
      } catch {
        /* not empty */
      }
    }
    await syncFS(M);
    throw new EngineError('save', t('The wallet could not be saved on this device.'));
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
export async function readWalletDb(path = walletPath) {
  const M = await loadEngine();
  if (!M.WasmWalletClient.IsInitialized(checkPath(path))) throw new EngineError('missing', t('There is no wallet on this device.'));
  return M.FS.readFile(path); // a copy
}

/** A re-keyed copy of `bytes` (opened with oldPass) that opens with newPass. */
export async function rekeyCopy(bytes, oldPass, newPass, { timeoutMs = 120000 } = {}) {
  const M = await loadEngine();
  if (typeof M.WasmWalletClient.RekeyFile !== 'function') throw new EngineError('engine', t('This engine build cannot export a wallet (it needs wasm patch 0105).'));
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
          reject(new EngineError('timeout', t('Preparing the file took too long.')));
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
        reject(new EngineError('rekey', t('The file could not be prepared.')));
      }
    });
    if (!ok) throw new EngineError('rekey', t('The file could not be prepared.'));
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
    // Wallet-data exports and imports (wasm patch 0110) the engine has not answered yet.
    this.dataCalls = 0;
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
      const e = new EngineError('rpc', m.error.message || t('wallet error')); // m.error.message: the engine's own words
      e.rpc = m.error;
      p.reject(e);
    } else p.resolve(m.result);
  }

  call(method, params, { timeoutMs = 60000 } = {}) {
    if (this.stopped) return Promise.reject(new EngineError('stopped', t('The wallet is locked.')));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError('timeout', t('The wallet did not answer ({method}).', { method })));
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
    if (this.stopped || !this.client) return Promise.reject(new EngineError('stopped', t('The wallet is locked.')));
    if (typeof this.client.exportOwnerKey !== 'function') return Promise.reject(new EngineError('engine', t('This engine build cannot show the owner key (it needs wasm patch 0106).')));
    if (!password) return Promise.reject(new EngineError('owner_key', t('Enter your password.')));
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (code, message) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new EngineError(code, message));
      };
      const timer = setTimeout(() => fail('timeout', t('The wallet did not answer. Try again.')), timeoutMs);
      try {
        this.client.exportOwnerKey(password, (key) => {
          if (done) return;
          if (typeof key !== 'string' || !key) return fail('owner_key', t('The owner key could not be read. Try again.'));
          done = true;
          clearTimeout(timer);
          resolve(key);
        });
      } catch {
        fail('owner_key', t('The owner key could not be read. Try again.'));
      }
    });
  }

  /**
   * The wallet's data as BEAM's desktop wallet and CLI export it (wasm patch 0110:
   * storage::ExportDataToJson): own addresses with their names, contacts, and every
   * transaction's parameters, as JSON text. No keys and no coins. Resolves the text.
   */
  exportData({ timeoutMs = 120000 } = {}) {
    return this.dataCall('exportData', [], timeoutMs, (r) => (typeof r === 'string' && r ? { ok: true, value: r } : { ok: false, code: 'export', message: t('The wallet data could not be read. Try again.') }));
  }

  /**
   * Brings BEAM's wallet data JSON into this wallet (wasm patch 0110:
   * storage::ImportDataFromJson). Resolves true when BEAM took every entry, false when
   * it refused one (an address of another seed stops it there; a refused transaction is
   * skipped and the rest go in). Entries already here are overwritten by BEAM: the caller
   * hands over only what is new (lib/wallet_data.js).
   */
  importData(json, { timeoutMs = 300000 } = {}) {
    if (typeof json !== 'string' || !json) return Promise.reject(new EngineError('import_data', t('Nothing to bring in.')));
    return this.dataCall('importData', [json], timeoutMs, (r) => ({ ok: true, value: r === true }));
  }

  /**
   * The same data in pages of about maxBytes (wasm patch 0111, when the engine has it): BEAM's own
   * export holds the whole file in the engine's fixed 100 MB heap at once and runs out of memory
   * past about 8 MB (lib/wallet_data.js). Page 0 carries the addresses; every page some payments.
   * Resolves the pages' JSON texts, for joinPages().
   */
  async exportDataPages({ maxBytes = 1000000, timeoutMs = 120000 } = {}) {
    const pages = [];
    let from = 0;
    for (let guard = 0; guard < 100000; guard++) {
      const { json, next } = await this.dataCall('exportDataPage', [from, maxBytes], timeoutMs, (json, next) =>
        typeof json === 'string' && json && Number.isSafeInteger(next) ? { ok: true, value: { json, next } } : { ok: false, code: 'export', message: t('The wallet data could not be read. Try again.') },
      );
      pages.push(json);
      if (next < 0) return pages;
      if (next <= from) throw new EngineError('export', t('The wallet data could not be read. Try again.'));
      from = next;
    }
    throw new EngineError('export', t('The wallet data could not be read. Try again.'));
  }

  /** Whether the engine exports in pages (wasm patch 0111). */
  get pagedExport() {
    return Boolean(this.client) && typeof this.client.exportDataPage === 'function';
  }

  /** One wasm patch 0110/0111 call: refused while the wallet is not running; settle() waits for its answer. */
  dataCall(fn, args, timeoutMs, accept) {
    if (this.stopped || !this.client) return Promise.reject(new EngineError('stopped', t('The wallet is locked.')));
    if (typeof this.client[fn] !== 'function') return Promise.reject(new EngineError('engine', t('This engine build cannot move wallet data (it needs wasm patch 0110).')));
    let running = false;
    try {
      running = this.client.isRunning();
    } catch {
      running = false;
    }
    if (!running) return Promise.reject(new EngineError('stopped', t('The wallet is not running yet. Try again in a moment.')));
    return new Promise((resolve, reject) => {
      let done = false;
      let offAbort = null;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (offAbort) offAbort();
      };
      const fail = (code, message) => {
        if (done) return;
        finish();
        reject(new EngineError(code, message));
      };
      const timer = setTimeout(() => fail('timeout', t('The wallet did not answer. Try again.')), timeoutMs);
      this.dataCalls++;
      try {
        this.client[fn](...args, (...r) => {
          this.dataCalls--;
          if (done) return;
          finish();
          const out = accept(...r);
          if (out.ok) resolve(out.value);
          else reject(new EngineError(out.code, out.message));
        });
      } catch {
        this.dataCalls--;
        fail('engine', t('The wallet could not do that. Try again.'));
        return;
      }
      // The engine ran out of memory (or stopped otherwise): it will never answer. Say so now.
      if (done) return;
      offAbort = onEngineAbort(() => {
        this.dataCalls = 0;
        fail('aborted', t('The wallet engine stopped working in this page. Reload the page; your wallet is safe.'));
      });
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new EngineError('stopped', t('The wallet is locked.')));
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
    // A wallet-data export or import (wasm patch 0110) also answers through the engine's queue.
    while ((this.inflight.size || this.dataCalls > 0) && Date.now() - t0 < timeoutMs) await tick();
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
 * rescan=true (engine patch 0107, needs `recovery`): the wallet first forgets
 * every coin, except those a payment under way is creating, and finds them
 * again from the snapshot; if the snapshot cannot be read nothing changes.
 * @returns {Promise<{session: WalletSession, imported: Promise<void>|null}>}
 */
export async function startWallet({ dbPass, node, recovery = null, onImport = null, bodyRequests = true, rescan = false, dbPath = walletPath }) {
  const M = await loadEngine();
  // Never a wallet in a page that does not hold the lock (it may have moved while the engine loaded).
  needThisTab();
  if (abortedWhy) throw new EngineError('aborted', t('The wallet engine stopped working in this page. Reload to start it again.'));
  if (!M.WasmWalletClient.IsInitialized(checkPath(dbPath))) throw new EngineError('missing', t('There is no wallet on this device.'));
  nodeGuard.setAllowed(node);
  const client = new M.WasmWalletClient(dbPath, dbPass, node);
  if (typeof client.setBodyRequests === 'function') client.setBodyRequests(Boolean(bodyRequests || recovery));
  else if (!bodyRequests && !recovery) throw new EngineError('engine', t('This engine build cannot start a wallet without scanning (needs patch 0102).'));
  if (rescan) {
    if (!recovery || typeof client.setRescan !== 'function') {
      client.delete();
      throw new EngineError('engine', recovery ? t('This engine build cannot rescan (needs patch 0107).') : t('A rescan needs the snapshot.'));
    }
    client.setRescan(true);
  }
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
          if (err) reject(new EngineError('import', t('The snapshot could not be read. Try again; if it keeps failing, skip it and let the wallet scan instead.')));
          else resolve();
        }
      });
    });
  }
  try {
    client.startWallet();
  } catch (e) {
    throw new EngineError('start', t('The wallet did not start: {reason}', { reason: String(e && e.message) }));
  }
  return { session, imported };
}
