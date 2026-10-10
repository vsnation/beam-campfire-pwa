// Buying BEAM through buybeam.my, without any screen: the coins it takes,
// what an amount buys (asked again on every change, the latest question
// only), a deposit address for one buy (kept on this device before it is
// shown), and where each open buy is (asked as often as buybeam.my says, less
// often while it cannot be reached, never again once it has ended). A port of
// the desktop app's lib/wallets/beam/buy/buybeam_controller.dart.
//
// One controller per unlocked wallet (lib/buy/wiring.js); it outlives the
// screens, so buys are followed after their screen closes. It follows them
// only while the wallet is unlocked and the page is visible: the wiring
// pauses it otherwise, and locking disposes of it.

import { BuyBeamError, sortAssets } from './buybeam.js';
import { makeOrder, withStatus, sameAs } from './store.js';

/** The time the controller reads, and its timers: schedule(ms, fn) → cancel(). */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  schedule(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
});

const ASSETS_TTL_MS = 10 * 60 * 1000;

export class BuyBeamController {
  constructor({ client, store, clock = systemClock, autoPoll = true, quoteDelayMs = 400, defaultPollMs = 15000, maxBackoffMs = 5 * 60 * 1000, orderRetries = 2 }) {
    this.client = client;
    this.store = store;
    this.clock = clock;
    /** Follow open buys on timers (tests call pollDue themselves). */
    this.autoPoll = autoPoll;
    /** How long typing must pause before a price is asked for. */
    this.quoteDelayMs = quoteDelayMs;
    /** Between two looks at a buy, when buybeam.my does not say. */
    this.defaultPollMs = defaultPollMs;
    /** The longest wait between looks while buybeam.my cannot be reached. */
    this.maxBackoffMs = maxBackoffMs;
    /** Extra tries of a deposit-address request that got no answer. */
    this.orderRetries = orderRetries;

    this._listeners = new Set();
    this._disposed = false;
    this._assets = null; // {list, at}
    this._limits = null;
    this._refusedBelowUsd = null;

    this._quoteRequest = null;
    this._quote = null;
    this._quoteError = null;
    this._quoting = false;
    this._quoteSeq = 0;
    this._quoteCancel = null;

    this._orders = new Map();
    this._dueAt = new Map();
    this._failures = new Map();
    this._pollErrors = new Map();
    this._busy = new Set();
    /** BEAM addresses made for an order request that got no answer, by the request: asking again with them returns the same order. */
    this._pendingAddress = new Map();
    this._resuming = null;
    this._paused = false;
    this._wake = null;
  }

