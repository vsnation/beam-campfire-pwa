// One running dApp and the wallet. Every request string from the dApp's
// frame goes through handle():
//
// 1. parse as JSON-RPC 2.0, as the core does;
// 2. the core's app allowlist for the negotiated API version (gate.js):
//    unknown -32601, blocked -32020;
// 3. parameter rules (sanitizer.js): no contract_file, no create_tx: true,
//    no hidden parameters on payments, no privileged shader;
// 4. process_invoke_data: the raw data is read in full and refused (-32020)
//    when it asks for privilege, calls BEAM names or signs with a key BEAM
//    Campfire's own features use (policy.js); sign_message with such a key
//    is refused too, and any other sign_message is put to the person first;
// 5. forwarded to this dApp's own app API in BEAM's engine (lib/contracts.js openApp), which
//    applies the core's app rules again, scopes transactions and addresses
//    to this dApp, and asks the person (through the consent presenter, with
//    this dApp's name) before tx_send or process_invoke_data runs.
//    invoke_contract and process_invoke_data go one at a time.
//
// handle() never throws: every failure is a JSON-RPC error string for the dApp.

import { RPC, RpcError, RpcFailure, parseRequest, resultResponse, errorResponse, eventResponse } from './rpc.js';
import { MethodGate, negotiateApiVersion, CURRENT_VERSION } from './gate.js';
import { RequestSanitizer, DEFAULT_REQUEST_LIMITS } from './sanitizer.js';
import { checkContractData, PolicyRefusal, reservedUseOfKeyMaterial, refusalError } from './policy.js';

export class DappSession {
  /**
   * @param {object} o
   * @param {string} o.appName shown in every approval
   * @param {{call: (method: string, params: object) => Promise<any>}} o.app this dApp's app API (openApp)
   * @param {(req: {appName: string, message: string}) => Promise<boolean>} o.confirmSign
   * @param {(why: string) => void} [o.onRefused] a request was refused before anyone was asked
   * @param {(delta: number) => void} [o.onBusy] +1/-1 around calls to the wallet
   */
  constructor({ appName, app, confirmSign, onRefused = null, onBusy = null, apiVersion = null, minApiVersion = null, limits = DEFAULT_REQUEST_LIMITS }) {
    this.appName = appName;
    this.app = app;
    this.confirmSign = confirmSign;
    this.onRefused = onRefused;
    this.onBusy = onBusy;
    this.limits = limits;
    this.sanitizer = new RequestSanitizer(limits);
    this.version = negotiateApiVersion({ wanted: apiVersion, minimum: minApiVersion }) || CURRENT_VERSION;
    this.gate = new MethodGate(this.version);
    this.inFlight = 0;
    this.closed = false;
    this.ownShader = null;
    this.shaderTail = Promise.resolve();
    this.subscribed = new Set();
    this.stats = { requests: 0, refused: 0, forwarded: 0 };
  }

  /** The web-extension handshake (create_beam_api): false when this wallet cannot serve the version asked for. */
  handshake({ apiver = null, apivermin = null } = {}) {
    if (this.closed) return false;
    const v = negotiateApiVersion({ wanted: apiver === '' ? null : apiver, minimum: apivermin });
    if (!v) return false;
    this.version = v;
    this.gate = new MethodGate(v);
    return true;
  }

  /** An engine event for this dApp's app API: delivered only when the dApp subscribed to it. */
  event(name, data) {
    if (this.closed || !this.subscribed.has(name)) return null;
    return eventResponse(name, data);
  }

  async handle(text) {
    this.stats.requests++;
    let id = null;
    try {
      const req = parseRequest(text, { maxLength: this.limits.maxRequestLength });
      id = req.id;
      if (this.closed) throw new RpcError(RPC.internalError, 'dApp session closed');
      this.gate.check(req.method);
      const params = await this.sanitizer.sanitize(req.method, req.params);
      if (this.inFlight >= this.limits.maxInFlight) throw new RpcError(RPC.throttle);
      this.inFlight++;
      try {
        return resultResponse(req.id, await this.dispatch(req.method, params));
      } finally {
        this.inFlight--;
      }
    } catch (e) {
      if (e instanceof RpcFailure) {
        this.stats.refused++;
        return errorResponse(e.id, e.error);
      }
      if (e instanceof RpcError) {
        if (e.code === RPC.notAllowed || e.code === RPC.methodNotFound || e.code === RPC.invalidParams) this.stats.refused++;
        return errorResponse(id, e);
      }
      if (e && e.rpc && typeof e.rpc.code === 'number') {
        // The engine's own error, passed through as the core wrote it.
        const err = new RpcError(e.rpc.code, e.rpc.data);
        if (typeof e.rpc.message === 'string') err.message = e.rpc.message;
        return errorResponse(id, err);
      }
      if (e && e.code === 'timeout') return errorResponse(id, new RpcError(RPC.internalError, 'The wallet did not answer in time; the outcome is unknown'));
      if (e && ['locked', 'closed', 'no_wallet', 'stopped'].includes(e.code)) return errorResponse(id, new RpcError(RPC.internalError, 'The wallet is locked or the dApp was closed'));
      return errorResponse(id, new RpcError(RPC.internalError));
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'invoke_contract':
        return this.oneShaderAtATime(() => this.forward(method, this.withOwnShader(params)));
      case 'process_invoke_data':
        try {
          checkContractData(Uint8Array.from(params.data));
        } catch (e) {
          if (e instanceof PolicyRefusal) {
            if (this.onRefused) this.onRefused(e.message);
            throw refusalError(e);
          }
          throw e;
        }
        return this.oneShaderAtATime(() => this.forward(method, params));
      case 'sign_message': {
        const use = await reservedUseOfKeyMaterial(params.key_material);
        if (use) {
          const why = `BEAM Campfire refused to sign: the key asked for controls ${use}. Nothing was signed.`;
          if (this.onRefused) this.onRefused(why);
          throw new RpcError(RPC.notAllowed, why);
        }
        const ok = await this.confirmSign({ appName: this.appName, message: params.message });
        if (!ok || this.closed) throw new RpcError(RPC.userRejected);
        return this.forward(method, params);
      }
      case 'ev_subunsub': {
        const r = await this.forward(method, params);
        for (const [k, v] of Object.entries(params)) {
          if (v === true) this.subscribed.add(k);
          else this.subscribed.delete(k);
        }
        return r;
      }
      default:
        return this.forward(method, params);
    }
  }

  async forward(method, params) {
    if (this.closed) throw new RpcError(RPC.internalError, 'dApp session closed');
    this.stats.forwarded++;
    if (this.onBusy) this.onBusy(1);
    try {
      return await this.app.call(method, params);
    } finally {
      if (this.onBusy) this.onBusy(-1);
    }
  }

  /**
   * The engine keeps one compiled app shader and reuses it for a call that
   * omits `contract`; that shader may be another app's. A call without
   * `contract` gets this dApp's own last shader, never whatever ran last.
   */
  withOwnShader(params) {
    if (Array.isArray(params.contract)) {
      this.ownShader = params.contract;
      return params;
    }
    if (!this.ownShader) throw new RpcError(RPC.invalidParams, 'Send the app shader with the first contract call');
    return { ...params, contract: this.ownShader };
  }

  oneShaderAtATime(op) {
    const result = this.shaderTail.then(() => op());
    this.shaderTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  close() {
    this.closed = true;
  }
}
