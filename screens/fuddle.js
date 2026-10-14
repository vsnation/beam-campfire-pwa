// Fuddle, the Wordle tournament on BEAM (lib/fuddle.js), built into BEAM Campfire and opened from
// dApps. Four screens: Fuddle (your games and the tournaments), a tournament (its rules, entering,
// collecting), a game (the grid, guessing, hints, refunds) and your games. Loaded on first use
// (screens/fuddle_screens.js). While the contract is not deployed (lib/fuddle_id.js FUDDLE_CID null)
// every one of them says "Fuddle opens soon" and calls nothing.
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, openSheet, toast, onHidden, onShown } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { syncReason } from '../lib/sync.js';
import {
  fuddleFor, GAME, FEES, MAX_ATTEMPTS, lengthsOf, lengthMultiplier, scoreOf, cleanGuess, missingLetters, hintMarks, letterStates,
  entryCost, guessCost, refundOf, blocksText, rulesBeforeEntering, gameClock, clockText, gameOutcome, failedReason,
} from '../lib/fuddle.js';
import { t, tn } from '../lib/i18n.js';

const POLL_MS = 15000;
const POLL_WAIT_MS = 6000; // while a guess or an entry is on its way
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const PREFERRED_LENGTH = 5;

const unit = (asset) => wallet.label(asset).unit;
/** "1.12 BEAM", every digit. */
const amt = (asset, groth) => `${formatAmount(groth)} ${unit(asset)}`;
/** "2 FOMO + 0.12 BEAM": the tournament asset's part, then BEAM's (merged when the asset is BEAM). */
function amounts(asset, assetAmount, beam) {
  if (asset === 0) return amt(0, BigInt(assetAmount) + BigInt(beam));
  const parts = [];
  if (BigInt(assetAmount)) parts.push(amt(asset, assetAmount));
  if (BigInt(beam)) parts.push(amt(0, beam));
  return parts.join(' + ') || amt(asset, 0n);
}

/** Plain words for whatever stopped a Fuddle transaction. */
function problemText(e) {
  const code = e && e.code;
  if (code === 'rejected') return t('Cancelled. Nothing was sent.');
  if (code === 'timeout') return t('The wallet did not answer in time. Check Activity before trying again.');
  if (e && e.message) return e.message;
  return t('Something went wrong. Nothing was sent. Try again.');
}

/** The service for this session, or null while Fuddle is not deployed. */
const service = () => fuddleFor(wallet.session);

/** Polls fn every `ms` while the page is visible and the screen alive; returns stop(). */
function poller(fn, msFn) {
  let timer = null;
  let stopped = false;
  let hidden = false;
  const next = () => {
    clearTimeout(timer);
    if (stopped || hidden) return;
    timer = setTimeout(async () => {
      try {
        await fn();
      } catch {
        /* the screen shows the last good answer */
      }
      next();
    }, msFn());
  };
  const offHidden = onHidden(() => {
    hidden = true;
    clearTimeout(timer);
  });
  const offShown = onShown(() => {
    hidden = false;
    fn().catch(() => {}).finally(next);
  });
  next();
  return {
    kick: next,
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (typeof offHidden === 'function') offHidden();
      if (typeof offShown === 'function') offShown();
    },
  };
}

/** "Fuddle opens soon": what every Fuddle screen shows while the contract is not deployed. */
function soon(app) {
  const el = screen(
    { title: t('Fuddle'), back: () => app.back('dapps'), cls: 'fuddle feature' },
    h(
      'div',
      { class: 'empty fuddle-soon', 'data-testid': 'fuddle-soon' },
      fuddleMark('big'),
      h('h2', { class: 'title center', text: t('Fuddle opens soon') }),
      h('p', { class: 'center', text: t('Fuddle is a word game on BEAM: guess a hidden word in six tries, with every hint checked on chain, and share the prize pool by score.') }),
      h('p', { class: 'center small', text: t('It is not open yet: its contract is being prepared. This screen will show the tournaments as soon as it opens. Nothing here can spend your funds until then.') }),
    ),
    h('div', { class: 'actions' }, secondary(t('Back to dApps'), () => app.back('dapps'), { 'data-testid': 'fuddle-soon-back' })),
  );
  return { el, destroy() {} };
}

