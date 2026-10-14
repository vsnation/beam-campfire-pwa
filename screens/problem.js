/* Problem: this browser can't run the wallet / this copy failed its signature check /
 *          the web address now serves code BEAM Campfire did not sign (tripwire) /
 *          the wallet engine stopped working in this page (engine)
 * Spec: ONE job: say why the wallet can't open here and what to do instead.
 *       Primary CTA: "Try again" (reload) - except after the tripwire, where a reload would run
 *       the unsigned code: there the next step is written out instead (the 12 words or the
 *       wallet.db file, in another wallet app).
 *       Taps from app open: 0.
 * Exit-intent reasons and answers:
 *   - "Is it broken?" -> names the exact missing feature or the failed check.
 *   - "What now?" -> the browser/OS that works, or to reload later / use the official address.
 *   - "Is my money gone?" (tripwire) -> no: the coins are on the blockchain; the 12 words or the
 *     wallet.db file and its password open them in BEAM Campfire desktop or another BEAM wallet.
 */
import { h } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { t, tk, tNodes } from '../lib/i18n.js';
import { loaderText } from '../lib/loader_words.js';

// The same words as src/loader-watch.js (lib/i18n.js EARLY_KEYS): one translation for both.
export const TRIPWIRE_TEXT =
  tk("This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.");

export default function problem(app, p = {}) {
  if (p.kind === 'tripwire') return tripwire(app);
  if (p.kind === 'bypassed') return bypassed();
  if (p.kind === 'engine') return engineStopped();
  const integrity = p.kind === 'integrity';
  const el = screen(
    { title: integrity ? t('Security check failed') : t("This browser can't run BEAM Campfire"), actions: [primary(t('Try again'), () => location.reload())] },
    integrity
      ? // The detail is the loader's sentence (lib/release.js via sw.js): lib/loader_words.js gives it in the active language.
        notice('error', t("{reason} Don't enter your 12 words here. Reload later, or open BEAM Campfire from its official address.", { reason: p.detail ? loaderText(p.detail) : t('This copy of BEAM Campfire did not pass its signature check.') }))
      : notice('warn', t('Missing: {features}.', { features: (p.detail || []).join(', ') })),
    integrity
      ? null
      : h('p', { class: 'lead', text: t('BEAM Campfire needs Safari on iOS 16.4 or newer (or a current Chrome, Edge or Firefox), opened over HTTPS from its own address. Private browsing can also block what the wallet needs.') }),
  );
  return { el };
}

function tripwire(app) {
  const el = screen(
    { title: t('Stop: unsigned code'), cls: 'tripwire' },
    h('div', { 'data-testid': 'tripwire' }, notice('error', ...tNodes('{warning} The wallet was locked the moment it was noticed.', { warning: h('strong', { text: t(TRIPWIRE_TEXT) }) }))),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: t('Your funds are safe') }),
      h('p', { text: t('Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet:') }),
      h('ul', { class: 'steps-list' }, h('li', { text: t('with your 12 words (Restore), or') }), h('li', { text: t('with your exported wallet.db file and its password (Import wallet.db).') })),
    ),
    // Its first two sentences are loader-watch.js's own (EARLY_KEYS): the same translation on both screens.
    h('p', { class: 'small', text: `${t('Close this app now. Do not reopen it from the same address or enter any password or words in it.')} ${t('This check is a best effort: code that has already taken over can show anything.')}` }),
  );
  return { el };
}

/* The wallet engine's runtime aborted: no wallet can run in this page any more, and
 * it would otherwise sit there reaching no node and seeing no payment. A reload starts
 * a new engine; the wallet on this device is untouched. */
function engineStopped() {
  const el = screen(
    { title: t('The wallet stopped'), actions: [primary(t('Start it again'), () => location.reload(), { 'data-testid': 'engine-reload' })] },
    h('div', { 'data-testid': 'engine-stopped' }, notice('warn', t('The wallet engine in this page stopped working. Your wallet and your coins are safe.'))),
    h('p', { class: 'lead', text: t('Start it again, then unlock with your password. A payment that was under way carries on.') }),
  );
  return { el };
}

/* Installed, but this load skipped the installed copy (a hard reload, or a browser set to bypass
 * installed web apps): not "this browser can't run it". One tap opens it normally. */
function bypassed() {
  const el = screen(
    { title: t('BEAM Campfire is installed'), actions: [primary(t('Open BEAM Campfire'), () => location.reload(), { 'data-testid': 'bypassed-open' })] },
    notice('info', t('This load skipped the installed copy (a hard reload does that). Open it again to continue.')),
    h('p', { class: 'small', text: t('If this screen keeps coming back, your browser is set to skip installed web apps: in its developer tools, turn off "Bypass for network" (Application, Service workers).') }),
  );
  return { el };
}
