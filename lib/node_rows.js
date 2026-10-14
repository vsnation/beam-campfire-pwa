// What each of BEAM's public nodes says on the node screen (screens/node.js). Pure.

// A public node more than this many blocks under the wallet's own block is "Behind".
export const BEHIND_BLOCKS = 3;

const fmt = (n) => Number(n).toLocaleString('en-US');
// A number and its unit stay on one line (no-break spaces); a second or more reads in seconds.
export const took = (ms) => (ms < 1000 ? `${ms}\u00a0ms` : `${(ms / 1000).toFixed(1)}\u00a0s`);

/**
 * One row: (its address, the wallet's state, an own node in use?, its check
 * {state: 'checking'|'ok'|'down', height?, ms?} or undefined, the wallet's own block or 0)
 * -> {cls: 'ok'|'wait'|'bad', text, inUse, canUse}. "In use" is the node the wallet is on (or
 * trying) now; "Use this one" (canUse) only on a node that answered and is not behind.
 * "Behind" is measured against the wallet's own block only: the engine checks the chain it
 * follows, while a check only hears what a node says, so one node claiming a huge height cannot
 * make the others look behind and steer a pick.
 */
export function nodeRowState(address, s, own, check, walletHeight) {
  const inUse = !own && s.node === address;
  const height = s.status ? Number(s.status.current_height) || 0 : 0;
  if (inUse && s.nodeConnected) return { cls: 'ok', text: height ? `Block\u00a0${fmt(height)}` : 'Connected', inUse, canUse: false };
  if (!check) {
    if (inUse) return { cls: 'wait', text: 'Connecting…', inUse, canUse: false };
    return { cls: 'wait', text: own ? 'Not checked: you use your own node' : 'Not checked yet', inUse, canUse: false };
  }
  if (check.state === 'checking') return { cls: 'wait', text: 'Checking…', inUse, canUse: false };
  if (check.state === 'down') return { cls: 'bad', text: 'Not answering', inUse, canUse: false };
  const behind = walletHeight > 0 && check.height < walletHeight - BEHIND_BLOCKS;
  return { cls: behind ? 'bad' : 'ok', text: `${behind ? 'Behind: block' : 'Block'}\u00a0${fmt(check.height)} · ${took(check.ms)}`, inUse, canUse: !behind && !inUse };
}
