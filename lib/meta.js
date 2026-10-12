// How a Confidential Asset is named and drawn: the desktop app's catalogue
// (lib/wallets/beam/assets/beam_asset_catalog.dart), ported so both apps show
// the same name, ticker and icon for the same asset. test/unit/asset_parity.test.mjs
// runs this and the desktop's own code over every mainnet asset.
//
// - A verified asset (VERIFIED) gets Campfire's name, ticker and bundled icon.
// - A DEX liquidity token gets its pool's name, "BEAM/FOMO LP" (lp_tokens.js),
//   and is drawn as its pool's two icons. One the DEX's pool list named but the
//   asset's own record has not confirmed yet (lp_tokens.js) keeps the pool's name
//   in its title ("BEAM/FOMO LP #94", amounts in "LP #94"), and is shown and
//   valued as an unverified asset: a lying node can name anything a pool share.
// - Anything else shows its on-chain name and ticker, cleaned, always next to its
//   number (#id), with the BEAM desktop wallet's generic icon for that number.
//
// Metadata ("STD:SCH_VER=1;N=Name;SN=Short;UN=UNIT;...") is written by whoever
// created the asset, so it is untrusted text: only an allow-list of printable
// characters is kept, lengths are capped, and it reaches the screen only through
// textContent. Its icon and logo URLs are never fetched (IP privacy: the app talks
// to this origin and the node, nobody else); every icon ships inside the release.

import { copiedKey, ID_LABEL } from './lookalike.js';
import { lpPoolOf, lpVersion } from './lp_tokens.js';
import { KINDS } from './dex.js';

const ICONS = 'img/assets';
const GENERIC = `${ICONS}/generic`;

/**
 * Assets Campfire vouches for, names checked against their on-chain metadata.
 * Anyone can create an asset called "FOMO"; only these ids get these names
 * without a number. CHAD and GIGA each exist twice: 186/187 are the first
 * MemeClash pair, 190/191 the current one. Icons: img/assets/NOTICE.txt.
 */
export const VERIFIED = Object.freeze({
  0: { name: 'BEAM', symbol: 'BEAM', color: '#25c2a0', icon: 'img/beam.svg' },
  4: { name: 'Gothic Crown', symbol: 'CROWN', color: '#ffd700', icon: `${ICONS}/4.png` },
  6: { name: 'Rangers Fan Token', symbol: 'RFC', color: '#0066cc' },
  7: { name: 'BeamX', symbol: 'BEAMX', color: '#da70d6', icon: `${ICONS}/7.png` },
  9: { name: 'Tico', symbol: 'TICO', color: '#e91e63', icon: `${ICONS}/9.png` },
  // The Beam Bridge's wrapped Ethereum assets (no icons of their own yet: the generic one for the id).
  36: { name: 'Wrapped ETH', symbol: 'bETH', color: '#627eea' },
  37: { name: 'Wrapped USDT', symbol: 'bUSDT', color: '#26a17b' },
  38: { name: 'Wrapped WBTC', symbol: 'bWBTC', color: '#f09242' },
  39: { name: 'Wrapped DAI', symbol: 'bDAI', color: '#f5ac37' },
  47: { name: 'Nephrite', symbol: 'NPH', color: '#3498db', icon: `${ICONS}/47.svg` },
  174: { name: 'FOMO', symbol: 'FOMO', color: '#60a5fa', icon: `${ICONS}/174.png` },
  186: { name: 'Giga', symbol: 'GIGA', color: '#a855f7', icon: `${ICONS}/186.png` },
  187: { name: 'Chad', symbol: 'CHAD', color: '#25c2a0', icon: `${ICONS}/187.png` },
  190: { name: 'Chad', symbol: 'CHAD', color: '#25c2a0', icon: `${ICONS}/187.png` },
  191: { name: 'GigaChad', symbol: 'GIGA', color: '#a855f7', icon: `${ICONS}/186.png` },
});

// ---------------------------------------------------------------- icons

