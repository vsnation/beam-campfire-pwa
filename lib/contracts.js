// The one place contract calls happen: BEAM's app API on the running engine,
// and the consent every spending request needs.
//
// Why the app API: in the WebAssembly engine, invoke_contract on the wallet's
// own session answers -32005 "Feature is not supported". Contract calls go
// through client.createAppAPI(...) instead. There, invoke_contract must carry
// create_tx:false (else -32020), and any request that spends - process_invoke_data
// and tx_send - first goes to the consent handlers registered on the client.
// The engine passes those handlers the original request text; its JSON-RPC id
// tells which app asked, because every id this module sends is unique across
// all open apps.
//
// Nothing is ever approved without a presenter that answers exactly `true`.
// No presenter, a presenter that throws, a closed screen, a closed app, a lock
// or a timeout all reject.
//
// ---------------------------------------------------------------- interface
//
//   bindSession(session)        lib/wallet.js, once per unlocked session: registers
//                               the engine's two approve handlers.
//   settleApps({ timeoutMs })   lib/wallet.js, before the engine stops: refuses new calls,
//                               withdraws consents, waits for the engine to answer what apps sent.
//   unbindSession()             lib/wallet.js, before the engine stops: rejects every
//                               pending consent and call, closes every app.
//   setConsentPresenter(fn)     fn(req) -> Promise<boolean>; returns an unset function.
//   openApp({ appName, appUrl, appId, unchecked, publisher }) -> Promise<App>
//                               publisher: {key, name} of a DApp Store dApp, from the chain.
//                               appId defaults to WasmWalletClient.GenerateAppID(appName, appUrl).
//                               unchecked: a dApp installed from a file (its requests say so).
//                               The wallet's own name is reserved for nativeApp().
//   nativeApp() -> Promise<App> the wallet's own app, "BEAM Campfire" (one per session).
//   privilegedApp() -> Promise<App> the wallet's own app at privilege 1 (one per session),
//                               for BEAM names' inbox and claims only: it runs nothing but
//                               the shaders pinned in PRIVILEGED_SHADERS (see below).
//
//   App
//     .appId, .appName, .native, .closed
//     .call(method, params, { timeoutMs }) -> Promise<result>
//         Any wallet API method. Spending methods wait for consent (default timeout
//         covers it). Rejects with ContractError; the engine's error object is on .rpc.
//     .view(args, shader, { timeoutMs }) -> Promise<object>
//         invoke_contract, create_tx:false; the shader's printed JSON, parsed (large
//         integers kept exact as strings). A {"error": ...} from the shader rejects with
//         code 'shader'; a transaction in the answer rejects with code 'unexpected'.
//     .transact(args, shader, { inspect, expect, intent, timeoutMs }) -> Promise<txId>
//         invoke_contract -> raw_data -> inspect -> process_invoke_data -> consent -> the tx id.
//         inspect(bytes, output) reads the built transaction (a copy of raw_data,
//         Uint8Array) and the shader's parsed output before the engine sees it again;
//         it returns null/undefined to let it on, or { code, message } (or throws) to
//         refuse it, and then nothing reaches process_invoke_data. expect(req) may
//         return { code, message } to refuse a request that is not what the caller asked
//         for (it is then rejected without being shown); intent is a hint for the
//         consent screen ({ action: 'swap', ... }) and only native apps may set it.
//     .onEvent(fn) -> unsubscribe     ev_* notifications this app subscribed to.
//     .close()
//
//   ConsentRequest (what a presenter receives)
//     { id, kind: 'contract' | 'send', appId, appName, native, unchecked, comment,
//       fee: bigint (groth), feeText, isEnough: boolean,
//       spends:   [{ assetId, amount: bigint (groth), amountText }],   leave the wallet
//       receives: [{ assetId, amount: bigint (groth), amountText }],   arrive in it
//       address (send only), isOnline (send only), intent (native only, or null),
//       signal: AbortSignal (aborted when the request is withdrawn: close the screen) }
//     Every asset has 8 decimals; amountText is the engine's own decimal string.
//
//   ContractError { code, message, rpc }
//     codes: no_wallet, locked, closed, open, reserved_name (an app or publisher name that reads
//     as the wallet's own), timeout, rpc, rejected (the person said
//     no), privileged (the engine refused invoke data that would re-run app code at a
//     privilege this app was not given: wasm patch 0112), shader, unexpected, busy (the engine
//     was still running another shader call of this app), plus whatever an expect() refusal names.
//
//   One shader call at a time per app (release audit RE3-3): the engine runs one invoke_contract
//   per app API and refuses a second while the first runs (v6_api_handle.cpp, "Previous shader call
//   is still in progress"). So App.call sends an app's invoke_contract only after its previous one
//   was answered; other methods go at once. Should the engine still refuse (a call that timed out
//   here but runs on there), the refusal is 'busy', in plain words.

