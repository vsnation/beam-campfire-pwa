// The official BeamMW bridge between BEAM and Ethereum: its five routes, in
// one registry that quoting, building, tracking and tests all import (a value
// quoted from one table and sent from another is a money bug). The same values
// as the desktop app's lib/wallets/bridge/bridge_routes.dart, field for field.
//
// Each route is a pair of "pipes": a contract on BEAM and one on Ethereum.
// Going to Ethereum ("b2e"), the BEAM pipe locks or burns the coins and
// records a message; a relayer pays the person on Ethereum about 61 BEAM
// blocks later. Going to BEAM ("e2b"), the Ethereum pipe takes the coins with
// `sendFunds`; a relayer pushes the message to BEAM a few minutes later and
// the person claims it with the key the BEAM pipe derives for their wallet.
//
// The Ethereum addresses here are data: nothing in this file talks to
// Ethereum. Amounts are BigInt in each side's smallest unit.

/** BEAM-side decimals, every route. */
export const BEAM_DECIMALS = 8;

/**
 * keccak256("NewLocalMessage(uint64,uint256,uint256,bytes)"): the event an
 * Ethereum pipe emits on `sendFunds`. Every field is in `data`:
 * (uint64 msgId, uint256 amount, uint256 relayerFee, bytes receiver).
 */
export const NEW_LOCAL_MESSAGE_TOPIC = '0x5f52670be4e2f3d7b079180b485ab44712641a10d1c77e843355f96036608ac7';

/** `sendFunds(uint256 value, uint256 relayerFee, bytes receiverBeamPubkey)`. */
export const SEND_FUNDS_SIGNATURE = 'sendFunds(uint256,uint256,bytes)';

/** BEAM confirmations the b2e relayer waits for before paying. */
export const BEAM_CONFIRMATIONS = 61;

/** BEAM network fee of a b2e `send` (no contract charge): 0.011 BEAM. */
export const SEND_FEE = 1100000n;

/**
 * BEAM network fee of an e2b claim (`receive` declares a charge of
 * 1,200,000): 0.121 BEAM. A BEAM wallet without it cannot claim a wrapped asset.
 */
export const CLAIM_FEE = 12100000n;

/** The pinned app shader (lib/shaders.js) that drives each kind of pipe. */
export const PIPE_SHADERS = Object.freeze({ forward: 'pipe', reverse: 'pipeReverse' });

const pow10 = (n) => 10n ** BigInt(n);

function route(r) {
  return Object.freeze({
    ...r,
    shaderKey: PIPE_SHADERS[r.shader],
    isBeam: r.beamAssetId === 0,
    isNativeEth: r.ethToken === null,
    // Ethereum units per groth when Ethereum has more decimals (ETH, DAI:
    // 10^10), else 1. An e2b value must be a multiple of it, or the relayer
    // truncates the rest away.
    ethGrid: pow10(r.ethDecimals > BEAM_DECIMALS ? r.ethDecimals - BEAM_DECIMALS : 0),
    // Groth per Ethereum unit when Ethereum has fewer decimals (USDT: 100),
    // else 1. A b2e amount and fee must be multiples of it.
    beamGrid: pow10(r.ethDecimals < BEAM_DECIMALS ? BEAM_DECIMALS - r.ethDecimals : 0),
    // The most one b2e crossing may carry, amount and fee each; above it the
    // WBEAM relayer rejects the message for good and the BEAM stays locked.
    maxGroth: r.maxCoins == null ? null : BigInt(r.maxCoins) * pow10(BEAM_DECIMALS),
  });
}

/**
 * Fields, as in the desktop's BridgeRoute:
 *   id                 stable id: beam, eth, wbtc, usdt, dai
 *   beamSymbol         what the BEAM wallet holds; ethSymbol what the Ethereum one holds
 *   beamAssetId        BEAM asset id (0 for BEAM)
 *   beamPipeCid        the BEAM pipe - never the asset-owner contract beside it,
 *                      whose get_pk gives a key nobody can ever claim with
 *   shader             'forward' (the four wrapped assets) or 'reverse' (BEAM)
 *   sendMethod, receiveMethod
 *                      the contract methods a built send / claim must call: 3 and 4
 *                      on the forward pipes; the reverse pipe sits behind an
 *                      upgradable wrapper that shifts them to 4 and 6
 *   ethPipe, ethToken  lowercase 0x addresses; ethToken null for native ETH
 *   ethDecimals        the Ethereum side's decimals (the BEAM side is always 8)
 *   relayGas           the gas the relayer charges for paying a b2e crossing
 *   processedSlot      storage slot of the Ethereum pipe's mapping(uint64 => bool)
 *                      of paid BEAM-side messages
 *   coingeckoId        the id the relayer prices the asset with
 *   maxCoins           per-crossing cap in whole coins, or null
 */
