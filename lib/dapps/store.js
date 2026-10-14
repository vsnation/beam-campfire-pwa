// BEAM's DApp Store, read from the chain: its publishers and their dApps (issue #45).
//
// The store is a contract on mainnet (STORE_CID: an Upgradable2 wrapper around
// BeamMW/beam-dapps-store's code), read with the Desktop Wallet's own app shader, pinned in
// lib/shaders.js (dappsStore). Two view calls, free, no transaction: view_publishers and
// view_dapps. Every string goes in and comes out as hex-encoded UTF-8.
//
// What the chain says is read, not trusted:
//   - anyone can become a publisher and list dApps for one contract call; a publisher key cannot be
//     forged (it is derived from the publisher's own seed), but names are free text and not unique;
//   - a dApp's id is its package's manifest guid, taken by whoever registers it first;
//   - one admin key can replace the store's code with no delay (never done so far);
//   - names and texts can carry line breaks, direction marks, zero-width characters and look-alike
//     letters; icons are free text (some are not images at all).
// So every text is cleaned (cleanText), an icon is used only when it is an SVG or a PNG/JPEG data
// URL that parses (iconUrl), and look-alikes are flagged (flagsFor): a name that reads like one of
// the dApps bundled with BEAM Campfire, a bundled dApp's id, and a name another publisher also uses.
// A store dApp is never matched to a bundled one by its id (the Desktop Wallet does, so whoever
// registers a bundled dApp's id can "update" it); installing checks the package against the
// store entry and its on-chain IPFS hash (lib/dapps/store_install.js).

import { canonical } from '../lookalike.js';
import { CATALOGUE } from './catalogue.js';
import { negotiateApiVersion } from './gate.js';
import { t, tn, tk } from '../i18n.js';

export const STORE_CID = 'e2d24b686e8d31a0fe97eade9cd23281e7059b74b5757bdb96c820ef9e2af41c';

/** beam-ui's categories (apps_view.h); the contract does not interpret the number. Names: tk(), shown with t(). */
export const CATEGORIES = Object.freeze([
  { id: 2, name: tk('Finance') },
  { id: 3, name: tk('Games') },
  { id: 4, name: tk('Technology') },
  { id: 5, name: tk('Governance') },
  { id: 1, name: tk('Other') },
]);
const CATEGORY_NAME = new Map(CATEGORIES.map((c) => [c.id, c.name]));
/** 0 (undefined) and anything unknown are shown as Other. */
export const categoryOf = (n) => (CATEGORY_NAME.has(Number(n)) ? Number(n) : 1);
/** The category's name, in English (a tk() text: the screens show t(categoryName(n))). */
export const categoryName = (n) => CATEGORY_NAME.get(categoryOf(n));

/** The contract's own limits (dapps_store_contract.h), in bytes. */
export const LIMITS = Object.freeze({ name: 30, title: 50, about: 150, website: 100, social: 50, description: 1024, version: 10, icon: 10240 });

