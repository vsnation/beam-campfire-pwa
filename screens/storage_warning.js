/* What the browser may delete, said where it matters (audit A-7)
 * Spec (Home notice): ONE job: tell a person whose wallet lives in a Safari tab that Safari can
 *       delete it, and what keeps it. Secondary card under the balance; "Later" hides it for a week.
 * Spec (the sheet before an airdrop batch or a bridge move): ONE job: say that what is about to be
 *       made is kept only in this browser, which may delete it, and how to keep it.
 *       Primary CTA: the outcome ("Create, then save the codes" / "Start the move"); "Not now".
 *       It adds one tap, only when the browser has not promised to keep this app's storage.
 * Exit-intent reasons and answers:
 *   - "Is my money gone?" -> no: said as what could happen and what prevents it, never as a fault.
 *   - "What do I do?" -> one concrete step: the Home Screen app (and the 12 words or the wallet.db
 *     there), Save as CSV right after creating, come back until the move is done.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet } from '../lib/ui.js';
import { evictionRisk } from '../lib/storage.js';
import { t, tk } from '../lib/i18n.js';

export const EVICTION_SNOOZE_MS = 7 * 24 * 3600 * 1000;

// The texts are marked with tk() and translated where they are shown (t(STORAGE_TEXT.codesTitle));
// homeBody, codesBody and bridgeBody give the whole sentence, already translated.
const WHY = Object.freeze({
  // The reason, in English: codesBody/bridgeBody pick their whole sentence by it (each is translated whole).
  safariTab: "Safari deletes a site's data after 7 days without a visit to it", // i18n-ignore: never shown alone; selects the whole sentence below
  mayClear: "This browser may clear this site's data when the device runs low on space", // i18n-ignore: never shown alone; selects the whole sentence below
});
export const STORAGE_TEXT = Object.freeze({
  homeTitle: tk('Safari can delete this wallet after 7 days without a visit.'),
  homeBody: (imported) =>
    imported
      ? t('Add BEAM Campfire to your Home Screen (Share, then Add to Home Screen) and open your wallet there from your wallet.db file: the Home Screen app keeps its data.')
      : t('Add BEAM Campfire to your Home Screen (Share, then Add to Home Screen) and open your wallet there with your 12 words: the Home Screen app keeps its data.'),
  why: WHY,
  codesTitle: tk('Save the codes as soon as they are made'),
  codesBody: (why) =>
    why === WHY.mayClear
      ? t("This browser may clear this site's data when the device runs low on space, and these codes are kept only here: they are the only key to the coins you lock. Right after creating, tap Save as CSV file and keep the file somewhere safe.")
      : t("Safari deletes a site's data after 7 days without a visit to it, and these codes are kept only here: they are the only key to the coins you lock. Right after creating, tap Save as CSV file and keep the file somewhere safe."),
  codesCta: tk('Create, then save the codes'),
  bridgeTitle: tk('Come back until this move is done'),
  bridgeBody: (why) =>
    why === WHY.mayClear
      ? t("This browser may clear this site's data when the device runs low on space, and this move's record is kept only here: BEAM Campfire needs it to finish the move. Open BEAM Campfire until the move says Done.")
      : t("Safari deletes a site's data after 7 days without a visit to it, and this move's record is kept only here: BEAM Campfire needs it to finish the move. Open BEAM Campfire until the move says Done."),
  bridgeCta: tk('Start the move'),
  // Shown by screens/airdrop_codes.js after its own sentence (hence the leading space).
  codesNote: { safariTab: tk('Safari can delete them after 7 days without a visit.'), mayClear: tk('This browser may clear them when space runs low.') },
});

/** Home: the notice for a wallet in a Safari tab whose storage is not kept; null otherwise. rerender: after Later. */
export function evictionNotice(app, rerender) {
  if (evictionRisk(app) !== 'safariTab' || !app.record) return null;
  if (app.prefs && app.prefs.evictionNoticeSnoozedUntil > Date.now()) return null;
  return h(
    'div',
    { class: 'notice warn', 'data-testid': 'eviction-notice' },
    icon('alert'),
    h(
      'div',
      { class: 'grow' },
      h('strong', { text: `${t(STORAGE_TEXT.homeTitle)} ` }),
      STORAGE_TEXT.homeBody(Boolean(app.record.imported)),
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        h('button', {
          class: 'btn btn-text btn-small',
          'data-testid': 'eviction-later',
          onclick: async () => {
            await app.setPrefs({ evictionNoticeSnoozedUntil: Date.now() + EVICTION_SNOOZE_MS }).catch(() => {});
            if (rerender) rerender();
          },
        }, t('Later')),
      ),
    ),
  );
}

/**
 * Before an airdrop batch ('codes') or a bridge move ('bridge') while this browser may delete the
 * record it makes: says so, and how to keep it. Resolves true to go on (at once when there is no risk).
 */
export function confirmKeptHere(app, kind) {
  const risk = evictionRisk(app);
  if (!risk) return Promise.resolve(true);
  const why = STORAGE_TEXT.why[risk];
  const txt = kind === 'codes' ? { title: t(STORAGE_TEXT.codesTitle), body: STORAGE_TEXT.codesBody(why), cta: t(STORAGE_TEXT.codesCta) } : { title: t(STORAGE_TEXT.bridgeTitle), body: STORAGE_TEXT.bridgeBody(why), cta: t(STORAGE_TEXT.bridgeCta) };
  return new Promise((resolve) => {
    const sheet = openSheet((close) => [
      h('h2', { text: txt.title }),
      h('p', { class: 'lead', 'data-testid': 'kept-here-text', text: txt.body }),
      h('button', { class: 'btn btn-primary', 'data-testid': 'kept-here-go', onclick: () => close(true) }, txt.cta),
      h('button', { class: 'btn btn-text', 'data-testid': 'kept-here-cancel', onclick: () => close(false) }, t('Not now')),
    ], { label: txt.title });
    sheet.then((v) => resolve(v === true));
  });
}
