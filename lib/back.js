// System back - Android's back button and gesture, the edge swipe in an iPhone
// Home Screen app, the browser's Back - does what the screen's own Back does:
// it closes an open sheet, else taps the top bar's Back, else a tab goes to
// Wallet. Only Wallet, Welcome and Unlock let it leave the app; any other
// screen without a Back (a payment's status, a step that must finish) stays.
//
// One history entry sits on top of the app's own. A Back uses it up and the
// app puts it back, so the address never changes and nothing about the screen
// is kept in the browser's history. Chrome skips entries a page adds before
// the person has touched it, so the entry is added on the first tap or key.

const ROOTS = new Set(['home', 'welcome', 'unlock']);
const TABS = new Set(['activity', 'settings']);
const STATE = { campfire: 'back' };

/** What a Back means on the current screen: 'sheet' | 'button' | 'home' | 'leave' | 'stay'. */
export function backAction({ overlays, backButton, screenName }) {
  if (overlays.length) return 'sheet';
  if (backButton) return 'button';
  if (TABS.has(screenName)) return 'home';
  if (ROOTS.has(screenName)) return 'leave';
  return 'stay';
}

export function installBack(app, win = window) {
  const hist = win.history;
  if (!hist || typeof hist.pushState !== 'function') return;
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    hist.pushState(STATE, '');
  };
  const onFirst = () => {
    win.removeEventListener('pointerdown', onFirst, true);
    win.removeEventListener('keydown', onFirst, true);
    arm();
  };
  win.addEventListener('pointerdown', onFirst, true);
  win.addEventListener('keydown', onFirst, true);

  win.addEventListener('popstate', () => {
    if (!armed) return; // a Back before the entry existed: the browser's own
    armed = false;
    const doc = win.document;
    const overlays = [...doc.querySelectorAll('.overlay')];
    const root = doc.getElementById('app');
    const backButton = root && root.querySelector('.topbar button[aria-label="Back"]');
    const action = backAction({ overlays, backButton, screenName: app.currentName });
    if (action === 'leave') {
      hist.back(); // past this app's first entry: out of the app
      return;
    }
    if (action === 'sheet') {
      const top = overlays[overlays.length - 1];
      // A sheet that is still at work (signing, sending) keeps its own buttons.
      if (top.dataset.dismissable !== '0') top.dispatchEvent(new Event('campfire:dismiss'));
    } else if (action === 'button') backButton.click();
    else if (action === 'home') app.go('home');
    arm();
  });
}
