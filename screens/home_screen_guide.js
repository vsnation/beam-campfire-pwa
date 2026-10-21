/* Add to Home Screen: why, and how, for a wallet in an iPhone Safari tab
 * Spec: ONE job: a person in a Safari tab learns that Safari deletes a site's data after 7 days
 *       without a visit, and adds BEAM Campfire to the Home Screen, whose app is not under that rule.
 *       Primary CTA: none can add it for them (iOS has no install prompt); the three steps are the
 *       action. In a sheet: "Got it" closes it.
 *       Taps from app open: 0 on the setup screen (steps shown inline); 1 on Welcome and Home
 *       ("Show me how").
 * Exit-intent reasons and answers:
 *   - "Why should I bother?" -> the reason first, as what Safari does, never as a fault.
 *   - "I can't find Share" -> since iOS 26 Safari hides it behind ••• (or ☰) next to the address: said in step 1.
 *   - "Add to Home Screen is not in the list" -> step 2 says to scroll down, or tap More.
 *   - "Setup says keep this screen open" -> the setup card says there is no need to wait: the Home
 *     Screen app sets itself up separately.
 *   - "Will the app keep what I made here?" -> no: a wallet made in a Safari tab does not move, so
 *     the steps end where the wallet is started (or opened again) in the Home Screen app.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet } from '../lib/ui.js';
import { t, tk, tNodes } from '../lib/i18n.js';

export const HOME_SCREEN_TEXT = Object.freeze({
  title: tk('Add BEAM Campfire to your Home Screen'),
  why: tk("Safari deletes a site's data after 7 days without a visit. The Home Screen app is not under that rule."),
  notMoved: tk('A wallet made in a Safari tab does not move to the Home Screen app.'),
  // The setup screen: leaving it is fine, though it also says to keep it open while it works.
  noWait: tk("You don't need to wait here: the Home Screen app sets itself up separately."),
  share: tk('Tap Share {share}. No Share button? Tap {more} or {menu} next to the address first.'),
  add: tk('Tap "Add to Home Screen" (scroll down, or tap More if it is not in the list). If you see "Open as Web App", leave it on. Tap Add.'),
  // The last step, by what the person has: nothing yet, their 12 words, or a wallet.db file.
  open: {
    start: tk('Open BEAM Campfire from your Home Screen and start your wallet there.'),
    words: tk('Open BEAM Campfire from your Home Screen and restore your wallet there with your 12 words.'),
    file: tk('Open BEAM Campfire from your Home Screen and import your wallet.db file there.'),
  },
  showMe: tk('Show me how'),
  gotIt: tk('Got it'),
});

/** The three steps, as a numbered list. last: 'start' | 'words' | 'file' (HOME_SCREEN_TEXT.open). */
export function homeScreenSteps(last = 'start') {
  return h(
    'ol',
    { class: 'steps-list a2hs-steps', 'data-testid': 'a2hs-steps' },
    h('li', {}, ...tNodes(HOME_SCREEN_TEXT.share, { share: icon('share', 'inline-icon'), more: icon('more', 'inline-icon'), menu: icon('menu', 'inline-icon') })),
    h('li', { text: t(HOME_SCREEN_TEXT.add) }),
    h('li', { text: t(HOME_SCREEN_TEXT.open[last] || HOME_SCREEN_TEXT.open.start) }),
  );
}

/** The reason and the steps in a sheet ("Show me how" on Welcome and Home). Resolves when closed. */
export function openHomeScreenGuide(last = 'start') {
  const title = t(HOME_SCREEN_TEXT.title);
  return openSheet((close) => [
    h('h2', { text: title }),
    h('p', { class: 'lead', 'data-testid': 'a2hs-why', text: last === 'start' ? `${t(HOME_SCREEN_TEXT.why)} ${t(HOME_SCREEN_TEXT.notMoved)}` : t(HOME_SCREEN_TEXT.why) }),
    homeScreenSteps(last),
    h('button', { class: 'btn btn-primary', 'data-testid': 'a2hs-got-it', onclick: () => close(true) }, t(HOME_SCREEN_TEXT.gotIt)),
  ], { label: title });
}