  get sandbox() {
    return this.client.sandbox;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed() {
    if (this._disposed) return;
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  dispose() {
    this._disposed = true;
    if (this._quoteCancel) this._quoteCancel();
    if (this._wake) this._wake();
    this._wake = null;
    this._listeners.clear();
  }

  // ---------------------------------------------------------------- coins

  /** The coins buybeam.my takes, in picker order (kept ten minutes). */
  async assets({ refresh = false } = {}) {
    const c = this._assets;
    if (!refresh && c && this.clock.now() - c.at < ASSETS_TTL_MS) return c.list;
    const list = sortAssets(await this.client.assets());
    this._assets = { list, at: this.clock.now() };
    return list;
  }

  /** The smallest-buy hint last read. */
  get limits() {
    return this._limits;
  }

  /**
   * What to say up front about the smallest buy: the figure buybeam.my last
   * observed, else the one a refused price stated here, else buybeam.my's own
   * floor. A hint only: a price decides.
   */
  get minimumHintUsd() {
    return this._limits?.upstreamObservedMinimumUsd ?? this._refusedBelowUsd ?? this._limits?.ourMinimumUsd ?? null;
  }

  /** Reads the smallest-buy hint; the last one is kept when buybeam.my cannot be reached. */
  async refreshLimits() {
    try {
      this._limits = await this.client.limits();
      this._changed();
    } catch (e) {
      if (!(e instanceof BuyBeamError)) throw e;
      // The form says nothing about a minimum until a quote does.
    }
    return this._limits;
  }

  // --------------------------------------------------------------- quotes

  /** What is being priced: {asset, amount (BuyBeamAmount), refundAddress}, or null. */
  get quoteRequest() {
    return this._quoteRequest;
  }

  /** The price of quoteRequest, once known. */
  get quote() {
    return this._quote;
  }

  /** Why quoteRequest has no price. */
  get quoteError() {
    return this._quoteError;
  }

  /** A price is being asked for (or about to be). */
  get quoting() {
    return this._quoting;
  }

  /** Prices `request` once typing pauses; the answer to any earlier request is dropped. Null clears the price. */
  requestQuote(request, { afterMs = null } = {}) {
    if (this._quoteCancel) this._quoteCancel();
    const seq = ++this._quoteSeq;
    this._quoteRequest = request;
    this._quote = null;
    this._quoteError = null;
    this._quoting = request !== null;
    this._changed();
    if (request === null) return;
    this._quoteCancel = this.clock.schedule(afterMs ?? this.quoteDelayMs, () => this._runQuote(seq, request));
  }

  /** Forgets the price being asked for without telling anyone (a form opening or closing). */
  cancelQuote() {
    if (this._quoteCancel) this._quoteCancel();
    this._quoteSeq++;
    this._quoteRequest = null;
    this._quote = null;
    this._quoteError = null;
    this._quoting = false;
  }

  /** Asks for the same price again, now ("Try again"). */
  requote() {
    if (this._quoteRequest) this.requestQuote(this._quoteRequest, { afterMs: 0 });
  }

  async _runQuote(seq, r) {
    if (seq !== this._quoteSeq || this._disposed) return;
    try {
      const q = await this.client.quote({ assetId: r.asset.assetId, amount: r.amount, refundAddress: r.refundAddress });
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quote = q;
    } catch (e) {
      const err = e instanceof BuyBeamError ? e : new BuyBeamError('network');
      if (err.code === 'amount_below_upstream_minimum' && err.minimumUsd != null) this._refusedBelowUsd = err.minimumUsd;
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quoteError = err;
    }
    this._quoting = false;
    this._changed();
  }

  // --------------------------------------------------------------- orders

  /** Every buy (of beamWalletId when given), newest first. */
  orders(beamWalletId = null) {
    return [...this._orders.values()].filter((o) => beamWalletId === null || o.beamWalletId === beamWalletId).sort((a, b) => b.createdAt - a.createdAt);
  }

  order(depositAddress) {
    return this._orders.get(depositAddress) || null;
  }

  /** Why the last look at a buy got no answer (null after one that did). */
  pollError(depositAddress) {
    return this._pollErrors.get(depositAddress) || null;
  }

  /** When the next look at a buy is due (ms; null: never, it has ended). */
  dueAt(depositAddress) {
    return this._dueAt.get(depositAddress) ?? null;
  }

  /** Loads the buys kept on this device and follows the open ones (once; later calls wait for the first). */
  resumeAll() {
    if (!this._resuming) this._resuming = this._resume();
    return this._resuming;
  }

  async _resume() {
    let stored;
    try {
      stored = await this.store.all();
    } catch (e) {
      // The next screen that opens asks again.
      this._resuming = null;
      this.loadError = e;
      this._changed();
      return;
    }
    this.loadError = null;
    const now = this.clock.now();
    for (const o of stored) {
      if (!this._orders.has(o.depositAddress)) this._orders.set(o.depositAddress, o);
      if (o.isOpen && !this._dueAt.has(o.depositAddress)) this._dueAt.set(o.depositAddress, now);
    }
    this._changed();
    this._arm();
  }

  /**
   * A deposit address for `amount` of `asset`, the BEAM going to a new address
   * of the wallet beamWalletId (newBeamAddress() makes it). The buy is on this
   * device before this returns. A request that got no answer is sent again as
   * it was, and buybeam.my returns the same order for it.
   */
  async placeOrder({ asset, amount, refundAddress, beamWalletId, newBeamAddress, quote = null }) {
    await this.resumeAll();
    const key = [asset.assetId, amount.raw, refundAddress, beamWalletId].join('|');
    let beamAddress = this._pendingAddress.get(key);
    if (!beamAddress) {
      beamAddress = await newBeamAddress();
      this._pendingAddress.set(key, beamAddress);
    }
    let answer = null;
    for (let attempt = 0; answer === null; attempt++) {
      try {
        answer = await this.client.order({ assetId: asset.assetId, amount, beamAddress, refundAddress });
      } catch (e) {
        if (!(e instanceof BuyBeamError) || !e.unreachable || attempt >= this.orderRetries) throw e;
      }
    }
    const order =
      this._orders.get(answer.depositAddress) ||
      makeOrder({
        depositAddress: answer.depositAddress,
        assetId: asset.assetId,
        symbol: asset.symbol,
        chain: asset.blockchain,
        decimals: asset.decimals,
        sendAmount: amount.text,
        sendAmountRaw: amount.raw,
        beamAddress,
        beamWalletId,
        refundAddress,
        createdAt: this.clock.now(),
        beamEstimate: answer.beamEstimate ?? quote?.beamEstimate ?? null,
        deadline: answer.deadline,
        etaSeconds: answer.etaSeconds ?? quote?.etaSeconds ?? null,
        lastState: 'awaiting_deposit',
        sandbox: this.client.sandbox,
      });
    // On this device before anything shows the address.
    await this.store.save(order);
    this._pendingAddress.delete(key);
    this._orders.set(order.depositAddress, order);
    if (order.isOpen) this._dueAt.set(order.depositAddress, this.clock.now() + this.defaultPollMs);
    this._changed();
    this._arm();
    return order;
  }

  /** Stops following buys (the page is hidden). */
  pause() {
    this._paused = true;
    if (this._wake) this._wake();
    this._wake = null;
  }

  /** Follows them again, everything that is due first. */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.pollDue();
  }

  /** Looks at every open buy whose turn it is. */
  async pollDue() {
    if (this._disposed || this._paused) return;
    const now = this.clock.now();
    const due = [...this._orders.values()].filter((o) => o.isOpen && !this._busy.has(o.depositAddress) && !((this._dueAt.get(o.depositAddress) ?? -Infinity) > now)).map((o) => o.depositAddress);
    for (const a of due) await this.poll(a);
    this._arm();
  }

  /** Looks at the buy paid at depositAddress once, now. */
  async poll(depositAddress) {
    const o = this._orders.get(depositAddress);
    if (!o || !o.isOpen || this._disposed || this._busy.has(depositAddress)) return o || null;
    this._busy.add(depositAddress);
    try {
      const s = await this.client.status(depositAddress);
      const next = withStatus(o, s, this.clock.now());
      this._failures.delete(depositAddress);
      this._pollErrors.delete(depositAddress);
      if (!sameAs(next, o)) await this._saveQuietly(next);
      this._orders.set(depositAddress, next);
      if (next.isOpen) this._dueAt.set(depositAddress, this.clock.now() + (s.pollAfterMs ?? this.defaultPollMs));
      else this._dueAt.delete(depositAddress);
      return next;
    } catch (e) {
      const err = e instanceof BuyBeamError ? e : new BuyBeamError('network');
      this._pollErrors.set(depositAddress, err);
      const n = (this._failures.get(depositAddress) || 0) + 1;
      this._failures.set(depositAddress, n);
      this._dueAt.set(depositAddress, this.clock.now() + this._backoff(n, err.retryAfterMs));
      return o;
    } finally {
      this._busy.delete(depositAddress);
      this._changed();
      this._arm();
    }
  }

  /** The wait after `failures` looks in a row got no answer: twice the usual each time, at most maxBackoffMs, never less than retryAfterMs. */
  _backoff(failures, retryAfterMs) {
    let wait = Math.min(this.defaultPollMs * 2 ** Math.min(failures, 10), this.maxBackoffMs);
    if (retryAfterMs != null && retryAfterMs > wait) wait = retryAfterMs;
    return wait;
  }

  async _saveQuietly(o) {
    try {
      await this.store.save(o);
    } catch {
      // Kept in memory; the next change tries again.
    }
  }

  /** Wakes up when the next open buy is due. */
  _arm() {
    if (!this.autoPoll || this._paused || this._disposed) return;
    if (this._wake) this._wake();
    this._wake = null;
    let next = null;
    for (const o of this._orders.values()) {
      const at = this._dueAt.get(o.depositAddress);
      if (!o.isOpen || at === undefined || this._busy.has(o.depositAddress)) continue;
      if (next === null || at < next) next = at;
    }
    if (next === null) return;
    this._wake = this.clock.schedule(Math.max(0, next - this.clock.now()), () => {
      this._wake = null;
      this.pollDue();
    });
  }
}