const HEX = /^(?:[0-9a-f]{2})*$/i;
const KEY = /^[0-9a-f]{66}$/;
const ID = /^[0-9a-f]{32}$/;
const CIDV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/** UTF-8 text from the shader's hex ('' for anything that is not hex). */
export function fromHex(h) {
  if (typeof h !== 'string' || !HEX.test(h)) return '';
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** For the shader's arguments: UTF-8 as hex. */
export const toHex = (s) => Array.from(new TextEncoder().encode(String(s)), (b) => b.toString(16).padStart(2, '0')).join('');

// Control characters, direction overrides and isolates, zero-width and other invisible characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ￹-￻]/g;

/** A text from the chain as it is shown: one line (or paragraphs for a description), nothing invisible, at most `max` characters. */
export function cleanText(raw, max = 200, { paragraphs = false } = {}) {
  let s = String(raw || '').normalize('NFC');
  if (paragraphs) s = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
  else s = s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "1.4.2" from {major, minor, release, build} (the build number shown only when it is not 0). */
export function versionText(v) {
  const n = versionParts(v);
  return n[3] ? n.join('.') : n.slice(0, 3).join('.');
}
export function versionParts(v) {
  const p = (x) => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : 0);
  return v && typeof v === 'object' ? [p(v.major), p(v.minor), p(v.release), p(v.build)] : [0, 0, 0, 0];
}
/** -1, 0, 1: a's version against b's (four numbers each). */
export function compareVersions(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/** "1.4.2" (a manifest's version) as four numbers; null when it is not one. */
export function parseVersionText(text) {
  const m = /^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/.exec(String(text || '').trim());
  return m ? [1, 2, 3, 4].map((i) => Number(m[i] || 0)) : null;
}

/**
 * An icon as an image URL, or null. The store holds free text; the Desktop Wallet shows it as an
 * image source. Only an SVG data URL whose text is an <svg> element, or a base64 PNG / JPEG / WebP
 * data URL, is kept; an <img> runs no script, so an SVG there is inert.
 */
export function iconUrl(raw) {
  const s = String(raw || '').trim();
  if (s.length > LIMITS.icon * 2) return null;
  const svg = /^data:image\/svg\+xml(?:;charset=utf-?8)?(?:;utf8)?,([\s\S]+)$/i.exec(s);
  if (svg) {
    let text = svg[1];
    try {
      if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text);
    } catch {
      return null;
    }
    if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text.trim())}`;
  }
  const b64 = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(s.replace(/\s+/g, ''));
  if (b64) return `data:image/${b64[1].toLowerCase()};base64,${b64[2]}`;
  return null;
}

/** A website as an https link, or null (http is not linked: it would leave the app unencrypted). */
export function websiteUrl(raw) {
  const s = cleanText(raw, LIMITS.website);
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const HANDLE = /^@?([A-Za-z0-9_.-]{1,50})$/;
/** Social names as links where the network has a plain profile address; text otherwise. */
export function socialLinks(p) {
  const out = [];
  const add = (kind, label, raw, url) => {
    const s = cleanText(raw, LIMITS.social);
    if (!s) return;
    const h = HANDLE.exec(s);
    out.push({ kind, label, text: s, url: h && url ? url(h[1]) : null });
  };
  add('twitter', 'X (Twitter)', p.twitter, (h) => `https://x.com/${h}`); // i18n-ignore: a network's own name
  add('telegram', 'Telegram', p.telegram, (h) => `https://t.me/${h}`); // i18n-ignore: a network's own name
  add('instagram', 'Instagram', p.instagram, (h) => `https://www.instagram.com/${h}`); // i18n-ignore: a network's own name
  add('linkedin', 'LinkedIn', p.linkedin, (h) => `https://www.linkedin.com/in/${h}`);
  add('discord', 'Discord', p.discord, null); // i18n-ignore: a network's own name
  return out;
}

/** One publisher from view_publishers, cleaned; null when its key is not a key. */
export function parsePublisher(r) {
  const key = String((r && r.pubkey) || '').toLowerCase();
  if (!KEY.test(key)) return null;
  const field = (f, max) => cleanText(fromHex(r[f]), max);
  const raw = { twitter: fromHex(r.twitter), telegram: fromHex(r.telegram), instagram: fromHex(r.instagram), linkedin: fromHex(r.linkedin), discord: fromHex(r.discord) };
  return Object.freeze({
    key,
    // The stand-in names are BEAM Campfire's words, in the language of the moment the store is read.
    name: field('name', LIMITS.name) || t('Unnamed publisher'),
    title: field('short_title', LIMITS.title),
    about: cleanText(fromHex(r.about_me), LIMITS.about, { paragraphs: true }),
    website: websiteUrl(fromHex(r.website)),
    websiteText: field('website', LIMITS.website),
    socials: Object.freeze(socialLinks(raw)),
  });
}

/** One dApp from view_dapps, cleaned; null when its id, publisher or IPFS hash is malformed. */
export function parseDapp(r) {
  const id = String((r && r.id) || '').toLowerCase();
  const publisher = String((r && r.publisher) || '').toLowerCase();
  const cid = String((r && r.ipfs_id) || '').trim();
  if (!ID.test(id) || !KEY.test(publisher) || !CIDV0.test(cid)) return null;
  const apiVersion = cleanText(fromHex(r.api_version), LIMITS.version);
  const minApiVersion = cleanText(fromHex(r.min_api_version), LIMITS.version);
  const parts = versionParts(r.version);
  return Object.freeze({
    id,
    publisher,
    cid,
    name: cleanText(fromHex(r.name), LIMITS.name) || t('Unnamed dApp'),
    description: cleanText(fromHex(r.description), LIMITS.description, { paragraphs: true }),
    apiVersion,
    minApiVersion,
    // Served at this API version by this wallet, or null when it needs a newer one (lib/dapps/gate.js).
    servedApi: negotiateApiVersion({ wanted: apiVersion || null, minimum: minApiVersion || null }),
    version: Object.freeze(parts),
    versionText: versionText(r.version),
    category: categoryOf(r.category),
    timestamp: Number.isSafeInteger(Number(r.timestamp)) ? Number(r.timestamp) : 0,
    icon: iconUrl(fromHex(r.icon)),
  });
}

/**
 * The store as the screens use it: {publishers: Map key -> publisher (with dapps: []), dapps: [],
 * readAt}. dApps whose publisher is not listed keep a stand-in publisher (the key only).
 */
