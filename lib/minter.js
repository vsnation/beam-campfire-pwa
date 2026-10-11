// Your own token on BEAM: BEAM's Minter contract creates a Confidential Asset
// with a supply ceiling, lists the ones this wallet created, and mints more of
// them. A port of the desktop app (lib/wallets/beam/contracts/minter/:
// minter_constants, minter_args, minter_models, token_metadata,
// beam_minter_service).
//
// Every transaction is built by the pinned app shader (lib/shaders.js 'minter')
// and checked byte for byte (lib/contract_tx.js) before the wallet is asked to
// sign: one call to the live Minter, the expected method, BVM charge, kernel
// comment and signing key count, the exact arguments (limit, metadata; token
// and amount) and exactly the expected funds. The approve sheet must then show
// the same amounts and fee, or nothing is sent.
//
// Creating a token costs the Minter's issuance fee (read from the contract with
// view_params, never assumed; 50 BEAM on mainnet) plus the 10 BEAM deposit every
// asset locks, plus the network fee. Neither comes back: the Minter has no way to
// destroy an asset.

import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { readContractTx, entryFee, InvokeDataError, le, concat, bytesEqual, spendText } from './contract_tx.js';

/** The Minter on mainnet (explorer kind "Minter"). */
export const MINTER_CID = '295fe749dc12c55213d1bd16ced174dc8780c020f59cb17749e900bb0c15d868';

/** Contract methods (minter/contract.h, Minter::Method). */
export const METHOD = Object.freeze({ view: 2, createToken: 3, withdraw: 4 });

/**
 * BVM charge create_token declares (On_create_token): CallFar x2 (20,000) + FundsLock (2,000)
 * + LoadVar_For(40-byte Settings) (7,000) + SaveVar_For(65-byte Token) (26,500) + AssetManage
 * (100,000) + 300 cycles (1,500) = 157,000 units. withdraw (mint) declares none.
 */
export const CREATE_CHARGE = 157000;
export const KERNEL = Object.freeze({ createToken: 'Creating asset', mint: 'Minting asset' });

/** What every new asset locks besides the issuance fee (g_Beam2Groth * 10 in the shader). Never returned. */
export const ASSET_DEPOSIT = 1000000000n;
/** 0.0167 BEAM: create_token's network fee (100,000 + 10 x 157,000 groth). */
export const CREATE_FEE = entryFee({ argsBytes: 0, spendAssets: [0], charge: CREATE_CHARGE });
/** 0.011 BEAM: a mint declares no charge. */
export const MINT_FEE = entryFee({ argsBytes: 0, spendAssets: [1], charge: 0 });

/** Every BEAM wallet shows assets on the groth scale: 1 token = 10^8 of its smallest unit. */
export const NTH_RATIO = 100000000n;
export const MAX_U64 = (1n << 64n) - 1n;
/** The largest supply ceiling the contract stores (128 bits). An empty "Maximum supply" asks for it. */
export const MAX_LIMIT = (1n << 128n) - 1n;
/**
 * The most one transaction can mint or burn: the engine writes funds as signed 64-bit
 * numbers, so anything from 2^63 up could not be read back (and would not be sent).
 */
export const MAX_PER_TX = (1n << 63n) - 1n;

export const LIMITS = Object.freeze({ name: 64, shortName: 6, unitName: 8, nthUnitName: 16, shortDescription: 128, longDescription: 1024, url: 512, encoded: 16 * 1024 });

// ---------------------------------------------------------------- metadata

/** Which field of a token's details is wrong, and how, in words a screen can show next to it. */
export class MetadataError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field; // name, shortName, unitName, nthUnitName, shortDescription, longDescription, color, siteUrl, pdfUrl, logoUrl, whole
  }
}

const STANDARD = /^[A-Za-z0-9 .,\-_]+$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const URL_RE = /^https?:\/\/[^\s;"\\]+$/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[;"\\\x00-\x1f\x7f]/;
const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;

const LABELS = { name: 'Name', shortName: 'Short name', unitName: 'Unit name', nthUnitName: 'Smallest unit name' };