import { SHADERS } from './shaders.js';
import { canonical } from './lookalike.js';
import { decodeInvokeData, FLAG_DEPENDENT, FLAG_SAVE_APP_INVOKE, FLAG_SAVE_SPEND_MAX } from './dapps/invoke_data.js';

export const NATIVE_APP_NAME = 'BEAM Campfire';
const NATIVE_APP_URL = 'campfire:native';
const PRIVILEGED_APP_URL = 'campfire:native-privileged';

// Privilege 1. BEAM names' inbox and claims (role=user view, receive_all, receive
// with a one-time key) derive keys from the wallet's master key (get_PkEx,
// get_BlindSk; bvm2.cpp). At privilege 0, the engine's default for an app, they
// fail with "Contract call failed ... get_PkEx". The engine opens an app at a
// chosen privilege (WasmWalletClient.createAppAPI(apiver, minapiver, appid,
// appname, cb, privilege), upstream wasmclient.cpp), and at 1 they run. Privilege
// 1 lets a shader derive any key this wallet's apps use, so that app runs only
// the shaders pinned here, by the SHA-256 of their exact bytes: never a dApp's
// (dApps always get privilege 0, and lib/dapps/sanitizer.js refuses these shaders
// from them). And it never sends invoke data the engine could re-run later (a
// stored app body, a dependent or multisigned call): what it signs is what was read.
export const PRIVILEGED_SHADERS = Object.freeze([SHADERS.bans.sha256]);
const INTERNAL = Symbol('contracts.internal');
export const CONSENT_TIMEOUT_MS = 10 * 60000;
const CALL_TIMEOUT_MS = 60000;
const OPEN_TIMEOUT_MS = 20000;
const RELEASE_AFTER_MS = 120000;
const SPEND_METHODS = new Set(['process_invoke_data', 'tx_send']);
const USER_REJECTED = -32021;
const CONTRACT_FAILED = -32019;
// The engine's refusal of a second shader call while one runs (ApiError::UnexpectedError, its data).
const UNEXPECTED_CALL = -32017;
export const ENGINE_SHADER_BUSY = 'Previous shader call is still in progress';
export const SHADER_BUSY_TEXT = 'BEAM Campfire is busy with another check. Try again in a moment.';
// The engine's refusal of invoke data asking to re-run app code at a privilege the app that
// sends it was not given (wasm patch 0112; core patch 0002 sends the same text in wallet-api).
// lib/dapps/policy.js refuses such data before anyone is asked; this is the engine's own line.
export const ENGINE_PRIVILEGE_REFUSAL = 'invoke data requests a shader privilege that was not granted';
const PRIVILEGE_REFUSED_TEXT = 'BEAM Campfire refused this request: it asks the wallet to run app code with extra privileges. Nothing was sent.';
const LOG_MAX = 20;

const shaderHashes = new WeakMap();

/** SHA-256 (hex) of a shader's bytes, once per byte array. */
function shaderHash(shader) {
  const arr = shaderArray(shader);
  let p = shaderHashes.get(arr);
  if (!p) {
    p = globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(arr)).then((d) => Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''));
    shaderHashes.set(arr, p);
  }
  return p;
}

export class ContractError extends Error {
  constructor(code, message, rpc = null) {
    super(message);
    this.code = code;
    this.rpc = rpc;
  }
}

let bound = null;
let presenter = null;
let presenting = Promise.resolve();
const outcomes = [];

// ---------------------------------------------------------------- parsing

const DEC = /^(\d+)(?:\.(\d{1,8}))?$/;

