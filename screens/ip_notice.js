/* IP privacy notice (before the first connection to any BEAM node; also Settings -> IP privacy)
 * Spec: ONE job: tell the person, before anything connects, who can see their IP address.
 *       Primary CTA: "Connect" (secondary: "How to hide my IP"). In Settings: "Done".
 *       Taps from app open: right after setup (create/restore), once per device.
 * Exit-intent reasons and answers:
 *   - "A privacy coin that leaks my IP?" -> said first, with the two fixes that work on an iPhone.
 *   - "Is Private Relay enough?" -> honest: Apple documents it for Safari; for a Home Screen
 *     app it is not documented, so a VPN is the sure way.
 *   - "What else does the node learn?" -> listed: when you're online and the payments you send;
 *     never your amounts or your 12 words.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { isImported } from '../lib/session.js';

export const IP_NOTICE_TEXT =
  'The BEAM node you connect to can see your IP address. To hide it, turn on iCloud Private Relay (Settings → [your name] → iCloud → Private Relay) or use a VPN.';

export default function ipNotice(app, params = {}) {
  const fromSettings = !params.first;
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'ip-details' },
    h('h3', { text: 'How to hide your IP address' }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: 'iCloud Private Relay (needs iCloud+): Settings → [your name] → iCloud → Private Relay → On. Apple documents it for browsing in Safari. For apps added to the Home Screen, Apple does not say, so do not rely on it alone.' }),
      h('li', { text: 'A VPN you trust covers every app on the phone, including BEAM Campfire on the Home Screen. Turn it on before you open the wallet.' }),
    ),
    h('p', { class: 'small', text: 'BEAM Campfire itself talks only to two places: the site it was loaded from, and the one BEAM node you pick in Settings. No analytics, no other servers.' }),
    h('p', { class: 'small', text: `The node can see your IP address, when your wallet is online, and the transactions it sends. It cannot see your amounts, your balance or your ${isImported(app) ? 'keys' : '12 words'}.` }),
  );
  const toggle = secondary('How to hide my IP', () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? 'How to hide my IP' : 'Hide details';
  }, { 'data-testid': 'ip-how' });

  const cta = fromSettings
    ? primary('Done', () => app.go('settings'))
    : primary('Connect', async () => {
        cta.disabled = true;
        await app.setPrefs({ ipAck: true, ipAckAt: Date.now() });
        app.go('fastStart', { first: true }, { replace: true });
      }, { 'data-testid': 'ip-connect' });

  const el = screen(
    { title: 'IP privacy', back: fromSettings ? () => app.go('settings') : null, actions: [cta, toggle] },
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'ip-text', text: IP_NOTICE_TEXT }),
    details,
  );
  return { el };
}
