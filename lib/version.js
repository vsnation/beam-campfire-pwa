// Filled in by tools/build.mjs. In an unbuilt tree (serving src/) the
// placeholders stay, BUILT is false and no service worker is registered.
export const APP_VERSION = "0.1.7";
export const BUILT = APP_VERSION !== '__BUILD' + '_VERSION__';
export const ENGINE_LOCK = {"beam_tag":"beam-7.5.14493","files":{"wasm-client.js":"68c784e45de57363241f9c9e68bf81a2d9b253221f8a8f45247cd99a84634bcf","wasm-client.wasm":"b86dd07950474beff01bd8a9103886a0230f549708814b4facef0e4444903ce8","wasm-client.worker.js":"eff6668e83689221c3515bd0b29bf9db9a1c8067a73213be4abe142f396a4e0e"},"rules_signature_contains":"3928666-96df3f33ee02ad9e"};
export const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
// The service worker's content-addressed file name (sw-<sha256 prefix>.js). Its
// bytes never change under that name, so a change there is a warning sign.
export const LOADER = "sw-1f03190f6a23cc9d.js";
