// Sending ETH or a known token from this wallet: check the recipient,
// prepare the exact transaction and what it can cost, sign it with the key
// open for as short a time as possible, save it, then broadcast it, and
// follow it to a receipt.
//
// The order is the point (plan §2):
//   prepare  walletFees + estimateGas (+ an eth_call of the token transfer);
//            the fee shown "up to" is gasLimit x maxFeePerGas of the very
//            transaction that will be signed, so it can never be exceeded.
//   sign     withEthKey: chain id 1 checked again, nonce from 'pending',
//            signed, key zeroed.
//   save     {hash, raw, nonce} into the sealed outbox BEFORE broadcasting.
//   send     eth_sendRawTransaction. A network error leaves it 'signed':
//            the same bytes can be sent again safely, never re-signed.
//   follow   receipts while the screen is visible and the wallet unlocked;
//            "replaced" when the account's mined nonce moved past ours with
//            no receipt (the desktop app's findReplacedPendingEthereumTransactions).

import { isAddress, toChecksumAddress } from './crypto.js';
import { encodeCall, abiDecode } from './abi.js';
import { signTransaction, MAINNET_CHAIN_ID } from './tx.js';
import { walletFees, gasWithHeadroom, EthRpcError } from './rpc.js';
import { withEthKey } from './vault.js';
import { addToOutbox, updateOutbox } from './outbox.js';
import { ETH, TOKENS, tokenByAddress } from './tokens.js';
import { formatUnits } from './units.js';
import { ROUTES } from '../bridge/routes.js';

/** wei as ETH for an "up to" figure: rounded up at 8 places, never understated. */
function ethUp(wei) {
  const cut = 10n ** 10n;
  return formatUnits(wei % cut === 0n ? wei : wei + (cut - (wei % cut)), 18);
}

/** A plain ETH payment to an account without code always uses exactly this. */
export const ETH_TRANSFER_GAS = 21000n;
const ZERO = '0x0000000000000000000000000000000000000000';

export class SendError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'not_enough' | 'no_gas' | 'would_fail' | 'recipient' | 'changed' | 'server'
  }
}

/** Contracts that take nothing back: the bridge's Ethereum pipes. Plain coins sent there are lost. */
export const BRIDGE_PIPES = Object.freeze(ROUTES.map((r) => r.ethPipe.toLowerCase()));

/**
 * Why `input` cannot receive a payment from `own`, in words, or null.
 * {code, message}; code: 'empty' | 'format' | 'checksum' | 'own' | 'zero' | 'bridge' | 'token'.
 */
export function recipientProblem(input, { own = null } = {}) {
  const a = String(input || '').trim();
  if (!a) return { code: 'empty', message: '' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    if (/^[0-9a-fA-F]{40}$/.test(a)) return { code: 'format', message: 'An Ethereum address starts with 0x. Copy it again from the person you are paying.' };
    return { code: 'format', message: "This isn't an Ethereum address (0x and 40 letters and digits). Copy it again from the person you are paying." };
  }
  if (!isAddress(a)) return { code: 'checksum', message: "This address doesn't add up: one character looks mistyped. Copy it again rather than typing it." };
  const low = a.toLowerCase();
  if (low === ZERO) return { code: 'zero', message: 'This is the zero address: coins sent to it are gone for good.' };
  if (own && low === own.toLowerCase()) return { code: 'own', message: "This is this wallet's own address. Paste the receiver's address." };
  if (BRIDGE_PIPES.includes(low)) return { code: 'bridge', message: "This is the BEAM bridge's contract. Coins sent to it directly are lost; moving coins to BEAM needs the bridge, not a payment." };
  const token = tokenByAddress(low);
  if (token) return { code: 'token', message: `This is the ${token.symbol} token's own contract. Coins sent to it are lost. Paste the receiver's address.` };
  return null;
}

/** {to, value, data} of a payment of `amount` of `asset` (ETH or a known token) to `recipient`. */
export function transferCall(asset, recipient, amount) {
  if (asset === ETH || asset.address == null) return { to: toChecksumAddress(recipient), value: amount, data: '0x' };
  if (!TOKENS.includes(asset)) throw new SendError('recipient', 'Only the tokens this wallet knows can be sent.');
  return { to: toChecksumAddress(asset.address), value: 0n, data: encodeCall('transfer(address,uint256)', [recipient, amount]) };
}

function revertText(e) {
  const m = String((e && e.message) || '');
  return m.replace(/^execution reverted:?\s*/i, '').trim();
}

