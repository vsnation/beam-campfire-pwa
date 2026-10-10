// JSON-RPC between a dApp and the wallet: parsing a dApp's request the way
// BEAM's core does, and the core's own error codes and messages, so dApps
// written for the desktop and mobile wallets recognise them.

export const RPC = Object.freeze({
  invalidJsonRpc: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  invalidAddress: -32003,
  throttle: -32014,
  notAllowed: -32020,
  userRejected: -32021,
});

const MESSAGES = {
  [-32600]: 'Invalid JSON-RPC.',
  [-32601]: 'Procedure not found.',
  [-32602]: 'Invalid parameters.',
  [-32603]: 'Internal JSON-RPC error.',
  [-32003]: 'Invalid address.',
  [-32014]: 'Requests limit exceeded',
  [-32020]: 'Call is not allowed',
  [-32021]: 'Call is rejected by user',
};

export class RpcError extends Error {
  constructor(code, data = undefined) {
    super(MESSAGES[code] || MESSAGES[-32603]);
    this.code = code;
    this.data = data;
  }
}

/** A request that failed before its id was known (or with it). */
export class RpcFailure extends Error {
  constructor(id, error) {
    super(error.message);
    this.id = id;
    this.error = error;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parses one request string. Params that are not an object are no params,
 * as in the core (it reads named params with find()).
 * @returns {{id: number|string, method: string, params: object}}
 */
export function parseRequest(text, { maxLength = 8 * 1024 * 1024 } = {}) {
  if (typeof text !== 'string' || text.length === 0) throw new RpcFailure(null, new RpcError(RPC.invalidJsonRpc, 'Empty request'));
  if (text.length > maxLength) throw new RpcFailure(null, new RpcError(RPC.invalidJsonRpc, `Request larger than ${maxLength} characters`));
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RpcFailure(null, new RpcError(RPC.invalidJsonRpc, 'Malformed JSON'));
  }
  if (!isPlainObject(json)) throw new RpcFailure(null, new RpcError(RPC.invalidJsonRpc, 'Not an object'));
  const id = json.id;
  if (!(typeof id === 'string' || Number.isSafeInteger(id))) throw new RpcFailure(null, new RpcError(RPC.invalidJsonRpc, 'ID can be integer or string only.'));
  if (json.jsonrpc !== '2.0') throw new RpcFailure(id, new RpcError(RPC.invalidJsonRpc, 'Invalid JSON-RPC 2.0 header.'));
  const method = json.method;
  if (typeof method !== 'string' || method.length === 0 || method.length > 64) throw new RpcFailure(id, new RpcError(RPC.invalidJsonRpc, 'Missing method'));
  return { id, method, params: isPlainObject(json.params) ? json.params : {} };
}

export function resultResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
}

export function errorResponse(id, e) {
  const err = { code: e.code, message: e.message };
  if (e.data !== undefined && e.data !== null) err.data = e.data;
  const out = { jsonrpc: '2.0' };
  if (typeof id === 'string' || Number.isSafeInteger(id)) out.id = id;
  out.error = err;
  return JSON.stringify(out);
}

export function eventResponse(name, data) {
  return JSON.stringify({ jsonrpc: '2.0', id: name, result: data });
}

// Characters a consent sheet cannot show: bidi overrides, zero-width marks, controls.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

export function hasHiddenText(s) {
  return INVISIBLE.test(s) || CONTROL.test(s);
}
