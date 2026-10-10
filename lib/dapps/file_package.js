// A .dapp file the person picked, read and checked before anything is kept
// or shown. The rules are the desktop BEAM Campfire's (DappPackage,
// DappManifest, DappStoreController.readFile), which follow beam-ui's
// manifest parser and add:
// - the guid is 32 hex digits (or a hyphenated UUID), only ever used in its
//   lowercase 32-hex form;
// - url names an .html page inside the package (localapp/...); a remote or
//   data: icon is ignored, a local one that is missing is dropped;
// - the name and publisher, shown on the install and approval sheets, may
//   not hold control or bidirectional characters, which could make one
//   dApp's name read as another's;
// - the archive itself: lib/dapps/zip.js (paths, entry types, sizes, counts,
//   compression ratio);
// - a file may take the guid of one of BEAM's own dApps only when it is that
//   dApp's pinned package byte for byte; a name that copies one of them under
//   another guid is installed with a warning.

import { readZip, ZipError, DEFAULT_LIMITS, pathSegments } from './zip.js';
import { negotiateApiVersion } from './gate.js';
import { sha256Hex } from './package.js';
import { CATALOGUE } from './catalogue.js';

export class InstallError extends Error {
  /**
   * dappName: for reservedGuid, the dApp the file claims to be; for unsupported, the file's own.
   * code: 'cantOpenFile' | 'cantReadManifest' | 'unsupported' | 'invalidFile' | 'alreadyInstalled'
   *     | 'storage' | 'tooLarge' | 'unsafeEntry' | 'unsafePath' | 'reservedGuid'
   * message: for logs and tests; never shown, never the file's contents.
   */
  constructor(code, message, { dappName = null } = {}) {
    super(message);
    this.code = code;
    this.dappName = dappName;
  }
}

export const MANIFEST_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  name: 30,
  description: 1024,
  apiVersion: 10,
  icon: 10240,
  publisher: 256,
});
const LOCAL = 'localapp/';

const HEX_GUID = /^[0-9a-fA-F]{32}$/;
const UUID_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VERSION = /^[0-9]{1,9}(\.[0-9]{1,9}){0,3}$/;
const API_VERSION = /^[0-9]{1,4}(\.[0-9]{1,4})?$/;
// C0, DEL, C1, and the Unicode marks that reorder or hide text (written as escapes).
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;
// The same, but a description may hold tabs and line breaks.
const UNSAFE_DESCRIPTION = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;

const invalid = (why) => new InstallError('invalidFile', why);

/** 32 lowercase hex digits, or null. */
export function canonicalGuid(raw) {
  if (HEX_GUID.test(raw)) return raw.toLowerCase();
  if (UUID_GUID.test(raw)) return raw.replace(/-/g, '').toLowerCase();
  return null;
}

function requiredString(json, key) {
  const v = json[key];
  if (typeof v !== 'string' || v.length === 0) throw invalid(`"${key}" must be a non-empty string`);
  return v;
}

function optionalString(json, key) {
  const v = json[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid(`"${key}" must be a string`);
  return v;
}

function apiVersionField(json, key) {
  const v = optionalString(json, key);
  if (v === null) return null;
  if (v.length > MANIFEST_LIMITS.apiVersion || !API_VERSION.test(v)) throw invalid(`"${key}" must be major.minor`);
  return v;
}

/** The package path of a localapp/ reference, null when it is not local; throws when it is local but unsafe. */
function localPath(ref, key) {
  if (!ref.startsWith(LOCAL)) return null;
  try {
    return pathSegments(ref.slice(LOCAL.length)).join('/');
  } catch (e) {
    throw invalid(`"${key}" is not a safe path: ${e.message}`);
  }
}

/** manifest.json's bytes -> its checked fields. Throws InstallError cantReadManifest or invalidFile. */
export function parseManifest(bytes) {
  if (!bytes || bytes.length === 0 || bytes.length > MANIFEST_LIMITS.maxBytes) throw new InstallError('cantReadManifest', `manifest.json is ${bytes ? bytes.length : 0} bytes`);
  let json;
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    json = JSON.parse(text);
  } catch (e) {
    throw new InstallError('cantReadManifest', `manifest.json is not UTF-8 JSON: ${e.message}`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).length === 0) throw invalid('manifest.json is not a JSON object');

  const guid = canonicalGuid(requiredString(json, 'guid'));
  if (!guid) throw invalid('guid must be 32 hex digits or a UUID');

  const name = requiredString(json, 'name');
  if (name.length > MANIFEST_LIMITS.name) throw invalid(`name longer than ${MANIFEST_LIMITS.name} characters`);
  if (UNSAFE_DISPLAY.test(name) || name.trim() === '') throw invalid('name contains control characters');

  const description = requiredString(json, 'description');
  if (description.length > MANIFEST_LIMITS.description) throw invalid(`description longer than ${MANIFEST_LIMITS.description}`);
  if (UNSAFE_DESCRIPTION.test(description)) throw invalid('description contains control characters');

  const startPath = localPath(requiredString(json, 'url'), 'url');
  if (startPath === null) throw invalid(`url must start with "${LOCAL}"`);
  if (!/\.html?$/i.test(startPath)) throw invalid('url must name an .html file');

  let iconPath = null;
  const icon = optionalString(json, 'icon');
  if (icon !== null) {
    if (icon.length > MANIFEST_LIMITS.icon) throw invalid(`icon longer than ${MANIFEST_LIMITS.icon} characters`);
    iconPath = localPath(icon, 'icon');
  }

  const version = optionalString(json, 'version');
  if (version !== null && !VERSION.test(version)) throw invalid('version must be up to 4 numeric parts');
  const apiVersion = apiVersionField(json, 'api_version');
  const minApiVersion = apiVersionField(json, 'min_api_version');

  let category = null;
  if (json.category !== undefined && json.category !== null) {
    if (!Number.isInteger(json.category) || json.category < 0 || json.category > 0xffffffff) throw invalid('category must be an unsigned integer');
    category = json.category;
  }

  const publisher = optionalString(json, 'publisher');
  if (publisher !== null && (publisher.length > MANIFEST_LIMITS.publisher || UNSAFE_DISPLAY.test(publisher))) throw invalid('publisher too long or contains control characters');

  return { guid, name, description, startPath, iconPath, version, apiVersion, minApiVersion, category, publisher };
}

