// Narrows what an allowed method may carry before it reaches the engine.
// The same rules as the desktop's DappRequestSanitizer:
//
// - invoke_contract: contract_file and every other unknown key are dropped;
//   create_tx: true is refused with the core's own error and create_tx is
//   always sent as false, so a dApp can never start a contract transaction
//   without process_invoke_data and the person's approval. App shader bytes
//   on the privileged list (the BANS app shader) are refused.
// - sign_message: only message and key_material; key material as strict
//   even-length hex (the core stops at the first non-hex character, so
//   anything else could sign with a key other than the one checked); a
//   message with hidden characters is refused (the sheet must show exactly
//   what is signed).
// - tx_send and process_invoke_data: only the keys the approval accounts
//   for, with checked types; anything else is refused rather than silently
//   forwarded. coins (manual coin selection) is refused.
// - ev_subunsub: ev_utxos_changed and ev_assets_changed are refused, as the
//   core refuses them for apps.
// - every other method: contract_file is dropped, the rest is forwarded for
//   the core to validate.

import { RPC, RpcError, hasHiddenText } from './rpc.js';

export const DEFAULT_REQUEST_LIMITS = Object.freeze({
  maxRequestLength: 8 * 1024 * 1024,
  maxShaderBytes: 2 * 1024 * 1024,
  maxInvokeDataBytes: 2 * 1024 * 1024,
  maxArgsLength: 1024 * 1024,
  maxCommentLength: 1024,
  maxAddressLength: 4096,
  maxInFlight: 64,
  maxSignMessageLength: 4096,
  maxKeyMaterialLength: 1024,
});

/** App shaders a BEAM Campfire wallet runs at privilege 1 (the BANS app shader); never accepted from a dApp. */
export const PRIVILEGED_SHADER_SHA256 = Object.freeze(['99eb1dfb023d30c338e3c4a4c536b7695b48ca25e27f9ce5f659b6567241736d']);

const INVOKE_KEYS = new Set(['contract', 'args', 'create_tx', 'priority', 'unique']);
const PROCESS_KEYS = new Set(['data', 'confirm_comment']);
const SIGN_KEYS = new Set(['message', 'key_material']);
const SEND_KEYS = new Set(['address', 'value', 'asset_id', 'fee', 'comment', 'confirm_comment', 'from', 'txId', 'offline']);
export const EVENTS = Object.freeze(['ev_sync_progress', 'ev_system_state', 'ev_assets_changed', 'ev_addrs_changed', 'ev_utxos_changed', 'ev_txs_changed', 'ev_connection_changed']);
const EVENTS_BLOCKED_FOR_APPS = new Set(['ev_utxos_changed', 'ev_assets_changed']);
const TX_ID = /^[0-9a-fA-F]{32}$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

const params = (why) => new RpcError(RPC.invalidParams, why);
const isU32 = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const x of d) s += x.toString(16).padStart(2, '0');
  return s;
}

function bytesParam(v, key, max) {
  if (!Array.isArray(v) || v.length > max) throw params(`${key} must be a byte array of at most ${max}`);
  const out = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const b = v[i];
    if (!Number.isInteger(b) || b < 0 || b > 255) throw params(`${key} must be a byte array`);
    out[i] = b;
  }
  return out;
}

function onlyKeys(p, allowed) {
  for (const k of Object.keys(p)) if (!allowed.has(k)) throw params(`${k} is not accepted from dApps`);
}

function optText(p, key, limits) {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > limits.maxCommentLength) throw params(`${key} must be a string of at most ${limits.maxCommentLength}`);
  return v;
}

export class RequestSanitizer {
  constructor(limits = DEFAULT_REQUEST_LIMITS, privileged = PRIVILEGED_SHADER_SHA256) {
    this.limits = limits;
    this.privileged = privileged;
  }

  /** The params to forward, or throws an RpcError. */
  async sanitize(method, p) {
    switch (method) {
      case 'invoke_contract':
        return this.invokeContract(p);
      case 'process_invoke_data':
        return this.processInvokeData(p);
      case 'tx_send':
        return this.txSend(p);
      case 'ev_subunsub':
        return this.evSubUnsub(p);
      case 'sign_message':
        return this.signMessage(p);
      default: {
        const out = {};
        for (const [k, v] of Object.entries(p)) if (k !== 'contract_file') out[k] = v;
        return out;
      }
    }
  }

