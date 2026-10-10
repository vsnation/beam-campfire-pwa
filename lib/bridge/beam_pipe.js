// The BEAM half of the bridge: the pipe contracts' views, and the two
// transactions that move money - `send` (BEAM wallet -> Ethereum) and
// `receive` (claim what came from Ethereum). Mirrors the desktop app
// (lib/wallets/beam/contracts/bridge/: pipe_args.dart, pipe_output.dart,
// beam_pipe_service.dart). Everything runs through the wallet's own app
// (contracts.js nativeApp) with the two pinned pipe shaders.
//
// A transaction is checked twice before anything is sent:
// 1. inspect: the raw_data the engine built is read in full and must be exactly
//    the request - one call, to this route's pipe, the right method, the packed
//    arguments byte for byte, the signatures, the funds, privilege 0, and stored
//    shader args (when present) equal to the request;
// 2. expect: what the engine then reports for the consent screen must be the
//    same amounts and exactly the bridge's network fee.
// Either mismatch refuses it (ContractError 'unexpected'): nothing is sent.
//
// Errors: a pipe that answers something that pipe does not answer (another
// contract, a shader error) is BridgeError 'badPipe'; an amount the bridge
// cannot carry is 'badAmount'; arguments that should never have been built
// (a cid that is not a registered pipe, a malformed address or id) are
// 'badArgs'. The wallet's own errors (locked, timeout, rejected...) stay
// ContractErrors.

import { nativeApp, ContractError } from '../contracts.js';
import { loadShader } from '../shaders.js';
import { decodeInvokeData } from '../dapps/invoke_data.js';
import { keyHashOf } from '../dapps/policy.js';
import { ROUTES, SEND_FEE, CLAIM_FEE } from './routes.js';

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // badPipe, badAmount, badArgs
  }
}

/** What both shaders print for a local_msg / remote_msg id that holds no message. */
export const ABSENT = 'msg with current id is absent';

const MAX_AMOUNT = (1n << 63n) - 1n;
const ZERO_ADDRESS = '0'.repeat(40);

// ---------------------------------------------------------------- args
//
// The shaders parse only `action` and never a `role` (the official apps send
// one; it is ignored), so none is sent. They read a missing number as 0 and
// parse with strtoull(.., 0), where a leading zero means octal: only canonical
// decimals are written, and every parameter an action reads is written.
//
// Only the five registered pipes are accepted as `cid`: the asset-owner
// contract beside each pipe answers get_pk with a key nobody can ever claim
// with, and four stale pipes in the forward registry still answer every action.

const PIPE_CIDS = new Set(ROUTES.map((r) => r.beamPipeCid));

