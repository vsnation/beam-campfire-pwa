/* One tab at a time (lib/one_tab.js): this tab does not hold the wallet.
 *
 * otherTab - Spec: ONE job: say BEAM Campfire is already open in another tab, and move it here.
 *       Primary CTA: "Use it here instead" (only if the other tab does not answer: "Take over anyway").
 *       Taps from app open: 0 to see it, 1 to have the wallet here.
 * movedTab - Spec: ONE job: say the wallet moved to another tab (locked and saved here first), and
 *       bring it back. Primary CTA: "Use it here instead". Taps: 1.
 *       how 'unchecked' (this browser cannot say which tab holds the wallet, re-audit RE1-1): ONE job:
 *       say to close the other tabs and reload. Primary CTA: "Reload". Taps: 1 (after closing them).
 *       In a browser that can never say, Reload lands here again (release audit RE3-1): the way out
 *       is another browser and the wallet's words or file, said under the button and, once the
 *       screen comes back in this tab, above it.
 * Exit-intent reasons and answers:
 *   - "Is my wallet gone / broken?" -> the lead says why there is one tab at a time: so the wallet's
 *     data stays intact; the moved screen says it was locked and saved before it moved.
 *   - "Which tab do I use now?" -> either: one tap here moves it; nothing to find or close first.
 *   - "It's stuck" (the other tab sleeps in the background) -> after 10 s it says so, in plain words,
 *     and offers "Take over anyway" with what that costs.
 *   - "Will it ask for my password?" -> the line under the button: it locks there, then opens here
 *     (unlock as usual).
 */
import { h, clear } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { oneTab } from '../lib/one_tab.js';
import { t, tk, tNodes } from '../lib/i18n.js';

// The texts are marked with tk() and translated where they are shown (t(OTHER_TAB_TITLE)).
export const OTHER_TAB_TITLE = tk('BEAM Campfire is open in another tab');
export const OTHER_TAB_LEAD = tk('It works in one tab at a time, so your wallet data stays intact.');
export const MOVED_TITLE = tk('BEAM Campfire moved to another tab');
export const MOVED_LEAD = {
  handed: tk('It works in one tab at a time. Your wallet was locked and saved here before it moved.'),
  stolen: tk('It works in one tab at a time. Another tab took it over, so your wallet is locked here.'),
  // Locking and saving had not finished when the hand-over's time ran out (lib/one_tab.js, RE1-7).
  capped: tk('It works in one tab at a time. Your wallet was locked here before it moved, but it may not have saved its last few seconds.'),
};
export const UNCHECKED_TITLE = tk('Close your other BEAM Campfire tabs');
export const UNCHECKED_LEAD = tk('This browser cannot keep BEAM Campfire to one tab. Close every other BEAM Campfire tab, then reload.');
const UNCHECKED_HINT = tk('Your wallet stays locked in this tab until then.');
export const UNCHECKED_WAY_OUT = tk('If this keeps happening, this browser cannot run BEAM Campfire safely: open it in another browser and restore your wallet there from its 12 words (or its wallet.db file).');
const UNCHECKED_SEEN_KEY = 'campfire-unchecked-seen';

/**
 * How many page loads of this tab showed the 'unchecked' screen (this one included); 1 when it cannot
 * count. Once per load (thisLoad): the screen is drawn again whenever a screen is asked for.
 */
let thisLoad = null;
const seenBefore = () => (thisLoad === null ? (thisLoad = uncheckedSeen()) : thisLoad) > 1;
/** Counts one more showing in `store` and returns the count. */
export function uncheckedSeen(store = globalThis.sessionStorage) {
  try {
    const n = (Number(store.getItem(UNCHECKED_SEEN_KEY)) || 0) + 1;
    store.setItem(UNCHECKED_SEEN_KEY, String(n));
    return n;
  } catch {
    return 1;
  }
}
const USE_HERE = tk('Use it here instead');
const HOW_IT_MOVES = tk('Your wallet locks in the other tab first, then opens here.');
const POLL_MS = 2000;

export function otherTab(app) {
  return oneTabScreen(app, { title: t(OTHER_TAB_TITLE), lead: t(OTHER_TAB_LEAD), testid: 'one-tab-other', spent: false });
}

export function movedTab(app, p = {}) {
  if (p.how === 'unchecked') return uncheckedTab();
  const how = p.how === 'stolen' || p.how === 'capped' ? p.how : 'handed';
  return oneTabScreen(app, { title: t(MOVED_TITLE), lead: t(MOVED_LEAD[how]), testid: 'one-tab-moved', spent: true, how });
}

