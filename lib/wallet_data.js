// "Move names, notes and history" (Settings -> Backup, issue #55): the rules, with no engine and
// no screen. Pure functions, unit-tested (test/unit/wallet_data.test.mjs); lib/wallet_data_io.js
// runs them against the wallet.
//
// The file is BEAM's own wallet data JSON, the one BEAM's desktop wallet ("Export wallet data")
// and CLI (export_data / import_data) write: storage::ExportDataToJson in wallet/core/wallet_db.cpp,
// reached through wasm patch 0110. Three lists:
//   OwnAddresses           this wallet's addresses: WalletID (hex), Index (the key index BEAM
//                          derives it from), Label (its name), CreationTime, Duration, Category,
//                          Address (the address as given out), Identity
//   Contacts               other people's addresses, the same fields, Index 0
//   TransactionParameters  every stored parameter of every payment: TransactionId (16 bytes),
//                          SubTransactionId, ParameterId, Value (bytes). Parameter 0 on sub 1 is
//                          the type, 5 the note (the "comment", UTF-8), 151 the status.
// No keys and no coins: the 12 words or wallet.db stay the backup. Anyone with the file sees every
// payment, amount, date, note and address in it, and can spend nothing.
//
// What BEAM does with it on import (ImportDataFromJson, read in wallet_db.cpp):
//   - an own address is kept only if BEAM derives the same address from THIS wallet's seed at that
//     Index (ValidateSbbsWalletID); the first one that fails stops the whole import, so a file of
//     another wallet adds nothing;
//   - a payment is refused if its address does not belong to this seed; the others go in;
//   - an entry already here is overwritten with the file's copy (a label renamed since, or a payment
//     that has finished since, would go back). BEAM Campfire hands over only what is NOT here yet
//     (planImport), so nothing in the wallet changes and a second import adds nothing.
//   - BEAM's JSON reader trusts the file's shape: a missing field is undefined behaviour in C++, so
//     every entry is checked here before any byte reaches the engine (parseWalletData).
//   - BEAM resumes, at the next start, every stored transaction whose status is pending, in progress,
//     registering or confirming, or that has no status at all (TxDescription::canResume; the default
//     status is Pending): it builds and signs it from its stored parameters, with no consent screen.
//     For a contract call those parameters include the call itself (invoke data). A crafted file could
//     so make the wallet sign a payment or a contract call nobody approved. BEAM Campfire brings in only
//     transactions that are over: status cancelled, completed or failed, read from the file
//     (finishedStatus); anything else is left out and the preview says how many. A finished payment
//     is history only: BEAM never starts it again.
//   - BEAM's writer and reader disagree on a payment that failed before it started: it is written
//     with the key index of its address (MyAddressID) but not the address (MyID), and the reader
//     refuses exactly that (measured with BEAM's CLI: import_data exits -1). BEAM Campfire drops that
//     index from such payments, in the files it saves and in the ones it brings in (groupTxs).
// The engine runs in a fixed 100 MB heap (wasm, no growth) and its reader holds the whole text
// as a JSON tree: measured on 2026-10-11, an 11 MB file imported, a 14.7 MB one stopped the engine
// (out of memory); an export of 7.5 MB worked and one of 10 MB stopped it. So an import goes in
// pieces of at most CHUNK_MAX_BYTES, and an export the engine cannot hold is refused before it is
// tried (exportFits), unless the engine can export in pages (wasm patch 0111).
//
// BEAM Campfire adds its own part, under the key EXTRAS_KEY, for what BEAM's file lacks: the
// address book (lib/contacts.js) and the hidden tokens (lib/hidden_tokens.js). BEAM's reader
// ignores keys it does not know, so the desktop wallet and the CLI import the file as usual.
// Contacts: BEAM's own Contacts list is not an address book a person kept. BEAM saves every address
// it pays, named after the payment's note (wallet.cpp: SavePeerAddress), so in a file from BEAM
// Campfire the address book is the extras part, and BEAM's list only goes back into wallet.db. A
// file from BEAM's desktop wallet or CLI has no extras part: there BEAM's list IS the contacts the
// person sees (the desktop's Contacts tab), and its named entries also go into the address book.

