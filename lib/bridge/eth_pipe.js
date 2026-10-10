// The bridge's Ethereum side for one Ethereum wallet, a port of the desktop
// app's lib/wallets/ethereum/bridge/ (eth_pipe_calls.dart, eth_pipe_service.dart):
//
// * before a quote: whether the route is frozen (a paused token, Tether's
//   blacklist or transfer fee), the gas price the relayer prices with, and the
//   wallet's balances;
// * moving coins to BEAM ("e2b"): an exact approval of the pipe (never an
//   unlimited one; USDT reset to 0 first), then `sendFunds`, each returned
//   unsigned by planLock(), signed by sign() with the key the caller opens
//   (lib/eth/vault.js withEthKey), broadcast by broadcast(), and the lock read
//   back from its receipt;
// * coming from BEAM ("b2e"): whether the relayer has paid a message yet, one
//   storage read of the pipe.
//
// The pipes (BeamMW beam-bridge-ethpipe, EthPipe.sol / ERC20Pipe.sol):
//
//   sendFunds(uint256 value, uint256 relayerFee, bytes receiverBeamPubkey)
//     requires a 33-byte receiver and nothing else about it; takes value +
//     relayerFee (msg.value for ETH, transferFrom for a token, a burn for
//     WBEAM) and emits
//   NewLocalMessage(uint64 msgId, uint amount, uint relayerFee, bytes receiver),
//     every field in `data`.
//
// Neither the pipe nor the relayer checks that the receiver is a key anyone can
// sign for: five real crossings went to keys that are not on the curve and can
// never be claimed. So the wallet checks it here, before anything is signed.
//
// Freeze checks are stricter than the desktop's in one place: a quote may use
// an answer up to 10 minutes old (an hour while the server does not answer),
// but sign() asks again right before signing, and no answer means no signature.

import { ROUTES, NEW_LOCAL_MESSAGE_TOPIC, SEND_FUNDS_SIGNATURE, ethToGroth } from './routes.js';
import { relayerGas as relayerGasFrom } from './fees.js';
import { BridgeError, checkKey } from './beam_pipe.js';
import { encodeCall, abiEncode, abiDecode, selector, addressTopic } from '../eth/abi.js';
import { keccak256, normAddress } from '../eth/crypto.js';
import { bytesToHex, hexToBytes, toBytes, bytesToBigInt, equalBytes } from '../eth/hex.js';
import { EthRpcError, walletFees, gasWithHeadroom } from '../eth/rpc.js';
import { signTransaction, parseSignedTransaction, MAINNET_CHAIN_ID } from '../eth/tx.js';

export const SEND_FUNDS_SELECTOR = '0x4d5dd2bc';
export const APPROVE_SELECTOR = '0x095ea7b3';
/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** 2^256: value + fee must stay below it, or the pipe's unchecked sum (solc 0.7.2) wraps and nothing is deposited. */
export const UINT256_LIMIT = 1n << 256n;
/** 2^63: the BEAM side keeps amounts in 64 bits; below 2^63 they also stay positive as signed integers. */
export const BEAM_AMOUNT_LIMIT = 1n << 63n;

/**
 * Gas for sendFunds when it cannot be measured yet (while the approval it needs
 * is not mined, eth_estimateGas reverts). Measured on mainnet 2026-10-09: ETH
 * ~31,000; WBTC ~47,000, DAI ~50,000, WBEAM 49-54,000, USDT 55-60,000. About
 * twice that; only the gas used is paid.
 */
export const SEND_FUNDS_GAS_ETH = 80000n;
export const SEND_FUNDS_GAS_TOKEN = 120000n;
/** Gas for an approve that cannot be measured (USDT's, before its reset to zero is mined). */
export const APPROVE_GAS = 70000n;

/** A freeze check is reused this long for quotes... */
export const FREEZE_FRESH_MS = 10 * 60000;
/** ...and, while the server does not answer, up to this long. Then nothing is quoted. */
export const FREEZE_STALE_MS = 60 * 60000;

export const STEP_KINDS = Object.freeze({ approveReset: 'approveReset', approve: 'approve', lock: 'lock' });

const PAUSED = selector('paused()');
const BASIS_POINTS = selector('basisPointsRate()');

