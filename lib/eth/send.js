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
//            the same bytes can be sent again safely, never re-signed. A
//            server that refuses the bytes may still have passed them on (or
//            be lying), so a refusal is not "never sent" at once: the entry
//            stays open (entry.refusedAt), its hash is checked and its bytes
//            offered again, and only after REFUSAL_WATCH_MS of refusals with
//            the hash unknown is it 'rejected'.
//   follow   receipts while the screen is visible and the wallet unlocked.
//            "Replaced" only with evidence: the server showing the transaction
//            that took our nonce, signed by this wallet's key (checked here, so
//            a server cannot make one up) and with a receipt. The account's
//            nonce having moved on is the server's word alone, and a server
//            that is wrong (or lying) about it would have the person pay again
//            while the first payment can still be mined; that is 'unsure'
//            (entry.unsureSince): kept open, the same bytes offered again, and
//            the screens say not to send it again yet. (The desktop app's
//            findReplacedPendingEthereumTransactions decides on the nonce alone.)
//   gate     while any transaction of this wallet is in doubt (unsure, or refused and still
//            watched), nothing new is signed: it would take the next nonce, and both could be
//            mined (lib/eth/doubt.js; release audit BM-1).

import { isAddress, toChecksumAddress } from './crypto.js';
import { encodeCall, abiDecode } from './abi.js';
import { signTransaction, verifyRpcTransaction, MAINNET_CHAIN_ID } from './tx.js';
import { walletFees, gasWithHeadroom, EthRpcError } from './rpc.js';
import { withEthKey } from './vault.js';
import { addToOutbox, updateOutbox } from './outbox.js';
import { assertNothingInDoubt, doubtOf } from './doubt.js';
import { ETH, TOKENS, tokenByAddress } from './tokens.js';
import { formatUnits } from './units.js';
import { ROUTES } from '../bridge/routes.js';
import { t } from '../i18n.js';

/** wei as ETH for an "up to" figure: rounded up at 8 places, never understated. */
function ethUp(wei) {
  const cut = 10n ** 10n;
  return formatUnits(wei % cut === 0n ? wei : wei + (cut - (wei % cut)), 18);
}

/** A plain ETH payment to an account without code always uses exactly this. */
export const ETH_TRANSFER_GAS = 21000n;

/** Above this share of the amount, the network fee is said in words and needs a tick before sending. */
export const HIGH_FEE_SHARE = 0.1;

/**
 * The network fee `fee` (wei) as a share of `amount` (wei of ETH), or null when there is
 * nothing to compare (a token, whose worth in ETH this wallet does not know).
 */
export function feeShare(fee, amount) {
  if (typeof amount !== 'bigint' || amount <= 0n || typeof fee !== 'bigint') return null;
  return Number((fee * 1000000n) / amount) / 1e6;
}

/** Whether a fee of this share needs the person's tick (feeShare above HIGH_FEE_SHARE). */
export const isHighFee = (share) => share != null && share > HIGH_FEE_SHARE;
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
    if (/^[0-9a-fA-F]{40}$/.test(a)) return { code: 'format', message: t('An Ethereum address starts with 0x. Copy it again from the person you are paying.') };
    return { code: 'format', message: t("This isn't an Ethereum address (0x and 40 letters and digits). Copy it again from the person you are paying.") };
  }
  if (!isAddress(a)) return { code: 'checksum', message: t("This address doesn't add up: one character looks mistyped. Copy it again rather than typing it.") };
  const low = a.toLowerCase();
  if (low === ZERO) return { code: 'zero', message: t('This is the zero address: coins sent to it are gone for good.') };
  if (own && low === own.toLowerCase()) return { code: 'own', message: t("This is this wallet's own address. Paste the receiver's address.") };
  if (BRIDGE_PIPES.includes(low)) return { code: 'bridge', message: t("This is the BEAM bridge's contract. Coins sent to it directly are lost; moving coins to BEAM needs the bridge, not a payment.") };
  const token = tokenByAddress(low);
  if (token) return { code: 'token', message: t("This is the {symbol} token's own contract. Coins sent to it are lost. Paste the receiver's address.", { symbol: token.symbol }) };
  return null;
}