/** The engine's decimal text ("0.011", "371.76133894") as groth. */
export function decimalToGroth(text) {
  const m = DEC.exec(String(text).trim());
  if (!m) throw new ContractError('unexpected', `Unreadable amount from the wallet: ${String(text).slice(0, 32)}`);
  return BigInt(m[1]) * 100000000n + BigInt((m[2] || '').padEnd(8, '0') || '0');
}

/** The leading decimal of a printed amount ("0.5", "0.5 BEAM"). */
function leadingDecimal(text) {
  const m = /^\s*(\d+(?:\.\d{1,8})?)(?!\d)/.exec(String(text));
  if (!m) throw new ContractError('unexpected', 'Unreadable amount from the wallet.');
  return m[1];
}

/**
 * JSON.parse that keeps integers too large for a double exact (as strings).
 * Shaders print reserves and amounts as bare numbers.
 */
export function parseShaderJson(text) {
  const quoted = String(text).replace(/("(?:[^"\\]|\\.)*")|(?<![\w.])(-?\d{16,})(?=\s*[,}\]])/g, (m, str, big) => (str ? str : `"${big}"`));
  return JSON.parse(quoted);
}

function shaderOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return {};
  let o;
  try {
    o = parseShaderJson(output);
  } catch {
    throw new ContractError('unexpected', 'The contract answered something unreadable.');
  }
  if (o && typeof o === 'object' && 'error' in o) throw new ContractError('shader', String(o.error));
  return o;
}

/** What the engine reported, as a ConsentRequest (without signal). Throws on anything unreadable. */
export function consentRequest(kind, app, rpcId, infoText, amountsText, intent = null) {
  const info = JSON.parse(infoText);
  if (!info || typeof info !== 'object') throw new ContractError('unexpected', 'no consent info');
  const fee = decimalToGroth(info.fee);
  const spends = [];
  const receives = [];
  if (kind === 'contract') {
    const amounts = JSON.parse(amountsText);
    if (!Array.isArray(amounts)) throw new ContractError('unexpected', 'no consent amounts');
    for (const a of amounts) {
      const assetId = Number(a.assetID);
      if (!Number.isInteger(assetId) || assetId < 0 || assetId > 0xffffffff) throw new ContractError('unexpected', 'bad asset id');
      const amountText = String(a.amount);
      const entry = { assetId, amount: decimalToGroth(amountText), amountText };
      (a.spend === true ? spends : receives).push(entry);
    }
  } else {
    const assetId = Number(info.assetID ?? 0);
    if (!Number.isInteger(assetId) || assetId < 0) throw new ContractError('unexpected', 'bad asset id');
    const amountText = leadingDecimal(info.amount);
    spends.push({ assetId, amount: decimalToGroth(amountText), amountText });
  }
  return {
    id: rpcId,
    kind,
    appId: app.appId,
    appName: app.appName,
    native: app.native,
    unchecked: app.unchecked === true,
    publisher: app.publisher || null,
    comment: typeof info.comment === 'string' ? info.comment.slice(0, 200) : '',
    fee,
    feeText: String(info.fee),
    isEnough: info.isEnough === true,
    spends,
    receives,
    address: kind === 'send' && typeof info.token === 'string' ? info.token : null,
    isOnline: kind === 'send' ? info.isOnline !== false : null,
    intent: app.native ? intent : null,
  };
}

const asBytes = new WeakMap();
function shaderArray(shader) {
  if (Array.isArray(shader)) return shader;
  if (shader instanceof Uint8Array) {
    let a = asBytes.get(shader);
    if (!a) {
      a = Array.from(shader);
      asBytes.set(shader, a);
    }
    return a;
  }
  throw new ContractError('unexpected', 'A shader must be bytes.');
}

/**
 * Runs a caller's check of a built transaction and the shader's answer. The bytes
 * it reads are the bytes process_invoke_data sends: anything that is not a byte
 * is refused first.
 */
