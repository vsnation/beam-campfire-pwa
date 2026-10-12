// What on-chain asset text *looks like*, so a copy of a verified asset is caught
// however it is spelt. A line-for-line port of the desktop app's
// lib/wallets/beam/assets/beam_asset_lookalike.dart: both apps flag the same
// assets (test/unit/asset_parity.test.mjs runs both over every mainnet asset).
//
// Anyone can mint an asset and name it anything. A copy of FOMO rarely spells it
// "FOMO": it uses Cyrillic О and М, Greek capitals, fullwidth or mathematical
// letters, digits for letters (F0M0), accents, an extra letter (wFOMO), a filler
// word (FOMO Token) or Campfire's own id label (Pepe #174). skeleton() reduces
// text to the Latin capitals it reads as, and copiedKey() compares those.

/** Letters of other scripts (and Latin variants NFKD keeps) that read as Latin capitals. */
const LATIN_LOOKALIKES = new Map([
  // Cyrillic capitals.
  [0x0410, 'A'], [0x0412, 'B'], [0x0421, 'C'], [0x0415, 'E'], [0x041d, 'H'],
  [0x0406, 'I'], [0x0408, 'J'], [0x041a, 'K'], [0x041c, 'M'], [0x041e, 'O'],
  [0x0420, 'P'], [0x0405, 'S'], [0x0422, 'T'], [0x0425, 'X'], [0x0423, 'Y'],
  [0x04ae, 'Y'], [0x04ba, 'H'], [0x0500, 'D'], [0x051a, 'Q'], [0x051c, 'W'],
  [0x04c0, 'I'], [0x042c, 'B'], [0x0417, '3'],
  // Cyrillic small letters.
  [0x0430, 'A'], [0x0432, 'B'], [0x0441, 'C'], [0x0435, 'E'], [0x043d, 'H'],
  [0x0456, 'I'], [0x0458, 'J'], [0x043a, 'K'], [0x043c, 'M'], [0x043e, 'O'],
  [0x0440, 'P'], [0x0455, 'S'], [0x0442, 'T'], [0x0445, 'X'], [0x0443, 'Y'],
  [0x04af, 'Y'], [0x04bb, 'H'], [0x0501, 'D'], [0x051b, 'Q'], [0x051d, 'W'],
  [0x04cf, 'I'], [0x044c, 'B'], [0x0437, '3'],
  // Greek capitals.
  [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'],
  [0x0399, 'I'], [0x039a, 'K'], [0x039c, 'M'], [0x039d, 'N'], [0x039f, 'O'],
  [0x03a1, 'P'], [0x03a4, 'T'], [0x03a5, 'Y'], [0x03a7, 'X'], [0x03f9, 'C'],
  [0x037f, 'J'], [0x03dc, 'F'],
  // Greek small letters.
  [0x03b1, 'A'], [0x03b2, 'B'], [0x03b3, 'Y'], [0x03b9, 'I'], [0x03ba, 'K'],
  [0x03bd, 'V'], [0x03bf, 'O'], [0x03c1, 'P'], [0x03c4, 'T'], [0x03c5, 'U'],
  [0x03c7, 'X'], [0x03f2, 'C'], [0x03f3, 'J'], [0x03c9, 'W'], [0x03d0, 'B'],
  [0x03dd, 'F'],
  // Armenian.
  [0x0555, 'O'], [0x0585, 'O'], [0x054d, 'U'], [0x057d, 'U'], [0x053c, 'L'],
  // Cherokee capitals (look like Latin capitals).
  [0x13aa, 'A'], [0x13f4, 'B'], [0x13df, 'C'], [0x13a0, 'D'], [0x13ac, 'E'],
  [0x13c0, 'G'], [0x13bb, 'H'], [0x13ab, 'J'], [0x13e6, 'K'], [0x13de, 'L'],
  [0x13b7, 'M'], [0x13e2, 'P'], [0x13d2, 'R'], [0x13da, 'S'], [0x13a2, 'T'],
  [0x13d9, 'V'], [0x13b3, 'W'], [0x13c3, 'Z'],
  // Latin small capitals and variants.
  [0x1d00, 'A'], [0x0299, 'B'], [0x1d04, 'C'], [0x1d05, 'D'], [0x1d07, 'E'],
  [0xa730, 'F'], [0x0262, 'G'], [0x029c, 'H'], [0x026a, 'I'], [0x1d0a, 'J'],
  [0x1d0b, 'K'], [0x029f, 'L'], [0x1d0d, 'M'], [0x0274, 'N'], [0x1d0f, 'O'],
  [0x1d18, 'P'], [0x0280, 'R'], [0xa731, 'S'], [0x1d1b, 'T'], [0x1d1c, 'U'],
  [0x1d20, 'V'], [0x1d21, 'W'], [0x028f, 'Y'], [0x1d22, 'Z'],
  [0x0131, 'I'], [0x0237, 'J'], [0x0251, 'A'], [0x0261, 'G'], [0x00f8, 'O'],
  [0x00d8, 'O'], [0x0111, 'D'], [0x0110, 'D'], [0x0127, 'H'], [0x0126, 'H'],
  [0x0142, 'L'], [0x0141, 'L'], [0x0167, 'T'], [0x0166, 'T'], [0x0180, 'B'],
  [0x0268, 'I'], [0x0289, 'U'], [0x00df, 'B'], [0x1e9e, 'B'], [0xa7b4, 'B'],
  [0x0192, 'F'],
  [0x00c6, 'AE'], [0x00e6, 'AE'], [0x0152, 'OE'], [0x0153, 'OE'],
  // Strokes that read as I or l.
  [0x007c, 'I'], [0x00a6, 'I'], [0x01c0, 'I'], [0x2223, 'I'],
]);

/** Combining marks NFKD leaves behind (accents, overlays). */
const isMark = (r) => (r >= 0x0300 && r <= 0x036f) || (r >= 0x1ab0 && r <= 0x1aff) || (r >= 0x1dc0 && r <= 0x1dff) || (r >= 0x20d0 && r <= 0x20ff) || (r >= 0xfe20 && r <= 0xfe2f);

/** Mathematical alphanumerics, in case the normaliser leaves any alone. */
function mathAlphanumeric(r) {
  if (r >= 0x1d400 && r <= 0x1d6a3) {
    const i = (r - 0x1d400) % 52;
    return String.fromCharCode(0x41 + (i < 26 ? i : i - 26));
  }
  if (r >= 0x1d7ce && r <= 0x1d7ff) return String.fromCharCode(0x30 + ((r - 0x1d7ce) % 10));
  return null;
}

/** `text` as the Latin capitals and digits it reads as (FОМО -> FOMO, Ｆ.Ｏ.Ｍ.Ｏ -> FOMO). */
export function skeleton(text) {
  let out = '';
  for (const ch of String(text).normalize('NFKD')) {
    const r = ch.codePointAt(0);
    if (isMark(r)) continue;
    if ((r >= 0x30 && r <= 0x39) || (r >= 0x41 && r <= 0x5a)) out += ch;
    else if (r >= 0x61 && r <= 0x7a) out += String.fromCharCode(r - 0x20);
    else if (LATIN_LOOKALIKES.has(r)) out += LATIN_LOOKALIKES.get(r);
    else {
      const m = mathAlphanumeric(r);
      if (m) out += m;
    }
  }
  return out;
}

/** Characters that stand for each other once rendered: digits for letters, l for I, rn for m, vv for w. */
const FOLD = { 0: 'O', 1: 'I', L: 'I', 2: 'Z', 3: 'E', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };

export function canonical(text) {
  const s = skeleton(text).replaceAll('RN', 'M').replaceAll('VV', 'W');
  let out = '';
  for (const c of s) out += FOLD[c] ?? c;
  return out;
}

/** Words that make no difference to what a name claims to be: "FOMO Token", "Official FOMO". */
const FILLER = new Set(['TOKEN', 'TOKENS', 'COIN', 'COINS', 'OFFICIAL', 'REAL', 'NEW', 'ORIGINAL', 'VERIFIED', 'THE', 'ON', 'OF', 'CA', 'ASSET', 'WRAPPED', 'BRIDGED', 'V1', 'V2', 'V3', 'V4', 'V5'].map(canonical));

/** `#174`, `＃174`, `# 174`: Campfire's own way of naming an asset by its number. */
export const ID_LABEL = /[#＃﹟]\s*(\p{Nd}+)/gu;

/** The asset numbers `text` claims with a `#…` label. */
export function claimedIds(text) {
  const ids = [];
  for (const m of String(text).normalize('NFKD').matchAll(ID_LABEL)) {
    // Dart's int.tryParse reads ASCII digits only; other scripts' digits are no id.
    if (/^[0-9]+$/.test(m[1])) ids.push(Number(m[1]));
  }
  return ids;
}

const words = (text) =>
  String(text)
    .normalize('NFKD')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .map(canonical)
    .filter((c) => c !== '');

/** One letter inserted, dropped, or two neighbours swapped; never a substitution. Both 4+ letters. */
function oneEditAway(a, b) {
  if (a === b || a.length < 4 || b.length < 4) return false;
  if (a.length === b.length) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  return long.slice(i + 1) === short.slice(i);
}

/**
 * Which of `known` (key -> {symbol, name}) an asset named `name` with ticker
 * `symbol` copies, or null. In order of confidence: it reads exactly as a known
 * ticker or name once look-alikes are folded (also with filler words dropped);
 * it claims a known asset's number; it is a near miss (contains a known ticker
 * of 3+ letters, a word is a known ticker of 4+, or one edit from one of 4+).
 * Keys come back as numbers.
 */
export function copiedKey(name, symbol, known) {
  const n = name == null ? '' : canonical(name);
  const s = symbol == null ? '' : canonical(symbol);
  const ws = name == null ? [] : words(name);
  const core = ws.filter((w) => !FILLER.has(w)).join('');
  const keys = Object.entries(known).map(([k, v]) => [Number(k), { symbol: canonical(v.symbol), name: canonical(v.name) }]);

  const same = (a, b) => a !== '' && a === b;
  for (const [key, k] of keys) {
    for (const mine of [n, s, core]) if (same(mine, k.symbol) || same(mine, k.name)) return key;
  }

  for (const id of [...claimedIds(name ?? ''), ...claimedIds(symbol ?? '')]) {
    for (const [key] of keys) if (key === id) return key;
  }

  // Near misses: the longest known ticker or name wins ("BEAMX2" copies BEAMX, not BEAM).
  let best = null;
  let bestLength = 0;
  const consider = (key, target, hit) => {
    if (hit && target.length > bestLength) {
      best = key;
      bestLength = target.length;
    }
  };
  for (const [key, k] of keys) {
    for (const target of [k.symbol, k.name]) {
      if (target.length >= 3 && s.length > target.length) consider(key, target, s.includes(target));
      if (target.length >= 4) {
        consider(key, target, ws.includes(target));
        for (const mine of [n, s, core]) consider(key, target, oneEditAway(mine, target));
      }
    }
  }
  return best;
}