// ---------------------------------------------------------------- calls (no network)

/** Whether `key` is a BEAM public key the pipe can pay and its owner can claim with (33 bytes, X on secp256k1, 00/01). */
export function isBeamReceiverKey(key) {
  try {
    checkKey(toBytes(key));
    return true;
  } catch {
    return false;
  }
}

/** sendFunds(value, fee, receiverKey) calldata. */
export function sendFundsCall(value, fee, receiverKey) {
  return encodeCall(SEND_FUNDS_SIGNATURE, [value, fee, toBytes(receiverKey)]);
}

/** ERC-20 approve(spender, amount) calldata. */
export function erc20ApproveCall(spender, amount) {
  return encodeCall('approve(address,uint256)', [spender, amount]);
}

/**
 * The storage key of processed[msgId] in a pipe whose mapping(uint64 => bool)
 * sits at `slot`: keccak256(abi.encode(uint64 msgId, uint256 slot)), what
 * `cast index uint64 <msgId> <slot>` prints. 0x-hex.
 */
export function processedKey(msgId, slot) {
  const id = typeof msgId === 'bigint' ? msgId : Number.isSafeInteger(msgId) ? BigInt(msgId) : -1n;
  if (id < 0n || id >= 1n << 64n) throw new RangeError(`msgId ${msgId}`);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new RangeError(`slot ${slot}`);
  return bytesToHex(keccak256(abiEncode('uint64,uint256', [id, BigInt(slot)])));
}

const MESSAGE_TYPES = 'uint64,uint256,uint256,bytes';

/**
 * Decodes a NewLocalMessage log's data → {msgId, amount, relayerFee, receiver},
 * refusing anything that is not exactly what abi.encode writes for it (no
 * trailing bytes, no odd offsets) and an id beyond 2^53 (none exists).
 * Throws a plain Error (the receipt reader turns it into a refusal).
 */
export function decodePipeMessage(data) {
  const bytes = toBytes(data);
  let v;
  try {
    v = abiDecode(MESSAGE_TYPES, bytes);
  } catch {
    throw new Error('not a NewLocalMessage');
  }
  if (!equalBytes(abiEncode(MESSAGE_TYPES, v), bytes)) throw new Error('NewLocalMessage is not canonical');
  if (v[0] > 1n << 53n) throw new Error('NewLocalMessage id out of range');
  return Object.freeze({ msgId: Number(v[0]), amount: v[1], relayerFee: v[2], receiver: v[3] });
}

function unexpected(why) {
  return new BridgeError('unexpectedTransaction', `This is not the bridge transaction that was sent: ${why}.`);
}

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : null);

function blockOf(v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  const n = BigInt(v);
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
}

/**
 * Reads a mined lock from its receipt (eth_getTransactionReceipt as the server
 * answers it, hex strings and all): reverted → {success: false}; otherwise it
 * must be `owner` calling the route's pipe, emitting exactly one
 * NewLocalMessage, from that pipe, naming exactly `value`, `fee` and
 * `receiverKey`, and for a token exactly one Transfer of value + fee from
 * `owner` into the pipe (WBEAM: burnt, to the zero address). Anything else
 * throws BridgeError 'unexpectedTransaction': it is not this crossing's lock.
 * → {hash, success, blockNumber, msgId}
 */
