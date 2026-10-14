// The 9 dApps BEAM's desktop wallet ships for mainnet, pinned by SHA-256 and
// size. The same list, pins and source commit as the desktop BEAM Campfire.
//
// The packages are not part of this app: BEAM Campfire downloads one from
// BEAM's GitHub the first time it is opened (raw.githubusercontent.com sends
// Access-Control-Allow-Origin: *) and refuses it unless the bytes match.
//
// needsEval: the bundle only starts with 'unsafe-eval' (webpack eval builds,
// emscripten glue). Only dao-core-app does without.
// remoteOrigins: https origins the bundle's own code fetches from (prices,
// bridge fees). They are off unless the person turns them on for that dApp,
// because each one sees the person's IP address.
// blurb: BEAM Campfire's own line about the dApp (tk: the list shows it translated; the name is
// the dApp's and never is).
// desktopShape: always offer the desktop (Qt) wallet shape. The NFT Gallery
// reads the chain through the wallet only in its desktop mode; in its mobile
// mode it loads everything from its own web server instead.

import { REMOTE_ORIGINS as FRAME_REMOTE_ORIGINS } from './frame_policy.js';
import { t, tk } from '../i18n.js';

/** beam-ui tag beam-7.5.14493.5867, the release matching core 7.5.14493. */
export const SOURCE_COMMIT = '2f36c21ed010dee350c052ffce9097b23f69ecfb';
export const SOURCE_HOST = 'https://raw.githubusercontent.com';

const COINGECKO = 'https://api.coingecko.com';
const BEAM_EXPLORER_API = 'https://explorer-api.beam.mw';

/**
 * The app bodies a dApp may store in its contract data for the core to redo the call later.
 * A dependent call that misses its block is rebuilt by re-running the stored body at the new
 * state and signing what it emits without asking again (contract_transaction.cpp RebuildHft);
 * only the funds are held to what was approved. lib/dapps/policy.js checkRebuild refuses any
 * other body, and every one from a dApp installed from a file.
 *
 * Key: SHA-256 of the body as the core stores it - bvm2::Processor::Compile(Kind::Manager) of the
 * app shader (ShadersManager::compileAppShader), not the .wasm file. These are every app shader
 * in the packages above that can make a dependent call (it imports SelectContext), compiled at
 * beam-7.5.14493; the Beam DEX one is also the body of a swap recorded on mainnet, and it and
 * this wallet's own amm_app.wasm match the desktop's pins (dapp_rebuild_terms.dart).
 * test/unit/dapps_rebuild.test.mjs finds them again in the packages.
 *
 * contracts: the core re-runs the body with the arguments stored next to it, so those are pinned
 * too (audit BC-4): each contract argument the body may be redone with (cid, and the
 * accumulator's cidAmm), and the contracts it may name - the ones that dApp is made for. Any other
 * contract argument (cidDaoCore, cidDaoVault: deploy and admin actions) is refused.
 */
const DEX_CID = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';
// BeamX DAO accumulator on mainnet, as accum-dapp.dapp's own code names it (app/index.js, `mainnet`).
const DAO_ACCUMULATOR_CID = 'ec160307c43bc3fc0c3a52d3e3d3dfd8101593e8cec7a907fc42c9f103aabbae';
const DEX_CONTRACTS = Object.freeze({ cid: Object.freeze([DEX_CID]) });
const ACCUMULATOR_CONTRACTS = Object.freeze({ cid: Object.freeze([DAO_ACCUMULATOR_CID]), cidAmm: Object.freeze([DEX_CID]) });
export const REBUILD_BODIES = Object.freeze({
  '578cec5ed84e3397c8756043248e00e014d37d9ca71e00dade46de55293b4ef8': Object.freeze({ package: 'dex-app.dapp', file: 'app/amm.wasm', wasmSha256: '8b4a0616332702937b20d38dc1140645748df9c5f02efe8dfed5562dbd12c3fa', contracts: DEX_CONTRACTS }),
  '6aff76279ceb49996994279865eab88a6a12244728d0faa1086a5f879c9a0e3c': Object.freeze({ package: 'accum-dapp.dapp', file: 'app/dao-accumulator.wasm', wasmSha256: 'c1a6273ac47a756b93fb02e4b6ad9bc8bb5c2d28a2e7a681e88bb50b987536e1', contracts: ACCUMULATOR_CONTRACTS }),
  '07799ada4636fbb7d21ffcaef3c12ccea0d0eafcb641349f6b2e7be63f94edf7': Object.freeze({ package: 'accum-dapp.dapp', file: 'app/app.wasm', wasmSha256: 'd612b5c55fb5290e1b52c6f2b888e013fb75a2dc8624851f7a234a1053bf0d03', contracts: ACCUMULATOR_CONTRACTS }),
  // This wallet's own Swap shader (lib/shaders.js): a dApp may use BEAM's DEX code as it is.
  'bdff009943b48d32af3253b7e61facd09777c8064e83934b23caa0443533dc8b': Object.freeze({ shader: 'amm_app.wasm', wasmSha256: '42d0f6f20237dd4a2e9fbcd912e82110a0602d3e147140fb179c3dc6bdab01ba', contracts: DEX_CONTRACTS }),
});

