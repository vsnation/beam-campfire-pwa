// Which Confidential Assets are BEAM DEX liquidity (LP) tokens, and of which pool.
// The desktop app's lib/wallets/beam/contracts/dex/beam_lp_tokens.dart, plus a
// snapshot so the names are right from the first frame.
//
// An LP token's own metadata is the contract's text ("Amm Liquidity Token
// 0-174-2", UN=AMML), but anyone can mint an asset with that text. So an asset
// is an LP token here only when the DEX contract says so: the snapshot below
// (the DEX's pool list as read from the chain), or a row of its pool list
// (pools_view, learnt at run time by learnPools) that the asset's own record
// agrees with. Never from a name.
//
// The mapping is a fact of the chain: an LP token belongs to one pool for its
// whole life (a destroyed and re-created pool mints a new one), so it is kept
// once per page and the snapshot never goes stale; pools created after it are
// learnt from the DEX when a screen reads it (Home, Swap).
//
// A pool list is one node's unproven answer (audit D-5): a lying one could name
// any asset - an airdropped one, say - "BEAM/FOMO LP" and value it from made-up
// reserves. So a row never changes a snapshot entry (or a confirmed one), and a
// learnt LP token stays unconfirmed - shown with its number, never verified,
// never valued as a pool share - until the wallet's own record of that asset
// (get_asset_info) says the DEX contract created it with that pool's text: its
// metadata is exactly lpMetadata() and its owner id is the one BEAM derives from
// the DEX's id and that metadata (contractAssetOwner).

import { DEX_CID } from './dex.js';

/**
 * Every pool of the DEX contract 729fe098…9cbf at mainnet height 4,074,459
 * (2026-10-10): LP token -> [aid1, aid2, kind]. Read from the contract's state,
 * and checked against the asset list: each of these 98 assets is owned by the
 * DEX contract and its metadata names the same pool ("Amm Liquidity Token
 * <aid1>-<aid2>-<kind>"); no other asset is.
 */
export const SNAPSHOT = Object.freeze({
  50: [0, 7, 2], 52: [0, 9, 0], 53: [0, 9, 2], 54: [0, 4, 0], 55: [0, 2, 2], 56: [0, 7, 1], 57: [0, 7, 0],
  58: [0, 37, 2], 59: [0, 3, 2], 60: [0, 47, 2], 61: [17, 47, 2], 62: [4, 9, 0], 63: [0, 36, 0],
  64: [7, 52, 0], 65: [7, 63, 0], 66: [7, 54, 0], 67: [0, 60, 2], 70: [0, 69, 2], 71: [0, 10, 2],
  72: [0, 1, 2], 73: [37, 47, 2], 74: [7, 23, 2], 75: [0, 74, 2], 76: [0, 40, 2], 77: [0, 36, 2],
  78: [2, 7, 2], 79: [9, 24, 2], 80: [47, 69, 2], 81: [0, 6, 2], 82: [7, 37, 2], 83: [7, 47, 2],
  85: [0, 26, 2], 88: [0, 87, 0], 89: [0, 37, 1], 91: [37, 47, 1], 92: [0, 90, 0], 95: [0, 38, 2],
  97: [87, 96, 0], 98: [0, 70, 2], 99: [0, 17, 2], 101: [0, 100, 2], 102: [0, 22, 0], 104: [0, 18, 2],
  105: [0, 39, 2], 106: [39, 47, 2], 107: [0, 18, 0], 109: [0, 108, 2], 110: [36, 38, 1], 112: [0, 111, 2],
  113: [0, 12, 0], 115: [0, 114, 2], 117: [0, 116, 2], 118: [0, 116, 1], 119: [7, 50, 1], 120: [9, 53, 1],
  121: [36, 77, 2], 124: [0, 122, 0], 126: [0, 125, 0], 128: [0, 127, 1], 129: [7, 127, 1], 130: [9, 47, 0],
  132: [0, 131, 2], 133: [0, 2, 0], 134: [0, 5, 2], 136: [0, 135, 0], 139: [0, 138, 2], 140: [0, 26, 1],
  142: [0, 141, 0], 143: [0, 141, 2], 144: [47, 108, 0], 146: [0, 145, 2], 147: [0, 50, 2], 148: [7, 108, 0],
  149: [0, 10, 0], 152: [0, 151, 2], 154: [0, 153, 0], 155: [7, 153, 0], 157: [0, 156, 2], 158: [0, 103, 0],
  160: [0, 159, 1], 162: [0, 161, 0], 164: [0, 163, 0], 166: [0, 165, 0], 168: [0, 167, 2], 170: [0, 169, 0],
  171: [7, 131, 2], 172: [0, 8, 1], 175: [0, 174, 2], 176: [7, 60, 2], 177: [0, 150, 2], 188: [0, 187, 2],
  189: [0, 186, 2], 192: [0, 190, 2], 193: [0, 191, 2], 197: [0, 18, 1], 199: [0, 198, 2], 201: [0, 200, 1],
  203: [0, 202, 1],
});

const byLp = new Map();
let version = 0;

/** Bumped whenever a pool is learnt or confirmed: names that depend on it are worked out again. */
export const lpVersion = () => version;

const isId = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;

function put(lpToken, aid1, aid2, kind, confirmed) {
  byLp.set(lpToken, Object.freeze({ lpToken, aid1, aid2, kind, confirmed }));
  version++;
}

/**
 * Records one pool ({lpToken, aid1, aid2, kind}) read from the DEX, unconfirmed.
 * Ignores anything malformed, as the desktop does: the LP token must be a
 * Confidential Asset distinct from the pool's two assets, which must be in the
 * contract's order (aid1 < aid2). Never changes a snapshot or confirmed entry.
 */
