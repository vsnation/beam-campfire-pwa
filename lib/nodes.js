// BEAM mainnet nodes that accept browser (WebSocket over TLS) connections on
// port 8200: the pool "Random node" picks from. Checked 2026-10-10: each
// answers a wss upgrade with 101, and every certificate also names eu-nodes.
// eu-node02/03/04 send their full certificate chain. eu-node01 sends only its
// own certificate: browsers that fetch the missing intermediate accept it,
// stricter TLS clients do not, so it is tried last. eu-nodes is a DNS name over
// the four. us-nodes are self-signed (browsers refuse them) and ap-nodes have
// no DNS, so neither is offered. tools/headers.mjs puts exactly these hosts in
// the CSP connect-src.
export const POOL = [
  { address: 'eu-node02.mainnet.beam.mw:8200', fullChain: true },
  { address: 'eu-node03.mainnet.beam.mw:8200', fullChain: true },
  { address: 'eu-node04.mainnet.beam.mw:8200', fullChain: true },
  { address: 'eu-nodes.mainnet.beam.mw:8200', fullChain: true },
  { address: 'eu-node01.mainnet.beam.mw:8200', fullChain: false },
];

export const NODES = POOL.map((n) => n.address);

/** prefs.node for BEAM's public nodes (the pool). Anything else there is the person's own node (host:port). */
export const RANDOM_NODE = 'random';

export const isPoolNode = (address) => NODES.includes(address);

/** "eu-node03.mainnet.beam.mw:8200" -> "eu-node03": how a pool node is named on screen. */
export const nodeName = (address) => String(address || '').split('.')[0];

/**
 * The order a wallet on BEAM's public nodes tries them in: the full-chain nodes
 * in a random order, then eu-nodes (which may land on any of them, eu-node01
 * included), then eu-node01. The first one is where the wallet starts.
 * `first`: the node the person picked on the node screen ("Use this one",
 * prefs.poolNode); it goes first and the rest keep their order behind it, so
 * the wallet still moves on by itself when it stops answering. Anything that
 * is not a pool node is ignored.
 */
export function poolOrder(random = Math.random, first = null) {
  const preferred = POOL.filter((n) => n.fullChain && n.address !== 'eu-nodes.mainnet.beam.mw:8200').map((n) => n.address);
  for (let i = preferred.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [preferred[i], preferred[j]] = [preferred[j], preferred[i]];
  }
  const rest = NODES.filter((a) => !preferred.includes(a));
  const order = [...preferred, ...rest];
  return isPoolNode(first) ? [first, ...order.filter((a) => a !== first)] : order;
}

/**
 * What wallet.start() is given for these preferences: the person's own node
 * (prefs.node, host:port), else the pool node they picked to start on
 * (prefs.poolNode), else RANDOM_NODE. A poolNode that is not one of POOL (an
 * older or unknown value) means no pick: a random start.
 */
export function walletNode(prefs) {
  const n = prefs && prefs.node;
  if (typeof n === 'string' && n && n !== RANDOM_NODE && !isPoolNode(n)) return n;
  return prefs && isPoolNode(prefs.poolNode) ? prefs.poolNode : RANDOM_NODE;
}

/** The node after `current` in `order`, wrapping round. */
export function nextInOrder(order, current) {
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}
