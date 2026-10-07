// Importing a BEAM wallet.db: the checks that need no engine, and the words
// the person sees. Pure functions, unit-tested (test/unit/wallet_file.test.mjs).
//
// What a real BEAM wallet.db looks like (measured on 2026-10-07: files from
// BEAM's desktop wallet 7.5.13840, LightWallet 7.5.13882 and the 7.5.14493
// CLI): an SQLCipher 4 database, so it does NOT start with "SQLite format 3"
// (the first 16 bytes are a random salt) and its size is a whole number of
// 4096-byte pages. SQLite never writes a partial page and its smallest page
// is 512 bytes, so "size is a multiple of 512" holds for every SQLite file,
// encrypted or not; anything else is not a database at all. Nothing else is
// checked here: only BEAM's engine, opening the file with the password, can
// tell a wallet from another encrypted file.

export const MIN_WALLET_BYTES = 1024;
export const MAX_WALLET_BYTES = 512 * 1024 * 1024;
const SQLITE_PAGE_MIN = 512;
// SecString::MAX_SIZE in BEAM is 4096 bytes and silently truncates longer passwords.
export const MAX_PASSWORD_BYTES = 4095;

const PLAIN_SQLITE = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

/** The words of the import flow, kept together (and tested). Matches the desktop app's BeamImportText/BeamImportMessages. */
export const IMPORT_TEXT = Object.freeze({
  title: 'Import wallet.db',
  intro: 'Already have a BEAM wallet as a wallet.db file? Choose it and enter its password. BEAM Campfire makes its own copy; your file is not changed.',
  choose: 'Choose wallet.db',
  change: 'Choose another file',
  untouched: 'your file is not changed',
  where: 'Put the file on this device first (on iPhone: AirDrop, iCloud Drive or the Files app). BEAM desktop wallet, Light Wallet and the BEAM CLI all name it wallet.db.',
  copyWarning: 'Copy wallet.db while the BEAM wallet app it comes from is closed. If that wallet spends coins after your copy was made, payments from here can fail until you import a newer copy.',
  passwordLabel: 'Wallet password',
  passwordHelper: 'The password you set in the BEAM wallet this file comes from.',
  noPhrase: 'This wallet will have no recovery phrase (12 words) in BEAM Campfire. Keep the original file and its password safe: they are how you get it back.',
  cta: 'Import my wallet',
  checking: 'Checking the password…',
  saving: 'Saving the wallet on this device…',
  reading: 'Reading the file…',
});

/** Problems, in words for the person who picked the file. Never blames; always says what to do next. */
export const IMPORT_PROBLEM = Object.freeze({
  empty: 'This file is empty. Choose the wallet.db file from your BEAM wallet.',
  tooSmall: 'This file is too small to be a BEAM wallet. Choose the wallet.db file from your BEAM wallet.',
  tooBig: 'This file is larger than 512 MB, more than a phone can open as a wallet. Check that it is the wallet.db file.',
  notDatabase: "This file isn't a BEAM wallet.db. Choose the wallet.db file from your BEAM wallet's folder.",
  wrongPassword: "That password doesn't open this wallet file. Check it (it is the password you set in the BEAM wallet this file comes from) and try again. If it still fails, the file may not be a BEAM wallet.",
  noPassword: 'Enter the wallet password.',
  passwordTooLong: 'That password is longer than BEAM accepts. Check it and try again.',
  gone: 'BEAM Campfire could not read that file. Choose it again; if it is in iCloud Drive, let it download first.',
  failed: 'Importing the wallet did not work. Nothing was changed; try again.',
  exists: 'There is already a wallet on this device. Delete it first (Settings → Delete wallet), then import the file.',
  slow: 'Checking the file took too long. Nothing was changed; try again.',
});

/** Shown wherever a phrase wallet would show, back up or verify its 12 words. Same words as the desktop NoRecoveryPhraseNotice. */
export const NO_PHRASE_NOTICE =
  'This wallet was imported from its wallet.db file and has no recovery phrase in BEAM Campfire. Its original file and password are its backup: keep them safe.';

/**
 * First look at a picked file, before anything is read into the engine.
 * @param {{size:number, head?:Uint8Array|null}} f  size in bytes; head = the first bytes, if read
 * @returns {{ok:true, plainSqlite:boolean} | {ok:false, problem:string, code:string}}
 */
export function checkWalletFile({ size, head = null }) {
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'gone', problem: IMPORT_PROBLEM.gone };
  if (size === 0) return { ok: false, code: 'empty', problem: IMPORT_PROBLEM.empty };
  if (size < MIN_WALLET_BYTES) return { ok: false, code: 'tooSmall', problem: IMPORT_PROBLEM.tooSmall };
  if (size > MAX_WALLET_BYTES) return { ok: false, code: 'tooBig', problem: IMPORT_PROBLEM.tooBig };
  if (size % SQLITE_PAGE_MIN !== 0) return { ok: false, code: 'notDatabase', problem: IMPORT_PROBLEM.notDatabase };
  return { ok: true, plainSqlite: isPlainSqlite(head) };
}

/** True for an unencrypted SQLite file. BEAM's are encrypted, but that alone is not reason to refuse one. */
export function isPlainSqlite(head) {
  if (!head || head.length < PLAIN_SQLITE.length) return false;
  return PLAIN_SQLITE.every((b, i) => head[i] === b);
}

/** @returns null when the password can be tried, else the problem text. Never echoes the password. */
export function importPasswordProblem(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return IMPORT_PROBLEM.noPassword;
  if (new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) return IMPORT_PROBLEM.passwordTooLong;
  return null;
}

/** "196 KB", "1.6 MB": for the file card. */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1e6) return `${Math.round(bytes / 1000)} KB`;
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The wallet record for an imported wallet.db (see store.js). No phrase, no block scan. */
export function importedRecord(id, passwordEnvelope, now = Date.now()) {
  return { id, createdAt: now, restored: false, imported: true, scan: false, envelopes: { password: passwordEnvelope, passkey: null }, setupDone: false };
}