/** Every remote origin any catalogued dApp may be granted (the frame policy grants them by bit). */
export const REMOTE_ORIGINS = Object.freeze([...FRAME_REMOTE_ORIGINS]);

const entry = (e) =>
  Object.freeze({
    needsEval: true,
    remoteOrigins: [],
    iconExt: 'svg',
    ...e,
    remoteOrigins: Object.freeze([...(e.remoteOrigins || [])]),
  });

export const CATALOGUE = Object.freeze([
  entry({
    fileName: 'dex-app.dapp',
    name: 'Beam DEX',
    blurb: tk('Swap BEAM and confidential assets'),
    guid: 'db851322f6674a6da3e84e9953db2ffd',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: '8f6d1b7dd6a694111cd645c559792b10d9ef9ecb87d340fce45adf0044bb088a',
    size: 5295745,
  }),
  entry({
    fileName: 'nft-marketplace.dapp',
    name: 'BEAM NFT Gallery',
    blurb: tk('Buy and sell confidential NFTs'),
    guid: 'ffbec734a0bb4f88a7104357a2680d20',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: 'd450b1798c0bb97e1c13c525848263370267f259a523592c4319ef88ef1ad4e0',
    size: 2633723,
    desktopShape: true,
  }),
  entry({
    fileName: 'bans.dapp',
    name: 'Beam Anonymous Name Service',
    blurb: tk('Register and look up BEAM names'),
    guid: 'a0b387971c9c4b0eaefa34f4deb888e4',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: 'eef3b49944aa1ba1271d3f85805d3241b05e7eb2dd1cea35bbf9396d4e5d4651',
    size: 5038009,
  }),
  entry({
    fileName: 'dao-core-app.dapp',
    name: 'BeamX DAO',
    blurb: tk('Stake BEAMX and follow governance'),
    guid: 'abcc470e12c6422291f360f83d79355e',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: '137ea5f23b973a6d083d47ea5506bdf46288e921c91d2511564ec0f8cd120625',
    size: 198455,
    needsEval: false,
    remoteOrigins: [COINGECKO],
  }),
  entry({
    fileName: 'dao-voting-app.dapp',
    name: 'BeamX DAO Voting',
    blurb: tk('Vote on BEAM community proposals'),
    guid: 'c26538f5ce9e410b89c1fd0dff783f97',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: 'ead5ae4454726a220322a41f486dceb7b287149a13c5105ffb85e2bf357f7b93',
    size: 2911424,
    remoteOrigins: [COINGECKO],
  }),
  entry({
    fileName: 'accum-dapp.dapp',
    name: 'Liquidity Accumulator',
    blurb: tk('Lock DEX liquidity for rewards'),
    guid: '7e9c916bc3444aadbd10232713be4525',
    version: '1.2.7',
    apiVersion: '7.0',
    minApiVersion: '6.0',
    sha256: '65a5a4cd633b247803078a9a8a0ff7c59ecba4afe4559b9136002f3461742f94',
    size: 4200960,
  }),
  entry({
    fileName: 'beam-asset-minter.dapp',
    name: 'Beam Asset Minter',
    blurb: tk('Create a confidential asset'),
    guid: '6e5151edf286458da42d11f3aef4969d',
    version: '1.0.29',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: '7d11c4ad243ec7a82ab092aba0124556b2ba768a5d66c218f343befeac891dbe',
    size: 2498315,
    remoteOrigins: [COINGECKO, BEAM_EXPLORER_API],
    iconExt: 'png',
  }),
  entry({
    fileName: 'beam-bridge-app.dapp',
    name: 'Bridges app',
    blurb: tk('Bring ETH and tokens to BEAM'),
    guid: '9811fa65e16b44b585ee22e227b0e2ee',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: 'e5ec2e38effb8f446a7ab70192f365aee01192b65b82011baf039d56c805fb73',
    size: 2266568,
    remoteOrigins: [COINGECKO, BEAM_EXPLORER_API],
  }),
  entry({
    fileName: 'beam-bridge-reverse-app.dapp',
    name: 'Beam to Ethereum bridge',
    blurb: tk('Move BEAM assets to Ethereum'),
    guid: '43d08c209df04c169005446d7eff51ab',
    version: '1.0.0',
    apiVersion: '7.0',
    minApiVersion: '7.0',
    sha256: '80bd1220ab35363ae683faaf766026387dead285817de3ac8fdc7906914f8092',
    size: 2265469,
    remoteOrigins: [COINGECKO, BEAM_EXPLORER_API],
  }),
]);

export function byGuid(guid) {
  return CATALOGUE.find((e) => e.guid === guid) || null;
}

export function sourceUrl(e) {
  return `${SOURCE_HOST}/BeamMW/beam-ui/${SOURCE_COMMIT}/ui/apps/mainnet/${e.fileName}`;
}

export function iconPath(e) {
  return `img/dapps/${e.guid}.${e.iconExt}`;
}

/** "5.3 MB" */
export function sizeText(bytes) {
  const mb = bytes / 1e6;
  return mb >= 1 ? t('{size} MB', { size: mb.toFixed(1) }) : t('{size} KB', { size: Math.max(1, Math.round(bytes / 1e3)) });
}

/** Host names only, for the words on screen ("api.coingecko.com"). */
export function hostOf(origin) {
  return new URL(origin).host;
}