const ZIP_CODES = { format: 'cantOpenFile', unsupported: 'invalidFile', unsafe_path: 'unsafePath', unsafe_entry: 'unsafeEntry', too_large: 'tooLarge', corrupt: 'invalidFile' };

/**
 * A package's bytes -> {manifest, apiVersion, sha256, files, totalBytes}, every rule checked.
 * apiVersion: the version it is served (gate.js), as the desktop negotiates it.
 */
export async function readFilePackage(bytes, limits = DEFAULT_LIMITS) {
  if (!(bytes instanceof Uint8Array)) throw new InstallError('cantOpenFile', 'the file could not be read');
  if (bytes.length > limits.maxPackageBytes) throw new InstallError('tooLarge', `package is ${bytes.length} bytes`);
  let files;
  try {
    files = await readZip(bytes, limits);
  } catch (e) {
    if (e instanceof ZipError) throw new InstallError(ZIP_CODES[e.code] || 'invalidFile', e.message);
    throw new InstallError('cantOpenFile', `not a readable zip archive (${(e && e.name) || e})`);
  }
  const raw = files.get('manifest.json');
  if (!raw) throw new InstallError('cantReadManifest', 'no manifest.json at the package root');
  const manifest = parseManifest(raw);
  if (!files.has(manifest.startPath)) throw invalid('the start page named by "url" is not in the package');
  if (manifest.iconPath && !files.has(manifest.iconPath)) manifest.iconPath = null;
  const apiVersion = negotiateApiVersion({ wanted: manifest.apiVersion, minimum: manifest.minApiVersion });
  if (!apiVersion) throw new InstallError('unsupported', `api_version ${manifest.apiVersion || 'current'} / min_api_version ${manifest.minApiVersion || '-'} not supported`, { dappName: manifest.name });
  let totalBytes = 0;
  for (const f of files.values()) totalBytes += f.length;
  return { manifest, apiVersion, sha256: await sha256Hex(bytes), files, totalBytes };
}

/**
 * One of BEAM's own dApps this package is, byte for byte (it then goes in as
 * that dApp), or null. Throws reservedGuid when it takes such a dApp's guid
 * without being its pinned package: it would be named exactly like the
 * checked one.
 */
export function catalogueEntryFor(pkg, catalogue = CATALOGUE) {
  const e = catalogue.find((x) => x.guid === pkg.manifest.guid);
  if (!e) return null;
  if (e.sha256 !== pkg.sha256) throw new InstallError('reservedGuid', `the file uses the guid of ${e.name}`, { dappName: e.name });
  return e;
}

/** The name of one of BEAM's own dApps that this package's name copies under another guid, or null. */
export function catalogueNameCopiedBy(manifest, catalogue = CATALOGUE) {
  const name = manifest.name.trim().toLowerCase();
  const e = catalogue.find((x) => x.guid !== manifest.guid && x.name.trim().toLowerCase() === name);
  return e ? e.name : null;
}

/** What went wrong with an install, in words that never blame the person and name the next step. */
export function installErrorText(err, name) {
  if (err instanceof InstallError) {
    switch (err.code) {
      case 'unsupported':
        return `${err.dappName || name} needs a newer wallet than this version of BEAM Campfire.`;
      case 'alreadyInstalled':
        return `${name} is already installed.`;
      case 'reservedGuid':
        return `This file claims to be ${err.dappName || 'one of the dApps BEAM Campfire checks'}, but it is not the package BEAM Campfire checks, so nothing was installed. Open ${err.dappName || 'it'} from the list of dApps instead.`;
      case 'storage':
        return `BEAM Campfire couldn't save ${name} on this device. Check that there is free space, then try again.`;
      default:
        return "This file isn't a dApp package BEAM Campfire can install safely, so nothing was installed. Ask the dApp's publisher for a new copy.";
    }
  }
  return `Something went wrong installing ${name}. Nothing was changed. Try again.`;
}
