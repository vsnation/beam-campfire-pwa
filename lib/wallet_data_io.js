// "Move names, notes and history" against the running wallet: make the file, read a picked one,
// bring it in. The rules live in lib/wallet_data.js; this module asks the engine (wasm patch 0110,
// WalletSession.exportData / importData) and the app's per-wallet stores.
//
// BEAM Campfire's own per-wallet data travels in the file's EXTRAS_KEY part (BEAM's readers skip
// it). Each kind has one entry in EXTRAS below: collect() reads it for the file, current() reads
// what this wallet has (for planImport), apply() adds the planned entries. Today: the address book
// (lib/contacts.js, sealed under w:<id>:payments) and the hidden tokens (lib/hidden_tokens.js,
// w:<id>:hiddenTokens). To add another kind: give it an entry here, read it in
// wallet_data.js readExtras(), plan it in planImport(), and count it in summaryRows().
// Nothing is ever replaced: a contact, a hidden token or a BEAM entry that is already here stays
// as it is.

import { wallet } from './wallet.js';
import { vaultFor, loadContacts } from './contacts.js';
import { loadHidden, setTokenHidden } from './hidden_tokens.js';
import {
  checkDataFile,
  parseWalletData,
  localIndex,
  planImport,
  importChunks,
  txJson,
  withExtras,
  repairExport,
  exportFits,
  joinPages,
  dataFileName,
  summarize,
  WalletDataError,
  DATA_PROBLEM,
} from './wallet_data.js';

const PAUSED = 'the wallet was locked, another one was opened, or it moved to another node';

// Own addresses BEAM refused in a row, none taken: the file is another seed's.
const OTHER_WALLET_AFTER = 5;

const notOpen = () => new WalletDataError('stopped', 'The wallet is not open yet. Go back to Home, then try again.');

/** BEAM Campfire's per-wallet extras (see the header). */
export const EXTRAS = {
  contacts: {
    async collect(app) {
      const v = await vaultFor(app);
      return (await v.contacts()).map((c) => ({ name: c.name, address: c.address }));
    },
    async current(app) {
      const v = await vaultFor(app);
      return v.contacts();
    },
    /** Adds each planned contact; one that turned out to be there already (or a full book) is skipped. */
    async apply(app, add) {
      const v = await vaultFor(app);
      let added = 0;
      for (const c of add) {
        try {
          await v.add(c);
          added++;
        } catch {
          /* duplicate or full since the plan: left out */
        }
      }
      if (added) await loadContacts(app).catch(() => null);
      return added;
    },
  },
  hiddenTokens: {
    async collect(app) {
      return [...(await loadHidden(app))].sort((a, b) => a - b);
    },
    async current(app) {
      return [...(await loadHidden(app))];
    },
    async apply(app, ids) {
      for (const id of ids) await setTokenHidden(app, id, true);
      return ids.length;
    },
  },
};

/**
 * What this wallet has, from the engine: its addresses (own and others) and every payment
 * (tx_list without a count lists them all; a count must be at least 1).
 */
export async function readLocal(session = wallet.session) {
  if (!session) throw notOpen();
  try {
    const [own, others, txs] = await Promise.all([
      session.call('addr_list', { own: true }, { timeoutMs: 60000 }),
      session.call('addr_list', { own: false }, { timeoutMs: 60000 }),
      session.call('tx_list', {}, { timeoutMs: 60000 }),
    ]);
    return { own: own || [], others: others || [], txs: Array.isArray(txs) ? txs : [] };
  } catch (e) {
    if (e && e.code === 'stopped') throw notOpen();
    throw new WalletDataError('local', 'BEAM Campfire could not read this wallet’s own lists just now. Try again in a moment.');
  }
}

/**
 * The wallet data file of the open wallet, with BEAM Campfire's extras.
 * @returns {Promise<{file: File, summary: object, left: string[]}>} left: extras that could not be read
 */
export async function prepareDataExport(app) {
  const session = wallet.session;
  if (!session) throw notOpen();
  // A payment made a moment ago is in the file only once it is committed (and then saved here too).
  await wallet.persistNow();
  let beamJson;
  if (session.pagedExport) {
    beamJson = joinPages(await session.exportDataPages());
  } else {
    const local = await readLocal(session);
    const fit = exportFits({ txCount: local.txs.length, addressCount: local.own.length + local.others.length });
    if (!fit.ok)
      throw new WalletDataError(
        'too_big',
        `This wallet has ${local.txs.length.toLocaleString('en-US')} payments, more history than BEAM Campfire can put in one file on this device yet (about ${fit.maxTxs.toLocaleString('en-US')}). Nothing is lost: wallet.db holds the names, notes and history, so “Export wallet.db” on this screen carries them to BEAM Campfire on another device or to BEAM’s desktop wallet.`,
      );
    beamJson = await session.exportData();
  }
  const extras = {};
  const left = [];
  for (const [kind, x] of Object.entries(EXTRAS)) {
    try {
      extras[kind] = await x.collect(app);
    } catch {
      left.push(kind === 'contacts' ? 'Your address book could not be opened, so it is not in the file.' : 'Your hidden tokens could not be read, so they are not in the file.');
    }
  }
  const text = withExtras(repairExport(beamJson).text, extras);
  const parsed = parseWalletData(text);
  if (!parsed.ok && parsed.code !== 'nothing') throw new WalletDataError('export', 'The wallet data could not be read. Try again.');
  const summary = parsed.ok ? parsed.summary : summarize({ own: [], contacts: [], params: [], extras: { contacts: [], hiddenTokens: [] } });
  return { file: new File([text], dataFileName(), { type: 'application/octet-stream' }), summary, left };
}

