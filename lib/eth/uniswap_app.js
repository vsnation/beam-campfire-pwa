// The Uniswap library (lib/eth/uniswap/) for the app's Ethereum wallet: one
// UniswapService per server, with the shipped pool list and a search cursor
// kept in the app's store (pool lists are public chain data); and the one way
// a swap or an approval leaves this device, the way a payment does
// (lib/eth/send.js): signed inside withEthKey (chain id 1 checked again, the
// nonce from 'pending', the key zeroed), saved to the sealed outbox BEFORE it
// is broadcast, then broadcast. The Permit2 signature is made the same way,
// only after the person confirmed the review. Nothing is signed while another
// transaction of this wallet is in doubt (lib/eth/doubt.js).

import { withEthKey } from './vault.js';
import { signTransaction, signPermitSingle, MAINNET_CHAIN_ID } from './tx.js';
import { toChecksumAddress } from './crypto.js';
import { addToOutbox } from './outbox.js';
import { broadcast } from './send.js';
import { assertNothingInDoubt } from './doubt.js';
import { ETH, TOKENS } from './tokens.js';
import { UniswapService } from './uniswap/service.js';
import { loadKnownPools, UniswapDiscovery } from './uniswap/discovery.js';
import { UniswapQuoter } from './uniswap/quoter.js';
import { secondOpinion } from './second_opinion.js';
import { ETH_TOKEN, uniTokenOf } from './uniswap/models.js';
import { store } from '../store.js';
import { t } from '../i18n.js';

/** ETH and the tokens the wallet knows, as the swap screen offers them. */
export const SWAP_TOKENS = Object.freeze([ETH_TOKEN, ...TOKENS.map(uniTokenOf)]);
export const WBEAM_TOKEN = SWAP_TOKENS.find((tok) => tok.symbol === 'WBEAM');

/** The tokens.js entry of a UniToken (for balances and badges). */
export function walletAsset(token) {
  return token.isEth ? ETH : TOKENS.find((x) => x.address === token.address) || null;
}

const STORE_PREFIX = 'uniswap-scan:';

/** Where discovery keeps how far each pool search got. */
export const poolStore = Object.freeze({
  read: (key) => store.get(`${STORE_PREFIX}${key}`),
  write: (key, scan) => store.set(`${STORE_PREFIX}${key}`, scan),
});

let known = null;
const services = new Map(); // server id -> UniswapService

function knownPools() {
  if (!known) known = loadKnownPools().catch((e) => {
    known = null;
    throw e;
  });
  return known;
}

/** The Uniswap service for the wallet's chosen server (one per server, so pool rankings are kept between screens). */
export async function uniswapFor(w) {
  const rpc = w.rpc;
  const id = rpc.host.id;
  const hit = services.get(id);
  if (hit && hit.rpc === rpc) return hit;
  const svc = new UniswapService({ rpc, known: await knownPools(), store: poolStore });
  services.set(id, svc);
  return svc;
}

/**
 * The amount out of `quote`'s route (the same pools, the same shares) as priced on `rpc`: only
 * eth_calls of the pools and quoters, nothing about the wallet. A throwaway pool store: the
 * second server's answers never become the chosen server's pool list.
 */
export function routeOutOn(rpc, quote, known) {
  return new UniswapQuoter({ rpc, discovery: new UniswapDiscovery({ rpc, known }) })
    .requote(quote)
    .then((q) => q.amountOut);
}

/**
 * The reviewed quote's route priced again on another listed Ethereum server (lib/eth/second_opinion.js).
 * Resolves to secondOpinion()'s {status, host, mine, theirs, gap}. makeRpc: for tests.
 */
export async function secondQuote(w, quote, { makeRpc = null } = {}) {
  const pools = await knownPools();
  return secondOpinion({ chosenId: w.rpc.host.id, mine: quote.amountOut, quoteOn: (rpc) => routeOutOn(rpc, quote, pools), ...(makeRpc ? { makeRpc } : {}) });
}

/** The Permit2 permit signed with the wallet's key: 65 bytes r ‖ s ‖ v. */
export function permitSigner(app, w) {
  return (permit) => withEthKey(app, ({ sk }) => signPermitSingle(permit, sk), w.kv);
}

/**
 * Signs an unsigned transaction from the service, saves it to the outbox, and
 * broadcasts it. meta: {kind: 'swap' | 'approve' | 'approveReset', asset
 * (tokens.js entry of what leaves), amount (bigint), extra (fields kept with
 * the entry)}. Returns broadcast()'s {entry, sent, error}. Refused (doubt.js
 * EthInDoubtError), before the key is opened, while another transaction of this
 * wallet is in doubt.
 */
export async function signAndBroadcast(app, w, tx, meta) {
  await assertNothingInDoubt(app, { ethId: w.ethId, kv: w.kv });
  const rpc = w.rpc;
  const signed = await withEthKey(
    app,
    async ({ sk, address }) => {
      await rpc.assertMainnet();
      const nonce = await rpc.getTransactionCount(address, 'pending');
      const s = signTransaction({ chainId: MAINNET_CHAIN_ID, nonce, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }, sk);
      if (s.from.toLowerCase() !== address.toLowerCase()) throw new Error(t('The signature does not belong to this wallet.'));
      return s;
    },
    w.kv,
  );
  const entry = {
    hash: signed.hash,
    raw: signed.raw,
    nonce: String(signed.nonce),
    from: signed.from,
    to: toChecksumAddress(tx.to),
    asset: meta.asset.symbol,
    token: meta.asset === ETH ? null : meta.asset.address,
    amount: String(meta.amount),
    gasLimit: String(tx.gasLimit),
    maxFeePerGas: String(tx.maxFeePerGas),
    maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas),
    createdAt: Date.now(),
    sentAt: null,
    state: 'signed',
    receipt: null,
    error: null,
    kind: meta.kind,
    ...(meta.extra || {}),
  };
  await addToOutbox(app, entry, { ethId: w.ethId, kv: w.kv });
  const r = await broadcast(app, rpc, entry, { ethId: w.ethId, kv: w.kv });
  await w.reloadOutbox().catch(() => {});
  return r;
}