function join(action, cid, params = {}) {
  if (!PIPE_CIDS.has(cid)) throw new BridgeError('badArgs', 'not one of the bridge pipes');
  return [`action=${action}`, `cid=${cid}`, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join(',');
}

function msgIdText(id, min = 0) {
  if (!Number.isSafeInteger(id) || id < min) throw new BridgeError('badArgs', `message id ${id} is not possible`);
  return String(id);
}

function positive(v, name) {
  if (typeof v !== 'bigint') throw new BridgeError('badArgs', `${name} must be a BigInt`);
  if (v <= 0n) throw new BridgeError('badArgs', `${name} must be positive`);
  if (v > MAX_AMOUNT) throw new BridgeError('badArgs', `${name} is above 2^63-1`);
  return v;
}

/** get_pk: the key the pipe pays this wallet's e2b crossings to. */
export const getPkArgs = (cid) => join('get_pk', cid);

/** local_msg_count: the b2e messages recorded so far. */
export const localMsgCountArgs = (cid) => join('local_msg_count', cid);

/** local_msg: b2e message msgId. BEAM-side ids start at 1. */
export const localMsgArgs = (cid, msgId) => join('local_msg', cid, { msgId: msgIdText(msgId, 1) });

/** remote_msg: e2b message msgId while pushed and unclaimed. The ids are the Ethereum pipe's, from 0. */
export const remoteMsgArgs = (cid, msgId) => join('remote_msg', cid, { msgId: msgIdText(msgId) });

/** view_incoming: the unclaimed e2b messages for this wallet's key, from id startFrom on. */
export const viewIncomingArgs = (cid, startFrom = null) => join('view_incoming', cid, startFrom == null ? {} : { startFrom: msgIdText(startFrom) });

/**
 * send (b2e): locks or burns amount + relayerFee groth and records a message
 * paying amount to receiver on Ethereum. receiver is 40 lowercase hex with no
 * 0x, as the official app sends it: the shader reads a raw 20-byte blob, and
 * anything else could leave part of the address unset.
 */
export function sendArgs({ cid, amount, receiver, relayerFee }) {
  if (typeof receiver !== 'string' || !/^[0-9a-f]{40}$/.test(receiver)) throw new BridgeError('badArgs', 'the receiver must be 40 lowercase hex characters, no 0x');
  positive(amount, 'amount');
  positive(relayerFee, 'relayerFee');
  // The contract adds them in 64 bits without a check: a sum past 2^64 wraps,
  // locking almost nothing for a huge payout the relayer refuses.
  if (amount + relayerFee > MAX_AMOUNT) throw new BridgeError('badArgs', 'amount + relayerFee is above 2^63-1');
  return join('send', cid, { amount: String(amount), receiver, relayerFee: String(relayerFee) });
}

/** receive (e2b claim) of pushed message msgId, signed with the key get_pk returns. */
export const receiveArgs = ({ cid, msgId }) => join('receive', cid, { msgId: msgIdText(msgId) });

// ---------------------------------------------------------------- outputs
//
// Each reads a view's output as contracts.js parsed it (integers of 16 digits
// or more arrive as digit strings). Anything that is not the shape the pipe
// prints is badPipe: an answer of the wrong shape most likely comes from the
// wrong contract, and a guess could send a crossing where nobody can claim it.

const P = (1n << 256n) - (1n << 32n) - 977n; // the secp256k1 field prime

function bad(message) {
  return new BridgeError('badPipe', message);
}

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/** A non-negative integer as an exact BigInt. */
function amountOf(o, key) {
  const v = o[key];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  // Only what parseShaderJson makes of a bare integer too large for a double.
  if (typeof v === 'string' && /^[1-9]\d{15,}$/.test(v)) return BigInt(v);
  throw bad(`${key}: expected a non-negative integer`);
}

/** A non-negative integer small enough for a JS number. */
function intOf(o, key) {
  const v = amountOf(o, key);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`${key}: ${v} is too large`);
  return Number(v);
}

function hexOf(o, key, bytes, what) {
  const v = o[key];
  if (typeof v !== 'string' || !new RegExp(`^[0-9a-f]{${2 * bytes}}$`).test(v)) throw bad(`${what}: expected ${2 * bytes} lowercase hex characters`);
  return v;
}

const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));

/**
 * Refuses (badPipe) anything that is not a BEAM public key: X[32] then a parity
 * byte 00 or 01, with X a non-zero field element that is the x of a secp256k1
 * point. A key that fails this could never sign a claim, and Ethereum would
 * still accept it in sendFunds.
 */
export function checkKey(key) {
  if (!key || key.length !== 33) throw bad(`a receive key is 33 bytes, not ${key ? key.length : 0}`);
  if (key[32] > 1) throw bad(`receive key parity byte ${key[32]}, expected 0 or 1`);
  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(key[i]);
  if (x === 0n || x >= P) throw bad('receive key X is not a field element');
  // On the curve y² = x³ + 7 exactly when x³ + 7 is a square mod p (Euler's
  // criterion); it is never 0 on secp256k1.
  const rhs = (modPow(x, 3n, P) + 7n) % P;
  if (modPow(rhs, (P - 1n) >> 1n, P) !== 1n) throw bad('receive key is not a secp256k1 point');
}

