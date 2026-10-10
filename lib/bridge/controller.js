// The bridge between one BEAM wallet and one Ethereum wallet of the same
// person: what a crossing costs and whether it can go (quote), the checked
// transactions it needs (prepare), sending them (start, collect), and
// following each crossing to the end, also after the page is closed
// (resumeAll), from records written before every step that cannot be undone
// (store.js). A port of the desktop app's bridge_controller.dart.
//
// To Ethereum: the BEAM pipe locks amount + fee and records a message; the
// bridge pays the Ethereum wallet about 61 BEAM blocks later, by itself (its
// relayer pays the gas: nothing for the person to do). Campfire finds the
// message the send created (the only one above the count read before sending
// with this receiver, amount, fee and block), waits out the blocks, then reads
// the Ethereum pipe's "paid" flag.
//
// To BEAM: the Ethereum pipe takes value + fee (after an exact approval for a
// token); the bridge brings the message to BEAM in a few minutes; then the
// crossing waits at "delivered" (ready to collect) until the person collects
// it: collect() builds the BEAM claim and shows it for their consent. Nothing
// is collected automatically.
//
// The rule from the BEAM DEX confirmation holds everywhere: a transaction that
// may have reached the network is never sent again as a new one. An Ethereum
// transaction is signed, its hash and exact bytes written, and only then
// broadcast; if the server later does not know it, the identical bytes go
// again (never a second signature). When the BEAM wallet throws after it may
// have sent, the crossing is "unknown" and Campfire keeps looking for it.
//
// Polling runs only while the caller says the page is visible and the wallet
// unlocked (setActive). Times are ms; the clock is {now(), sleep(ms)}.
//
// The two halves (fakes in the tests):
//   beam  receiveKey(route), localMessageCount(route), localMessage(route, id),
//         remoteMessage(route, id), incoming(route, {startFrom}),
//         send(route, {ethReceiver, amount, fee}) → txId (consent inside),
//         claim(route, {msgId, amount}) → txId (consent inside),
//         txStatus(txId) → {state: 'pending'|'completed'|'failed', height, reason},
//         tipHeight(), available(assetId)
//         (beamSide() below builds it from beam_pipe.js and lib/wallet.js)
//   eth   eth_pipe.js EthPipe: owner, freezes, relayerGas, balance, ethBalance,
//         planLock, sign, broadcast, known, succeeded, lockResult, isPaid
//   prices prices.js PriceFeed: usd(ids)

import { SEND_FEE, CLAIM_FEE, BEAM_CONFIRMATIONS, routeById } from './routes.js';
import { BridgeError, checkSendAmounts, ethReceiver } from './beam_pipe.js';
import { STATES, DIRECTIONS, makeCrossing, changeCrossing, isOpen, checkUnique, crossingToJson } from './store.js';
import { readConditions, quoteToEthereum, quoteToBeam, makeQuote, makeBlock, BLOCKS, REVIEW_AGE_MS, TIMING, coinText, sourceGrid } from './quote.js';
import { floorToGrid } from './fees.js';

/** How often each kind of crossing is looked at. */
export const POLLING = Object.freeze({
  beamTxMs: 20000, // a BEAM transaction (send or claim) until it is mined
  blocksMs: 60000, // the 61 confirmations before the bridge pays
  paidMs: 60000, // the Ethereum pipe's "paid" flag
  toBeamMs: 30000, // a crossing to BEAM, until it is ready to collect
  ethReceiptMs: 15000, // an Ethereum transaction until it is mined
  tickMs: 5000, // how often the controller checks what is due
});

const CONDITIONS_MS = 60000;

export const systemClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const STORAGE_FAILED = (sym) => `Campfire could not write to this device's storage, so it did not send your ${sym}. Nothing was moved.`;
const ELSEWHERE = 'Collected outside this screen (on another device with the same wallet, perhaps).';

/** The message of an error as the person reads it. */
const plain = (e) => (e && typeof e.message === 'string' && e.message ? e.message : String(e));

/**
 * Whether a BEAM-side error means nothing reached the network: the person
 * declined (or the consent sheet timed out or was closed), a check refused the
 * built transaction before the engine sent it, or the pipe refused to build it.
 * Anything else may have gone out.
 */
export function nothingSent(e) {
  if (!e || typeof e.code !== 'string') return false;
  if (['rejected', 'refused', 'badArgs', 'badAmount', 'badPipe', 'shader'].includes(e.code)) return true;
  // The refusals made before process_invoke_data say so in these words (lib/contracts.js, beam_pipe.js).
  return e.code === 'unexpected' && /Nothing was sent\.$/.test(e.message || '');
}

/**
 * Whether a message the pipe stamped `recorded` was made by a transaction mined
 * in block `mined`. The pipe stamps the chain's height while that block is
 * applied, one below it (mainnet: mined in 4072998, stamped 4072997); the block
 * itself is accepted too.
 */
