// Confidential Asset metadata: "STD:SCH_VER=1;N=Name;SN=Short;UN=UNIT;...".
// Metadata is written by whoever created the asset, so it is untrusted text:
// control characters are stripped, lengths are capped, and it is only ever
// put on screen with textContent. Icon URLs in metadata are never fetched
// (IP privacy: the app talks to this origin and the node, nobody else).
// NTH_RATIO is display text the core never reads; every asset has 8 decimals.

const MAX_FIELD = 64;

function clean(v, max = MAX_FIELD) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function parseMetadata(raw) {
  const out = { standard: false, name: '', shortName: '', unit: '', nthUnit: '', shortDesc: '', color: '' };
  if (typeof raw !== 'string' || raw === '') return out;
  let body = raw;
  if (body.startsWith('STD:')) {
    out.standard = true;
    body = body.slice(4);
  }
  const fields = {};
  for (const part of body.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in fields)) fields[k] = part.slice(i + 1);
  }
  out.name = clean(fields.N);
  out.shortName = clean(fields.SN);
  out.unit = clean(fields.UN, 16);
  out.nthUnit = clean(fields.NTHUN, 16);
  out.shortDesc = clean(fields.OPT_SHORT_DESC, 128);
  const c = (fields.OPT_COLOR || '').trim();
  out.color = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '';
  return out;
}

/**
 * Assets the desktop app shows as known, names checked against their on-chain
 * metadata (lib/wallets/beam/assets/beam_asset_catalog.dart). Anyone can create
 * an asset called "FOMO"; only these ids get these names without a number.
 */
export const VERIFIED = Object.freeze({
  0: { name: 'BEAM', unit: 'BEAM', color: '#25c2a0' },
  4: { name: 'Gothic Crown', unit: 'CROWN', color: '#ffd700' },
  6: { name: 'Rangers Fan Token', unit: 'RFC', color: '#0066cc' },
  7: { name: 'BeamX', unit: 'BEAMX', color: '#da70d6' },
  9: { name: 'Tico', unit: 'TICO', color: '#e91e63' },
  36: { name: 'Wrapped ETH', unit: 'bETH', color: '#627eea' },
  37: { name: 'Wrapped USDT', unit: 'bUSDT', color: '#26a17b' },
  38: { name: 'Wrapped WBTC', unit: 'bWBTC', color: '#f09242' },
  39: { name: 'Wrapped DAI', unit: 'bDAI', color: '#f5ac37' },
  47: { name: 'Nephrite', unit: 'NPH', color: '#3498db' },
  174: { name: 'FOMO', unit: 'FOMO', color: '#60a5fa' },
  186: { name: 'Giga', unit: 'GIGA', color: '#a855f7' },
  187: { name: 'Chad', unit: 'CHAD', color: '#25c2a0' },
  190: { name: 'Chad', unit: 'CHAD', color: '#25c2a0' },
  191: { name: 'GigaChad', unit: 'GIGA', color: '#a855f7' },
});

// The desktop wallet's generic asset colours, picked by id. An unverified
// asset's own OPT_COLOR is never used: its creator could pick a verified one's.
const GENERIC = ['#72fdff', '#2acf1d', '#ffbb54', '#d885ff', '#008eff', '#ff746b', '#91e300', '#ffe75a', '#9643ff', '#395bff', '#ff3b3b', '#73ff7c', '#ffa86c', '#ff3abe', '#00aee1', '#ff5200', '#6464ff', '#ff7a21', '#63afff', '#c81f68'];

/** The name and unit to show for an asset id with (maybe) metadata. */
export function assetLabel(assetId, raw) {
  const id = Number(assetId);
  const known = VERIFIED[id];
  if (known) return { id, name: known.name, unit: known.unit, color: known.color, verified: true };
  const m = parseMetadata(raw);
  const unit = m.unit || m.shortName || `Asset #${id}`;
  const name = m.name || m.shortName || unit;
  return { id, name, unit, color: GENERIC[id % GENERIC.length], verified: false };
}

/** Up to two letters for an asset's round badge ("FO", "bE", "#9"). */
export function badgeText(label) {
  const u = String(label.unit || '');
  if (u.startsWith('Asset #')) return label.id < 100 ? `#${label.id}` : 'CA'; // never a cut-off number
  const letters = [...u.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('');
  return letters || `#${label.id}`;
}