export function learnPool(p) {
  if (!p) return;
  const lpToken = Number(p.lpToken);
  const aid1 = Number(p.aid1);
  const aid2 = Number(p.aid2);
  const kind = Number(p.kind);
  if (![lpToken, aid1, aid2].every(isId) || !Number.isInteger(kind)) return;
  if (lpToken <= 0 || aid1 >= aid2 || lpToken === aid1 || lpToken === aid2) return;
  const old = byLp.get(lpToken);
  if (old && (old.confirmed || (old.aid1 === aid1 && old.aid2 === aid2 && old.kind === kind))) return;
  put(lpToken, aid1, aid2, kind, false);
}

/** Records the LP token of every pool of a pools_view (lib/dex.js parsePools). */
export function learnPools(pools) {
  for (const p of pools || []) if (p && p.lpToken != null) learnPool(p);
}

/**
 * The pool `assetId` is the LP token of ({lpToken, aid1, aid2, kind, confirmed}),
 * or null when it is not one (or not known yet). Only a confirmed one may be
 * shown or valued as a pool share (lib/meta.js, lib/pricer.js).
 */
export function lpPoolOf(assetId) {
  return byLp.get(Number(assetId)) || null;
}

/** Whether a pool row's LP token is that pool's, as far as this wallet knows (snapshot or confirmed). */
export function lpTrusted(row) {
  const e = row && byLp.get(Number(row.lpToken));
  return Boolean(e && e.confirmed && e.aid1 === Number(row.aid1) && e.aid2 === Number(row.aid2) && e.kind === Number(row.kind));
}

/** Learnt LP tokens whose asset record has not agreed yet. */
export function unconfirmedLpTokens() {
  return [...byLp.values()].filter((e) => !e.confirmed).map((e) => e.lpToken);
}

/** The metadata the DEX contract gives the LP token of pool aid1-aid2-kind (bvm/Shaders/amm/contract.cpp, PoolCreate). */
export const lpMetadata = (aid1, aid2, kind) => `STD:SCH_VER=1;N=Amm Liquidity Token ${aid1}-${aid2}-${kind};SN=AmmL;UN=AMML;NTHUN=GROTH`;

const enc = new TextEncoder();
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const toHex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (...parts) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', concat(parts)));
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** BEAM's hash encoding of a length: 7 bits at a time, low first, the top bit saying more follows. */
function varint(n) {
  const out = [];
  for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n % 0x80) | 0x80);
  out.push(n);
  return Uint8Array.from(out);
}

/**
 * The owner id the wallet API reports (get_asset_info ownerId) for an asset that
 * contract `cidHex` created with `metadata`: BEAM derives it from the two
 * (core/block_crypt.cpp, Asset::Metadata::UpdateHash and get_Owner):
 *   SHA-256("bvm.a.own\0" || cid || SHA-256("B.AssetMeta\0" || varint(length) || metadata)).
 * Nothing but that contract can create an asset with that owner.
 */
export async function contractAssetOwner(cidHex, metadata) {
  const m = enc.encode(metadata);
  const metaHash = await sha256(enc.encode('B.AssetMeta\0'), varint(m.length), m);
  return toHex(await sha256(enc.encode('bvm.a.own\0'), fromHex(cidHex), metaHash));
}

/**
 * Confirms a learnt LP token when `info` (its get_asset_info record) says the
 * DEX contract created it as that pool's LP token. True when it did.
 *
 * The owner id binds the contract and the text, not the asset's number, so a
 * record could be copied onto another number. A pool has one LP token while it
 * lives (PoolCreate fails for a pool that exists), so a second one for a pool
 * this wallet already knows the token of is refused. (A pool destroyed and made
 * again after the snapshot stays unconfirmed until a release updates it: safe.)
 */
export async function confirmLpToken(lpToken, info) {
  const e = byLp.get(Number(lpToken));
  if (!e || e.confirmed || !info || Number(info.asset_id) !== e.lpToken) return false;
  for (const o of byLp.values()) if (o.confirmed && o.aid1 === e.aid1 && o.aid2 === e.aid2 && o.kind === e.kind) return false;
  const want = lpMetadata(e.aid1, e.aid2, e.kind);
  if (info.metadata !== want || typeof info.ownerId !== 'string') return false;
  if (info.ownerId.toLowerCase() !== (await contractAssetOwner(DEX_CID, want))) return false;
  // Still the same row after the hash (a different one may have been learnt meanwhile).
  if (byLp.get(e.lpToken) !== e) return false;
  put(e.lpToken, e.aid1, e.aid2, e.kind, true);
  return true;
}

/**
 * Asks getInfo(id) (the wallet's get_asset_info) for every unconfirmed LP token
 * and confirms the ones that agree. Failures are quiet: the token stays
 * unconfirmed. True when one was confirmed.
 */
export async function confirmLearnt(getInfo) {
  let any = false;
  for (const id of unconfirmedLpTokens()) {
    try {
      if (await confirmLpToken(id, await getInfo(id))) any = true;
    } catch {
      /* not in the wallet's records yet: stays unconfirmed */
    }
  }
  return any;
}

/** Back to the snapshot alone (tests). */
export function resetLpTokens() {
  byLp.clear();
  for (const [lp, [aid1, aid2, kind]] of Object.entries(SNAPSHOT)) put(Number(lp), aid1, aid2, kind, true);
  version++;
}

resetLpTokens();