async function inspected(raw, inspect, output) {
  if (!raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new ContractError('unexpected', 'The wallet built an unreadable transaction. Nothing was sent.');
  let problem = null;
  try {
    problem = await inspect(Uint8Array.from(raw), output);
  } catch (e) {
    problem = { code: 'unexpected', message: (e && e.message) || 'This transaction is not what was asked for. Nothing was sent.' };
  }
  if (!problem) return;
  if (typeof problem === 'string') problem = { code: 'refused', message: problem };
  throw new ContractError(problem.code || 'refused', problem.message || 'This transaction was refused. Nothing was sent.');
}

/**
 * What the privileged app sends must be exactly what was read: no app body stored
 * for the engine to re-run later at the privilege it names (contract_transaction.cpp
 * rebuilds dependent calls from it), no dependent, multisigned or unreadable call.
 */
function notRebuildable(raw) {
  let d;
  try {
    d = decodeInvokeData(raw, { allowAdvanced: true });
  } catch {
    throw new ContractError('unexpected', 'The wallet built a transaction it cannot fully read. Nothing was sent.');
  }
  const stored = d.appPrivilege !== null || d.spendMax !== null;
  const later = d.entries.some((e) => e.flags & (FLAG_DEPENDENT | FLAG_SAVE_APP_INVOKE | FLAG_SAVE_SPEND_MAX));
  if (stored || later) throw new ContractError('unexpected', 'The wallet built a transaction it could change after approval. Nothing was sent.');
}

// ---------------------------------------------------------------- apps

class App {
  constructor(b, api, appId, appName, native, privilege = 0) {
    this.b = b;
    this.api = api;
    this.appId = appId;
    this.appName = appName;
    this.native = native;
    this.privilege = privilege;
    this.closed = false;
    this.key = ++b.seq;
    this.n = 0;
    this.pending = new Map();
    this.listeners = new Set();
    // Ids sent to the engine that it has not answered yet, kept after close (see close()).
    this.unanswered = new Set();
    // The last invoke_contract of this app, answered or not: the next one waits for it (RE3-3).
    this.shaderTurn = Promise.resolve();
    this.releaseWhenDrained = null;
    api.setHandler((s) => this.onMessage(s));
  }

  onMessage(s) {
    let m;
    try {
      m = JSON.parse(s);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const isEvent = typeof m.id === 'string' && m.id.startsWith('ev_');
    if (!isEvent) this.unanswered.delete(m.id);
    if (this.closed) {
      if (this.releaseWhenDrained && this.unanswered.size === 0) this.releaseWhenDrained();
      return;
    }
    if (isEvent) {
      for (const fn of this.listeners) {
        try {
          fn(m.id, m.result);
        } catch (e) {
          console.error(e);
        }
      }
      return;
    }
    const entry = this.pending.get(m.id);
    if (!entry) return;
    this.finish(m.id, entry);
    if (m.error) {
      const code = Number(m.error.code);
      if (code === USER_REJECTED && entry.refusal) entry.reject(new ContractError(entry.refusal.code || 'refused', entry.refusal.message || 'This request was refused.', m.error));
      else if (code === USER_REJECTED) entry.reject(new ContractError('rejected', 'Cancelled. Nothing was sent.', m.error));
      else if (code === CONTRACT_FAILED && typeof m.error.data === 'string' && m.error.data.startsWith(ENGINE_PRIVILEGE_REFUSAL)) entry.reject(new ContractError('privileged', PRIVILEGE_REFUSED_TEXT, m.error));
      else if (code === UNEXPECTED_CALL && typeof m.error.data === 'string' && m.error.data.startsWith(ENGINE_SHADER_BUSY)) entry.reject(new ContractError('busy', SHADER_BUSY_TEXT, m.error));
      else entry.reject(new ContractError('rpc', String(m.error.message || 'The wallet refused the request.'), m.error));
    } else entry.resolve(m.result);
  }

  finish(id, entry) {
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.b.inflight.delete(id);
  }

  /**
   * Any wallet API method through this app. An invoke_contract waits until this app's previous one
   * was answered (the engine runs one at a time per app, RE3-3). Its timeout covers the wait too: a
   * call whose time runs out in the queue rejects then and is never sent.
   */
  call(method, params, opts = {}) {
    if (method !== 'invoke_contract') return this.send(method, params, opts);
    const ms = opts.timeoutMs || CALL_TIMEOUT_MS;
    const deadline = Date.now() + ms;
    const run = this.shaderTurn.then(() => {
      const left = deadline - Date.now();
      if (left <= 0) throw new ContractError('timeout', 'The wallet did not answer in time.');
      return this.send(method, params, { ...opts, timeoutMs: left });
    });
    this.shaderTurn = run.then(
      () => {},
      () => {},
    );
    let timer = null;
    const outOfTime = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ContractError('timeout', 'The wallet did not answer in time.')), ms);
    });
    return Promise.race([run, outOfTime]).finally(() => clearTimeout(timer));
  }

  /** Sends one request now (call() decides when). */
  send(method, params, { timeoutMs = null, expect = null, intent = null, [INTERNAL]: internal = false } = {}) {
    if (this.closed) return Promise.reject(new ContractError(bound === this.b ? 'closed' : 'locked', bound === this.b ? 'This app was closed.' : 'The wallet is locked.'));
    if (this.b.closing) return Promise.reject(new ContractError('locked', 'The wallet is locked.'));
    // The privileged app takes only what view() and transact() send, after their checks.
    if (this.privilege && !internal) return Promise.reject(new ContractError('unexpected', 'This part of the wallet only runs BEAM names. Nothing was sent.'));
    const spend = SPEND_METHODS.has(method);
    const ms = timeoutMs || (spend ? CONSENT_TIMEOUT_MS + 60000 : CALL_TIMEOUT_MS);
    const id = `cf${this.key}.${++this.n}`;
    return new Promise((resolve, reject) => {
      const entry = { app: this, id, method, resolve, reject, expect, intent, refusal: null, timer: null };
      entry.timer = setTimeout(() => {
        this.finish(id, entry);
        reject(new ContractError('timeout', 'The wallet did not answer in time.'));
      }, ms);
      this.pending.set(id, entry);
      this.b.inflight.set(id, entry);
      const req = { jsonrpc: '2.0', id, method };
      if (params !== undefined) req.params = params;
      try {
        this.api.callWalletApi(JSON.stringify(req));
        this.unanswered.add(id);
      } catch (e) {
        this.finish(id, entry);
        reject(new ContractError('rpc', String((e && e.message) || e)));
      }
    });
  }

  /** On the privileged app: refuses any shader but the pinned ones, before the engine sees it. */
  async allowed(shader) {
    if (!this.privilege) return;
    if (!PRIVILEGED_SHADERS.includes(await shaderHash(shader))) throw new ContractError('unexpected', 'This part of the wallet only runs BEAM names. Nothing was sent.');
  }

  /** A read-only contract call: the shader's output, parsed. */
  async view(args, shader, { timeoutMs } = {}) {
    await this.allowed(shader);
    const r = await this.call('invoke_contract', { args: String(args), contract: shaderArray(shader), create_tx: false }, { timeoutMs, [INTERNAL]: true });
    if (r && Array.isArray(r.raw_data) && r.raw_data.length) throw new ContractError('unexpected', 'A read-only call produced a transaction.');
    return shaderOutput(r && r.output);
  }

  /** Builds the transaction, asks for consent, sends it. Resolves with the tx id. */
  async transact(args, shader, { inspect = null, expect = null, intent = null, timeoutMs } = {}) {
    await this.allowed(shader);
    const r = await this.call('invoke_contract', { args: String(args), contract: shaderArray(shader), create_tx: false }, { timeoutMs, [INTERNAL]: true });
    const output = shaderOutput(r && r.output);
    const raw = r && r.raw_data;
    if (!Array.isArray(raw) || raw.length === 0) throw new ContractError('unexpected', 'The contract built no transaction.');
    if (this.privilege) notRebuildable(raw);
    if (inspect) await inspected(raw, inspect, output);
    const done = await this.call('process_invoke_data', { data: raw }, { expect, intent, [INTERNAL]: true });
    const txId = done && (done.txid || done.txId);
    if (typeof txId !== 'string' || !/^[0-9a-f]{32}$/i.test(txId)) throw new ContractError('unexpected', 'The wallet did not return a transaction id.');
    return txId;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(code = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const c of [...this.b.consents]) if (c.app === this) c.withdraw('closed');
    for (const [id, entry] of [...this.pending]) {
      this.finish(id, entry);
      entry.reject(new ContractError(code, code === 'locked' ? 'The wallet is locked.' : 'This app was closed.'));
    }
    this.listeners.clear();
    this.b.apps.delete(this);
    if (this.native && !this.privilege && this.b.native) this.b.native = null;
    if (this.privilege && this.b.privileged) this.b.privileged = null;
    // Deleting an app API while the engine still runs a request sent through it
    // can leave the engine unable to open the next app (measured: after the BEAM
    // NFT Gallery dApp closed mid-load, createAppAPI stopped answering). So the
    // handle is released once the engine has answered everything sent through
    // it, or after two minutes; a session that is ending releases at once.
    const release = () => {
      if (this.released) return;
      this.released = true;
      clearTimeout(this.releaseTimer);
      this.releaseWhenDrained = null;
      this.b.draining.delete(this);
      try {
        this.api.setHandler(() => {});
      } catch {
        /* engine already gone */
      }
      try {
        this.api.delete();
      } catch {
        /* embind handle already released */
      }
    };
    if (code === 'locked' || this.unanswered.size === 0) return release();
    this.releaseWhenDrained = release;
    this.releaseTimer = setTimeout(release, RELEASE_AFTER_MS);
    this.b.draining.add(this);
  }
}

