// Installing a dApp from BEAM's DApp Store (issues #46, #47).
//
// Where the package comes from. Store packages live on IPFS, in BEAM's private swarm, which a
// browser cannot join; no public IPFS gateway has them (measured 2026-10-11), and BEAM's nodes serve
// them only over plain http. So BEAM Campfire keeps a copy of the store's packages next to itself,
// on each address it is published at: `dapp-store/<IPFS hash>.dapp`, fetched from the address the app
// was opened from. That address already serves the app, so no new party learns anything; the
// service worker hands such a file over only as data, never as a page (sw.js). A copy is used only
// when its bytes hash to exactly the IPFS hash its publisher recorded on chain (lib/dapps/ipfs_hash.js):
// the copy can be missing, never different. A dApp listed after the copy was last brought up to date
// is not there yet; installing it from a .dapp file works as for any dApp.
//
// What is checked before anything is kept, beyond the hash:
//   - every rule a .dapp file goes through (lib/dapps/file_package.js readFilePackage);
//   - the package's manifest is the store entry's: guid = the dApp's id, the same name, version and
//     API versions (the Desktop Wallet checks guid and name only);
//   - it is not one of the dApps bundled with BEAM Campfire under another's bytes (reservedGuid);
//   - an installed dApp with the same id is updated only by the same publisher's higher version.
//     The same id from another publisher, or over a dApp installed from a file, is refused: it is a
//     different app (the Desktop Wallet would replace it).
// Nothing is installed or updated by itself: the person taps Install or Update.

import { matchesCid } from './ipfs_hash.js';
import { readFilePackage, catalogueEntryFor, InstallError } from './file_package.js';
import { installed as defaultInstalled } from './installed.js';
import { cleanText, parseVersionText, compareVersions, LIMITS } from './store.js';
import { t, tk } from '../i18n.js';

export const MIRROR_DIR = 'dapp-store';
export const MAX_STORE_PACKAGE_BYTES = 32 * 1024 * 1024;

// A StoreInstallError's message is for logs and tests (each line says so): the screens show
// storeInstallErrorText, the words for its code.
export class StoreInstallError extends Error {
  /** problems: for notThisEntry, what differs (tk() texts: 'its id', 'its name', ...). */
  constructor(code, message, { problems = [] } = {}) {
    super(message);
    this.code = code; // notMirrored | network | tooLarge | hashMismatch | notThisEntry | otherPublisher | fromFile | olderVersion | reservedGuid | unsupported | aborted
    this.problems = problems;
  }
}

export const mirrorPath = (cid) => `${MIRROR_DIR}/${cid}.dapp`;

/** The package's bytes from this app's copy of the store, checked against its IPFS hash. */
export async function fetchStorePackage(dapp, { onProgress = null, signal = null, fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(mirrorPath(dapp.cid), { cache: 'no-store', credentials: 'same-origin', signal });
  } catch {
    if (signal && signal.aborted) throw new StoreInstallError('aborted', 'The download was stopped.'); // i18n-ignore: for logs and tests
    throw new StoreInstallError('network', "BEAM Campfire's copy of the store could not be reached."); // i18n-ignore: for logs and tests
  }
  if (res.status === 404) throw new StoreInstallError('notMirrored', 'Not in the copy yet.'); // i18n-ignore: for logs and tests
  if (!res.ok) throw new StoreInstallError('network', `The copy answered ${res.status}.`); // i18n-ignore: for logs and tests
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  if (declared > MAX_STORE_PACKAGE_BYTES) throw new StoreInstallError('tooLarge', `The package is ${declared} bytes.`); // i18n-ignore: for logs and tests
  const parts = [];
  let n = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > MAX_STORE_PACKAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new StoreInstallError('tooLarge', `The package is over ${MAX_STORE_PACKAGE_BYTES} bytes.`); // i18n-ignore: for logs and tests
        }
        parts.push(value);
        if (onProgress) onProgress(n, declared || null);
      }
    } else {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > MAX_STORE_PACKAGE_BYTES) throw new StoreInstallError('tooLarge', `The package is ${all.length} bytes.`); // i18n-ignore: for logs and tests
      parts.push(all);
      n = all.length;
      if (onProgress) onProgress(n, n);
    }
  } catch (e) {
    if (e instanceof StoreInstallError) throw e;
    if (signal && signal.aborted) throw new StoreInstallError('aborted', 'The download was stopped.'); // i18n-ignore: for logs and tests
    throw new StoreInstallError('network', 'The download stopped before it finished.'); // i18n-ignore: for logs and tests
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  if (!(await matchesCid(bytes, dapp.cid))) throw new StoreInstallError('hashMismatch', 'The copy is not the file the publisher listed.'); // i18n-ignore: for logs and tests
  return bytes;
}

