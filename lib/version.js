// Filled in by tools/build.mjs. In an unbuilt tree (serving src/) the
// placeholders stay, BUILT is false and no service worker is registered.
export const APP_VERSION = "0.2.19";
export const BUILT = APP_VERSION !== '__BUILD' + '_VERSION__';
export const ENGINE_LOCK = {"beam_tag":"beam-7.5.14493","files":{"wasm-client.js":"b3d47b7ce7a18a6400de02f103e2982dd511ce2e5f3815a8e9cd1661d7ab97f0","wasm-client.wasm":"a0410ea3ab28486847e48434ba68125c09bf1986acb801daec82fc5a5d3f482b","wasm-client.worker.js":"eff6668e83689221c3515bd0b29bf9db9a1c8067a73213be4abe142f396a4e0e"},"rules_signature_contains":"3928666-96df3f33ee02ad9e"};
export const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
// The service worker's content-addressed file name (sw-<sha256 prefix>.js). Its
// bytes never change under that name, so a change there is a warning sign.
export const LOADER = "sw-ea57ebf485421b18.js";
// What that loader does to pages (release.json loader_compat). A running loader with the
// same value serves this release's pages with the same headers (lib/loader.js loaderBehind).
export const LOADER_COMPAT = "44245312edd43939b8e457adb44470ba8643d4a8208d85b964a212ba0b2ecd3c";
