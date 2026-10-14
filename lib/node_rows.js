// What each of BEAM's public nodes says on the node screen (screens/node.js). Pure.
import { t } from './i18n.js';

// A public node more than this many blocks under the wallet's own block is "Behind".
export const BEHIND_BLOCKS = 3;

const fmt = (n) => Number(n).toLocaleString('en-US');
// A number and its unit stay on one line (no-break spaces); a second or more reads in seconds.
export const took = (ms) => (ms < 1000 ? t('{n}\u00a0ms', { n: ms }) : t('{n}\u00a0s', { n: (ms / 1000).toFixed(1) }));

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
  if (inUse && s.nodeConnected) return { cls: 'ok', text: height ? t('Block\u00a0{height}', { height: fmt(height) }) : t('Connected'), inUse, canUse: false };
  if (!check) {
    if (inUse) return { cls: 'wait', text: t('Connecting…'), inUse, canUse: false };
    return { cls: 'wait', text: own ? t('Not checked: you use your own node') : t('Not checked yet'), inUse, canUse: false };
  }
  if (check.state === 'checking') return { cls: 'wait', text: t('Checking…'), inUse, canUse: false };
  if (check.state === 'down') return { cls: 'bad', text: t('Not answering'), inUse, canUse: false };
  const behind = walletHeight > 0 && check.height < walletHeight - BEHIND_BLOCKS;
  const block = { height: fmt(check.height), time: took(check.ms) };
  return { cls: behind ? 'bad' : 'ok', text: behind ? t('Behind: block\u00a0{height} · {time}', block) : t('Block\u00a0{height} · {time}', block), inUse, canUse: !behind && !inUse };
}