function oneTabScreen(app, { title, lead, testid, spent, how = null }) {
  const tab = oneTab();
  let gone = false;
  let pollTimer = null;
  const note = h('div', { 'data-testid': 'one-tab-note' });
  const hint = h('p', { class: 'small center', role: 'status', 'data-testid': 'one-tab-status', text: t(HOW_IT_MOVES) });
  // One listener (dom.js adds listeners): what a tap does changes with the state.
  let action = () => moveHere();
  const btn = primary(t(USE_HERE), () => action && action(), { 'data-testid': 'one-tab-use-here' });

  const setButton = (label, onclick, { testid: id = 'one-tab-use-here', disabled = false } = {}) => {
    btn.textContent = label;
    action = onclick;
    btn.disabled = disabled;
    btn.dataset.testid = id;
  };

  /** The wallet is this tab's now: a page that let it go reloads (its memory is the old copy). */
  const arrived = () => {
    if (gone) return;
    gone = true;
    stopPolling();
    if (spent || tab.spent) location.reload();
    else app.continueBoot();
  };

  const failed = (e) => {
    clear(note);
    note.appendChild(notice('error', t("That didn't work: {reason}. Try again; your wallet is safe.", { reason: (e && e.message) || e })));
    hint.textContent = t(HOW_IT_MOVES);
    setButton(t(USE_HERE), () => moveHere());
  };

  const offerSteal = ({ acked }) => {
    if (gone) return;
    clear(note);
    note.appendChild(
      notice(
        'warn',
        ...(acked
          ? tNodes('{title} It is still locking your wallet.', { title: h('strong', { text: t('The other tab is taking long to let go.') }) })
          : tNodes('{title} It may be asleep in the background.', { title: h('strong', { text: t("The other tab isn't answering.") }) })),
      ),
    );
    hint.textContent = t('Taking over stops it at once. Anything it did in its last few seconds may not be saved.');
    setButton(t('Take over anyway'), () => {
      setButton(t('Taking over…'), null, { testid: 'one-tab-steal', disabled: true });
      tab.stealNow().then(arrived, failed);
    }, { testid: 'one-tab-steal' });
  };

  function moveHere() {
    clear(note);
    setButton(t('Moving it here…'), null, { disabled: true });
    hint.textContent = t('Waiting for the other tab to lock your wallet and save it…');
    tab.takeOver({ onNoAnswer: offerSteal }).then(arrived, failed);
  }

  // Not moved here yet and the other tab closes: the wallet is free, go on by itself (only a lock
  // that is free right now: { ifAvailable }, never a place in a queue).
  const tryClaim = () => {
    if (gone || spent || tab.state !== 'busy' || document.visibilityState !== 'visible') return;
    tab.claim().then((r) => r === 'held' && arrived(), () => {});
  };
  const onVisible = () => tryClaim();
  function stopPolling() {
    clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisible);
  }
  if (!spent) {
    pollTimer = setInterval(tryClaim, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  const el = screen(
    { topbar: false, cls: 'one-tab', actions: [btn, hint] },
    h('div', { class: 'hero', 'data-testid': testid, 'data-how': how || '' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: title }), h('p', { text: lead })),
    note,
  );
  // Left (another screen took over, e.g. this tab found it cannot check the lock): nothing of this
  // screen acts any more, not even a hand-over that answers late.
  return {
    el,
    destroy() {
      gone = true;
      stopPolling();
    },
  };
}

/**
 * The lock could not be looked up in this browser (lib/one_tab.js, RE1-1): no wallet runs here. The
 * first time it says to close the other tabs; the way out of a browser that can never say (RE3-1) is
 * under the button, and above it once this tab has shown the screen before (a reload that did not help).
 */
function uncheckedTab() {
  const again = seenBefore();
  const wayOut = again ? h('div', { 'data-testid': 'one-tab-way-out', 'data-again': 'true' }, notice('warn', t(UNCHECKED_WAY_OUT))) : null;
  const el = screen(
    {
      topbar: false,
      cls: 'one-tab',
      actions: [
        primary(t('Reload'), () => location.reload(), { 'data-testid': 'one-tab-reload' }),
        h('p', { class: 'small center', role: 'status', 'data-testid': 'one-tab-status', text: t(UNCHECKED_HINT) }),
        again ? null : h('p', { class: 'small center', 'data-testid': 'one-tab-way-out', text: t(UNCHECKED_WAY_OUT) }),
      ],
    },
    h('div', { class: 'hero', 'data-testid': 'one-tab-moved', 'data-how': 'unchecked' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: t(UNCHECKED_TITLE) }), h('p', { text: t(UNCHECKED_LEAD) })),
    wayOut,
  );
  return { el };
}
