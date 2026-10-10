// App shaders: the WebAssembly programs the engine runs to build a contract
// call. A substituted shader could make the engine sign something other than
// what the screen shows, so each one is pinned by SHA-256 and size - the same
// pins the desktop app uses (lib/wallets/beam/contracts/*/..._constants.dart).
//
// - The build (tools/build.mjs) copies them from assets/beam/shaders/ into
//   shaders/, refuses any file whose bytes differ from these pins, and checks
//   that each pin here is the one the desktop's Dart file carries. They are in
//   the signed manifest like every other file.
// - The page loads a shader only when a feature first needs it (never on first
//   paint) and checks its hash again before handing it to the engine.

export const SHADERS = Object.freeze({
  amm: Object.freeze({
    file: 'amm_app.wasm',
    sha256: '42d0f6f20237dd4a2e9fbcd912e82110a0602d3e147140fb179c3dc6bdab01ba',
    size: 38914,
    dart: 'lib/wallets/beam/contracts/dex/dex_constants.dart',
  }),
  bans: Object.freeze({
    file: 'bans_app.wasm',
    sha256: '99eb1dfb023d30c338e3c4a4c536b7695b48ca25e27f9ce5f659b6567241736d',
    size: 34666,
    dart: 'lib/wallets/beam/contracts/bans/bans_constants.dart',
  }),
  airdrop: Object.freeze({
    file: 'airdrop_app.wasm',
    sha256: 'cddf4a6301f01f2045312f90e977951feaba04d1174744d768dde1c214e55c20',
    size: 12821,
    dart: 'lib/wallets/beam/contracts/airdrop/airdrop_constants.dart',
  }),
  minter: Object.freeze({
    file: 'minter_app.wasm',
    sha256: '95b37fc5708fbad7b323d52ef32e02c40d572433251d8ab6d1e88c80ba4b0fe1',
    size: 7430,
    dart: 'lib/wallets/beam/contracts/minter/minter_constants.dart',
  }),
  // The bridge: one shader drives the four wrapped assets' pipes, the other
  // BEAM's own (reverse) pipe. Both pins live in one Dart file.
  pipe: Object.freeze({
    file: 'pipe_app.wasm',
    sha256: '6a2ca541ac14e20cdeb55f432bf3d5ee273547844bc92853f1d1282fa6f9a9c3',
    size: 7840,
    dart: 'lib/wallets/beam/contracts/bridge/pipe_constants.dart',
  }),
  pipeReverse: Object.freeze({
    file: 'pipe_reverse_app.wasm',
    sha256: '6310f8af645dc85e093ab975209a60ca1b71197d92841c78fdac70088341415e',
    size: 5876,
    dart: 'lib/wallets/beam/contracts/bridge/pipe_constants.dart',
  }),
});

export const SHADER_DIR = 'shaders';

export class ShaderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** Throws unless `bytes` are exactly the pinned shader `key`. */
export async function verifyShader(key, bytes) {
  const pin = SHADERS[key];
  if (!pin) throw new ShaderError('unknown', `No pinned shader called ${key}.`);
  if (bytes.length !== pin.size) throw new ShaderError('mismatch', `${pin.file}: ${bytes.length} bytes, pinned ${pin.size}.`);
  const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  if (digest !== pin.sha256) throw new ShaderError('mismatch', `${pin.file} does not match its pinned hash.`);
  return bytes;
}

const cache = new Map();

/**
 * The verified bytes of shader `key` ("amm", "bans", "airdrop", "minter",
 * "pipe", "pipeReverse"),
 * fetched from this release on first use. Concurrent calls share one fetch;
 * a failure is not cached.
 * @returns {Promise<Uint8Array>}
 */
export function loadShader(key, { fetchImpl = globalThis.fetch } = {}) {
  if (cache.has(key)) return cache.get(key);
  const pin = SHADERS[key];
  if (!pin) return Promise.reject(new ShaderError('unknown', `No pinned shader called ${key}.`));
  const p = (async () => {
    let r;
    try {
      r = await fetchImpl(`${SHADER_DIR}/${pin.file}`, { cache: 'no-store', credentials: 'same-origin' });
    } catch {
      throw new ShaderError('load', 'A part of the app could not be loaded. Check your connection and try again.');
    }
    if (!r.ok) throw new ShaderError('load', `A part of the app is missing (${pin.file}). Reload BEAM Campfire.`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return verifyShader(key, bytes);
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