// ---------------------------------------------------------------- consent

function record(o) {
  outcomes.push({ at: Date.now(), ...o });
  if (outcomes.length > LOG_MAX) outcomes.splice(0, outcomes.length - LOG_MAX);
}

function summary(req) {
  if (!req) return {};
  const amt = (l) => l.map((a) => ({ assetId: a.assetId, amount: a.amountText }));
  return { kind: req.kind, appName: req.appName, fee: req.feeText, isEnough: req.isEnough, spends: amt(req.spends), receives: amt(req.receives) };
}

function onConsent(b, kind, request, infoText, amountsText, cb) {
  let decided = false;
  let timer = null;
  let pending = null;
  let req = null;
  const decide = (ok, why) => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    if (pending) b.consents.delete(pending);
    const approve = ok === true && bound === b && !(pending && pending.ctl.signal.aborted);
    record({ decision: approve ? 'approved' : why === 'refused' ? 'refused' : 'rejected', why: approve ? null : why || 'declined', ...summary(req) });
    try {
      if (kind === 'contract') {
        if (approve) cb.contractInfoApproved(request);
        else cb.contractInfoRejected(request);
      } else if (approve) cb.sendApproved(request);
      else cb.sendRejected(request);
    } catch (e) {
      console.warn('[campfire] consent answer failed', e && e.message);
    }
    try {
      cb.delete();
    } catch {
      /* embind handle already released */
    }
  };

  if (bound !== b || b.closing) return decide(false, 'locked');
  let rpcId;
  try {
    rpcId = JSON.parse(request).id;
  } catch {
    return decide(false, 'unreadable');
  }
  const entry = b.inflight.get(rpcId);
  if (!entry || entry.app.closed) return decide(false, 'unknown');
  if (kind === 'contract' ? entry.method !== 'process_invoke_data' : entry.method !== 'tx_send') return decide(false, 'unexpected');
  try {
    req = consentRequest(kind, entry.app, rpcId, infoText, amountsText, entry.intent);
  } catch {
    return decide(false, 'unreadable');
  }
  if (entry.expect) {
    let problem = null;
    try {
      problem = entry.expect(req);
    } catch (e) {
      problem = { code: 'unexpected', message: (e && e.message) || 'This request is not what was asked for.' };
    }
    if (problem) {
      entry.refusal = typeof problem === 'string' ? { code: 'refused', message: problem } : problem;
      return decide(false, 'refused');
    }
  }
  const ctl = new AbortController();
  req.signal = ctl.signal;
  pending = {
    app: entry.app,
    ctl,
    withdraw(why) {
      if (!ctl.signal.aborted) ctl.abort();
      decide(false, why);
    },
  };
  b.consents.add(pending);
  timer = setTimeout(() => pending.withdraw('timeout'), CONSENT_TIMEOUT_MS);
  // One consent on screen at a time. A withdrawn request frees the queue at
  // once, whether or not its screen ever answers.
  const withdrawn = new Promise((resolve) => ctl.signal.addEventListener('abort', () => resolve(false), { once: true }));
  presenting = presenting.then(async () => {
    if (decided) return;
    let ok = false;
    const fn = presenter;
    try {
      ok = fn ? (await Promise.race([Promise.resolve().then(() => fn(req)), withdrawn])) === true : false;
    } catch (e) {
      console.warn('[campfire] consent screen failed', e && e.message);
      ok = false;
    }
    decide(ok, fn ? 'declined' : 'no_presenter');
  });
}