export function decodeLockReceipt(route, receipt, { owner, value, fee, receiverKey }) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const hash = r.transactionHash;
  const blockNumber = blockOf(r.blockNumber);
  if (typeof hash !== 'string' || blockNumber === null) throw unexpected('no hash or block');
  if (lower(r.from) !== lower(owner)) throw unexpected('it was sent from another address');
  if (lower(r.to) !== route.ethPipe) throw unexpected(`it went to another contract, not the ${route.ethSymbol} pipe`);
  if (r.status === '0x0') return Object.freeze({ hash: hash.toLowerCase(), success: false, blockNumber, msgId: null });
  if (r.status !== '0x1') throw unexpected('its receipt has no status');

  const logs = Array.isArray(r.logs) ? r.logs.filter((l) => l && typeof l === 'object') : [];
  const topicsOf = (l) => (Array.isArray(l.topics) ? l.topics.map(lower) : []);
  const messages = logs.filter((l) => topicsOf(l)[0] === NEW_LOCAL_MESSAGE_TOPIC);
  if (messages.length !== 1) throw unexpected(`it records ${messages.length} bridge messages, not one`);
  const log = messages[0];
  if (lower(log.address) !== route.ethPipe || topicsOf(log).length !== 1) throw unexpected('its message comes from another contract');
  let m;
  try {
    m = decodePipeMessage(hexToBytes(log.data));
  } catch {
    throw unexpected('its message cannot be read');
  }
  if (m.amount !== value) throw unexpected('it moves another amount');
  if (m.relayerFee !== fee) throw unexpected('it pays another bridge fee');
  if (!equalBytes(m.receiver, toBytes(receiverKey))) throw unexpected('it pays another BEAM wallet');

  if (!route.isNativeEth) {
    // The pipe took exactly value + fee of the token: a token that keeps a
    // transfer fee (USDT can switch one on) would leave the pipe short while
    // the message still names the full amount.
    const transfers = logs.filter((l) => lower(l.address) === route.ethToken && topicsOf(l)[0] === ERC20_TRANSFER_TOPIC);
    if (transfers.length !== 1) throw unexpected(`it moves ${route.ethSymbol} ${transfers.length} times`);
    const t = transfers[0];
    const topics = topicsOf(t);
    const into = route.isBeam ? ZERO_ADDRESS : route.ethPipe;
    let amount = -1n;
    try {
      const d = hexToBytes(t.data);
      if (d.length === 32) amount = bytesToBigInt(d);
    } catch {
      /* refused below */
    }
    if (topics.length !== 3 || topics[1] !== addressTopic(lower(owner)) || topics[2] !== addressTopic(into) || amount !== value + fee) {
      throw unexpected('the pipe did not take exactly the amount and the fee');
    }
  }
  return Object.freeze({ hash: hash.toLowerCase(), success: true, blockNumber, msgId: m.msgId });
}

/** `v` Ethereum units of the route's asset as a plain number ("100.02"). */
function units(v, route) {
  const d = route.ethDecimals;
  const s = v.toString().padStart(d + 1, '0');
  const frac = s.slice(s.length - d).replace(/0+$/, '');
  return frac ? `${s.slice(0, s.length - d)}.${frac}` : s.slice(0, s.length - d);
}

/**
 * Refuses (badAmount) what the pipes or the relayer would get wrong: nothing to
 * move, a negative fee, an amount the relayer would cut to BEAM's 8 decimals
 * (the cut stays in the pipe: steps of 10^10 wei for ETH and DAI), a sum that
 * wraps the pipe's unchecked value + fee (nothing deposited, nothing paid), or
 * one BEAM cannot hold. Refuses (badPipe) a receiver nobody can claim with. A
 * zero fee is allowed: the relayer delivers it (it never checks an e2b fee),
 * though Campfire always pays one.
 */
export function checkLockAmounts(route, { value, fee, receiverKey }) {
  const bad = (why) => {
    throw new BridgeError('badAmount', why);
  };
  if (typeof value !== 'bigint' || typeof fee !== 'bigint') bad('Amounts must be BigInt.');
  if (value <= 0n) bad('Nothing to move.');
  if (fee < 0n) bad('The bridge fee cannot be negative.');
  const grid = route.ethGrid;
  if (value % grid !== 0n || fee % grid !== 0n) bad(`${route.ethSymbol} moves to BEAM in steps of ${units(grid, route)}; the rest would stay in the bridge.`);
  if (value + fee >= UINT256_LIMIT) bad('This amount is too large.');
  if (ethToGroth(route, value) + ethToGroth(route, fee) >= BEAM_AMOUNT_LIMIT) bad('This amount is too large for BEAM.');
  // It comes from the BEAM pipe's get_pk: a shader error or the wrong
  // contract, and coins sent to it could never be claimed.
  if (!isBeamReceiverKey(receiverKey)) throw new BridgeError('badPipe', 'The BEAM wallet gave a receive key nobody could claim with.');
}

/**
 * Throws (unexpectedTransaction) unless `tx` ({to, data, value}) is an
 * approve(pipe, amount) of a route's token or a sendFunds to a route's pipe
 * with a claimable receiver and the ETH it needs, as planLock builds them.
 * Returns the route.
 */
