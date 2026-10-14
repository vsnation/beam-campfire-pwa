// Burn: destroy some of a token for good, through BEAM's BlackHole contract. A port of the
// desktop app (lib/wallets/beam/contracts/burn/: blackhole_constants, beam_burn_service).
//
// The BlackHole has exactly one method, Method_2 (Deposit), which does FundsLock(aid, amount)
// and nothing else; nothing can ever unlock, and its destructor is empty. What goes in is gone.
// So a burn is checked like every other contract call here (pinned shader, one call to the
// BlackHole, method, no charge, kernel comment, no signing key, the exact token and amount,
// exactly those funds) and is sent only with the person's acknowledgement that it is forever.
// BEAM itself (asset 0) is never burned here.

import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { entryFee, le, concat, bytesEqual } from './contract_tx.js';
import { MAX_PER_TX, checkBuilt, expectFunds, consentExpectation, transactChecked, mapError as mapMinterError } from './minter.js';

/** The BlackHole on mainnet (explorer kind "BlackHole"). */
export const BLACKHOLE_CID = '5ab408982b148210e88f180114f10222a2235eafeede0a3a224fda0e523e17b7';
/** BlackHole::Method::Deposit. */
export const DEPOSIT_METHOD = 2;
/** The kernel comment deposit writes. */
export const KERNEL = 'Send to Black hole contract'; // i18n-ignore: the kernel comment the shader writes on chain, compared
/** 0.011 BEAM: a burn declares no BVM charge. */
export const BURN_FEE = entryFee({ argsBytes: 0, spendAssets: [1], charge: 0 });

const CID_RE = /^[0-9a-f]{64}$/;

function checkCid(cid) {
  if (!CID_RE.test(cid)) throw new RangeError('contract id: 64 lowercase hex'); // i18n-ignore: an internal invariant (the arguments are checked before)
}

/** The BlackHole app shader's args; its actions are under role=manager (the shader's only role). */
export const args = Object.freeze({
  deposit: ({ assetId, amount, cid = BLACKHOLE_CID }) => {
    checkCid(cid);
    if (!Number.isInteger(assetId) || assetId <= 0 || assetId > 0xffffffff) throw new RangeError('a token id, 1..2^32-1 (burning BEAM itself is refused)'); // i18n-ignore: an internal invariant (the arguments are checked before)
    const a = BigInt(amount);
    if (a <= 0n || a > MAX_PER_TX) throw new RangeError('amount must be 1..2^63-1'); // i18n-ignore: an internal invariant (the arguments are checked before)
    return `role=manager,action=deposit,cid=${cid},aid=${assetId},amount=${a}`;
  },
  /** Everything ever burned: {"res": [{aid, amount}]} (amount is the low 64 bits of the total). */
  viewFunds: ({ cid = BLACKHOLE_CID } = {}) => {
    checkCid(cid);
    return `role=manager,action=view_funds,cid=${cid}`;
  },
});

export class BurnError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    // busy, notAcknowledged, unexpected, shaderError
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * What a person types to confirm a burn: the ticker when it is plain letters and digits,
 * otherwise the asset's number (an unverified ticker may hold symbols that are hard to type).
 */
export function confirmWord(symbol, assetId) {
  const s = String(symbol || '');
  return /^[A-Za-z0-9]{1,8}$/.test(s) ? s.toUpperCase() : String(assetId);
}

/** True when what was typed confirms `word` (case and surrounding spaces do not matter). */
export const confirms = (typed, word) => String(typed || '').trim().toUpperCase() === word;

function mapError(e) {
  if (e instanceof BurnError) return e;
  const m = mapMinterError(e);
  if (m && m.code === 'noSuchToken') return new BurnError('shaderError', m.message);
  return m;
}

/**
 * Burns over one wallet session.
 *   deps.view(args) -> parsed shader output; deps.transact(args, {inspect, expect, intent}) -> txId
 */
export function createBurn(deps) {
  let flow = null;
  const fail = (what) => {
    throw new BurnError('unexpected', 'The wallet built a different transaction than requested, so nothing was burned.', { detail: what }); // i18n-ignore: never shown: minterProblem() gives code 'unexpected' its own words
  };

  const svc = {
    get busy() {
      return Boolean(flow);
    },

    /** Everything ever burned, per asset (low 64 bits of each total). */
    async burnedTotals() {
      let out;
      try {
        out = await deps.view(args.viewFunds());
      } catch (e) {
        throw mapError(e);
      }
      const list = out && Array.isArray(out.res) ? out.res : null;
      if (!list) throw new BurnError('unexpected', 'The BlackHole answered something this wallet cannot read.'); // i18n-ignore: never shown: minterProblem() gives code 'unexpected' its own words
      const totals = new Map();
      for (const row of list) {
        const aid = Number(row && row.aid);
        const v = row && (typeof row.amount === 'number' || typeof row.amount === 'string') ? BigInt(row.amount) : null;
        if (!Number.isInteger(aid) || aid < 0 || v == null || v < 0n) throw new BurnError('unexpected', 'The BlackHole answered something this wallet cannot read.'); // i18n-ignore: never shown: minterProblem() gives code 'unexpected' its own words
        totals.set(aid, v);
      }
      return totals;
    },

    /**
     * Burns `amount` (smallest units) of the token `assetId`. Refused unless `acknowledged` is
     * exactly true: a screen sets it only after the person typed the confirm word.
     * @returns {{ txId, fee, built }}
     */
    burn({ assetId, amount, ticker = '', acknowledged = false }) {
      if (acknowledged !== true) return Promise.reject(new BurnError('notAcknowledged', 'Confirm that the tokens will be destroyed forever.')); // i18n-ignore: never shown: minterProblem() gives this code its own words
      if (flow) return Promise.reject(new BurnError('busy', 'Another burn is in progress. Finish or cancel it first.')); // i18n-ignore: never shown: minterProblem() gives this code its own words
      const token = {};
      flow = token;
      return (async () => {
        try {
          const v = BigInt(amount);
          const a = args.deposit({ assetId, amount: v });
          let built = null;
          const txId = await transactChecked(
            deps,
            a,
            {
              intent: { action: 'burn', ticker },
              inspect: (raw) => {
                const d = checkBuilt(raw, { cid: BLACKHOLE_CID, method: DEPOSIT_METHOD, charge: 0, comment: KERNEL, sigs: 0 }, fail);
                if (!bytesEqual(d.entries[0].args, concat(le(assetId, 4), le(v, 8)))) fail('the burn arguments differ from the request'); // i18n-ignore: the detail of a refusal, for logs and tests; never shown
                expectFunds(d, new Map([[assetId, v]]), 'the burn', fail); // i18n-ignore: the detail of a refusal, for logs and tests; never shown
                built = d;
              },
              expect: consentExpectation(() => built),
            },
            mapError,
          );
          return { txId, fee: built.fee, built };
        } finally {
          if (flow === token) flow = null;
        }
      })();
    },
  };
  return svc;
}

let live = null;

/** Burns on the running wallet's own app and the pinned BlackHole shader. One per wallet session. */
export function burnFor(session) {
  if (live && live.session === session) return live.svc;
  const withApp = async () => {
    const [app, shader] = await Promise.all([nativeApp(), loadShader('blackhole')]);
    return { app, shader };
  };
  const svc = createBurn({
    view: async (a) => {
      const { app, shader } = await withApp();
      return app.view(a, shader, { timeoutMs: 120000 });
    },
    transact: async (a, opts) => {
      const { app, shader } = await withApp();
      return app.transact(a, shader, { ...opts, timeoutMs: 120000 });
    },
  });
  live = { session, svc };
  return svc;
}
