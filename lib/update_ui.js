// "Check for updates" and "Update from another address", as sheets: what is
// being asked right now, then the answer in plain words. Used by Settings.
// The rules live in the loader (sw.js) and lib/update_sources.js; this file
// only shows them.
import { h } from './dom.js';
import { openSheet, notice, toast, progressBar, focusSoon } from './ui.js';
import { copyAt, refusalText, staleRelease, releaseDate } from './update.js';
import { normalizeSource } from './update_sources.js';

const tid = (id) => ({ 'data-testid': id });

/**
 * Under the progress while a check runs (issue #77): where it looks, and that a copy's files pass the
 * same signature check as this app's own address. A check asks every place on purpose: an address
 * that stops publishing, or keeps serving an old release, cannot hide a newer signed one.
 */
export const CHECKING_NOTE =
  "BEAM Campfire asks its own address and the public copies, and keeps the newest release. Whichever copy it comes from, every file is checked against BEAM Campfire's signature before it is kept. Your app keeps working meanwhile.";

/** "this app's address" or "a copy at <host>". */
const placeOf = (p) => copyAt(p) || "this app's address";

/** The line under the title while the check runs. */
export function progressText(p) {
  if (!p) return 'Starting…';
  if (p.step === 'downloading') return `Downloading ${p.version} from ${placeOf(p)}${p.total ? `: ${p.done} of ${p.total} files checked` : '…'}`;
  if (p.step === 'asking') {
    if (p.total === 1) return "Asking this app's address…";
    return p.answered ? `Looking for the newest version: ${p.answered} of ${p.total} places checked` : `Looking for the newest version in ${p.total} places…`;
  }
  return p.own ? "Asking this app's address…" : `Asking ${placeOf(p)}…`;
}

/** "Asked: this app's address, raw.githubusercontent.com and cdn.jsdelivr.net." */
export function triedText(tried) {
  const names = (tried || []).map((t) => (t.own ? "this app's address" : t.host));
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Asked: ${list}.`;
}

/**
 * Runs a check with a live sheet and turns that sheet into the answer.
 * Returns the loader's result.
 */
export async function runUpdateCheck(app, { onDone = null } = {}) {
  let progress = null;
  let result = null;
  const sheet = openSheet((close) => (result ? answer(app, result, close) : checking(progress, close)), { label: 'Check for updates' });
  const r = await app.updates.check({
    onProgress: (p) => {
      progress = p;
      if (!sheet.closed) sheet.rerender();
    },
  });
  // "Delete this download" only where the running loader can do it (an older one cannot).
  if (r.result === 'ready') r.canDiscard = await app.updates.canDiscard();
  result = r;
  if (onDone) onDone(r);
  if (r.result === 'none' && !staleRelease(r.newest && r.newest.created)) {
    sheet.close();
    toast(r.from && !r.from.own ? `You have the latest version (checked at ${placeOf(r.from)}).` : 'You have the latest version.', 4000);
  } else if (!sheet.closed) sheet.rerender();
  else if (r.result === 'ready') toast(`Version ${r.version} is ready: open Settings → Check for updates to install it.`, 5000);
  else if (r.result === 'none') toast(`No newer version found; the newest release is from ${staleRelease(r.newest.created).date}.`, 5000);
  return r;
}

function checking(p, close) {
  return [
    h('h2', { text: 'Checking for updates' }),
    h('p', { class: 'lead', 'aria-live': 'polite', text: progressText(p), ...tid('update-progress') }),
    progressBar(p && p.step === 'downloading' && p.total ? p.done / p.total : null),
    h('p', { class: 'small', text: CHECKING_NOTE, ...tid('update-checking-note') }),
    h('button', { class: 'btn btn-text', onclick: () => close(), ...tid('update-progress-hide') }, 'Hide'),
  ];
}

function answer(app, r, close) {
  const other = h('button', { class: 'btn btn-text', onclick: () => { close(); openOtherAddress(app); }, ...tid('update-other') }, 'Update from another address');
  if (r.result === 'none') {
    // Up to date with everything that answered, but that is old: perhaps every source was left behind.
    const old = staleRelease(r.newest && r.newest.created);
    return [
      h('h2', { text: 'No newer version found' }),
      h('div', tid('update-stale'), notice('warn', `The newest BEAM Campfire release any update source has is from ${old.date}, about ${old.months} months ago. If BEAM Campfire has moved to a new address, a copy there can bring you a newer one. Your app keeps working.`)),
      h('p', { class: 'small', text: triedText(r.tried), ...tid('update-tried') }),
      h('button', { class: 'btn btn-primary', onclick: () => close(), ...tid('update-stale-ok') }, 'Keep using this version'),
      other,
    ];
  }
  if (r.result === 'ready') {
    const where = copyAt(r.from)
      ? `Downloaded from ${copyAt(r.from)} and checked against BEAM Campfire's signature, file by file. Your wallet and settings stay as they are.`
      : 'This version was downloaded and checked against the BEAM Campfire release signature. Your wallet and settings stay as they are.';
    const released = releaseDate(r.created);
    return [
      h('h2', { text: `Update to ${r.version}` }),
      h('p', { class: 'lead', text: where, ...tid('update-ready-text') }),
      released ? h('p', { class: 'small', text: `Released ${released}.`, ...tid('update-released') }) : null,
      h('button', { class: 'btn btn-primary', onclick: () => applyUpdate(app, { close }), ...tid('update-apply-sheet') }, `Update to ${r.version}`),
      h('button', { class: 'btn btn-text', onclick: () => close(), ...tid('update-later') }, 'Later'),
      r.canDiscard ? h('button', { class: 'btn btn-text', onclick: () => discardDownload(app, { close }), ...tid('update-discard') }, 'Delete this download') : null,
    ];
  }
  if (r.result === 'needs_own_address') return needsAddress(r.version, close, r.ownVersion);
  if (r.result === 'refused') {
    return [
      h('h2', { text: 'Update refused' }),
      notice('error', `${refusalText(r)} You are still on the version you had, which is unchanged.`),
      h('p', { class: 'small', text: triedText(r.tried), ...tid('update-tried') }),
      h('button', { class: 'btn btn-primary', onclick: () => close() }, 'Keep using this version'),
      other,
    ];
  }
  return [
    h('h2', { text: 'No update source reachable' }),
    h('div', tid('no-update-source'), notice('info', 'No update source reachable. Your app keeps working.')),
    h('p', { class: 'lead', text: 'BEAM Campfire runs from the copy on this device. It does not need its web address to open, unlock, sync, send or receive.' }),
    h('p', { class: 'small', text: triedText(r.tried), ...tid('update-tried') }),
    h('button', { class: 'btn btn-primary', onclick: () => close(), ...tid('no-update-ok') }, 'Keep using this version'),
    other,
  ];
}

