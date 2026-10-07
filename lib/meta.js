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

/** The name and unit to show for an asset id with (maybe) metadata. */
export function assetLabel(assetId, raw) {
  if (Number(assetId) === 0) return { id: 0, name: 'BEAM', unit: 'BEAM', color: '' };
  const m = parseMetadata(raw);
  const unit = m.unit || m.shortName || `Asset ${assetId}`;
  const name = m.name || m.shortName || unit;
  return { id: Number(assetId), name, unit, color: m.color };
}