/** Throws unless the package is the store entry it was fetched for. */
export function checkAgainstEntry(pkg, dapp) {
  const m = pkg.manifest;
  const same = (a, b) => cleanText(a, LIMITS.name) === cleanText(b, LIMITS.name);
  const v = parseVersionText(m.version);
  // What differs, as tk() labels: the message (for logs and tests) is English, the screen translates them.
  const problems = [];
  if (m.guid !== dapp.id) problems.push(tk('its id'));
  if (!same(m.name, dapp.name)) problems.push(tk('its name'));
  if (!v || compareVersions(v, dapp.version) !== 0) problems.push(tk('its version'));
  if ((m.apiVersion || '') !== dapp.apiVersion || (m.minApiVersion || '') !== dapp.minApiVersion) problems.push(tk('its API version'));
  if (problems.length) throw new StoreInstallError('notThisEntry', `The package differs from the store entry in ${problems.join(', ')}.`, { problems }); // i18n-ignore: for logs and tests
}

/**
 * What tapping the button does for a store entry, given what is installed:
 *   {action: 'install'}                        not installed
 *   {action: 'open'}                           this publisher's same (or newer) version is installed
 *   {action: 'update', from: installed record} this publisher's older version is installed
 *   {action: 'blocked', code, record}          the id is taken by a dApp from a file or another publisher
 */
export function storeState(dapp, record) {
  if (!record) return { action: 'install' };
  if (!record.store) return { action: 'blocked', code: 'fromFile', record };
  if (record.store.publisher !== dapp.publisher) return { action: 'blocked', code: 'otherPublisher', record };
  return compareVersions(record.store.version, dapp.version) < 0 ? { action: 'update', from: record } : { action: 'open', record };
}

/**
 * Fetches, checks and keeps a store dApp (install or update). publisher: the store's publisher record
 * (for its name). Returns the installed record. Throws StoreInstallError or InstallError.
 */
export async function installFromStore(dapp, publisher, { installed = defaultInstalled, onProgress = null, signal = null, fetchImpl } = {}) {
  const state = storeState(dapp, await installed.get(dapp.id));
  if (state.action === 'blocked') throw new StoreInstallError(state.code, state.code === 'fromFile' ? 'A dApp with this id was installed from a file.' : 'A dApp with this id from another publisher is installed.'); // i18n-ignore: for logs and tests
  if (state.action === 'open') return state.record;
  if (!dapp.servedApi) throw new StoreInstallError('unsupported', 'It needs a newer wallet.'); // i18n-ignore: for logs and tests
  const bytes = await fetchStorePackage(dapp, { onProgress, signal, fetchImpl });
  let pkg;
  try {
    pkg = await readFilePackage(bytes);
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('cantOpenFile', String((e && e.message) || e));
  }
  checkAgainstEntry(pkg, dapp);
  // One of BEAM Campfire's bundled dApps byte for byte is that dApp, not a store one; another's
  // bytes under a bundled dApp's id are refused here (reservedGuid).
  if (catalogueEntryFor(pkg)) throw new StoreInstallError('reservedGuid', 'It is one of the dApps that come with BEAM Campfire.'); // i18n-ignore: for logs and tests
  return installed.install(pkg, bytes, {
    replace: state.action === 'update',
    store: { publisher: dapp.publisher, publisherName: (publisher && publisher.name) || '', cid: dapp.cid, version: [...dapp.version] },
  });
}

/** What went wrong, in words that name the next step and never blame the person. */
export function storeInstallErrorText(err, name) {
  if (err instanceof InstallError && err.code === 'reservedGuid') return t("{name} uses the id of a dApp that comes with BEAM Campfire, so it can't be installed. Open that dApp from dApps instead.", { name });
  if (!(err instanceof StoreInstallError)) return null;
  switch (err.code) {
    case 'notMirrored':
      return t("{name} isn't in BEAM Campfire's copy of the store yet. Ask its publisher for the .dapp file and choose Install from a file, or try again in a few days.", { name });
    case 'network':
      return t("{name} couldn't be downloaded just now. Check your connection and try again.", { name });
    case 'aborted':
      return t('The download was stopped. Nothing was installed.');
    case 'tooLarge':
      return t('{name} is larger than BEAM Campfire installs (32 MB). Nothing was installed.', { name });
    case 'hashMismatch':
      return t('The copy of {name} is not the file its publisher listed, so it was not installed. Nothing on your device changed.', { name });
    case 'notThisEntry':
      // What differs: a list of labels ("its name, its version"), from the error's problems.
      return t("The package for {name} doesn't match what the store says about it ({problems}), so it was not installed.", { name, problems: (err.problems || []).map((p) => t(p)).join(', ') });
    case 'fromFile':
      return t("You installed a dApp with the same id from a file. Remove it under dApps first if you want the store's {name}.", { name });
    case 'otherPublisher':
      return t('You have a dApp with the same id from another publisher. It is a different app: remove it first if you want this one.');
    case 'reservedGuid':
      return t("{name} uses the id of a dApp that comes with BEAM Campfire, so it can't be installed. Open that dApp from dApps instead.", { name });
    case 'unsupported':
      return t('{name} needs a newer wallet than this version of BEAM Campfire.', { name });
    default:
      return null;
  }
}
