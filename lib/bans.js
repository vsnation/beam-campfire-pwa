// BEAM names (BANS, the BEAM Anonymous Name Service): look a name up, register
// it, renew it, list this wallet's names, and pay a name.
//
// A port of the desktop app (lib/wallets/beam/contracts/bans/: bans_constants,
// bans_name, bans_args, bans_models, bans_timeline, bans_recipient,
// bans_service). Every transaction is built by the pinned app shader and read
// back from its bytes (lib/contract_tx.js) before the wallet is asked to sign:
// one call, the right contract and method, the right name, periods and owner
// key, and exactly the funds asked for. The approve sheet then has to show
// those same amounts and fee, or the request is refused unseen.
//
// Amounts are BigInt in the asset's smallest unit (8 decimals for every asset).

import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { readContractTx, ArgsReader, singleEntry, CONTRACT_CALL_FEE, InvokeDataError, spendText } from './contract_tx.js';

/** Mainnet BANS contract ("Bans v0", deployed at 1,890,525). bans_constants.dart. */
export const BANS_CID = 'af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e';

/** Domain::s_MinLen / s_MaxLen (contract.h:38-39). */
export const NAME_MIN = 3;
export const NAME_MAX = 64;
/** One registration period: 1440 * 365 blocks, about a year at one block a minute. */
export const BLOCKS_PER_PERIOD = 1440 * 365;
/** A name can be paid at most 50 periods ahead (s_PeriodValidityMax). */
export const MAX_PERIODS = 50;
/** After expiry the owner keeps the name 1440 * 90 blocks (s_PeriodHold). */
export const HOLD_BLOCKS = 1440 * 90;
export const BLOCK_SECONDS = 60;
/** Every BANS call is a plain contract call: 0.011 BEAM. */
export const NAME_CALL_FEE = CONTRACT_CALL_FEE;
/** Above this the price moved too far since the estimate shown: refuse, show the new one. */
export const PRICE_SLACK_BPS = 200n;

/** USD per period by name length (Domain::get_PriceTok, contract.h:73-83). */
export function usdPerPeriod(length) {
  if (length <= 3) return 320;
  if (length <= 4) return 120;
  return 10;
}

export const KERNEL = Object.freeze({
  register: 'BANS: registering domain',
  extend: 'BANS: extending the domain registration period',
  setOwner: 'BANS: setting the domain owner',
  setPrice: 'BANS: setting the domain price',
  buy: 'BANS: buying the domain',
  pay: 'vault_anon send anon',
});

export const METHOD = Object.freeze({ setOwner: 3, extend: 4, setPrice: 5, buy: 6, register: 7, vaultDeposit: 2, vaultWithdraw: 3 });

export class BansError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // invalidName, invalidKey, refused, claimUnsupported, ownerChanged, unexpected, priceMoved, notMine
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- names

const NAME_PROBLEM_TEXT = {
  empty: 'Type a name.',
  tooShort: 'Names need at least 3 characters.',
  tooLong: 'Names can be at most 64 characters.',
  invalidCharacter: 'Use only lowercase letters, numbers, - _ and ~.',
};

/** Domain::IsValidChar: _ - ~ a-z 0-9. */
const validChar = (c) => c === 0x5f || c === 0x2d || c === 0x7e || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);

/** What the contract would object to in a canonical name, or null. */
export function nameProblem(name) {
  const s = String(name);
  if (!s) return 'empty';
  if (s.length < NAME_MIN) return 'tooShort';
  if (s.length > NAME_MAX) return 'tooLong';
  for (let i = 0; i < s.length; i++) if (!validChar(s.charCodeAt(i))) return 'invalidCharacter';
  return null;
}

export const describeNameProblem = (p) => NAME_PROBLEM_TEXT[p] || NAME_PROBLEM_TEXT.invalidCharacter;

/** Trims, lower-cases ASCII only and removes one trailing ".beam". Does not validate. */
export function normaliseName(input) {
  let s = String(input).trim();
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (s.endsWith('.beam')) s = s.slice(0, -5);
  return s;
}

/** Typed or pasted text -> the canonical name; throws BansError('invalidName'). */
export function parseName(input) {
  const s = normaliseName(input);
  const p = nameProblem(s);
  if (p) throw new BansError('invalidName', describeNameProblem(p), { problem: p });
  return s;
}