/**
 * get_pk: the 33-byte receive key. The forward shader names it `pk`, the
 * reverse one `pubkey`; each must use its own name, so a route driven by the
 * wrong shader is noticed here.
 */
export function parseReceiveKey(out, shader) {
  const name = shader === 'reverse' ? 'pubkey' : 'pk';
  if (!isObject(out) || typeof out[name] !== 'string') throw bad(`get_pk printed no "${name}"`);
  const key = bytesOf(hexOf(out, name, 33, `get_pk ${name}`));
  checkKey(key);
  return key;
}

/** local_msg_count: {"count": n}. */
export function parseCount(out) {
  if (!isObject(out)) throw bad('local_msg_count printed no object');
  return intOf(out, 'count');
}

/** local_msg: { receiver: '0x' + 40 hex, amount, relayerFee, height }. */
export function parseLocalMessage(out) {
  if (!isObject(out)) throw bad('local_msg printed no object');
  return Object.freeze({
    receiver: `0x${hexOf(out, 'receiver', 20, 'local_msg receiver')}`,
    amount: amountOf(out, 'amount'),
    relayerFee: amountOf(out, 'relayerFee'),
    height: intOf(out, 'height'),
  });
}

/** remote_msg: { amount, relayerFee, receiver: the 33-byte key it pays }. */
export function parseRemoteMessage(out) {
  if (!isObject(out)) throw bad('remote_msg printed no object');
  return Object.freeze({
    amount: amountOf(out, 'amount'),
    relayerFee: amountOf(out, 'relayerFee'),
    receiver: bytesOf(hexOf(out, 'receiver', 33, 'remote_msg receiver')),
  });
}

/**
 * view_incoming: [{ msgId, amount }]. The id is spelled MsgId by both shaders;
 * msgId and id are accepted too, but never two different ids in one entry. On
 * a contract with no pipe params (an asset-owner cid) the shader prints
 * {"incoming": ["error": "no params"]}, which is not JSON at all: that reaches
 * here as badPipe, never as an empty list (which would say "nothing to claim"
 * about a contract that cannot hold anything).
 */
export function parseIncoming(out) {
  if (!isObject(out) || !Array.isArray(out.incoming)) throw bad('view_incoming printed no "incoming" list');
  return Object.freeze(
    out.incoming.map((item) => {
      if (!isObject(item)) throw bad('view_incoming: an entry is not an object');
      let id = null;
      for (const name of ['MsgId', 'msgId', 'id']) {
        if (!(name in item)) continue;
        const v = intOf(item, name);
        if (id !== null && id !== v) throw bad('view_incoming: an entry has two different ids');
        id = v;
      }
      if (id === null) throw bad('view_incoming: an entry has no MsgId');
      return Object.freeze({ msgId: id, amount: amountOf(item, 'amount') });
    }),
  );
}

// ---------------------------------------------------------------- checks