/** {to, value, data} of a payment of `amount` of `asset` (ETH or a known token) to `recipient`. */
export function transferCall(asset, recipient, amount) {
  if (asset === ETH || asset.address == null) return { to: toChecksumAddress(recipient), value: amount, data: '0x' };
  if (!TOKENS.includes(asset)) throw new SendError('recipient', t('Only the tokens this wallet knows can be sent.'));
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
 * feeShare, highFee, preparedAt}. feeShare: the likely fee as a share of an ETH
 * amount (null for a token); highFee: above HIGH_FEE_SHARE, so the review asks
 * for a tick. Throws SendError with the reason in words.
 */
export async function prepareSend(rpc, { from, asset, recipient, amount, balances, now = Date.now() }) {
  const problem = recipientProblem(recipient, { own: from });
  if (problem) throw new SendError('recipient', problem.message || t('Enter the address to send to.'));
  if (typeof amount !== 'bigint' || amount <= 0n) throw new SendError('not_enough', t('The amount must be more than zero.'));
  const isEth = asset === ETH;
  const have = isEth ? balances.eth : balances[asset.symbol];
  if (have == null) throw new SendError('server', t('The balance is not known yet. Try again in a moment.'));
  if (!isEth && amount > have) throw new SendError('not_enough', t("That's more than you have ({amount}).", { amount: `${formatUnits(have, asset.decimals)} ${asset.symbol}` }));
  if (isEth && amount > have) throw new SendError('not_enough', t("That's more than you have ({amount}).", { amount: `${formatUnits(have, 18)} ETH` }));

  const call = transferCall(asset, recipient, amount);
  const fees = await walletFees(rpc);
  let estimate;
  try {
    estimate = await rpc.estimateGas({ from, to: call.to, data: call.data, value: call.value });
  } catch (e) {
    if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e; // the server, not the transaction
    if (isEth && /insufficient funds/i.test(e.message)) throw new SendError('not_enough', t('There is not enough ETH for the amount and the network fee.'));
    if (isEth && (await rpc.getCode(call.to)).length === 0) estimate = ETH_TRANSFER_GAS; // no code: it cannot refuse ETH
    else {
      const reason = revertText(e);
      throw new SendError('would_fail', reason ? t('Ethereum says this payment would fail ({reason}). Nothing was sent.', { reason }) : t('Ethereum says this payment would fail. Nothing was sent.'));
    }
  }
  if (!isEth) {
    // The exact call, as it will run: a token that answers false (or reverts) would take the fee and move nothing.
    let out;
    try {
      out = await rpc.ethCall({ from, to: call.to, data: call.data });
    } catch (e) {
      if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e;
      const reason = revertText(e);
      throw new SendError('would_fail', reason ? t('The {symbol} contract refuses this transfer ({reason}). Nothing was sent.', { symbol: asset.symbol, reason }) : t('The {symbol} contract refuses this transfer. Nothing was sent.', { symbol: asset.symbol }));
    }
    if (out.length > 0 && (out.length !== 32 || abiDecode('bool', out)[0] !== true)) throw new SendError('would_fail', t('The {symbol} contract refuses this transfer. Nothing was sent.', { symbol: asset.symbol }));
  }
  const gasLimit = estimate === ETH_TRANSFER_GAS && isEth ? ETH_TRANSFER_GAS : gasWithHeadroom(estimate);
  const upTo = gasLimit * fees.maxFeePerGas;
  let likely = estimate * (fees.baseFee + fees.maxPriorityFeePerGas);
  if (likely > upTo) likely = upTo;
  const eth = balances.eth ?? 0n;
  if (isEth && amount + upTo > eth) {
    const max = eth > upTo ? eth - upTo : 0n;
    throw new SendError('not_enough', t("With the network fee (up to {fee}) that's more than you have. You can send up to {max}.", { fee: `${ethUp(upTo)} ETH`, max: `${formatUnits(max, 18)} ETH` }));
  }
  if (!isEth && upTo > eth) throw new SendError('no_gas', t('The network fee is paid in ETH: up to {fee}, and this wallet has {balance}.', { fee: `${ethUp(upTo)} ETH`, balance: `${formatUnits(eth, 18)} ETH` }));
  return {
    asset,
    recipient: toChecksumAddress(recipient),
    amount,
    tx: { to: call.to, value: call.value, data: call.data, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
    gas: estimate,
    fees: { likely, upTo, baseFee: fees.baseFee, tip: fees.maxPriorityFeePerGas },
    feeShare: isEth ? feeShare(likely, amount) : null,
    highFee: isEth && isHighFee(feeShare(likely, amount)),
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
 * How long bytes a server refused stay open (entry.refusedAt), their hash checked and the bytes
 * offered again, before they count as never sent ('rejected'): 30 minutes.
 */
export const REFUSAL_WATCH_MS = 30 * 60 * 1000;

/**
 * Signs `prepared` (already reviewed and confirmed by the person), saves it,
 * broadcasts it. Returns {entry, sent, error}: sent false with error when the
 * broadcast did not go through. The entry stays open ('signed') either way:
 * a refusal sets entry.refusedAt, and only following it decides it was never
 * sent ('rejected'). Refused (doubt.js EthInDoubtError), before the key is
 * opened, while another transaction of this wallet is in doubt.
 */
export async function signAndSend(app, rpc, prepared, { ethId, kv, now = () => Date.now() } = {}) {
  await assertNothingInDoubt(app, { ethId, kv });
  const signed = await withEthKey(
    app,
    async ({ sk, address }) => {
      await rpc.assertMainnet();
      const nonce = await rpc.getTransactionCount(address, 'pending');
      const s = signTransaction({ chainId: MAINNET_CHAIN_ID, nonce, ...prepared.tx }, sk);
      if (s.from !== address) throw new SendError('server', t('The signature does not belong to this wallet.'));
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

/**
 * Sends an entry's saved bytes (again). Never re-signs. A server's refusal of bytes it was never
 * seen to hold is not final at once (entry.refusedAt): it may have passed them on before
 * refusing, or be lying. giveUp: the caller has just checked that the hash is unknown and the
 * nonce still free (followOnce), so once the bytes have been refused for REFUSAL_WATCH_MS they
 * are 'rejected': never sent.
 */
export async function broadcast(app, rpc, entry, { ethId, kv, now = () => Date.now(), giveUp = false } = {}) {
  try {
    await rpc.sendRawTransaction(entry.raw);
    const e = (await updateOutbox(app, entry.hash, { state: entry.state === 'signed' ? 'pending' : entry.state, sentAt: entry.sentAt || now(), error: null, refusedAt: null }, { ethId, kv })) || entry;
    return { entry: e, sent: true, error: null };
  } catch (err) {
    // A nonce already used is followOnce's to settle (mined, replaced or unsure), never a refusal.
    const nonceGone = serverRefused(err) && /nonce too low|already used|replacement/i.test(err.message);
    let patch = { error: err.message };
    if (serverRefused(err) && !nonceGone && entry.state === 'signed') {
      const since = entry.refusedAt || now();
      patch = giveUp && now() - since >= REFUSAL_WATCH_MS ? { state: 'rejected', error: err.message, refusedAt: since } : { error: err.message, refusedAt: since };
    }
    const e = (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
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
 *   'unsure'                not in any block, yet the server says nonce `nonce` is used up:
 *                           replaced, or the server is behind, confused or lying. Never
 *                           'replaced' on this alone (followOnce looks for the evidence).
 *   'unknown'               the server has never seen it: send the bytes again
 */
export function classify({ receipt, minedNonce, nonce, known, inBlock = false }) {
  if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
  if (inBlock) return 'pending';
  if (minedNonce > BigInt(nonce)) return 'unsure';
  if (!known) return 'unknown';
  return 'pending';
}

/** At most one search for what took an open transaction's nonce per this long (it can take ~50 requests). */
export const NONCE_LOOK_MS = 60000;
/** How far back the search doubles its step: 2^26 blocks, years of Ethereum. */
export const NONCE_SEARCH_STEPS = 26;
const lastLook = new Map(); // entry hash -> when its nonce was last looked into (ms)

/**
 * The lowest block at whose end `from` had sent more than `nonce` transactions: where the
 * transaction with that nonce was mined. null when the server contradicts itself. Asks for the
 * account's count at past blocks, which a server without old state refuses (it throws then).
 */
async function nonceBlock(rpc, from, nonce, maxSteps) {
  const head = await rpc.blockNumber();
  if ((await rpc.getTransactionCount(from, head)) <= nonce) return null;
  let hi = head;
  let lo = null;
  for (let i = 0, step = 1; i < maxSteps && hi > 0; i++, step *= 2) {
    const b = Math.max(0, hi - step);
    if ((await rpc.getTransactionCount(from, b)) <= nonce) {
      lo = b;
      break;
    }
    hi = b;
  }
  if (lo === null) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await rpc.getTransactionCount(from, mid)) > nonce) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The mined transaction that used `entry`'s nonce, as evidence: the server must show it, and
 * it must check out (tx.js verifyRpcTransaction: signed by this wallet's key, this nonce,
 * Ethereum mainnet) and have a receipt. Looked for among `candidates` (hashes the wallet already
 * knows: another outbox entry with the same nonce, the history index) and then in the block
 * where the account's count passed the nonce. Returns {hash, blockNumber, ours} (ours: it is this
 * very transaction, in a block whose receipt the server has not served yet), or null.
 */
export async function findNonceTaker(rpc, entry, { candidates = [], maxSteps = NONCE_SEARCH_STEPS } = {}) {
  const me = entry.from.toLowerCase();
  const nonce = BigInt(entry.nonce);
  const ownTx = (rtx) => {
    const v = verifyRpcTransaction(rtx);
    return v && v.from.toLowerCase() === me && v.nonce === nonce && v.chainId === MAINNET_CHAIN_ID ? v : null;
  };
  const mined = async (hash) => rpc.getTransactionReceipt(hash).catch(() => null);
  for (const c of new Set(candidates.map((h) => String(h).toLowerCase()))) {
    if (c === entry.hash) continue;
    const rtx = await rpc.getTransactionByHash(c).catch(() => null);
    const v = rtx && rtx.blockHash ? ownTx(rtx) : null;
    const receipt = v ? await mined(v.hash) : null;
    if (receipt) return { hash: v.hash, blockNumber: receipt.blockNumber, ours: false };
  }
  const n = await nonceBlock(rpc, entry.from, nonce, maxSteps);
  if (n === null) return null;
  const block = await rpc.getBlockByNumber(n, true);
  for (const rtx of (block && block.transactions) || []) {
    const v = ownTx(rtx);
    if (!v) continue;
    if (v.hash === entry.hash) return { hash: v.hash, blockNumber: n, ours: true };
    const receipt = await mined(v.hash);
    return receipt ? { hash: v.hash, blockNumber: receipt.blockNumber, ours: false } : null;
  }
  return null;
}

/**
 * One look at an open entry: asks the server, updates the outbox, sends the
 * same bytes again when the server has forgotten them. Returns the entry.
 * candidates: hashes that may have taken this entry's nonce (findNonceTaker()).
 */
export async function followOnce(app, rpc, entry, { ethId, kv, candidates = [], now = () => Date.now() } = {}) {
  if (entry.state !== 'signed' && entry.state !== 'pending') return entry;
  const minedNonce = await rpc.getTransactionCount(entry.from, 'latest');
  const receipt = await rpc.getTransactionReceipt(entry.hash);
  const tx = receipt ? null : await rpc.getTransactionByHash(entry.hash);
  let state = classify({ receipt, minedNonce, nonce: entry.nonce, known: Boolean(receipt || tx), inBlock: Boolean(tx && tx.blockHash) });
  if (state === 'unsure') {
    const at = now();
    if (at - (lastLook.get(entry.hash) ?? -Infinity) < NONCE_LOOK_MS) return entry; // looked a moment ago: nothing new to prove
    lastLook.set(entry.hash, at);
    const taker = await findNonceTaker(rpc, entry, { candidates }).catch(() => null);
    if (taker && taker.ours) state = 'pending'; // ours is in that block: its receipt is on its way
    else if (taker) {
      lastLook.delete(entry.hash);
      const patch = { state: 'replaced', replacedBy: taker.hash, replacedIn: taker.blockNumber, unsureSince: null, refusedAt: null };
      return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
    } else {
      // The server's word alone. The payment stays open and its same bytes are offered again:
      // a server that lost them takes them back, one whose nonce really moved on refuses them.
      const sent = (await broadcast(app, rpc, entry, { ethId, kv, now })).entry;
      if (sent.state !== 'signed' && sent.state !== 'pending') return sent;
      // This look failed as the ones before it did: written down, so a day of them can be told
      // (lib/eth/doubt.js mayForget; at most once per NONCE_LOOK_MS, as the look itself).
      const patch = { unsureSince: sent.unsureSince || at, doubtLookAt: at };
      return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...sent, ...patch };
    }
  }
  lastLook.delete(entry.hash);
  // Unknown to the server and its nonce still free: the bytes go again, and a refusal that has
  // lasted REFUSAL_WATCH_MS ends it as never sent.
  if (state === 'unknown') {
    const b = await broadcast(app, rpc, entry, { ethId, kv, now, giveUp: true });
    const sent = b.entry;
    // Still in doubt (refused: a server that says the nonce is free yet refuses the bytes as used;
    // or "Not sure yet" from an earlier look that this server neither confirms nor clears): written
    // down at most once per NONCE_LOOK_MS, as above. Every look that leaves it in doubt counts, or a
    // doubt looked at only this way could never be forgotten (lib/eth/doubt.js mayForget, RE3-2).
    const at = now();
    if (b.sent || doubtOf(sent) === null || at - (sent.doubtLookAt ?? -Infinity) < NONCE_LOOK_MS) return sent;
    return (await updateOutbox(app, entry.hash, { doubtLookAt: at }, { ethId, kv })) || { ...sent, doubtLookAt: at };
  }
  if (state === 'pending') return entry.state === 'pending' && !entry.unsureSince && !entry.refusedAt ? entry : (await updateOutbox(app, entry.hash, { state: 'pending', unsureSince: null, refusedAt: null }, { ethId, kv })) || entry;
  const patch = receipt ? minedPatch(receipt) : { state, unsureSince: null, refusedAt: null };
  return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
}

/** The outbox patch for a transaction whose receipt the server served: mined, confirmed or failed, nothing in doubt. */
export function minedPatch(receipt) {
  return {
    state: receipt.status === 1 ? 'confirmed' : 'failed',
    unsureSince: null,
    refusedAt: null,
    receipt: { blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: String(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice == null ? null : String(receipt.effectiveGasPrice) },
  };
}

/** The fee an entry paid (mined) or may pay at most (open): {wei, final}. */
export function entryFee(entry) {
  const r = entry.receipt;
  if (r && r.gasUsed && r.effectiveGasPrice) return { wei: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), final: true };
  return { wei: BigInt(entry.gasLimit || 0) * BigInt(entry.maxFeePerGas || 0), final: false };
}