/**
 * The BEAM desktop wallet's generic asset icons (img/assets/generic, Apache-2.0),
 * used as it uses them: an asset with no icon of its own gets asset-<id % 20>,
 * so one asset always looks the same, here and in the desktop wallets. The
 * choice depends only on the id, never on anything the asset's creator wrote.
 */
export const GENERIC_ICON_COUNT = 20;
export const genericIcon = (assetId) => `${GENERIC}/asset-${Number(assetId) % GENERIC_ICON_COUNT}.svg`;

/** For an asset id the network does not know. */
export const MISSING_ICON = `${GENERIC}/asset-err.svg`;

/** Generic icons a verified asset already wears (RFC #6 shows asset-6). */
const VERIFIED_GENERIC = new Set(Object.entries(VERIFIED).filter(([, k]) => !k.icon).map(([id]) => genericIcon(id)));

/** genericIcon for an asset Campfire does not vouch for, skipping any a verified asset wears. */
export function unverifiedIcon(assetId) {
  for (let i = 0; i < GENERIC_ICON_COUNT; i++) {
    const p = genericIcon(Number(assetId) + i);
    if (!VERIFIED_GENERIC.has(p)) return p;
  }
  return MISSING_ICON;
}

/**
 * Bundled icons that are not a filled circle of their own, with how far (a
 * fraction of the icon's size) to inset them on a neutral disc with a hairline
 * edge: NPH's bare triangle, GIGA's face cut out on transparency, CHAD's face on
 * a white square. Every other icon fills its circle.
 */
const FRAMED = Object.freeze({ [`${ICONS}/47.svg`]: 0.17, [`${ICONS}/186.png`]: 0, [`${ICONS}/187.png`]: 0 });
export const frameInset = (icon) => (Object.prototype.hasOwnProperty.call(FRAMED, icon) ? FRAMED[icon] : null);

// The desktop wallet's accent colours, in the same order as its icons. An
// unverified asset's own OPT_COLOR is never used: its creator could pick a verified one's.
const GENERIC_COLORS = ['#72fdff', '#2acf1d', '#ffbb54', '#d885ff', '#008eff', '#ff746b', '#91e300', '#ffe75a', '#9643ff', '#395bff', '#ff3b3b', '#73ff7c', '#ffa86c', '#ff3abe', '#00aee1', '#ff5200', '#6464ff', '#ff7a21', '#63afff', '#c81f68'];
export const genericColor = (assetId) => GENERIC_COLORS[Number(assetId) % GENERIC_COLORS.length];

// ---------------------------------------------------------------- metadata

/**
 * The fields of "STD:..." metadata, as the desktop reads them (BeamAssetMetadata):
 * anything without the STD: prefix has none; a repeated key keeps its last value.
 */
