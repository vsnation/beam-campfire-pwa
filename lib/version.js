// Filled in by tools/build.mjs. In an unbuilt tree (serving src/) the
// placeholders stay, BUILT is false and no service worker is registered.
export const APP_VERSION = "0.2.10";
export const BUILT = APP_VERSION !== '__BUILD' + '_VERSION__';
export const ENGINE_LOCK = {"beam_tag":"beam-7.5.14493","files":{"wasm-client.js":"60bd3c8bcb34a04a1508017b2f4d1d75a739220be542d8ae5f8730a5dfebc982","wasm-client.wasm":"84ac5d999f2db59dd98c20adb69567d4b9a62b7ecb4d3448f04cf2de7a1f5163","wasm-client.worker.js":"eff6668e83689221c3515bd0b29bf9db9a1c8067a73213be4abe142f396a4e0e"},"rules_signature_contains":"3928666-96df3f33ee02ad9e"};
export const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
// The service worker's content-addressed file name (sw-<sha256 prefix>.js). Its
// bytes never change under that name, so a change there is a warning sign.
export const LOADER = "sw-6bbd4c175f01375b.js";
// What that loader does to pages (release.json loader_compat). A running loader with the
// same value serves this release's pages with the same headers (lib/loader.js loaderBehind).
export const LOADER_COMPAT = "4da06086d3edcfe57114cde14650eb766d851a385b62bf758a5ff09ebf822164";