  async invokeContract(p) {
    const out = {};
    for (const [k, v] of Object.entries(p)) if (INVOKE_KEYS.has(k)) out[k] = v;
    const createTx = out.create_tx;
    if (createTx !== undefined && createTx !== null && typeof createTx !== 'boolean') throw params('create_tx must be a boolean');
    if (createTx === true) throw new RpcError(RPC.notAllowed, 'Applications must set create_tx to false and use process_contract_data');
    out.create_tx = false;
    if (Object.prototype.hasOwnProperty.call(out, 'contract')) {
      const shader = bytesParam(out.contract, 'contract', this.limits.maxShaderBytes);
      if (this.privileged.includes(await sha256Hex(shader))) {
        throw new RpcError(RPC.notAllowed, 'BEAM Campfire refused this request: the app shader is one BEAM Campfire reserves for its own name service. Nothing was run.');
      }
      out.contract = Array.from(shader);
    }
    const args = out.args;
    if (args !== undefined && args !== null && (typeof args !== 'string' || args.length > this.limits.maxArgsLength)) throw params(`args must be a string of at most ${this.limits.maxArgsLength}`);
    for (const k of ['priority', 'unique']) {
      const v = out[k];
      if (v !== undefined && v !== null && !isU32(v)) throw params(`${k} must be an unsigned 32-bit integer`);
    }
    return out;
  }

  async processInvokeData(p) {
    onlyKeys(p, PROCESS_KEYS);
    if (!Object.prototype.hasOwnProperty.call(p, 'data')) throw params('data is required');
    const data = bytesParam(p.data, 'data', this.limits.maxInvokeDataBytes);
    if (data.length === 0) throw params('data is empty');
    const comment = optText(p, 'confirm_comment', this.limits);
    const out = { data: Array.from(data) };
    if (comment !== undefined) out.confirm_comment = comment;
    return out;
  }

  async txSend(p) {
    if (Object.prototype.hasOwnProperty.call(p, 'coins')) throw params('coins is not accepted from dApps');
    onlyKeys(p, SEND_KEYS);
    const L = this.limits;
    const { address, value, asset_id: assetId, fee, from, txId, offline } = p;
    if (typeof address !== 'string' || address.length === 0 || address.length > L.maxAddressLength) throw params('address must be a non-empty string');
    if (!Number.isSafeInteger(value) || value <= 0) throw params('value must be a positive integer');
    if (assetId !== undefined && assetId !== null && !isU32(assetId)) throw params('asset_id must be an unsigned 32-bit integer');
    if (fee !== undefined && fee !== null && (!Number.isSafeInteger(fee) || fee <= 0)) throw params('fee must be a positive integer');
    if (from !== undefined && from !== null && (typeof from !== 'string' || from.length === 0 || from.length > L.maxAddressLength)) throw params('from must be a non-empty string');
    if (txId !== undefined && txId !== null && (typeof txId !== 'string' || !TX_ID.test(txId))) throw params('txId must be 32 hex digits');
    if (offline !== undefined && offline !== null && typeof offline !== 'boolean') throw params('offline must be a boolean');
    const comment = optText(p, 'comment', L);
    const confirm = optText(p, 'confirm_comment', L);
    const out = { address, value };
    if (assetId != null) out.asset_id = assetId;
    if (fee != null) out.fee = fee;
    if (comment !== undefined) out.comment = comment;
    if (confirm !== undefined) out.confirm_comment = confirm;
    if (from != null) out.from = from;
    if (txId != null) out.txId = txId;
    if (offline != null) out.offline = offline;
    return out;
  }

  async signMessage(p) {
    onlyKeys(p, SIGN_KEYS);
    const L = this.limits;
    const { message, key_material: key } = p;
    if (typeof message !== 'string' || message.length === 0 || message.length > L.maxSignMessageLength) throw params(`message must be a non-empty string of at most ${L.maxSignMessageLength}`);
    if (hasHiddenText(message)) throw params('message must not contain control or bidi characters');
    if (typeof key !== 'string' || key.length > L.maxKeyMaterialLength || !HEX.test(key)) throw params('key_material must be an even number of hex digits');
    return { message, key_material: key };
  }

  async evSubUnsub(p) {
    const entries = Object.entries(p);
    if (entries.length === 0) throw params('Must subunsub at least one supported event');
    for (const [k, v] of entries) {
      if (!EVENTS.includes(k)) throw params(`The event '${k}' is unknown.`);
      if (EVENTS_BLOCKED_FOR_APPS.has(k)) throw new RpcError(RPC.notAllowed);
      if (typeof v !== 'boolean') throw params(`${k} must be a boolean`);
    }
    return { ...p };
  }
}