import { ADDRESS_COMMENT } from './payments.js';
import { checkContact, cleanName, cleanAddress, looksLikeAddress, findByAddress, lookalikeOf, CONTACTS_MAX } from './contacts.js';
import { parseHidden } from './tokens.js';
import { t, tn, tk } from './i18n.js';

export const DATA_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** One engine import call at most this much JSON (measured: 11 MB fits a fresh wallet's heap, 14.7 MB does not). */
export const CHUNK_MAX_BYTES = 1500 * 1000;
/** An export the engine is trusted to hold in one piece (measured: 7.5 MB worked, 10 MB ran out of memory). */
export const EXPORT_SAFE_BYTES = 6 * 1000 * 1000;
/** Bytes a payment takes in the file, on average, for the estimate (real wallets: 15-37 KB, failed ones 3 KB). */
export const EXPORT_BYTES_PER_TX = 30 * 1000;
export const EXPORT_BYTES_PER_ADDRESS = 400;
export const EXTRAS_KEY = 'BeamCampfire';
export const EXTRAS_VERSION = 1;

const DEFAULT_SUB_TX = 1; // kDefaultSubTxID in BEAM
const P_TYPE = 0; // TxParameterID::TransactionType
const P_MESSAGE = 5; // TxParameterID::Message: the note
const P_STATUS = 151; // TxParameterID::Status
/** TxStatus values that are over: Canceled 2, Completed 3, Failed 4 (wallet/core/common.h). */
const FINISHED = new Set([2, 3, 4]);
const P_MY_ID = 6; // TxParameterID::MyID (MyAddr): this wallet's address in the payment
const P_MY_ADDRESS_ID = 158; // TxParameterID::MyAddressID: the key index of that address
// Labels BEAM and this app give addresses by themselves: not names a person chose.
const AUTO_LABELS = new Set(['', 'default', ADDRESS_COMMENT]);
const LABEL_MAX_CHARS = 1024;
const TEXT_FIELD_MAX = 4096;
const HEX = /^[0-9a-f]+$/i;

/** BEAM's own name for the file (TimestampFile("export.dat"): the desktop wallet and the CLI): export<seconds>.dat. */
export function dataFileName(now = Date.now()) {
  return `export${Math.floor(now / 1000)}.dat`;
}

/** The words of the card and its sheets, kept together (and tested). Shown with t(DATA_TEXT.title). */
export const DATA_TEXT = Object.freeze({
  title: tk('Move names, notes and history'),
  lead: tk('Your 12 words bring back your coins, not your address names, payment notes, contacts or payment history. Save them to a file, then bring them into BEAM Campfire on your new device, or into BEAM’s desktop wallet.'),
  reveals: tk('The file shows every payment in it, with amounts, dates, notes and addresses, to anyone who gets it. It holds no keys: nobody can spend your coins with it.'),
  // A wallet imported from its wallet.db has no 12 words here; its wallet.db carries all of this already.
  leadImported: tk('Your address names, payment notes, contacts and payment history, in a file you can bring into BEAM Campfire on another device or into BEAM’s desktop wallet, without the whole wallet.db.'),
  saveCta: tk('Save wallet data'),
  importCta: tk('Bring in wallet data'),
  confirmTitle: tk('Save wallet data'),
  confirmCta: tk('Make the file'),
  preparing: tk('Making the file…'),
  readyTitle: tk('Your wallet data file is ready'),
  saveFile: tk('Save the file'),
  keepPrivate: tk('Keep it private: it shows your payment history. It cannot spend your coins.'),
  opensIn: tk('BEAM Campfire on another device brings it in with “Bring in wallet data”; BEAM’s desktop wallet with Settings → Import wallet data.'),
  reading: tk('Reading the file…'),
  previewTitle: tk('Bring this into your wallet?'),
  nothingChanged: tk('Nothing already in this wallet is changed.'),
  bringIn: tk('Bring it in'),
  bringing: tk('Bringing it in…'),
  chooseOther: tk('Choose another file'),
  doneTitle: tk('Your wallet data is in'),
  seeActivity: tk('See your payments'),
  allHere: tk('Everything in this file is already in this wallet.'),
  otherWalletTitle: tk('This file is from another wallet'),
  otherWallet: tk('Nothing was added. Its addresses belong to a wallet with different 12 words, so BEAM does not take them. Choose the file saved from this wallet.'),
  partTitle: tk('Most of it came in'),
});

/**
 * Problems with a picked file: what happened and what to do next. Never blames. Each is read in the
 * active language when it is asked for (a getter: tooBig carries the size limit as a value).
 */
export const DATA_PROBLEM = Object.freeze({
  get empty() {
    return t('This file is empty. Choose the file you saved with “Save wallet data” (BEAM’s desktop wallet names it export….dat).');
  },
  get tooBig() {
    return t('This file is larger than {mb} MB, more than BEAM Campfire reads as wallet data. Check that it is the file from “Save wallet data”.', { mb: DATA_FILE_MAX_BYTES / 1024 / 1024 });
  },
  get gone() {
    return t('BEAM Campfire could not read that file. Choose it again; if it is in iCloud Drive, let it download first.');
  },
  get notData() {
    return t('This isn’t a BEAM wallet data file. Choose the file you saved with “Save wallet data” (BEAM’s desktop wallet names it export….dat).');
  },
  get damaged() {
    return t('This wallet data file is damaged or was changed after it was saved, so BEAM Campfire does not bring it in. Save a new one from the other wallet.');
  },
  get nothing() {
    return t('This file holds no names, contacts or payments, so there is nothing to bring in.');
  },
  get unsafeNumber() {
    return t('This file has numbers too large to read safely, so BEAM Campfire does not bring it in. Bring it into BEAM’s desktop wallet instead.');
  },
});

export class WalletDataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** First look at a picked file, before it is read. */
export function checkDataFile({ size }) {
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'gone', problem: DATA_PROBLEM.gone };
  if (size === 0) return { ok: false, code: 'empty', problem: DATA_PROBLEM.empty };
  if (size > DATA_FILE_MAX_BYTES) return { ok: false, code: 'tooBig', problem: DATA_PROBLEM.tooBig };
  return { ok: true };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const uint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const byteArray = (v, len = null) => Array.isArray(v) && (len === null || v.length === len) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const optString = (v, max = TEXT_FIELD_MAX) => v === undefined || (typeof v === 'string' && v.length <= max);

/** Every field BEAM's reader takes from an address entry, as BEAM's reader needs it. */
export function validAddressEntry(e) {
  return (
    isObj(e) &&
    typeof e.WalletID === 'string' &&
    e.WalletID.length > 0 &&
    e.WalletID.length <= 256 &&
    HEX.test(e.WalletID) &&
    uint(e.Index) &&
    typeof e.Label === 'string' &&
    e.Label.length <= LABEL_MAX_CHARS &&
    uint(e.CreationTime) &&
    uint(e.Duration) &&
    optString(e.Category) &&
    optString(e.Address) &&
    (e.Identity === undefined || (typeof e.Identity === 'string' && e.Identity.length <= 256 && (e.Identity === '' || HEX.test(e.Identity)))) &&
    (e.SubIndex === undefined || uint(e.SubIndex))
  );
}

/** Every field BEAM's reader takes from a transaction parameter. */
export function validTxParam(p) {
  return isObj(p) && byteArray(p.TransactionId, 16) && uint(p.SubTransactionId, 0x7fffffff) && uint(p.ParameterId, 255) && byteArray(p.Value);
}

export const txIdHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

/** A name a person gave, as opposed to one BEAM or this app gave by itself. */
export const isChosenLabel = (label) => typeof label === 'string' && !AUTO_LABELS.has(label.trim());

function decodeNote(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return '';
  }
}