/** ownVersion: what the address served when it answered (it has not caught up yet); else it did not answer. */
function needsAddress(version, close, ownVersion = null) {
  const why = ownVersion
    ? `which still serves version ${ownVersion}. Your app keeps working; check again later.`
    : 'which is not serving it right now. Your app keeps working; check again later.';
  return [
    h('h2', { text: `Version ${version} needs this app's address` }),
    h('div', tid('update-needs-address'), notice('info', `BEAM Campfire ${version} changes how the app starts on this device, and that part can only come from the address you installed it from, ${why}`)),
    h('button', { class: 'btn btn-primary', onclick: () => close() }, 'Keep using this version'),
  ];
}

/** Said once a downloaded update is deleted (issue #78). */
export const DISCARDED_TOAST = 'Download deleted. Check for updates to download it again.';

/**
 * "Delete this download": the downloaded, not installed release goes. No confirmation: nothing is
 * lost that a check cannot bring back. Returns the loader's answer.
 */
export async function discardDownload(app, { close = null, onDone = null } = {}) {
  const r = await app.updates.discard();
  if (r.result === 'discarded' || r.result === 'none') {
    if (close) close();
    toast(DISCARDED_TOAST, 4000);
  } else if (r.result === 'busy') {
    toast('A check for updates is running. Delete the download once it has finished.', 4000);
  } else {
    toast(`The download could not be deleted (${r.reason || 'no answer'}). Your app keeps working.`, 5000);
  }
  if (onDone) onDone(r);
  return r;
}

/** Update: switches to the staged release, or says why it needs this app's address first. */
export async function applyUpdate(app, { close = null } = {}) {
  const r = await app.updates.apply();
  if (r.result === 'applied') return r;
  if (close) close();
  if (r.result === 'needs_own_address') openSheet((done) => needsAddress(r.version, done), { label: 'Update' });
  else toast(r.reason || 'The update could not be applied. Your app keeps working.', 4000);
  return r;
}

/**
 * "Update from another address": paste the address of any copy of the app.
 * It is saved and asked after the built-in sources on every check.
 */
export function openOtherAddress(app, { onDone = null } = {}) {
  const saved = app.updates.addedSource();
  let message = null;
  let draft = null;
  return openSheet((close, rerender) => {
    const input = h('input', {
      class: `input${message ? ' bad' : ''}`,
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
      placeholder: 'https://',
      'aria-label': 'Address of a copy of BEAM Campfire',
      ...tid('other-address'),
    });
    input.value = draft != null ? draft : saved || '';
    const submit = () => {
      const n = normalizeSource(input.value);
      if (!n.ok) {
        message = n.reason;
        draft = input.value;
        return rerender();
      }
      app.updates.setAddedSource(n.url);
      close();
      runUpdateCheck(app, { onDone });
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    focusSoon(input);
    return [
      h('h2', { text: 'Update from another address' }),
      h('p', { class: 'lead', text: "Any copy of BEAM Campfire can bring you an update when the app's own address is gone. Paste the address of one. Whatever it sends is checked against BEAM Campfire's signature, so a changed or fake copy can't be installed." }),
      h('label', { class: 'field' }, 'Address of a copy', input),
      message ? h('p', { class: 'hint bad', role: 'alert', text: message, ...tid('other-address-error') }) : null,
      h('p', { class: 'small', text: "It is saved on this device and asked after this app's address and the public copies, only when you check for updates." }),
      h('button', { class: 'btn btn-primary', onclick: submit, ...tid('other-address-check') }, 'Look for an update here'),
      saved
        ? h('button', { class: 'btn btn-text', onclick: () => { app.updates.setAddedSource(null); close(); toast('Address forgotten.'); if (onDone) onDone(null); }, ...tid('other-address-forget') }, 'Forget this address')
        : null,
      h('button', { class: 'btn btn-text', onclick: () => close() }, 'Cancel'),
    ];
  }, { label: 'Update from another address' });
}
