// The sentences of the code the loader runs: sw.js and what tools/loader_source.mjs inlines into it
// (lib/release.js, lib/update_sources.js, lib/node_address.js). Those files cannot import
// lib/i18n.js: the service worker has no catalog, and changing their bytes changes the loader's name
// (every install moves to a new loader) or, for node_address.js, its loader_compat (a release from a
// copy of the app could no longer install where the address is gone). So they keep writing English,
// and a screen that shows one of their sentences passes it through loaderText(): the sentence's
// template is found here and given in the active language, with the same values (file names, hosts,
// versions) put back as text. A sentence that matches no template is shown as it came.
//
// test/unit/i18n_loader_words.test.mjs lists every sentence those files can write and fails when one
// has no template here (or a template matches none).
import { t, tk } from './i18n.js';
import { NODE_EXAMPLE } from './node_address.js';

export const LOADER_WORDS = Object.freeze([
  // lib/release.js
  tk('Release key must be a public P-256 JWK.'),
  tk('The release signature is not readable.'),
  tk('This update is not signed with the BEAM Campfire release key.'),
  tk('release.json is not JSON.'),
  tk('release.json is missing fields.'),
  tk("This update's file list is not the one that was signed."),
  tk('manifest.json does not belong to this release.'),
  tk('File count differs from the signed release.'),
  tk('Bad file path in manifest: {path}'),
  tk('Duplicate path {path}'),
  tk('Bad entry for {path}'),
  tk('A file in this update ({path}) is not the one that was signed.'),
  // lib/update_sources.js
  tk('No BEAM Campfire release is published at this address.'),
  tk('unknown error'),
  tk('A different release claims version {version}.'),
  tk('Paste the address of a copy of BEAM Campfire.'),
  tk('That address is too long.'),
  tk("That isn't a web address."),
  tk('Use an address that starts with https://.'),
  tk('Leave out the user name and password: the address must work without them.'),
  // sw.js: one file of a release, from this app's address or from a copy at {host}
  tk('Could not download {path}.'),
  tk('Could not download {path} from {host}.'),
  tk('{path}: HTTP {status}'),
  tk('{path} from {host}: HTTP {status}'),
  tk('{path} is far larger than a BEAM Campfire release file.'),
  tk('{path} from {host} is far larger than a BEAM Campfire release file.'),
  tk('The download of {path} was interrupted.'),
  tk('The download of {path} from {host} was interrupted.'),
  tk('unknown request'),
  // lib/node_address.js ({example}: NODE_EXAMPLE, the same in every language)
  tk("Type your node's address, for example {example}."),
  tk('The app connects to nodes over a secure connection (wss) only. Type the address without ws://, like {example}.'),
  tk('Leave out {scheme} and type only the host and port, like {example}.'),
  tk('Leave out the user name and password: type only the host and port, like {example}.'),
  tk('Leave out everything after the port: type only the host and port, like {example}.'),
  tk('An address has no spaces. It looks like {example}.'),
  tk("IPv6 addresses can't be used here. Use the node's host name or its IPv4 address."),
  tk('Add the port your node accepts wallets on (its websocket_port), like {example}.'),
  tk('The port must be a number from 1 to 65535.'),
  tk('That is not a host name or an IPv4 address. It looks like {example}.'),
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each template as a pattern: its words exactly, each {placeholder} any text. The ones with the most
// fixed words are tried first, so "Could not download {path} from {host}." wins over "Could not
// download {path}." for a sentence with a host.
const PATTERNS = LOADER_WORDS.map((tpl) => {
  const names = [];
  const re = new RegExp(`^${tpl.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/).map((part) => {
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part);
    if (!m) return escapeRe(part);
    names.push(m[1]);
    return '([\\s\\S]+?)';
  }).join('')}$`);
  return { tpl, names, re, fixed: tpl.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').length };
}).sort((a, b) => b.fixed - a.fixed);

/** The template a loader sentence was written from, with its values: { template, params } or null. */
export function loaderTemplate(sentence) {
  if (typeof sentence !== 'string') return null;
  for (const p of PATTERNS) {
    const m = p.re.exec(sentence);
    if (!m) continue;
    const params = {};
    p.names.forEach((n, i) => {
      params[n] = m[i + 1];
    });
    return { template: p.tpl, params };
  }
  return null;
}

/** A sentence from the loader's code in the active language; anything else as it is. */
export function loaderText(sentence) {
  const found = loaderTemplate(sentence);
  if (!found) return sentence;
  // The example address is the same in every language (and must stay one, to be typed as shown).
  if ('example' in found.params && found.params.example !== NODE_EXAMPLE) return sentence;
  return t(found.template, found.params);
}