/**
 * Reads a picked file and plans what it adds here. Throws WalletDataError with the words to show.
 * @returns {Promise<{name:string, size:number, summary:object, plan:object, bookBlocked:boolean}>}
 */
export async function previewImport(app, file) {
  const c = checkDataFile({ size: file && file.size });
  if (!c.ok) throw new WalletDataError(c.code, c.problem);
  let text;
  try {
    text = await file.text();
  } catch {
    throw new WalletDataError('gone', DATA_PROBLEM.gone);
  }
  const parsed = parseWalletData(text);
  text = null;
  if (!parsed.ok) throw new WalletDataError(parsed.code, parsed.problem);
  const local = await readLocal();
  let book = [];
  let bookBlocked = false;
  try {
    book = await EXTRAS.contacts.current(app);
  } catch {
    bookBlocked = true;
  }
  const hidden = await EXTRAS.hiddenTokens.current(app).catch(() => []);
  const plan = planImport(parsed.data, localIndex(local), { book, hidden, bookBlocked });
  return { name: file.name, size: file.size, summary: parsed.summary, plan, bookBlocked };
}

/**
 * Brings the planned entries in, own addresses first (BEAM's check that the file is this seed's),
 * in pieces the engine can hold. A piece BEAM refuses in part is brought in again entry by entry,
 * so the counts are exact. onProgress({step, done, total}).
 * @returns {Promise<{added:object, refused:{own:number, contacts:number, txs:number}, otherWallet:boolean, stopped:string|null}>}
 */
export async function runImport(app, preview, { onProgress = () => {}, chunkBytes } = {}) {
  const { plan } = preview;
  const added = { own: 0, contacts: 0, txs: 0, book: 0, people: 0, hiddenTokens: 0 };
  const refused = { own: 0, contacts: 0, txs: 0 };
  const chunks = importChunks(plan, chunkBytes);
  const total = { own: plan.own.length, contacts: plan.contacts.length, txs: plan.txs.length };
  const done = { own: 0, contacts: 0, txs: 0 };
  let stopped = null;
  // Only into the wallet the file was checked against: a lock or a switch to another wallet stops it
  // (a move to another node is the same wallet, the same database file).
  const dbPath = wallet.run && wallet.run.dbPath;
  const recordId = app.record && app.record.id;
  const same = () => Boolean(wallet.session && wallet.run && wallet.run.dbPath === dbPath && app.record && app.record.id === recordId);
  const session = () => {
    if (!same()) throw new WalletDataError('stopped', PAUSED);
    return wallet.session;
  };
  const one = (kind, item) => (kind === 'txs' ? txJson(item) : JSON.stringify({ [kind === 'own' ? 'OwnAddresses' : 'Contacts']: [item] }));
  try {
    for (const ch of chunks) {
      // Every own address was refused: the file is another seed's. Nothing more goes in.
      if (ch.kind !== 'own' && total.own && !added.own) break;
      onProgress({ step: ch.kind, done: done[ch.kind], total: total[ch.kind] });
      if (await session().importData(ch.json)) added[ch.kind] += ch.items.length;
      else {
        for (const item of ch.items) {
          if (await session().importData(one(ch.kind, item))) added[ch.kind]++;
          else refused[ch.kind]++;
          // Own addresses refused one after another and none taken: another seed's file (BEAM checks
          // each against this wallet's seed). The rest would be refused too: stop asking.
          if (ch.kind === 'own' && !added.own && refused.own >= OTHER_WALLET_AFTER) break;
        }
      }
      if (ch.kind === 'own' && !added.own && refused.own >= OTHER_WALLET_AFTER) {
        refused.own = total.own;
        break;
      }
      done[ch.kind] += ch.items.length;
      onProgress({ step: ch.kind, done: done[ch.kind], total: total[ch.kind] });
    }
  } catch (e) {
    stopped = e && e.code === 'stopped' ? PAUSED : (e && e.message) || PAUSED;
  }
  const otherWallet = total.own > 0 && added.own === 0 && refused.own === total.own;
  if (!otherWallet && !stopped && !same()) stopped = PAUSED;
  if (!otherWallet && !stopped) {
    if (plan.book.add.length) {
      onProgress({ step: 'book', done: 0, total: plan.book.add.length });
      added.book = await EXTRAS.contacts.apply(app, plan.book.add).catch(() => 0);
    }
    if (plan.hidden.length) added.hiddenTokens = await EXTRAS.hiddenTokens.apply(app, plan.hidden).catch(() => 0);
  }
  // The contacts a person sees (lib/wallet_data.js summarize): the address book's, or BEAM's from the desktop wallet.
  added.people = plan.campfire ? added.book : added.contacts;
  // BEAM adds payments without an event: save what came in and show it.
  await wallet.persistNow().catch(() => null);
  wallet.refreshTxs();
  return { added, refused, otherWallet, stopped };
}