/** The extras section, read softly: what cannot be used is left out, never the whole file. */
export function readExtras(raw) {
  if (!isObj(raw)) return { present: false, contacts: [], hiddenTokens: [] };
  const contacts = [];
  for (const c of Array.isArray(raw.contacts) ? raw.contacts : []) {
    if (!isObj(c)) continue;
    const name = cleanName(c.name);
    const address = cleanAddress(c.address);
    if (name && looksLikeAddress(address)) contacts.push({ name, address });
  }
  return { present: true, contacts, hiddenTokens: parseHidden(raw.hiddenTokens) };
}

/** Contacts BEAM's own list carries (the desktop wallet's address book) in the address book's shape. */
export function beamContactsAsBook(list) {
  const out = [];
  for (const e of list || []) {
    const name = cleanName(e.Label);
    const address = cleanAddress(e.Address);
    if (name && looksLikeAddress(address)) out.push({ name, address });
  }
  return out;
}

/**
 * Reads the file's text: is it BEAM's wallet data, every entry whole, and what it holds.
 * @returns {{ok:true, data:object, summary:object} | {ok:false, code:string, problem:string}}
 */
export function parseWalletData(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'empty', problem: DATA_PROBLEM.empty };
  let unsafe = false;
  let obj;
  try {
    obj = JSON.parse(text, (k, v) => {
      if (typeof v === 'number' && !Number.isSafeInteger(v) && Number.isInteger(v)) unsafe = true;
      return v;
    });
  } catch {
    return { ok: false, code: 'notData', problem: DATA_PROBLEM.notData };
  }
  const keys = ['OwnAddresses', 'Contacts', 'TransactionParameters']; // i18n-ignore: BEAM's JSON keys
  if (!isObj(obj) || !keys.some((k) => k in obj)) return { ok: false, code: 'notData', problem: DATA_PROBLEM.notData };
  for (const k of keys) if (k in obj && !Array.isArray(obj[k])) return { ok: false, code: 'damaged', problem: DATA_PROBLEM.damaged };
  const own = obj.OwnAddresses || [];
  const contacts = obj.Contacts || [];
  const params = obj.TransactionParameters || [];
  if (unsafe) return { ok: false, code: 'unsafeNumber', problem: DATA_PROBLEM.unsafeNumber };
  if (!own.every(validAddressEntry) || !contacts.every(validAddressEntry) || !params.every(validTxParam)) return { ok: false, code: 'damaged', problem: DATA_PROBLEM.damaged };
  const extras = readExtras(obj[EXTRAS_KEY]);
  const data = { own, contacts, params, extras };
  const summary = summarize(data);
  if (!summary.own && !summary.contacts && !summary.txs && !summary.book && !summary.hiddenTokens) return { ok: false, code: 'nothing', problem: DATA_PROBLEM.nothing };
  return { ok: true, data, summary };
}

