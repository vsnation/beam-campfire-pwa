// Face ID / Touch ID unlock through a passkey and the WebAuthn PRF extension.
//
// There is no server: the passkey is not used to log in anywhere. What we use
// is PRF - the authenticator turns a fixed salt into 32 secret bytes, and only
// after user verification (Face ID / Touch ID / device PIN). Those bytes,
// through HKDF, unlock the passkey envelope (lib/envelope.js). Without PRF
// (iOS before 18, some browsers) the passkey cannot hold a key, so the
// password stays the way in.

import { randomBytes, b64, unb64 } from './envelope.js';

const RP_NAME = 'BEAM Campfire';

export class PasskeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'unsupported' | 'cancelled' | 'no_prf' | 'failed'
  }
}

function b64url(u8) {
  return b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return unb64(t + '='.repeat((4 - (t.length % 4)) % 4));
}

/** True when a platform authenticator exists; PRF itself is only known after trying. */
export async function passkeyAvailable() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && caps['extension:prf'] === false) return false;
    }
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function mapError(e) {
  if (e instanceof PasskeyError) return e;
  if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    return new PasskeyError('cancelled', 'Face ID was cancelled or timed out.');
  if (e && e.name === 'InvalidStateError') return new PasskeyError('failed', 'This device already has a BEAM Campfire passkey for this wallet.');
  return new PasskeyError('failed', 'The passkey did not work on this device.');
}

/**
 * Creates a passkey and evaluates PRF once.
 * @returns {{credId:string, prfSalt:Uint8Array, prf:Uint8Array}}
 */
export async function createPasskey(walletId) {
  if (!(await passkeyAvailable())) throw new PasskeyError('unsupported', 'Face ID / Touch ID passkeys are not available here.');
  const prfSalt = randomBytes(32);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME },
        user: { id: randomBytes(16), name: `BEAM Campfire wallet ${walletId.slice(0, 6)}`, displayName: 'BEAM Campfire wallet' },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        timeout: 120000,
        attestation: 'none',
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (e) {
    throw mapError(e);
  }
  const credId = b64url(new Uint8Array(cred.rawId));
  const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
  if (!ext.prf || ext.prf.enabled === false) throw new PasskeyError('no_prf', 'This device made a passkey but cannot use it to protect a key (no PRF support).');
  let prf = ext.prf.results && ext.prf.results.first ? new Uint8Array(ext.prf.results.first) : null;
  if (!prf) prf = await evaluatePrf(credId, prfSalt);
  return { credId, prfSalt, prf };
}

/** Asks for Face ID / Touch ID and returns the PRF output for this credential. */
export async function evaluatePrf(credId, prfSalt) {
  let a;
  try {
    a = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: unb64url(credId) }],
        userVerification: 'required',
        timeout: 120000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (e) {
    throw mapError(e);
  }
  const ext = a.getClientExtensionResults ? a.getClientExtensionResults() : {};
  const first = ext.prf && ext.prf.results && ext.prf.results.first;
  if (!first) throw new PasskeyError('no_prf', 'This passkey cannot unlock the wallet on this device (no PRF result).');
  return new Uint8Array(first);
}