function le64(v) {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameFunds(map, want) {
  const keys = Object.keys(want);
  return map.size === keys.length && keys.every((k) => map.get(Number(k)) === want[k]);
}

/** The args string as the key=value map the core stores it as. */
function argsMap(args) {
  const m = {};
  for (const kv of args.split(',')) {
    const i = kv.indexOf('=');
    m[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return m;
}

/**
 * The m_vSig hash of the key a pipe pays e2b crossings to: the core signs with
 * SHA-256("bvm.m.key\0" ‖ id) (bvm2.cpp DeriveKeyPreimage), and both pipe
 * shaders use the cid as the id, for get_pk and for the claim's signature alike.
 */
export const pipeKeyHash = (cid) => keyHashOf(cid);

const NOT_ASKED = 'The bridge transfer the wallet built is not the one you asked for. Nothing was sent.';

function refusal(why) {
  return { code: 'unexpected', message: NOT_ASKED, why };
}

/** The checks every pipe transaction shares: one call, to this pipe, built from exactly the request, privilege 0. */
function commonChecks(raw, route, args) {
  let data;
  try {
    data = decodeInvokeData(raw);
  } catch (e) {
    return { problem: refusal(`cannot read the built transaction: ${e && e.message}`) };
  }
  if (data.entries.length !== 1) return { problem: refusal(`${data.entries.length} contract calls, expected one`) };
  const e = data.entries[0];
  if (e.contractId !== route.beamPipeCid) return { problem: refusal(`the call targets ${e.contractId}, not the ${route.beamSymbol} pipe`) };
  if (data.appArgs) {
    const asked = argsMap(args);
    const stored = data.appArgs;
    const ok = Object.keys(stored).length === Object.keys(asked).length && Object.entries(asked).every(([k, v]) => Object.hasOwn(stored, k) && stored[k] === v);
    if (!ok) return { problem: refusal('the stored shader args differ from the request') };
  }
  if ((data.appPrivilege ?? 0) !== 0) return { problem: refusal('the stored shader would run with wallet keys') };
  return { entry: e };
}

/**
 * inspect for a send: exactly one entry, this route's pipe, its send method,
 * the 36-byte SendFunds args (receiver20 ‖ u64le amount ‖ u64le fee), no
 * signatures, amount + fee of the route's asset leaving the wallet, privilege 0,
 * stored args equal to the request. Returns null, or a refusal.
 */
export function sendInspector(route, { receiver, amount, fee, args = sendArgs({ cid: route.beamPipeCid, amount, receiver, relayerFee: fee }) }) {
  const want = new Uint8Array([...bytesOf(receiver), ...le64(amount), ...le64(fee)]);
  return (raw) => {
    const { problem, entry: e } = commonChecks(raw, route, args);
    if (problem) return problem;
    if (e.method !== route.sendMethod) return refusal(`contract method ${e.method}, expected ${route.sendMethod} (send)`);
    if (!sameBytes(e.args, want)) return refusal('send carries other arguments than receiver, amount and fee');
    if (e.signatureKeyHashes.length !== 0) return refusal(`send asks for ${e.signatureKeyHashes.length} signatures, expected none`);
    if (!sameFunds(e.spend, { [route.beamAssetId]: amount + fee })) return refusal(`send moves other funds than ${amount + fee} of asset ${route.beamAssetId}`);
    return null;
  };
}

/**
 * inspect for a claim: exactly one entry, this route's pipe, its receive
 * method, the u64le message id, exactly one signature - by the key whose hash
 * is SHA-256("bvm.m.key\0" ‖ cid) - the message's amount of the route's asset
 * arriving, privilege 0, stored args equal to the request.
 */
export function claimInspector(route, { msgId, amount, args = receiveArgs({ cid: route.beamPipeCid, msgId }) }) {
  return async (raw) => {
    const { problem, entry: e } = commonChecks(raw, route, args);
    if (problem) return problem;
    if (e.method !== route.receiveMethod) return refusal(`contract method ${e.method}, expected ${route.receiveMethod} (receive)`);
    if (!sameBytes(e.args, le64(msgId))) return refusal(`receive carries other arguments than message ${msgId}`);
    const key = await pipeKeyHash(route.beamPipeCid);
    if (e.signatureKeyHashes.length !== 1 || e.signatureKeyHashes[0] !== key) return refusal("receive is not signed with this pipe's receive key alone");
    if (!sameFunds(e.spend, { [route.beamAssetId]: -amount })) return refusal(`receive moves other funds than ${amount} of asset ${route.beamAssetId} arriving`);
    return null;
  };
}

/**
 * expect for a send: the engine reports amount + fee of the route's asset
 * leaving, nothing arriving, and a network fee of exactly 0.011 BEAM.
 */
export function sendExpectation(route, { amount, fee }) {
  return (req) => {
    if (req.kind !== 'contract') return refusal('not a contract call');
    const s = req.spends;
    if (s.length !== 1 || s[0].assetId !== route.beamAssetId || s[0].amount !== amount + fee || req.receives.length !== 0) return refusal('the wallet reports other amounts than the send');
    if (req.fee !== SEND_FEE) return refusal(`the wallet reports a fee of ${req.fee} groth, expected ${SEND_FEE}`);
    return null;
  };
}

/**
 * expect for a claim: the engine reports the message's amount of the route's
 * asset arriving, nothing leaving, and a network fee of exactly 0.121 BEAM.
 */
export function claimExpectation(route, { amount }) {
  return (req) => {
    if (req.kind !== 'contract') return refusal('not a contract call');
    const g = req.receives;
    if (g.length !== 1 || g[0].assetId !== route.beamAssetId || g[0].amount !== amount || req.spends.length !== 0) return refusal('the wallet reports other amounts than the claim');
    if (req.fee !== CLAIM_FEE) return refusal(`the wallet reports a fee of ${req.fee} groth, expected ${CLAIM_FEE}`);
    return null;
  };
}

// ---------------------------------------------------------------- the pipe

const ROUTE_FIELDS = ['beamPipeCid', 'beamAssetId', 'shader', 'shaderKey', 'sendMethod', 'receiveMethod'];

/** `route` as the registry has it; every field the BEAM side uses is compared. */
function registered(route) {
  const r = route && ROUTES.find((x) => x.id === route.id);
  if (!r || (route !== r && ROUTE_FIELDS.some((f) => route[f] !== r[f]))) throw new BridgeError('badArgs', 'not a registered bridge route');
  return r;
}

/** An Ethereum address (0x optional, any case) as 40 lowercase hex; never the zero address. */
export function ethReceiver(address) {
  const hex = typeof address === 'string' && address.startsWith('0x') ? address.slice(2) : address;
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{40}$/.test(hex)) throw new BridgeError('badArgs', 'not an Ethereum address');
  const lower = hex.toLowerCase();
  // Ethereum accepts a payout to address zero: the coins would be gone.
  if (lower === ZERO_ADDRESS) throw new BridgeError('badArgs', 'the zero address');
  return lower;
}

/** Refuses (badAmount) what the bridge cannot carry, before anything is built. */
export function checkSendAmounts(route, amount, fee) {
  const refuse = (why) => {
    throw new BridgeError('badAmount', why);
  };
  if (typeof amount !== 'bigint' || typeof fee !== 'bigint') refuse('amounts must be BigInt');
  if (amount <= 0n) refuse('nothing to move');
  // A zero fee is never relayed: the coins would stay locked on BEAM.
  if (fee <= 0n) refuse('the bridge fee must be above zero');
  if (amount + fee > MAX_AMOUNT) refuse('the amount is too large');
  if (route.maxGroth != null && (amount > route.maxGroth || fee > route.maxGroth)) refuse(`at most ${route.maxCoins} ${route.beamSymbol} per crossing`);
  if (amount % route.beamGrid !== 0n || fee % route.beamGrid !== 0n) refuse(`${route.beamSymbol} moves in steps of ${route.beamGrid} groth`);
}

function viewError(e, what) {
  if (e instanceof ContractError && e.code === 'shader') return bad(`${what}: the pipe said "${e.message}"`);
  if (e instanceof ContractError && e.code === 'unexpected') return bad(`${what}: ${e.message}`);
  return e;
}

/**
 * The bridge's BEAM side for the unlocked wallet. `open` and `load` are the
 * wallet's own app and the pinned shader loader; tests pass their own.
 */
export class BeamPipe {
  constructor({ open = nativeApp, load = loadShader, timeoutMs } = {}) {
    this.open = open;
    this.load = load;
    this.timeoutMs = timeoutMs;
  }

  async #app(r) {
    const [app, shader] = await Promise.all([this.open(), this.load(r.shaderKey)]);
    return { app, shader };
  }

  async #view(r, args, what) {
    const { app, shader } = await this.#app(r);
    try {
      return await app.view(args, shader, { timeoutMs: this.timeoutMs });
    } catch (e) {
      throw viewError(e, what);
    }
  }

  /** Like #view, but null for exactly the shaders' "absent" answer. */
  async #viewOrAbsent(r, args, what) {
    const { app, shader } = await this.#app(r);
    try {
      return await app.view(args, shader, { timeoutMs: this.timeoutMs });
    } catch (e) {
      if (e instanceof ContractError && e.code === 'shader' && e.message === ABSENT) return null;
      throw viewError(e, what);
    }
  }

  /** The 33-byte key this pipe pays this wallet's e2b crossings to. */
  async receiveKey(route) {
    const r = registered(route);
    return parseReceiveKey(await this.#view(r, getPkArgs(r.beamPipeCid), 'get_pk'), r.shader);
  }

  /** How many b2e messages the pipe has recorded. */
  async localMessageCount(route) {
    const r = registered(route);
    return parseCount(await this.#view(r, localMsgCountArgs(r.beamPipeCid), 'local_msg_count'));
  }

  /** b2e message msgId, or null when there is none. */
  async localMessage(route, msgId) {
    const r = registered(route);
    const out = await this.#viewOrAbsent(r, localMsgArgs(r.beamPipeCid, msgId), 'local_msg');
    return out === null ? null : parseLocalMessage(out);
  }

  /** e2b message msgId, or null when absent (claimed or never pushed). */
  async remoteMessage(route, msgId) {
    const r = registered(route);
    const out = await this.#viewOrAbsent(r, remoteMsgArgs(r.beamPipeCid, msgId), 'remote_msg');
    return out === null ? null : parseRemoteMessage(out);
  }

  /** The unclaimed e2b messages for this wallet's key, from startFrom on. */
  async incoming(route, { startFrom = 0 } = {}) {
    const r = registered(route);
    return parseIncoming(await this.#view(r, viewIncomingArgs(r.beamPipeCid, startFrom), 'view_incoming'));
  }

  /**
   * Moves `amount` of the route's BEAM asset to `ethReceiver` on Ethereum,
   * paying the relayer `fee` (groth, both). Built, inspected, checked against
   * the engine's report, then shown on the consent sheet. Resolves with the tx id.
   */
  async send(route, { ethReceiver: to, amount, fee, intent = null }) {
    const r = registered(route);
    const receiver = ethReceiver(to);
    checkSendAmounts(r, amount, fee);
    const args = sendArgs({ cid: r.beamPipeCid, amount, receiver, relayerFee: fee });
    return this.#transact(r, args, {
      inspect: sendInspector(r, { receiver, amount, fee, args }),
      expect: sendExpectation(r, { amount, fee }),
      intent: intent || { action: 'bridge', direction: 'toEthereum', route: r.id, amount, fee, receiver: `0x${receiver}` },
    });
  }

  /**
   * Claims e2b message `msgId`, which pays `amount` (groth) of the route's
   * asset to this wallet. Resolves with the tx id.
   */
  async claim(route, { msgId, amount, intent = null }) {
    const r = registered(route);
    if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_AMOUNT) throw new BridgeError('badAmount', `a claim of ${amount} groth is not possible`);
    const args = receiveArgs({ cid: r.beamPipeCid, msgId });
    return this.#transact(r, args, {
      inspect: claimInspector(r, { msgId, amount, args }),
      expect: claimExpectation(r, { amount }),
      intent: intent || { action: 'bridge', direction: 'toBeam', route: r.id, amount, msgId },
    });
  }

  async #transact(r, args, opts) {
    const { app, shader } = await this.#app(r);
    try {
      return await app.transact(args, shader, { ...opts, timeoutMs: this.timeoutMs });
    } catch (e) {
      // A pipe that refuses to build (a message claimed meanwhile) says so in its output.
      if (e instanceof ContractError && e.code === 'shader') throw bad(`the pipe said "${e.message}"`);
      throw e;
    }
  }
}