export function parseMetadata(raw) {
  const values = new Map();
  if (typeof raw !== 'string' || !raw.startsWith('STD:')) return values;
  for (const entry of raw.slice(4).split(';')) {
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    values.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return values;
}

const MAX_NAME = 32;
const MAX_SYMBOL = 8;
const MAX_RAW = 512;
const MAX_MARKS = 2;
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const SPACE = /^[\p{Zs}\t]$/u;
const MARK = /^\p{M}$/u;
const NUMBER_SIGNS = new Set(['#', '＃', '﹟']);

/** Letters and marks that render as nothing, so a name cannot look empty or hide characters. */
const blank = (r) => r === 0x115f || r === 0x1160 || r === 0x3164 || r === 0xffa0 || r === 0x2800 || r === 0x17b4 || r === 0x17b5 || r === 0x034f || (r >= 0x180b && r <= 0x180f) || (r >= 0xfe00 && r <= 0xfe0f) || (r >= 0xe0100 && r <= 0xe01ef);

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Characters as people see them (grapheme clusters). */
function graphemes(text) {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  // Without Intl.Segmenter: a base character with the marks after it.
  const out = [];
  for (const ch of text) {
    if (out.length && MARK.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * Printable characters only, any run of spaces as one, no borrowed "#174"
 * (Campfire's id label is Campfire's), at most `max` characters as people see
 * them; null when nothing usable is left. On-chain names are attacker text.
 */
export function cleanText(raw, max) {
  if (raw == null) return null;
  let text = String(raw);
  if (text.length > MAX_RAW) text = text.slice(0, MAX_RAW);
  text = text.replaceAll(ID_LABEL, ' ');
  let out = '';
  for (const cluster of graphemes(text)) {
    let base = false;
    let marks = 0;
    for (const c of cluster) {
      const r = c.codePointAt(0);
      if (blank(r)) continue;
      if (MARK.test(c)) {
        if (base && marks < MAX_MARKS) {
          out += c;
          marks++;
        }
      } else if (SPACE.test(c)) {
        out += ' ';
        base = false;
      } else if (PRINTABLE.test(c) && !NUMBER_SIGNS.has(c)) {
        out += c;
        base = true;
      }
    }
  }
  const kept = out.replace(/ {2,}/g, ' ').trim();
  if (!kept) return null;
  const chars = graphemes(kept);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : kept;
}

/** "Asset #557": an unverified asset whose metadata gave no name. */
export const placeholderName = (assetId) => `Asset #${assetId}`;
/** "#557": an unverified asset whose metadata gave no ticker. */
export const placeholderSymbol = (assetId) => `#${assetId}`;

const KNOWN = Object.fromEntries(Object.entries(VERIFIED).map(([id, k]) => [id, { symbol: k.symbol, name: k.name }]));

/** The verified asset an unverified one named `name` with ticker `symbol` copies, or null. */
export const impersonationOf = (name, symbol) => copiedKey(name, symbol, KNOWN);

// ---------------------------------------------------------------- display

/** An LP token of a pool of LP tokens of… is named this many levels deep at most. */
const MAX_LP_DEPTH = 3;

const labelOf = (d) => (d.verified || d.symbol === `#${d.id}` ? d.symbol : `${d.symbol} #${d.id}`);
const pairSide = (d) => (d.pool || d.unconfirmedPool ? `(${d.label})` : d.label);

/**
 * How to show `assetId`: { id, name, symbol, label, verified, icon, color,
 * impersonates, pool, unconfirmedPool }. `raw` is its on-chain metadata (or null); `metaOf(id)`
 * gives another asset's, for an LP token's unverified side ("BEAM/PEPE #94 LP").
 * `label` is the ticker as a sentence names it: "FOMO" for a verified asset (or an
 * LP token of two), "PEPE #94" for anything else.
 */
export function display(assetId, raw, metaOf = () => null, depth = 0) {
  const id = Number(assetId);
  const known = VERIFIED[id];
  if (known) {
    return finish({ id, name: known.name, symbol: known.symbol, verified: true, icon: known.icon || genericIcon(id), color: known.color, impersonates: null, pool: null });
  }
  const pool = lpPoolOf(id);
  if (pool && depth < MAX_LP_DEPTH) {
    const side = (aid) => display(aid, metaOf(aid), metaOf, depth + 1);
    const a = side(pool.aid1);
    const b = side(pool.aid2);
    const name = `${pairSide(a)}/${pairSide(b)} LP`;
    // Not confirmed by the asset's own record: an unverified asset that says which pool it claims (audit D-5).
    // Its ticker is "LP", so amounts read "2.5 LP #94": short, and never without the number.
    if (!pool.confirmed) return finish({ id, name, symbol: 'LP', verified: false, icon: unverifiedIcon(id), color: genericColor(id), impersonates: null, pool: null, unconfirmedPool: pool });
    // For places that cannot draw a pair: the desktop wallet's generic icon for the id.
    return finish({ id, name, symbol: name, verified: a.verified && b.verified, icon: unverifiedIcon(id), color: genericColor(id), impersonates: null, pool });
  }
  const m = parseMetadata(raw);
  const rawName = m.has('N') ? m.get('N') : null;
  const rawSymbol = m.has('UN') ? m.get('UN') : m.has('SN') ? m.get('SN') : null;
  return finish({
    id,
    name: cleanText(rawName, MAX_NAME) ?? placeholderName(id),
    symbol: cleanText(rawSymbol, MAX_SYMBOL) ?? placeholderSymbol(id),
    verified: false,
    icon: unverifiedIcon(id),
    color: genericColor(id),
    // Judged on the raw text: cleaning drops a borrowed "#174".
    impersonates: impersonationOf(rawName, rawSymbol),
    pool: null,
  });
}

function finish(d) {
  if (!('unconfirmedPool' in d)) d.unconfirmedPool = null;
  d.label = labelOf(d);
  // What screens put after an amount: the ticker, with the number for an asset
  // Campfire does not vouch for ("5 PEPE #94"), so a copy never reads like the real one.
  d.unit = d.label;
  return Object.freeze(d);
}

// ---------------------------------------------------------------- live labels

// Metadata this page has read from the chain, by asset id. A chain fact, the same
// for every wallet: an asset's metadata is fixed when it is created.
const seen = new Map();
let seenVersion = 0;

/** The on-chain metadata read so far for `assetId`, or null. */
export const metadataOf = (assetId) => seen.get(Number(assetId)) ?? null;

const FIELDS = ['name', 'symbol', 'unit', 'label', 'verified', 'icon', 'color', 'impersonates', 'pool', 'unconfirmedPool'];

/**
 * The name and ticker to show for an asset id with (maybe) metadata (see display).
 * The object stays current: its fields are worked out again once metadata for it
 * (or for an LP token's side) arrives, or the DEX names it as a pool's LP token.
 * `symbol` is the bare ticker ("PEPE", "#557" when there is none); `unit` and
 * `label` the ticker as money screens write it ("FOMO", "BEAM/FOMO LP", "PEPE #94").
 */
export function assetLabel(assetId, raw) {
  const id = Number(assetId);
  if (typeof raw === 'string' && seen.get(id) !== raw) {
    seen.set(id, raw);
    seenVersion++;
  }
  let at = '';
  let look = null;
  const now = () => {
    const v = `${seenVersion}:${lpVersion()}`;
    if (v !== at) {
      look = display(id, metadataOf(id), metadataOf);
      at = v;
    }
    return look;
  };
  const label = { id };
  for (const f of FIELDS) Object.defineProperty(label, f, { enumerable: true, get: () => now()[f] });
  return Object.freeze(label);
}

/** Under a token's name, as on the desktop's asset list: "FOMO", "Pool share · 1% fee", "PEPE · Unverified #94". */
export function tokenSubtitle(l) {
  if (l.pool) return KINDS[l.pool.kind] ? `Pool share · ${KINDS[l.pool.kind].percent} fee` : 'Pool share';
  if (l.unconfirmedPool) return `Pool share · unconfirmed #${l.id}`;
  if (l.verified) return l.symbol;
  return `${l.symbol === `#${l.id}` ? '' : `${l.symbol} · `}Unverified #${l.id}`;
}

/** The warning under an asset that copies a verified one (the desktop's wording). */
export function copyWarning(l) {
  if (l.impersonates == null) return null;
  const real = VERIFIED[l.impersonates];
  return `Not the verified ${real ? real.symbol : `#${l.impersonates}`} (#${l.impersonates}). Anyone can create an asset with any name.`;
}

/** Up to two letters for a round badge without an icon ("FO", "bE", "#9"). */
export function badgeText(label) {
  const u = String(label.symbol || label.unit || '');
  if (u.startsWith('#') || u.startsWith('Asset #')) return label.id >= 0 && label.id < 100 ? `#${label.id}` : 'CA'; // never a cut-off number
  const letters = [...u.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('');
  return letters || `#${label.id}`;
}
