// When a random-node wallet gives up on its node and moves to the next one in
// the pool (lib/nodes.js). Pure: same inputs, same answer (test/unit/node_pool).
//
// "Answered" means the node completed the BEAM handshake (ev_connection_changed
// node_connected, engine patch 0104) or gave a block; an open WebSocket alone
// is not an answer.
// - unreachable: never answered, no WebSocket to it opened within 15 s, or two
//   attempts failed (the engine retries every 5 s).
// - silent: never answered, though sockets to it opened, for 45 s (it accepts
//   and says nothing, or closes every connection before the handshake).
// - dropped: it answered, then the connection was lost and not back for 20 s.
// - stalled: connected, but no new block or sync progress for 10 minutes.
//   BEAM makes a block a minute; ten minutes without one is the node, not
//   chance (about 1 in 22,000), and this rule needs no clock and no explorer.
// A whole round of the pool in which no node gave anything slows hops to one a
// minute (the person is offline, not the nodes); a round of stall hops that
// never shows a higher block stops stall hops until one appears (the network
// itself is quiet).

export const HEALTH = {
  connectTimeoutMs: 15000,
  failedAttempts: 2,
  silentMs: 45000,
  dropMs: 20000,
  stallMs: 600000,
  roundCooldownMs: 60000,
};

const stay = { switch: false, reason: null };
const go = (reason) => ({ switch: true, reason });

/**
 * @param {object} p
 * @param {number} p.now                  ms
 * @param {number} p.startedAt            ms, when the wallet started on this node
 * @param {object} p.guard                the node guard for this node: failures, everOpen, firstOpenAt (ms)
 * @param {boolean} p.answered            the node answered since this node was started
 * @param {number|null} p.answeredAt      ms of its first answer
 * @param {boolean} p.connected           connected to it now (the engine's view)
 * @param {number|null} p.lostAt          ms since when it is not connected (after it answered)
 * @param {number|null} p.lastProgressAt  ms of the last new block / tip / sync progress on this node
 * @param {boolean} p.importing           a recovery import is running (a restart would throw it away)
 */
export function assessNodeHealth({ now, startedAt, guard, answered = false, answeredAt = null, connected = false, lostAt = null, lastProgressAt = null, importing = false }) {
  if (importing) return stay;
  const g = guard || {};
  if (!answered) {
    if (!g.everOpen) return now - startedAt >= HEALTH.connectTimeoutMs || (g.failures || 0) >= HEALTH.failedAttempts ? go('unreachable') : stay;
    return now - (g.firstOpenAt || startedAt) >= HEALTH.silentMs ? go('silent') : stay;
  }
  if (!connected) return lostAt != null && now - lostAt >= HEALTH.dropMs ? go('dropped') : stay;
  const since = Math.max(answeredAt || startedAt, lastProgressAt || 0);
  return now - since >= HEALTH.stallMs ? go('stalled') : stay;
}

/**
 * Whether a hop the health check asks for may happen now.
 * @param {object} p
 * @param {string} p.reason     from assessNodeHealth
 * @param {number} p.now        ms
 * @param {number} p.poolSize
 * @param {number} p.emptyHops  consecutive hops away from nodes that gave no block or progress at all
 * @param {number} p.lastHopAt  ms of the last hop (0: none)
 * @param {number} p.staleHops  consecutive "stalled" hops that never showed a block above the best seen
 */
export function hopAllowed({ reason, now, poolSize, emptyHops = 0, lastHopAt = 0, staleHops = 0 }) {
  if (reason === 'stalled') return staleHops < poolSize;
  if (emptyHops >= poolSize) return now - lastHopAt >= HEALTH.roundCooldownMs;
  return true;
}
