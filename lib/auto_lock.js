// Auto-lock: after the chosen minutes without use while on screen, and after as long out of sight
// (another tab, another app, the screen off). Out of sight it locks there and then, not on the way
// back: a tab left in the background on a computer must not keep the wallet's database password and
// the running engine in memory for days (Settings says "Also in the background"). A browser slows
// timers in a background tab (Chrome: about once a minute), so the lock may come a little late; a
// phone that froze the page locks it the moment it comes back. (Ported from the Firo wallet.)
//
//   app: { lastActivity, hiddenAt, autoLockMs(), lockAllowedNow(), lock(reason), touch() }
//   env: the page (document, window, timers, clock), replaced in the tests.

export const CHECK_EVERY_MS = 15000;

export function installAutoLock(app, { doc = globalThis.document, win = globalThis.window, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), every = (f, ms) => setInterval(f, ms) } = {}) {
  let hiddenLock = null;
  const lockIfIdle = () => {
    if (!app.lockAllowedNow()) return;
    const since = doc.visibilityState === 'visible' ? app.lastActivity : app.hiddenAt || app.lastActivity;
    if (now() - since >= app.autoLockMs()) app.lock('timeout');
  };
  win.addEventListener('pointerdown', () => app.touch(), { passive: true });
  win.addEventListener('keydown', () => app.touch(), { passive: true });
  doc.addEventListener('visibilitychange', () => {
    clearTimer(hiddenLock);
    hiddenLock = null;
    if (doc.visibilityState === 'hidden') {
      app.hiddenAt = now();
      hiddenLock = setTimer(lockIfIdle, app.autoLockMs() + 50);
    } else {
      // Back in sight: how long it was away counts (coming back is use).
      if (app.hiddenAt && now() - app.hiddenAt >= app.autoLockMs() && app.lockAllowedNow()) app.lock('timeout');
      app.hiddenAt = null;
      app.touch();
    }
  });
  every(lockIfIdle, CHECK_EVERY_MS);
  return { lockIfIdle };
}