/** The canonical name, or null. */
export function tryName(input) {
  const s = normaliseName(input);
  return nameProblem(s) ? null : s;
}

export const display = (name) => `${name}.beam`;

// ---------------------------------------------------------------- keys

const KEY_RE = /^[0-9a-f]{64}0[01]$/;
export const ZERO_KEY = '00'.repeat(33);
export const isKey = (k) => typeof k === 'string' && KEY_RE.test(k);

export function requireKey(k) {
  const key = String(k).trim().toLowerCase();
  if (!isKey(key) || key === ZERO_KEY) throw new BansError('invalidKey', 'That is not a name key. A name key is 66 characters of 0-9 and a-f; copy it again from the receiving wallet.');
  return key;
}

/** "72e3…51ef": a short form for screens that only inform. */
export function fingerprint(key) {
  if (key.length < 12) return key;
  const end = key.length - 2;
  return `${key.slice(0, 4)}…${key.slice(end - 4, end)}`;
}

/** "72e3 68c0 … 570d 51ef": 16 characters, what two people compare. */
export function checkCode(key) {
  if (key.length < 20) return key;
  const end = key.length - 2;
  const g = (from) => key.slice(from, from + 4);
  return `${g(0)} ${g(4)} … ${g(end - 8)} ${g(end - 4)}`;
}

// ---------------------------------------------------------------- args

const MAX_AID = 0xffffffff;
const MAX_U64 = (1n << 64n) - 1n;

function build(role, action, more = {}, cid = BANS_CID) {
  return [`role=${role}`, `action=${action}`, `cid=${cid}`, ...Object.entries(more).map(([k, v]) => `${k}=${v}`)].join(',');
}

function checkedName(name) {
  const p = nameProblem(name);
  if (p) throw new BansError('invalidName', describeNameProblem(p), { problem: p });
  return name;
}

function periodsArg(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIODS) throw new RangeError(`periods must be 1..${MAX_PERIODS}`);
  return String(n);
}

function aidArg(aid) {
  if (!Number.isInteger(aid) || aid < 0 || aid > MAX_AID) throw new RangeError('asset id out of range');
  return String(aid);
}

function amountArg(v, allowZero) {
  const b = BigInt(v);
  if (b < 0n || (!allowZero && b === 0n)) throw new RangeError('amount must be positive');
  if (b > MAX_U64) throw new RangeError('amount above 2^64-1');
  return b.toString();
}

export const args = Object.freeze({
  myKey: () => build('user', 'my_key'),
  userView: () => build('user', 'view'),
  viewParams: () => build('manager', 'view_params'),
  viewName: (name) => build('manager', 'view_name', { name: checkedName(name) }),
  viewDomain: (ownerKey = null) => build('manager', 'view_domain', { pk: ownerKey == null ? ZERO_KEY : requireKey(ownerKey) }),
  register: (name, periods) => build('user', 'domain_register', { name: checkedName(name), nPeriods: periodsArg(periods) }),
  extend: (name, periods) => build('user', 'domain_extend', { name: checkedName(name), nPeriods: periodsArg(periods) }),
  pay: (name, assetId, amount) => build('manager', 'pay', { name: checkedName(name), aid: aidArg(assetId), amount: amountArg(amount, false) }),
});

// ---------------------------------------------------------------- answers

const CID_RE = /^[0-9a-f]{64}$/;

function fmt(what) {
  return new BansError('unexpected', `The name service answered something this wallet cannot check (${what}). Try again; if it keeps happening, report it.`);
}