/** A stored transaction type: BEAM writes the byte with its length first ([1, 0] simple, [1, 12] contract call). */
export function txType(value) {
  if (value.length === 2 && value[0] === 1) return value[1];
  if (value.length === 1) return value[0];
  return null;
}

const CONTRACT_TX = 12;
/** A note as the Activity shows it: a payment's comment; a contract call's comment is the app's, not the person's. */
const personsNote = (tx) => tx.type !== CONTRACT_TX && tx.note.trim();

/**
 * A stored status: BEAM writes a small number as one byte with the top bit set (measured on a
 * Desktop Wallet export: 130 cancelled, 131 completed, 132 failed). Anything else: null (unknown).
 */
export function statusValue(value) {
  return Array.isArray(value) && value.length === 1 && value[0] >= 0x80 && value[0] <= 0x86 ? value[0] - 0x80 : null;
}

/** Over (cancelled, completed, failed): BEAM will never resume it. */
export const finishedStatus = (s) => FINISHED.has(s);

/** Payments grouped by id: Map(hex -> {params, typed, type, note, repair, finished}). */
export function groupTxs(params) {
  const txs = new Map();
  for (const p of params) {
    const id = txIdHex(p.TransactionId);
    let tx = txs.get(id);
    if (!tx) txs.set(id, (tx = { id, params: [], typed: false, type: null, note: '', myId: false, myAddressId: false, statuses: [] }));
    tx.params.push(p);
    if (p.SubTransactionId === DEFAULT_SUB_TX && p.ParameterId === P_TYPE) {
      tx.typed = true;
      tx.type = txType(p.Value);
    }
    if (p.SubTransactionId === DEFAULT_SUB_TX && p.ParameterId === P_MESSAGE && p.Value.length) tx.note = decodeNote(p.Value);
    // Every status row, on any sub-transaction: all must be over.
    if (p.ParameterId === P_STATUS) tx.statuses.push(statusValue(p.Value));
    if (p.ParameterId === P_MY_ID) tx.myId = true;
    if (p.ParameterId === P_MY_ADDRESS_ID) tx.myAddressId = true;
  }
  for (const tx of txs.values()) {
    tx.finished = tx.statuses.length > 0 && tx.statuses.every(finishedStatus);
    // A payment that failed before it started (no coins, say) has the key index of its address but not
    // the address: BEAM writes it so, and its own reader then refuses it ("Invalid MyAddressID"),
    // in the desktop wallet and the CLI too. Without the index BEAM takes it as it takes any payment
    // with neither. The index only serves a payment proof, which a payment that never started has not.
    tx.repair = tx.myAddressId && !tx.myId;
    if (tx.repair) tx.params = tx.params.filter((p) => p.ParameterId !== P_MY_ADDRESS_ID);
  }
  return txs;
}

