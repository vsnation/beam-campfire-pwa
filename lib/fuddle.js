// Fuddle v9: a Wordle tournament on BEAM (the Fuddle repo's v9/, commit 8e86b3140: README.md is
// the spec this follows, contract.h the byte layout, app.cpp the app shader pinned as
// lib/shaders.js "fuddle").
//
// How a game goes, for the player: enter a game of a tournament (the entry in the tournament's
// asset and the answering fee in BEAM), guess (each letter of a guess costs the letter price,
// bought with the guess), get a hint from the answer service (green / yellow / grey, on chain about
// two blocks later), guess again within the clocks, and once the tournament is over and settled
// collect the prize share and whatever refunds are owed. A game the service fails is refunded with
// its compensation (the slash) at once; a game never played gives the entry and the answering fee
// back.
//
// Nothing here trusts the app shader's transaction more than it has to. Every transaction is built
// by the pinned app shader and then read back from its bytes (lib/contract_tx.js) before the wallet
// is asked to sign: exactly one call, to this contract, the method, the declared charge and its
// comment, the signer count, the argument bytes equal to this module's own encoding of contract.h's
// packed struct (the player key included), the funds to the groth against figures computed here
// from the tournament's terms, and the network fee equal to what the charge sets (the wallet never
// passes a fee of its own). The approve sheet must then show those same figures.
//
// The contract is not deployed yet: FUDDLE_CID (lib/fuddle_id.js) is null and fuddleFor() returns
// null, so the screens say "Fuddle opens soon". Guesses need no dictionary proof (SubmitGuess
// carries letters only; only the service's Reveal proves its word is in the published list), so
// the wallet ships no word list.

import { readContractTx, toHex, fromHex, le, concat, bytesEqual, ArgsReader, InvokeDataError, spendText } from './contract_tx.js';
import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { FUDDLE_CID, FUDDLE_SERVICE_PK, fuddleLive } from './fuddle_id.js';
import { t, tn, tk } from './i18n.js';

// ---------------------------------------------------------------- the contract (contract.h)

export const METHOD = Object.freeze({ enterGame: 9, buyLetters: 10, submitGuess: 11, claimTimeout: 14, finalize: 15, claim: 16, claimRefund: 21 });
/** BVM units the app shader declares (contract.h Charge): they set the network fee. */
export const CHARGE = Object.freeze({ enterGame: 220000, enterGameEvict: 315000, buyLetters: 153000, submitGuess: 156000, claimTimeout: 215000, finalize: 102000, claim: 132000, claimRefund: 179000 });
// Kernel comments the app shader writes into the transaction, checked byte for byte.
export const KERNEL = Object.freeze({
  enterGame: 'Fuddle v9: enter game', // i18n-ignore: a kernel comment the app shader writes, compared
  buyLetters: 'Fuddle v9: buy letters', // i18n-ignore: a kernel comment the app shader writes, compared
  submitGuess: 'Fuddle v9: guess', // i18n-ignore: a kernel comment the app shader writes, compared
  claimTimeout: 'Fuddle v9: claim timeout', // i18n-ignore: a kernel comment the app shader writes, compared
  finalize: 'Fuddle v9: finalize tournament', // i18n-ignore: a kernel comment the app shader writes, compared
  claim: 'Fuddle v9: claim', // i18n-ignore: a kernel comment the app shader writes, compared
  claimRefund: 'Fuddle v9: refund of a game', // i18n-ignore: a kernel comment the app shader writes, compared
});
/** The argument struct sizes (contract.h, #pragma pack(1)). */
export const ARGS_SIZE = Object.freeze({ enterGame: 46, buyLetters: 93, submitGuess: 53, claimTimeout: 12, finalize: 8, claim: 41, claimRefund: 45 });

export const NO_EVICT = 0xffffffff;
export const WORD_LENGTHS = Object.freeze([4, 5, 6]);
export const MAX_ATTEMPTS = 6;
export const LETTERS = 26;
export const IDLE_BLOCKS = 60;
export const REVEAL_BLOCKS = 60;
export const MAX_OPEN_PER_PLAYER = 4;
export const ANSWER_BLOCKS_MIN = 20;
export const ANSWER_BLOCKS_MAX = 120;
export const BPS = 10000;
/** One block is about a minute on BEAM: the clocks are counted in blocks. */
export const BLOCK_SECONDS = 60;

export const GAME = Object.freeze({ playing: 0, revealed: 1, failed: 2, ended: 3 });
export const VERDICT = Object.freeze({ none: 0, honest: 1, lied: 2, silent: 3, unrevealed: 4, unplayed: 5 });
export const FB = Object.freeze({ absent: 0, present: 1, correct: 2 });

const TOURNAMENT_PHASES = new Set(['finalised', 'awaiting_answerer', 'upcoming', 'open', 'ready_to_finalise', 'ending']);
const GAME_PHASES = new Set(['revealed', 'ended_unplayed', 'failed', 'hint_overdue', 'waiting_hint', 'your_move', 'unplayed_ended', 'reveal_overdue', 'waiting_reveal']);

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const KEY_RE = /^[0-9a-f]{64}0[01]$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- fees, clocks, scores

/** The network fee of a call declaring `units`: 0.001 BEAM + max(0.01 BEAM, 10 groth per unit) (v9 README, "Methods"). */
export function feeForCharge(units) {
  const bvm = 10n * BigInt(units);
  return 100000n + (bvm < 1000000n ? 1000000n : bvm);
}

/** Every call's network fee: enter 0.023 BEAM (0.0325 when it ends an abandoned game), guess 0.0166, ... */
export const FEES = Object.freeze(Object.fromEntries(Object.entries(CHARGE).map(([k, v]) => [k, feeForCharge(v)])));

/** Blocks after entering within which the first guess is due (contract.h FirstGuessBlocks). */
export const firstGuessBlocks = (answerBlocks) => Math.min(2 * answerBlocks, IDLE_BLOCKS);

/** The shortest game that always leaves time for six guesses (contract.h MinGameBlocks). */
export const minGameBlocks = (answerBlocks) => firstGuessBlocks(answerBlocks) + (MAX_ATTEMPTS - 1) * (answerBlocks + IDLE_BLOCKS);

/** The score of a game solved at `attempts` (1..6): (1000 + (7 - attempts) x 150) x 100/125/150 % for 4/5/6 letters. */
export function scoreOf(len, attempts) {
  if (!WORD_LENGTHS.includes(len) || !Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) return 0;
  const mult = len === 4 ? 100 : len === 5 ? 125 : 150;
  return Math.floor(((1000 + (7 - attempts) * 150) * mult) / 100);
}

/** The score multiplier of a word length, as a percentage: 100, 125, 150. */
export const lengthMultiplier = (len) => (len === 4 ? 100 : len === 5 ? 125 : 150);

/** a * b / c, floored, exact for 64-bit inputs (the shader's MulDiv). */
export function mulDiv(a, b, c) {
  const x = BigInt(a);
  const y = BigInt(b);
  const z = BigInt(c);
  if (x === 0n || y === 0n) return 0n;
  return (x * y) / z;
}

/** The word lengths a tournament allows (len_mask bit 0 = 4 letters, 1 = 5, 2 = 6). */
export const lengthsOf = (lenMask) => WORD_LENGTHS.filter((len, i) => lenMask & (1 << i));

// ---------------------------------------------------------------- letters and hints

/** "crane" -> [2, 17, 0, 13, 4]; refuses anything but a..z (either case). */
export function lettersOf(word) {
  const s = String(word ?? '');
  const out = [];
  for (const c of s) {
    const lower = c.toLowerCase();
    if (lower < 'a' || lower > 'z' || lower.length !== 1) throw new RangeError('letters a to z only'); // i18n-ignore: internal invariant (the keyboard types a..z only)
    out.push(lower.charCodeAt(0) - 97);
  }
  return out;
}