function standard(field, v) {
  const label = LABELS[field];
  const max = LIMITS[field];
  if (typeof v !== 'string' || v === '' || v.trim() !== v) throw new MetadataError(field, `${label} cannot be empty or start or end with a space.`);
  if (v.length > max) throw new MetadataError(field, `${label} can be at most ${max} characters.`);
  if (!STANDARD.test(v)) throw new MetadataError(field, `${label} can use English letters, digits, spaces and . , - _ only.`);
}

function text(field, v) {
  if (v == null) return;
  if (v === '' || FORBIDDEN.test(v)) throw new MetadataError(field, 'The description cannot be empty or contain ; " \\ or line breaks.');
  if (bytesOf(v) > LIMITS[field]) throw new MetadataError(field, `The description can be at most ${LIMITS[field]} bytes.`);
}

function link(field, v) {
  if (v == null) return;
  if (v.length > LIMITS.url || !URL_RE.test(v)) throw new MetadataError(field, 'Use a full web address that starts with https, without spaces, ; " or \\.');
}

function checkOne(field, m) {
  switch (field) {
    case 'name':
    case 'shortName':
    case 'unitName':
    case 'nthUnitName':
      return standard(field, m[field]);
    case 'shortDescription':
    case 'longDescription':
      return text(field, m[field]);
    case 'color':
      if (m.color != null && !COLOR.test(m.color)) throw new MetadataError('color', 'Use a colour like #25C2A0.');
      return undefined;
    case 'siteUrl':
    case 'pdfUrl':
    case 'logoUrl':
      return link(field, m[field]);
    default:
      throw new MetadataError('whole', `unknown field ${field}`);
  }
}

const ORDER = ['name', 'shortName', 'unitName', 'nthUnitName', 'shortDescription', 'longDescription', 'color', 'siteUrl', 'pdfUrl', 'logoUrl'];
const KEYS = { name: 'N', shortName: 'SN', unitName: 'UN', nthUnitName: 'NTHUN', shortDescription: 'OPT_SHORT_DESC', longDescription: 'OPT_LONG_DESC', color: 'OPT_COLOR', siteUrl: 'OPT_SITE_URL', pdfUrl: 'OPT_PDF_URL', logoUrl: 'OPT_LOGO_URL' };

/** Optional fields: empty or blank means "not given" (the desktop's _opt). */
const opt = (v) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

/** The fields with defaults applied: smallest unit "groth", unit name = the short name, optional ones trimmed or null. */
export function normaliseFields(f = {}) {
  return {
    name: f.name ?? '',
    shortName: f.shortName ?? '',
    unitName: f.unitName == null || f.unitName === '' ? (f.shortName ?? '') : f.unitName,
    nthUnitName: f.nthUnitName == null ? 'groth' : f.nthUnitName,
    shortDescription: opt(f.shortDescription),
    longDescription: opt(f.longDescription),
    color: opt(f.color),
    siteUrl: opt(f.siteUrl),
    pdfUrl: opt(f.pdfUrl),
    logoUrl: opt(f.logoUrl),
  };
}

/**
 * A token's metadata in BEAM's standard schema, exactly as it will be stored on chain:
 *   STD:SCH_VER=1;N=<name>;SN=<short>;UN=<unit>;NTHUN=<smallest>;NTH_RATIO=100000000
 *   [;OPT_SHORT_DESC=…][;OPT_LONG_DESC=…][;OPT_COLOR=#RRGGBB][;OPT_SITE_URL=…][;OPT_PDF_URL=…][;OPT_LOGO_URL=…]
 * The rules are the BEAM wallet core's own (WalletAssetMeta::Parse): a value that breaks them
 * makes every BEAM wallet show the asset as non-standard. The format has no escaping, so a
 * character that would corrupt it is refused, never dropped: no ; anywhere; N, SN, UN and NTHUN
 * only ASCII letters, digits, space and . , - _ and never empty; SN at most 6 characters;
 * descriptions at most 128 / 1,024 bytes; OPT_COLOR #RGB or #RRGGBB. The text also travels as
 * one quoted shader argument, so " and \ and control characters are refused everywhere.
 * NTH_RATIO is always 10^8: the scale every BEAM wallet shows balances in.
 * @throws {MetadataError} for the first field (in this order) that is wrong.
 */