/**
 * BEAM's export with the payments BEAM's own reader would refuse repaired (groupTxs), so the
 * desktop wallet and the CLI take the whole file. Untouched (byte for byte) when none needs it.
 * @returns {{text: string, repaired: number}}
 */
export function repairExport(beamJson) {
  let unsafe = false;
  let o;
  try {
    o = JSON.parse(beamJson, (k, v) => {
      if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) unsafe = true;
      return v;
    });
  } catch {
    return { text: beamJson, repaired: 0 };
  }
  if (unsafe || !isObj(o) || !Array.isArray(o.TransactionParameters) || !o.TransactionParameters.every(validTxParam)) return { text: beamJson, repaired: 0 };
  const repair = [...groupTxs(o.TransactionParameters).values()].filter((tx) => tx.repair);
  if (!repair.length) return { text: beamJson, repaired: 0 };
  const ids = new Set(repair.map((tx) => tx.id));
  o.TransactionParameters = o.TransactionParameters.filter((p) => !(p.ParameterId === P_MY_ADDRESS_ID && ids.has(txIdHex(p.TransactionId))));
  return { text: JSON.stringify(o), repaired: repair.length };
}

/** The address book this file would bring, one per address: BEAM Campfire's own, or else BEAM's named contacts. */
export function bookFromData(data) {
  const out = [];
  for (const c of data.extras.present ? data.extras.contacts : beamContactsAsBook(data.contacts)) if (!findByAddress(out, c.address)) out.push(c);
  return out;
}

/** What a file holds, in counts. */
export function summarize(data) {
  const txs = [...groupTxs(data.params).values()].filter((tx) => tx.typed);
  const book = bookFromData(data).length;
  return {
    own: data.own.length,
    ownNamed: data.own.filter((a) => isChosenLabel(a.Label)).length,
    contacts: data.contacts.length,
    txs: txs.length,
    notes: txs.filter(personsNote).length,
    book,
    // The contacts a person sees: the address book's from BEAM Campfire, BEAM's list from the desktop wallet.
    people: data.extras.present ? book : data.contacts.length,
    hiddenTokens: data.extras.hiddenTokens.length,
  };
}

/**
 * What this wallet has, for planImport: from addr_list (own and not) and tx_list.
 * @param {{own:object[], others:object[], txs:object[]}} lists
 */