export const sameBlock = (recorded, mined) => recorded === mined - 1 || recorded === mined;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function newId(now) {
  const r = new Uint8Array(4);
  globalThis.crypto.getRandomValues(r);
  return `x${now}${hex(r)}`;
}

/** Two records that differ only in updatedAt. */
function sameRecord(a, b) {
  if (a === b) return true;
  const ja = { ...crossingToJson(a), updatedAt: 0 };
  const jb = { ...crossingToJson(b), updatedAt: 0 };
  return JSON.stringify(ja) === JSON.stringify(jb);
}

export class BridgeController {
  #records = new Map();
  #dueAt = new Map();
  #busy = new Set();
  #conditions = new Map();
  #keys = new Map();
  #started = new WeakSet();
  #listeners = new Set();
  #inflight = new Set();
  #polls = new Map();
  #timer = null;
  #resuming = null;
  #active = false;
  #disposed = false;
  #tip = null;

  /**
   * beam, eth, prices: the two halves and the price feed (see the top of this file).
   * store: store.js SealedBridgeStore (or MemoryBridgeStore).
   * beamWalletId, ethWalletId: whose crossings these are.
   * autoPoll: poll on a timer while active (tests call pollDue() themselves).
   */
  constructor({ beam, eth, prices, store, beamWalletId, ethWalletId, clock = systemClock, polling = POLLING, autoPoll = true }) {
    this.beam = beam;
    this.eth = eth;
    this.prices = prices;
    this.store = store;
    this.beamWalletId = beamWalletId;
    this.ethWalletId = ethWalletId;
    this.clock = clock;
    this.polling = polling;
    this.autoPoll = autoPoll;
  }

  // ------------------------------------------------------------- state

  /** The BEAM chain tip last read, for "blocks left". */
  get tipHeight() {
    return this.#tip;
  }

  /** Whether polling runs (the caller said: visible and unlocked). */
  get active() {
    return this.#active;
  }