/** Three small tiles, green, yellow and grey: Fuddle's mark in dApps and on its screens. */
export function fuddleMark(size = '') {
  return h('span', { class: `fuddle-mark${size ? ` ${size}` : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'm correct' }), h('span', { class: 'm present' }), h('span', { class: 'm absent' }));
}

/** Who answers a tournament's guesses, in words. */
function answeredBy(svc, tour) {
  return svc.servicePk && tour.answerer === svc.servicePk ? t('Answers by the BEAM Campfire service') : t('Answers by another service, not the BEAM Campfire one');
}

/** "in about 3 hours" for a height ahead, "now" when it has come. */
const whenText = (h0, height) => (h0 > height ? t('in {time}', { time: blocksText(h0 - height) }) : t('now'));

/** Can this wallet send right now (honestly synced)? The reason when it cannot. */
function sendBlock() {
  const s = wallet.state.sync;
  return s && s.canSend ? null : t('Playing is paused: {reason}.', { reason: syncReason((s && s.title) || t('Not connected')) });
}

/** What the wallet lacks to pay `need` (asset -> groth): a sentence, or null. */
function shortText(need) {
  for (const [asset, n] of need) {
    if (n > 0n && wallet.available(asset) < n) return t('This needs {need} and the wallet has {have}.', { need: amt(asset, n), have: amt(asset, wallet.available(asset)) });
  }
  return null;
}

// ---------------------------------------------------------------- the grid and the keyboard

const MARK = { correct: 'check', present: 'shift', absent: 'minus' };
function markWords(letter, mark) {
  const L = letter.toUpperCase();
  if (mark === 'correct') return t('{letter}: in the word, right place', { letter: L });
  if (mark === 'present') return t('{letter}: in the word, another place', { letter: L });
  return t('{letter}: not in the word', { letter: L });
}

function tile(letter, mark = null, state = '') {
  const cls = `tile${mark ? ` ${mark}` : ''}${state ? ` ${state}` : ''}`;
  return h(
    'span',
    { class: cls, role: 'img', 'aria-label': letter ? (mark ? markWords(letter, mark) : letter.toUpperCase()) : t('empty') },
    h('span', { class: 'l', text: letter ? letter.toUpperCase() : '' }),
    mark ? h('span', { class: 'mk' }, icon(MARK[mark])) : null,
  );
}

/**
 * The six rows: answered guesses with their marks, a guess waiting for its hint, the one being
 * typed, empty rows after it.
 */
function grid(game, { typed = '', pending = null, canType = false }) {
  const rows = [];
  const len = game.len;
  for (const g of game.guesses) {
    const marks = g.answered ? hintMarks(g.feedback) : null;
    rows.push(h('div', { class: `grid-row${marks ? ' answered' : ' waiting'}`, 'data-testid': `fuddle-row-${g.attempt}`, 'data-state': marks ? 'answered' : 'waiting' }, ...[...g.letters].map((c, i) => tile(c, marks ? marks[i] : null, marks ? '' : 'waiting'))));
  }
  if (pending && pending.attempt === game.guesses.length) {
    rows.push(h('div', { class: 'grid-row sending', 'data-testid': `fuddle-row-${pending.attempt}`, 'data-state': 'sending' }, ...[...pending.word].map((c) => tile(c, null, 'waiting'))));
  } else if (canType && rows.length < MAX_ATTEMPTS) {
    const cells = [];
    for (let i = 0; i < len; i++) cells.push(tile(typed[i] || '', null, i < typed.length ? 'typed' : 'empty'));
    rows.push(h('div', { class: 'grid-row current', 'data-testid': 'fuddle-row-current' }, ...cells));
  }
  while (rows.length < MAX_ATTEMPTS) rows.push(h('div', { class: 'grid-row' }, ...Array.from({ length: len }, () => tile('', null, 'empty'))));
  return h('div', { class: `fuddle-grid len-${len}`, 'data-testid': 'fuddle-grid', role: 'group', 'aria-label': t('Your guesses') }, ...rows);
}

function legend() {
  const item = (mark, text) => h('span', { class: 'legend-item' }, h('span', { class: `tile mini ${mark}` }, h('span', { class: 'mk' }, icon(MARK[mark]))), h('span', { text }));
  return h('div', { class: 'fuddle-legend', 'data-testid': 'fuddle-legend' }, item('correct', t('Right letter, right place')), item('present', t('In the word, another place')), item('absent', t('Not in the word')));
}

function keyboard(states, { onKey, disabled }) {
  const key = (c) => {
    const st = states.get(c) || null;
    return h(
      'button',
      { class: `key${st ? ` ${st}` : ''}`, type: 'button', disabled, 'data-key': c, 'aria-label': st ? markWords(c, st) : c.toUpperCase(), onclick: () => onKey(c) },
      h('span', { text: c.toUpperCase() }),
      st ? h('span', { class: 'mk' }, icon(MARK[st])) : null,
    );
  };
  return h(
    'div',
    { class: 'fuddle-keys', 'data-testid': 'fuddle-keys', role: 'group', 'aria-label': t('Letters') },
    h('div', { class: 'key-row' }, ...[...KEY_ROWS[0]].map(key)),
    h('div', { class: 'key-row' }, ...[...KEY_ROWS[1]].map(key)),
    h('div', { class: 'key-row' }, ...[...KEY_ROWS[2]].map(key), h('button', { class: 'key wide', type: 'button', disabled, 'data-key': 'back', 'aria-label': t('Delete a letter'), onclick: () => onKey('back') }, icon('backspace'))),
  );
}

// ---------------------------------------------------------------- Fuddle (home)

/* Fuddle (dApps -> Fuddle)
 * Spec: ONE job: get into a game: continue the one waiting for your guess, or pick a tournament to enter.
 *       Primary CTA: "Continue your game" while a game waits for a guess; otherwise "Play" on the
 *       newest tournament taking entries (it opens that tournament, whose rules come before entering).
 *       Taps from app open: 3 (Home -> dApps -> Fuddle -> Continue / Play), entering is 2 more.
 * Exit-intent reasons and answers:
 *   - "What is this?" -> one line under the title: guess a hidden word in six tries, hints checked on
 *     chain, prizes shared by score.
 *   - "Is it a scam / who runs it?" -> every tournament says who answers its guesses; the rules and
 *     the compensation if that service fails come before any payment.
 *   - "What does it cost?" -> each tournament row shows its entry and its prize pool now.
 *   - "I had a game going" -> it is first, with what is due and how long is left.
 *   - "Nothing to play" -> said, with what comes next (when entries open), never a blank list.
 */
export function fuddleHome(app) {
  const svc = service();
  if (!svc) return soon(app);
  let alive = true;
  let data = null; // { browse, mine }
  let error = null;
  const body = h('div', { class: 'content fuddle-home' });

  function tournamentRow(tour, height, cta = false) {
    const entering = tour.phase === 'open' && height + 1 <= tour.entriesCloseH;
    const free = Math.max(0, tour.maxOpen - tour.openGames);
    const pool = tour.phase === 'finalised' ? tour.pool : tour.poolEstimate;
    const status = entering
      ? t('Entries close {when} · ends {end}', { when: whenText(tour.entriesCloseH, height), end: whenText(tour.endH, height) })
      : tour.phase === 'upcoming'
        ? t('Entries open {when}', { when: whenText(tour.startH, height) })
        : tour.phase === 'finalised'
          ? t('Settled')
          : t('Entries closed · games finishing');
    return h(
      'button',
      { class: 'row fuddle-tour', type: 'button', 'data-testid': `fuddle-tour-${tour.tid}`, 'data-phase': tour.phase, onclick: () => app.go('fuddleTournament', { tid: tour.tid }) },
      fuddleMark(),
      h(
        'span',
        { class: 'main' },
        h('div', { class: 't', text: t('Tournament #{tid}', { tid: tour.tid }) }),
        h('div', { class: 's', text: t('Entry {entry} · prize pool {pool}', { entry: amt(tour.asset, tour.entry), pool: amt(tour.asset, pool) }) }),
        h('div', { class: 's', text: status }),
        entering ? h('div', { class: 's', text: t('{free} of {all} places free', { free, all: tour.maxOpen }) }) : null,
        h('div', { class: 's', text: answeredBy(svc, tour) }),
      ),
      entering ? h('span', { class: cta ? 'pill strong' : 'pill', text: t('Play') }) : h('span', { class: 'chev' }, icon('chevron')),
    );
  }

  function gameLine(x, height) {
    const { game: g, outcome: o, tour } = x;
    if (o.outcome === 'playing') {
      const c = gameClock(g, height);
      if (c.kind === 'hint') return t('Waiting for the hint');
      return c.kind === 'firstGuess' ? t('Make your first guess · {time} left', { time: blocksText(c.blocksLeft) }) : t('Your move · {time} left', { time: blocksText(c.blocksLeft) });
    }
    if (o.outcome === 'checking') return t('Game over · the word is being revealed');
    if (o.outcome === 'solved') return tn({ one: 'Solved in {n} guess · score {score}', other: 'Solved in {n} guesses · score {score}' }, g.solvedAt, { score: o.score.toLocaleString('en-US') });
    if (o.outcome === 'unsolved') return t('Not solved');
    if (o.outcome === 'stopped') return t('Ended: no guess in time');
    if (o.outcome === 'late') return t('The answer service is late: end the game for your refund');
    if (o.outcome === 'abandoned') return t('No first guess in time: end the game for your entry');
    if (o.outcome === 'failed' || o.outcome === 'unplayed') {
      if (!o.refundable) return t('Refund taken');
      const r = refundOf(tour, g.letterPrice === undefined ? { ...g, letterPrice: tour.letterPrice } : g);
      return t('Take back {amount}', { amount: amounts(r.asset, r.assetAmount, r.beam) });
    }
    return '';
  }

  function gameRow(x, height) {
    const { game: g, outcome: o, tour } = x;
    const ico = { playing: 'edit', checking: 'clock', solved: 'check', unsolved: 'minus', stopped: 'minus', late: 'alert', abandoned: 'alert', failed: 'alert', unplayed: 'clock' }[o.outcome] || 'info';
    const tone = { solved: 'ok', late: 'fail', abandoned: 'wait', failed: o.refundable ? 'fail' : '', unplayed: o.refundable ? 'wait' : '', playing: 'in' }[o.outcome] || '';
    return h(
      'button',
      { class: 'row fuddle-game-row', type: 'button', 'data-testid': `fuddle-game-${tour.tid}-${g.idx}`, 'data-outcome': o.outcome, onclick: () => app.go('fuddleGame', { tid: tour.tid, idx: g.idx }) },
      h('span', { class: `ico${tone ? ` ${tone}` : ''}` }, icon(ico)),
      h('span', { class: 'main' }, h('div', { class: 't', text: tn({ one: '{n} letter · tournament #{tid}', other: '{n} letters · tournament #{tid}' }, g.len, { tid: tour.tid }) }), h('div', { class: 's', text: gameLine(x, height) })),
      h('span', { class: 'chev' }, icon('chevron')),
    );
  }

  function claimRow(c) {
    return h(
      'button',
      { class: 'row fuddle-claim-row', type: 'button', 'data-testid': `fuddle-claim-${c.tid}`, onclick: () => app.go('fuddleTournament', { tid: c.tid }) },
      h('span', { class: 'ico ok' }, icon('gift')),
      h('span', { class: 'main' }, h('div', { class: 't', text: t('Tournament #{tid} is settled', { tid: c.tid }) }), h('div', { class: 's', text: t('Collect {amount}', { amount: amounts(c.asset, c.payoutAsset, c.payoutBeam) }) })),
      h('span', { class: 'chev' }, icon('chevron')),
    );
  }

  function render() {
    if (!alive) return;
    const lead = h('p', { class: 'lead', text: t('Guess a hidden word in six tries. Every hint is checked on chain, and the prize pool is shared by score.') });
    if (error && !data) {
      return put(body, lead, h('div', { 'data-testid': 'fuddle-load-failed' }, notice('error', t('Fuddle could not be read from the network: {reason}', { reason: error.message }))), h('div', { class: 'actions' }, primary(t('Try again'), () => load(), { 'data-testid': 'fuddle-retry' })));
    }
    if (!data) return put(body, lead, h('div', { class: 'card fuddle-loading', 'data-testid': 'fuddle-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text: t('Reading the tournaments from the network…') })));
    const height = data.browse.height;
    const list = data.browse.tournaments;
    const open = list.filter((x) => x.phase === 'open' && height + 1 <= x.entriesCloseH);
    const upcoming = list.filter((x) => x.phase === 'upcoming');
    const active = data.mine.games.filter((x) => ['playing', 'checking', 'late', 'abandoned'].includes(x.outcome.outcome) || x.outcome.refundable);
    const next = active.find((x) => x.outcome.outcome === 'playing' && x.game.phase === 'your_move') || null;
    const ctaTour = !next && open.length ? open[0] : null;
    const parts = [lead];
    if (data.browse.state.paused) parts.push(notice('warn', t('Fuddle is paused: no new games for now. Games in play go on.')));
    if (next) {
      parts.push(
        h(
          'div',
          { class: 'card fuddle-next', 'data-testid': 'fuddle-next' },
          h('div', { class: 'fuddle-next-head' }, fuddleMark(), h('div', { class: 'grow' }, h('div', { class: 'name', text: t('Your game is waiting for a guess') }), h('div', { class: 'small', text: clockText(gameClock(next.game, height)) }))),
          primary(t('Continue your game'), () => app.go('fuddleGame', { tid: next.tour.tid, idx: next.game.idx }), { 'data-testid': 'fuddle-continue' }),
        ),
      );
    }
    if (active.length || data.mine.claims.length) {
      parts.push(h('p', { class: 'section-title', text: t('Your games') }));
      parts.push(h('div', { class: 'card list', 'data-testid': 'fuddle-mine' }, ...data.mine.claims.map(claimRow), ...active.map((x) => gameRow(x, height))));
    }
    parts.push(h('p', { class: 'section-title', text: t('Tournaments') }));
    const shown = [...open, ...upcoming];
    if (shown.length) {
      parts.push(h('div', { class: 'card list', 'data-testid': 'fuddle-tournaments' }, ...shown.map((x) => tournamentRow(x, height, x === ctaTour))));
      if (ctaTour) parts.push(h('div', { class: 'actions' }, primary(t('Play tournament #{tid}', { tid: ctaTour.tid }), () => app.go('fuddleTournament', { tid: ctaTour.tid }), { 'data-testid': 'fuddle-play' })));
    } else {
      parts.push(h('div', { class: 'card empty', 'data-testid': 'fuddle-none-open' }, fuddleMark('big'), h('p', { text: t('No tournament is taking entries right now.') }), h('p', { class: 'small', text: t('A new one usually opens every day. Look again later; your games and winnings stay here.') })));
    }
    parts.push(h('div', { class: 'btn-row fuddle-more' }, textButton(t('All your games'), () => app.go('fuddleGames'), { 'data-testid': 'fuddle-all-games' })));
    put(body, ...parts);
  }

  async function load() {
    error = null;
    render();
    try {
      const browse = await svc.browse();
      const mine = await svc.mine(browse.tournaments);
      data = { browse, mine };
    } catch (e) {
      error = e;
    }
    render();
  }

  load();
  const poll = poller(load, () => POLL_MS);
  const off = wallet.onChange(() => render());
  const el = screen({ title: t('Fuddle'), back: () => app.back('dapps'), cls: 'fuddle feature' }, body);
  return {
    el,
    destroy() {
      alive = false;
      poll.stop();
      off();
    },
  };
}

// ---------------------------------------------------------------- a tournament

/* A Fuddle tournament (Fuddle -> a tournament)
 * Spec: ONE job: enter this tournament knowing its rules and exactly what it costs; once it is
 *       settled, collect what it pays.
 *       Primary CTA: "Enter and pay 1.143 BEAM" (entry + answering fee + network fee), or once settled
 *       "Collect 6.50 BEAM". The approve sheet that follows shows the same figures.
 *       Taps from app open: 4 (Home -> dApps -> Fuddle -> Play -> Enter), then approve.
 * Exit-intent reasons and answers:
 *   - "What happens to my money?" -> entry, answering fee and network fee before the button; the
 *     prize pool, the fee and the creator's cut in the rules; refunds and the compensation if the
 *     service fails.
 *   - "How long does it take?" -> the clocks in plain minutes and hours, from this tournament's figures.
 *   - "Which length?" -> 5 letters picked; longer words score more, said with the chips.
 *   - "Why can't I enter?" -> the reason replaces the button (closed, full, not synced, not enough).
 */
export function fuddleTournament(app, { tid }) {
  const svc = service();
  if (!svc) return soon(app);
  let alive = true;
  let busy = false;
  let d = null; // { tour, state, me, games, answerer }
  let error = null;
  let note = null;
  let len = null;
  const body = h('div', { class: 'content fuddle-tour-screen' });

  const kv = (k, v, testid, sub = null) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid, text: v }));

  function enterState() {
    const { tour, state, me } = d;
    const height = state.height;
    const problem = svc.entryProblem(tour, { height, me, paused: state.paused });
    if (problem) return { off: problem };
    // A full tournament may still take an entry: the place of a game nobody played in time goes to it.
    const blocked = sendBlock();
    if (blocked) return { off: blocked };
    const cost = entryCost(tour);
    const need = new Map([[0, cost.beamTotal]]);
    if (tour.asset !== 0) need.set(tour.asset, tour.entry);
    const short = shortText(need);
    if (short) return { off: short, receive: true };
    return { off: null, cost };
  }

  function rulesCard(tour) {
    const rules = rulesBeforeEntering(tour, { slashText: amt(0, tour.slash), priceText: amt(tour.asset, tour.letterPrice) });
    return h('div', { class: 'card fuddle-rules', 'data-testid': 'fuddle-rules' }, h('h3', { text: t('Before you play') }), h('ul', { class: 'fuddle-rule-list' }, ...rules.map((r) => h('li', { 'data-rule': r.id, text: r.text }))));
  }

  function lengthChips(tour) {
    const lens = lengthsOf(tour.lenMask);
    if (!lens.includes(len)) len = lens.includes(PREFERRED_LENGTH) ? PREFERRED_LENGTH : lens[0];
    const chip = (n) =>
      h(
        'button',
        { class: `choice${n === len ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(n === len), 'data-testid': `fuddle-len-${n}`, onclick: () => ((len = n), render()) },
        tn({ one: '{n} letter', other: '{n} letters' }, n),
      );
    return h(
      'div',
      { class: 'fuddle-lengths' },
      h('p', { class: 'section-title', text: t('Word length') }),
      h('div', { class: `choices ${lens.length === 3 ? 'three' : ''}`, role: 'radiogroup', 'aria-label': t('Word length') }, ...lens.map(chip)),
      h('p', { class: 'small', text: lens.length > 1 ? t('Longer words score more: 5 letters count 1.25 times, 6 letters 1.5 times. A 5-letter game solved in three guesses scores {score}.', { score: scoreOf(5, 3).toLocaleString('en-US') }) : t('This tournament plays {n}-letter words; scores count {mult}%.', { n: lens[0], mult: lengthMultiplier(lens[0]) }) }),
    );
  }

  function costCard(tour) {
    const c = entryCost(tour);
    return h(
      'div',
      { class: 'card flat fuddle-cost', 'data-testid': 'fuddle-cost' },
      kv(t('Entry'), amt(tour.asset, tour.entry), 'fuddle-cost-entry', t('goes into the prize pool')),
      kv(t('Answering fee'), amt(0, tour.answerFee), 'fuddle-cost-answer', t('paid to the answer service for a game you play; back if you never guess')),
      kv(t('Network fee'), amt(0, c.fee), 'fuddle-cost-fee'),
      kv(t('You pay now'), amounts(tour.asset, tour.entry, tour.answerFee + c.fee), 'fuddle-cost-total'),
    );
  }

  function resultCard() {
    const { tour, me, payout } = d;
    if (!me || !me.joined) return null;
    if (tour.phase === 'finalised') {
      if (me.claimed) return h('div', { 'data-testid': 'fuddle-collected' }, notice('success', t('You collected what this tournament paid you.')));
      if (!payout || payout.nothing) return h('div', { 'data-testid': 'fuddle-nothing' }, notice('info', t('This tournament is settled. Nothing is left for you to collect: no score, and every refund was taken.')));
      return h(
        'div',
        { class: 'card fuddle-result', 'data-testid': 'fuddle-result' },
        h('h3', { text: t('Your result') }),
        kv(t('Your score'), me.score.toLocaleString('en-US'), 'fuddle-score', tour.totalScore ? t('of {total} scored by all players', { total: tour.totalScore.toLocaleString('en-US') }) : t('nobody scored: everyone gets back what they paid in')),
        kv(t('Your share of the prize pool'), amt(tour.asset, payout.prize), 'fuddle-prize'),
        payout.refundAsset ? kv(t('Refunds not taken yet'), amt(tour.asset, payout.refundAsset), 'fuddle-refund-asset') : null,
        payout.refundBeam ? kv(t('BEAM back'), amt(0, payout.refundBeam), 'fuddle-refund-beam', t('answering fees and compensation')) : null,
        kv(t('Network fee'), amt(0, FEES.claim), 'fuddle-claim-fee'),
        kv(t('You collect'), amounts(tour.asset, payout.assetAmount, payout.beam), 'fuddle-collect-total'),
      );
    }
    if (tour.phase === 'ready_to_finalise' || tour.phase === 'ending') {
      return h(
        'div',
        { class: 'card fuddle-result', 'data-testid': 'fuddle-settling' },
        h('h3', { text: t('Your result') }),
        kv(t('Your score so far'), me.score.toLocaleString('en-US'), 'fuddle-score'),
        me.prizeEstimate !== undefined ? kv(t('Your share if it ended now'), amt(tour.asset, me.prizeEstimate), 'fuddle-estimate') : null,
        h('p', { class: 'small', text: tour.phase === 'ready_to_finalise' ? t('Every game has ended. The answer service settles the tournament within minutes; then you can collect here.') : t('The tournament has ended; its last games are finishing. Once every game has ended it is settled and you can collect here.') }),
      );
    }
    return h(
      'div',
      { class: 'card fuddle-result', 'data-testid': 'fuddle-standing' },
      kv(t('Your score so far'), me.score.toLocaleString('en-US'), 'fuddle-score'),
      me.prizeEstimate !== undefined ? kv(t('Your share if it ended now'), amt(tour.asset, me.prizeEstimate), 'fuddle-estimate') : null,
    );
  }

  function gamesCard() {
    if (!d.games.length) return null;
    return h(
      'div',
      { class: 'fuddle-my-games' },
      h('p', { class: 'section-title', text: t('Your games here') }),
      h(
        'div',
        { class: 'card list' },
        ...d.games.map((g) => {
          const o = gameOutcome(g, { claimed: d.me && d.me.claimed });
          return h(
            'button',
            { class: 'row', type: 'button', 'data-testid': `fuddle-tgame-${g.idx}`, onclick: () => app.go('fuddleGame', { tid, idx: g.idx }) },
            h('span', { class: 'main' }, h('div', { class: 't', text: tn({ one: 'Game {idx}: {n} letter', other: 'Game {idx}: {n} letters' }, g.len, { idx: g.idx }) }), h('div', { class: 's', text: outcomeWords(o, g) })),
            h('span', { class: 'chev' }, icon('chevron')),
          );
        }),
      ),
    );
  }

  function render() {
    if (!alive) return;
    if (error && !d) return put(body, h('div', { 'data-testid': 'fuddle-load-failed' }, notice('error', t('This tournament could not be read: {reason}', { reason: error.message }))), h('div', { class: 'actions' }, primary(t('Try again'), () => load(), { 'data-testid': 'fuddle-retry' })));
    if (!d) return put(body, h('div', { class: 'card fuddle-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text: t('Reading the tournament…') })));
    const { tour, state } = d;
    const height = state.height;
    const pool = tour.phase === 'finalised' ? tour.pool : tour.poolEstimate;
    const open = tour.phase === 'open' || tour.phase === 'upcoming';
    // What a player decides by, at the top; the rest (end, players, the service's record) further down.
    const head = h(
      'div',
      { class: 'card fuddle-tour-head', 'data-testid': 'fuddle-tour-head' },
      h('div', { class: 'fuddle-next-head' }, fuddleMark(), h('div', { class: 'grow' }, h('div', { class: 'name', text: t('Tournament #{tid}', { tid: tour.tid }) }), h('div', { class: 'small', text: answeredBy(svc, tour) }))),
      kv(tour.phase === 'finalised' ? t('Prize pool') : t('Prize pool now'), amt(tour.asset, pool), 'fuddle-pool', tour.sponsored ? t('{amount} of it put up by the creator', { amount: amt(tour.asset, tour.sponsored) }) : null),
      open ? kv(t('Entries close'), whenText(tour.entriesCloseH, height), 'fuddle-close') : null,
      open ? kv(t('Places free'), t('{free} of {all}', { free: Math.max(0, tour.maxOpen - tour.openGames), all: tour.maxOpen }), 'fuddle-free') : null,
    );
    const details = h(
      'div',
      { class: 'card fuddle-details', 'data-testid': 'fuddle-details' },
      tour.phase === 'finalised' ? null : kv(t('Ends'), whenText(tour.endH, height), 'fuddle-ends', t('block {h}', { h: tour.endH.toLocaleString('en-US') })),
      kv(t('Players'), String(tour.players), 'fuddle-players'),
      d.answerer ? kv(t('Answer service record'), t('{honest} games answered honestly · {failed} failed', { honest: d.answerer.honestGames.toLocaleString('en-US'), failed: d.answerer.failedGames.toLocaleString('en-US') }), 'fuddle-service-record', t('a bond of {bond} pays for its failures', { bond: amt(0, d.answerer.bond) })) : null,
    );
    const msg = note ? notice(note.kind, note.text) : null;
    if (msg) msg.dataset.testid = 'fuddle-note';
    let parts;
    if (tour.phase === 'finalised' && d.me && d.me.joined && !d.me.claimed && d.payout && !d.payout.nothing) {
      // Settled, with money for this wallet: the result and Collect first.
      const actions = h('div', { class: 'actions' }, sendBlock() ? h('p', { class: 'hint center', text: sendBlock() }) : null, primary(t('Collect {amount}', { amount: amounts(tour.asset, d.payout.assetAmount, d.payout.beam) }), collect, { disabled: busy || Boolean(sendBlock()), 'data-testid': 'fuddle-collect' }));
      parts = [resultCard(), msg, actions, head, details, gamesCard()];
    } else if (open) {
      const st = enterState();
      const actions = h(
        'div',
        { class: 'actions' },
        st.off ? h('p', { class: 'hint center', 'data-testid': 'fuddle-enter-reason', text: st.off }) : null,
        st.receive ? textButton(t('Receive BEAM'), () => app.go('receive')) : null,
        primary(t('Enter and pay {amount}', { amount: amounts(tour.asset, tour.entry, tour.answerFee + FEES.enterGame) }), enter, { disabled: busy || Boolean(st.off), 'data-testid': 'fuddle-enter' }),
      );
      // The button stays at the bottom of the screen (sticky) while the rules above it are read.
      parts = [head, lengthChips(tour), rulesCard(tour), costCard(tour), msg, actions, resultCard(), gamesCard(), details];
    } else {
      parts = [head, resultCard(), msg, gamesCard()];
      if (tour.phase === 'ready_to_finalise' && d.me && d.me.joined) parts.push(h('div', { class: 'actions' }, secondary(t('Settle it now ({fee} BEAM network fee)', { fee: formatAmount(FEES.finalize) }), settle, { disabled: busy || Boolean(sendBlock()), 'data-testid': 'fuddle-settle' })));
      if (!d.me || !d.me.joined) parts.push(h('p', { class: 'small', 'data-testid': 'fuddle-closed', text: !tour.accepted ? svc.entryProblem(tour, { height }) : tour.phase === 'finalised' ? t('This tournament is settled.') : t('Entries for this tournament are closed. Its games are finishing.') }));
      parts.push(details);
    }
    put(body, ...parts);
  }

  async function load() {
    error = null;
    try {
      const [tour, state, me, games] = await Promise.all([svc.tournament(tid), svc.state(), svc.myTournament(tid), svc.myGames(tid)]);
      const answerer = await svc.answerer(tour.answerer).catch(() => null);
      let payout = null;
      if (tour.phase === 'finalised' && me.joined && !me.claimed) payout = (await svc.claimPreview(tid)).payout;
      d = { tour, state, me, games, answerer, payout };
    } catch (e) {
      error = e;
    }
    render();
  }

  async function act(fn, sent) {
    if (busy) return;
    app.touch();
    busy = true;
    note = null;
    render();
    try {
      const r = await fn();
      if (!alive) return;
      note = { kind: 'success', text: sent(r) };
      wallet.refreshTxs();
      wallet.refreshStatus();
      return r;
    } catch (e) {
      if (!alive) return;
      note = { kind: e.code === 'rejected' ? 'info' : 'error', text: problemText(e) };
    } finally {
      busy = false;
      if (alive) render();
    }
    return null;
  }

  async function enter() {
    const tour = d.tour;
    const chosen = len;
    const known = d.games.map((g) => g.idx);
    const words = { rows: [[t('Entry'), amt(tour.asset, tour.entry)], [t('Answering fee'), amt(0, tour.answerFee)]], notes: [t('If the answer service fails your game, you get back the entry, its letters and the answering fee, plus {slash}.', { slash: amt(0, tour.slash) })] };
    const r = await act(() => svc.enter({ tid, len: chosen, words }), () => t('Entry sent.'));
    if (r && alive) app.go('fuddleGame', { tid, entering: { txId: r.txId, known, len: chosen } });
  }

  async function collect() {
    const tour = d.tour;
    const p = d.payout;
    const words = { rows: [[t('Your share of the prize pool'), amt(tour.asset, p.prize)], ...(p.refundAsset ? [[t('Refunds not taken yet'), amt(tour.asset, p.refundAsset)]] : []), ...(p.refundBeam ? [[t('BEAM back'), amt(0, p.refundBeam)]] : [])] };
    await act(() => svc.claim({ tid, words }), () => t('Sent. It reaches your balance in about a minute.'));
    load();
  }

  async function settle() {
    await act(() => svc.settle({ tid, words: { notes: [t('Settling counts the scores and fixes everyone\'s payout. Anyone may do it once every game has ended.')] } }), () => t('Sent. The tournament is settled in about a minute.'));
    load();
  }

  load();
  const poll = poller(load, () => POLL_MS);
  const off = wallet.onChange(() => d && render());
  const el = screen({ title: t('Fuddle'), back: () => app.back('fuddle'), cls: 'fuddle feature sticky-actions' }, body);
  return {
    el,
    destroy() {
      alive = false;
      poll.stop();
      off();
    },
  };
}

/** How a game turned out, in a few words, for the lists. */
function outcomeWords(o, g) {
  switch (o.outcome) {
    case 'playing':
      return g.phase === 'waiting_hint' ? t('Waiting for the hint') : g.phase === 'your_move' ? t('Your turn') : t('In play');
    case 'checking':
      return t('Game over · the word is being revealed');
    case 'solved':
      return tn({ one: 'Solved in {n} guess · score {score}', other: 'Solved in {n} guesses · score {score}' }, g.solvedAt, { score: o.score.toLocaleString('en-US') });
    case 'unsolved':
      return t('Not solved');
    case 'stopped':
      return t('Ended: no guess in time');
    case 'failed':
      return o.refundable ? t('The service failed it: refund ready') : t('The service failed it: refunded');
    case 'unplayed':
      return o.refundable ? t('Never played: entry ready to take back') : t('Never played: entry taken back');
    case 'late':
      return t('The answer service is late');
    case 'abandoned':
      return t('No first guess in time');
    default:
      return '';
  }
}

// ---------------------------------------------------------------- a game

/* A Fuddle game (Fuddle -> Continue your game, or a game in a list)
 * Spec: ONE job: make the next guess, and see clearly what happens to it.
 *       Primary CTA: "Send my guess" once a whole word is typed (the approve sheet shows the letters
 *       it buys and the fee); when the game is over and owes money: "Take back 1.68 BEAM" or "End the game".
 *       Taps from app open: 4 (Home -> dApps -> Fuddle -> Continue your game), type, Send my guess.
 * Exit-intent reasons and answers:
 *   - "Did my guess go through? Where is my hint?" -> each step is shown as it happens, with how long it
 *     usually takes and by when it must come.
 *   - "How much time do I have?" -> the clock under the grid, in minutes, and what happens when it runs out.
 *   - "I can't tell the colours apart" -> every hint has its mark (tick, arrows, dash) and is read out.
 *   - "The service failed / took too long" -> the refund (and the compensation) is one button away.
 *   - "What did that cost?" -> the letters a guess buys and the fee are said before sending it.
 */
export function fuddleGame(app, params = {}) {
  const svc = service();
  if (!svc) return soon(app);
  const tid = params.tid;
  let idx = Number.isInteger(params.idx) ? params.idx : null;
  let entering = params.entering || null; // { txId, known, len, status }
  let alive = true;
  let busy = false;
  let game = null;
  let tour = null;
  let me = null;
  let height = 0;
  let error = null;
  let note = null;
  let typed = '';
  let pending = null; // { txId, attempt, word }
  const body = h('div', { class: 'content fuddle-play' });
  const live = h('div', { class: 'fuddle-status', 'aria-live': 'polite', 'data-testid': 'fuddle-status' });

  const canType = () => game && game.phase === 'your_move' && !pending && !busy;

  function steps(list) {
    return h(
      'div',
      { class: 'steps', 'data-testid': 'fuddle-steps' },
      ...list.map(([state, text, sub]) => h('div', { class: `step-row ${state}`, 'data-state': state }, h('span', { class: 'step-mark' }, state === 'done' ? icon('check') : state === 'failed' ? icon('close') : null), h('span', { class: 'grow' }, h('div', { text }), sub ? h('div', { class: 'small', text: sub }) : null))),
    );
  }

  /** What the status block says: the game's clock, a guess on its way, how it ended. */
  function status() {
    if (entering) {
      if (entering.status === 'failed') return notice('error', t('Your entry did not go through. Nothing left your wallet. Go back and try again.'));
      return h('div', { class: 'card', 'data-testid': 'fuddle-entering' }, h('h3', { text: t('Starting your game') }), steps([[entering.status === 'landed' ? 'done' : 'active', t('Entry on its way to a block'), t('about a minute')], [entering.status === 'landed' ? 'active' : 'waiting', t('Your game opens'), t('the first-guess clock starts then')]]));
    }
    if (!game) return null;
    const o = gameOutcome(game, { claimed: me && me.claimed });
    const clock = gameClock(game, height);
    if (pending) {
      return h(
        'div',
        { class: 'card', 'data-testid': 'fuddle-sending', 'data-state': 'sending' },
        steps([
          ['active', t('Sending your guess'), t('it lands in the next block, about a minute')],
          ['waiting', t('The answer service checks it'), t('usually within a minute or two')],
          ['waiting', t('Your hint appears here'), null],
        ]),
        h('p', { class: 'small', text: t('You can leave this screen: the hint waits here for you.') }),
      );
    }
    if (o.outcome === 'playing' && clock.kind === 'hint') {
      return h(
        'div',
        { class: 'card', 'data-testid': 'fuddle-waiting', 'data-state': 'waiting' },
        steps([
          ['done', t('Your guess is on chain'), null],
          ['active', t('The answer service checks it'), t('usually within a minute or two; it must answer within {time}', { time: blocksText(clock.blocksLeft) })],
          ['waiting', t('Your hint appears here'), null],
        ]),
        h('p', { class: 'small', text: t('You can leave this screen: the hint waits here for you.') }),
      );
    }
    if (o.outcome === 'playing') {
      return h('div', { class: `fuddle-clock${clock.blocksLeft <= 10 ? ' urgent' : ''}`, 'data-testid': 'fuddle-clock', 'data-kind': clock.kind }, icon('clock'), h('span', { text: clockText(clock) }));
    }
    if (o.outcome === 'checking') return h('div', { 'data-testid': 'fuddle-checking' }, notice('info', o.solved ? h('strong', { text: `${t('Solved!')} ` }) : null, clockText(clock)));
    if (o.outcome === 'solved') return h('div', { 'data-testid': 'fuddle-solved' }, notice('success', h('strong', { text: `${tn({ one: 'Solved in {n} guess.', other: 'Solved in {n} guesses.' }, game.solvedAt)} ` }), t('Score {score}. Your share of the prize pool is paid when the tournament ends.', { score: o.score.toLocaleString('en-US') })));
    if (o.outcome === 'unsolved') return h('div', { 'data-testid': 'fuddle-unsolved' }, notice('info', h('strong', { text: `${t('Not solved in six guesses.')} ` }), t('The word was checked on chain against every hint. Your entry stays in the prize pool.')));
    if (o.outcome === 'stopped') return h('div', { 'data-testid': 'fuddle-stopped' }, notice('info', h('strong', { text: `${t('This game ended unsolved.')} ` }), t('No guess came within {time} of the last hint, so the game ended. Your entry stays in the prize pool.', { time: blocksText(60) })));
    if (o.outcome === 'late' || o.outcome === 'abandoned') return h('div', { 'data-testid': 'fuddle-late', 'data-kind': clock.kind }, notice('warn', clockText(clock)), h('p', { class: 'small', text: o.outcome === 'late' ? t('Step 1 of 2: end the game (a {fee} BEAM network fee). Step 2: take your refund, here.', { fee: formatAmount(FEES.claimTimeout) }) : t('Step 1 of 2: end the game (a {fee} BEAM network fee). Step 2: take your entry back, here. Or leave it: it comes back with your final collection when the tournament ends.', { fee: formatAmount(FEES.claimTimeout) }) }));
    if (o.outcome === 'failed' || o.outcome === 'unplayed') {
      const r = refundOf(tour, game);
      const what = amounts(r.asset, r.assetAmount, r.beam);
      const head = o.outcome === 'failed' ? failedReason(game.verdict) : t('No first guess was made in time, so this game never started.');
      const tail = o.refundable
        ? o.outcome === 'failed'
          ? t('You get back {amount}: the entry, the letters of this game and the answering fee, plus {slash} compensation from the service\'s bond.', { amount: what, slash: amt(0, r.slash) })
          : t('You get back {amount}: the entry and the answering fee.', { amount: what })
        : game.refunded
          ? t('Refund taken: {amount}.', { amount: what })
          : t('Its refund came with your final collection.');
      return h('div', { 'data-testid': o.outcome === 'failed' ? 'fuddle-failed' : 'fuddle-unplayed', 'data-refunded': game.refunded ? '1' : '0' }, notice(o.refundable ? 'warn' : 'success', h('strong', { text: `${head} ` }), tail));
    }
    return null;
  }

  function costLine() {
    if (!canType() || !tour || !me) return null;
    const word = cleanGuess(typed, game.len);
    // While typing, letters not typed yet are counted as bought: the most this guess can cost.
    const most = missingLetters(me.letters, word) + (game.len - word.length);
    const c = guessCost(game.letterPrice, most);
    return h(
      'p',
      { class: 'small center', 'data-testid': 'fuddle-guess-cost' },
      word.length < game.len
        ? t('Up to {amount} for letters · network fee {fee} BEAM', { amount: amt(tour.asset, c.letters), fee: formatAmount(c.fee) })
        : most
          ? tn({ one: 'Buys {n} letter for {amount} · network fee {fee} BEAM', other: 'Buys {n} letters for {amount} · network fee {fee} BEAM' }, most, { amount: amt(tour.asset, c.letters), fee: formatAmount(c.fee) })
          : t('Uses letters you bought ahead · network fee {fee} BEAM', { fee: formatAmount(c.fee) }),
    );
  }

  function onKey(k) {
    if (!canType()) return;
    app.touch();
    if (k === 'back') typed = typed.slice(0, -1);
    else if (k === 'enter') return send();
    else if (typed.length < game.len) typed += k;
    render();
  }

  function render() {
    if (!alive) return;
    put(live, status());
    if (error && !game && !entering) {
      return put(body, h('div', { 'data-testid': 'fuddle-load-failed' }, notice('error', t('This game could not be read: {reason}', { reason: error.message }))), h('div', { class: 'actions' }, primary(t('Try again'), () => load(), { 'data-testid': 'fuddle-retry' })));
    }
    if (!game) return put(body, live, entering ? null : h('div', { class: 'card fuddle-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text: t('Reading your game…') })));
    const o = gameOutcome(game, { claimed: me && me.claimed });
    const msg = note ? notice(note.kind, note.text) : null;
    if (msg) msg.dataset.testid = 'fuddle-note';
    const head = h('div', { class: 'fuddle-game-head' }, h('span', { class: 'small', text: tn({ one: '{n} letter · tournament #{tid} · game {idx}', other: '{n} letters · tournament #{tid} · game {idx}' }, game.len, { tid, idx: game.idx }) }), h('span', { class: 'small', 'data-testid': 'fuddle-attempt', text: t('Guess {n} of {total}', { n: Math.max(1, Math.min(MAX_ATTEMPTS, game.attempts + (canType() ? 1 : 0))), total: MAX_ATTEMPTS }) }));
    // The word being typed stays in its row while the guess is prepared and approved.
    const parts = [head, live, grid(game, { typed, pending, canType: game.phase === 'your_move' && !pending }), legend(), msg];
    let actions = null;
    if (o.outcome === 'playing' && game.phase === 'your_move' && !pending) {
      const blocked = sendBlock();
      const ready = typed.length === game.len;
      // The keyboard and the button stay at the bottom of the screen, as a phone's keyboard does.
      actions = h(
        'div',
        { class: 'fuddle-panel', 'data-testid': 'fuddle-panel' },
        keyboard(letterStates(game.guesses), { onKey, disabled: busy }),
        costLine(),
        blocked ? h('p', { class: 'hint center', text: blocked }) : null,
        primary(ready ? t('Send my guess') : tn({ one: 'Type {n} more letter', other: 'Type {n} more letters' }, game.len - typed.length), send, { disabled: busy || !ready || Boolean(blocked), 'data-testid': 'fuddle-send' }),
      );
      parts.push(h('button', { class: 'btn btn-text btn-small fuddle-buy-link', type: 'button', onclick: buySheet, 'data-testid': 'fuddle-buy' }, t('Buy letters ahead')));
    } else if (o.endable) {
      actions = h('div', { class: 'actions' }, primary(t('End the game'), endGame, { disabled: busy || Boolean(sendBlock()), 'data-testid': 'fuddle-end' }), secondary(t('Back to Fuddle'), () => app.go('fuddle')));
    } else if (o.refundable) {
      const r = refundOf(tour, game);
      actions = h('div', { class: 'actions' }, primary(t('Take back {amount}', { amount: amounts(r.asset, r.assetAmount, r.beam) }), refund, { disabled: busy || Boolean(sendBlock()), 'data-testid': 'fuddle-refund' }), secondary(t('Back to Fuddle'), () => app.go('fuddle')));
    } else if (o.outcome !== 'playing') {
      actions = h('div', { class: 'actions' }, secondary(t('Back to Fuddle'), () => app.go('fuddle'), { 'data-testid': 'fuddle-back-home' }), textButton(t('See the tournament'), () => app.go('fuddleTournament', { tid })));
    }
    parts.push(actions);
    put(body, ...parts);
  }

  async function findEntered() {
    const st = await wallet.txStatus(entering.txId).catch(() => null);
    const s = Number(st && st.status);
    if (s === 2 || s === 4) {
      entering.status = 'failed';
      return;
    }
    if (s === 3) entering.status = 'landed';
    if (entering.status !== 'landed') return;
    const mine = await svc.myGames(tid);
    const fresh = mine.filter((g) => !entering.known.includes(g.idx) && g.len === entering.len).sort((a, b) => b.idx - a.idx)[0];
    if (fresh) {
      idx = fresh.idx;
      entering = null;
    }
  }

  async function load() {
    error = null;
    try {
      if (entering) await findEntered();
      if (idx === null) return render();
      const [g, tr, m, st] = await Promise.all([svc.game(tid, idx), tour ? Promise.resolve(tour) : svc.tournament(tid), svc.myTournament(tid), svc.state()]);
      game = g;
      tour = tr;
      me = m;
      height = st.height;
      // A guess on its way: kept until the game shows it.
      if (pending && game.attempts > pending.attempt) pending = null;
      if (pending && pending.txId) {
        const s = Number(((await wallet.txStatus(pending.txId).catch(() => null)) || {}).status);
        if (s === 2 || s === 4) {
          note = { kind: 'error', text: t('Your guess did not go through. Nothing left your wallet. Type it again and send it.') };
          typed = pending.word;
          pending = null;
        }
      }
    } catch (e) {
      error = e;
    }
    render();
  }

  async function act(fn, sent) {
    if (busy) return null;
    app.touch();
    busy = true;
    note = null;
    render();
    try {
      const r = await fn();
      if (!alive) return null;
      if (sent) note = { kind: 'success', text: sent(r) };
      wallet.refreshTxs();
      wallet.refreshStatus();
      return r;
    } catch (e) {
      if (alive) note = { kind: e.code === 'rejected' ? 'info' : 'error', text: problemText(e) };
      return null;
    } finally {
      busy = false;
      if (alive) render();
    }
  }

  async function send() {
    if (!canType() || typed.length !== game.len) return;
    const word = typed;
    const r = await act(() => svc.guess({ tid, idx, word }), null);
    if (r) {
      pending = { txId: r.txId, attempt: r.attempt, word: r.guess };
      typed = '';
      render();
      poll.kick();
    }
  }

  async function endGame() {
    await act(() => svc.endGame({ tid, idx, words: { notes: [t('Ending the game moves no money; the refund is the next step, on this screen.')] } }), () => t('Sent. The game ends in about a minute; then take your refund here.'));
    load();
  }

  async function refund() {
    const r = refundOf(tour, game);
    const rows = [[t('Entry'), amt(r.asset, tour.entry)]];
    if (r.letters) rows.push([t('Letters of this game'), amt(r.asset, r.letters)]);
    rows.push([t('Answering fee'), amt(0, tour.answerFee)]);
    if (r.slash) rows.push([t("Compensation from the service's bond"), amt(0, r.slash)]);
    await act(() => svc.refund({ tid, idx, words: { rows } }), () => t('Sent. It reaches your balance in about a minute.'));
    load();
  }

  function buySheet() {
    if (!tour) return;
    let text = '';
    let sheetBusy = false;
    const stock = me ? me.letters.reduce((n, x) => n + x, 0) : 0;
    let problem = null;
    const s = openSheet(
      (close, rerender) => {
        const letters = cleanGuess(text, 256);
        const cost = tour.letterPrice * BigInt(letters.length);
        const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: text, 'aria-label': t('Letters to buy'), 'data-testid': 'fuddle-buy-input' });
        input.addEventListener('input', () => {
          text = input.value;
          const pos = input.selectionStart;
          rerender();
          const again = document.querySelector('[data-testid="fuddle-buy-input"]');
          if (again) {
            again.focus();
            again.setSelectionRange(pos, pos);
          }
        });
        const go = async () => {
          if (sheetBusy || !letters.length) return;
          sheetBusy = true;
          problem = null;
          rerender();
          try {
            await svc.buyLetters({ tid, letters });
            close(true);
            toast(t('Sent. Your letters arrive in about a minute.'), 5000);
            load();
          } catch (e) {
            problem = problemText(e);
            sheetBusy = false;
            rerender();
          }
        };
        return h(
          'div',
          { class: 'fuddle-buy', 'data-testid': 'fuddle-buy-sheet' },
          h('h2', { text: t('Buy letters ahead') }),
          h('p', { class: 'small', text: t('Each guess buys the letters it needs by itself, so you never have to do this. Letters bought ahead are used first by your guesses in this tournament.') }),
          stock ? h('p', { class: 'small', 'data-testid': 'fuddle-stock', text: tn({ one: 'You have {n} letter bought ahead here.', other: 'You have {n} letters bought ahead here.' }, stock) }) : null,
          notice('warn', t("Letters bought ahead stay in this tournament. If its answer service stops taking new games you can't start another game to use them, and letters left when the tournament ends are not given back.")),
          h('label', { class: 'field' }, h('span', { text: t('Letters, one for each you want (for example aeiou)') }), input),
          h('p', { class: 'small', 'data-testid': 'fuddle-buy-cost', text: letters.length ? t('{n} letters: {amount}, plus a {fee} BEAM network fee.', { n: letters.length, amount: amt(tour.asset, cost), fee: formatAmount(FEES.buyLetters) }) : t('Type the letters you want.') }),
          problem ? notice('error', problem) : null,
          h('div', { class: 'actions' }, primary(letters.length ? tn({ one: 'Buy {n} letter', other: 'Buy {n} letters' }, letters.length) : t('Buy letters'), go, { disabled: sheetBusy || !letters.length || Boolean(sendBlock()), 'data-testid': 'fuddle-buy-go' }), textButton(t('Cancel'), () => close(false))),
        );
      },
      { label: t('Buy letters ahead') },
    );
    return s;
  }

  // The keyboard of a computer types too (letters, Backspace, Enter), unless a field or a sheet has it.
  const onKeyDown = (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || document.querySelector('.overlay')) return;
    if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    if (/^[a-zA-Z]$/.test(ev.key)) onKey(ev.key.toLowerCase());
    else if (ev.key === 'Backspace') onKey('back');
    else if (ev.key === 'Enter' && typed.length && game && typed.length === game.len) onKey('enter');
    else return;
    ev.preventDefault();
  };
  document.addEventListener('keydown', onKeyDown);

  load();
  const poll = poller(load, () => (pending || entering || (game && game.phase === 'waiting_hint') ? POLL_WAIT_MS : POLL_MS));
  const off = wallet.onChange(() => game && render());
  const el = screen({ title: t('Fuddle'), back: () => app.back('fuddle'), cls: 'fuddle feature sticky-actions' }, body);
  return {
    el,
    destroy() {
      alive = false;
      poll.stop();
      off();
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}

// ---------------------------------------------------------------- your games

/* Your Fuddle games (Fuddle -> All your games)
 * Spec: ONE job: see every game of yours that is in play, owes you money or just finished, and open it.
 *       Primary CTA: none of its own: each row opens its game (or its tournament to collect).
 *       Taps from app open: 4 (Home -> dApps -> Fuddle -> All your games).
 * Exit-intent reasons and answers:
 *   - "Where is my money?" -> refunds and collections first, with their amounts.
 *   - "No games?" -> says so, with the way to play.
 */
export function fuddleGames(app) {
  const svc = service();
  if (!svc) return soon(app);
  let alive = true;
  let data = null;
  let error = null;
  const body = h('div', { class: 'content' });

  function render() {
    if (!alive) return;
    if (error && !data) return put(body, notice('error', t('Your games could not be read: {reason}', { reason: error.message })), h('div', { class: 'actions' }, primary(t('Try again'), () => load())));
    if (!data) return put(body, h('div', { class: 'card fuddle-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text: t('Reading your games…') })));
    const { games, claims } = data.mine;
    const height = data.browse.height;
    if (!games.length && !claims.length) {
      return put(body, h('div', { class: 'card empty', 'data-testid': 'fuddle-games-none' }, fuddleMark('big'), h('p', { text: t('No games yet.') }), h('p', { class: 'small', text: t('Your games show here while their tournament runs, and until you collect what it pays.') })), h('div', { class: 'actions' }, primary(t('Find a tournament'), () => app.go('fuddle'))));
    }
    const order = { late: 0, abandoned: 0, failed: 1, unplayed: 1, playing: 2, checking: 3, solved: 4, unsolved: 4, stopped: 4 };
    const sorted = [...games].sort((a, b) => (order[a.outcome.outcome] ?? 5) - (order[b.outcome.outcome] ?? 5) || b.tour.tid - a.tour.tid || b.game.idx - a.game.idx);
    put(
      body,
      claims.length ? h('p', { class: 'section-title', text: t('To collect') }) : null,
      claims.length
        ? h(
            'div',
            { class: 'card list', 'data-testid': 'fuddle-games-claims' },
            ...claims.map((c) =>
              h(
                'button',
                { class: 'row', type: 'button', 'data-testid': `fuddle-claim-${c.tid}`, onclick: () => app.go('fuddleTournament', { tid: c.tid }) },
                h('span', { class: 'ico ok' }, icon('gift')),
                h('span', { class: 'main' }, h('div', { class: 't', text: t('Tournament #{tid} is settled', { tid: c.tid }) }), h('div', { class: 's', text: t('Collect {amount}', { amount: amounts(c.asset, c.payoutAsset, c.payoutBeam) }) })),
                h('span', { class: 'chev' }, icon('chevron')),
              ),
            ),
          )
        : null,
      games.length ? h('p', { class: 'section-title', text: t('Games') }) : null,
      games.length
        ? h(
            'div',
            { class: 'card list', 'data-testid': 'fuddle-games-list' },
            ...sorted.map((x) =>
              h(
                'button',
                { class: 'row', type: 'button', 'data-testid': `fuddle-game-${x.tour.tid}-${x.game.idx}`, 'data-outcome': x.outcome.outcome, onclick: () => app.go('fuddleGame', { tid: x.tour.tid, idx: x.game.idx }) },
                h('span', { class: 'main' }, h('div', { class: 't', text: tn({ one: '{n} letter · tournament #{tid}', other: '{n} letters · tournament #{tid}' }, x.game.len, { tid: x.tour.tid }) }), h('div', { class: 's', text: x.outcome.outcome === 'playing' && x.game.phase === 'your_move' ? t('Your move · {time} left', { time: blocksText(gameClock(x.game, height).blocksLeft) }) : outcomeWords(x.outcome, x.game) })),
                h('span', { class: 'chev' }, icon('chevron')),
              ),
            ),
          )
        : null,
    );
  }

  async function load() {
    error = null;
    try {
      const browse = await svc.browse();
      data = { browse, mine: await svc.mine(browse.tournaments) };
    } catch (e) {
      error = e;
    }
    render();
  }
  render();
  load();
  const poll = poller(load, () => POLL_MS);
  const el = screen({ title: t('Your Fuddle games'), back: () => app.back('fuddle'), cls: 'fuddle feature' }, body);
  return {
    el,
    destroy() {
      alive = false;
      poll.stop();
    },
  };
}
