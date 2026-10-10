// buybeam.my, the one service Buy BEAM talks to, as the desktop app does
// (lib/wallets/beam/buy/buybeam_client.dart, kBuyBeamBaseUrl): its buy API
// under one path, and its own site, which the person may open with a tap to
// reach its support.
//
// Written without the scheme and joined in apiBase(), as lib/eth/hosts.js
// does, so the "no source file reaches out to another origin" check in
// test/unit/config.test.mjs keeps flagging literal URLs elsewhere, and the
// CSP (tools/headers.mjs) lists exactly buyConnectSources(): the API path,
// never the whole host.

const SCHEME = 'https:';

export const BUYBEAM = Object.freeze({ id: 'buybeam', name: 'buybeam.my', host: 'buybeam.my', path: '/api/v1/buy/' });

/** The API's base, without the trailing slash: requests add "/assets", "/quote", … */
export function buyApiBase() {
  return `${SCHEME}//${BUYBEAM.host}${BUYBEAM.path.slice(0, -1)}`;
}

/** buybeam.my's site, where its support is. A link the person taps, never fetched. */
export function buySiteUrl() {
  return `${SCHEME}//${BUYBEAM.host}`;
}

/** What `connect-src` must list for Buy BEAM: the API path only. */
export function buyConnectSources() {
  return [`${SCHEME}//${BUYBEAM.host}${BUYBEAM.path}`];
}