export const ROUTES = Object.freeze([
  route({
    id: 'beam',
    beamSymbol: 'BEAM',
    ethSymbol: 'WBEAM',
    name: 'BEAM',
    beamAssetId: 0,
    beamPipeCid: 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835',
    shader: 'reverse',
    sendMethod: 4,
    receiveMethod: 6,
    ethPipe: '0x6063024646e8a1561970840a4b0e0f1082f5a670',
    ethToken: '0xe5acbb03d73267c03349c76ead672ee4d941f499',
    ethDecimals: 8,
    relayGas: 96000,
    processedSlot: 2,
    coingeckoId: 'beam',
    maxCoins: 3000000,
  }),
  route({
    id: 'eth',
    beamSymbol: 'bETH',
    ethSymbol: 'ETH',
    name: 'Ether',
    beamAssetId: 36,
    beamPipeCid: '8872509d36a8e2aa7a60839a1828c372af47c0a5309f3f6186379cddec847369',
    shader: 'forward',
    sendMethod: 3,
    receiveMethod: 4,
    ethPipe: '0xb1d7ff9d3acaf30e282c5f6eb1f2a6503f516a96',
    ethToken: null,
    ethDecimals: 18,
    relayGas: 120000,
    processedSlot: 1,
    coingeckoId: 'ethereum',
    maxCoins: null,
  }),
  route({
    id: 'wbtc',
    beamSymbol: 'bWBTC',
    ethSymbol: 'WBTC',
    name: 'Bitcoin',
    beamAssetId: 38,
    beamPipeCid: '7c66181ba4625202aae6e46afe89acbf1f839523344b0b371fc7988ac2e8c056',
    shader: 'forward',
    sendMethod: 3,
    receiveMethod: 4,
    ethPipe: '0x604422d7ec88c45b82b71851d073efeaa928dcef',
    ethToken: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    ethDecimals: 8,
    relayGas: 120000,
    processedSlot: 2,
    coingeckoId: 'wrapped-bitcoin',
    maxCoins: null,
  }),
  route({
    id: 'usdt',
    beamSymbol: 'bUSDT',
    ethSymbol: 'USDT',
    name: 'Tether',
    beamAssetId: 37,
    beamPipeCid: '8af23fe6338e3e67574f4548c9acf3d269756ae9b25ab025fd4268a07b8a3c29',
    shader: 'forward',
    sendMethod: 3,
    receiveMethod: 4,
    ethPipe: '0x7c3fe09e86b0d8661d261a49bfa385536b7077f9',
    ethToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    ethDecimals: 6,
    relayGas: 120000,
    processedSlot: 2,
    coingeckoId: 'tether',
    maxCoins: null,
  }),
  route({
    id: 'dai',
    beamSymbol: 'bDAI',
    ethSymbol: 'DAI',
    name: 'Dai',
    beamAssetId: 39,
    beamPipeCid: '02fb908e55a59ab5acc5bf6f1707a8dcdb70a944d6f2a7bff3c7af18c8e278da',
    shader: 'forward',
    sendMethod: 3,
    receiveMethod: 4,
    ethPipe: '0xacdc8f4559741a3c8caab0ba74c57807a9fe2d73',
    ethToken: '0x6b175474e89094c44da98b954eedeac495271d0f',
    ethDecimals: 18,
    relayGas: 120000,
    processedSlot: 2,
    coingeckoId: 'dai',
    maxCoins: null,
  }),
]);

/** The route `id`; throws for an id that is not one. */
export function routeById(id) {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`no bridge route ${id}`);
  return r;
}

/** The route whose BEAM asset is `assetId`, or null. */
export function routeForBeamAsset(assetId) {
  return ROUTES.find((r) => r.beamAssetId === assetId) || null;
}

/** The route whose Ethereum asset is `token` (null for ETH), or null. */
export function routeForEthToken(token) {
  const t = token == null ? null : String(token).toLowerCase();
  return ROUTES.find((r) => r.ethToken === t) || null;
}

/** Ethereum units in groth (truncated, as the relayer does). */
export function ethToGroth(route, ethUnits) {
  return route.ethDecimals >= BEAM_DECIMALS ? ethUnits / route.ethGrid : ethUnits * route.beamGrid;
}

/** Groth in Ethereum units (truncated, as the relayer does). */
export function grothToEth(route, groth) {
  return route.ethDecimals >= BEAM_DECIMALS ? groth * route.ethGrid : groth / route.beamGrid;
}