  /** This wallet pair's crossings: open ones first, newest first. */
  get crossings() {
    return [...this.#records.values()].sort((a, b) => {
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }

  crossing(id) {
    return this.#records.get(id) || null;
  }

  /** BEAM blocks left before the bridge pays c (to Ethereum), when the tip is known. */
  blocksLeft(c) {
    if (c.height === null || this.#tip === null) return null;
    return Math.max(0, c.height + BEAM_CONFIRMATIONS - this.#tip);
  }

  /** fn() after every change; returns an unsubscribe function. */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    if (this.#disposed) return;
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  #mine(c) {
    return c.beamWalletId === this.beamWalletId && c.ethWalletId === this.ethWalletId;
  }

  #ch(c, patch) {
    return changeCrossing(c, { ...patch, updatedAt: this.clock.now() });
  }

  /** Resolves when every Ethereum step sequence started here has finished (tests, and a clean lock). */
  async idle() {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
  }

  // ------------------------------------------------------------- reading

  /** Freezes, the bridge fee and its prices for route going direction, read at most once a minute unless refresh. */
  async conditions(route, direction, { refresh = false } = {}) {
    const key = `${route.id}-${direction}`;
    const cached = this.#conditions.get(key);
    const now = this.clock.now();
    if (!refresh && cached && now - cached.at < CONDITIONS_MS) return cached.c;
    const c = await readConditions({ route, direction, eth: this.eth, prices: this.prices, now });
    this.#conditions.set(key, { c, at: now });
    return c;
  }

  /** What route going direction can draw on: {source, beam, eth}. */
  async balances(route, direction) {
    if (direction === DIRECTIONS.toEthereum) {
      const beam = await this.beam.available(0);
      return Object.freeze({ source: route.isBeam ? beam : await this.beam.available(route.beamAssetId), beam, eth: null });
    }
    const [source, eth, beam] = await Promise.all([this.eth.balance(route), this.eth.ethBalance(), this.beam.available(0)]);
    return Object.freeze({ source, beam, eth });
  }

  async #receiveKey(route) {
    if (!this.#keys.has(route.id)) this.#keys.set(route.id, await this.beam.receiveKey(route));
    return this.#keys.get(route.id);
  }

  // ------------------------------------------------------------- quote

  /**
   * What moving `amount` (source units) of route going direction does, and
   * whether it can go. Never throws for a reason the person can act on: that
   * is in quote.block.
   */
  async quote(route, direction, amount) {
    const cond = await this.conditions(route, direction);
    const now = this.clock.now();
    let bal;
    try {
      bal = await this.balances(route, direction);
    } catch {
      return makeQuote({
        route,
        direction,
        amount,
        cond,
        balances: Object.freeze({ source: 0n, beam: 0n, eth: 0n }),
        ethAddress: this.eth.owner,
        now,
        blockReason: makeBlock(BLOCKS.network, "Couldn't read your balances", 'One of your wallets did not answer. Nothing was sent; try again in a minute.'),
      });
    }
    if (direction === DIRECTIONS.toEthereum) return quoteToEthereum({ route, amount, cond, balances: bal, ethAddress: this.eth.owner, now });
    return quoteToBeam({
      route,
      amount,
      cond,
      balances: bal,
      ethAddress: this.eth.owner,
      now,
      receiveKey: () => this.#receiveKey(route),
      planLock: (r, a) => this.eth.planLock(r, a),
    });
  }

  /** The most of route that can leave going direction, every fee kept back; zero when nothing can (or the fee is unknown). */
  async maxAmount(route, direction) {
    const cond = await this.conditions(route, direction);
    if (cond.fee == null) return 0n;
    const bal = await this.balances(route, direction);
    let max = bal.source - cond.fee;
    if (direction === DIRECTIONS.toEthereum) {
      if (route.isBeam) max -= SEND_FEE;
      if (route.maxGroth != null && max > route.maxGroth) max = route.maxGroth;
    } else if (route.isNativeEth) {
      // Keep the network fee of the lock itself (priced on a tiny value).
      try {
        const plan = await this.eth.planLock(route, { value: route.ethGrid, fee: cond.fee, receiverKey: await this.#receiveKey(route) });
        max -= plan.maxGasCost;
      } catch {
        return 0n;
      }
    }
    if (max <= 0n) return 0n;
    return floorToGrid(max, sourceGrid(route, direction));
  }

  // ------------------------------------------------------------- prepare

  /**
   * Checks what q sends, nothing is sent: to Ethereum, the amounts and the
   * receiver (the BEAM transaction itself is built, checked and shown for
   * consent by start); to BEAM, the key read again and the Ethereum
   * transactions priced again. → {quote, at, receiveKey, plan}
   */
  async prepare(q) {
    if (q.block) throw new BridgeError('badAmount', q.block.title);
    const route = q.route;
    const fee = q.fee;
    const now = this.clock.now();
    if (q.direction === DIRECTIONS.toEthereum) {
      checkSendAmounts(route, q.amount, fee);
      ethReceiver(this.eth.owner);
      return Object.freeze({ quote: q, at: now, receiveKey: null, plan: null });
    }
    const key = await this.beam.receiveKey(route);
    this.#keys.set(route.id, key);
    if (q.receiveKey && !sameBytes(key, q.receiveKey)) {
      throw new BridgeError('unexpectedTransaction', 'Your BEAM wallet gave a different key than a moment ago. Nothing was sent.');
    }
    const plan = await this.eth.planLock(route, { value: q.amount, fee, receiverKey: key });
    if (plan.route !== route || plan.value !== q.amount || plan.fee !== fee || !sameBytes(plan.receiverKey, key) || !plan.steps.length) {
      throw new BridgeError('unexpectedTransaction', 'The Ethereum transactions are not the ones asked for. Nothing was sent.');
    }
    const ethBal = await this.eth.ethBalance();
    const need = plan.maxGasCost + (route.isNativeEth ? q.amount + fee : 0n);
    if (need > ethBal) {
      throw new BridgeError('badAmount', `The Ethereum network fee went up: this now needs up to ${coinText(need, 18)} ETH and your wallet has ${coinText(ethBal, 18)} ETH. Nothing was sent.`);
    }
    return Object.freeze({ quote: q, at: this.clock.now(), receiveKey: key, plan });
  }

  // ------------------------------------------------------------- start

  /**
   * Sends p and returns its crossing, which Campfire then follows. To Ethereum
   * the BEAM transaction goes through the wallet's consent sheet before this
   * returns; to BEAM the Ethereum transactions go out one by one after it
   * returns (the crossing says which). Throws only when nothing was sent.
   */
  async start(p) {
    if (this.#disposed) throw new BridgeError('closed', 'The bridge is closed.');
    if (!p || !p.quote) throw new BridgeError('badArgs', 'Nothing prepared to send.');
    if (this.clock.now() - p.at > REVIEW_AGE_MS) throw new BridgeError('reviewExpired', 'This review is more than 15 minutes old; check it again.');
    if (this.#started.has(p)) throw new BridgeError('alreadySent', 'This crossing was already sent.');
    // Every known message id of this pair, before any new one is taken.
    await this.resumeAll();
    const q = p.quote;
    const route = q.route;
    const now = this.clock.now();
    const base = {
      id: newId(now),
      route: route.id,
      direction: q.direction,
      amount: q.amount,
      receives: q.receives,
      relayerFee: q.fee,
      beamWalletId: this.beamWalletId,
      ethWalletId: this.ethWalletId,
      ethAddress: this.eth.owner,
      createdAt: now,
      updatedAt: now,
    };

    if (q.direction === DIRECTIONS.toEthereum) {
      // Read before sending: the send's message is above it.
      const countBefore = await this.beam.localMessageCount(route);
      let c = makeCrossing({ ...base, state: STATES.sending, beamNetworkFee: SEND_FEE, countBefore });
      this.#started.add(p);
      try {
        await this.#save(c);
      } catch (e) {
        this.#started.delete(p);
        throw e;
      }
      try {
        const txId = await this.beam.send(route, { ethReceiver: this.eth.owner, amount: q.amount, fee: q.fee });
        c = this.#ch(c, { state: STATES.sent, beamTxId: txId });
      } catch (e) {
        c = nothingSent(e)
          ? this.#ch(c, { state: STATES.failed, lastError: e.code === 'rejected' ? 'You did not approve it, so nothing left your wallet.' : `${plain(e)} Nothing left your wallet.`, finishedAt: this.clock.now() })
          : this.#ch(c, { state: STATES.unknown, lastError: plain(e) });
      }
      await this.#saveQuietly(c);
      if (isOpen(c)) this.#schedule(c, this.polling.beamTxMs);
      return c;
    }

    const plan = p.plan;
    const c = makeCrossing({
      ...base,
      state: plan.steps.length > 1 ? STATES.approving : STATES.locking,
      beamNetworkFee: CLAIM_FEE,
      ethNetworkFee: plan.maxGasCost,
      beamReceiveKey: hex(p.receiveKey),
    });
    this.#started.add(p);
    try {
      await this.#save(c);
    } catch (e) {
      this.#started.delete(p);
      throw e;
    }
    // Polling leaves it alone while its steps are being sent.
    this.#busy.add(c.id);
    const run = this.#sendLockSteps(c, plan)
      .catch((e) => {
        // Every step records its own failure; this is a bug's last net.
        console.error('[campfire] bridge lock steps stopped', e);
      })
      .finally(() => {
        this.#busy.delete(c.id);
        this.#inflight.delete(run);
      });
    this.#inflight.add(run);
    return c;
  }

  /**
   * The approvals (each mined before the next step), then the lock. Each step
   * is signed (after a fresh freeze check, inside eth.sign), its hash and bytes
   * written, and only then broadcast.
   */
  async #sendLockSteps(first, plan) {
    let c = first;
    const sym = routeById(c.route).ethSymbol;
    const failed = async (lastError, extra = {}) => {
      c = this.#ch(c, { ...extra, state: STATES.lockFailed, lastError, finishedAt: this.clock.now() });
      await this.#saveQuietly(c);
    };
    const steps = plan.steps;
    for (let i = 0; i < steps.length; i++) {
      if (this.#disposed) return; // still "approving": a restart ends it as nothing locked
      const isLock = i === steps.length - 1;
      if (isLock && c.state !== STATES.locking) {
        c = this.#ch(c, { state: STATES.locking });
        // Not written, so not sent.
        if (!(await this.#saveQuietly(c))) return failed(STORAGE_FAILED(sym));
      }
      let signed;
      try {
        signed = await this.eth.sign(steps[i]);
      } catch (e) {
        return failed(isLock ? `Your ${sym} was not sent: ${plain(e)} Nothing was moved.` : `Letting the bridge take ${sym} did not go through, so nothing was moved. (${plain(e)})`);
      }
      // Written before it is broadcast: the hash, and for the lock the exact bytes.
      c = isLock ? this.#ch(c, { lockHash: signed.hash, lockRaw: signed.raw, lockNonce: signed.nonce }) : this.#ch(c, { approveHashes: [...c.approveHashes, signed.hash] });
      if (!(await this.#saveQuietly(c))) return failed(STORAGE_FAILED(sym), isLock ? { lockHash: null, lockRaw: null, lockNonce: null } : {});
      let sendError = null;
      try {
        await this.eth.broadcast(signed.raw);
      } catch (e) {
        sendError = e;
      }
      if (isLock) {
        if (sendError) {
          // The hash is known either way: Campfire looks for it, and sends the
          // same signed bytes again while Ethereum does not have them.
          c = this.#ch(c, { lastError: `Ethereum did not confirm it received your ${sym} (${plain(sendError)}). Campfire keeps looking for it and sends the same signed transaction again if needed; it never signs a second one.` });
          await this.#saveQuietly(c);
        }
        this.#schedule(c, this.polling.ethReceiptMs);
        return undefined;
      }
      // An approval moves nothing: even if it reached Ethereum, nothing is locked.
      if (sendError) return failed(`Letting the bridge take ${sym} did not go through, so nothing was moved. (${plain(sendError)})`);
      const until = this.clock.now() + TIMING.approveWaitMs;
      let ok = null;
      for (;;) {
        ok = await this.eth.succeeded(signed.hash).catch(() => null);
        if (ok !== null || this.#disposed) break;
        if (this.clock.now() > until) break;
        await this.#sendAgainIfLost(signed.hash, signed.raw);
        await this.clock.sleep(this.polling.ethReceiptMs);
      }
      if (this.#disposed) return undefined;
      if (ok !== true) {
        return failed(
          ok === false
            ? `Letting the bridge take ${sym} failed on Ethereum, so nothing was moved. Only its network fee was spent.`
            : `Letting the bridge take ${sym} was not confirmed within 30 minutes, so nothing was moved.`,
        );
      }
    }
    return undefined;
  }

  /**
   * Broadcasts the identical signed bytes again when the server does not know
   * `hash` (dropped from its pool, or the first broadcast never arrived).
   * Returns null when nothing had to be done or it went, else the error.
   */
  async #sendAgainIfLost(hash, raw) {
    if (!raw) return null;
    try {
      if (await this.eth.known(hash)) return null;
      await this.eth.broadcast(raw);
      return null;
    } catch (e) {
      return e;
    }
  }

  // ------------------------------------------------------------- collect

  /**
   * Collects crossing id (to BEAM, ready to collect): builds the BEAM claim,
   * which the wallet checks and shows for the person's consent, and sends it.
   * The only way a crossing to BEAM is claimed. Throws when nothing was sent.
   */
  async collect(id) {
    // A look under way (poll) is not a collect in progress: let it finish (it may find the
    // coins collected elsewhere), then read the record again.
    while (this.#polls.has(id)) await this.#polls.get(id);
    const from = this.#records.get(id);
    if (!from || from.state !== STATES.delivered) throw new BridgeError('badAmount', 'There is nothing to collect for this crossing right now.');
    if (this.#busy.has(id)) throw new BridgeError('alreadySent', 'This crossing is being collected.');
    this.#busy.add(id);
    try {
      return await this.#collect(from);
    } finally {
      this.#busy.delete(id);
    }
  }

  async #collect(from) {
    let c = from;
    const route = routeById(c.route);
    const have = await this.beam.available(0);
    if (have < CLAIM_FEE) {
      throw new BridgeError('badAmount', `Your BEAM wallet needs ${coinText(CLAIM_FEE, 8)} BEAM for the network fee of collecting it, and has ${coinText(have, 8)} BEAM. Receive a little BEAM first.`);
    }
    const m = await this.beam.remoteMessage(route, c.msgId);
    if (!m) {
      // The pipe no longer has it: it was collected, by us or elsewhere.
      await this.#markCollectedElsewhere(c);
      throw new BridgeError('alreadySent', 'It was already collected: it is in your BEAM wallet.');
    }
    if (m.amount !== c.receives) {
      await this.#saveQuietly(this.#ch(c, { state: STATES.unknown, lastError: `It arrived on BEAM with a different amount (${coinText(m.amount, 8)} ${route.beamSymbol}). Campfire will not collect it.` }));
      throw new BridgeError('unexpectedTransaction', 'It arrived on BEAM with a different amount than was sent. Nothing was collected.');
    }
    c = this.#ch(c, { state: STATES.claiming, claimStartedAt: this.clock.now(), beamNetworkFee: CLAIM_FEE, lastError: null });
    // Written before the claim can be sent; not written, not sent.
    await this.#save(c);
    try {
      const txId = await this.beam.claim(route, { msgId: c.msgId, amount: c.receives });
      c = this.#ch(c, { claimTxId: txId });
    } catch (e) {
      if (nothingSent(e)) {
        // Back to "ready to collect": nothing was sent.
        if (e.code === 'badPipe' && !(await this.beam.remoteMessage(route, c.msgId).catch(() => m))) {
          await this.#markCollectedElsewhere(c);
          throw new BridgeError('alreadySent', 'It was already collected: it is in your BEAM wallet.');
        }
        await this.#saveQuietly(this.#ch(c, { state: STATES.delivered, claimStartedAt: null, lastError: e.code === 'rejected' ? null : plain(e) }));
        throw e;
      }
      // It may have gone out: Campfire watches the message instead.
      c = this.#ch(c, { lastError: plain(e) });
    }
    await this.#saveQuietly(c);
    this.#schedule(c, this.polling.beamTxMs);
    return c;
  }

  async #markCollectedElsewhere(c) {
    const ours = c.claimTxId !== null && (await this.beam.txStatus(c.claimTxId).catch(() => null))?.state === 'completed';
    await this.#saveQuietly(this.#ch(c, { state: STATES.claimed, lastError: ours ? null : ELSEWHERE, finishedAt: this.clock.now() }));
  }

  // ------------------------------------------------------------- tracking

  /**
   * Loads this wallet pair's crossings and follows the open ones (call on
   * unlock). A crossing caught between steps by a restart is settled first:
   * one that was about to approve sent nothing; one that was sending may have
   * sent, and is looked for.
   */
  resumeAll() {
    if (this.#disposed) return Promise.resolve();
    if (!this.#resuming) {
      this.#resuming = this.#resume().catch((e) => {
        this.#resuming = null;
        throw e;
      });
    }
    return this.#resuming;
  }

  async #resume() {
    for (const stored of await this.store.all()) {
      if (!this.#mine(stored)) continue;
      let c = stored;
      if (isOpen(c)) {
        c = this.#afterRestart(c);
        if (c !== stored) await this.#saveQuietly(c);
        this.#dueAt.set(c.id, this.clock.now());
      }
      this.#records.set(c.id, c);
    }
    this.#startTimer();
    this.#emit();
    if (this.#active && this.autoPoll) this.pollDue().catch(() => {});
  }

  #afterRestart(c) {
    const now = this.clock.now();
    const sym = routeById(c.route).ethSymbol;
    switch (c.state) {
      case STATES.approving:
        // The lock is only signed after this record says "locking".
        return this.#ch(c, {
          state: STATES.lockFailed,
          lastError: `Campfire was closed before your ${sym} was sent, so nothing was moved. Start again: the permission you gave is kept, so it is one step this time.`,
          finishedAt: now,
        });
      case STATES.sending:
        return this.#ch(c, { state: STATES.unknown, lastError: 'Campfire was closed while sending.' });
      case STATES.locking:
        return c.lockHash ? c : this.#ch(c, { state: STATES.unknown, lastError: 'Campfire was closed while sending.' });
      default:
        return c;
    }
  }

  /**
   * Polling runs only while the page is visible and the wallet unlocked; the
   * caller says which (on visibilitychange, lock and unlock).
   */
  setActive({ visible, unlocked }) {
    const active = visible === true && unlocked === true && !this.#disposed;
    if (active === this.#active) return;
    this.#active = active;
    if (!active) {
      this.#stopTimer();
      return;
    }
    this.#startTimer();
    if (this.autoPoll) this.pollDue().catch(() => {});
  }

  #startTimer() {
    if (!this.autoPoll || !this.#active || this.#disposed || this.#timer) return;
    this.#timer = setInterval(() => this.pollDue().catch(() => {}), this.polling.tickMs);
  }

  #stopTimer() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #schedule(c, after) {
    this.#dueAt.set(c.id, this.clock.now() + after);
    this.#startTimer();
  }

  /** Looks at every open crossing whose turn it is (only while active). */
  async pollDue() {
    if (this.#disposed || !this.#active) return;
    const now = this.clock.now();
    const due = [...this.#records.values()].filter((c) => isOpen(c) && !this.#busy.has(c.id) && !((this.#dueAt.get(c.id) ?? 0) > now)).map((c) => c.id);
    for (const id of due) {
      if (!this.#active || this.#disposed) return;
      await this.poll(id);
    }
  }

  /** Looks at crossing id once, now (the caller asked), and schedules the next look. */
  poll(id) {
    const c = this.#records.get(id);
    if (!c || !isOpen(c) || this.#disposed || this.#busy.has(id)) return Promise.resolve(c || null);
    this.#busy.add(id);
    const run = this.#look(id, c).finally(() => {
      if (this.#polls.get(id) === run) this.#polls.delete(id);
    });
    this.#polls.set(id, run);
    return run;
  }

  async #look(id, c) {
    try {
      const [next, wait] = c.direction === DIRECTIONS.toEthereum ? await this.#stepToEthereum(c) : await this.#stepToBeam(c);
      if (!sameRecord(next, c)) await this.#saveQuietly(next);
      if (isOpen(next)) this.#dueAt.set(id, this.clock.now() + wait);
      return next;
    } catch (e) {
      // A node that did not answer: the same question next time.
      console.warn('[campfire] following a crossing failed', plain(e));
      this.#dueAt.set(id, this.clock.now() + this.polling.blocksMs);
      return c;
    } finally {
      this.#busy.delete(id);
    }
  }

  async #stepToEthereum(c) {
    const route = routeById(c.route);
    const P = this.polling;
    switch (c.state) {
      case STATES.sent: {
        const s = await this.beam.txStatus(c.beamTxId);
        if (s.state === 'pending') return [c, P.beamTxMs];
        if (s.state === 'failed') return [this.#ch(c, { state: STATES.failed, lastError: s.reason || 'The BEAM transaction failed.', finishedAt: this.clock.now() }), P.beamTxMs];
        const h = s.height;
        const msgId = await this.#findLocalMessage(c, h);
        if (msgId === null) return [c.height === h ? c : this.#ch(c, { height: h }), P.beamTxMs];
        return this.#stepToEthereum(this.#ch(c, { state: STATES.confirmed, msgId, height: h, lastError: null }));
      }
      case STATES.unknown:
      case STATES.sending: {
        if (c.beamTxId) return this.#stepToEthereum(this.#ch(c, { state: STATES.sent }));
        // No transaction id: look for the message it would have made.
        const found = await this.#findLocalMessageAnyHeight(c);
        if (!found) return [c, P.blocksMs];
        // The block it was mined in: one above the pipe's stamp.
        return this.#stepToEthereum(this.#ch(c, { state: STATES.confirmed, msgId: found[0], height: found[1] + 1, lastError: null }));
      }
      case STATES.confirmed:
      case STATES.waitingForGas: {
        const tip = await this.beam.tipHeight();
        this.#tip = tip;
        if (tip < c.height + BEAM_CONFIRMATIONS) {
          this.#emit(); // blocks left changed
          return [c, P.blocksMs];
        }
        const dueAt = c.dueAt ?? this.clock.now();
        let next = c.dueAt === null ? this.#ch(c, { dueAt }) : c;
        // The relayer pays the gas: the pipe's flag says when it has paid.
        if (await this.eth.isPaid(route, c.msgId)) return [this.#ch(next, { state: STATES.paid, finishedAt: this.clock.now(), lastError: null }), P.paidMs];
        if (next.state === STATES.confirmed && this.clock.now() - dueAt >= TIMING.gasWaitMs) next = this.#ch(next, { state: STATES.waitingForGas });
        return [next, P.paidMs];
      }
      default:
        return [c, P.blocksMs];
    }
  }

  /** The message the send of c made: above countBefore, to ethAddress, with its amount and fee, mined at `height`, not another crossing's. */
  async #findLocalMessage(c, height) {
    const matches = await this.#localMatches(c, height);
    return matches.length ? matches[0][0] : null;
  }

  async #findLocalMessageAnyHeight(c) {
    const matches = await this.#localMatches(c, null);
    return matches.length ? matches[0] : null;
  }

  /** Every match [id, stamped height], lowest id first: two identical sends in one block pay the same address the same amount, so either may be either. */
  async #localMatches(c, height) {
    const route = routeById(c.route);
    const count = await this.beam.localMessageCount(route);
    const floor = c.countBefore ?? 0;
    const taken = new Set([...this.#records.values()].filter((o) => o.id !== c.id && o.route === c.route && o.direction === c.direction && o.msgId !== null).map((o) => o.msgId));
    const out = [];
    for (let id = count; id > floor; id--) {
      if (taken.has(id)) continue;
      const m = await this.beam.localMessage(route, id);
      if (!m) continue;
      if (m.receiver.toLowerCase() === c.ethAddress.toLowerCase() && m.amount === c.amount && m.relayerFee === c.relayerFee && (height === null || sameBlock(m.height, height))) out.push([id, m.height]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  async #stepToBeam(c) {
    const route = routeById(c.route);
    const P = this.polling;
    const now = () => this.clock.now();
    switch (c.state) {
      case STATES.approving:
        // The steps are being sent by #sendLockSteps.
        return [c, P.ethReceiptMs];
      case STATES.locking: {
        if (!c.lockHash) return [c, P.ethReceiptMs];
        let lock;
        try {
          lock = await this.eth.lockResult(route, c.lockHash, { value: c.amount, fee: c.relayerFee, receiverKey: unhex(c.beamReceiveKey) });
        } catch (e) {
          if (!(e instanceof BridgeError) || e.code !== 'unexpectedTransaction') throw e;
          return [this.#ch(c, { state: STATES.unknown, lastError: 'The lock on Ethereum does not say what Campfire sent. Campfire will not collect anything for it.' }), P.toBeamMs];
        }
        if (!lock) {
          // Pending, or the server does not have it: the same bytes again.
          const e = await this.#sendAgainIfLost(c.lockHash, c.lockRaw);
          const lastError = e ? `Ethereum does not have your ${route.ethSymbol} lock yet, and sending the same signed transaction again failed (${plain(e)}). Campfire keeps trying.` : c.lastError;
          return [lastError === c.lastError ? c : this.#ch(c, { lastError }), P.ethReceiptMs];
        }
        if (!lock.success) {
          return [this.#ch(c, { state: STATES.lockFailed, lastError: 'Ethereum refused the lock, so nothing was locked. Only its network fee was spent.', height: lock.blockNumber, finishedAt: now() }), P.toBeamMs];
        }
        const locked = this.#ch(c, { state: STATES.locked, msgId: lock.msgId, height: lock.blockNumber, lockedAt: now(), lastError: null });
        try {
          checkUnique(locked, this.#records.values());
        } catch {
          return [this.#ch(c, { state: STATES.unknown, height: lock.blockNumber, lastError: 'Ethereum names a bridge message another crossing already has. Campfire will not collect anything for this one.' }), P.toBeamMs];
        }
        return this.#stepToBeam(locked);
      }
      case STATES.unknown: {
        if (c.lockHash && c.msgId === null) return this.#stepToBeam(this.#ch(c, { state: STATES.locking }));
        if (c.msgId !== null) return [c, P.toBeamMs];
        // No hash: look on BEAM for what the lock would have brought.
        const taken = new Set([...this.#records.values()].filter((o) => o.route === c.route && o.direction === c.direction && o.msgId !== null).map((o) => o.msgId));
        for (const m of await this.beam.incoming(route)) {
          if (m.amount === c.receives && !taken.has(m.msgId)) return this.#stepToBeam(this.#ch(c, { state: STATES.delivered, msgId: m.msgId, deliveredAt: now(), lastError: null }));
        }
        return [c, P.toBeamMs];
      }
      case STATES.locked:
      case STATES.notDeliveredYet: {
        const m = await this.beam.remoteMessage(route, c.msgId);
        if (!m) {
          const since = c.lockedAt ?? c.updatedAt;
          if (c.state === STATES.locked && now() - since >= TIMING.deliveryWaitMs) return [this.#ch(c, { state: STATES.notDeliveredYet }), P.toBeamMs];
          return [c, P.toBeamMs];
        }
        if (m.amount !== c.receives) {
          return [this.#ch(c, { state: STATES.unknown, lastError: `It arrived on BEAM with a different amount (${coinText(m.amount, 8)} ${route.beamSymbol}). Campfire will not collect it.` }), P.toBeamMs];
        }
        // Ready to collect: the person collects it (collect()); nothing is claimed by itself.
        return [this.#ch(c, { state: STATES.delivered, deliveredAt: now() }), P.toBeamMs];
      }
      case STATES.delivered: {
        // Still there? It may have been collected on another device.
        const m = await this.beam.remoteMessage(route, c.msgId);
        if (!m) return [this.#ch(c, { state: STATES.claimed, lastError: ELSEWHERE, finishedAt: now() }), P.toBeamMs];
        return [c, P.toBeamMs];
      }
      case STATES.claiming: {
        if (c.claimTxId) {
          const s = await this.beam.txStatus(c.claimTxId);
          if (s.state === 'pending') return [c, P.beamTxMs];
          if (s.state === 'completed') return [this.#ch(c, { state: STATES.claimed, finishedAt: now(), lastError: null }), P.beamTxMs];
          return [this.#claimDidNotGo(c, s.reason || 'The claim failed on BEAM.'), P.toBeamMs];
        }
        // The claim threw while sending: the message tells.
        const m = await this.beam.remoteMessage(route, c.msgId);
        if (!m) return [this.#ch(c, { state: STATES.claimed, finishedAt: now(), lastError: null }), P.beamTxMs];
        const since = c.claimStartedAt ?? c.updatedAt;
        if (now() - since >= TIMING.claimWaitMs) return [this.#claimDidNotGo(c, 'The claim did not reach BEAM.'), P.toBeamMs];
        return [c, P.beamTxMs];
      }
      default:
        return [c, P.toBeamMs];
    }
  }

  #claimDidNotGo(c, why) {
    // Only the person starts it again.
    return this.#ch(c, { state: STATES.delivered, lastError: `${why} Nothing was lost: it is still waiting for you to collect it.` });
  }

  // ------------------------------------------------------------- helpers

  async #save(c) {
    await this.store.save(c);
    this.#records.set(c.id, c);
    this.#emit();
  }

  /** #save for a step already taken: the record in memory follows even if storage does not (the next save writes it). */
  async #saveQuietly(c) {
    try {
      await this.#save(c);
      return true;
    } catch {
      this.#records.set(c.id, c);
      this.#emit();
      return false;
    }
  }

  /** Stops polling and every step sequence at its next turn. */
  dispose() {
    this.#disposed = true;
    this.#active = false;
    this.#stopTimer();
    this.#listeners.clear();
  }
}

// ---------------------------------------------------------------- the BEAM half in the app

const PENDING = Object.freeze({ state: 'pending', height: null, reason: null });

/**
 * The controller's BEAM half from the app's own parts: `pipe` a beam_pipe.js
 * BeamPipe, `wallet` the lib/wallet.js Wallet (txStatus, available, state).
 */
export function beamSide({ pipe, wallet }) {
  return Object.freeze({
    receiveKey: (route) => pipe.receiveKey(route),
    localMessageCount: (route) => pipe.localMessageCount(route),
    localMessage: (route, id) => pipe.localMessage(route, id),
    remoteMessage: (route, id) => pipe.remoteMessage(route, id),
    incoming: (route, opts) => pipe.incoming(route, opts),
    send: (route, args) => pipe.send(route, args),
    claim: (route, args) => pipe.claim(route, args),
    async txStatus(txId) {
      const t = await wallet.txStatus(txId);
      const s = Number(t && t.status);
      const height = Number(t && t.height);
      // 3 completed; 2 cancelled and 4 failed; 0, 1 and 5 still on the way.
      if (s === 3 && Number.isSafeInteger(height) && height > 0) return Object.freeze({ state: 'completed', height, reason: null });
      if (s === 2 || s === 4) return Object.freeze({ state: 'failed', height: null, reason: (t && (t.failure_reason || t.status_string)) || 'The BEAM transaction failed.' });
      return PENDING;
    },
    async tipHeight() {
      const h = Number(wallet.state && wallet.state.status && wallet.state.status.current_height);
      if (!Number.isSafeInteger(h) || h <= 0) throw new BridgeError('network', 'The BEAM wallet does not know the chain height yet.');
      return h;
    },
    async available(assetId) {
      return wallet.available(assetId);
    },
  });
}
