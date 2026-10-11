// Everything around a payment that is not the payment itself: its note, its
// payment proof, its place in a block explorer, and removing its record. A port
// of the desktop app's BeamTxActions / BeamProofVerdict / BeamTxText
// (lib/wallets/beam/tx/beam_tx_actions.dart, lib/widgets/beam/tx/beam_tx_text.dart),
// checked against BEAM's core (tag beam-7.5.14493) where the two disagree:
//
// * A note is the transaction's comment (tx_send "comment" → TxParameterID::Message).
//   BEAM keeps it in this wallet only: SimpleTransaction::SendToPeer sends the
//   receiver amount, asset, fee, heights and keys, never the message, and the
//   receiver's copy takes its comment from the label of its own address
//   (Wallet::OnMessage). The desktop says "The receiver sees it too"; it does not.
// * verify_payment_proof checks the receiver's signature on this device and asks
//   no node (V6Api::onHandleVerifyPaymentProof only parses PaymentInfo). The
//   desktop says it "checks it against the BEAM network"; the words here say what
//   it does, and offer the explorer for "is it in a block".
// * export_payment_proof answers an empty string, not an error, when the payment
//   has no receiver signature (an old-style address): that is "no proof".
// Pure: no DOM, no engine. Screens call the wallet through the functions at the end.

export const NOTE_MAX = 256; // the desktop's comment field (maxLength 256)

/** BEAM's explorer, as the desktop links it (Beam.defaultBlockExplorer, from TxTable.qml). */
export const EXPLORER_HOST = 'explorer.beam.mw';
const EXPLORER_TX = 'https://explorer.beam.mw/block?kernel_id=';

// Transaction states as the engine numbers them (wallet/core/common.h TxStatus).
export const TX = Object.freeze({ pending: 0, inProgress: 1, cancelled: 2, completed: 3, failed: 4, registering: 5 });
const SIMPLE = 0;
const PUSH = 7; // offline, max privacy and public offline payments

/**
 * A note as it is kept: printable characters only (no line breaks, no control or
 * direction characters), single spaces, at most NOTE_MAX characters.
 */
export function cleanNote(raw) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, NOTE_MAX).join('');
}

/** What the note field says under itself. Name payments are contract calls, which carry none. */
export function noteHint({ toName = false } = {}) {
  return toName ? "A payment to a name can't keep a note." : "BEAM doesn't send it to the receiver.";
}

export const ADDRESS_COMMENT = 'BEAM Campfire'; // lib/wallet.js labels the addresses it makes with this

/**
 * The note line a payment shows, or null: what the person wrote on a payment they
 * sent; on one they received, the label of their own address it came to (BEAM puts
 * that there), unless it is the label BEAM Campfire gives its own addresses.
 */
export function txNote(tx) {
  if (!tx || Number(tx.tx_type) === 12) return null;
  const c = cleanNote(tx.comment);
  if (!c) return null;
  if (tx.income) return c === ADDRESS_COMMENT ? null : { label: 'Your address label', text: c };
  return { label: 'Note', text: c };
}

export function isSelfTx(tx) {
  return /own address|self sending/i.test(String((tx && tx.status_string) || ''));
}

/** The core's canDelete (common.cpp TxDescription::canDelete): only a finished record. */
export function canDeleteTx(tx) {
  const s = Number(tx && tx.status);
  return s === TX.cancelled || s === TX.completed || s === TX.failed;
}

/** A proof exists only for a completed payment this wallet sent to someone else (V6Api::onHandleExportPaymentProof). */
export function canExportProof(tx) {
  if (!tx || tx.income || isSelfTx(tx)) return false;
  return Number(tx.status) === TX.completed && [SIMPLE, PUSH].includes(Number(tx.tx_type));
}

/** The receiver is the one a sender hands a proof to: offered on a completed payment received. */
export function canCheckProof(tx) {
  return Boolean(tx && tx.income && Number(tx.status) === TX.completed && [SIMPLE, PUSH].includes(Number(tx.tx_type)) && !isSelfTx(tx));
}

/** A real kernel id: 64 hex characters, not all zeros (the engine writes zeros before there is one). */
export function hasKernel(kernel) {
  return typeof kernel === 'string' && /^[0-9a-f]{64}$/i.test(kernel) && /[1-9a-f]/i.test(kernel);
}

/** The explorer page of a transaction, by its kernel id; null when there is none. */
export function explorerUrl(kernel) {
  return hasKernel(kernel) ? `${EXPLORER_TX}${kernel.toLowerCase()}` : null;
}

export const EXPLORER_NOTE = `Opens ${EXPLORER_HOST} in your browser. It sees your IP address and which transaction you looked up; BEAM Campfire sends it nothing.`;