export function encodeMetadata(fields) {
  const m = normaliseFields(fields);
  for (const f of ORDER) checkOne(f, m);
  const parts = ['SCH_VER=1', `N=${m.name}`, `SN=${m.shortName}`, `UN=${m.unitName}`, `NTHUN=${m.nthUnitName}`, `NTH_RATIO=${NTH_RATIO}`];
  for (const f of ORDER.slice(4)) if (m[f] != null) parts.push(`${KEYS[f]}=${m[f]}`);
  const s = `STD:${parts.join(';')}`;
  if (bytesOf(s) > LIMITS.encoded) throw new MetadataError('whole', 'The token details are too long in total.');
  return s;
}

/**
 * What is wrong with one field, or null: the core's rules for `field` alone (the desktop's
 * _check). The ticker's words say "Ticker" where the schema says "Short name".
 */
export function fieldProblem(field, fields) {
  try {
    checkOne(field, normaliseFields(fields));
    return null;
  } catch (e) {
    if (!(e instanceof MetadataError)) throw e;
    return field === 'shortName' ? e.message.replace('Short name', 'Ticker') : e.message;
  }
}

/** The fields of chain metadata, split as the core splits them (untrusted text: display only). */
export function metadataFields(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('STD:')) return null;
  const out = {};
  for (const token of raw.slice(4).split(';')) {
    const eq = token.indexOf('=');
    if (!token || eq < 0) continue;
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------- numbers

/**
 * "Maximum supply", whole tokens: digits (spaces, commas and _ as group marks are fine).
 * Empty means no maximum: the largest ceiling the contract stores.
 * @returns {{ empty: boolean, whole: bigint|null, limit: bigint|null, error: string|null }}
 */
export function parseSupply(input) {
  const t = String(input ?? '').replace(/[\s,_]/g, '');
  if (t === '') return { empty: true, whole: null, limit: MAX_LIMIT, error: null };
  if (!/^\d+$/.test(t) || BigInt(t) === 0n) return { empty: false, whole: null, limit: null, error: 'Enter a whole number above zero, like 1000000' };
  const whole = BigInt(t);
  if (whole * NTH_RATIO > MAX_LIMIT) return { empty: false, whole: null, limit: null, error: 'That is more than a token can ever have. Leave it empty for no maximum.' };
  return { empty: false, whole, limit: whole * NTH_RATIO, error: null };
}

/** True when a ceiling is the "no maximum" one. */
export const unlimited = (limit) => BigInt(limit) === MAX_LIMIT;

/**
 * An amount as a person types it, in smallest units: "1", "1.5", "1,5", ".5", group spaces.
 * The rules of lib/amount.js parseAmount, with a ceiling of `max` instead of 2^53.
 * @returns {{ value: bigint|null, error: string|null }} error null and value null = empty.
 */
export function parseUnits(input, max = MAX_PER_TX) {
  let s = String(input ?? '').replace(/[\s\u00a0\u2009\u202f]/g, '');
  if (s === '') return { value: null, error: null };
  if (s.startsWith('-')) return { value: null, error: 'The amount must be more than zero.' };
  const marks = s.match(/[.,]/g) || [];
  if (marks.length > 1) return { value: null, error: 'Use one decimal mark, like 1.25' };
  s = s.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return { value: null, error: 'Only digits and one decimal mark, like 1.25' };
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 8) return { value: null, error: 'Tokens have 8 decimal places at most.' };
  const value = BigInt(whole || '0') * NTH_RATIO + BigInt((frac + '00000000').slice(0, 8) || '0');
  if (value <= 0n) return { value: null, error: 'The amount must be more than zero.' };
  if (value > max) return { value, error: 'over' };
  return { value, error: null };
}

// ---------------------------------------------------------------- args

const CID_RE = /^[0-9a-f]{64}$/;