// ---------------------------------------------------------------- session

/** Registers the engine's approve handlers for this unlocked session (once). */
export function bindSession(session) {
  if (!session || !session.client) throw new ContractError('no_wallet', 'The wallet is not running.');
  if (bound && bound.session === session) return;
  if (bound) unbindSession();
  const b = { session, client: session.client, M: session.M, apps: new Set(), draining: new Set(), inflight: new Map(), consents: new Set(), native: null, privileged: null, opening: Promise.resolve(), seq: 0 };
  bound = b;
  b.client.setApproveContractInfoHandler((request, info, amounts, cb) => onConsent(b, 'contract', request, info, amounts, cb));
  b.client.setApproveSendHandler((request, info, cb) => onConsent(b, 'send', request, info, null, cb));
}

/**
 * Before the engine stops (lib/wallet.js stop): new calls through any app are refused, every
 * pending consent is withdrawn, and this waits, at most timeoutMs, until the engine has answered
 * every request already sent through an app. unbindSession() then releases the apps' handles.
 * Releasing a handle while the engine still ran a request through it (a lock half a second after
 * typing an amount on Swap or a pool, its quote in flight) made the engine's answer reach a freed
 * handle - "Cannot read properties of undefined (reading 'refcount')" - and the next unlock never
 * synced (measured: 1 lock in 4).
 */
