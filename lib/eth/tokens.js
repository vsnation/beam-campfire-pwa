// The Ethereum assets the wallet knows by address, exactly as the desktop app
// lists them: WBEAM, USDT and USDC from lib/utilities/default_eth_tokens.dart,
// and the bridge's other tokens, WBTC and DAI, from
// lib/pages/eth/uniswap/uniswap_deps.dart (kUniVerifiedTokens) and
// lib/wallets/bridge/bridge_routes.dart. Anyone can deploy a token called
// "USDT"; only these addresses are shown as the real thing.
//
// Addresses are lowercase, as in the Dart lists; show them with
// toChecksumAddress() from crypto.js.

export const ETH = Object.freeze({ address: null, symbol: 'ETH', name: 'Ether', decimals: 18, bridge: 'eth' });

/**
 * bridge: the bridge route id that carries the token ('beam' is WBEAM ⇄ BEAM),
 * or null. WBEAM is BEAM on Ethereum, 1:1, minted and burnt by the bridge's
 * Ethereum pipe; it is priced and drawn as BEAM.
 */
export const TOKENS = Object.freeze(
  [
    { address: '0xe5acbb03d73267c03349c76ead672ee4d941f499', symbol: 'WBEAM', name: 'Wrapped BEAM', decimals: 8, bridge: 'beam' },
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', name: 'Tether', decimals: 6, bridge: 'usdt' },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: 6, bridge: null },
    { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, bridge: 'wbtc' },
    { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', name: 'Dai', decimals: 18, bridge: 'dai' },
  ].map((t) => Object.freeze(t)),
);

export const WBEAM = TOKENS[0];

/** The known token at `address` (any case), or null. */
export function tokenByAddress(address) {
  if (typeof address !== 'string') return null;
  const a = address.toLowerCase();
  return TOKENS.find((t) => t.address === a) || null;
}

export function tokenBySymbol(symbol) {
  return symbol === 'ETH' ? ETH : TOKENS.find((t) => t.symbol === symbol) || null;
}
