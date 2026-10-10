// dApps installed from a .dapp file, kept in this wallet's own storage (the
// app's IndexedDB, lib/store.js), as the desktop keeps them per wallet: they
// survive reloads, open offline, and go with the wallet when it is removed
// from this device.
//
//   dapp-files         the list: [{guid, name, description, version, publisher,
//                      apiVersion, minApiVersion, startPath, sha256, size,
//                      icon, installedAt, origins}], in install order
//   dapp-file:<guid>   the package's bytes, as picked
//
// Each time a dApp is opened its package is read again with every rule and
// its SHA-256 compared with the list's. origins: the https origins the person
// let it reach (lib/dapps/frame_policy.js); they stay through a replace, as
// the desktop keeps a dApp's own data, and go with Remove. A dApp's
// localStorage and IndexedDB live in its frame's memory only, so there is no
// other saved data to delete. Writes go one at a time, each in one
// transaction.

import { store } from '../store.js';
import { InstallError, readFilePackage } from './file_package.js';
import { remoteOriginFor, MAX_FILE_ORIGINS } from './frame_policy.js';
import { sha256Hex, mimeFor } from './package.js';

const LIST = 'dapp-files';
const pkgKey = (guid) => `dapp-file:${guid}`;
const GUID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const ICON_TYPES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon']);
const MAX_ICON_BYTES = 128 * 1024;

/** The package's own icon as a data: URL for an <img> (which runs no script), or null. */
export function iconDataUrl(files, iconPath) {
  if (!iconPath || !files.has(iconPath)) return null;
  const type = mimeFor(iconPath);
  const bytes = files.get(iconPath);
  if (!ICON_TYPES.has(type) || bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

const cleanOrigins = (list) => (Array.isArray(list) ? [...new Set(list.filter((o) => remoteOriginFor(o) === o))].slice(0, MAX_FILE_ORIGINS) : []);

function validRecord(r) {
  return r && typeof r === 'object' && GUID.test(r.guid) && typeof r.name === 'string' && typeof r.startPath === 'string' && SHA.test(r.sha256);
}

/** kv: {get, batch} (lib/store.js; a Map-backed one in the unit tests). */
export function installedStore(kv = store) {
  let tail = Promise.resolve();
  const serial = (op) => {
    const r = tail.then(op);
    tail = r.catch(() => {});
    return r;
  };

  async function list() {
    const raw = await kv.get(LIST);
    return Array.isArray(raw) ? raw.filter(validRecord).map((r) => ({ ...r, origins: cleanOrigins(r.origins) })) : [];
  }

  async function write(ops, why) {
    try {
      await kv.batch(ops);
    } catch (e) {
      throw new InstallError('storage', `${why}: ${(e && e.name) || e}`);
    }
  }

  return {
    list,

    async get(guid) {
      return (await list()).find((r) => r.guid === guid) || null;
    },

    /** Keeps a package read by readFilePackage. Throws alreadyInstalled unless replace. */
    install(pkg, bytes, { replace = false } = {}) {
      return serial(async () => {
        const m = pkg.manifest;
        const all = await list();
        const old = all.find((r) => r.guid === m.guid);
        if (old && !replace) throw new InstallError('alreadyInstalled', `${m.name} is already installed`);
        const rec = {
          guid: m.guid,
          name: m.name,
          description: m.description,
          version: m.version,
          publisher: m.publisher,
          apiVersion: m.apiVersion,
          minApiVersion: m.minApiVersion,
          startPath: m.startPath,
          sha256: pkg.sha256,
          size: bytes.length,
          icon: iconDataUrl(pkg.files, m.iconPath),
          installedAt: Date.now(),
          origins: old ? old.origins : [],
        };
        const next = old ? all.map((r) => (r.guid === m.guid ? rec : r)) : [...all, rec];
        await write([['set', pkgKey(m.guid), bytes.slice()], ['set', LIST, next]], 'saving the package');
        return rec;
      });
    },

    /** The record and its package, read and checked again. Throws InstallError. */
    async open(guid) {
      const rec = (await list()).find((r) => r.guid === guid);
      if (!rec) throw new InstallError('storage', 'not installed');
      const raw = await kv.get(pkgKey(guid));
      if (!raw) throw new InstallError('storage', 'the package is missing');
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if ((await sha256Hex(bytes)) !== rec.sha256) throw new InstallError('storage', 'the kept package changed');
      const pkg = await readFilePackage(bytes);
      if (pkg.manifest.guid !== guid) throw new InstallError('storage', 'the kept package is another dApp');
      return { rec, pkg };
    },

    remove(guid) {
      return serial(async () => {
        const all = await list();
        await write([['del', pkgKey(guid)], ['set', LIST, all.filter((r) => r.guid !== guid)]], 'removing the package');
      });
    },

    /** Lets the dApp reach `origin` (an https origin, see frame_policy.js) as well. */
    allow(guid, origin) {
      return serial(async () => {
        if (remoteOriginFor(origin) !== origin) throw new Error(`not an origin a dApp may be allowed: ${origin}`);
        return update(guid, (r) => (r.origins.includes(origin) ? r.origins : [...r.origins, origin].slice(0, MAX_FILE_ORIGINS)));
      });
    },

    revoke(guid, origin) {
      return serial(() => update(guid, (r) => r.origins.filter((o) => o !== origin)));
    },
  };

  async function update(guid, originsOf) {
    const all = await list();
    const r = all.find((x) => x.guid === guid);
    if (!r) throw new InstallError('storage', 'not installed');
    const next = { ...r, origins: originsOf(r) };
    await write([['set', LIST, all.map((x) => (x.guid === guid ? next : x))]], 'saving what it may reach');
    return next;
  }
}

export const installed = installedStore();
