// BEAM mainnet nodes that accept browser (WebSocket over TLS) connections on
// port 8200. Checked 2026-10-07: these three answer with a valid certificate;
// us-nodes / us-node01 present an invalid certificate and ap-nodes is
// unreachable, so they are not offered. Keep in sync with tools/headers.mjs
// (CSP connect-src) - a unit test checks that.
export const NODES = [
  { address: 'eu-nodes.mainnet.beam.mw:8200', label: 'Europe' },
  { address: 'eu-node01.mainnet.beam.mw:8200', label: 'Europe 1' },
  { address: 'eu-node02.mainnet.beam.mw:8200', label: 'Europe 2' },
];
