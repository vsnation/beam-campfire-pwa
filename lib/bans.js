// BEAM names (BANS, the BEAM Anonymous Name Service): look a name up, register
// it, renew it, list this wallet's names, pay a name; transfer, sell and buy a
// name; read what waits for this wallet's names and claim it.
//
// A port of the desktop app (lib/wallets/beam/contracts/bans/: bans_constants,
// bans_name, bans_args, bans_models, bans_timeline, bans_recipient,
// bans_service). Every transaction is built by a pinned app shader and read
// back from its bytes (lib/contract_tx.js) before the wallet is asked to sign:
// one call, the right contract and method, the right name, periods and owner
// key, and exactly the funds asked for. The approve sheet then has to show
// those same amounts and fee, or the request is refused unseen.
//
// A payment to a name is the one exception to "the BANS shader builds it": its
// `pay` reads the vault and the owner key from the node while it builds, with no
// proof, so a lying node could aim it anywhere (audit D-1). It is built instead
// by BEAM's own Anon-Vault app shader (vault_anon, user send_anon) into the
// pinned vault, for the owner key this wallet looked up, showed and remembered.
// The deposit is the same as BANS writes (vault_anon/app_impl.h OnUser_send_anon,
// the name zero-padded to 64 bytes as its message), so the owner's wallet finds
// and claims it as any other payment to their name.
//
// Amounts are BigInt in the asset's smallest unit (8 decimals for every asset).

import { nativeApp, privilegedApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { readContractTx, ArgsReader, singleEntry, CONTRACT_CALL_FEE, InvokeDataError, spendText } from './contract_tx.js';
import { VAULT_ANON_CID } from './dapps/policy.js';
import { t, tk } from './i18n.js';

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

// The shaders' kernel comments, written into each transaction and compared with ===: never translated.
export const KERNEL = Object.freeze({
  register: 'BANS: registering domain', // i18n-ignore: kernel comment the shader writes, compared
  extend: 'BANS: extending the domain registration period', // i18n-ignore: kernel comment the shader writes, compared
  setOwner: 'BANS: setting the domain owner', // i18n-ignore: kernel comment the shader writes, compared
  setPrice: 'BANS: setting the domain price', // i18n-ignore: kernel comment the shader writes, compared
  buy: 'BANS: buying the domain', // i18n-ignore: kernel comment the shader writes, compared
  pay: 'vault_anon send anon', // i18n-ignore: kernel comment the shader writes, compared
  receiveRaw: 'vault_anon receive raw', // i18n-ignore: kernel comment the shader writes, compared
  receiveAnon: 'vault_anon receive', // i18n-ignore: kernel comment the shader writes, compared
});

/** receive_all claims at most this many vault entries per transaction (bans/app.cpp, nMaxOps). */
export const CLAIMS_PER_TRANSACTION = 30;

export const METHOD = Object.freeze({ setOwner: 3, extend: 4, setPrice: 5, buy: 6, register: 7, vaultDeposit: 2, vaultWithdraw: 3 });

export class BansError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // invalidName, invalidKey, refused, claimUnsupported, ownerChanged, nameChanged, wrongVault, unexpected, priceMoved, notMine
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- names

// Shown with t() (describeNameProblem): read before any language is known.
const NAME_PROBLEM_TEXT = {
  empty: tk('Type a name.'),
  tooShort: tk('Names need at least 3 characters.'),
  tooLong: tk('Names can be at most 64 characters.'),
  invalidCharacter: tk('Use only lowercase letters, numbers, - _ and ~.'),
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

export const describeNameProblem = (p) => t(NAME_PROBLEM_TEXT[p] || NAME_PROBLEM_TEXT.invalidCharacter);

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
  if (!isKey(key) || key === ZERO_KEY) throw new BansError('invalidKey', t('That is not a name key. A name key is 66 characters of 0-9 and a-f; copy it again from the receiving wallet.'));
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

/** The name as BANS's pay writes it into a payment: its bytes, zero-padded to NAME_MAX (bans/app.cpp, Memset). Hex. */
export function nameMessage(name) {
  const hex = Array.from(name, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return hex + '00'.repeat(NAME_MAX - name.length);
}

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
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIODS) throw new RangeError(`periods must be 1..${MAX_PERIODS}`); // i18n-ignore: internal invariant, the screens never pass it
  return String(n);
}

function aidArg(aid) {
  if (!Number.isInteger(aid) || aid < 0 || aid > MAX_AID) throw new RangeError('asset id out of range'); // i18n-ignore: internal invariant, the screens never pass it
  return String(aid);
}

function amountArg(v, allowZero) {
  const b = BigInt(v);
  if (b < 0n || (!allowZero && b === 0n)) throw new RangeError('amount must be positive'); // i18n-ignore: internal invariant, the screens never pass it
  if (b > MAX_U64) throw new RangeError('amount above 2^64-1'); // i18n-ignore: internal invariant, the screens never pass it
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
  /**
   * A payment to the owner of `name`, built by BEAM's Anon-Vault app shader
   * (vault_anon/app.cpp, user send_anon) into BEAM's own vault, for exactly
   * `ownerKey`: the key this wallet checked, never one re-read while building.
   * (BANS's own manager/pay is not used: it reads the owner from the node as it
   * builds, audit D-1.)
   * msg: the name as BANS's pay writes it, its bytes zero-padded to 64, which the
   * shader encrypts for the owner, whose wallet then shows which name was paid.
   */
  sendAnon: (ownerKey, name, assetId, amount) =>
    build('user', 'send_anon', { pkOwner: requireKey(ownerKey), aid: aidArg(assetId), amount: amountArg(amount, false), msg: nameMessage(checkedName(name)) }, VAULT_ANON_CID),
  /** Gives the name to another key (owner only). */
  setOwner: (name, newOwnerKey) => build('user', 'domain_set_owner', { name: checkedName(name), pkOwner: requireKey(newOwnerKey) }),
  /** Lists the name for `amount` of `assetId`; an amount of 0 takes it off sale (owner only). */
  setPrice: (name, assetId, amount) => build('user', 'domain_set_price', { name: checkedName(name), aid: aidArg(assetId), amount: amountArg(amount, true) }),
  /** Pays the listed price; the name moves to this wallet's key. */
  buy: (name) => build('user', 'domain_buy', { name: checkedName(name) }),
  /**
   * Claims from the vault. Without a one-time key: what names this wallet sold
   * earned (privilege 0). With one: that payment to a name (privilege 1). 0 = all.
   * The shader reads every argument it declares (PAR_READ), so all are passed.
   */
  receive: ({ assetId, amount = 0n, oneTimeKey = null }) => build('user', 'receive', { pkOwner: oneTimeKey == null ? ZERO_KEY : requireKey(oneTimeKey), aid: aidArg(assetId), amount: amountArg(amount, true) }),
  /** Up to 30 claims, sale proceeds first (privilege 1). */
  receiveAll: () => build('user', 'receive_all'),
});

