// System back - Android's back button and gesture, the edge swipe in an iPhone
// Home Screen app, the browser's Back - does what the screen's own Back does:
// it closes an open sheet, else a layer over the screen (a running dApp) by its
// own close button ([data-back]), else taps the top bar's Back, which follows
// the app's history (lib/nav.js), else a tab goes to Wallet (Activity,
// Settings, and the Ethereum side). Any other screen without a Back (Wallet,
// Welcome, Unlock, a payment's status, a step that must finish) stays. On a
// screen still loading, it waits for its Back. The Back is found by data-nav,
// never by its label, which is translated.
//
// The browser's history holds one entry for each step a Back can take: the
// screens of the app's history, Wallet under a tab, and each sheet or layer
// open over the screen. Opening one adds an entry; going back, by the app's
// own Back too, goes back over them. The address never changes and nothing
// about a screen is kept in the browser. This is for the swipe: Safari shows a
// picture of the entry it goes back to, taken as that entry was left, so the
// picture is the screen the Back opens. (With entries added once, at the first
// touch, it showed the screen of that touch, often Unlock: owner, 2026-10-27.)
//
// Wallet, Welcome and Unlock are the first entry: a Back there leaves the app
// in a browser tab, and has nothing to go back to in a Home Screen app. Unless
// entries of an earlier page of this app lie under it (a reload keeps them),
// where a Back would start the app again at Unlock: then one entry is kept
// under the first screen and a Back onto it stays.
//
// What the browsers allow (audit of 0.1.16 / 0.2.21):
// - Chrome skips, on the person's Back, entries a page added with no tap since
//   its last Back; Safari, entries added more than 10 s after a tap (and the
//   one before: no worse than no entry). Skipped, the app's entries are passed
//   over and the earlier page loads: Unlock again. So an entry is never added
//   after a Back with no tap since; a Back that changes nothing steps forward
//   again onto the entry it left (a traversal marks nothing); other entries
//   wait for the next tap (counted when the finger lifts, as Chrome does).
// - A picture is taken of whatever is painted when an entry is left, and it
//   stays with the entry, ahead of it too. Recovery words, keys and codes must
//   not stay in one: an entry left while they were painted (by the app or by
//   the person's swipe) is stepped onto and off again once they are gone from
//   the screen, which takes its picture anew; so is the entry under a screen
//   that stays (its picture is that screen, not what was before it).
import { isRoot } from './nav.js';

const TABS = new Set(['activity', 'settings', 'ethHome', 'ethStart']);
// Screens that show or take recovery words, keys, airdrop codes or a password that can be shown,
// and the parts that show them in a sheet or on another screen ([data-secret]: a claim code typed).
export const SECRET_SCREENS = new Set(['backup', 'confirmWords', 'restore', 'watch', 'viewKey', 'ownerKey', 'airdropCodes', 'setPassword', 'importWallet', 'ethWords', 'ethConfirm', 'ethImport', 'ethSettings']);
const SECRET_PARTS = '[data-testid="words"], .owner-key, [data-testid="eth-key-box"], [data-secret]'; // i18n-ignore: a CSS selector

/** What a Back means on the current screen: 'sheet' | 'layer' | 'button' | 'home' | 'stay'. */
export function backAction({ overlays, layerBack = null, backButton, screenName }) {
  if (overlays.length) return 'sheet';
  if (layerBack) return 'layer';
  if (backButton) return 'button';
  if (TABS.has(screenName)) return 'home';
  return 'stay';
}

/**
 * How many entries above the first the screen on show has: Wallet under a tab, each screen Back
 * returns through (trail: lib/nav.js, oldest first), a layer, and each sheet.
 */
export function stepsFor({ name, params = {}, trail = [], layer = false, sheets = 0 }) {
  const first = trail[0] || { name, params };
  const underTab = TABS.has(first.name) && isRoot(first.name, first.params || {}) ? 1 : 0;
  return underTab + trail.length + (layer ? 1 : 0) + sheets;
}

/** Whether the app runs as a Home Screen app (no browser around it). */
export function inStandalone(win) {
  try {
    return Boolean((win.navigator && win.navigator.standalone) || (win.matchMedia && win.matchMedia('(display-mode: standalone)') /* i18n-ignore: a media query */.matches));
  } catch {
    return false;
  }
}

/**
 * Whether an entry lies under the page's own that a Back on the first screen must not reach. In a
 * Home Screen app, any (the app is all there is: an earlier page of it, which a Back would load
 * again). In a browser tab, an earlier page of this app, which the Navigation API tells apart
 * from other sites; without it, none is assumed (a Back leaves, as in any site).
 */
