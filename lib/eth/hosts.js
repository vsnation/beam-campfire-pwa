// Every Ethereum host the app may contact, and nothing else: the one list
// the RPC client, Settings and (from Phase 1b) the CSP in tools/headers.mjs
// read. The same servers the desktop app offers
// (lib/wallets/crypto_currency/coins/ethereum.dart: the default node and
// publicRpcs), plus CoinGecko's price endpoint for the bridge.
//
// Hosts are written without their scheme and joined in originOf(): the
// "no source file reaches out to another origin" check in
// test/unit/config.test.mjs flags literal URLs outside the files it lists,
// and this file joins that list together with the CSP change, so that both
// change in one reviewed step.
//
// There is no fallback between servers: each one sees the IP address
// together with the Ethereum address, so the person picks one and the app
// uses only that one.
//
// Stack Wallet's server also keeps an index of each address's history
// (GET /export, the desktop app's lib/services/ethereum/ethereum_api.dart).
// The desktop app always asks it, whichever RPC is picked; the PWA asks it
// only while Settings -> Ethereum -> "History from Stack Wallet" is on.

const SCHEME = 'https:';

/**
 * logs: whether eth_getLogs over a few thousand blocks answered when this
 * list was measured (2026-10). Not a promise; getLogs still copes with refusals.
 */
export const ETH_RPC_HOSTS = Object.freeze(
  [
    { id: 'stackwallet', name: 'Stack Wallet', host: 'eth2.stackwallet.com', logs: true },
    { id: 'publicnode', name: 'PublicNode', host: 'ethereum-rpc.publicnode.com', logs: false },
    { id: 'drpc', name: 'dRPC', host: 'eth.drpc.org', logs: false },
    { id: 'mevblocker', name: 'MEV Blocker', host: 'rpc.mevblocker.io', logs: true },
    { id: 'blast', name: 'Blast', host: 'eth-mainnet.public.blastapi.io', logs: false },
  ].map((h) => Object.freeze(h)),
);

/** The desktop app's default, and the PWA's. */
export const DEFAULT_ETH_RPC = 'stackwallet';

/** Bridge prices (simple/price), asked only after the person allows it. */
export const PRICE_HOST = Object.freeze({ id: 'coingecko', name: 'CoinGecko', host: 'api.coingecko.com', path: '/api/v3/simple/price' });

export function originOf(entry) {
  return `${SCHEME}//${entry.host}`;
}

/** The RPC entry for `id`; throws for anything not in the list. */
export function ethRpcHost(id) {
  const h = ETH_RPC_HOSTS.find((x) => x.id === id);
  if (!h) throw new Error(`Unknown Ethereum server: ${id}`);
  return h;
}

/** The URL JSON-RPC requests go to. Only a listed host can produce one. */
export function rpcUrl(entry) {
  if (!ETH_RPC_HOSTS.includes(entry)) throw new Error('Not one of the listed Ethereum servers.');
  return originOf(entry);
}

/** The simple/price URL for CoinGecko ids, priced in USD. */
export function priceUrl(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => !/^[a-z0-9-]+$/.test(i))) throw new Error('bad price ids');
  return `${originOf(PRICE_HOST)}${PRICE_HOST.path}?ids=${ids.join(',')}&vs_currencies=usd`;
}

/**
 * Where an address's history is indexed: Stack Wallet's own server (the
 * desktop app's EthereumAPI.stackBaseServer, the same host as its default node).
 */
export const HISTORY_HOST = ETH_RPC_HOSTS[0];

/**
 * GET /export: the transactions to and from `address` (firstBlock onwards), or
 * with `emitter` the logs that token contract emitted about the address.
 * `address` and `emitter` must already be checked 0x addresses.
 */
export function historyUrl(address, { firstBlock = 0, emitter = null } = {}) {
  const hex = /^0x[0-9a-fA-F]{40}$/;
  if (!hex.test(address) || (emitter && !hex.test(emitter)) || !Number.isSafeInteger(firstBlock) || firstBlock < 0) throw new Error('bad history query');
  const q = emitter ? `addrs=${address.toLowerCase()}&emitter=${emitter.toLowerCase()}&logs=true` : `addrs=${address.toLowerCase()}&firstBlock=${firstBlock}&unripe=true`;
  return `${originOf(HISTORY_HOST)}/export?${q}`;
}

/**
 * The block explorer the person may open with a tap to see a transaction.
 * Never fetched by the app (it is not in connect-src): a link only.
 */
export const TX_EXPLORER = Object.freeze({ id: 'etherscan', name: 'Etherscan', host: 'etherscan.io' });

export function txExplorerUrl(hash) {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('not a transaction hash');
  return `${originOf(TX_EXPLORER)}/tx/${hash.toLowerCase()}`;
}

/** What `connect-src` must list for these hosts (the price entry is an exact path). */
export function connectSources() {
  return [...ETH_RPC_HOSTS.map(originOf), `${originOf(PRICE_HOST)}${PRICE_HOST.path}`];
}