export async function settleApps({ timeoutMs = 5000 } = {}) {
  const b = bound;
  if (!b) return;
  b.closing = true;
  for (const c of [...b.consents]) c.withdraw('locked');
  const busy = () => [...b.apps, ...b.draining].some((a) => a.unanswered.size > 0);
  const t0 = Date.now();
  while (bound === b && busy() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 20));
}

/** Before the engine stops: every pending consent is rejected, every app closed. */
export function unbindSession() {
  const b = bound;
  if (!b) return;
  for (const c of [...b.consents]) c.withdraw('locked');
  bound = null;
  for (const app of [...b.apps]) app.close('locked');
  for (const app of [...b.draining]) if (app.releaseWhenDrained) app.releaseWhenDrained();
  for (const fn of ['setApproveContractInfoHandler', 'setApproveSendHandler']) {
    try {
      b.client[fn](null);
    } catch {
      /* engine already gone */
    }
  }
}

/** Plugs in the consent screen. Returns a function that unplugs it. */
export function setConsentPresenter(fn) {
  presenter = typeof fn === 'function' ? fn : null;
  const mine = presenter;
  return () => {
    if (presenter === mine) presenter = null;
  };
}

/** Whether a and b differ by at most one letter added, dropped, changed, or two neighbours swapped. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * A name that reads as the wallet's own, however it is spelt: accents, Cyrillic or Greek
 * letters, digits for letters, other spacing, or with words around it ("BEAM Campfire
 * Security"); and any spelling one edit from it, anywhere in the name (audit BC-5: a look-alike
 * the skeleton does not know, such as "ſ", reads as another letter or drops out). The approve
 * sheet and the notifications show an app's and a publisher's name.
 */
const NATIVE_KEY = canonical(NATIVE_APP_NAME);
export function readsAsWallet(name) {
  const c = canonical(String(name || ''));
  if (c.includes(NATIVE_KEY)) return true;
  for (let len = NATIVE_KEY.length - 1; len <= NATIVE_KEY.length + 1; len++) {
    for (let i = 0; i + len <= c.length; i++) if (withinOneEdit(c.slice(i, i + len), NATIVE_KEY)) return true;
  }
  return false;
}

function cleanName(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 64);
}