export function localIndex({ own = [], others = [], txs = [] }) {
  const ids = new Set();
  const tokens = new Set();
  for (const a of [...own, ...others]) {
    if (a && typeof a.wallet_id === 'string') ids.add(a.wallet_id.toLowerCase());
    if (a && typeof a.address === 'string') tokens.add(a.address);
  }
  const txIds = new Set(txs.filter((tx) => tx && typeof tx.txId === 'string').map((tx) => tx.txId.toLowerCase()));
  return { ids, tokens, txIds };
}

const addressHere = (e, local) => local.ids.has(e.WalletID.toLowerCase()) || (typeof e.Address === 'string' && e.Address && local.tokens.has(e.Address));

/**
 * Which address-book entries can be added: new addresses only; never one that looks like a saved
 * contact's address (the look-alike trick) or takes a saved contact's name for another address.
 */
export function planBook(incoming, existing) {
  const add = [];
  const skipped = { already: 0, lookalike: 0, sameName: 0, full: 0, invalid: 0 };
  const list = [...(existing || [])];
  for (const c of incoming) {
    if (findByAddress(list, c.address)) {
      skipped.already++;
      continue;
    }
    if (lookalikeOf(list, c.address)) {
      skipped.lookalike++;
      continue;
    }
    if (list.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) {
      skipped.sameName++;
      continue;
    }
    if (list.length >= CONTACTS_MAX) {
      skipped.full++;
      continue;
    }
    const r = checkContact(c, list);
    if (!r.ok) {
      skipped.invalid++;
      continue;
    }
    const entry = { name: r.name, address: r.address };
    add.push(entry);
    list.push({ id: `new${add.length}`, ...entry });
  }
  return { add, skipped };
}

/**
 * What an import adds: only entries this wallet does not have (BEAM would overwrite the others),
 * and only payments BEAM can take (a type on the main part).
 * @param {{own, contacts, params, extras}} data  from parseWalletData
 * @param {{ids:Set, tokens:Set, txIds:Set}} local  from localIndex
 * @param {{book?:object[], hidden?:number[]}} mine  this wallet's address book and hidden tokens
 */
export function planImport(data, local, mine = {}) {
  const own = data.own.filter((e) => !addressHere(e, local));
  const contacts = data.contacts.filter((e) => !addressHere(e, local));
  const groups = [...groupTxs(data.params).values()];
  const usable = groups.filter((tx) => tx.typed);
  // Only what is over: an unfinished one would be built and signed at the next start, unasked.
  const finished = usable.filter((tx) => tx.finished);
  const txs = finished.filter((tx) => !local.txIds.has(tx.id));
  // The address book could not be opened here: nothing is added to it (it is never written over).
  const book = mine.bookBlocked ? { add: [], skipped: { already: 0, lookalike: 0, sameName: 0, full: 0, invalid: 0 }, blocked: true } : planBook(bookFromData(data), mine.book || []);
  const hiddenHere = new Set(parseHidden(mine.hidden || []));
  const hidden = data.extras.hiddenTokens.filter((id) => !hiddenHere.has(id));
  return {
    own,
    contacts,
    txs,
    book,
    hidden,
    campfire: data.extras.present,
    repaired: txs.filter((tx) => tx.repair).length,
    unreadable: groups.length - usable.length,
    unfinished: usable.length - finished.length,
    already: { own: data.own.length - own.length, contacts: data.contacts.length - contacts.length, txs: finished.length - txs.length },
    counts: {
      own: own.length,
      ownNamed: own.filter((a) => isChosenLabel(a.Label)).length,
      contacts: contacts.length,
      txs: txs.length,
      notes: txs.filter(personsNote).length,
      book: book.add.length,
      people: data.extras.present ? book.add.length : contacts.length,
      hiddenTokens: hidden.length,
    },
  };
}

/** Nothing in the plan to add. */
export const planEmpty = (plan) => !plan.own.length && !plan.contacts.length && !plan.txs.length && !plan.book.add.length && !plan.hidden.length;

