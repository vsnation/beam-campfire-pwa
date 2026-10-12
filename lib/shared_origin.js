// Where BEAM Campfire must not make a wallet: a web address other sites share (audit E-3).
// On <user>.github.io every GitHub Pages project of that user (github.com/<user>/<repository>) is
// one origin, so any of them could read this app's storage, change the app copy it serves from
// Cache Storage, and use its passkeys (a passkey belongs to the host). GitLab Pages (<user>.gitlab.io)
// and Codeberg Pages (<user>.codeberg.page) are shared the same way (audit UPD-9). The copy
// published there (vsnation.github.io/beam-campfire-pwa/) exists so that installed apps can still
// fetch signed updates when their own address is gone; the wallet is used at BEAM Campfire's own
// address.
// Create is refused there. Restore and Import are not (audit UPD-2): if pwa.buybeam.my is lost,
// such a copy may be the only web copy left, and refusing them would strand a web restore. They
// run only after the person read and confirmed a warning (app.sharedOriginOk, set by the warning
// sheet in screens/welcome.js and cleared whenever Welcome or Add a wallet is shown again). A wallet
// already on such a copy keeps working. No imports: lib/session.js and the screens use it.

export const SHARED_HOST_SUFFIXES = Object.freeze(['.github.io', '.gitlab.io', '.codeberg.page']);

// BEAM Campfire's own address, where wallets are created, restored and imported.
export const HOME_HOST = 'pwa.buybeam.my';
export const HOME_URL = `https://${HOME_HOST}/`;

/** Whether a host name is one other sites share. */
export function isSharedOrigin(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return SHARED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

const currentHost = () => (typeof location !== 'undefined' && location !== null ? location.hostname : '');

/** Whether this page runs on such an address. */
export function onSharedOrigin() {
  return isSharedOrigin(currentHost());
}

// What the shared-address screens say (screens/welcome.js, screens/add_wallet.js). Plain words:
// no "origin", no "passkey".
const ELSEWHERE = 'BEAM Campfire for desktop and Android';
export const SHARED_TEXT = Object.freeze({
  why: (host) => `This copy of BEAM Campfire is at ${host}, an address other websites share: they could read a wallet kept here, or change this copy of the app. New wallets are made at BEAM Campfire's own address, ${HOME_HOST}.`,
  go: `Go to ${HOME_HOST}`,
  unexpected: `If ${HOME_HOST} shows anything unexpected, don't enter your words there.`,
  elsewhere: `Your 12 words also open your wallet in ${ELSEWHERE}, or in any other BEAM wallet.`,
  restoreHere: 'Restore with 12 words here',
  importHere: 'Import a wallet.db file here',
  warnTitle: Object.freeze({ restore: 'Restore your wallet here?', import: 'Import your wallet here?' }),
  warn: (host, kind) =>
    `${host} is shared with other websites. Any of them could read the wallet you ${kind === 'import' ? 'import' : 'restore'} here, or change this copy of the app to see your ${kind === 'import' ? 'password' : 'words or password'} as you type.`,
  warnWhen: `Do this only if ${HOME_HOST} and ${ELSEWHERE} are out of reach. When you can, move your coins to a new wallet made in one of them.`,
  confirm: Object.freeze({ restore: 'I understand, restore here', import: 'I understand, import here' }),
  cancel: 'Cancel',
});

export class SharedOriginError extends Error {
  constructor(code = 'shared_origin') {
    super(
      code === 'shared_origin'
        ? `This copy of BEAM Campfire is at an address other websites share, so it makes no new wallets. Create one at ${HOME_HOST}, or in ${ELSEWHERE}.`
        : 'This copy of BEAM Campfire is at an address other websites share. Read the warning and confirm it before you restore or import a wallet here.',
    );
    this.code = code;
  }
}

/**
 * Why adding a wallet of this kind is refused here, or null.
 * kind: 'create' | 'restore' | 'import' (anything else counts as 'create');
 * consented: the person confirmed the shared-address warning for this restore or import.
 * @returns null | 'shared_origin' (Create, never on a shared address) | 'shared_origin_unconfirmed'
 */
export function sharedOriginRefusal(kind, consented, hostname = currentHost()) {
  if (!isSharedOrigin(hostname)) return null;
  if (kind !== 'restore' && kind !== 'import') return 'shared_origin';
  return consented === true ? null : 'shared_origin_unconfirmed';
}

/**
 * Throws SharedOriginError when adding a wallet of this kind is refused here: called before a
 * wallet is created, restored or imported, before anything is touched.
 */
export function refuseOnSharedOrigin(kind = 'create', app = null) {
  const code = sharedOriginRefusal(kind, Boolean(app && app.sharedOriginOk === true));
  if (code) throw new SharedOriginError(code);
}