export function checkBridgeTx(tx) {
  const refuse = () => {
    throw new BridgeError('unexpectedTransaction', 'This is not a bridge transaction; it was not signed.');
  };
  let to;
  let data;
  let value;
  try {
    to = normAddress(tx.to);
    data = toBytes(tx.data);
    value = tx.value === undefined ? 0n : tx.value;
  } catch {
    refuse();
  }
  if (typeof value !== 'bigint' || data.length < 4) refuse();
  const sel = bytesToHex(data.subarray(0, 4));
  const args = data.subarray(4);
  for (const r of ROUTES) {
    if (r.ethToken && to === r.ethToken && sel === APPROVE_SELECTOR) {
      if (value !== 0n || args.length !== 64) refuse();
      let v;
      try {
        v = abiDecode('address,uint256', args);
      } catch {
        refuse();
      }
      if (lower(v[0]) !== r.ethPipe || !equalBytes(erc20ApproveCall(r.ethPipe, v[1]), data)) refuse();
      return r;
    }
    if (to === r.ethPipe && sel === SEND_FUNDS_SELECTOR) {
      let v;
      try {
        v = abiDecode('uint256,uint256,bytes', args);
      } catch {
        refuse();
      }
      const [val, fee, key] = v;
      if (!isBeamReceiverKey(key) || val + fee >= UINT256_LIMIT || value !== (r.isNativeEth ? val + fee : 0n) || !equalBytes(sendFundsCall(val, fee, key), data)) refuse();
      return r;
    }
  }
  return refuse();
}

// ---------------------------------------------------------------- freezes

function freezeChecks(route) {
  const token = route.ethToken;
  if (!token) return [];
  switch (route.id) {
    // WBEAM: one key holds its pause (and its minting).
    case 'beam':
      return [{ to: token, data: PAUSED, token: 'WBEAM', reason: 'WBEAM is paused by its issuer', flag: true }];
    case 'wbtc':
      return [{ to: token, data: PAUSED, token: 'WBTC', reason: 'WBTC is paused by its issuer', flag: true }];
    // Tether can pause USDT, blacklist the pipe (every USDT in it then stays
    // there for good), or switch on a transfer fee (the pipe would get less
    // than the message says).
    case 'usdt':
      return [
        { to: token, data: PAUSED, token: 'USDT', reason: 'Tether has paused USDT', flag: true },
        { to: token, data: encodeCall('isBlackListed(address)', [route.ethPipe]), token: 'USDT', reason: "Tether has frozen the bridge's USDT", flag: true },
        { to: token, data: BASIS_POINTS, token: 'USDT', reason: 'USDT now charges a transfer fee', flag: false },
      ];
    // DAI has no pause and no blacklist; native ETH has no issuer; the pipes
    // themselves have no admin at all.
    default:
      return [];
  }
}

// ---------------------------------------------------------------- the service

/**
 * The bridge's Ethereum side for the wallet at `owner`.
 *   rpc      an EthRpc (lib/eth/rpc.js) on the server the person chose
 *   owner    the wallet's address
 *   withKey  fn => withEthKey(app, fn): runs fn({sk, address}) with the key open
 *   clock    () => ms
 */
export class EthPipe {
  #freezes = new Map();
  #signed = new WeakSet();

  constructor({ rpc, owner, withKey = null, clock = () => Date.now() }) {
    this.rpc = rpc;
    this.owner = normAddress(owner);
    this.withKey = withKey;
    this.clock = clock;
  }

  /** f(), with any failure to reach the server as BridgeError 'network' saying what could not be read. */
  static async read(what, f) {
    try {
      return await f();
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError('network', `Could not read ${what} from Ethereum (${e && e.message}).`);
    }
  }