/** "a1b2c3d4…e5f6a7" (the desktop's BeamTxText.short). */
export function short(s, head = 8, tail = 6) {
  s = String(s || '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// ------------------------------------------------------------------ proofs

export const PROOF_MAX_HEX = 4096; // a proof is about 300 hex characters; a paste longer than this is something else

/**
 * What a person pasted, as the hex string verify_payment_proof takes, or a
 * problem. Spaces and line breaks (a proof split by a chat app) are dropped.
 */
export function parseProofInput(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return { ok: false, problem: 'empty' };
  if (s.length > PROOF_MAX_HEX || !/^[0-9a-fA-F]+$/.test(s) || s.length % 2 || s.length < 64) return { ok: false, problem: 'notProof' };
  return { ok: true, hex: s.toLowerCase() };
}

export const PROOF_TEXT = Object.freeze({
  notProof: 'This text is not a payment proof. Ask the sender to send the whole proof again.',
  invalid: 'This proof is not valid. It does not show that the payment happened.',
  none: "No payment proof exists for this payment: the receiver's address does not give one.",
  notConnected: 'The wallet is not ready yet. Try again in a moment.',
  exportIntro: 'Send this to the receiver, or to anyone who needs to see that you paid. It shows the amount, the two wallets’ public IDs and the transaction ID. Nothing else: not your balance, not your other payments.',
  checkIntro: 'Paste the proof the sender gave you.',
  howChecked: "Checked on this device: the receiver's wallet signed it. To see the payment in a block, open its transaction ID in the explorer.",
});

/**
 * The core's verify_payment_proof answer, in words (the desktop's BeamProofVerdict).
 * mine: identities of this wallet's own addresses (addr_list "identity"), so a
 * proof of a payment to this wallet says "to you"; names: identity → a contact's
 * name. describe(amount, assetId) formats the amount with its asset.
 */
export function proofVerdict(info, { mine = [], names = new Map(), describe = (a, id) => `${a} #${id}` } = {}) {
  if (!info || typeof info !== 'object' || info.is_valid !== true) return { valid: false, sentence: PROOF_TEXT.invalid };
  let amount;
  try {
    amount = BigInt(info.amount);
  } catch {
    return { valid: false, sentence: PROOF_TEXT.invalid };
  }
  const assetId = Number(info.asset_id) || 0;
  const sender = String(info.sender || '');
  const receiver = String(info.receiver || '');
  const kernel = String(info.kernel || '');
  const own = new Set(mine.map((m) => String(m).toLowerCase()));
  const toYou = own.has(receiver.toLowerCase());
  const fromYou = own.has(sender.toLowerCase());
  const what = describe(amount, assetId);
  const senderName = names.get(sender.toLowerCase()) || null;
  const receiverName = names.get(receiver.toLowerCase()) || null;
  const from = fromYou ? 'you' : senderName || short(sender);
  const to = toYou ? 'you' : receiverName || short(receiver);
  return { valid: true, toYou, fromYou, senderName, receiverName, amount, assetId, sender, receiver, kernel, sentence: `Valid: ${what} was paid from ${from} to ${to} (transaction ID ${short(kernel)}).` };
}

// ---------------------------------------------------------------- deleting

export const REMOVE_TEXT = Object.freeze({
  title: 'Remove this payment from your list?',
  body: 'Only this wallet’s record goes. Nothing changes on the blockchain and no money moves.',
  proofToo: 'Its payment proof goes with it: get the proof first if you may need it.',
  confirm: 'Remove from list',
  keep: 'Keep it',
  done: 'Removed from your list',
  refused: 'This payment is still under way, so it stays in the list until it finishes.',
});

// ---------------------------------------------------------------- the wallet

/** export_payment_proof: the proof's hex, or null when the payment has none. */
export async function exportProof(session, txId) {
  const r = await session.call('export_payment_proof', { txId }, { timeoutMs: 20000 });
  const hex = r && typeof r.payment_proof === 'string' ? r.payment_proof.trim() : '';
  return /^[0-9a-f]+$/i.test(hex) ? hex : null;
}

/** verify_payment_proof on a parsed paste: the core's answer, or {parseError: true} when it is not a proof at all. */
export async function verifyProof(session, hex) {
  try {
    return await session.call('verify_payment_proof', { payment_proof: hex }, { timeoutMs: 20000 });
  } catch (e) {
    if (e && e.code === 'rpc') return { parseError: true };
    throw e;
  }
}

/**
 * This wallet's identities, for "you" on a proof: its own addresses' (addr_list),
 * and the ones its payments used (tx_list: sender_identity of what it sent,
 * receiver_identity of what it received), which old addresses do not list.
 */
export async function ownIdentities(session, txs = []) {
  const list = await session.call('addr_list', { own: true }, { timeoutMs: 20000 });
  const ids = [];
  for (const a of Array.isArray(list) ? list : []) ids.push(a && a.identity, identityOf(a && a.wallet_id), identityOf(a && a.address));
  for (const t of txs || []) {
    if (!t) continue;
    ids.push(t.income ? t.receiver_identity : t.sender_identity, identityOf(t.income ? t.receiver : t.sender));
  }
  return [...new Set(ids.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()))];
}

/**
 * The key a proof names for an old-style address (a BEAM wallet id: a channel number
 * and a 32-byte key, written in hex): its last 64 hex characters. Measured: a proof of a
 * payment to 1bd07c7b7e…3ccbe802 names its receiver 7c7b7e3b42…3ccbe802. Null for
 * anything else (a new-style address does not show its key).
 */
export function identityOf(address) {
  const a = String(address || '').toLowerCase();
  return /^[0-9a-f]{65,72}$/.test(a) ? a.slice(-64) : null;
}

/** The payment in this wallet's list with the proof's kernel, or null. */
export function paymentWithKernel(txs, kernel) {
  if (!hasKernel(kernel)) return null;
  const k = kernel.toLowerCase();
  return (txs || []).find((t) => typeof t.kernel === 'string' && t.kernel.toLowerCase() === k) || null;
}

/** tx_delete: true once the record is gone. */
export async function deleteTx(session, txId) {
  const r = await session.call('tx_delete', { txId }, { timeoutMs: 20000 });
  return r === true || (r && r.result === true) || r === 'done';
}