/** What the guess field may hold: a..z only, lower case, at most `len`. */
export const cleanGuess = (text, len) => String(text ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, len);

/**
 * How many letters a guess must buy, by the contract's rule: each position spends one letter of
 * that kind from the player's stock in this tournament while there is one, else it is missing.
 */
export function missingLetters(stock, word) {
  const left = Array.from({ length: LETTERS }, (_, i) => Number((stock && stock[i]) || 0));
  let missing = 0;
  for (const c of lettersOf(word)) {
    if (left[c] > 0) left[c]--;
    else missing++;
  }
  return missing;
}

/** "02110" -> ['absent', 'correct', 'present', 'present', 'absent']. */
export function hintMarks(feedback) {
  const names = ['absent', 'present', 'correct'];
  return String(feedback).split('').map((d) => {
    const v = Number(d);
    if (!Number.isInteger(v) || v < 0 || v > 2) throw new RangeError('a hint digit is 0, 1 or 2'); // i18n-ignore: internal invariant (parsed hints are checked first)
    return names[v];
  });
}

/**
 * The hint the contract computes (contract.h ComputeFeedback): greens first, then yellows left to
 * right, each letter of the word used at most once. For tests and for checking a revealed game.
 */
export function feedbackFor(guess, word) {
  const g = lettersOf(guess);
  const w = lettersOf(word);
  if (g.length !== w.length) throw new RangeError("a guess has the word's length"); // i18n-ignore: internal invariant
  const fb = g.map((c, i) => (c === w[i] ? 2 : 0));
  const rest = w.map((c, i) => (fb[i] === 2 ? -1 : c));
  for (let i = 0; i < g.length; i++) {
    if (fb[i] === 2) continue;
    const j = rest.indexOf(g[i]);
    if (j >= 0) {
      fb[i] = 1;
      rest[j] = -1;
    }
  }
  return fb.join('');
}

/** Each letter's best known state over a game's answered guesses: Map('a' -> 'correct' | 'present' | 'absent'). */
export function letterStates(guesses) {
  const rank = { absent: 0, present: 1, correct: 2 };
  const out = new Map();
  for (const g of guesses || []) {
    if (!g.answered || !g.feedback) continue;
    const marks = hintMarks(g.feedback);
    [...g.letters].forEach((c, i) => {
      const m = marks[i];
      if (!out.has(c) || rank[m] > rank[out.get(c)]) out.set(c, m);
    });
  }
  return out;
}

// ---------------------------------------------------------------- args (app.cpp Method_1)

function checkCid(cid) {
  if (!fuddleLive(cid)) throw new RangeError('Fuddle calls need its contract id'); // i18n-ignore: internal invariant (the screens never call before the contract is live)
}
const u64Arg = (v) => {
  const b = BigInt(v);
  if (b < 0n || b > U64_MAX) throw new RangeError('not a 64-bit unsigned number'); // i18n-ignore: internal invariant, never shown
  return b.toString();
};
const u32Arg = (v) => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError('not a 32-bit unsigned number'); // i18n-ignore: internal invariant, never shown
  return String(v);
};
const lenArg = (len) => {
  if (!WORD_LENGTHS.includes(len)) throw new RangeError('a word has 4, 5 or 6 letters'); // i18n-ignore: internal invariant, never shown
  return String(len);
};
const attemptArg = (a) => {
  if (!Number.isInteger(a) || a < 0 || a >= MAX_ATTEMPTS) throw new RangeError('an attempt is 0..5'); // i18n-ignore: internal invariant, never shown
  return String(a);
};
function lettersArg(text, { min = 1, max = 256 } = {}) {
  const s = String(text ?? '');
  if (!/^[a-z]+$/.test(s) || s.length < min || s.length > max) throw new RangeError('letters a to z, lower case'); // i18n-ignore: internal invariant, never shown
  return s;
}
const pkArg = (pk) => {
  if (!KEY_RE.test(String(pk))) throw new RangeError('not a public key'); // i18n-ignore: internal invariant, never shown
  return pk;
};

function join(cid, action, p = {}) {
  checkCid(cid);
  return ['role=user', `action=${action}`, `cid=${cid}`, ...Object.entries(p).map(([k, v]) => `${k}=${v}`)].join(',');
}

/** The app shader's arguments for every action the wallet uses (role=user). Nothing else is ever sent. */
export const fuddleArgs = Object.freeze({
  myKey: (cid) => join(cid, 'my_key'),
  viewState: (cid) => join(cid, 'view_state'),
  viewTournaments: (cid, { skip = 0, limit = 100 } = {}) => join(cid, 'view_tournaments', { skip: u64Arg(skip), limit: u32Arg(limit) }),
  viewTournament: (cid, { tid }) => join(cid, 'view_tournament', { tid: u64Arg(tid) }),
  viewMyTournament: (cid, { tid }) => join(cid, 'view_my_tournament', { tid: u64Arg(tid) }),
  viewGame: (cid, { tid, idx }) => join(cid, 'view_game', { tid: u64Arg(tid), idx: u32Arg(idx) }),
  viewMyGames: (cid, { tid }) => join(cid, 'view_my_games', { tid: u64Arg(tid) }),
  viewClaimable: (cid, { skip = 0, limit = 200 } = {}) => join(cid, 'view_claimable', { skip: u64Arg(skip), limit: u32Arg(limit) }),
  viewAnswerer: (cid, { pk }) => join(cid, 'view_answerer', { pk: pkArg(pk) }),
  enterGame: (cid, { tid, len }) => join(cid, 'enter_game', { tid: u64Arg(tid), len: lenArg(len) }),
  buyLetters: (cid, { tid, letters }) => join(cid, 'buy_letters', { tid: u64Arg(tid), letters: lettersArg(letters) }),
  /** buy_missing is always 1: the letters a guess lacks are bought with it. */
  submitGuess: (cid, { tid, idx, attempt, guess }) => join(cid, 'submit_guess', { tid: u64Arg(tid), idx: u32Arg(idx), attempt: attemptArg(attempt), guess: lettersArg(guess, { min: 4, max: 6 }), buy_missing: '1' }),
  claimTimeout: (cid, { tid, idx }) => join(cid, 'claim_timeout', { tid: u64Arg(tid), idx: u32Arg(idx) }),
  claimRefund: (cid, { tid, idx }) => join(cid, 'claim_refund', { tid: u64Arg(tid), idx: u32Arg(idx) }),
  finalize: (cid, { tid }) => join(cid, 'finalize', { tid: u64Arg(tid) }),
  claim: (cid, { tid }) => join(cid, 'claim', { tid: u64Arg(tid) }),
});

// ---------------------------------------------------------------- argument bytes (contract.h Method::*)

const pkBytes = (pk) => fromHex(pkArg(pk));

/** The bytes each method's packed struct must hold, built here, compared with the kernel's. */
export const encodeArgs = Object.freeze({
  enterGame: ({ pk, tid, len, evict = NO_EVICT }) => concat(pkBytes(pk), le(tid, 8), le(len, 1), le(evict, 4)),
  buyLetters: ({ pk, tid, letters }) => {
    const counts = new Array(LETTERS).fill(0);
    for (const c of lettersOf(letters)) counts[c]++;
    return concat(pkBytes(pk), le(tid, 8), ...counts.map((n) => le(n, 2)));
  },
  submitGuess: ({ pk, tid, idx, attempt, guess, buyMissing = 1 }) => {
    const l = lettersOf(guess);
    const six = new Uint8Array(6);
    six.set(l);
    return concat(pkBytes(pk), le(tid, 8), le(idx, 4), le(attempt, 1), six, le(buyMissing, 1));
  },
  claimTimeout: ({ tid, idx }) => concat(le(tid, 8), le(idx, 4)),
  finalize: ({ tid }) => le(tid, 8),
  claim: ({ pk, tid }) => concat(pkBytes(pk), le(tid, 8)),
  claimRefund: ({ pk, tid, idx }) => concat(pkBytes(pk), le(tid, 8), le(idx, 4)),
});