  /**
   * Why `route` cannot be used now: [{reason}], empty when it can. Throws
   * BridgeError 'frozen' (a check that failed or answered nonsense) or
   * 'network' when it cannot tell. fresh: ask now, never a kept answer.
   */
  async freezes(route, { fresh = false } = {}) {
    const checks = freezeChecks(route);
    if (!checks.length) return [];
    const now = this.clock();
    const cached = this.#freezes.get(route.id);
    if (!fresh && cached && now - cached.at < FREEZE_FRESH_MS) return cached.freezes;
    let failure;
    try {
      const results = await this.rpc.multicall(checks.map((c) => ({ to: c.to, data: c.data })));
      if (!Array.isArray(results) || results.length !== checks.length) throw new BridgeError('frozen', `Could not tell whether ${route.ethSymbol} is frozen, so it is not bridged for now.`);
      const found = [];
      checks.forEach((c, i) => {
        const r = results[i];
        if (!r || !r.success || !(r.data instanceof Uint8Array) || r.data.length !== 32) throw new BridgeError('frozen', `Could not tell whether ${c.token} is frozen, so it is not bridged for now.`);
        const word = bytesToBigInt(r.data);
        if (c.flag && word > 1n) throw new BridgeError('frozen', `${c.token} gave an answer it never gives, so it is not bridged for now.`);
        if (word !== 0n) found.push(Object.freeze({ reason: c.reason }));
      });
      const frozen = Object.freeze(found);
      this.#freezes.set(route.id, { freezes: frozen, at: now });
      return frozen;
    } catch (e) {
      failure = e instanceof BridgeError ? e : new BridgeError('network', `Could not reach Ethereum to check ${route.ethSymbol} (${e && e.message}).`);
    }
    // A server that flaps does not stop the bridge for an hour; after that an
    // old "not frozen" is not trusted. Never for a check right before signing.
    if (!fresh && cached && now - cached.at < FREEZE_STALE_MS) return cached.freezes;
    throw failure;
  }

  /** Asks now; throws unless the route is known not to be frozen (fail closed). */
  async assertNotFrozen(route) {
    const f = await this.freezes(route, { fresh: true });
    if (f.length) throw new BridgeError('frozen', f.map((x) => x.reason).join('\n'));
  }

  /** The relayer's gas price: eth_feeHistory(0xa, latest, [50]) → fees.js relayerGas. */
  async relayerGas() {
    try {
      return relayerGasFrom(await this.rpc.feeHistory(10, 'latest', [50]), this.clock());
    } catch (e) {
      // No gas price, so no quote.
      throw new BridgeError('noPrice', `Could not read the Ethereum gas price (${e && e.message}).`);
    }
  }

  /** The wallet's balance of the route's Ethereum asset (wei for ETH). */
  async balance(route) {
    if (!route.ethToken) return this.ethBalance();
    return EthPipe.read(`your ${route.ethSymbol} balance`, async () => abiDecode('uint256', await this.rpc.ethCall({ to: route.ethToken, data: encodeCall('balanceOf(address)', [this.owner]) }))[0]);
  }

  async ethBalance() {
    return EthPipe.read('your ETH balance', () => this.rpc.getBalance(this.owner));
  }

  /** What the route's pipe may take from the wallet now. */
  async allowance(route) {
    if (!route.ethToken) throw new BridgeError('badArgs', 'ETH needs no approval');
    return EthPipe.read(`your ${route.ethSymbol} approval`, async () => abiDecode('uint256', await this.rpc.ethCall({ to: route.ethToken, data: encodeCall('allowance(address,address)', [this.owner, route.ethPipe]) }))[0]);
  }