export function entriesUnder(win) {
  if (inStandalone(win)) return win.history.length > 1;
  try {
    const cur = win.navigation && win.navigation.currentEntry;
    return Boolean(cur && typeof cur.index === 'number' && cur.index > 0);
  } catch {
    return false; // no Navigation API
  }
}

export function installBack(app, win = window) {
  const hist = win.history;
  if (!hist || typeof hist.pushState !== 'function') return;
  const doc = Math.random().toString(36).slice(2);
  const later = (f, ms = 0) => (win.setTimeout || setTimeout)(f, ms);
  const nav = () => {
    try {
      return win.navigation && typeof win.navigation.traverseTo === 'function' && win.navigation.currentEntry ? win.navigation : null;
    } catch {
      return null;
    }
  };
  let armed = false;
  let floor = 0; // 1: one entry kept under the first screen
  let at = 0; // the entry on show, counted from this page's own
  let top = 0; // the last entry of this page's (entries above `at` are ahead of it)
  let travelling = 0; // traversals the app asked for that have not arrived yet
  let then = null; // where to go once they have (a round trip)
  let waiting = false; // a Back waits for a screen still loading
  let backSinceTouch = true; // a Back of the person's since the last tap or key (none yet: as one)
  const keys = []; // each entry's Navigation API key, to go straight to it
  const shot = []; // what each entry showed when it was left: { name, secret }
  let painted = { name: null, secret: false };
  let retook = '';
  const ours = (s) => Boolean(s && s.campfire === 'back' && s.doc === doc && Number.isInteger(s.n));

  const LOADING = ':scope > main[aria-busy="true"]'; // i18n-ignore: a CSS selector
  const view = () => {
    const d = win.document;
    const root = d.getElementById('app');
    return { d, overlays: [...d.querySelectorAll('.overlay')], root, layerBack: root && root.querySelector('[data-back]') };
  };
  const secretOnShow = () => {
    const { d } = view();
    return SECRET_SCREENS.has(app.currentName) || Boolean(d.querySelector(SECRET_PARTS));
  };
  const wanted = () => {
    const { overlays, layerBack } = view();
    const trail = app.nav && typeof app.nav.entries === 'function' ? app.nav.entries() : [];
    return floor + stepsFor({ name: app.currentName, params: app.params || {}, trail, layer: Boolean(layerBack), sheets: overlays.length });
  };
  /** Whether a Back now would leave the screen as it is (a screen still loading has no Back yet). */
  const stays = () => {
    const { overlays, root, layerBack } = view();
    if (!overlays.length && root && root.querySelector(LOADING)) return false;
    const backButton = root && root.querySelector('.topbar button[data-nav="back"]');
    return backAction({ overlays, layerBack, backButton, screenName: app.currentName }) === 'stay';
  };
  const canAdd = () => !backSinceTouch;
  // What the entry being left shows: what was painted, or a secret if one is on show (painted or about to be).
  const leaving = () => ({ name: painted.name, secret: painted.secret || secretOnShow() });

  // What the next frame paints, noted once it is painted (pictures are taken of that). A change
  // that comes after a frame was noted and before its sync asks for another.
  let noting = false;
  let again = false;
  const notePaint = () => {
    if (noting) {
      again = true;
      return;
    }
    noting = true;
    const frame = () => {
      again = false;
      painted = { name: app.currentName, secret: secretOnShow() };
      later(() => {
        noting = false;
        if (again) notePaint();
        sync();
      });
    };
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(frame);
    else later(frame);
  };

  // A traversal the browser drops (another one took its place) never arrives: after a while the
  // entry on show is read back and the entries follow again.
  let lost = null;
  const travel = (to, back = null) => {
    if (to === at) return;
    travelling++;
    then = back;
    const from = at;
    shot[from] = leaving();
    clearTimeout(lost);
    lost = later(() => {
      if (!travelling) return;
      travelling = 0;
      then = null;
      if (ours(hist.state)) at = hist.state.n;
      sync();
    }, 2000);
    // Straight to the entry by its key: entries a dApp's frame added in between are passed over.
    const n = nav();
    if (n && keys[to]) {
      try {
        const r = n.traverseTo(keys[to]);
        if (r && r.committed) r.committed.catch(() => {});
        if (r && r.finished) r.finished.catch(() => {});
        return;
      } catch {
        /* not one of its entries any more: by count */
      }
    }
    hist.go(to - from);
  };
  const push = () => {
    shot[at] = leaving();
    at++;
    hist.pushState({ campfire: 'back', doc, n: at }, '');
    top = at;
    shot.length = at;
    const n = nav();
    keys.length = at;
    keys[at] = n ? n.currentEntry.key : null;
  };

  /** Brings the entries to what is on show. */
  function sync() {
    if (!armed || travelling || waiting) return;
    const want = wanted();
    if (want < at) return travel(want);
    if (want > at) {
      if (canAdd()) {
        while (at < want) push();
      } else {
        // No tap since: onto the entries there are (the person's Back never wears down the ones
        // under the screen); any more are added at the next tap.
        if (top > at) return travel(Math.min(want, top));
        return;
      }
    }
    // Pictures are taken anew only once the screen on show is painted and holds nothing secret
    // (the secret's leaving is a change that calls this again).
    if (secretOnShow()) {
      if (!painted.secret) notePaint();
      return;
    }
    if (painted.secret || painted.name !== app.currentName) return notePaint();
    // A picture of words or a key (an entry left while they were painted): stepped onto and off, it is taken anew.
    for (let k = top; k >= 0; k--) if (k !== at && shot[k] && shot[k].secret) return travel(k, at);
    // Under a screen that stays, the picture is that screen's: the swipe shows it staying.
    if (at >= 1 && stays() && (!shot[at - 1] || shot[at - 1].name !== app.currentName)) {
      const key = `${at}:${app.currentName}`;
      if (retook !== key) {
        retook = key;
        travel(at - 1, at);
      }
    }
  }

  const arm = () => {
    armed = true;
    floor = entriesUnder(win) ? 1 : 0;
    hist.replaceState({ campfire: 'back', doc, n: 0 }, '');
    at = 0;
    top = 0;
    const n = nav();
    keys[0] = n ? n.currentEntry.key : null;
    painted = { name: app.currentName, secret: secretOnShow() };
  };
  const onTouch = () => {
    backSinceTouch = false;
    if (!armed) arm();
    sync();
  };
  win.addEventListener('pointerup', onTouch, true);
  win.addEventListener('keydown', onTouch, true);
  // VoiceOver and TalkBack activate with a click and no pointer events.
  win.addEventListener('click', (e) => e.isTrusted !== false && onTouch(), true);

  // A screen, sheet or layer opened or closed (the app's own Back and its tabs too): the entries follow.
  if (typeof win.MutationObserver === 'function' && win.document && win.document.body) {
    new win.MutationObserver(() => {
      notePaint();
      sync();
    }).observe(win.document.body, { childList: true, subtree: true });
  }

  // A screen still loading its code (a spinner, no top bar yet) has no Back:
  // the Back waits for that screen, a few seconds at most. More Backs meanwhile count once.
  const whenLoaded = (root) => {
    if (waiting) return;
    waiting = true;
    const t0 = Date.now();
    const screen = app.current;
    const tick = () => {
      if (app.current !== screen) {
        waiting = false;
        sync();
      } else if (!root.querySelector(LOADING)) {
        waiting = false;
        run();
      } else if (Date.now() - t0 < 5000) setTimeout(tick, 50);
      else {
        waiting = false;
        sync();
      }
    };
    setTimeout(tick, 50);
  };

  /** Does what a Back means now; returns the action. */
  function run() {
    const { overlays, root, layerBack } = view();
    if (!overlays.length && root && root.querySelector(LOADING)) {
      whenLoaded(root);
      return 'wait';
    }
    const backButton = root && root.querySelector('.topbar button[data-nav="back"]');
    const action = backAction({ overlays, layerBack, backButton, screenName: app.currentName });
    if (action === 'sheet') {
      const top = overlays[overlays.length - 1];
      // A sheet that holds a payment decides (lib/ui.js openSheet): its way out while that is
      // offered, nothing while it signs or sends.
      top.dispatchEvent(new Event(top.dataset.dismissable !== '0' ? 'campfire:dismiss' : 'campfire:beside'));
    } else if (action === 'layer') layerBack.click();
    else if (action === 'button') backButton.click();
    else if (action === 'home') app.go('home');
    // What the Back opened is on show; or nothing moved, and the entry it left is stepped onto again.
    sync();
    return action;
  }

  win.addEventListener('popstate', () => {
    if (!armed || !ours(hist.state)) return; // the browser's own, or not this page's
    const n = hist.state.n;
    const from = at;
    at = n;
    if (travelling) {
      travelling--;
      if (!travelling) {
        const next = then;
        then = null;
        if (next !== null && next !== at) travel(next);
        else sync();
      }
      return;
    }
    // The person's Back or Forward: the entry left was pictured as it was on show.
    shot[from] = leaving();
    backSinceTouch = true;
    if (n < from) run();
    else sync(); // Forward: there is nothing ahead, back to the screen on show
  });
}