function join(action, cid, p = {}) {
  if (!CID_RE.test(cid)) throw new RangeError('contract id: 64 lowercase hex');
  return [`action=${action}`, `cid=${cid}`, ...Object.entries(p).map(([k, v]) => `${k}=${v}`)].join(',');
}

function aidArg(id) {
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new RangeError('a token id, 1..2^32-1 (aid 0 would list every token)');
  return String(id);
}

/**
 * The Minter app shader's args (bvm/Shaders/minter/app.cpp). It reads only `action` (no roles).
 * Numbers are plain decimals: strtoull(.., 0) would read a leading zero as octal.
 */
export const args = Object.freeze({
  /** {"res": {tokenIssueFee, cidDaoVault}} */
  viewParams: ({ cid = MINTER_CID } = {}) => join('view_params', cid),
  /** {"res": [{aid, mintedLo, mintedHi, limitLo, limitHi, owner_pk, metadata?}]}: tokens this wallet created. */
  viewOwned: ({ cid = MINTER_CID } = {}) => join('view_owned', cid),
  /** {"res": {mintedLo, …, is_owner?}} or the error "no such token". */
  viewToken: ({ assetId, cid = MINTER_CID }) => join('view_token', cid, { aid: aidArg(assetId) }),
  /**
   * A new token whose supply can never pass `limit` (smallest units, 1..2^128-1, sent as
   * limit + limitHi). The metadata goes last and quoted, so its own , and = stay inside it;
   * encodeMetadata guarantees it holds no " or \ that would end or escape the value.
   */
  createToken: ({ metadata, limit, cid = MINTER_CID }) => {
    const l = BigInt(limit);
    if (l <= 0n || l > MAX_LIMIT) throw new RangeError('limit must be 1..2^128-1');
    if (typeof metadata !== 'string' || !metadata.startsWith('STD:') || /["\\]/.test(metadata)) throw new RangeError('metadata: encodeMetadata text only');
    return join('create_token', cid, { limit: String(l & MAX_U64), limitHi: String(l >> 64n), metadata: `"${metadata}"` });
  },
  /** withdraw: mint `value` of a token this wallet created. */
  mint: ({ assetId, value, cid = MINTER_CID }) => {
    const v = BigInt(value);
    if (v <= 0n || v > MAX_U64) throw new RangeError('value must be 1..2^64-1');
    return join('withdraw', cid, { aid: aidArg(assetId), value: String(v) });
  },
});

// ---------------------------------------------------------------- answers

export class MinterError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    // busy, noSuchToken, notOwner, aboveLimit, noSuchContract, unexpected, shaderError
    this.code = code;
    Object.assign(this, extra);
  }
}

