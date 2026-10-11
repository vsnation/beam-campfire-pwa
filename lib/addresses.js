// This wallet's own BEAM addresses: which can still be paid, which one Receive
// shows, and their labels. A port of the desktop's BeamReceiveModel /
// BeamReceiveText (lib/widgets/beam/receive/beam_receive_model.dart,
// beam_receive_text.dart). Pure, except the wallet calls at the end.
//
// The engine's addr_list (own: true) gives each address: address, comment (its
// label), create_time (s), duration (s, 0 = never expires), expired, own, type.
// edit_address changes a label (own addresses only); delete_address forgets one,
// after which new payments to it no longer reach this wallet.

export const LABEL_MAX = 64; // the desktop's label field (maxLength 64)

/** Address types as a person would say them (BeamReceiveText.typeLabel). */
export function typeLabel(type) {
  switch (type) {
    case 'regular':
      return 'Regular';
    case 'regular_new':
      return 'Regular, with proof';
    case 'offline':
      return 'Offline';
    case 'max_privacy':
      return 'Max privacy';
    case 'public_offline':
      return 'Public';
    default:
      return 'Other';
  }
}

/** Only a regular address can be the one Receive shows (the desktop's rule: offline ones are for one payment). */
export const canBeCurrent = (a) => Boolean(a && a.own !== false && !a.expired && (a.type === 'regular' || a.type === 'regular_new'));

/** A label as it is kept: printable, single spaces, at most LABEL_MAX characters. */
export function cleanLabel(raw) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, LABEL_MAX).join('');
}

const newestFirst = (list) => [...list].sort((a, b) => (Number(b.create_time) || 0) - (Number(a.create_time) || 0));

/** Own addresses split into active and expired, each newest first. */
export function splitAddresses(list) {
  const own = (Array.isArray(list) ? list : []).filter((a) => a && a.own !== false && typeof a.address === 'string');
  return { active: newestFirst(own.filter((a) => !a.expired)), expired: newestFirst(own.filter((a) => a.expired)) };
}

/**
 * The address Receive shows: the one the person chose (when it is still theirs and
 * can be paid), else the newest regular one BEAM Campfire made for Receive, else
 * null (Receive makes one). `label` is the label lib/wallet.js gives its addresses.
 */
export function pickReceiveAddress(list, { preferred = null, label = null } = {}) {
  const { active } = splitAddresses(list);
  if (preferred) {
    const p = active.find((a) => a.address === preferred);
    if (p && canBeCurrent(p)) return p.address;
  }
  const mine = active.filter((a) => a.type === 'regular' && (label == null || a.comment === label));
  return mine.length ? mine[0].address : null;
}

const fmtDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "Created 22 Jun 2024 · Never expires" and the like (BeamReceiveText.lifetime). */
export function lifetime(a, { day = fmtDay } = {}) {
  const created = Number(a.create_time) || 0;
  const duration = Number(a.duration) || 0;
  const parts = [created ? `Created ${day(created)}` : 'Created earlier'];
  if (!duration) parts.push(a.expired ? 'Expired' : 'Never expires');
  else parts.push(`${a.expired ? 'Expired' : 'Expires'} ${day(created + duration)}`);
  return parts.join(' · ');
}

/** "3f25d94eac…c9df9477": the full address is one tap away (copy). */
export function shortAddress(address, keep = 10) {
  const s = String(address || '');
  return s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** A payment to or from this address that has not finished: deleting it now would strand the payment. */
export function busyWith(address, txs) {
  return (txs || []).some((t) => {
    const s = Number(t.status);
    const pending = s === 0 || s === 1 || s === 5;
    return pending && (t.receiver === address || t.sender === address);
  });
}

export const ADDRESS_TEXT = Object.freeze({
  deleteTitle: 'Delete this address?',
  deleteBody: "Payments sent to it after this won't reach your wallet. Your balance and past payments stay as they are.",
  deleteBusy: 'A payment to this address is still under way. Delete it once that payment has finished.',
  deleted: 'Address deleted',
  labelSaved: 'Label saved',
  current: 'Shown on Receive',
  madeCurrent: 'Receive now shows this address',
  noLabel: 'No label',
  labelHint: 'e.g. From Alex',
});

// ---------------------------------------------------------------- the wallet

export async function listOwn(session) {
  const list = await session.call('addr_list', { own: true }, { timeoutMs: 20000 });
  return Array.isArray(list) ? list : [];
}

export async function renameAddress(session, address, label) {
  return session.call('edit_address', { address, comment: cleanLabel(label) }, { timeoutMs: 20000 });
}

export async function deleteAddress(session, address) {
  return session.call('delete_address', { address }, { timeoutMs: 20000 });
}