function asMap(v, what) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`);
}

function asList(v, what) {
  if (Array.isArray(v)) return v;
  throw fmt(`${what}: expected a list`);
}

function asInt(v, what) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  throw fmt(`${what}: expected a whole number`);
}

function asBig(v, what) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw fmt(`${what}: expected an amount`);
}

function asKey(m, k) {
  if (isKey(m[k])) return m[k];
  throw fmt(`${k}: expected a 33-byte key`);
}

function asCid(m, k) {
  if (typeof m[k] === 'string' && CID_RE.test(m[k])) return m[k];
  throw fmt(`${k}: expected a contract id`);
}

function domain(m, name) {
  const price = m.price;
  return {
    name,
    ownerKey: asKey(m, 'key'),
    expireHeight: asInt(m.hExpire, 'hExpire'),
    salePrice: price == null ? null : amountOf(asMap(price, 'price')),
  };
}

function amountOf(m) {
  return { assetId: asInt(m.aid, 'aid'), amount: asBig(m.amount, 'amount') };
}

/** my_key: {"res": {"key": ...}}. */
export function parseMyKey(out) {
  return asKey(asMap(asMap(out, 'output').res, 'res'), 'key');
}

/** view_name: the record, or null for {} (never registered). */
export function parseViewName(out, name) {
  const res = asMap(out, 'output').res;
  if (res == null) return null;
  return domain(asMap(res, 'res'), name);
}

/** view_domain: {"domains": [...]}. */
export function parseViewDomain(out) {
  return asList(asMap(out, 'output').domains, 'domains').map((e) => {
    const m = asMap(e, 'domains[]');
    if (typeof m.name !== 'string') throw fmt('domains[].name: expected a string');
    return domain(m, m.name);
  });
}

/** view_params: {"res": {vault, dao-vault, oracle, price?, h0}}. price is USD per BEAM, 5 decimals, absent when stale. */
export function parseViewParams(out) {
  const res = asMap(asMap(out, 'output').res, 'res');
  if (res.price != null && typeof res.price !== 'string') throw fmt('price: expected text');
  return {
    vaultCid: asCid(res, 'vault'),
    daoVaultCid: asCid(res, 'dao-vault'),
    oracleCid: asCid(res, 'oracle'),
    activationHeight: asInt(res.h0, 'h0'),
    usdPerBeamText: res.price == null ? null : res.price,
  };
}

// ---------------------------------------------------------------- refusals

/** The shader's own error text -> what to say (bans_exceptions.dart). */
const REFUSALS = {
  'name is invalid': ['nameInvalid', 'Names use only a-z, 0-9, - _ and ~, in lowercase.'],
  'name too short': ['nameTooShort', 'Names need at least 3 characters.'],
  'name too long': ['nameTooLong', 'Names can be at most 64 characters.'],
  'name not specified': ['nameMissing', 'Type a name first.'],
  'not registered': ['notRegistered', 'No one owns this name. Check the spelling, or ask for their address.'],
  'owned by other': ['ownedByOther', 'This name belongs to another wallet, so this wallet cannot change it.'],
  'already owned by me': ['alreadyMine', 'This name is already yours. Renew it instead.'],
  'validity period too long': ['periodTooLong', 'A name can be paid for at most 50 years ahead. Choose fewer years.'],
  'price feed unavailable': ['priceFeedUnavailable', 'The BEAM price feed is not updating right now, so names cannot be priced. Try again in a few minutes.'],
  'domain expired': ['domainExpired', 'This name has expired, so it cannot receive payments. Ask the recipient for an address instead.'],
  'amount not specified': ['amountMissing', 'Enter an amount above zero.'],
  'not for sale': ['notForSale', 'This name is not listed for sale.'],
  'no change': ['noChange', 'That is already the price. Nothing to change.'],
  'new owner not set': ['newOwnerMissing', "Paste the receiving wallet's name key."],
  'nothing to withdraw': ['nothingToClaim', 'There is nothing waiting to be claimed.'],
  'no funds': ['noFunds', 'There is nothing waiting to be claimed.'],
  'insufficient funds': ['insufficientFunds', 'Less is waiting than that amount. Claim the full amount instead.'],
  'not detected': ['paymentNotFound', 'That payment was not found for this wallet. Refresh and try again.'],
};

export function refusal(shaderText) {
  const r = REFUSALS[shaderText];
  if (r) return new BansError('refused', r[1], { refusal: r[0], shaderText });
  return new BansError('refused', `The name service could not do that (${shaderText}). Try again; if it keeps happening, report it.`, { refusal: 'unknown', shaderText });
}

/** A core error that means a privilege-1 shader call (claims) on an engine that refuses them. */
export function isPrivilegeFailure(rpc) {
  if (!rpc) return false;
  const data = typeof rpc.data === 'string' ? rpc.data : JSON.stringify(rpc.data ?? '');
  const text = `${rpc.message || ''} ${data}`;
  return text.includes('get_PkEx') || text.includes('get_BlindSk');
}

/** ContractError from lib/contracts.js -> BansError where it means something to a person. */
export function mapError(e) {
  if (e instanceof BansError) return e;
  if (e instanceof InvokeDataError) return new BansError('unexpected', 'The name service built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.', { detail: e.message });
  if (e && e.code === 'shader') return refusal(e.message);
  if (e && e.code === 'rpc' && isPrivilegeFailure(e.rpc)) {
    return new BansError('claimUnsupported', 'Claiming name payments is not possible in this version. They are safe in the BEAM vault.');
  }
  return e;
}

// ---------------------------------------------------------------- time

export const STATUS = Object.freeze({ available: 'available', active: 'active', forSale: 'forSale', onHold: 'onHold', availableAgain: 'availableAgain' });
export const canRegister = (s) => s === STATUS.available || s === STATUS.availableAgain;
export const canReceivePayments = (s) => s === STATUS.active || s === STATUS.forSale || s === STATUS.onHold;

/** A registered name's status at the next block after tipHeight (what the shader checks). */
export function statusOf({ expireHeight, tipHeight, listed = false }) {
  const h = tipHeight + 1;
  if (expireHeight + HOLD_BLOCKS <= h) return STATUS.availableAgain;
  if (expireHeight <= h) return STATUS.onHold;
  return listed ? STATUS.forSale : STATUS.active;
}

export const holdEndHeight = (expireHeight) => expireHeight + HOLD_BLOCKS;
export const expiryAfterRegister = ({ tipHeight, periods }) => tipHeight + 1 + BLOCKS_PER_PERIOD * periods;
export const expiryAfterExtend = ({ expireHeight, tipHeight, periods }) => Math.max(expireHeight, tipHeight + 1) + BLOCKS_PER_PERIOD * periods;

/** Most periods a renewal can add now: the new expiry stays within 50 periods of the next block. */
export function maxExtendPeriods({ expireHeight, tipHeight }) {
  const h = tipHeight + 1;
  const from = Math.max(h, expireHeight);
  const limit = h + BLOCKS_PER_PERIOD * MAX_PERIODS;
  return from < limit ? Math.floor((limit - from) / BLOCKS_PER_PERIOD) : 0;
}

/** Estimated date (ms) of block `height`, from the wallet's last block and its time (seconds). */
export function dateOf(height, { tipHeight, tipTime }) {
  return (tipTime + BLOCK_SECONDS * (height - tipHeight)) * 1000;
}

// ---------------------------------------------------------------- price

/**
 * The BEAM a name costs for `periods`, as a range: the contract charges
 * floor(usd * 1e8 * periods / median) groth, and view_params prints the median
 * truncated, so the true one lies in [printed, printed + 10^-digits).
 */
export function priceEstimate({ usdPerPeriod: usd, periods, medianText }) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(medianText || '').trim());
  if (!m) throw new BansError('refused', REFUSALS['price feed unavailable'][1], { refusal: 'priceFeedUnavailable' });
  const frac = m[2] || '';
  const scale = 10n ** BigInt(frac.length);
  const digits = BigInt(m[1] + frac);
  if (digits === 0n) throw new BansError('refused', REFUSALS['price feed unavailable'][1], { refusal: 'priceFeedUnavailable' });
  const top = BigInt(usd) * BigInt(periods) * 100000000n * scale;
  return { usdPerPeriod: usd, periods, usdTotal: usd * periods, medianText, maxGroth: top / digits, minGroth: top / (digits + 1n) };
}

// ---------------------------------------------------------------- the Send field

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * What a recipient field holds. An address always wins: a hex address of 60
 * or more characters is also a syntactically valid name, and treating it as one
 * would pay somewhere the person did not paste. Anything longer than a name
 * can be is left to the wallet's own address check.
 * @returns {{kind:'empty'}|{kind:'address'}|{kind:'name', name}|{kind:'invalid', problem}}
 */
export function classifyRecipient(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };
  if ((HEX_RE.test(t) && t.length >= 60) || t.length > NAME_MAX + 6) return { kind: 'address' };
  const candidate = normaliseName(t.startsWith('@') ? t.slice(1) : t);
  const p = nameProblem(candidate);
  if (!p) return { kind: 'name', name: candidate };
  return { kind: 'invalid', problem: p };
}

// ---------------------------------------------------------------- service

const fail = (what) => {
  throw new BansError('unexpected', 'The name service built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.', { detail: `expected ${what}` });
};

function expectName(r, name) {
  const len = r.u8();
  const bytes = r.bytes(len);
  if (String.fromCharCode(...bytes) !== name || !r.atEnd) fail(`name ${name}`);
}

function onlyBeamSpend(e) {
  const s = [...e.spend].filter(([, v]) => v !== 0n);
  if (s.length !== 1 || s[0][0] !== 0 || s[0][1] <= 0n) fail('the price is paid in BEAM');
  return s[0][1];
}

/**
 * The approve sheet must show exactly what the built transaction does: these
 * spends, nothing received, this fee. Anything else is refused unseen.
 */
export function consentExpectation(getBuilt) {
  return (req) => {
    const b = getBuilt();
    const bad = { code: 'unexpected', message: 'The wallet built something other than what this screen shows. Nothing was sent.' };
    if (!b || req.kind !== 'contract') return bad;
    const same = (list, map) => list.length === map.size && list.every((a) => map.get(a.assetId) === a.amount);
    if (!same(req.spends, b.pays) || !same(req.receives, b.receives)) return bad;
    if (req.fee !== b.fee) return { code: 'unexpected', message: 'The network fee is not the one this screen expected. Nothing was sent.' };
    return null;
  };
}

/**
 * BANS over one wallet session.
 *   deps.view(args) -> parsed shader output (lib/contracts.js App.view)
 *   deps.transact(args, {inspect, expect, intent}) -> txId (App.transact)
 *   deps.status() -> wallet_status ({current_height, current_state_timestamp, is_in_sync})
 */
export function createBans(deps) {
  let myKeyCache = null;

  async function view(a) {
    try {
      return await deps.view(a);
    } catch (e) {
      throw mapError(e);
    }
  }

  async function tip() {
    const st = await deps.status();
    const tipHeight = Number(st && st.current_height);
    if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new BansError('unexpected', 'The wallet does not know the current block yet. Try again in a moment.');
    return { tipHeight, tipTime: Number(st.current_state_timestamp) || Math.floor(Date.now() / 1000), inSync: st.is_in_sync === true };
  }

  const svc = {
    async myKey() {
      if (!myKeyCache) myKeyCache = parseMyKey(await view(args.myKey()));
      return myKeyCache;
    },

    async params() {
      return parseViewParams(await view(args.viewParams()));
    },

    /** The name on the wallet's own node: {name, domain|null, status, ownerKey, tipHeight, tipTime, inSync}. */
    async resolve(name) {
      const t = await tip();
      const d = parseViewName(await view(args.viewName(name)), name);
      const status = d ? statusOf({ expireHeight: d.expireHeight, tipHeight: t.tipHeight, listed: Boolean(d.salePrice) }) : STATUS.available;
      return { name, domain: d, status, ownerKey: d ? d.ownerKey : null, ...t };
    },

    /** Every name this wallet owns (view_domain filtered by my_key), expired ones included. */
    async myNames() {
      const key = await svc.myKey();
      const t = await tip();
      const names = parseViewDomain(await view(args.viewDomain(key)));
      return { key, names: names.map((d) => ({ ...d, status: statusOf({ expireHeight: d.expireHeight, tipHeight: t.tipHeight, listed: Boolean(d.salePrice) }) })), ...t };
    },

    /**
     * Registers `name` for `periods` years. The price is read from the built
     * transaction and must be within the estimate shown (plus a small margin for
     * the price feed moving), go to the BANS contract, method 7, for this name,
     * these periods and this wallet's key.
     */
    async register(name, periods, { estimate = null, onBuilt = null } = {}) {
      checkedName(name);
      const key = await svc.myKey();
      const a = args.register(name, periods);
      let built = null;
      const txId = await svc.transact(a, {
        intent: { action: 'nameRegister', name, periods },
        inspect: (raw) => {
          const d = readContractTx(raw);
          const e = singleEntry(d, BANS_CID, METHOD.register, fail);
          const r = new ArgsReader(e.args);
          const owner = r.pubKey();
          if (r.u8() !== periods) fail('periods');
          expectName(r, name);
          if (owner !== key) fail('the name is registered to this wallet');
          const pay = onlyBeamSpend(e);
          checkPrice(pay, estimate);
          built = { pays: d.pays, receives: d.receives, fee: d.fee, pay };
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ...built };
    },

    /** Renews a name this wallet owns. */
    async extend(name, periods, { estimate = null, onBuilt = null } = {}) {
      const res = await svc.resolve(name);
      const key = await svc.myKey();
      if (!res.domain) throw refusal('not registered');
      if (res.ownerKey !== key) throw refusal('owned by other');
      if (res.status === STATUS.availableAgain) throw new BansError('refused', `${display(name)} expired more than 90 days ago, so it can no longer be renewed. Register it again instead.`, { refusal: 'pastHold' });
      const max = maxExtendPeriods({ expireHeight: res.domain.expireHeight, tipHeight: res.tipHeight });
      if (periods > max) throw refusal('validity period too long');
      const a = args.extend(name, periods);
      let built = null;
      const txId = await svc.transact(a, {
        intent: { action: 'nameRenew', name, periods },
        inspect: (raw) => {
          const d = readContractTx(raw);
          const e = singleEntry(d, BANS_CID, METHOD.extend, fail);
          const r = new ArgsReader(e.args);
          if (r.u8() !== periods) fail('periods');
          expectName(r, name);
          const pay = onlyBeamSpend(e);
          checkPrice(pay, estimate);
          built = { pays: d.pays, receives: d.receives, fee: d.fee, pay };
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ...built, expireHeight: expiryAfterExtend({ expireHeight: res.domain.expireHeight, tipHeight: res.tipHeight, periods }) };
    },

    /**
     * Pays `amount` of `assetId` to the owner of `name`, anonymously, through the
     * BANS vault. The name is resolved before the build and again after it; if
     * its owner differs from the one the person was shown (expectedOwnerKey), or
     * between the two, nothing is signed.
     */
    async pay(name, assetId, amount, { expectedOwnerKey = null } = {}) {
      const p = await svc.params();
      const before = await svc.resolve(name);
      const key = before.ownerKey;
      if (!key) throw refusal('not registered');
      if (!canReceivePayments(before.status)) throw refusal('domain expired');
      if (expectedOwnerKey && key !== expectedOwnerKey) throw ownerChanged(name);
      const a = args.pay(name, assetId, amount);
      const want = BigInt(amount);
      let built = null;
      const txId = await svc.transact(a, {
        intent: { action: 'namePay', name },
        inspect: async (raw) => {
          const d = readContractTx(raw);
          const after = await svc.resolve(name);
          if (after.ownerKey !== key) throw ownerChanged(name);
          if (!canReceivePayments(after.status)) throw refusal('domain expired');
          const e = singleEntry(d, p.vaultCid, METHOD.vaultDeposit, fail);
          const r = new ArgsReader(e.args);
          if (r.u64() !== want) fail('amount');
          const custom = r.u32();
          r.pubKey(); // the one-time key
          if (r.u32() !== assetId) fail('asset');
          if (custom !== 33 + NAME_MAX || r.remaining !== custom) fail('sender key and encrypted name');
          const spends = [...e.spend].filter(([, v]) => v !== 0n);
          if (spends.length !== 1 || spends[0][0] !== assetId || spends[0][1] !== want) fail(`the kernel pays exactly the amount, not ${spendText(e.spend)}`);
          built = { pays: d.pays, receives: d.receives, fee: d.fee };
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ownerKey: key, ...built };
    },

    /**
     * deps.transact with this module's inspect: it returns nothing to let the
     * transaction on, and what it throws comes back to the caller as thrown
     * (lib/contracts.js would otherwise report every refusal as 'unexpected').
     */
    async transact(a, opts) {
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
        throw mapError(thrown || e);
      }
    },
  };

  function checkPrice(pay, estimate) {
    if (!estimate) return;
    const ceiling = estimate.maxGroth + (estimate.maxGroth * PRICE_SLACK_BPS) / 10000n;
    if (pay > ceiling) throw new BansError('priceMoved', 'The BEAM price moved since the estimate on this screen. Nothing was sent; check the new price and try again.', { pay });
  }

  return svc;
}

function ownerChanged(name) {
  return new BansError('ownerChanged', `${display(name)} just changed owner. Nothing was sent. Check with the recipient before sending.`);
}

// ---------------------------------------------------------------- live wiring

let live = null;

/** BANS on the running wallet's own app and the pinned shader. One per wallet session. */
export function bansFor(session, status) {
  if (live && live.session === session) return live.svc;
  const withApp = async () => {
    const [app, shader] = await Promise.all([nativeApp(), loadShader('bans')]);
    return { app, shader };
  };
  const svc = createBans({
    view: async (a) => {
      const { app, shader } = await withApp();
      return app.view(a, shader, { timeoutMs: 90000 });
    },
    transact: async (a, opts) => {
      const { app, shader } = await withApp();
      return app.transact(a, shader, opts);
    },
    status,
  });
  live = { session, svc };
  return svc;
}

