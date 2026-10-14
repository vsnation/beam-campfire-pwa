// Payment history as a CSV file, as BEAM's own wallets write it (issue #51).
//
// The columns and rows are BEAM core's ExportTxHistoryToCsv
// (wallet/client/extensions/export/tx_history_to_csv.cpp), which the Desktop Wallet's "Export
// transactions history" uses: one row per regular or offline / max-privacy payment (tx_type 0 and 7,
// TxType::Simple and PushTransaction), newest first, with the payment proof for each completed payment
// this wallet sent to someone else. Contract calls (swaps, pools, names) are not payments and are not
// in it, as in the Desktop Wallet.
//
// Two differences, both so that the file opens correctly everywhere:
//   - every field is quoted as RFC 4180 says when it needs to be: BEAM writes the comment as it is,
//     so a comma in a comment shifts every later column;
//   - the file starts with a UTF-8 byte order mark, so Excel reads a comment's non-Latin letters.
// Amounts are BEAM's PrintableAmount (no thousands separators); dates "11 Oct 2026 | 12:08" in this
// device's time zone (kTimeStampFormatCsv, "%d %b %Y | %H:%M", local). USD and BTC values come from the
// exchange rates the engine recorded with a payment, empty when it has none (as BEAM leaves them).
// Pure except readAllTxs / readProofs, which ask the engine.
//
// i18n-ignore-file: the CSV file's column names, month names and values stay English, in every language (a data format people import into spreadsheets, as BEAM writes it); the screen around it is translated (screens/activity.js)

import { formatAmount } from './amount.js';
import { canExportProof } from './payments.js';

export const CSV_HEADER = ['Type', 'Date | Time', 'Amount', 'Unit name', 'Amount, USD', 'Amount, BTC', 'Transaction fee, BEAM', 'Status', 'Comment', 'Transaction ID', 'Kernel ID', 'Sending address', "Sending wallet's signature", 'Receiving address', "Receiving wallet's signature", 'Token', 'Payment proof'];

const PAYMENT_TYPES = new Set([0, 7]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A payment, not a contract call, a split's own record or anything else. */
export const isCsvPayment = (tx) => Boolean(tx) && PAYMENT_TYPES.has(Number(tx.tx_type));

/** One field: quoted when it holds a comma, a quote, a line break or leading / trailing space. */
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "11 Oct 2026 | 12:08", in this device's time zone (BEAM's kTimeStampFormatCsv). */
export function csvDate(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} | ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const plain = (groth) => formatAmount(BigInt(groth || 0), { group: false });

/** amount × rate, both in groth units (BEAM's convertAmount), to `places` decimals; '' without a rate. */
export function convertAmount(groth, rate, places) {
  let r;
  try {
    r = BigInt(rate || 0);
  } catch {
    return '';
  }
  if (r <= 0n) return '';
  const scale = 10n ** BigInt(places);
  // groth/1e8 * rate/1e8, rounded half up to `places`.
  const num = BigInt(groth || 0) * r * scale;
  const den = 100000000n * 100000000n;
  const q = (num + den / 2n) / den;
  const whole = q / scale;
  const frac = (q % scale).toString().padStart(places, '0');
  return `${whole}.${frac}`;
}

/**
 * The rate the engine recorded with a payment (tx_list with rates: true) from the payment's own asset
 * to a currency ('usd', 'btc'), in groth units, or 0 (TxDescription::getExchangeRate). The engine
 * writes an asset as its number (BEAM is 0) and a currency by name.
 */
export function rateOf(tx, to) {
  const list = Array.isArray(tx && tx.rates) ? tx.rates : [];
  const asset = Number(tx && tx.asset_id) || 0;
  const r = list.find((x) => x && (Number(x.from) === asset || (asset === 0 && String(x.from).toLowerCase() === 'beam')) && x.from !== '' && x.from !== null && String(x.to).toLowerCase() === to);
  return r ? r.rate : 0;
}

/**
 * The rows, as BEAM writes them. unit(assetId): the asset's unit name ('BEAM' for 0). proofs: Map
 * txId -> proof hex. Returns the whole file as text, with a byte order mark and CRLF line ends.
 */
export function buildCsv(txs, { unit = () => 'BEAM', proofs = new Map() } = {}) {
  const rows = [CSV_HEADER];
  const list = (txs || []).filter(isCsvPayment).sort((a, b) => Number(b.create_time) - Number(a.create_time));
  for (const t of list) {
    const sent = t.income !== true;
    const assetId = Number(t.asset_id) || 0;
    rows.push([
      sent ? 'Send' : 'Receive',
      csvDate(t.create_time),
      plain(t.value),
      unit(assetId),
      convertAmount(t.value, rateOf(t, 'usd'), 2),
      convertAmount(t.value, rateOf(t, 'btc'), 8),
      plain(t.fee),
      t.status_string || '',
      t.comment || '',
      t.txId || '',
      t.kernel && !/^0+$/.test(t.kernel) ? t.kernel : '',
      t.sender || '',
      t.sender_identity || '',
      t.receiver || '',
      t.receiver_identity || '',
      t.token || '',
      proofs.get(t.txId) || '',
    ]);
  }
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** "beam-campfire-payments-2026-10-11.csv" (with the wallet's name when there are several). */
export function csvFileName(now = new Date(), walletName = null) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const w = walletName ? `-${String(walletName).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)}` : '';
  return `beam-campfire-payments${w}-${d}.csv`;
}

/** Every payment the wallet keeps, page by page (tx_list returns at most `count`). */
export async function readAllTxs(session, { pageSize = 500, maxPages = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < maxPages; i++) {
    // rates: the exchange rates BEAM's signed broadcasts gave the wallet when each payment was made.
    const page = await session.call('tx_list', { count: pageSize, skip: i * pageSize, rates: true }, { timeoutMs: 60000 });
    const list = Array.isArray(page) ? page : [];
    for (const t of list) {
      if (t && !seen.has(t.txId)) {
        seen.add(t.txId);
        out.push(t);
      }
    }
    if (list.length < pageSize) break;
  }
  return out;
}

/** Proofs of the completed payments this wallet sent (one engine call each); progress(done, total). */
export async function readProofs(session, txs, exportProof, progress = () => {}) {
  const want = txs.filter((t) => isCsvPayment(t) && canExportProof(t));
  const proofs = new Map();
  let done = 0;
  for (const t of want) {
    try {
      const hex = await exportProof(session, t.txId);
      if (hex) proofs.set(t.txId, hex);
    } catch {
      /* no proof for this one: the cell stays empty, as BEAM leaves it */
    }
    progress(++done, want.length);
  }
  return proofs;
}