/**
 * Builds the transaction and its costs. balances: {eth: wei, [symbol]: units}.
 * Returns {asset, recipient, amount, tx:{to, value, data, gasLimit,
 * maxFeePerGas, maxPriorityFeePerGas}, gas, fees:{likely, upTo, baseFee, tip},
 * preparedAt}. Throws SendError with the reason in words.
 */
export async function prepareSend(rpc, { from, asset, recipient, amount, balances, now = Date.now() }) {
  const problem = recipientProblem(recipient, { own: from });
  if (problem) throw new SendError('recipient', problem.message || 'Enter the address to send to.');
  if (typeof amount !== 'bigint' || amount <= 0n) throw new SendError('not_enough', 'The amount must be more than zero.');
  const isEth = asset === ETH;
  const have = isEth ? balances.eth : balances[asset.symbol];
  if (have == null) throw new SendError('server', 'The balance is not known yet. Try again in a moment.');
  if (!isEth && amount > have) throw new SendError('not_enough', `That's more than you have (${formatUnits(have, asset.decimals)} ${asset.symbol}).`);
  if (isEth && amount > have) throw new SendError('not_enough', `That's more than you have (${formatUnits(have, 18)} ETH).`);

  const call = transferCall(asset, recipient, amount);
  const fees = await walletFees(rpc);
  let estimate;
  try {
    estimate = await rpc.estimateGas({ from, to: call.to, data: call.data, value: call.value });
  } catch (e) {
    if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e; // the server, not the transaction
    if (isEth && /insufficient funds/i.test(e.message)) throw new SendError('not_enough', 'There is not enough ETH for the amount and the network fee.');
    if (isEth && (await rpc.getCode(call.to)).length === 0) estimate = ETH_TRANSFER_GAS; // no code: it cannot refuse ETH
    else throw new SendError('would_fail', `Ethereum says this payment would fail${revertText(e) ? ` (${revertText(e)})` : ''}. Nothing was sent.`);
  }
  if (!isEth) {
    // The exact call, as it will run: a token that answers false (or reverts) would take the fee and move nothing.
    let out;
    try {
      out = await rpc.ethCall({ from, to: call.to, data: call.data });
    } catch (e) {
      if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e;
      throw new SendError('would_fail', `The ${asset.symbol} contract refuses this transfer${revertText(e) ? ` (${revertText(e)})` : ''}. Nothing was sent.`);
    }
    if (out.length > 0 && (out.length !== 32 || abiDecode('bool', out)[0] !== true)) throw new SendError('would_fail', `The ${asset.symbol} contract refuses this transfer. Nothing was sent.`);
  }
  const gasLimit = estimate === ETH_TRANSFER_GAS && isEth ? ETH_TRANSFER_GAS : gasWithHeadroom(estimate);
  const upTo = gasLimit * fees.maxFeePerGas;
  let likely = estimate * (fees.baseFee + fees.maxPriorityFeePerGas);
  if (likely > upTo) likely = upTo;
  const eth = balances.eth ?? 0n;
  if (isEth && amount + upTo > eth) {
    const max = eth > upTo ? eth - upTo : 0n;
    throw new SendError('not_enough', `With the network fee (up to ${ethUp(upTo)} ETH) that's more than you have. You can send up to ${formatUnits(max, 18)} ETH.`);
  }
  if (!isEth && upTo > eth) throw new SendError('no_gas', `The network fee is paid in ETH: up to ${ethUp(upTo)} ETH, and this wallet has ${formatUnits(eth, 18)} ETH.`);
  return {
    asset,
    recipient: toChecksumAddress(recipient),
    amount,
    tx: { to: call.to, value: call.value, data: call.data, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
    gas: estimate,
    fees: { likely, upTo, baseFee: fees.baseFee, tip: fees.maxPriorityFeePerGas },
    preparedAt: now,
  };
}

/** The most that can be sent: all of a token, or the ETH balance less the fee at most. */
export function maxSendable(asset, balances, upToFee) {
  if (asset !== ETH) return balances[asset.symbol] ?? 0n;
  const eth = balances.eth ?? 0n;
  return eth > upToFee ? eth - upToFee : 0n;
}

/** Whether a fresh preparation costs more than the one the person reviewed. */
export function costRose(reviewed, fresh) {
  return fresh.fees.upTo > reviewed.fees.upTo || fresh.tx.gasLimit !== reviewed.tx.gasLimit || fresh.tx.to !== reviewed.tx.to || fresh.tx.value !== reviewed.tx.value;
}

function serverRefused(e) {
  return e instanceof EthRpcError && typeof e.code === 'number';
}

/**
 * Signs `prepared` (already reviewed and confirmed by the person), saves it,
 * broadcasts it. Returns {entry, sent, error}: sent false with error when the
 * broadcast did not go through (entry.state tells whether it can still be
 * mined: 'signed' yes, 'rejected' no).
 */
export async function signAndSend(app, rpc, prepared, { ethId, kv, now = () => Date.now() } = {}) {
  const signed = await withEthKey(
    app,
    async ({ sk, address }) => {
      await rpc.assertMainnet();
      const nonce = await rpc.getTransactionCount(address, 'pending');
      const s = signTransaction({ chainId: MAINNET_CHAIN_ID, nonce, ...prepared.tx }, sk);
      if (s.from !== address) throw new SendError('server', 'The signature does not belong to this wallet.');
      return s;
    },
    kv,
  );
  let entry = {
    hash: signed.hash,
    raw: signed.raw,
    nonce: String(signed.nonce),
    from: signed.from,
    to: prepared.recipient,
    asset: prepared.asset.symbol,
    token: prepared.asset === ETH ? null : prepared.asset.address,
    amount: String(prepared.amount),
    gasLimit: String(prepared.tx.gasLimit),
    maxFeePerGas: String(prepared.tx.maxFeePerGas),
    maxPriorityFeePerGas: String(prepared.tx.maxPriorityFeePerGas),
    createdAt: now(),
    sentAt: null,
    state: 'signed',
    receipt: null,
    error: null,
  };
  await addToOutbox(app, entry, { ethId, kv });
  return broadcast(app, rpc, entry, { ethId, kv, now });
}

/** Sends an entry's saved bytes (again). Never re-signs. */
export async function broadcast(app, rpc, entry, { ethId, kv, now = () => Date.now() } = {}) {
  try {
    await rpc.sendRawTransaction(entry.raw);
    const e = (await updateOutbox(app, entry.hash, { state: entry.state === 'signed' ? 'pending' : entry.state, sentAt: entry.sentAt || now(), error: null }, { ethId, kv })) || entry;
    return { entry: e, sent: true, error: null };
  } catch (err) {
    // A server that refuses the bytes (nonce used, fee below the base fee, not enough ETH) will not take them later either.
    const nonceGone = serverRefused(err) && /nonce too low|already used|replacement/i.test(err.message);
    const patch = serverRefused(err) && !nonceGone && entry.state === 'signed' ? { state: 'rejected', error: err.message } : { error: err.message };
    const e = (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || entry;
    return { entry: e, sent: false, error: err };
  }
}

/**
 * What happened to a sent transaction, from: its receipt (or null), the
 * account's mined nonce count (asked BEFORE the receipt, so a transaction
 * mined in between still shows as mined), whether the server knows it and
 * whether it says it is in a block.
 *   'confirmed' | 'failed'  mined, status 1 / 0
 *   'pending'               in a block, receipt not served yet; or known and waiting
 *   'replaced'              not in any block, but nonce `nonce` is used up
 *   'unknown'               the server has never seen it: send the bytes again
 */
export function classify({ receipt, minedNonce, nonce, known, inBlock = false }) {
  if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
  if (inBlock) return 'pending';
  if (minedNonce > BigInt(nonce)) return 'replaced';
  if (!known) return 'unknown';
  return 'pending';
}

/**
 * One look at an open entry: asks the server, updates the outbox, sends the
 * same bytes again when the server has forgotten them. Returns the entry.
 */
export async function followOnce(app, rpc, entry, { ethId, kv } = {}) {
  if (entry.state !== 'signed' && entry.state !== 'pending') return entry;
  const minedNonce = await rpc.getTransactionCount(entry.from, 'latest');
  const receipt = await rpc.getTransactionReceipt(entry.hash);
  const tx = receipt ? null : await rpc.getTransactionByHash(entry.hash);
  const state = classify({ receipt, minedNonce, nonce: entry.nonce, known: Boolean(receipt || tx), inBlock: Boolean(tx && tx.blockHash) });
  if (state === 'unknown') return (await broadcast(app, rpc, entry, { ethId, kv })).entry;
  if (state === 'pending') return entry.state === 'pending' ? entry : (await updateOutbox(app, entry.hash, { state: 'pending' }, { ethId, kv })) || entry;
  const patch = { state };
  if (receipt) patch.receipt = { blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: String(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice == null ? null : String(receipt.effectiveGasPrice) };
  return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
}

/** The fee an entry paid (mined) or may pay at most (open): {wei, final}. */
export function entryFee(entry) {
  const r = entry.receipt;
  if (r && r.gasUsed && r.effectiveGasPrice) return { wei: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), final: true };
  return { wei: BigInt(entry.gasLimit || 0) * BigInt(entry.maxFeePerGas || 0), final: false };
}