export function buildStore(publishersOut, dappsOut, { now = Date.now() } = {}) {
  const publishers = new Map();
  for (const r of (publishersOut && publishersOut.publishers) || []) {
    const p = parsePublisher(r);
    if (p && !publishers.has(p.key)) publishers.set(p.key, { ...p, dapps: [] });
  }
  const dapps = [];
  const seen = new Set();
  for (const r of (dappsOut && dappsOut.dapps) || []) {
    const d = parseDapp(r);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    if (!publishers.has(d.publisher)) publishers.set(d.publisher, { key: d.publisher, name: t('Unlisted publisher'), title: '', about: '', website: null, websiteText: '', socials: [], dapps: [] });
    publishers.get(d.publisher).dapps.push(d);
    dapps.push(d);
  }
  dapps.sort((a, b) => b.timestamp - a.timestamp || a.name.localeCompare(b.name));
  const store = { publishers, dapps, readAt: now };
  store.flags = flagsFor(store);
  return store;
}

/**
 * Why a store entry needs a second look, per dApp id and per publisher key:
 *   bundledName   its name reads like a dApp bundled with BEAM Campfire (FOMO -> F0M0 included)
 *   bundledId     it uses a bundled dApp's id: it can never be installed as that dApp
 *   sharedName    another publisher lists a dApp whose name reads the same
 *   publisherName another publisher's name reads the same
 */
export function flagsFor({ publishers, dapps }, catalogue = CATALOGUE) {
  const dapp = new Map();
  const publisher = new Map();
  const add = (m, k, f) => m.set(k, [...(m.get(k) || []), f]);
  const bundledByName = new Map(catalogue.map((c) => [canonical(c.name), c.name]));
  const bundledIds = new Map(catalogue.map((c) => [c.guid, c.name]));
  const byName = new Map();
  for (const d of dapps) {
    const k = canonical(d.name);
    if (k && bundledByName.has(k)) add(dapp, d.id, { code: 'bundledName', name: bundledByName.get(k) });
    if (bundledIds.has(d.id)) add(dapp, d.id, { code: 'bundledId', name: bundledIds.get(d.id) });
    if (k) byName.set(k, [...(byName.get(k) || []), d]);
  }
  for (const same of byName.values()) {
    const keys = new Set(same.map((d) => d.publisher));
    if (keys.size > 1) for (const d of same) add(dapp, d.id, { code: 'sharedName', count: keys.size - 1 });
  }
  const pubByName = new Map();
  for (const p of publishers.values()) {
    const k = canonical(p.name);
    if (k) pubByName.set(k, [...(pubByName.get(k) || []), p.key]);
  }
  for (const keys of pubByName.values()) if (keys.length > 1) for (const k of keys) add(publisher, k, { code: 'publisherName', count: keys.length - 1 });
  return { dapp, publisher };
}

/** The flags' words, for a dApp's page. */
export function flagText(f) {
  switch (f.code) {
    case 'bundledName':
      return t('Its name reads like {name}, which comes with BEAM Campfire. This is a different dApp from another publisher.', { name: f.name });
    case 'bundledId':
      return t('It uses the id of {name}, which comes with BEAM Campfire, so it cannot be installed here.', { name: f.name });
    case 'sharedName':
      return tn({ one: 'Another publisher lists a dApp with the same name. Check the publisher before you install it.', other: '{n} other publishers list a dApp with the same name. Check the publisher before you install it.' }, f.count);
    case 'publisherName':
      return tn({ one: 'Another publisher uses the same name. The key below is what tells them apart.', other: '{n} other publishers use the same name. The key below is what tells them apart.' }, f.count);
    default:
      return '';
  }
}

/**
 * The dApps shown: not hidden publishers', in a category ('all' or a CATEGORIES id), matching a
 * search over name, description and publisher name (case and accents ignored).
 */
export function visibleDapps(store, { hidden = new Set(), category = 'all', query = '' } = {}) {
  const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  return store.dapps.filter((d) => {
    if (hidden.has(d.publisher)) return false;
    if (category !== 'all' && d.category !== category) return false;
    if (!q) return true;
    const p = store.publishers.get(d.publisher);
    return fold(d.name).includes(q) || fold(d.description).includes(q) || (p && fold(p.name).includes(q));
  });
}

/** Publishers that list dApps, by name (as the Desktop Wallet lists them). */
export const listedPublishers = (store) => [...store.publishers.values()].filter((p) => p.dapps.length).sort((a, b) => a.name.localeCompare(b.name));

/** "d4cc34a1…c401": a key short enough to read, long enough to compare. */
export const shortKey = (k) => `${k.slice(0, 8)}…${k.slice(-6)}`;

/** The two view calls, through `view(args)` (an app's view with the pinned shader). */
export async function readStore(view, { cid = STORE_CID } = {}) {
  const [pubs, dapps] = [await view(`action=view_publishers,cid=${cid}`), await view(`action=view_dapps,cid=${cid}`)];
  return buildStore(pubs, dapps);
}