// ---------------------------------------------------------------- answers (every action prints one JSON object)

export class FuddleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** what: which part of the answer did not check out, in technical words (kept for logs, never translated). */
function fmt(what) {
  return new FuddleError('unexpected', t('Fuddle answered something this wallet cannot check. Try again; if it keeps happening, report it.'), { detail: what });
}
const asMap = (v, what) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`); // i18n-ignore: technical detail kept for logs
};
const asList = (v, what) => {
  if (Array.isArray(v)) return v;
  throw fmt(`${what}: expected a list`); // i18n-ignore: technical detail kept for logs
};
function big(m, k) {
  const v = m[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= U64_MAX) return BigInt(v);
  throw fmt(`${k}: expected an unsigned 64-bit integer`); // i18n-ignore: technical detail kept for logs
}
function num(m, k, max = Number.MAX_SAFE_INTEGER) {
  const v = big(m, k);
  if (v > BigInt(max)) throw fmt(`${k}: out of range`); // i18n-ignore: technical detail kept for logs
  return Number(v);
}
const u32 = (m, k) => num(m, k, 0xffffffff);
function flag(m, k) {
  const v = num(m, k, 1);
  return v === 1;
}
function pubKey(m, k) {
  if (typeof m[k] === 'string' && KEY_RE.test(m[k])) return m[k];
  throw fmt(`${k}: not a public key`); // i18n-ignore: technical detail kept for logs
}
function oneOf(m, k, set) {
  if (typeof m[k] === 'string' && set.has(m[k])) return m[k];
  throw fmt(`${k}: unknown value`); // i18n-ignore: technical detail kept for logs
}

/** my_key: {"my_pk": key}: this wallet's player key for Fuddle ({cid, 0}, the same in every wallet of this seed). */
export function parseMyKey(out) {
  return pubKey(asMap(out, 'output'), 'my_pk');
}

/** view_state: the contract's parameters and the node's height. */
export function parseState(out) {
  const o = asMap(out, 'output');
  return {
    owner: pubKey(o, 'owner'),
    feeBps: num(o, 'fee_bps', 300),
    paused: flag(o, 'paused'),
    slash: big(o, 'slash'),
    answerFee: big(o, 'answer_fee'),
    tournaments: num(o, 'tournaments'),
    height: num(o, 'height'),
    dicts: asList(o.dicts, 'dicts').map((d) => {
      const m = asMap(d, 'dicts[]');
      if (typeof m.root !== 'string' || !HEX64_RE.test(m.root)) throw fmt('dicts[].root: not 32 bytes'); // i18n-ignore: technical detail kept for logs
      return { len: num(m, 'len', 6), ver: num(m, 'ver', 255), root: m.root, depth: num(m, 'depth', 16), words: u32(m, 'words') };
    }),
  };
}

/** One tournament as AddTournament prints it, with the clocks checked against contract.h. */
export function parseTournament(row) {
  const m = asMap(row, 'tournament');
  const x = {
    tid: num(m, 'tid'),
    creator: pubKey(m, 'creator'),
    answerer: pubKey(m, 'answerer'),
    asset: u32(m, 'asset'),
    entry: big(m, 'entry'),
    letterPrice: big(m, 'letter_price'),
    sponsored: big(m, 'sponsored'),
    answerFee: big(m, 'answer_fee'),
    slash: big(m, 'slash'),
    feeBps: num(m, 'fee_bps', 300),
    creatorBps: num(m, 'creator_bps', 5000),
    maxOpen: num(m, 'max_open', 256),
    lenMask: num(m, 'len_mask', 7),
    startH: num(m, 'start_h'),
    endH: num(m, 'end_h'),
    gameBlocks: u32(m, 'game_blocks'),
    answerBlocks: num(m, 'answer_blocks', ANSWER_BLOCKS_MAX),
    createdH: num(m, 'created_h'),
    firstGuessBlocks: num(m, 'first_guess_blocks'),
    idleBlocks: num(m, 'idle_blocks'),
    minGameBlocks: num(m, 'min_game_blocks'),
    entriesCloseH: num(m, 'entries_close_h'),
    accepted: flag(m, 'accepted'),
    games: u32(m, 'games'),
    openGames: u32(m, 'open_games'),
    endedGames: u32(m, 'ended_games'),
    failedGames: u32(m, 'failed_games'),
    players: u32(m, 'players'),
    totalScore: big(m, 'total_score'),
    grossIn: big(m, 'gross_in'),
    phase: oneOf(m, 'phase', TOURNAMENT_PHASES),
  };
  if (x.answerBlocks < ANSWER_BLOCKS_MIN || !x.lenMask || !x.maxOpen) throw fmt("terms out of the contract's range"); // i18n-ignore: technical detail kept for logs
  if (x.firstGuessBlocks !== firstGuessBlocks(x.answerBlocks)) throw fmt('first_guess_blocks differs from contract.h'); // i18n-ignore: technical detail kept for logs
  if (x.idleBlocks !== IDLE_BLOCKS) throw fmt('idle_blocks differs from contract.h'); // i18n-ignore: technical detail kept for logs
  if (x.minGameBlocks !== minGameBlocks(x.answerBlocks)) throw fmt('min_game_blocks differs from contract.h'); // i18n-ignore: technical detail kept for logs
  if (x.entriesCloseH !== (x.endH > x.minGameBlocks ? x.endH - x.minGameBlocks : 0)) throw fmt('entries_close_h differs from contract.h'); // i18n-ignore: technical detail kept for logs
  if (x.openGames !== x.games - x.endedGames) throw fmt('open_games does not add up'); // i18n-ignore: technical detail kept for logs
  if (x.phase === 'finalised') {
    x.pool = big(m, 'pool');
    x.creatorDue = big(m, 'creator_due');
    x.creatorPaid = flag(m, 'creator_paid');
    x.paidOut = big(m, 'paid_out');
  } else {
    x.poolEstimate = big(m, 'pool_estimate');
  }
  return x;
}

/** view_tournaments: {"tournaments": [...]}. */
export function parseTournaments(out) {
  return asList(asMap(out, 'output').tournaments, 'tournaments').map(parseTournament);
}

/** view_tournament: {"tournament": {...}}. */
export function parseTournamentView(out) {
  return parseTournament(asMap(out, 'output').tournament);
}

/** view_my_tournament: {"me": {...}}: this wallet's letters, score, money in and refunds owed, and its payout once settled. */
export function parseMyTournament(out) {
  const m = asMap(asMap(out, 'output').me, 'me');
  const letters = asList(m.letters, 'letters');
  if (letters.length !== LETTERS) throw fmt('letters: expected 26 counts'); // i18n-ignore: technical detail kept for logs
  const me = {
    tid: num(m, 'tid'),
    joined: flag(m, 'joined'),
    letters: letters.map((v) => num({ letter: v }, 'letter', 0xffff)),
    score: big(m, 'score'),
    games: u32(m, 'games'),
    failedGames: u32(m, 'failed_games'),
    paidIn: big(m, 'paid_in'),
    refundAsset: big(m, 'refund_asset'),
    refundBeam: big(m, 'refund_beam'),
    refundAssetPaid: big(m, 'refund_asset_paid'),
    refundBeamPaid: big(m, 'refund_beam_paid'),
    claimed: flag(m, 'claimed'),
    openGames: u32(m, 'open_games'),
  };
  if (me.refundAssetPaid > me.refundAsset || me.refundBeamPaid > me.refundBeam) throw fmt('refunds paid exceed refunds owed'); // i18n-ignore: technical detail kept for logs
  if ('prize' in m) {
    me.prize = big(m, 'prize');
    me.payoutAsset = big(m, 'payout_asset');
    me.payoutBeam = big(m, 'payout_beam');
    me.claimable = flag(m, 'claimable');
  } else if ('prize_estimate' in m) me.prizeEstimate = big(m, 'prize_estimate');
  return me;
}

/** A game as AddGameShort prints it (view_my_games rows, and the head of view_game). */
function parseGameShort(m) {
  const g = {
    idx: u32(m, 'idx'),
    player: pubKey(m, 'player'),
    len: num(m, 'len', 6),
    status: num(m, 'status', 3),
    verdict: num(m, 'verdict', 5),
    attempts: num(m, 'attempts', MAX_ATTEMPTS),
    solvedAt: num(m, 'solved_at', MAX_ATTEMPTS),
    deadlineH: num(m, 'deadline_h'),
    refunded: flag(m, 'refunded'),
  };
  if (!WORD_LENGTHS.includes(g.len)) throw fmt('len: not 4, 5 or 6'); // i18n-ignore: technical detail kept for logs
  return g;
}

/** view_my_games: {"games": [...]}: this wallet's games in one tournament. */
export function parseMyGames(out) {
  return asList(asMap(out, 'output').games, 'games').map((r) => parseGameShort(asMap(r, 'games[]')));
}

/** view_game: {"game": {...}}: the game, every guess with its hint, and where its clock stands. */
export function parseGame(out) {
  const m = asMap(asMap(out, 'output').game, 'game');
  const g = {
    tid: num(m, 'tid'),
    ...parseGameShort(m),
    answerer: pubKey(m, 'answerer'),
    batchId: big(m, 'batch_id'),
    leafIndex: num(m, 'leaf_index', 255),
    asset: u32(m, 'asset'),
    letterPrice: big(m, 'letter_price'),
    answerBlocks: num(m, 'answer_blocks', ANSWER_BLOCKS_MAX),
    inlineIn: big(m, 'inline_in'),
    phase: oneOf(m, 'phase', GAME_PHASES),
  };
  g.guesses = asList(m.guesses, 'guesses').map((r, i) => {
    const x = asMap(r, 'guesses[]');
    const letters = x.letters;
    if (typeof letters !== 'string' || letters.length !== g.len || !/^[a-z]+$/.test(letters)) throw fmt("guesses[].letters: not the word's length in a..z"); // i18n-ignore: technical detail kept for logs
    const answered = flag(x, 'answered');
    const guess = { attempt: num(x, 'attempt', MAX_ATTEMPTS - 1), letters, answered, guessedH: num(x, 'guessed_h'), answeredH: num(x, 'answered_h') };
    if (guess.attempt !== i) throw fmt('guesses[]: out of order'); // i18n-ignore: technical detail kept for logs
    if (answered) {
      if (typeof x.feedback !== 'string' || !new RegExp(`^[012]{${g.len}}$`).test(x.feedback)) throw fmt('guesses[].feedback: not one digit 0..2 per letter'); // i18n-ignore: technical detail kept for logs
      guess.feedback = x.feedback;
    }
    return guess;
  });
  if (g.guesses.length !== g.attempts) throw fmt('guesses: not one per attempt'); // i18n-ignore: technical detail kept for logs
  const opt = (k, key) => {
    if (key in m) g[k] = num(m, key);
  };
  opt('hintDueH', 'hint_due_h');
  opt('timeoutFromH', 'timeout_from_h');
  opt('nextAttempt', 'next_attempt');
  opt('guessDueH', 'guess_due_h');
  opt('revealDueH', 'reveal_due_h');
  if ('solved' in m) g.solved = flag(m, 'solved');
  // A phase the shader prints only with its clock: the screens read the clock from it.
  const needs = { your_move: ['nextAttempt', 'guessDueH'], waiting_hint: ['hintDueH'], hint_overdue: ['hintDueH', 'timeoutFromH'], unplayed_ended: ['timeoutFromH'], waiting_reveal: ['revealDueH'], reveal_overdue: ['revealDueH', 'timeoutFromH'] };
  for (const k of needs[g.phase] || []) if (g[k] === undefined) throw fmt(`${g.phase} without its clock`); // i18n-ignore: technical detail kept for logs
  if (g.phase === 'your_move' && g.nextAttempt !== g.attempts) throw fmt('next_attempt differs from attempts'); // i18n-ignore: technical detail kept for logs
  return g;
}

/** view_claimable: {"claimable": [{tid, asset, prize, payout_asset, payout_beam}]}: finalised tournaments with something left to collect. */
export function parseClaimable(out) {
  return asList(asMap(out, 'output').claimable, 'claimable').map((r) => {
    const m = asMap(r, 'claimable[]');
    return { tid: num(m, 'tid'), asset: u32(m, 'asset'), prize: big(m, 'prize'), payoutAsset: big(m, 'payout_asset'), payoutBeam: big(m, 'payout_beam') };
  });
}

/** view_answerer: the answer service's record: its bond and how many games it served honestly or failed. */
export function parseAnswerer(out) {
  const m = asMap(out, 'output');
  return {
    pk: pubKey(m, 'pk'),
    enabled: flag(m, 'enabled'),
    bond: big(m, 'bond'),
    reserved: big(m, 'reserved'),
    freeBond: big(m, 'free_bond'),
    earned: big(m, 'earned'),
    openGames: u32(m, 'open_games'),
    honestGames: u32(m, 'honest_games'),
    failedGames: u32(m, 'failed_games'),
  };
}

// ---------------------------------------------------------------- money

/** asset -> net amount (positive = paid by this wallet), `assetAmount` of `asset` plus `beam` BEAM, merged when the asset is BEAM. */
export function fundsOf(asset, assetAmount, beam, sign = 1n) {
  const m = new Map();
  const add = (k, v) => {
    const x = BigInt(v);
    if (x) m.set(k, (m.get(k) || 0n) + sign * x);
  };
  add(asset, assetAmount);
  add(0, beam);
  return m;
}

/** What entering costs: the entry (tournament asset), the answering fee (BEAM) and the network fee (BEAM). */
export function entryCost(tour, { evict = false } = {}) {
  const fee = evict ? FEES.enterGameEvict : FEES.enterGame;
  return { asset: tour.asset, entry: tour.entry, answerFee: tour.answerFee, fee, funds: fundsOf(tour.asset, tour.entry, tour.answerFee, 1n), beamTotal: (tour.asset === 0 ? tour.entry : 0n) + tour.answerFee + fee };
}

/** What a guess costs: the letters it must buy (letter price each, tournament asset) and the network fee. */
export function guessCost(letterPrice, missing) {
  const letters = BigInt(letterPrice) * BigInt(missing);
  return { missing, letters, fee: FEES.submitGuess };
}

/**
 * What ClaimRefund pays for a game that failed or ended unplayed (app.cpp On_user_claim_refund):
 * the entry plus the letters used (letter price x attempts x length) in the tournament's asset, and
 * the answering fee plus, for a failed game, the slash in BEAM.
 */
export function refundOf(tour, game) {
  const failed = game.status === GAME.failed;
  const asset = tour.entry + BigInt(game.letterPrice) * BigInt(game.attempts * game.len);
  const beam = tour.answerFee + (failed ? tour.slash : 0n);
  return { asset: tour.asset, assetAmount: asset, beam, slash: failed ? tour.slash : 0n, letters: BigInt(game.letterPrice) * BigInt(game.attempts * game.len), funds: fundsOf(tour.asset, asset, beam, -1n) };
}

/**
 * What Claim pays once a tournament is finalised (app.cpp ComputePayout), computed here from the
 * tournament's pool and total score and this wallet's record: the prize (pool x score / total
 * score, floored; when nobody scored, what was paid in less the refunds owed), plus the refunds not
 * taken yet.
 */
export function payoutOf(tour, me) {
  if (tour.phase !== 'finalised') throw new RangeError('a payout is known once the tournament is finalised'); // i18n-ignore: internal invariant, never shown
  const prize = tour.totalScore ? mulDiv(tour.pool, me.score, tour.totalScore) : me.paidIn - me.refundAsset;
  const refundAsset = me.refundAsset - me.refundAssetPaid;
  const refundBeam = me.refundBeam - me.refundBeamPaid;
  const assetAmount = prize + refundAsset;
  return { asset: tour.asset, prize, refundAsset, refundBeam, assetAmount, beam: refundBeam, funds: fundsOf(tour.asset, assetAmount, refundBeam, -1n), nothing: assetAmount === 0n && refundBeam === 0n };
}

/** The share of the fee and the creator's cut, as percentages for the words ("1%", "0.5%"). */
export function percentText(bps) {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

// ---------------------------------------------------------------- time, in words

/** About how long `blocks` is (one block is about a minute): "about 40 minutes", "about an hour", "about 7 hours", "about 2 days". */
export function blocksText(blocks) {
  const n = Math.max(0, Math.round(Number(blocks) || 0));
  if (n <= 1) return t('about a minute');
  if (n < 60) return tn({ one: 'about {n} minute', other: 'about {n} minutes' }, n);
  if (n < 90) return t('about an hour');
  if (n < 1440) {
    const h = Math.round(n / 60);
    return tn({ one: 'about {n} hour', other: 'about {n} hours' }, h);
  }
  const d = Math.round(n / 1440);
  return tn({ one: 'about {n} day', other: 'about {n} days' }, d);
}

/**
 * What a player is told before entering (v9 README, "What a player is told before entering"), from
 * the tournament's own figures. Each item is one whole sentence: { id, text }.
 * slashText / priceText: the amounts as the screen writes them ("0.5 BEAM", "0.01 BEAM").
 */
export function rulesBeforeEntering(tour, { slashText, priceText }) {
  const out = [
    { id: 'length', text: t('A game takes about 15–20 minutes: six guesses, and each hint arrives about a minute after you guess.') },
    { id: 'idle', text: t("After each hint you have {time} to make your next guess. If you don't, the game ends unsolved and your entry stays in the prize pool.", { time: blocksText(tour.idleBlocks) }) },
    { id: 'firstGuess', text: t("If you don't make your first guess within {time}, the game ends and your entry and answering fee come back to you.", { time: blocksText(tour.firstGuessBlocks) }) },
    { id: 'entriesClose', text: t('Entries close {time} before the tournament ends, so every game has time for all six guesses.', { time: blocksText(tour.minGameBlocks) }) },
    { id: 'letters', text: t('Each letter you guess costs {price}, paid with the guess.', { price: priceText }) },
    { id: 'lettersAhead', text: t("Letters bought ahead stay in this tournament. If its answer service stops taking new games you can't start another game to use them, and letters left when the tournament ends are not given back.") },
    { id: 'fee', text: tour.creatorBps ? t("When the tournament ends, {fee} of what was paid in goes to Fuddle as its fee and {cut} to the tournament's creator; the rest is the prize pool, shared by score.", { fee: percentText(tour.feeBps), cut: percentText(tour.creatorBps) }) : t('When the tournament ends, {fee} of what was paid in goes to Fuddle as its fee; the rest is the prize pool, shared by score.', { fee: percentText(tour.feeBps) }) },
    { id: 'nobody', text: t('If nobody scores, everyone gets back what they paid in, with no fee.') },
    { id: 'trust', text: t('The answer service picked the words, but each one was fixed on chain before anyone played, and every hint is checked when the word is revealed.') },
    { id: 'compensation', text: t('If the service gives a wrong hint, misses its time or never reveals the word, you get back your entry, the letters of that game and the answering fee, plus {slash} from its bond.', { slash: slashText }) },
  ];
  return out;
}

/**
 * Where a game's clock stands at `height`, for the play screen: what the player waits for or must
 * do, and how many blocks are left. kind:
 *   firstGuess   make the first guess by dueH, else the game ends and the entry comes back
 *   nextGuess    make the next guess by dueH, else the game ends unsolved
 *   hint         the service owes a hint by dueH; after it the game can be ended and refunded
 *   hintLate     the service missed the hint: end the game and take the refund
 *   reveal       the game is over; the service reveals the word by dueH
 *   revealLate   the service missed the reveal: end the game and take the refund
 *   unplayed     no first guess in time: end the game to take the entry back
 *   over         nothing is due (revealed, failed or ended)
 */
export function gameClock(g, height) {
  const left = (due) => Math.max(0, due - height);
  switch (g.phase) {
    case 'your_move':
      return { kind: g.attempts ? 'nextGuess' : 'firstGuess', dueH: g.guessDueH, blocksLeft: left(g.guessDueH) };
    case 'waiting_hint':
      return { kind: 'hint', dueH: g.hintDueH, blocksLeft: left(g.hintDueH) };
    case 'hint_overdue':
      return { kind: 'hintLate', dueH: g.hintDueH, blocksLeft: 0, fromH: g.timeoutFromH };
    case 'waiting_reveal':
      return { kind: 'reveal', dueH: g.revealDueH, blocksLeft: left(g.revealDueH) };
    case 'reveal_overdue':
      return { kind: 'revealLate', dueH: g.revealDueH, blocksLeft: 0, fromH: g.timeoutFromH };
    case 'unplayed_ended':
      return { kind: 'unplayed', dueH: null, blocksLeft: 0, fromH: g.timeoutFromH };
    default:
      return { kind: 'over', dueH: null, blocksLeft: 0 };
  }
}

/** The clock in one sentence for the play screen. */
export function clockText(clock) {
  const time = blocksText(clock.blocksLeft);
  switch (clock.kind) {
    case 'firstGuess':
      return t('Make your first guess within {time}, or the game ends and your entry comes back.', { time });
    case 'nextGuess':
      return t('Make your next guess within {time}, or the game ends unsolved and your entry stays in the pool.', { time });
    case 'hint':
      return t('The answer service is checking your guess. The hint usually lands within a minute or two; it must land within {time}.', { time });
    case 'hintLate':
      return t('The answer service missed its time to answer. You can end this game and take back your entry, letters and answering fee, plus its compensation.');
    case 'reveal':
      return t('This game is over. The answer service shows the word on chain within {time}, so every hint can be checked.', { time });
    case 'revealLate':
      return t('The answer service did not show the word in time. You can end this game and take back your entry, letters and answering fee, plus its compensation.');
    case 'unplayed':
      return t('No first guess was made in time. End the game to take back your entry and answering fee.');
    default:
      return '';
  }
}

/**
 * How a game turned out, for the play screen and the list of games. outcome:
 *   playing      the player's move, or a hint on its way (not over)
 *   checking     over, the word not revealed yet (solved or not: solved says which)
 *   solved       revealed: solved at solvedAt guesses, score
 *   unsolved     revealed after six guesses
 *   stopped      revealed after fewer guesses: the player made no guess in time
 *   failed       the service failed it (verdict lied, silent or unrevealed): refund + compensation
 *   unplayed     no first guess: entry and answering fee back
 *   late         the service is late (hint or reveal): the game can be ended now
 *   abandoned    no first guess in time, not closed yet: it can be ended now
 * refundable: ClaimRefund may be asked now; endable: ClaimTimeout may be asked now.
 */
export function gameOutcome(g, { claimed = false } = {}) {
  const base = { refundable: false, endable: false, score: 0 };
  if (g.status === GAME.revealed) {
    if (g.solvedAt) return { ...base, outcome: 'solved', score: scoreOf(g.len, g.solvedAt) };
    return { ...base, outcome: g.attempts >= MAX_ATTEMPTS ? 'unsolved' : 'stopped' };
  }
  if (g.status === GAME.failed) return { ...base, outcome: 'failed', verdict: g.verdict, refundable: !g.refunded && !claimed };
  if (g.status === GAME.ended) return { ...base, outcome: 'unplayed', refundable: !g.refunded && !claimed };
  // still playing (status 0): the phase says where its clock stands
  if (g.phase === 'hint_overdue' || g.phase === 'reveal_overdue') return { ...base, outcome: 'late', endable: true };
  if (g.phase === 'unplayed_ended') return { ...base, outcome: 'abandoned', endable: true };
  if (g.phase === 'waiting_reveal') return { ...base, outcome: 'checking', solved: g.solved === true };
  return { ...base, outcome: 'playing' };
}

/** Why the service failed a game, in words (verdict 2, 3, 4). */
export function failedReason(verdict) {
  if (verdict === VERDICT.lied) return t('A hint was wrong: the revealed word does not give it.');
  if (verdict === VERDICT.silent) return t('The answer service did not answer a guess in time.');
  if (verdict === VERDICT.unrevealed) return t('The answer service did not reveal the word in time.');
  return t('The answer service failed this game.');
}

// ---------------------------------------------------------------- the shader's refusals

/** The app shader's error texts (app.cpp) -> a code a screen can act on. */
export function shaderCodeFor(text) {
  const said = String(text || '');
  const table = {
    'tournament not found': 'tournamentNotFound',
    'game not found': 'gameNotFound',
    'contract not found': 'contractNotFound',
    'its answer service has not accepted this tournament yet': 'notAccepted',
    'its answer service is not taking new games; games in play go on': 'serviceStopped',
    'its answer service is not taking new games; letters cannot be bought ahead': 'serviceStopped',
    'you have the most open games allowed in this tournament; finish one first': 'tooManyOpen',
    'every slot of this tournament is in play; try again shortly': 'full',
    'not your game': 'notYourGame',
    'not enough letters; set buy_missing=1 to buy them with this guess': 'notEnoughLetters',
    'tournament not finalised': 'notFinalised',
    'you did not play this tournament': 'notPlayed',
    'already claimed': 'alreadyClaimed',
    'only a failed game or one that ended unplayed is refunded': 'notRefundable',
    'already refunded': 'alreadyRefunded',
    'already paid by claim': 'alreadyClaimed',
  };
  if (table[said]) return table[said];
  if (said.startsWith('missing or invalid argument')) return 'badArgument';
  return 'shaderError';
}

// Translated where an error is made: t(MESSAGES[code]).
const MESSAGES = {
  tournamentNotFound: tk('This tournament is not on the network. Go back and pick another one.'),
  gameNotFound: tk('This game is not on the network yet. If you just entered, wait a minute and look again.'),
  contractNotFound: tk('Fuddle could not be read from the network. Check your connection and try again.'),
  notAccepted: tk("This tournament's answer service has not agreed to run it yet, so nobody can enter. Pick another tournament."),
  serviceStopped: tk("This tournament's answer service is not taking new games. Games already in play go on to their end."),
  tooManyOpen: tk('You already have 4 games open in this tournament, the most allowed. Finish one, then enter again.'),
  full: tk('Every place in this tournament is in play right now. Try again in a few minutes, when a game ends.'),
  notYourGame: tk('This game was entered from another wallet.'),
  notEnoughLetters: tk('This guess needs letters you do not have. Try again: the wallet buys them with the guess.'),
  notFinalised: tk('This tournament is not settled yet, so there is nothing to collect. It is settled once every game has ended.'),
  notPlayed: tk('This wallet did not play in this tournament.'),
  alreadyClaimed: tk('This was already collected.'),
  notRefundable: tk('This game is not refunded: it was played to its end.'),
  alreadyRefunded: tk('This refund was already taken.'),
  badArgument: tk('Fuddle could not do that. Try again; if it keeps happening, report it.'),
};

/** A refusal or failure in plain words; FuddleErrors pass through. */
export function mapFuddleError(e) {
  if (e instanceof FuddleError) return e;
  if (e instanceof InvokeDataError) return new FuddleError('unexpected', t('Fuddle built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.'), { detail: e.message, nothingSent: true });
  if (e && e.code === 'shader') {
    const code = shaderCodeFor(e.message);
    return new FuddleError(code, MESSAGES[code] ? t(MESSAGES[code]) : t('Fuddle could not do that ({reason}). Try again; if it keeps happening, report it.', { reason: e.message }), { shaderText: e.message });
  }
  return e;
}

// ---------------------------------------------------------------- the built transaction

/** Throws: the built transaction is not the one asked for, so it is never sent. what: the detail, kept in English for logs. */
export function builtWrong(what) {
  throw new FuddleError('unexpected', t('Fuddle built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.'), { detail: what, nothingSent: true });
}

/**
 * Decodes a built transaction and checks it is exactly one call of `method` on `cid`, with the
 * declared `charge`, its kernel `comment`, `signatures` signing keys, argument bytes equal to
 * `args` (Uint8Array), the funds `funds` (asset -> net, positive = paid) and nothing else, and the
 * network fee the charge sets. Stored app arguments, when the engine keeps them, must be `shaderArgs`.
 */
export function checkBuilt(raw, { cid, method, charge, comment, signatures, args, funds, shaderArgs }) {
  let d;
  try {
    d = readContractTx(raw);
  } catch (e) {
    builtWrong(`cannot read the prepared transaction: ${e.message}`); // i18n-ignore: builtWrong() detail for logs, never shown
  }
  if (d.entries.length !== 1) builtWrong('expected one contract call'); // i18n-ignore: builtWrong() detail for logs, never shown
  const e = d.entries[0];
  if (e.contractId !== cid) builtWrong(`the call targets ${e.contractId}, not Fuddle`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (e.method !== method) builtWrong(`contract method ${e.method}, not ${method}`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (e.isDependent || e.isAdvanced) builtWrong('a dependent or advanced call'); // i18n-ignore: builtWrong() detail for logs, never shown
  if (e.charge !== charge) builtWrong(`BVM charge ${e.charge}, expected ${charge}`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (e.comment !== comment) builtWrong(`kernel comment "${e.comment}"`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (e.signatureCount !== signatures) builtWrong(`${e.signatureCount} signing keys, expected ${signatures}`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (!bytesEqual(e.args, args)) builtWrong(`the arguments differ from the request: ${toHex(e.args)}`); // i18n-ignore: builtWrong() detail for logs, never shown
  if (d.spendMax) builtWrong('a stored spending ceiling'); // i18n-ignore: builtWrong() detail for logs, never shown
  if (d.appArgs) {
    for (const kv of String(shaderArgs || '').split(',')) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      if (!Object.prototype.hasOwnProperty.call(d.appArgs, k) || d.appArgs[k] !== kv.slice(i + 1)) builtWrong('stored shader args differ from the request'); // i18n-ignore: builtWrong() detail for logs, never shown
    }
  }
  const s = d.spend;
  const same = s.size === funds.size && [...funds].every(([k, v]) => s.get(k) === v);
  if (!same) builtWrong(`moves ${spendText(s)}, expected exactly ${spendText(funds)}`); // i18n-ignore: builtWrong() detail for logs, never shown
  const fee = feeForCharge(charge);
  if (d.fee !== fee) builtWrong(`a network fee of ${d.fee} groth, expected ${fee}`); // i18n-ignore: builtWrong() detail for logs, never shown
  for (const v of s.values()) if (v > I64_MAX || v < -I64_MAX) builtWrong('an amount beyond 2^63'); // i18n-ignore: builtWrong() detail for logs, never shown
  return d;
}

/** The approve sheet must show what was built and checked, to the groth, or it is refused unseen. */
export function consentMatches(getBuilt) {
  return (req) => {
    const d = getBuilt();
    const bad = { code: 'unexpected', message: t('The wallet built something other than what this screen shows. Nothing was sent.'), nothingSent: true };
    if (!d || req.kind !== 'contract') return bad;
    const same = (list, map) => list.length === map.size && list.every((x) => map.get(x.assetId) === x.amount);
    if (!same(req.spends, d.pays) || !same(req.receives, d.receives)) return bad;
    if (req.fee !== d.fee) return { code: 'unexpected', message: t('The network fee is not the one this screen expected. Nothing was sent.'), nothingSent: true };
    return null;
  };
}

// ---------------------------------------------------------------- the service

/** One Fuddle transaction at a time: a second one while one is being prepared or approved is refused. */
export function fuddleLock() {
  let flow = null;
  return {
    get busy() {
      return Boolean(flow);
    },
    run(fn) {
      if (flow) return Promise.reject(new FuddleError('busy', t('Another Fuddle transaction is in progress. Finish or cancel it first.')));
      const token = {};
      flow = token;
      return (async () => {
        try {
          return await fn();
        } finally {
          if (flow === token) flow = null;
        }
      })();
    },
  };
}

/**
 * Fuddle over one wallet session. Every action takes `words` ({ rows, notes, warn }: what the
 * screen wants the approve sheet to say, screens/consent.js intentExtras); the action name and the
 * figures the sheet's button reads stay this module's.
 *   deps.cid                  the contract id (FUDDLE_CID; tests pass their own)
 *   deps.view(args)           -> the shader's parsed output (App.view)
 *   deps.transact(args, opts) -> txId (App.transact: opts.inspect, opts.expect, opts.intent)
 *   deps.servicePk            the BEAM Campfire answer service's key, or null
 */
export function createFuddle(deps) {
  const cid = deps.cid;
  checkCid(cid);
  const lock = deps.lock || fuddleLock();
  let myKeyP = null;

  async function view(a) {
    try {
      return await deps.view(a);
    } catch (e) {
      throw mapFuddleError(e);
    }
  }

  // deps.transact with this module's inspect: what it throws comes back as thrown (lib/contracts.js
  // would otherwise report every refusal as 'unexpected'); the rest in plain words.
  async function transact(a, opts) {
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
      throw mapFuddleError(thrown || e);
    }
  }

  const svc = {
    cid,
    servicePk: deps.servicePk || null,
    get busy() {
      return lock.busy;
    },

    /** This wallet's Fuddle player key (read once). */
    myKey() {
      if (!myKeyP) {
        myKeyP = view(fuddleArgs.myKey(cid)).then(parseMyKey);
        myKeyP.catch(() => {
          myKeyP = null;
        });
      }
      return myKeyP;
    },
    async state() {
      return parseState(await view(fuddleArgs.viewState(cid)));
    },
    async tournaments({ skip = 0, limit = 100 } = {}) {
      return parseTournaments(await view(fuddleArgs.viewTournaments(cid, { skip, limit })));
    },
    async tournament(tid) {
      return parseTournamentView(await view(fuddleArgs.viewTournament(cid, { tid })));
    },
    async myTournament(tid) {
      return parseMyTournament(await view(fuddleArgs.viewMyTournament(cid, { tid })));
    },
    async game(tid, idx) {
      return parseGame(await view(fuddleArgs.viewGame(cid, { tid, idx })));
    },
    async myGames(tid) {
      return parseMyGames(await view(fuddleArgs.viewMyGames(cid, { tid })));
    },
    async claimable() {
      return parseClaimable(await view(fuddleArgs.viewClaimable(cid)));
    },
    async answerer(pk) {
      return parseAnswerer(await view(fuddleArgs.viewAnswerer(cid, { pk })));
    },

    /**
     * The tournaments a player may look at, newest first: the latest `limit` by id, the ones the answer
     * service accepted. With the height they were read at.
     */
    async browse({ limit = 60 } = {}) {
      const st = await svc.state();
      const skip = Math.max(0, st.tournaments - limit);
      const list = st.tournaments ? await svc.tournaments({ skip, limit }) : [];
      return { state: st, height: st.height, tournaments: list.filter((x) => x.accepted).sort((a, b) => b.tid - a.tid) };
    },

    /**
     * This wallet's games in the tournaments of `list` that are not finalised (a game in play read in
     * full), and what it can collect anywhere (view_claimable): { games: [{ tour, game, outcome }], claims }.
     */
    async mine(list) {
      const games = [];
      for (const tour of list.filter((x) => x.phase !== 'finalised' && x.games > 0)) {
        for (const short of await svc.myGames(tour.tid)) {
          // A game in play is read in full: its phase says whose move it is and what is late.
          const g = short.status === GAME.playing ? await svc.game(tour.tid, short.idx) : { ...short, tid: tour.tid };
          games.push({ tour, game: g, outcome: gameOutcome(g) });
        }
      }
      const claims = await svc.claimable();
      return { games, claims };
    },

    /** Checks before entering, in plain words (the contract would refuse these on landing). */
    entryProblem(tour, { height, me = null, paused = false }) {
      if (paused) return t('Fuddle is paused: no new games for now. Games in play go on.');
      if (!tour.accepted) return t(MESSAGES.notAccepted);
      if (height < tour.startH) return t('This tournament has not started yet. Entries open in {time}.', { time: blocksText(tour.startH - height) });
      // A transaction built now lands in the next block at the earliest.
      if (height + 1 > tour.entriesCloseH) return t('Entries for this tournament are closed. Its games are finishing; pick a newer tournament.');
      if (me && me.openGames >= MAX_OPEN_PER_PLAYER) return t(MESSAGES.tooManyOpen);
      return null;
    },

    /**
     * Enters a game of `len` letters in tournament `tid`. Pays the entry (tournament asset) and the
     * answering fee (BEAM) plus the network fee. When the tournament is full the shader takes the place
     * of a game nobody played (its player gets entry and fee back); the kernel then declares the
     * larger charge, and that game is checked to be one the contract will let it end.
     */
    enter({ tid, len, words = null }) {
      return lock.run(async () => {
        const [pk, tour] = await Promise.all([svc.myKey(), svc.tournament(tid)]);
        if (!lengthsOf(tour.lenMask).includes(len)) throw new FuddleError('badLength', t('This tournament has no {n}-letter games.', { n: len }));
        const a = fuddleArgs.enterGame(cid, { tid, len });
        let built = null;
        let evicted = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleEnter', tid, len, assetId: tour.asset },
          inspect: async (raw) => {
            let evict = NO_EVICT;
            try {
              const e = readContractTx(raw).entries;
              if (e.length === 1 && e[0].args.length === ARGS_SIZE.enterGame) evict = new ArgsReader(e[0].args.subarray(42, 46)).u32();
            } catch {
              /* checked in full below */
            }
            const charge = evict === NO_EVICT ? CHARGE.enterGame : CHARGE.enterGameEvict;
            const d = checkBuilt(raw, { cid, method: METHOD.enterGame, charge, comment: KERNEL.enterGame, signatures: 1, args: encodeArgs.enterGame({ pk, tid, len, evict }), funds: entryCost(tour).funds, shaderArgs: a });
            if (evict !== NO_EVICT) {
              const other = await svc.game(tid, evict).catch(() => null);
              if (!other || other.phase !== 'unplayed_ended') builtWrong(`ends game ${evict}, which is not an abandoned one`); // i18n-ignore: builtWrong() detail for logs, never shown
              evicted = evict;
            }
            built = d;
          },
          expect: consentMatches(() => built),
        });
        return { txId, tour, cost: entryCost(tour, { evict: evicted !== null }), evicted, built };
      });
    },

    /** Buys `letters` (a..z, one per unit) ahead in tournament `tid`. */
    buyLetters({ tid, letters, words = null }) {
      return lock.run(async () => {
        const text = lettersArg(cleanGuess(letters, 256));
        const [pk, tour] = await Promise.all([svc.myKey(), svc.tournament(tid)]);
        const a = fuddleArgs.buyLetters(cid, { tid, letters: text });
        const cost = tour.letterPrice * BigInt(text.length);
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleLetters', tid, count: text.length },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.buyLetters, charge: CHARGE.buyLetters, comment: KERNEL.buyLetters, signatures: 1, args: encodeArgs.buyLetters({ pk, tid, letters: text }), funds: fundsOf(tour.asset, cost, 0n, 1n), shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, count: text.length, cost, built };
      });
    },

    /**
     * Sends guess `word` as game `idx`'s next attempt. The letters missing from this wallet's stock in
     * the tournament are bought with it (buy_missing=1): their count is computed here from the stock,
     * and the transaction must pay exactly that many letters.
     */
    guess({ tid, idx, word, words = null }) {
      return lock.run(async () => {
        const [pk, g, me] = await Promise.all([svc.myKey(), svc.game(tid, idx), svc.myTournament(tid)]);
        if (g.player !== pk) throw new FuddleError('notYourGame', t(MESSAGES.notYourGame));
        if (g.phase !== 'your_move') throw new FuddleError('notYourMove', g.phase === 'waiting_hint' ? t('Your last guess is still waiting for its hint.') : t('This game takes no more guesses.'));
        const guess = cleanGuess(word, g.len);
        if (guess.length !== g.len) throw new FuddleError('badGuess', t('Type a {n}-letter word.', { n: g.len }));
        const attempt = g.attempts;
        const missing = missingLetters(me.letters, guess);
        const cost = guessCost(g.letterPrice, missing);
        const a = fuddleArgs.submitGuess(cid, { tid, idx, attempt, guess });
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleGuess', tid, idx, word: guess.toUpperCase(), missing },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.submitGuess, charge: CHARGE.submitGuess, comment: KERNEL.submitGuess, signatures: 1, args: encodeArgs.submitGuess({ pk, tid, idx, attempt, guess }), funds: fundsOf(g.asset, cost.letters, 0n, 1n), shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, attempt, guess, cost, built };
      });
    },

    /**
     * Ends a game whose clock ran out (ClaimTimeout: anyone may, no key signs): a hint or a reveal the
     * service missed (the game fails and is refunded with compensation), or a game never played (its
     * entry and answering fee come back). Moves no funds; pays the network fee.
     */
    endGame({ tid, idx, words = null }) {
      return lock.run(async () => {
        const g = await svc.game(tid, idx);
        if (!['hint_overdue', 'reveal_overdue', 'unplayed_ended'].includes(g.phase)) throw new FuddleError('notOverdue', t('This game cannot be ended now: nothing in it is overdue.'));
        const a = fuddleArgs.claimTimeout(cid, { tid, idx });
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleEnd', tid, idx },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.claimTimeout, charge: CHARGE.claimTimeout, comment: KERNEL.claimTimeout, signatures: 0, args: encodeArgs.claimTimeout({ tid, idx }), funds: new Map(), shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, built };
      });
    },

    /** Takes the refund of a failed game, or of one that ended unplayed, now (ClaimRefund). */
    refund({ tid, idx, words = null }) {
      return lock.run(async () => {
        const [pk, tour, g, me] = await Promise.all([svc.myKey(), svc.tournament(tid), svc.game(tid, idx), svc.myTournament(tid)]);
        if (g.player !== pk) throw new FuddleError('notYourGame', t(MESSAGES.notYourGame));
        if (g.status !== GAME.failed && g.status !== GAME.ended) throw new FuddleError('notRefundable', t(MESSAGES.notRefundable));
        if (g.refunded) throw new FuddleError('alreadyRefunded', t(MESSAGES.alreadyRefunded));
        if (me.claimed) throw new FuddleError('alreadyClaimed', t(MESSAGES.alreadyClaimed));
        const r = refundOf(tour, g);
        const a = fuddleArgs.claimRefund(cid, { tid, idx });
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleRefund', tid, idx, assetId: tour.asset },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.claimRefund, charge: CHARGE.claimRefund, comment: KERNEL.claimRefund, signatures: 1, args: encodeArgs.claimRefund({ pk, tid, idx }), funds: r.funds, shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, refund: r, built };
      });
    },

    /** Settles a tournament whose games have all ended (Finalize: anyone may, no key signs). */
    settle({ tid, words = null }) {
      return lock.run(async () => {
        const tour = await svc.tournament(tid);
        if (tour.phase !== 'ready_to_finalise') throw new FuddleError('notReady', tour.phase === 'finalised' ? t('This tournament is already settled.') : t('This tournament cannot be settled yet: it has not ended, or a game in it is still open.'));
        const a = fuddleArgs.finalize(cid, { tid });
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleSettle', tid },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.finalize, charge: CHARGE.finalize, comment: KERNEL.finalize, signatures: 0, args: encodeArgs.finalize({ tid }), funds: new Map(), shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, built };
      });
    },

    /**
     * What collecting tournament `tid` pays, computed here (payoutOf) and compared with what the
     * shader prints: { tour, me, payout }. Throws when there is nothing to collect.
     */
    async claimPreview(tid) {
      const [tour, me] = await Promise.all([svc.tournament(tid), svc.myTournament(tid)]);
      if (tour.phase !== 'finalised') throw new FuddleError('notFinalised', t(MESSAGES.notFinalised));
      if (!me.joined) throw new FuddleError('notPlayed', t(MESSAGES.notPlayed));
      if (me.claimed) throw new FuddleError('alreadyClaimed', t(MESSAGES.alreadyClaimed));
      const payout = payoutOf(tour, me);
      if (me.prize !== undefined && (me.prize !== payout.prize || me.payoutAsset !== payout.assetAmount || me.payoutBeam !== payout.beam)) throw fmt(`the shader's payout ${me.payoutAsset}/${me.payoutBeam} differs from ${payout.assetAmount}/${payout.beam}`); // i18n-ignore: technical detail kept for logs
      return { tour, me, payout };
    },

    /** Collects the prize share and the refunds left in a finalised tournament (Claim). */
    claim({ tid, words = null }) {
      return lock.run(async () => {
        const pk = await svc.myKey();
        const { tour, payout } = await svc.claimPreview(tid);
        if (payout.nothing) throw new FuddleError('nothing', t('There is nothing for you to collect in this tournament.'));
        const a = fuddleArgs.claim(cid, { tid });
        let built = null;
        const txId = await transact(a, {
          intent: { ...words, action: 'fuddleClaim', tid, assetId: tour.asset },
          inspect: (raw) => {
            built = checkBuilt(raw, { cid, method: METHOD.claim, charge: CHARGE.claim, comment: KERNEL.claim, signatures: 1, args: encodeArgs.claim({ pk, tid }), funds: payout.funds, shaderArgs: a });
          },
          expect: consentMatches(() => built),
        });
        return { txId, payout, built };
      });
    },
  };
  return svc;
}

// ---------------------------------------------------------------- live wiring

let live = null;

/**
 * Fuddle on the running wallet's own app with its pinned shader, one per wallet session; null while
 * the contract is not deployed (FUDDLE_CID null): the screens then say "Fuddle opens soon".
 */
export function fuddleFor(session, { cid = FUDDLE_CID, servicePk = FUDDLE_SERVICE_PK } = {}) {
  if (!fuddleLive(cid) || !session) return null;
  if (live && live.session === session && live.cid === cid) return live.svc;
  const withApp = () => Promise.all([nativeApp(), loadShader('fuddle')]);
  const svc = createFuddle({
    cid,
    servicePk,
    view: async (a) => {
      const [app, shader] = await withApp();
      return app.view(a, shader, { timeoutMs: 120000 });
    },
    transact: async (a, opts) => {
      const [app, shader] = await withApp();
      return app.transact(a, shader, { ...opts, timeoutMs: 120000 });
    },
  });
  live = { session, cid, svc };
  return svc;
}
