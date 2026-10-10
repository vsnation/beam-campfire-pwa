// The core's per-method "allowed for apps" rule, per wallet API version
// (BEAM core tag beam-7.5.14493, wallet/api/v*/v*_api_defs.h): a method the
// negotiated version does not declare is answered -32601, a declared method
// flagged APPS_BLOCKED -32020, as AppsApi::AnyThread_callWalletApiChecked
// does. BEAM's engine applies the same rule again behind this one.
// A unit test checks this table against the desktop's generated one.

import { RPC, RpcError } from './rpc.js';

const V60_ALLOWED = ['addr_list', 'block_details', 'calc_change', 'create_address', 'delete_address', 'edit_address', 'export_payment_proof', 'generate_tx_id', 'get_asset_info', 'get_confirmations_count', 'invoke_contract', 'process_invoke_data', 'tx_asset_info', 'tx_cancel', 'tx_delete', 'tx_list', 'tx_send', 'tx_status', 'validate_address', 'verify_payment_proof'];
const V60_BLOCKED = ['change_password', 'get_utxo', 'set_confirmations_count', 'swap_accept_offer', 'swap_cancel_offer', 'swap_create_offer', 'swap_decode_token', 'swap_get_balance', 'swap_offer_status', 'swap_offers_board', 'swap_offers_list', 'swap_publish_offer', 'swap_recommended_fee_rate', 'tx_asset_consume', 'tx_asset_issue', 'tx_split', 'wallet_status'];

function table(allowed, blocked) {
  const t = Object.create(null);
  for (const m of blocked) t[m] = false;
  for (const m of allowed) t[m] = true;
  return Object.freeze(t);
}

const V61_ALLOWED = [...V60_ALLOWED, 'ev_subunsub', 'get_version', 'wallet_status'];
const V61_BLOCKED = V60_BLOCKED.filter((m) => m !== 'wallet_status');
const V70_ALLOWED = [...V61_ALLOWED, 'ipfs_add', 'ipfs_gc', 'ipfs_get', 'ipfs_hash', 'ipfs_pin', 'ipfs_unpin', 'sign_message', 'verify_signature'];
const V71_ALLOWED = [...V70_ALLOWED, 'derive_id'];
const V72_BLOCKED = [...V61_BLOCKED, 'assets_swap_accept', 'assets_swap_cancel', 'assets_swap_create', 'assets_swap_offers_list'];
const V73_ALLOWED = [...V71_ALLOWED, 'assets_list'];
const V74_ALLOWED = [...V73_ALLOWED, 'read_messages', 'send_message'];

export const METHOD_TABLE = Object.freeze({
  '6.0': table(V60_ALLOWED, V60_BLOCKED),
  '6.1': table(V61_ALLOWED, V61_BLOCKED),
  '6.2': table(V61_ALLOWED, V61_BLOCKED),
  '7.0': table(V70_ALLOWED, V61_BLOCKED),
  '7.1': table(V71_ALLOWED, V61_BLOCKED),
  '7.2': table(V71_ALLOWED, V72_BLOCKED),
  '7.3': table(V73_ALLOWED, V72_BLOCKED),
  '7.4': table(V74_ALLOWED, V72_BLOCKED),
});

export const API_VERSIONS = Object.freeze(Object.keys(METHOD_TABLE));
export const CURRENT_VERSION = '7.4';

/** 'current' or 'major.minor' that this wallet serves, else null. Strict: digits and one dot only. */
export function parseApiVersion(text) {
  if (typeof text !== 'string') return null;
  if (text === 'current') return CURRENT_VERSION;
  const m = /^([0-9]{1,4})\.([0-9]{1,4})$/.exec(text);
  if (!m) return null;
  const v = `${Number(m[1])}.${Number(m[2])}`;
  return API_VERSIONS.includes(v) ? v : null;
}

/** As beam-ui and the core choose: the wanted version (current when absent) if served, else the minimum, else null. */
export function negotiateApiVersion({ wanted = null, minimum = null } = {}) {
  return parseApiVersion(wanted == null || wanted === '' ? 'current' : wanted) || parseApiVersion(minimum == null ? '' : minimum);
}

export class MethodGate {
  constructor(version) {
    if (!METHOD_TABLE[version]) throw new Error(`no method table for ${version}`);
    this.version = version;
    this.table = METHOD_TABLE[version];
  }

  allows(method) {
    return this.table[method] === true;
  }

  declares(method) {
    return Object.prototype.hasOwnProperty.call(this.table, method);
  }

  /** Throws the core's error for a method a dApp may not call. */
  check(method) {
    if (!this.declares(method)) throw new RpcError(RPC.methodNotFound, method);
    if (!this.allows(method)) throw new RpcError(RPC.notAllowed);
  }

  get allowedMethods() {
    return Object.keys(this.table).filter((m) => this.table[m]).sort();
  }
}

/** The two methods that move funds; BEAM's engine asks the person before either runs. */
export const CONSENT_METHODS = Object.freeze(['tx_send', 'process_invoke_data']);
