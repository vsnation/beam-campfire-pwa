// A batch's airdrop codes as a CSV file: the desktop app's export (AirdropCsv in
// lib/wallets/beam/contracts/airdrop/voucher_code_store.dart), same columns as
// LightWallet: Number,Code,Value,Asset,Status, CRLF line ends.
//
// Codes are bearer keys to locked funds: the file is made only on a tap, in memory,
// and handed to the share sheet or saved as a download (lib/export.js). Nothing here
// logs a code or keeps the file.

export const CSV_HEADER = 'Number,Code,Value,Asset,Status';

/**
 * One RFC 4180 cell, defused against spreadsheet formula injection: a cell that a
 * spreadsheet would run as a formula (= + - @, tab, CR) gets a leading ', and a cell
 * holding " , CR or LF is quoted with its " doubled. Asset names come from untrusted
 * on-chain metadata.
 */
export function csvCell(value) {
  let v = String(value ?? '');
  if (v !== '' && '=+-@\t\r'.includes(v[0])) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replaceAll('"', '""')}"`;
  return v;
}

/**
 * The CSV text of a saved batch (lib/airdrop.js readSavedBatch shape).
 *   formatValue(bigint) -> the amount as people read it ("1,000.5")
 *   assetLabel: the asset as money screens name it ("FOMO", "PEPE #94")
 */
export function airdropCsv(batch, { formatValue, assetLabel }) {
  let out = `${CSV_HEADER}\r\n`;
  batch.codes.forEach((c, i) => {
    out += `${[String(i + 1), c.code, formatValue(BigInt(c.value)), assetLabel, c.status || 'unknown'].map(csvCell).join(',')}\r\n`;
  });
  return out;
}

/** "airdrop-codes-2026-10-11-10.csv": the day the batch was made and how many codes it holds (as the desktop). */
export function csvFileName(batch) {
  const day = /^\d{4}-\d{2}-\d{2}/.test(String(batch.createdAt)) ? String(batch.createdAt).slice(0, 10) : 'batch';
  return `airdrop-codes-${day}-${batch.codes.length}.csv`;
}

/** The CSV as a file for the share sheet or a download. */
export function csvFile(batch, opts) {
  return new File([airdropCsv(batch, opts)], csvFileName(batch), { type: 'text/csv' });
}
