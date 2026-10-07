// The one place "synced" is decided (mirrors lib/wallets/beam/sync/beam_sync_state.dart).
//
// "Synced" - and with it, permission to send - needs all of:
//   1. is_in_sync from the engine (it only means "last block <= 600 s old");
//   2. the tip timestamp is under 10 minutes old by this device's clock;
//   3. the engine is connected to its node in this session (an engine that
//      reopens within ten minutes reports is_in_sync before hearing a node);
//   4. the wallet is past the HF6 fork height whenever the network is;
//   5. a fresh explorer height (fetched through this origin) is at most 5
//      blocks ahead. With no usable explorer, the verdict is "synced" with
//      verified=false and the wording says the height could not be
//      double-checked. Blocking every send while a third party is down would
//      give that third party a switch over the wallet.
// No height constant ever grants "synced"; the fork height only denies it.
// Pure: same inputs, same answer.

export const HF6_HEIGHT = 3928666;
export const RULES = {
  maxTipAgeSec: 600,
  maxExplorerLag: 5,
  maxExplorerTipAgeSec: 600,
  maxExplorerFetchAgeSec: 180,
  blockSec: 60,
};

/**
 * @param {object} p
 * @param {object|null} p.status   last wallet_status result (or null)
 * @param {boolean} p.nodeConnected  a websocket to the node is open now
 * @param {boolean} p.everConnected  the node answered at least once this session
 * @param {boolean} p.connectFailed  no node connection for a while (the wallet decides how long)
 * @param {{height:number,timestamp:number,fetchedAt:number}|null} p.explorer
 * @param {number} p.now  unix seconds
 * @param {{done:number,total:number}|null} p.progress  engine sync progress
 * @param {boolean} p.importing  recovery import running
 */
export function assessSync({ status, nodeConnected, everConnected = nodeConnected, connectFailed = false, explorer, now, progress = null, importing = false }) {
  const height = status ? Number(status.current_height) || 0 : 0;
  const tipTs = status ? Number(status.current_state_timestamp) || 0 : 0;
  const tipAge = tipTs ? now - tipTs : Infinity;

  const ex = usableExplorer(explorer, now);
  const networkHeight = ex ? ex.height : null;
  const base = { height, networkHeight, canSend: false, verified: false, behindBlocks: null, tipAgeSec: Number.isFinite(tipAge) ? tipAge : null };

  if (importing) return { ...base, state: 'importing', title: 'Getting your wallet ready', detail: 'Reading the blockchain snapshot. Keep BEAM Campfire open.' };

  if (connectFailed && !nodeConnected) {
    return { ...base, state: 'offline', title: "Can't reach the BEAM network", detail: 'Check your internet connection, or pick another node in Settings. Sending is paused until it is back.' };
  }
  if (!everConnected || !status) {
    return { ...base, state: 'connecting', title: 'Connecting…', detail: 'Reaching the BEAM network.' };
  }
  if (!nodeConnected) {
    return { ...base, state: 'offline', title: "Can't reach the BEAM network", detail: 'Check your internet connection, or pick another node in Settings. Sending is paused until it is back.' };
  }

  // The fork check: a wallet below HF6 while the network is past it follows dead rules.
  if (ex && ex.height >= HF6_HEIGHT && height > 0 && height < HF6_HEIGHT) {
    return { ...base, state: 'stalled', behindBlocks: ex.height - height, title: 'This node is on an old chain', detail: 'Pick another node in Settings. Sending is paused.' };
  }

  let behind = null;
  if (ex) behind = Math.max(0, ex.height - height);
  else if (Number.isFinite(tipAge) && tipAge > RULES.maxTipAgeSec) behind = Math.round(tipAge / RULES.blockSec);

  const fresh = status.is_in_sync === true && tipAge <= RULES.maxTipAgeSec && tipAge > -120;
  if (!fresh) {
    const pct = progress && progress.total > 0 ? Math.floor((progress.done * 100) / progress.total) : null;
    const b = behind != null && behind > 0 ? behind : null;
    return {
      ...base,
      state: 'syncing',
      behindBlocks: b,
      percent: pct,
      title: b ? `Catching up: ${b.toLocaleString('en-US')} block${b === 1 ? '' : 's'} behind` : 'Catching up with the network',
      detail: 'Sending is paused until your wallet is up to date.',
    };
  }

  if (ex && ex.height - height > RULES.maxExplorerLag) {
    return {
      ...base,
      state: 'behind',
      behindBlocks: ex.height - height,
      title: `${(ex.height - height).toLocaleString('en-US')} blocks behind the network`,
      detail: 'Your node is behind. Sending is paused; pick another node in Settings if this lasts.',
    };
  }

  if (ex && height - ex.height <= RULES.maxExplorerLag) {
    return { ...base, state: 'synced', canSend: true, verified: true, behindBlocks: 0, title: 'Synced', detail: `Block ${height.toLocaleString('en-US')}, confirmed by a second source.` };
  }
  return {
    ...base,
    state: 'synced',
    canSend: true,
    verified: false,
    behindBlocks: 0,
    title: 'Synced',
    detail: `Block ${height.toLocaleString('en-US')}. Can't double-check with the network right now.`,
  };
}

function usableExplorer(explorer, now) {
  if (!explorer || !Number.isSafeInteger(explorer.height) || explorer.height <= 0) return null;
  if (explorer.fetchedAt && now - explorer.fetchedAt > RULES.maxExplorerFetchAgeSec) return null;
  if (explorer.timestamp && now - explorer.timestamp > RULES.maxExplorerTipAgeSec) return null;
  return explorer;
}