function fmt(what) {
  return new MinterError('unexpected', `The Minter answered something this wallet cannot check (${what}). Try again; if it keeps happening, report it.`);
}
const asMap = (v, what) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`);
};
function u64(m, k) {
  const v = m[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= MAX_U64) return BigInt(v);
  throw fmt(`${k}: expected an unsigned 64-bit integer`);
}
const optString = (m, k) => (typeof m[k] === 'string' ? m[k] : null);

/** view_params: the issuance fee (groth) and where it goes. */
export function parseParams(out) {
  const r = asMap(asMap(out, 'output').res, 'res');
  const daoVaultCid = optString(r, 'cidDaoVault');
  if (!daoVaultCid || !CID_RE.test(daoVaultCid)) throw fmt('cidDaoVault: not a contract id');
  return { issueFee: u64(r, 'tokenIssueFee'), daoVaultCid };
}

/**
 * One token row. view_token prints no aid (pass `assetId`); view_owned prints only this
 * wallet's tokens and no is_owner (pass owned: true).
 */
export function parseToken(row, { assetId = null, owned = false } = {}) {
  const m = asMap(row, 'token');
  const aid = assetId ?? Number(u64(m, 'aid'));
  if (!Number.isInteger(aid) || aid <= 0 || aid > 0xffffffff) throw fmt('aid: not a token id');
  const minted = (u64(m, 'mintedHi') << 64n) | u64(m, 'mintedLo');
  const limit = (u64(m, 'limitHi') << 64n) | u64(m, 'limitLo');
  const isOwner = owned || m.is_owner === 1 || m.is_owner === '1';
  return { assetId: aid, minted, limit, mintable: limit > minted ? limit - minted : 0n, isOwner, ownerKey: optString(m, 'owner_pk'), ownerCid: optString(m, 'owner_cid'), metadata: optString(m, 'metadata') };
}

/** view_owned: the tokens this wallet created, by asset id. */
export function parseOwned(out) {
  const list = asMap(out, 'output').res;
  if (!Array.isArray(list)) throw fmt('res: expected a list');
  return list.map((row) => parseToken(row, { owned: true })).sort((a, b) => a.assetId - b.assetId);
}

/** The shader's error strings -> a code a screen can act on. */
export function codeFor(shaderMessage) {
  switch (shaderMessage) {
    case 'no such token':
      return 'noSuchToken';
    case 'not owner':
      return 'notOwner';
    case 'no such contract':
      return 'noSuchContract';
    default:
      return 'shaderError';
  }
}

export function mapError(e) {
  if (e instanceof MinterError) return e;
  if (e instanceof InvokeDataError) return new MinterError('unexpected', 'The wallet built a different transaction than requested, so it was not sent.', { detail: e.message });
  if (e && e.code === 'shader') return new MinterError(codeFor(e.message), e.message, { shaderText: e.message });
  return e;
}

/**
 * What stopped a Minter or burn action, in plain words: what happened, never the person's
 * fault, and the next step (the desktop's minterProblem). { title, message }.
 */
export function minterProblem(e) {
  const code = e && e.code;
  switch (code) {
    case 'rejected':
      return { title: 'Cancelled', message: 'Nothing was sent.' };
    case 'timeout':
      return { title: 'The wallet did not answer in time', message: 'Check Activity before trying again: it may still go through.' };
    case 'busy':
      return { title: 'Another token action is still open', message: 'Finish or close it, then try again.' };
    case 'noSuchToken':
      return { title: "The Minter doesn't know this token", message: 'It may still be waiting for the network. Try again in a few minutes.' };
    case 'notOwner':
      return { title: 'Only the wallet that created this token can mint it', message: 'Open the wallet that created it to mint more.' };
    case 'aboveLimit':
      return { title: 'More than this token can ever have', message: `${e.message} Lower the amount.` };
    case 'notAcknowledged':
      return { title: 'Confirm that the tokens are destroyed for good', message: 'Type the ticker to confirm, then try again.' };
    case 'unexpected':
    case 'refused':
      return { title: 'Stopped for your safety', message: 'The wallet built a different transaction than the one you asked for, so nothing was sent. Try again; if it repeats, update the app.' };
    case 'noSuchContract':
      return { title: "The Minter contract didn't answer", message: 'The wallet may be on the wrong network. Check BEAM node in Settings.' };
    case 'load':
    case 'mismatch':
      return { title: 'A part of the app could not be loaded', message: e.message };
    case 'shaderError':
    case 'shader':
      return { title: 'The contract refused this', message: `Nothing was sent. It said: "${e.message}".` };
    case 'locked':
    case 'no_wallet':
      return { title: 'The wallet is locked', message: 'Nothing was sent. Unlock it and try again.' };
    default:
      return { title: 'Something went wrong on our side', message: `Nothing was sent. Try again; if it keeps happening, restart the app.${e && e.message ? ` (${String(e.message).slice(0, 160)})` : ''}` };
  }
}

// ---------------------------------------------------------------- checks shared with burn.js

/**
 * Decodes and checks a built transaction: one call, contract `cid`, `method`, BVM `charge`,
 * kernel `comment`, `sigs` signing keys, not dependent. fail(what) throws.
 */
export function checkBuilt(raw, { cid, method, charge, comment, sigs }, fail) {
  let d;
  try {
    d = readContractTx(raw);
  } catch (e) {
    fail(`cannot read the prepared transaction: ${e.message}`);
  }
  if (d.entries.length !== 1) fail('expected one contract call');
  const e = d.entries[0];
  if (e.contractId !== cid) fail(`the call targets ${e.contractId}`);
  if (e.method !== method) fail(`contract method ${e.method}, not ${method}`);
  if (e.isDependent) fail('a dependent call');
  if (e.charge !== charge) fail(`BVM charge ${e.charge}, expected ${charge}`);
  if (e.comment !== comment) fail(`kernel comment "${e.comment}"`);
  if (e.signatureCount !== sigs) fail(`${e.signatureCount} signing keys, expected ${sigs}`);
  return d;
}

/** The funds a built transaction moves must be exactly `expected` (Map assetId -> net, positive = paid). */
export function expectFunds(d, expected, what, fail) {
  const s = d.spend;
  const ok = s.size === expected.size && [...expected].every(([k, v]) => s.get(k) === v);
  if (!ok) fail(`${what} moves ${spendText(s)}, expected exactly ${spendText(expected)}`);
}

/** What the approve sheet shows must be what was built and checked, to the groth. */
export function consentExpectation(getBuilt) {
  return (req) => {
    const d = getBuilt();
    const bad = { code: 'unexpected', message: 'The wallet built something other than what this screen shows. Nothing was sent.' };
    if (!d || req.kind !== 'contract') return bad;
    const same = (list, map) => list.length === map.size && list.every((x) => map.get(x.assetId) === x.amount);
    if (!same(req.spends, d.pays) || !same(req.receives, d.receives)) return bad;
    if (req.fee !== d.fee) return { code: 'unexpected', message: 'The network fee is not the one this screen expected. Nothing was sent.' };
    return null;
  };
}

/**
 * deps.transact with a caller's inspect whose throw comes back as thrown (lib/contracts.js would
 * report every refusal as 'unexpected'), errors mapped by `map`.
 */
export async function transactChecked(deps, a, opts, map) {
  let thrown = null;
  const inspect = async (bytes, output) => {
    try {
      await opts.inspect(bytes, output);
    } catch (e) {
      thrown = e;
      throw e;
    }
    return null;
  };
  try {
    return await deps.transact(a, { ...opts, inspect });
  } catch (e) {
    throw map(thrown || e);
  }
}

/** The app args the core keeps with a call (when it does) must be the ones asked for. */
function sameAppArgs(d, wanted, fail) {
  if (!d.appArgs) return;
  for (const [k, v] of Object.entries(wanted)) {
    const got = d.appArgs[k];
    if (got !== v && got !== `"${v}"`) fail(`stored shader arg ${k} differs from the request`);
  }
}

// ---------------------------------------------------------------- service

/**
 * The Minter over one wallet session.
 *   deps.view(args) -> parsed shader output (App.view)
 *   deps.transact(args, {inspect, expect, intent}) -> txId (App.transact)
 * One Minter transaction at a time: creating a token costs 60 BEAM, so a double tap must not
 * create two.
 */
export function createMinter(deps) {
  let flow = null;

  async function view(a) {
    try {
      return await deps.view(a);
    } catch (e) {
      throw mapError(e);
    }
  }

  /** Claims the service synchronously, before the first await: a second tap finds it busy. */
  function flowed(fn) {
    if (flow) return Promise.reject(new MinterError('busy', 'Another token transaction is in progress. Finish or cancel it first.'));
    const token = {};
    flow = token;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (flow === token) flow = null;
      }
    })();
  }

  const fail = (what) => {
    throw new MinterError('unexpected', 'The wallet built a different transaction than requested, so it was not sent.', { detail: what });
  };

  const svc = {
    get busy() {
      return Boolean(flow);
    },

    async params() {
      return parseParams(await view(args.viewParams()));
    },

    /** Tokens this wallet created. */
    async owned() {
      return parseOwned(await view(args.viewOwned()));
    },

    /** One token, or null when the Minter has none with this id. */
    async token(assetId) {
      try {
        return parseToken(asMap(await view(args.viewToken({ assetId })), 'output').res, { assetId });
      } catch (e) {
        if (e.code === 'noSuchToken') return null;
        throw e;
      }
    },

    /**
     * Creates a token described by `metadata` (encodeMetadata's text) whose supply can never
     * pass `limit` (smallest units). Nothing is minted yet. Pays the Minter's issuance fee (read
     * now from view_params), the 10 BEAM asset deposit and the network fee.
     * @returns {{ txId, issueFee, deposit, fee, built }}
     */
    createToken({ metadata, limit, ticker = '' }) {
      return flowed(async () => {
        const p = await svc.params();
        const a = args.createToken({ metadata, limit });
        const text = enc.encode(metadata);
        const l = BigInt(limit);
        const pay = ASSET_DEPOSIT + p.issueFee;
        let built = null;
        const txId = await transactChecked(
          deps,
          a,
          {
            intent: { action: 'tokenCreate', ticker, issueFee: p.issueFee, deposit: ASSET_DEPOSIT },
            inspect: (raw) => {
              const d = checkBuilt(raw, { cid: MINTER_CID, method: METHOD.createToken, charge: CREATE_CHARGE, comment: KERNEL.createToken, sigs: 0 }, fail);
              // Aid 0 | limit lo, hi | the new token's owner key (33 bytes, parity 0 or 1) | size | metadata.
              const got = d.entries[0].args;
              const head = concat(le(0, 4), le(l & MAX_U64, 8), le(l >> 64n, 8));
              const tail = concat(le(text.length, 4), text);
              const ok = got.length === head.length + 33 + tail.length && bytesEqual(got.subarray(0, head.length), head) && got[head.length + 32] <= 1 && bytesEqual(got.subarray(head.length + 33), tail);
              if (!ok) fail('the token arguments differ from the request');
              sameAppArgs(d, { action: 'create_token', cid: MINTER_CID, limit: String(l & MAX_U64), limitHi: String(l >> 64n), metadata }, fail);
              expectFunds(d, new Map([[0, pay]]), 'creating the token', fail);
              built = d;
            },
            expect: consentExpectation(() => built),
          },
          mapError,
        );
        return { txId, issueFee: p.issueFee, deposit: ASSET_DEPOSIT, fee: built.fee, built };
      });
    },

    /** Mints `value` (smallest units) of `assetId`, a token this wallet created, within its limit. */
    mint({ assetId, value, ticker = '' }) {
      return flowed(async () => {
        const v = BigInt(value);
        if (v <= 0n || v > MAX_PER_TX) throw new MinterError('aboveLimit', 'One mint can be at most 92,233,720,368.54775807 tokens.');
        const t = await svc.token(assetId);
        if (!t) throw new MinterError('noSuchToken', `Asset ${assetId} was not created with the Minter.`);
        if (!t.isOwner) throw new MinterError('notOwner', 'Only the wallet that created this token can mint it.');
        if (v > t.mintable) throw new MinterError('aboveLimit', `At most ${t.mintable} more can be minted.`, { mintable: t.mintable });
        const a = args.mint({ assetId, value: v });
        let built = null;
        const txId = await transactChecked(
          deps,
          a,
          {
            intent: { action: 'tokenMint', ticker },
            inspect: (raw) => {
              const d = checkBuilt(raw, { cid: MINTER_CID, method: METHOD.withdraw, charge: 0, comment: KERNEL.mint, sigs: 1 }, fail);
              if (!bytesEqual(d.entries[0].args, concat(le(assetId, 4), le(v, 8)))) fail('the mint arguments differ from the request');
              sameAppArgs(d, { action: 'withdraw', cid: MINTER_CID, aid: String(assetId), value: String(v) }, fail);
              expectFunds(d, new Map([[assetId, -v]]), 'the mint', fail);
              built = d;
            },
            expect: consentExpectation(() => built),
          },
          mapError,
        );
        return { txId, token: t, fee: built.fee, built };
      });
    },
  };
  return svc;
}

// ---------------------------------------------------------------- live wiring

let live = null;

/** The Minter on the running wallet's own app and the pinned shader. One per wallet session. */
export function minterFor(session) {
  if (live && live.session === session) return live.svc;
  const withApp = async () => {
    const [app, shader] = await Promise.all([nativeApp(), loadShader('minter')]);
    return { app, shader };
  };
  const svc = createMinter({
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
