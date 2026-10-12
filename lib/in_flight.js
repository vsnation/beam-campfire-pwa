// What deleting a wallet takes with it that is the only record of coins still under way (release
// audit BM-4, BC-6), so the delete screen can say so first:
//   bridge   its open moves (lib/bridge/store.js): to BEAM, the coins can be found again from the
//            restored wallet ("Waiting for you on BEAM"), but the move's own record goes;
//   airdrop  saved batches whose codes may not all be claimed (lib/airdrop.js codeVault): the codes
//            are kept nowhere else, and they are the recipients' only key to the locked coins (the
//            creator can still take unclaimed value back from the chain);
//   buy      buys at buybeam.my still in progress (lib/buy/store.js): the deposit address is the
//            buy's only handle.
// The open wallet's records are opened and counted. A wallet that is locked, or not the open one,
// cannot be opened without its password: then only whether such records are kept is said (count
// null), and so is a record that does not open. Nothing here writes; nothing throws.
//
// inFlight(app, target, {kv}) -> [{kind: 'bridge' | 'airdrop' | 'buy', count: number | null}],
// only the kinds with something to say. kv: target's own store (lib/wallets.js walletStore).

const BRIDGE_KEY = 'bridge'; // lib/bridge/store.js BRIDGE_RECORD_KEY (not imported: it pulls in the sealing code)
const AIRDROP_KEY = 'airdropCodes'; // lib/airdrop.js VAULT_KEY
const BUY_KEY = 'buybeam'; // lib/buy/store.js BUY_RECORD_KEY

/** A batch nobody has finished with: on chain (or not yet known), with a code not known to be claimed or taken back. */
function mayHaveUnclaimed(b) {
  return b.txStatus !== 'failed' && b.codes.some((c) => c.status === 'available' || c.status === 'unknown');
}

async function present(kv, key) {
  try {
    const v = await kv.get(key);
    if (v == null) return false;
    if (key === BRIDGE_KEY) return Array.isArray(v.records) && v.records.length > 0;
    return true;
  } catch {
    return false;
  }
}

const COUNTERS = {
  bridge: {
    key: BRIDGE_KEY,
    async count(app, kv) {
      const { bridgeStoreFor, isOpen } = await import('./bridge/store.js');
      return (await bridgeStoreFor(app, kv).all()).filter(isOpen).length;
    },
  },
  airdrop: {
    key: AIRDROP_KEY,
    async count(app, kv) {
      const { codeVault } = await import('./airdrop.js');
      return (await codeVault({ kv, walletId: app.record.id, secret: app.dbPass, imported: Boolean(app.record.imported) }).all()).filter(mayHaveUnclaimed).length;
    },
  },
  buy: {
    key: BUY_KEY,
    async count(app, kv) {
      const { sealedBuyStore } = await import('./buy/store.js');
      return (await sealedBuyStore(app, { kv }).all()).filter((o) => o.isOpen).length;
    },
  },
};

export async function inFlight(app, target, { kv }) {
  const open = Boolean(app && app.dbPass && app.record && target && app.record.id === target.id);
  const out = [];
  for (const [kind, c] of Object.entries(COUNTERS)) {
    if (!(await present(kv, c.key))) continue;
    let count = null;
    if (open) {
      try {
        count = await c.count(app, kv);
      } catch {
        count = null; // kept, but it did not open: said to be there
      }
    }
    if (count === null || count > 0) out.push({ kind, count });
  }
  return out;
}