// ---------------------------------------------------------------- answers

const CID_RE = /^[0-9a-f]{64}$/;

// `what` is a technical detail for a report (a field and what it should hold): it stays English.
function fmt(what) {
  return new BansError('unexpected', t('The name service answered something this wallet cannot check ({what}). Try again; if it keeps happening, report it.', { what }));
}

function asMap(v, what) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`); // i18n-ignore: technical detail for a report
}

function asList(v, what) {
  if (Array.isArray(v)) return v;
  throw fmt(`${what}: expected a list`); // i18n-ignore: technical detail for a report
}

function asInt(v, what) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  throw fmt(`${what}: expected a whole number`); // i18n-ignore: technical detail for a report
}

function asBig(v, what) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw fmt(`${what}: expected an amount`); // i18n-ignore: technical detail for a report
}

function asKey(m, k) {
  if (isKey(m[k])) return m[k];
  throw fmt(`${k}: expected a 33-byte key`); // i18n-ignore: technical detail for a report
}

function asCid(m, k) {
  if (typeof m[k] === 'string' && CID_RE.test(m[k])) return m[k];
  throw fmt(`${k}: expected a contract id`); // i18n-ignore: technical detail for a report
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

/**
 * A name from a list the node answered. The contract stores only canonical names
 * (bans/contract.cpp checks every character and the length), so anything else was
 * made up on the way: refused, never shown as one of this wallet's names.
 */
function storedName(m) {
  if (typeof m.name !== 'string' || tryName(m.name) !== m.name) throw fmt('domains[].name: expected a name'); // i18n-ignore: technical detail for a report
  return m.name;
}

/** view_domain: {"domains": [...]}. */
export function parseViewDomain(out) {
  return asList(asMap(out, 'output').domains, 'domains').map((e) => {
    const m = asMap(e, 'domains[]');
    return domain(m, storedName(m));
  });
}

/**
 * role=user,action=view (privilege 1): my names, sale proceeds held under my key
 * (raw[]) and payments to my names (anon[], each with its one-time key and the
 * name the sender paid, decrypted by the shader).
 */
export function parseUserView(out) {
  const res = asMap(asMap(out, 'output').res, 'res');
  const domains = asList(res.domains ?? [], 'domains').map((e) => {
    const m = asMap(e, 'domains[]');
    return domain(m, storedName(m));
  });
  const saleProceeds = asList(res.raw ?? [], 'raw').map((e) => amountOf(asMap(e, 'raw[]')));
  const payments = asList(res.anon ?? [], 'anon').map((e) => {
    const m = asMap(e, 'anon[]');
    const a = amountOf(m);
    // The sender wrote this (it is decrypted from their payment): a name, or nothing. Never fatal,
    // or anyone could break this wallet's inbox with one payment.
    const name = typeof m.domain === 'string' && tryName(m.domain) === m.domain ? m.domain : null;
    return { oneTimeKey: asKey(m, 'pk'), assetId: a.assetId, amount: a.amount, name };
  });
  return { domains, saleProceeds, payments };
}

/**
 * view_params: {"res": {vault, dao-vault, oracle, price?, h0}}. price is USD per BEAM, 5 decimals, absent when stale.
 *
 * The node answers this without proof, and the vault is where every payment to a
 * name goes (audit D-1): one that is not BEAM's own (lib/dapps/policy.js
 * VAULT_ANON_CID, the BANS contract's setting since it was created) is refused.
 */
export function parseViewParams(out) {
  const res = asMap(asMap(out, 'output').res, 'res');
  if (res.price != null && typeof res.price !== 'string') throw fmt('price: expected text'); // i18n-ignore: technical detail for a report
  if (asCid(res, 'vault') !== VAULT_ANON_CID) throw wrongVault();
  return {
    vaultCid: VAULT_ANON_CID,
    daoVaultCid: asCid(res, 'dao-vault'),
    oracleCid: asCid(res, 'oracle'),
    activationHeight: asInt(res.h0, 'h0'),
    usdPerBeamText: res.price == null ? null : res.price,
  };
}

// ---------------------------------------------------------------- refusals

/** The shader's own error text -> what to say (bans_exceptions.dart); shown with t() (refusal). */
const REFUSALS = {
  'name is invalid': ['nameInvalid', tk('Names use only a-z, 0-9, - _ and ~, in lowercase.')],
  'name too short': ['nameTooShort', tk('Names need at least 3 characters.')],
  'name too long': ['nameTooLong', tk('Names can be at most 64 characters.')],
  'name not specified': ['nameMissing', tk('Type a name first.')],
  'not registered': ['notRegistered', tk('No one owns this name. Check the spelling, or ask for their address.')],
  'owned by other': ['ownedByOther', tk('This name belongs to another wallet, so this wallet cannot change it.')],
  'already owned by me': ['alreadyMine', tk('This name is already yours. Renew it instead.')],
  'validity period too long': ['periodTooLong', tk('A name can be paid for at most 50 years ahead. Choose fewer years.')],
  'price feed unavailable': ['priceFeedUnavailable', tk('The BEAM price feed is not updating right now, so names cannot be priced. Try again in a few minutes.')],
  'domain expired': ['domainExpired', tk('This name has expired, so it cannot receive payments. Ask the recipient for an address instead.')],
  'amount not specified': ['amountMissing', tk('Enter an amount above zero.')],
  'not for sale': ['notForSale', tk('This name is not listed for sale.')],
  'no change': ['noChange', tk('That is already the price. Nothing to change.')],
  'new owner not set': ['newOwnerMissing', tk("Paste the receiving wallet's name key.")],
  'nothing to withdraw': ['nothingToClaim', tk('There is nothing waiting to be claimed.')],
  'no funds': ['noFunds', tk('There is nothing waiting to be claimed.')],
  'insufficient funds': ['insufficientFunds', tk('Less is waiting than that amount. Claim the full amount instead.')],
  'not detected': ['paymentNotFound', tk('That payment was not found for this wallet. Refresh and try again.')],
  'invalid account key': ['invalidAccountKey', tk("That name key is not one BEAM can pay to. Ask for the receiving wallet's name key again.")],
};

export function refusal(shaderText) {
  const r = REFUSALS[shaderText];
  if (r) return new BansError('refused', t(r[1]), { refusal: r[0], shaderText });
  return new BansError('refused', t('The name service could not do that ({reason}). Try again; if it keeps happening, report it.', { reason: shaderText }), { refusal: 'unknown', shaderText });
}

function wrongVault() {
  return new BansError('wrongVault', t("The BEAM node this wallet uses gave a vault for name payments that is not BEAM's own, so nothing was sent. Try again later, or choose another node under Settings → BEAM node."));
}

/**
 * The owner key a name has now, against the one this wallet paid it before
 * (`pinned`, kept sealed with the wallet: lib/contacts.js) and the new one the
 * person chose after seeing both (`accepted`):
 *   'first'    never paid from this wallet
 *   'same'     the owner it was paid before
 *   'changed'  another owner: stop, show both, ask
 *   'accepted' another owner, the one the person chose to pay
 * A name changes owner when it is sold, transferred or expires - or when a node
 * lies about it (audit D-1) - so a change is never taken silently.
 */
export function pinVerdict({ pinned = null, now, accepted = null }) {
  if (!pinned) return 'first';
  if (now === pinned) return 'same';
  return now === accepted ? 'accepted' : 'changed';
}

/**
 * After a payment to a name got no answer in time (it may have gone out): the owner key to keep for
 * it, or null. Only when what this wallet remembers was read (`known`: {pinned} — null when it could
 * not be read) and the key Send checked does not contradict it: a different remembered owner is never
 * replaced without the person's choice (`accepted`) (release audit 0.2.18, S1).
 */
export function pinAfterTimeout({ known = null, checked = null, accepted = null }) {
  if (!known || !checked) return null;
  return pinVerdict({ pinned: known.pinned ?? null, now: checked, accepted }) === 'changed' ? null : checked;
}

function nameChanged(name, before, now) {
  return new BansError('nameChanged', t('{name} now has a different owner than when you last paid it. Nothing was sent. Check with the person before paying.', { name: display(name) }), { name, before, now });
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
  if (e instanceof InvokeDataError) return new BansError('unexpected', t('The name service built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.'), { detail: e.message });
  if (e && e.code === 'shader') return refusal(e.message);
  if ((e && e.code === 'rpc' && isPrivilegeFailure(e.rpc)) || (e && e.code === 'open' && e.privileged)) {
    return new BansError('claimUnsupported', t('Claiming name payments is not possible in this version. They are safe in the BEAM vault.'));
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
  if (!m) throw new BansError('refused', t(REFUSALS['price feed unavailable'][1]), { refusal: 'priceFeedUnavailable' });
  const frac = m[2] || '';
  const scale = 10n ** BigInt(frac.length);
  const digits = BigInt(m[1] + frac);
  if (digits === 0n) throw new BansError('refused', t(REFUSALS['price feed unavailable'][1]), { refusal: 'priceFeedUnavailable' });
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
  const typed = String(text || '').trim();
  if (!typed) return { kind: 'empty' };
  if ((HEX_RE.test(typed) && typed.length >= 60) || typed.length > NAME_MAX + 6) return { kind: 'address' };
  const candidate = normaliseName(typed.startsWith('@') ? typed.slice(1) : typed);
  const p = nameProblem(candidate);
  if (!p) return { kind: 'name', name: candidate };
  return { kind: 'invalid', problem: p };
}

// ---------------------------------------------------------------- service

// `what` (what the check expected) goes to `detail`, for logs and reports only: never shown, stays English.
const fail = (what) => {
  throw new BansError('unexpected', t('The name service built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.'), { detail: `expected ${what}` }); // i18n-ignore: detail for logs and reports
};

function expectName(r, name) {
  const len = r.u8();
  const bytes = r.bytes(len);
  if (String.fromCharCode(...bytes) !== name || !r.atEnd) fail(`name ${name}`); // i18n-ignore: what the check expected, a detail for logs
}

function onlyBeamSpend(e) {
  const s = [...e.spend].filter(([, v]) => v !== 0n);
  if (s.length !== 1 || s[0][0] !== 0 || s[0][1] <= 0n) fail('the price is paid in BEAM'); // i18n-ignore: what the check expected, a detail for logs
  return s[0][1];
}

/**
 * The approve sheet must show exactly what the built transaction does: these
 * spends, nothing received, this fee. Anything else is refused unseen.
 */
export function consentExpectation(getBuilt) {
  return (req) => {
    const b = getBuilt();
    const bad = { code: 'unexpected', message: t('The wallet built something other than what this screen shows. Nothing was sent.') };
    if (!b || req.kind !== 'contract') return bad;
    const same = (list, map) => list.length === map.size && list.every((a) => map.get(a.assetId) === a.amount);
    if (!same(req.spends, b.pays) || !same(req.receives, b.receives)) return bad;
    if (req.fee !== b.fee) return { code: 'unexpected', message: t('The network fee is not the one this screen expected. Nothing was sent.') };
    return null;
  };
}

/**
 * The payment to a name, as built: one call, to BEAM's Anon-Vault, its Deposit
 * method, with no signature asked of this wallet and nothing stored to re-run;
 * exactly `want` of `assetId` into an account of a one-time key, with a sender
 * key and the 64-byte encrypted name after it (vault_anon Method::Deposit,
 * OnUser_send_anon); the kernel spends exactly that, and receives nothing.
 */
function checkDeposit(d, assetId, want) {
  const e = singleEntry(d, VAULT_ANON_CID, METHOD.vaultDeposit, fail);
  if (e.flags !== 0 || e.signatureCount !== 0 || d.appArgs !== null || d.appPrivilege !== null) fail('a plain deposit'); // i18n-ignore: what the check expected, a detail for logs
  if (e.comment !== KERNEL.pay) fail(`"${KERNEL.pay}"`);
  const r = new ArgsReader(e.args);
  if (r.u64() !== want) fail('amount');
  const custom = r.u32();
  if (!isKey(r.pubKey())) fail('a one-time key');
  if (r.u32() !== assetId) fail('asset');
  if (custom !== 33 + NAME_MAX || r.remaining !== custom) fail('sender key and encrypted name'); // i18n-ignore: what the check expected, a detail for logs
  if (!isKey(r.pubKey())) fail('a sender key'); // i18n-ignore: what the check expected, a detail for logs
  const spends = [...e.spend].filter(([, v]) => v !== 0n);
  if (spends.length !== 1 || spends[0][0] !== assetId || spends[0][1] !== want) fail(`the kernel pays exactly the amount, not ${spendText(e.spend)}`); // i18n-ignore: what the check expected, a detail for logs
  if (d.receives.size) fail('a payment receives nothing'); // i18n-ignore: what the check expected, a detail for logs
}

/** The vault withdrawals a claim builds: each one pays this wallet, nothing leaves it. */
function claimEntries(d, myKey) {
  if (!d.entries.length) fail('at least one claim'); // i18n-ignore: what the check expected, a detail for logs
  for (const e of d.entries) {
    if (e.contractId !== VAULT_ANON_CID || e.method !== METHOD.vaultWithdraw) fail('claims withdraw from the BEAM names vault'); // i18n-ignore: what the check expected, a detail for logs
    const r = new ArgsReader(e.args);
    const amount = r.u64();
    const custom = r.u32();
    const owner = r.pubKey();
    const aid = r.u32();
    if (r.remaining !== custom) fail('a vault withdrawal'); // i18n-ignore: what the check expected, a detail for logs
    if (!e.isAdvanced && owner !== myKey) fail('sale proceeds held under this wallet\'s key'); // i18n-ignore: what the check expected, a detail for logs
    const spends = [...e.spend].filter(([, v]) => v !== 0n);
    if (amount <= 0n || spends.length !== 1 || spends[0][0] !== aid || spends[0][1] !== -amount) fail(`a claim receives its amount, not ${spendText(e.spend)}`); // i18n-ignore: what the check expected, a detail for logs
  }
  if (d.pays.size) fail('claims only receive'); // i18n-ignore: what the check expected, a detail for logs
}

/**
 * BANS over one wallet session.
 *   deps.view(args) -> parsed shader output (lib/contracts.js App.view)
 *   deps.transact(args, {inspect, expect, intent}) -> txId (App.transact)
 *   deps.status() -> wallet_status ({current_height, current_state_timestamp, is_in_sync})
 *   deps.transactVault(args, opts): the same with BEAM's Anon-Vault app shader (payments to a name).
 *   deps.viewPrivileged / deps.transactPrivileged: the same at privilege 1 (lib/contracts.js
 *     privilegedApp), for the inbox and claims of payments; absent = claims unsupported.
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

  const unsupported = () => new BansError('claimUnsupported', t('Claiming name payments is not possible in this version. They are safe in the BEAM vault.'));

  async function viewPrivileged(a) {
    if (!deps.viewPrivileged) throw unsupported();
    try {
      return await deps.viewPrivileged(a);
    } catch (e) {
      throw mapError(e);
    }
  }

  /** Why a name that expired more than 90 days ago cannot be transferred, sold or taken off sale. */
  function pastHoldText(name, action) {
    if (action === 'transfer') return t('{name} expired more than 90 days ago, so it cannot be transferred. Register it again first.', { name: display(name) });
    if (action === 'unlist') return t('{name} expired more than 90 days ago, so it cannot be taken off sale. Register it again first.', { name: display(name) });
    return t('{name} expired more than 90 days ago, so it cannot be sold. Register it again first.', { name: display(name) });
  }

  /** An owned, not long-expired name, read now: {res, key}. action: 'transfer' | 'sell' | 'unlist'. */
  async function ownedNow(name, action) {
    const res = await svc.resolve(name);
    const key = await svc.myKey();
    if (!res.domain) throw refusal('not registered'); // i18n-ignore: the shader's error text, a key of REFUSALS
    if (res.ownerKey !== key) throw refusal('owned by other'); // i18n-ignore: the shader's error text, a key of REFUSALS
    if (res.status === STATUS.availableAgain) throw new BansError('refused', pastHoldText(name, action), { refusal: 'pastHold' });
    return { res, key };
  }

  async function tip() {
    const st = await deps.status();
    const tipHeight = Number(st && st.current_height);
    if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new BansError('unexpected', t('The wallet does not know the current block yet. Try again in a moment.'));
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
      const clock = await tip();
      const d = parseViewName(await view(args.viewName(name)), name);
      const status = d ? statusOf({ expireHeight: d.expireHeight, tipHeight: clock.tipHeight, listed: Boolean(d.salePrice) }) : STATUS.available;
      return { name, domain: d, status, ownerKey: d ? d.ownerKey : null, ...clock };
    },

    /** Every name this wallet owns (view_domain filtered by my_key), expired ones included. */
    async myNames() {
      const key = await svc.myKey();
      const clock = await tip();
      const names = parseViewDomain(await view(args.viewDomain(key)));
      return { key, names: names.map((d) => ({ ...d, status: statusOf({ expireHeight: d.expireHeight, tipHeight: clock.tipHeight, listed: Boolean(d.salePrice) }) })), ...clock };
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
          if (owner !== key) fail('the name is registered to this wallet'); // i18n-ignore: what the check expected, a detail for logs
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
      if (!res.domain) throw refusal('not registered'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (res.ownerKey !== key) throw refusal('owned by other'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (res.status === STATUS.availableAgain) throw new BansError('refused', t('{name} expired more than 90 days ago, so it can no longer be renewed. Register it again instead.', { name: display(name) }), { refusal: 'pastHold' });
      const max = maxExtendPeriods({ expireHeight: res.domain.expireHeight, tipHeight: res.tipHeight });
      if (periods > max) throw refusal('validity period too long'); // i18n-ignore: the shader's error text, a key of REFUSALS
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
     * Pays `amount` of `assetId` to the owner of `name`, anonymously, through
     * BEAM's Anon-Vault. The name is resolved before the build and again after
     * it; if its owner differs from the one the person was shown
     * (expectedOwnerKey), or between the two, nothing is signed.
     *
     * The payment is built by BEAM's Anon-Vault app shader (args.sendAnon) into
     * VAULT_ANON_CID for exactly that owner key, so nothing the node answers
     * while it is built can redirect it (audit D-1). The one-time key in the
     * kernel is the owner key plus a point from the shader's own random scalar,
     * which the wallet cannot recompute; that it belongs to `key` rests on the
     * pinned shader, which takes the key as its argument and reads no chain state.
     *
     * pinnedKey: the owner key this wallet paid the name before (null: never).
     * Another owner now stops the payment (nameChanged, with both keys) unless it
     * is acceptedKey, the new one the person saw and chose (pinVerdict).
     */
    async pay(name, assetId, amount, { expectedOwnerKey = null, pinnedKey = null, acceptedKey = null } = {}) {
      checkedName(name);
      const before = await svc.resolve(name);
      const key = before.ownerKey;
      if (!key) throw refusal('not registered'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (!canReceivePayments(before.status)) throw refusal('domain expired'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (expectedOwnerKey && key !== expectedOwnerKey) throw ownerChanged(name);
      if (pinVerdict({ pinned: pinnedKey, now: key, accepted: acceptedKey }) === 'changed') throw nameChanged(name, pinnedKey, key);
      return svc.deposit(key, name, assetId, amount, {
        // Right after the build, before anything is signed: still the same owner, still able to receive.
        check: async () => {
          const after = await svc.resolve(name);
          if (after.ownerKey !== key) throw ownerChanged(name);
          if (!canReceivePayments(after.status)) throw refusal('domain expired'); // i18n-ignore: the shader's error text, a key of REFUSALS
        },
      });
    },

    /**
     * The payment itself, as pay() makes it once the name's owner is known: BEAM's
     * Anon-Vault app shader builds a deposit of `amount` of `assetId` into
     * VAULT_ANON_CID for exactly `ownerKey`, with `name` as its message; check(d)
     * runs on the built transaction, then checkDeposit; the approve sheet shows a
     * payment to name.beam with the built amounts and fee. Used directly only by
     * the live test that pays this wallet's own key and claims it back
     * (test/e2e/live_vault_claim.mjs).
     */
    async deposit(ownerKey, name, assetId, amount, { check = null } = {}) {
      const key = requireKey(ownerKey);
      const a = args.sendAnon(key, name, assetId, amount);
      const want = BigInt(amount);
      let built = null;
      const txId = await svc.transact(a, {
        vault: true,
        intent: { action: 'namePay', name },
        inspect: async (raw) => {
          const d = readContractTx(raw);
          if (check) await check(d);
          checkDeposit(d, assetId, want);
          built = { pays: d.pays, receives: d.receives, fee: d.fee };
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ownerKey: key, ...built };
    },

    /**
     * Gives `name` to the wallet whose name key is `newOwnerKey`. Owner only; no
     * funds move, only the network fee. The kernel must name this key and this name.
     */
    async setOwner(name, newOwnerKey, { words = {}, onBuilt = null } = {}) {
      checkedName(name);
      const to = requireKey(newOwnerKey);
      const { key } = await ownedNow(name, 'transfer');
      if (to === key) throw new BansError('refused', t("That is this wallet's own key. Paste the key of the wallet that should get {name}.", { name }), { refusal: 'ownKey' });
      const a = args.setOwner(name, to);
      let built = null;
      const txId = await svc.transact(a, {
        intent: { ...words, action: 'nameTransfer', name, newOwnerKey: to, checkCode: checkCode(to) },
        inspect: (raw) => {
          const d = readContractTx(raw);
          const e = singleEntry(d, BANS_CID, METHOD.setOwner, fail);
          const r = new ArgsReader(e.args);
          if (r.pubKey() !== to) fail('the new owner key'); // i18n-ignore: what the check expected, a detail for logs
          expectName(r, name);
          if (d.spend.size) fail('a transfer moves no funds'); // i18n-ignore: what the check expected, a detail for logs
          built = { pays: d.pays, receives: d.receives, fee: d.fee };
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, newOwnerKey: to, ...built };
    },

    /**
     * Lists `name` for `amount` of `assetId`; 0 takes it off sale. Owner only; no
     * funds move. Anyone can then buy it at that price at once.
     */
    async setPrice(name, assetId, amount, { words = {}, onBuilt = null } = {}) {
      checkedName(name);
      const price = BigInt(amount);
      const { res } = await ownedNow(name, price === 0n ? 'unlist' : 'sell');
      const listed = res.domain.salePrice;
      if (price === 0n && !listed) throw refusal('no change'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (listed && listed.assetId === assetId && listed.amount === price) throw refusal('no change'); // i18n-ignore: the shader's error text, a key of REFUSALS
      const a = args.setPrice(name, assetId, price);
      let built = null;
      const txId = await svc.transact(a, {
        intent: price === 0n ? { ...words, action: 'nameUnlist', name } : { ...words, action: 'nameSell', name, assetId, amount: price },
        inspect: (raw) => {
          const d = readContractTx(raw);
          const e = singleEntry(d, BANS_CID, METHOD.setPrice, fail);
          const r = new ArgsReader(e.args);
          if (r.u32() !== assetId) fail('the asset'); // i18n-ignore: what the check expected, a detail for logs
          if (r.u64() !== price) fail('the price'); // i18n-ignore: what the check expected, a detail for logs
          expectName(r, name);
          if (d.spend.size) fail('a listing moves no funds'); // i18n-ignore: what the check expected, a detail for logs
          built = { pays: d.pays, receives: d.receives, fee: d.fee };
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ...built };
    },

    /**
     * Buys a listed name at exactly the price the person was shown
     * (expectedPrice {assetId, amount}); the name moves to this wallet's key with
     * the time left on it. A price changed since then is refused before signing.
     */
    async buy(name, { expectedPrice = null, words = {}, onBuilt = null } = {}) {
      checkedName(name);
      const res = await svc.resolve(name);
      const key = await svc.myKey();
      if (!res.domain) throw refusal('not registered'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (res.ownerKey === key) throw refusal('already owned by me'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (res.status === STATUS.availableAgain) throw new BansError('refused', t('{name} has expired for good, so it cannot be bought. Register it instead.', { name: display(name) }), { refusal: 'pastHold' });
      const listed = res.domain.salePrice;
      if (!listed) throw refusal('not for sale'); // i18n-ignore: the shader's error text, a key of REFUSALS
      if (expectedPrice && (listed.assetId !== expectedPrice.assetId || listed.amount !== BigInt(expectedPrice.amount))) throw new BansError('priceMoved', t('The seller changed the price of {name}. Nothing was sent; check the new price and try again.', { name: display(name) }), { listed });
      const a = args.buy(name);
      let built = null;
      const txId = await svc.transact(a, {
        intent: { ...words, action: 'nameBuy', name },
        inspect: (raw) => {
          const d = readContractTx(raw);
          const e = singleEntry(d, BANS_CID, METHOD.buy, fail);
          const r = new ArgsReader(e.args);
          if (r.pubKey() !== key) fail('the name goes to this wallet'); // i18n-ignore: what the check expected, a detail for logs
          expectName(r, name);
          const s = [...e.spend].filter(([, v]) => v !== 0n);
          if (s.length !== 1 || s[0][0] !== listed.assetId || s[0][1] !== listed.amount) fail(`the kernel pays the listed price, not ${spendText(e.spend)}`); // i18n-ignore: what the check expected, a detail for logs
          built = { pays: d.pays, receives: d.receives, fee: d.fee };
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, price: listed, expireHeight: res.domain.expireHeight, ...built };
    },

    /** What waits for this wallet's names (privilege 1): {domains, saleProceeds, payments}. */
    async inbox() {
      return parseUserView(await viewPrivileged(args.userView()));
    },

    /**
     * Claims up to 30 waiting payments and sale proceeds in one transaction
     * (privilege 1). words(built): the approve sheet's extra words, from what was
     * built (rows, notes: screens/consent.js intentExtras), or a plain object.
     */
    async claimAll({ words = null, onBuilt = null } = {}) {
      if (!deps.transactPrivileged) throw unsupported();
      await svc.params(); // refuses a node that names another vault
      const key = await svc.myKey();
      let built = null;
      const intent = { action: 'nameClaim' };
      const txId = await svc.transact(args.receiveAll(), {
        privileged: true,
        intent,
        inspect: (raw) => {
          const d = readContractTx(raw, { allowAdvanced: true });
          claimEntries(d, key);
          built = { pays: d.pays, receives: d.receives, fee: d.fee, count: d.entries.length };
          Object.assign(intent, typeof words === 'function' ? words(built) : words || {}, { action: 'nameClaim' });
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ...built };
    },

    /**
     * Claims what names this wallet sold earned in `assetId` (privilege 0: works
     * where the inbox cannot be read). A shader "no funds" means nothing waits.
     */
    async claimSaleProceeds(assetId, { words = null, onBuilt = null } = {}) {
      await svc.params(); // refuses a node that names another vault
      const key = await svc.myKey();
      let built = null;
      const intent = { action: 'nameClaim' };
      const txId = await svc.transact(args.receive({ assetId }), {
        intent,
        inspect: (raw) => {
          const d = readContractTx(raw, { allowAdvanced: true });
          claimEntries(d, key);
          built = { pays: d.pays, receives: d.receives, fee: d.fee, count: d.entries.length };
          Object.assign(intent, typeof words === 'function' ? words(built) : words || {}, { action: 'nameClaim' });
          if (onBuilt) onBuilt(built);
        },
        expect: consentExpectation(() => built),
      });
      return { txId, ...built };
    },

    /**
     * deps.transact with this module's inspect: it returns nothing to let the
     * transaction on, and what it throws comes back to the caller as thrown
     * (lib/contracts.js would otherwise report every refusal as 'unexpected').
     * opts.privileged: through deps.transactPrivileged (claims of payments).
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
      const { privileged = false, vault = false, ...rest } = opts;
      if (vault && !deps.transactVault) throw new BansError('unexpected', t('Paying a name is not possible in this version. Nothing was sent.'));
      const run = privileged ? deps.transactPrivileged : vault ? deps.transactVault : deps.transact;
      try {
        return await run(a, { ...rest, inspect });
      } catch (e) {
        throw mapError(thrown || e);
      }
    },
  };

  function checkPrice(pay, estimate) {
    if (!estimate) return;
    const ceiling = estimate.maxGroth + (estimate.maxGroth * PRICE_SLACK_BPS) / 10000n;
    if (pay > ceiling) throw new BansError('priceMoved', t('The BEAM price moved since the estimate on this screen. Nothing was sent; check the new price and try again.'), { pay });
  }

  return svc;
}

function ownerChanged(name) {
  return new BansError('ownerChanged', t('{name} just changed owner. Nothing was sent. Check with the recipient before sending.', { name: display(name) }));
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
  // Privilege 1, for the inbox and claims only. An engine that cannot open it says so as 'claimUnsupported'.
  const withPrivileged = async () => {
    const [app, shader] = await Promise.all([
      privilegedApp().catch((e) => {
        throw e && e.code === 'open' ? Object.assign(e, { privileged: true }) : e;
      }),
      loadShader('bans'),
    ]);
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
    // Payments to a name: BEAM's Anon-Vault app shader, on the same app (privilege 0).
    transactVault: async (a, opts) => {
      const [app, shader] = await Promise.all([nativeApp(), loadShader('vaultAnon')]);
      return app.transact(a, shader, opts);
    },
    viewPrivileged: async (a) => {
      const { app, shader } = await withPrivileged();
      return app.view(a, shader, { timeoutMs: 90000 });
    },
    transactPrivileged: async (a, opts) => {
      const { app, shader } = await withPrivileged();
      return app.transact(a, shader, opts);
    },
    status,
  });
  live = { session, svc };
  return svc;
}