/**
 * The plan as engine calls, each at most maxBytes of JSON (one payment is never split: BEAM reads a
 * payment's type and its other parameters in the same call). Own addresses first: the first call
 * that has them is BEAM's check that the file belongs to this seed.
 * @returns {{kind:'own'|'contacts'|'txs', json:string, items:object[]}[]}
 */
export function importChunks(plan, maxBytes = CHUNK_MAX_BYTES) {
  const out = [];
  const pack = (kind, key, items, sizeOf, rowsOf) => {
    let cur = [];
    let size = 0;
    const flush = () => {
      if (!cur.length) return;
      out.push({ kind, items: cur, json: JSON.stringify({ [key]: cur.flatMap(rowsOf) }) });
      cur = [];
      size = 0;
    };
    for (const it of items) {
      const s = sizeOf(it);
      if (cur.length && size + s > maxBytes) flush();
      cur.push(it);
      size += s;
    }
    flush();
  };
  const one = (e) => [e];
  pack('own', 'OwnAddresses', plan.own, (e) => JSON.stringify(e).length + 1, one);
  pack('contacts', 'Contacts', plan.contacts, (e) => JSON.stringify(e).length + 1, one); // i18n-ignore: BEAM's JSON key
  pack('txs', 'TransactionParameters', plan.txs, (tx) => tx.params.reduce((n, p) => n + JSON.stringify(p).length + 1, 0), (tx) => tx.params);
  return out;
}

/** The import of one payment again, alone (after a call BEAM refused in part: which ones went in). */
export const txJson = (tx) => JSON.stringify({ TransactionParameters: tx.params });

/**
 * BEAM's export text with BEAM Campfire's part added, without touching BEAM's bytes: its JSON
 * object ends with "}", so the extras go in just before it.
 */
export function withExtras(beamJson, extras) {
  const hasContacts = extras && Array.isArray(extras.contacts) && extras.contacts.length;
  const hasHidden = extras && Array.isArray(extras.hiddenTokens) && extras.hiddenTokens.length;
  // Written even when empty: it says the address book is this part, not BEAM's list (see the header).
  const body = beamJson.trimEnd();
  if (!body.startsWith('{') || !body.endsWith('}')) throw new WalletDataError('export', t('The wallet data could not be read. Try again.'));
  const part = { v: EXTRAS_VERSION };
  if (hasContacts) part.contacts = extras.contacts.map((c) => ({ name: c.name, address: c.address }));
  if (hasHidden) part.hiddenTokens = parseHidden(extras.hiddenTokens);
  const inner = body.slice(1, -1).trim();
  return `{${inner}${inner ? ',' : ''}${JSON.stringify(EXTRAS_KEY)}:${JSON.stringify(part)}}`;
}

/** Whether the engine can hold this wallet's export in one piece (see the header). */
export function exportFits({ txCount = 0, addressCount = 0 }) {
  const bytes = txCount * EXPORT_BYTES_PER_TX + addressCount * EXPORT_BYTES_PER_ADDRESS;
  return { ok: bytes <= EXPORT_SAFE_BYTES, bytes, maxTxs: Math.floor(EXPORT_SAFE_BYTES / EXPORT_BYTES_PER_TX) };
}

/** Joins the pages of a paged export (wasm patch 0111): the first page's object with every page's payments. */
export function joinPages(pages) {
  if (!pages.length) throw new WalletDataError('export', t('The wallet data could not be read. Try again.'));
  const first = JSON.parse(pages[0]);
  const all = Array.isArray(first.TransactionParameters) ? first.TransactionParameters : [];
  for (const p of pages.slice(1)) {
    const o = JSON.parse(p);
    if (Array.isArray(o.TransactionParameters)) for (const row of o.TransactionParameters) all.push(row);
  }
  return JSON.stringify({ Contacts: first.Contacts || [], OwnAddresses: first.OwnAddresses || [], TransactionParameters: all });
}

