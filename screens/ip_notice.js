/* IP privacy (Settings -> IP privacy). Not a setup step: create, restore and import go straight
 * to connecting (owner, 2026-10-10: optional, never in the way of a new wallet).
 * Spec: ONE job: say who can see the person's IP address, and how to hide it.
 *       Primary CTA: "Done" (secondary: "How to hide my IP").
 *       Taps from app open: 2 (Settings -> IP privacy).
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
import { t, tk } from '../lib/i18n.js';

export const IP_NOTICE_TEXT =
  tk('The BEAM node you connect to can see your IP address. To hide it, turn on iCloud Private Relay (Settings → [your name] → iCloud → Private Relay) or use a VPN.');

// Who else sees the IP address (audit UPD-4): a tapped Check for updates asks every update source
// at once (lib/update_sources.js findUpdate), not only this app's own address.
export const IP_APP_TEXT =
  tk('By itself, BEAM Campfire talks to the site it was loaded from and the one BEAM node it is connected to. When you tap Check for updates, it also asks every update source at once: the public copies of BEAM Campfire on GitHub and jsDelivr, and any address you added. Each of them sees your IP address. No analytics.');

export default function ipNotice(app) {
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'ip-details' },
    h('h3', { text: t('How to hide your IP address') }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: t('iCloud Private Relay (needs iCloud+): Settings → [your name] → iCloud → Private Relay → On. Apple documents it for browsing in Safari. For apps added to the Home Screen, Apple does not say, so do not rely on it alone.') }),
      h('li', { text: t('A VPN you trust covers every app on the phone, including BEAM Campfire on the Home Screen. Turn it on before you open the wallet.') }),
    ),
    h('p', { class: 'small', 'data-testid': 'ip-app-text', text: t(IP_APP_TEXT) }),
    h('p', { class: 'small', text: isImported(app) ? t('The node can see your IP address, when your wallet is online, and the transactions it sends. It cannot see your amounts, your balance or your keys.') : t('The node can see your IP address, when your wallet is online, and the transactions it sends. It cannot see your amounts, your balance or your 12 words.') }),
  );
  const toggle = secondary(t('How to hide my IP'), () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? t('How to hide my IP') : t('Hide details');
  }, { 'data-testid': 'ip-how' });

  const cta = primary(t('Done'), () => app.back('settings'), { 'data-testid': 'ip-done' });

  const el = screen(
    { title: t('IP privacy'), back: () => app.back('settings'), actions: [cta, toggle] },
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'ip-text', text: t(IP_NOTICE_TEXT) }),
    details,
  );
  return { el };
}
