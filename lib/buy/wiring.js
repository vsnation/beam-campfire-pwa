// Buy BEAM for the unlocked wallet: one controller per wallet (buys sealed in
// the app's store, requests to buybeam.my), a new BEAM address of this wallet
// for each buy, and whether the BEAM a buy delivered is in the wallet yet.
// The desktop app's lib/pages/beam/buy/buy_beam_wiring.dart, for the PWA's
// one wallet.
//
// Open buys are followed only while the wallet is unlocked and the page is
// visible: hiding the page pauses the controller, locking disposes of it and
// forgets the key the buys are sealed with.

import { BuyBeamClient } from './buybeam.js';
import { BuyBeamController } from './controller.js';
import { sealedBuyStore, forgetBuyKeys, hasBuys } from './store.js';
import { store } from '../store.js';
import { walletStore } from '../wallet_scope.js';
import { wallet } from '../wallet.js';
import { t } from '../i18n.js';

/** The comment on the BEAM addresses made for buys, as the desktop app names them. */
export const BUY_ADDRESS_COMMENT = 'Buy BEAM'; // i18n-ignore: written into the wallet as the address's comment, the desktop app's name for it

/** Thrown by newBuyAddress() while the BEAM wallet is not running yet. */
export class WalletNotReady extends Error {
  constructor() {
    super('The BEAM wallet is still starting.'); // i18n-ignore: for logs; Buy BEAM says it in its own words (instanceof WalletNotReady)
    this.code = 'wallet_not_ready';
  }
}

let current = null; // {walletId, controller}
let hooked = false;

function stop() {
  if (current) current.controller.dispose();
  current = null;
  forgetBuyKeys();
}

/** The buy controller of the unlocked wallet, created (and its open buys followed) on first use. */
export function buyBeam(app) {
  if (!app || !app.dbPass || !app.record) throw new Error(t('Unlock the wallet first.'));
  if (current && current.walletId === app.record.id) return current.controller;
  stop();
  // Bound to this wallet: a buy's update that lands after a switch still goes to its own buys.
  const controller = new BuyBeamController({ client: new BuyBeamClient(), store: sealedBuyStore(app, { kv: walletStore(app.record) }) });
  current = { walletId: app.record.id, controller };
  if (!hooked) {
    hooked = true;
    app.lockHooks.add(stop);
    document.addEventListener('visibilitychange', () => {
      if (!current) return;
      if (document.visibilityState === 'visible') current.controller.resume();
      else current.controller.pause();
    });
  }
  if (document.visibilityState !== 'visible') controller.pause();
  controller.resumeAll();
  return controller;
}

/** Follows this wallet's open buys when it keeps any (Home calls it: one store read when there are none). */
export async function followBuys(app) {
  try {
    if (await hasBuys(store)) buyBeam(app);
  } catch {
    // Following is a convenience: the buy's own screen asks again.
  }
}

/** A new regular BEAM address of this wallet for one buy. */
export async function newBuyAddress() {
  if (!wallet.session) throw new WalletNotReady();
  const addr = await wallet.session.call('create_address', { type: 'regular', expiration: 'never', comment: BUY_ADDRESS_COMMENT }, { timeoutMs: 20000 });
  if (typeof addr !== 'string' || !addr) throw new Error('The wallet did not make an address.'); // i18n-ignore: for logs; Buy BEAM shows its own sentence for any failure here
  await wallet.persistNow();
  return addr;
}

/** Whether this wallet has the BEAM transaction txId, received and completed. */
export function receivedInWallet(txId) {
  if (!txId) return false;
  return wallet.state.txs.some((tx) => tx.txId === txId && tx.income && Number(tx.status) === 3);
}