// ---------------------------------------------------------------- words for counts

// Each count is a whole phrase (tn): '{n} payment' / '{n} payments', the number written '1,234'.
const num = (count) => count.toLocaleString('en-US');

/**
 * Rows for a summary card: [label, value]. Zero rows are left out, except the payments row.
 * c: {own, ownNamed, people, txs, notes, hiddenTokens} (summarize, planImport counts).
 */
export function summaryRows(c) {
  const rows = [];
  if (c.own) rows.push([t('Your addresses'), c.ownNamed ? t('{count} · {named} with a name', { count: num(c.own), named: num(c.ownNamed) }) : num(c.own)]);
  if (c.people) rows.push([t('Contacts'), num(c.people)]);
  rows.push([t('Payments'), c.notes ? t('{count} · {noted} with a note', { count: num(c.txs), noted: num(c.notes) }) : num(c.txs)]);
  if (c.hiddenTokens) rows.push([t('Hidden tokens'), num(c.hiddenTokens)]);
  return rows;
}

/** "2 addresses, 1 contact and 5 payments": what was (or will be) added. c: {own, people, txs, hiddenTokens}. */
export function addedText(c) {
  const parts = [];
  if (c.own) parts.push(tn({ one: '{n} address', other: '{n} addresses' }, c.own, { n: num(c.own) }));
  if (c.people) parts.push(tn({ one: '{n} contact', other: '{n} contacts' }, c.people, { n: num(c.people) }));
  if (c.txs) parts.push(tn({ one: '{n} payment', other: '{n} payments' }, c.txs, { n: num(c.txs) }));
  if (c.hiddenTokens) parts.push(tn({ one: '{n} hidden token', other: '{n} hidden tokens' }, c.hiddenTokens, { n: num(c.hiddenTokens) }));
  // The list as one whole pattern per length: word order and separators differ between languages.
  const [p1, p2, p3, p4] = parts;
  switch (parts.length) {
    case 0:
      return t('nothing');
    case 1:
      return p1;
    case 2:
      return t('{first} and {second}', { first: p1, second: p2 });
    case 3:
      return t('{first}, {second} and {third}', { first: p1, second: p2, third: p3 });
    default:
      return t('{first}, {second}, {third} and {fourth}', { first: p1, second: p2, third: p3, fourth: p4 });
  }
}

/** Transactions in the file that were not over: left out, said plainly; null when none were. */
export function unfinishedText(count) {
  if (!count) return null;
  return tn(
    {
      one: 'Left out: {n} payment still under way in that file. Only the wallet that started a payment can finish it, so it stays with that wallet.',
      other: 'Left out: {n} payments still under way in that file. Only the wallet that started a payment can finish it, so it stays with that wallet.',
    },
    count,
    { n: num(count) },
  );
}

/** Why some address-book entries were left out, in words; null when none were. */
export function bookSkippedText(skipped) {
  const out = [];
  if (skipped.lookalike) out.push(tn({ one: '{n} contact whose address looks like one you saved but is different', other: '{n} contacts whose address looks like one you saved but is different' }, skipped.lookalike, { n: num(skipped.lookalike) }));
  if (skipped.sameName) out.push(tn({ one: '{n} contact with the name of a contact you saved, for another address', other: '{n} contacts with the name of a contact you saved, for another address' }, skipped.sameName, { n: num(skipped.sameName) }));
  if (skipped.full) out.push(tn({ one: '{n} contact: the address book is full ({max})', other: '{n} contacts: the address book is full ({max})' }, skipped.full, { n: num(skipped.full), max: CONTACTS_MAX }));
  if (skipped.invalid) out.push(tn({ one: '{n} contact that could not be read', other: '{n} contacts that could not be read' }, skipped.invalid, { n: num(skipped.invalid) }));
  // Each reason is a whole phrase; they are listed with "; ".
  return out.length ? t('Left out, to keep your address book safe: {reasons}.', { reasons: out.join('; ') }) : null;
}