async function open({ appName, appUrl = '', appId = null, unchecked = false, publisher = null }, native, privilege = 0) {
  const b = bound;
  if (!b) throw new ContractError('no_wallet', 'Unlock the wallet first.');
  if (b.closing) throw new ContractError('locked', 'The wallet is locked.');
  const name = cleanName(appName);
  if (!name) throw new ContractError('open', 'An app needs a name.');
  if (!native && readsAsWallet(name)) throw new ContractError('reserved_name', "Its name reads like BEAM Campfire's own, so its requests could pass for the wallet's.");
  if (!native && publisher && readsAsWallet(publisher.name)) throw new ContractError('reserved_name', "Its publisher's name reads like BEAM Campfire's own, so its requests could pass for the wallet's.");
  const id = appId || b.M.WasmWalletClient.GenerateAppID(name, String(appUrl || ''));
  // One app is opened at a time: with two createAppAPI calls in flight at once, at any privilege,
  // the engine stops the page (measured 2026-10-11: two dApps, or the wallet's two apps, opened
  // together; nothing answered again). The next one waits for this one's answer or its timeout.
  const turn = b.opening;
  let release;
  b.opening = new Promise((r) => {
    release = r;
  });
  await turn;
  if (bound !== b) {
    release();
    throw new ContractError('locked', 'The wallet is locked.');
  }
  const api = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ContractError('timeout', 'The wallet did not open the app in time.')), OPEN_TIMEOUT_MS);
    try {
      const done = (err, a) => {
        clearTimeout(t);
        if (err || !a) reject(new ContractError('open', `The app could not be opened: ${err || 'no api'}`));
        else resolve(a);
      };
      if (privilege) b.client.createAppAPI('current', 'current', id, name, done, privilege);
      else b.client.createAppAPI(id, name, done);
    } catch (e) {
      clearTimeout(t);
      reject(new ContractError('open', `The app could not be opened: ${(e && e.message) || e}`));
    }
  }).finally(() => release());
  if (bound !== b) {
    try {
      api.delete();
    } catch {
      /* gone */
    }
    throw new ContractError('locked', 'The wallet is locked.');
  }
  const app = new App(b, api, id, name, native, privilege);
  // Installed from a file: BEAM Campfire did not check it, and the approve sheet says so.
  app.unchecked = unchecked === true && !native;
  // From BEAM's DApp Store: the publisher the chain names (its name and key), never the dApp's own text.
  app.publisher = !native && publisher && /^[0-9a-f]{66}$/.test(publisher.key) ? { key: publisher.key, name: cleanName(publisher.name || '') || 'Unnamed publisher' } : null;
  b.apps.add(app);
  return app;
}

/** Opens an app (a dApp, or a wallet feature) on the running engine. */
export function openApp(opts = {}) {
  return open(opts, false);
}

/** The wallet's own app, shared by its native features for this session. */
export function nativeApp() {
  const b = bound;
  if (!b) return Promise.reject(new ContractError('no_wallet', 'Unlock the wallet first.'));
  if (!b.native) {
    b.native = open({ appName: NATIVE_APP_NAME, appUrl: NATIVE_APP_URL }, true);
    b.native.catch(() => {
      if (b.native) b.native = null;
    });
  }
  return b.native.then((app) => {
    if (app.closed) {
      b.native = null;
      return nativeApp();
    }
    return app;
  });
}

/**
 * The wallet's own app at privilege 1, for BEAM names' inbox and claims. It runs only
 * the shaders in PRIVILEGED_SHADERS; on an engine that cannot open it, it rejects
 * with code 'open'. Shown on the approve sheet as the wallet itself.
 */
export function privilegedApp() {
  const b = bound;
  if (!b) return Promise.reject(new ContractError('no_wallet', 'Unlock the wallet first.'));
  if (!b.privileged) {
    b.privileged = open({ appName: NATIVE_APP_NAME, appUrl: PRIVILEGED_APP_URL }, true, 1);
    b.privileged.catch(() => {
      if (b.privileged) b.privileged = null;
    });
  }
  return b.privileged.then((app) => {
    if (app.closed) {
      b.privileged = null;
      return privilegedApp();
    }
    return app;
  });
}

/** Read-only, for the e2e harness: the last consent decisions (no secrets). */
export function consentLog() {
  return outcomes.map((o) => ({ ...o }));
}

/** Read-only state, for tests. */
export function contractsState() {
  return { bound: Boolean(bound), apps: bound ? bound.apps.size : 0, inflight: bound ? bound.inflight.size : 0, consents: bound ? bound.consents.size : 0, presenter: Boolean(presenter) };
}
