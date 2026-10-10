// The address of the person's own BEAM node: host:port and nothing else.
// Shared by the page, the node check frame (node_probe.js) and the service
// worker: the build inlines this file into sw.js, so it imports nothing. The
// worker runs every address through normalizeNodeAddress before it goes into a
// Content-Security-Policy, so nothing but [a-z0-9.-], one colon and a port can
// ever reach that header.

export const NODE_EXAMPLE = 'node.example.com:8200';

const fail = (code, error) => ({ ok: false, code, error });

function validIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

function validHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "wss://Node.Example.com:8200/" -> {ok: true, address: "node.example.com:8200", host, port}.
 * Refused, each with a plain sentence: a scheme other than wss://, a user name
 * or password, a path, query or fragment, IPv6 (CSP host sources cannot name
 * one), a missing or out-of-range port, anything that is not a host name or an
 * IPv4 address.
 */
export function normalizeNodeAddress(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return fail('empty', `Type your node's address, for example ${NODE_EXAMPLE}.`);
  if (/^wss:\/\//i.test(s)) s = s.slice(6);
  else if (/^ws:\/\//i.test(s)) return fail('insecure', `The app connects to nodes over a secure connection (wss) only. Type the address without ws://, like ${NODE_EXAMPLE}.`);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return fail('scheme', `Leave out ${s.slice(0, s.indexOf('://') + 3)} and type only the host and port, like ${NODE_EXAMPLE}.`);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.includes('@')) return fail('credentials', `Leave out the user name and password: type only the host and port, like ${NODE_EXAMPLE}.`);
  if (/[/?#\\]/.test(s)) return fail('path', `Leave out everything after the port: type only the host and port, like ${NODE_EXAMPLE}.`);
  if (/\s/.test(s)) return fail('host', `An address has no spaces. It looks like ${NODE_EXAMPLE}.`);
  if (s.startsWith('[') || (s.match(/:/g) || []).length > 1) return fail('ipv6', "IPv6 addresses can't be used here. Use the node's host name or its IPv4 address.");
  const colon = s.lastIndexOf(':');
  if (colon < 0) return fail('port', `Add the port your node accepts wallets on (its websocket_port), like ${NODE_EXAMPLE}.`);
  const portText = s.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return fail('port', 'The port must be a number from 1 to 65535.');
  const port = Number(portText);
  let host = s.slice(0, colon).toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (/[^\x21-\x7e]/.test(host)) {
    // An international name: its ASCII (punycode) form is what DNS and the CSP use.
    try {
      host = new URL(`wss://${host}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !validIPv4(host) : !validHostname(host))) return fail('host', `That is not a host name or an IPv4 address. It looks like ${NODE_EXAMPLE}.`);
  return { ok: true, address: `${host}:${port}`, host, port };
}

/** The WebSocket origin of a checked address: "wss://host:port". */
export function nodeOrigin(address) {
  const n = normalizeNodeAddress(address);
  if (!n.ok) throw new Error('not a node address');
  return `wss://${n.address}`;
}

/** `csp` with the person's own node added to connect-src, and nothing else changed. null: `csp` itself. */
export function cspWithNode(csp, address) {
  if (address == null) return csp;
  const origin = nodeOrigin(address);
  return csp
    .split('; ')
    .map((d) => (d.startsWith('connect-src ') && !d.split(' ').includes(origin) ? `${d} ${origin}` : d))
    .join('; ');
}

/**
 * The policy of the node check frame: it may run this app's own scripts and
 * open a WebSocket to the one address being checked, nothing else, and only
 * this app's own pages may frame it.
 */
export function probeCsp(address) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src ${nodeOrigin(address)}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

export const NODE_PROBE_PAGE = 'node_probe.html';
export const PROBE_ID = /^[a-z0-9]{8,40}$/;
