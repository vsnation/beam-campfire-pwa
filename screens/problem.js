/* Problem: this browser can't run the wallet / this copy failed its signature check /
 *          the web address now serves code BEAM Campfire did not sign (tripwire)
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

export const TRIPWIRE_TEXT =
  "This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.";

export default function problem(app, p = {}) {
  if (p.kind === 'tripwire') return tripwire(app);
  if (p.kind === 'bypassed') return bypassed();
  const integrity = p.kind === 'integrity';
  const el = screen(
    { title: integrity ? 'Security check failed' : "This browser can't run BEAM Campfire", actions: [primary('Try again', () => location.reload())] },
    integrity
      ? notice('error', p.detail || 'This copy of BEAM Campfire did not pass its signature check.', " Don't enter your 12 words here. Reload later, or open BEAM Campfire from its official address.")
      : notice('warn', `Missing: ${(p.detail || []).join(', ')}.`),
    integrity
      ? null
      : h('p', { class: 'lead', text: 'BEAM Campfire needs Safari on iOS 16.4 or newer (or a current Chrome, Edge or Firefox), opened over HTTPS from its own address. Private browsing can also block what the wallet needs.' }),
  );
  return { el };
}

function tripwire(app) {
  const el = screen(
    { title: 'Stop: unsigned code', cls: 'tripwire' },
    h('div', { 'data-testid': 'tripwire' }, notice('error', h('strong', { text: TRIPWIRE_TEXT }), ' The wallet was locked the moment it was noticed.')),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: 'Your funds are safe' }),
      h('p', { text: 'Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet:' }),
      h('ul', { class: 'steps-list' }, h('li', { text: 'with your 12 words (Restore), or' }), h('li', { text: 'with your exported wallet.db file and its password (Import wallet.db).' })),
    ),
    h('p', { class: 'small', text: 'Close this app now. Do not reopen it from the same address or enter any password or words in it. This check is a best effort: code that has already taken over can show anything.' }),
  );
  return { el };
}

/* Installed, but this load skipped the installed copy (a hard reload, or a browser set to bypass
 * installed web apps): not "this browser can't run it". One tap opens it normally. */
function bypassed() {
  const el = screen(
    { title: 'BEAM Campfire is installed', actions: [primary('Open BEAM Campfire', () => location.reload(), { 'data-testid': 'bypassed-open' })] },
    notice('info', 'This load skipped the installed copy (a hard reload does that). Open it again to continue.'),
    h('p', { class: 'small', text: 'If this screen keeps coming back, your browser is set to skip installed web apps: in its developer tools, turn off "Bypass for network" (Application, Service workers).' }),
  );
  return { el };
}
