// Filled in by tools/build.mjs. In an unbuilt tree (serving src/) the
// placeholders stay, BUILT is false and no service worker is registered.
export const APP_VERSION = "0.2.3";
export const BUILT = APP_VERSION !== '__BUILD' + '_VERSION__';
export const ENGINE_LOCK = {"beam_tag":"beam-7.5.14493","files":{"wasm-client.js":"f4e61c591a1882f2129407c1ab9430dd83019910e235374c89a30af994f25e82","wasm-client.wasm":"760eb2c769b3e557cc13bdb67686fc99584d97b6cb25ee21b0d13f408f484ce3","wasm-client.worker.js":"eff6668e83689221c3515bd0b29bf9db9a1c8067a73213be4abe142f396a4e0e"},"rules_signature_contains":"3928666-96df3f33ee02ad9e"};
export const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
// The service worker's content-addressed file name (sw-<sha256 prefix>.js). Its
// bytes never change under that name, so a change there is a warning sign.
export const LOADER = "sw-968f2b51432ac5bf.js";
// What that loader does to pages (release.json loader_compat). A running loader with the
// same value serves this release's pages with the same headers (lib/loader.js loaderBehind).
export const LOADER_COMPAT = "58bb6cf6516114b22ecd365c6cab6b16d8f49c97ea89e0108d7b3360a92f856c";
