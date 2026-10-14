// What a scanned QR code (or a pasted text) is, and so where it goes (Home's Scan, lib/scan_go.js).
// The same rules as BEAM Campfire's lib/utilities/beam/scan_recognize.dart, checked against the same
// cases (test/beam/scan/scan_vectors.json at the repository root).
//
//   beam         a BEAM address (hex, or base58 as BEAM's newer addresses are), or a "beam:" link,
//                with its amount when the link carries a valid one          -> Send (BEAM)
//   name         a BEAM name, "alice.beam" (or "beam:alice.beam")            -> Send (BEAM), name looked up
//   eth          an Ethereum address, or an EIP-681 "ethereum:" link on Ethereum mainnet (chain 1),
//                with its value in wei when it is a whole number, and the token of a "/transfer" link
//                                                                            -> Send (Ethereum)
//   code         an airdrop code, ABCD-EFGH-JKLM-NPQR                        -> Airdrop codes, Claim
//   unsupported  a link of another chain (chain), another coin (coin), or a web link (link): said, never opened
//   unknown      anything else: shown as text, nothing done with it
//   empty
// Pure. Nothing is looked up or opened here: an address is checked again by the screen it goes to
// (BEAM's own validation, the Ethereum checksum), and a web link is never followed.

import { parseAmount, formatAmount } from './amount.js';

const HEX_ADDR = /^[0-9a-fA-F]{60,72}$/;
const B58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{40,1024}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^([a-z0-9_~-]{3,64})\.beam$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const decode = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

/** A wei amount from EIP-681's number ("1000", "2.014e18"), as a decimal string; null unless whole and positive. */
export function weiOf(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d{1,3}))?$/.exec(String(text || ''));
  if (!m) return null;
  const frac = m[2] || '';
  const exp = Number(m[3] || 0);
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) return null;
  const digits = `${m[1]}${frac.slice(0, exp).padEnd(exp, '0')}`;
  const v = BigInt(digits);
  return v > 0n ? v.toString() : null;
}

function nameOf(s) {
  const m = NAME.exec(s.toLowerCase());
  return m ? m[1] : null;
}

function beamOf(addr, amount = null) {
  const a = addr.replace(/\s+/g, '');
  const name = nameOf(a);
  if (name) return { kind: 'name', name };
  if (!HEX_ADDR.test(a) && !B58_ADDR.test(a)) return { kind: 'unknown' };
  return amount != null ? { kind: 'beam', address: a, amount } : { kind: 'beam', address: a };
}

function ethLink(rest) {
  // ethereum:<target>[@chain][/function]?params (EIP-681)
  const m = /^(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([A-Za-z]+))?(?:\?(.*))?$/.exec(rest);
  if (!m) return { kind: 'unknown' };
  if (m[2] && m[2] !== '1') return { kind: 'unsupported', reason: 'chain' };
  const q = new URLSearchParams(m[4] || '');
  if (m[3]) {
    if (m[3] !== 'transfer') return { kind: 'unknown' };
    const to = q.get('address');
    return to && ETH_ADDR.test(to) ? { kind: 'eth', to, token: m[1] } : { kind: 'unknown' };
  }
  const wei = q.has('value') ? weiOf(q.get('value')) : null;
  return wei ? { kind: 'eth', to: m[1], valueWei: wei } : { kind: 'eth', to: m[1] };
}

/** The scanned text's meaning (see the table above). */
export function recognize(raw) {
  let s = String(raw ?? '').trim();
  const nl = s.search(/[\r\n]/);
  if (nl >= 0) s = s.slice(0, nl).trim();
  if (!s) return { kind: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(s);
  if (scheme && !ETH_ADDR.test(s)) {
    const sch = scheme[1].toLowerCase();
    const rest = scheme[2];
    if (sch === 'beam') {
      const m = /^(?:\/\/)?([^?#]*)(?:\?([^#]*))?/.exec(rest);
      const q = new URLSearchParams(m[2] || '');
      const a = q.get('amount') ?? q.get('tx_amount');
      let amount = null;
      // Plain digits and one dot only: "1,000" or "1,25" is refused, never read as 1 or 1.25 (the app's
      // release audit 1.3.0; a decimal comma could mean either).
      if (a != null && /^[0-9]+(\.[0-9]+)?$/.test(a.trim())) {
        try {
          const g = parseAmount(a.trim());
          if (g > 0n) amount = formatAmount(g, { group: false });
        } catch {
          amount = null;
        }
      }
      return beamOf(decode(m[1]).trim(), amount);
    }
    if (sch === 'ethereum') return ethLink(rest);
    if (sch === 'http' || sch === 'https') return { kind: 'unsupported', reason: 'link' };
    return { kind: 'unsupported', reason: 'coin' };
  }
  if (ETH_ADDR.test(s)) return { kind: 'eth', to: s };
  const name = nameOf(s);
  if (name) return { kind: 'name', name };
  // An airdrop code: 16 symbols of its alphabet, in groups of 4 or not.
  const compact = s.replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length === 16 && [...compact].every((c) => CODE_ALPHABET.includes(c)) && /^[A-Za-z0-9]{4}([\s-]?[A-Za-z0-9]{4}){3}$/.test(s)) return { kind: 'code', code: compact };
  if (/\s/.test(s)) return { kind: 'unknown' };
  return beamOf(s);
}
