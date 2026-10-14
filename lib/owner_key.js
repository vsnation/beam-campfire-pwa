// "Show owner key" (Settings -> Backup): the wording, and what a key from the
// engine must look like before it is shown. Pure, so the unit tests read it.
//
// The key is BEAM's KeyString (core/block_rw.cpp), as `beam-wallet
// export_owner_key` prints it: base64 of an 8-byte MAC, then, encrypted with
// the password, 'P', the 98-byte packed public key generator (HKdfPub: a
// secret and two compressed points) and the meta "0". So 108 bytes, 144
// base64 characters.

import { tk } from './i18n.js';

export const OWNER_KEY_BYTES = 8 + 1 + 98 + 1;

// The screens show these with t() (screens/owner_key.js, screens/backup.js).
export const OWNER_KEY_TEXT = Object.freeze({
  title: tk('Owner key'),
  lead: tk('With this key, a BEAM node you run finds every payment to this wallet, including offline and max-privacy ones.'),
  whatTitle: tk('What it can and can’t do'),
  can: tk('Whoever has it can see your balance and your payment history.'),
  cannot: tk('It can’t spend or move your coins.'),
  copies: tk('It covers every copy of this wallet, on any device.'),
  share: tk('Give it only to a node you run yourself. Don’t share it with anyone.'),
  passwordLabel: tk('Your BEAM Campfire password'),
  passwordHint: tk('The key is locked with this password. Your node needs the same one.'),
  faceIdHint: tk('Then confirm with Face ID.'),
  cta: tk('Show owner key'),
  shownLead: tk('Copy it into your node’s settings, and start the node with the same password you just entered.'),
  shownWarn: tk('Anyone with this key can see your balance and history. Keep it private.'),
  copyCta: tk('Copy owner key'),
  copied: tk('Owner key copied'),
  done: tk('Done'),
  backupTitle: tk('Owner key'),
  backupText: tk('For running your own BEAM node: with this key it finds every payment to this wallet, including offline and max-privacy ones. It can see your coins, not spend them.'),
  backupCta: tk('Show owner key'),
});

/** True for a string shaped like an exported owner key (standard base64, 108 bytes). */
export function looksLikeOwnerKey(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return false;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad === OWNER_KEY_BYTES;
}