  /**
   * The unsigned transactions that lock value + fee in the route's pipe for
   * receiverKey, priced: in order a reset of a non-zero allowance (USDT), an
   * exact approval, then sendFunds; only sendFunds for ETH or when the
   * allowance already covers value + fee. Nothing is signed.
   * → {route, value, fee, receiverKey, steps, fees, maxGasCost, expectedGasCost}
   *   step: {kind, to, data (bytes), value, gasLimit, maxFeePerGas, maxPriorityFeePerGas, baseFee, note, maxGasCost, expectedGasCost}
   */
  async planLock(route, { value, fee, receiverKey }) {
    checkLockAmounts(route, { value, fee, receiverKey });
    const key = Uint8Array.from(toBytes(receiverKey));
    const total = value + fee;
    const fees = await EthPipe.read('Ethereum fees', () => walletFees(this.rpc));
    const steps = [];
    if (route.ethToken) {
      const current = await this.allowance(route);
      if (current < total) {
        // Exactly what this lock takes, never "any amount": a pipe left with
        // an open approval could take more later.
        if (current > 0n && !(await this.#changesAllowance(route, total))) {
          // USDT refuses to change an allowance that is not zero.
          steps.push(await this.#approvalTx(route, 0n, fees, `Reset the ${route.ethSymbol} permission of the BEAM bridge to 0`));
        }
        steps.push(await this.#approvalTx(route, total, fees, `Approve ${units(total, route)} ${route.ethSymbol} for the BEAM bridge`));
      }
    }
    const data = sendFundsCall(value, fee, key);
    const msgValue = route.isNativeEth ? total : 0n;
    let gas = route.isNativeEth ? SEND_FUNDS_GAS_ETH : SEND_FUNDS_GAS_TOKEN;
    if (!steps.length) {
      try {
        gas = gasWithHeadroom(await this.rpc.estimateGas({ from: this.owner, to: route.ethPipe, data, value: msgValue }));
      } catch (e) {
        // It reverts (not enough of the coin yet, or a freeze): balances and
        // freezes are checked elsewhere; the plan keeps a safe limit.
        if (!isServerError(e)) throw new BridgeError('network', `Could not reach Ethereum to price the lock (${e && e.message}).`);
      }
    }
    steps.push(step(STEP_KINDS.lock, route.ethPipe, data, msgValue, gas, fees, `Bridge: move ${units(value, route)} ${route.ethSymbol} to BEAM`));
    return Object.freeze({
      route,
      value,
      fee,
      receiverKey: key,
      steps: Object.freeze(steps),
      fees,
      maxGasCost: steps.reduce((s, t) => s + t.maxGasCost, 0n),
      expectedGasCost: steps.reduce((s, t) => s + t.expectedGasCost, 0n),
    });
  }

  /** Whether the token lets the wallet change its non-zero allowance to `amount` directly (USDT reverts: zero first). */
  async #changesAllowance(route, amount) {
    try {
      await this.rpc.ethCall({ to: route.ethToken, data: erc20ApproveCall(route.ethPipe, amount), from: this.owner });
      return true;
    } catch (e) {
      if (isServerError(e) && (e.code === 3 || /revert/i.test(e.message))) return false;
      throw new BridgeError('network', `Could not reach Ethereum to check the approval (${e && e.message}).`);
    }
  }

  async #approvalTx(route, amount, fees, note) {
    const data = erc20ApproveCall(route.ethPipe, amount);
    let gas = APPROVE_GAS;
    try {
      gas = gasWithHeadroom(await this.rpc.estimateGas({ from: this.owner, to: route.ethToken, data }));
    } catch (e) {
      // Reverts until an earlier step is mined (USDT's reset).
      if (!isServerError(e)) throw new BridgeError('network', `Could not reach Ethereum to price the approval (${e && e.message}).`);
    }
    return step(amount === 0n ? STEP_KINDS.approveReset : STEP_KINDS.approve, route.ethToken, data, 0n, gas, fees, note);
  }

  /**
   * Signs one planned step with the wallet's key and returns {raw, hash, nonce}
   * without broadcasting it (the caller stores the hash and the raw bytes
   * first). Only a bridge transaction is signed (checkBridgeTx), only on
   * mainnet, only after a fresh freeze check that answered "not frozen", and
   * each request at most once (alreadySent), even when this throws.
   */
  async sign(tx) {
    const route = checkBridgeTx(tx);
    if (this.#signed.has(tx)) throw new BridgeError('alreadySent', 'This transaction was already signed once; plan it again.');
    this.#signed.add(tx);
    if (typeof this.withKey !== 'function') throw new BridgeError('badArgs', 'No Ethereum key to sign with.');
    await this.assertNotFrozen(route);
    await EthPipe.read('the network', () => this.rpc.assertMainnet());
    const nonce = await EthPipe.read('your next transaction number', () => this.rpc.getTransactionCount(this.owner, 'pending'));
    const signed = await this.withKey(({ sk, address }) => {
      if (normAddress(address) !== this.owner) throw new BridgeError('unexpectedTransaction', 'The opened key is not this Ethereum wallet. Nothing was signed.');
      return signTransaction(
        { chainId: MAINNET_CHAIN_ID, nonce, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
        sk,
      );
    });
    if (lower(signed.from) !== this.owner) throw new BridgeError('unexpectedTransaction', "The signature is not this wallet's. Nothing was sent.");
    return Object.freeze({ raw: signed.raw, hash: signed.hash.toLowerCase(), nonce: Number(signed.nonce) });
  }

  /**
   * Broadcasts signed bytes and returns their hash. The bytes are read back
   * first: mainnet, this wallet's, and a bridge transaction. Sending the same
   * bytes again is safe (the server says it has them).
   */
  async broadcast(raw) {
    let parsed;
    try {
      parsed = parseSignedTransaction(raw);
    } catch {
      throw new BridgeError('unexpectedTransaction', 'These are not signed transaction bytes. Nothing was sent.');
    }
    if (parsed.tx.chainId !== MAINNET_CHAIN_ID || lower(parsed.from) !== this.owner) throw new BridgeError('unexpectedTransaction', "This transaction is not this wallet's on Ethereum. Nothing was sent.");
    checkBridgeTx(parsed.tx);
    return this.rpc.sendRawTransaction(raw);
  }

  /** Whether the server knows transaction `hash` (pending or mined). */
  async known(hash) {
    return EthPipe.read('the transaction', async () => (await this.rpc.getTransactionByHash(hash)) !== null);
  }

  /** The mined receipt of `hash` as the server answers it, or null while pending or unknown. */
  async #receipt(hash) {
    return EthPipe.read('the transaction', async () => {
      const r = await this.rpc.call('eth_getTransactionReceipt', [bytesToHex(toBytes(hash))]);
      if (!r || typeof r !== 'object' || r.blockNumber == null) return null;
      return r;
    });
  }

  /** Whether transaction `hash` is mined: null while pending, true or false (reverted) once it is. */
  async succeeded(hash) {
    const r = await this.#receipt(hash);
    if (r === null) return null;
    if (lower(r.transactionHash) !== lower(hash)) throw new BridgeError('unexpectedTransaction', 'The server answered with another transaction.');
    return r.status === '0x1';
  }

  /**
   * The lock `hash` once mined (null while pending): decodeLockReceipt with this
   * wallet as the sender. Throws (unexpectedTransaction) for anything that is
   * not exactly this lock.
   */
  async lockResult(route, hash, { value, fee, receiverKey }) {
    const r = await this.#receipt(hash);
    if (r === null) return null;
    const lock = decodeLockReceipt(route, r, { owner: this.owner, value, fee, receiverKey });
    if (lock.hash !== lower(hash)) throw new BridgeError('unexpectedTransaction', 'The server answered with another transaction.');
    return lock;
  }

  /** Whether the relayer has paid BEAM-side message beamMsgId on Ethereum: one storage read of the pipe. */
  async isPaid(route, beamMsgId) {
    const word = await EthPipe.read('the bridge payout', async () => {
      // A storage word; some servers drop its leading zeros ("0x1").
      const r = await this.rpc.call('eth_getStorageAt', [route.ethPipe, processedKey(beamMsgId, route.processedSlot), 'latest']);
      if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{0,64}$/.test(r)) throw new Error('eth_getStorageAt: not a storage word');
      return r === '0x' ? 0n : BigInt(r);
    });
    if (word > 1n) throw new BridgeError('badPipe', `The ${route.ethSymbol} pipe gave an answer it never gives.`);
    return word === 1n;
  }
}

/** A JSON-RPC error the server answered (a revert, a refusal), not a failure to reach it. */
function isServerError(e) {
  return e instanceof EthRpcError && typeof e.code === 'number';
}

function step(kind, to, data, value, gasLimit, fees, note) {
  return Object.freeze({
    kind,
    to,
    data,
    value,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    baseFee: fees.baseFee,
    note,
    // The most it can cost in gas (limit × max fee), and what it will most
    // likely cost (limit × (base fee + tip)); only the gas used is paid.
    maxGasCost: gasLimit * fees.maxFeePerGas,
    expectedGasCost: gasLimit * (fees.baseFee + fees.maxPriorityFeePerGas),
  });
}
