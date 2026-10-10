// "Show owner key" (Settings -> Backup): the wording, and what a key from the
// engine must look like before it is shown. Pure, so the unit tests read it.
//
// The key is BEAM's KeyString (core/block_rw.cpp), as `beam-wallet
// export_owner_key` prints it: base64 of an 8-byte MAC, then, encrypted with
// the password, 'P', the 98-byte packed public key generator (HKdfPub: a
// secret and two compressed points) and the meta "0". So 108 bytes, 144
// base64 characters.

export const OWNER_KEY_BYTES = 8 + 1 + 98 + 1;

export const OWNER_KEY_TEXT = Object.freeze({
  title: 'Owner key',
  lead: 'With this key, a BEAM node you run finds every payment to this wallet, including offline and max-privacy ones.',
  whatTitle: 'What it can and can’t do',
  can: 'Whoever has it can see your balance and your payment history.',
  cannot: 'It can’t spend or move your coins.',
  copies: 'It covers every copy of this wallet, on any device.',
  share: 'Give it only to a node you run yourself. Don’t share it with anyone.',
  passwordLabel: 'Your BEAM Campfire password',
  passwordHint: 'The key is locked with this password. Your node needs the same one.',
  faceIdHint: 'Then confirm with Face ID.',
  cta: 'Show owner key',
  shownLead: 'Copy it into your node’s settings, and start the node with the same password you just entered.',
  shownWarn: 'Anyone with this key can see your balance and history. Keep it private.',
  copyCta: 'Copy owner key',
  copied: 'Owner key copied',
  done: 'Done',
  backupTitle: 'Owner key',
  backupText: 'For running your own BEAM node: with this key it finds every payment to this wallet, including offline and max-privacy ones. It can see your coins, not spend them.',
  backupCta: 'Show owner key',
});

/** True for a string shaped like an exported owner key (standard base64, 108 bytes). */
export function looksLikeOwnerKey(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return false;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad === OWNER_KEY_BYTES;
}
