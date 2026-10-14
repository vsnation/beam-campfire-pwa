// The DEX's pool list, read through the wallet's own node (a read-only call of
// the pinned AMM shader), shared by Swap and Home. Every read also teaches
// lp_tokens.js which assets are liquidity tokens, so a pool created after this
// release is named "BEAM/XYZ LP" like the ones in its snapshot - once the
// wallet's own record of that asset agrees (get_asset_info): the list is one
// node's word, and a lying one could call any asset a pool share (audit D-5).
import { wallet } from './wallet.js';
import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { poolsViewArgs, parsePools, DexError } from './dex.js';
import { learnPools, lpPoolOf, confirmLearnt, unconfirmedLpTokens } from './lp_tokens.js';
import { VERIFIED } from './meta.js';
import { t } from './i18n.js';

const POOLS_TTL_MS = 30000;
let poolCache = null; // { at, pools, session }

export async function dexApp() {
  const [app, shader] = await Promise.all([nativeApp(), loadShader('amm')]);
  return { app, shader };
}

/** Every pool (lib/dex.js parsePools), at most 30 s old unless `force`. */
const EMPTY_RETRY_MS = 3000;

export async function loadPools(force = false) {
  if (!force && poolCache && poolCache.session === wallet.session && Date.now() - poolCache.at < POOLS_TTL_MS) return poolCache.pools;
  const { app, shader } = await dexApp();
  let pools = parsePools(await app.view(poolsViewArgs(), shader));
  // BEAM's DEX holds dozens of pools: an empty list is a read that failed (seen 2026-10-13, for a few
  // seconds after sync), not a market with nothing in it. Asked once more after 3 s; never cached,
  // never "nothing can be bought".
  if (!pools.length) {
    await new Promise((r) => setTimeout(r, EMPTY_RETRY_MS));
    pools = parsePools(await app.view(poolsViewArgs(), shader));
  }
  if (!pools.length) throw new DexError('unexpected', t("BEAM's exchange sent no prices yet. Try again in a moment"));
  learnPools(pools);
  confirmLearntPools();
  poolCache = { at: Date.now(), pools, session: wallet.session };
  return pools;
}

let confirming = null;

/**
 * Confirms the LP tokens learnt from pool lists against the wallet's own asset
 * records (lib/lp_tokens.js confirmLearnt), in the background; the screens are
 * drawn again when one is. A token the wallet has no record of yet stays
 * unconfirmed and is asked about again with the next pool read.
 */
function confirmLearntPools() {
  const session = wallet.session;
  if (confirming || !session || !unconfirmedLpTokens().length) return confirming;
  confirming = confirmLearnt((id) => session.call('get_asset_info', { asset_id: id }, { timeoutMs: 20000 }))
    .then((any) => {
      if (any && wallet.session === session) wallet.emit();
      return any;
    })
    .catch(() => false)
    .finally(() => {
      confirming = null;
    });
  return confirming;
}

// Ids already compared with a pool list in this session: no second read for them.
let checked = { session: null, ids: new Set(), tried: 0 };
const RETRY_MS = 5 * 60000;

/**
 * Whether any of `ids` (assets this wallet holds) is neither verified nor a known
 * LP token, and has not been compared with the DEX's pool list in this session:
 * one of them may be the LP token of a pool newer than the snapshot.
 */
export function needsPoolCheck(ids) {
  if (checked.session !== wallet.session) checked = { session: wallet.session, ids: new Set(), tried: 0 };
  if (Date.now() - checked.tried < RETRY_MS) return false;
  return ids.some((id) => id > 0 && !VERIFIED[id] && !lpPoolOf(id) && !checked.ids.has(id));
}

/**
 * Reads the pool list once for `ids` (see needsPoolCheck). True when it named a
 * new LP token among them. Failures are quiet: the asset keeps the name it has,
 * and the check is tried again after a while.
 */
export async function checkPools(ids) {
  checked.tried = Date.now();
  const before = ids.filter((id) => lpPoolOf(id)).length;
  try {
    await loadPools();
  } catch {
    return false;
  }
  for (const id of ids) checked.ids.add(id);
  checked.tried = 0;
  return ids.filter((id) => lpPoolOf(id)).length > before;
}
