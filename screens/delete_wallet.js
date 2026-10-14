/* Delete wallet from this device (also: "Forgot your password?")
 * Spec: ONE job: remove this wallet from this device, knowingly.
 *       Primary CTA: "Delete from this device" (enabled only after typing DELETE).
 *       Taps from app open: 3 (Settings -> Delete) / 2 from the unlock screen / 4 for another
 *       wallet (Settings -> Wallets -> its row -> Delete).
 * Exit-intent reasons and answers:
 *   - "Will I lose my money?" -> only if the 12 words are lost too; said in one sentence.
 *   - "I forgot my password" -> this is the way back: delete here, restore with the words.
 *   - Imported from a wallet.db: the same, with the original file and its password instead of words.
 *   - "Does this delete my other wallets?" -> with several, it names the one that goes and says the
 *     others stay as they are; only its own file and data are removed (lib/wallets.js).
 *   - "Is it really all gone?" -> what BEAM Campfire cannot remove is said, small: its Face ID passkey
 *     lives in the password manager (BEAM Campfire asks it to forget it; where to check), and, for the
 *     last wallet, the browser may keep deleted data on disk until it tidies up (clearing the site's
 *     data in the browser's settings removes it).
 *   - "What about my move / my codes / my purchase still under way?" -> open bridge moves, airdrop
 *     batches whose codes may not all be claimed, and purchases at buybeam.my in progress are listed
 *     first (this device keeps their only record), with a way to each (save the codes, finish, collect);
 *     Delete then also waits for "Delete anyway" (lib/in_flight.js; release audit BM-4, BC-6).
 */
import { h, put } from '../lib/dom.js';
import { inFlight } from '../lib/in_flight.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { wipeWallet, isImported } from '../lib/session.js';
import { hasEthWallet, ethWalletKind } from '../lib/eth/record.js';
import { listWallets, nameOf, walletStore } from '../lib/wallets.js';
import { t, tn, tNodes, lang } from '../lib/i18n.js';

// The word typed to confirm: the same in every language (it is compared below).
const CONFIRM_WORD = 'DELETE';

/** "A, B and C" in the app's language (English: no comma before "and"). */
function listText(names) {
  if (typeof Intl !== 'undefined' && typeof Intl.ListFormat === 'function') {
    const l = lang();
    return new Intl.ListFormat(l === 'en' ? 'en-GB' : l, { type: 'conjunction', style: 'long' }).format(names);
  }
  return names.join(', ').replace(/, ([^,]*)$/, ' and $1'); // English where Intl.ListFormat is missing
}

export default function deleteWallet(app, params = {}) {
  const forgot = Boolean(params.forgot);
  // Several wallets: Settings -> Wallets names the one to delete; otherwise it is the selected one.
  const other = Boolean(params.id && !(app.record && app.record.id === params.id));
  if (!app.record && !other) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const target = other ? { id: params.id, name: params.name, imported: Boolean(params.imported), slot0: false } : app.record;
  const name = other ? params.name : nameOf(app.record);
  const imported = other ? Boolean(params.imported) : isImported(app);
  const othersBox = h('div');
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': t('Type {word}', { word: CONFIRM_WORD }), 'data-testid': 'delete-confirm', placeholder: CONFIRM_WORD });
  const msg = h('div');
  // With an Ethereum wallet beside it, its own words (or private key) are needed too: it goes with it.
  const ethBox = h('div');
  const kvP = other ? listWallets().then((l) => {
    const r = l.find((x) => x.id === params.id);
    if (!r) throw new Error('gone');
    return walletStore(r);
  }) : Promise.resolve(undefined);
  kvP.then((kv) => Promise.all([hasEthWallet(kv), ethWalletKind(kv)])).then(([has, known]) => {
    const kind = has ? known || 'words' : null;
    const lead = h('strong', { text: t('Your Ethereum wallet is removed too.') });
    const text =
      kind === 'key'
        ? tNodes('{lead} Its private key brings it back; your BEAM words do not. Save the key (Settings → Ethereum wallet → Backup) and keep your BEAM words before you delete.', { lead })
        : tNodes('{lead} Its own words bring it back; your BEAM words do not. Keep both sets of words before you delete.', { lead });
    if (kind) put(ethBox, h('div', { 'data-testid': 'delete-eth-words', 'data-kind': kind }, notice('warn', ...text)));
  }, () => {});
  const cta = primary(t('Delete from this device'), run, { disabled: true, 'data-testid': 'delete-submit' });
  cta.classList.replace('btn-primary', 'btn-danger');

  // Coins still under way whose only record is this wallet's (lib/in_flight.js): listed, and Delete
  // waits for "Delete anyway" while any are. null while it is being read.
  let flight = null;
  let flightAck = false;
  const flightBox = h('div');
  const update = () => {
    // NFKC: ＤＥＬＥＴＥ typed with a Chinese or Japanese keyboard is DELETE.
    cta.disabled = input.value.normalize('NFKC').trim().toUpperCase() !== CONFIRM_WORD || flight === null || (flight.length > 0 && !flightAck);
  };
  input.addEventListener('input', update);
  const openHere = Boolean(app.dbPass && app.record && app.record.id === target.id);
  listWallets()
    .then((l) => {
      const r = l.find((x) => x.id === target.id);
      return r ? inFlight(app, target, { kv: walletStore(r) }) : [];
    })
    .then(
      (list) => {
        flight = list;
        put(flightBox, list.length ? flightNotice(list) : null);
        update();
      },
      () => {
        flight = [];
        update();
      },
    );

  function flightNotice(list) {
    const counted = list.filter((x) => x.count !== null);
    const unseen = list.filter((x) => x.count === null);
    const lines = {
      bridge: (x) =>
        tn(
          {
            one: '{n} bridge move still under way. The coins are not lost: moves to Ethereum arrive by themselves, and coins moved to BEAM can be collected again from the restored wallet, under "Waiting for you on BEAM". Only the record here goes.',
            other: '{n} bridge moves still under way. The coins are not lost: moves to Ethereum arrive by themselves, and coins moved to BEAM can be collected again from the restored wallet, under "Waiting for you on BEAM". Only the record here goes.',
          },
          x.count,
        ),
      airdrop: (x) =>
        tn(
          {
            one: '{n} airdrop batch with codes that may not all be claimed. The codes are kept only here: save them as a CSV file first (My batches → Show codes). What nobody claimed can still be taken back later.',
            other: '{n} airdrop batches with codes that may not all be claimed. The codes are kept only here: save them as a CSV file first (My batches → Show codes). What nobody claimed can still be taken back later.',
          },
          x.count,
        ),
      buy: (x) =>
        tn(
          {
            one: '{n} purchase at buybeam.my still under way. Its deposit address is kept only here: let it finish first.',
            other: '{n} purchases at buybeam.my still under way. Their deposit addresses are kept only here: let them finish first.',
          },
          x.count,
        ),
    };
    const names = { bridge: t('bridge moves'), airdrop: t('airdrop codes'), buy: t('purchases at buybeam.my') };
    const listed = (xs) => listText(xs.map((x) => names[x.kind]));
    const ways = { bridge: [t('Bridge moves'), 'bridgeList'], airdrop: [t('My batches'), 'airdropBatches'], buy: [t('Purchases'), 'buyOrders'] };
    const box = h('input', { type: 'checkbox', 'data-testid': 'delete-flight-ack' });
    box.addEventListener('change', () => {
      flightAck = box.checked;
      update();
    });
    return h(
      'div',
      { class: 'stack tight delete-flight', 'data-testid': 'delete-in-flight', 'data-kinds': list.map((x) => x.kind).join(' ') },
      notice(
        'warn',
        ...(counted.length
          ? tNodes('{lead} This device keeps their only record:', { lead: h('strong', { text: t('Coins still on their way go with it too.') }) })
          : [h('strong', { text: t('Coins still on their way may go with it too.') })]),
        counted.length ? h('ul', { class: 'plain-list' }, ...counted.map((x) => h('li', { 'data-kind': x.kind, text: lines[x.kind](x) }))) : null,
        unseen.length
          ? h('p', {
              'data-testid': 'delete-in-flight-unseen',
              text: counted.length
                ? t("It also keeps saved {list}: BEAM Campfire can't look inside them without this wallet's password.", { list: listed(unseen) })
                : t("This device keeps this wallet's saved {list}, the only record of any still under way. BEAM Campfire can't look inside them without the wallet's password, so it can't tell whether any are. Open the wallet to check them first, if you can.", { list: listed(unseen) }),
            })
          : null,
        openHere && counted.length
          ? h('div', { class: 'btn-row prompt-actions' }, ...counted.map((x) => h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': `delete-way-${x.kind}`, onclick: () => app.go(ways[x.kind][1]) }, ways[x.kind][0])))
          : null,
      ),
      h('label', { class: 'check-row' }, box, h('span', { text: t('Delete anyway: I saved or finished what I need') })),
    );
  }

  // What stays where BEAM Campfire cannot reach it.
  const tracesBox = h('div', { class: 'stack tight' });
  listWallets().then((l) => {
    // Two or more wallets here: one other (l.length 2) is "Your other wallet".
    if (l.length > 1) put(othersBox, h('p', { class: 'lead', 'data-testid': 'delete-others', text: tn({ one: 'Only {name} is deleted. Your other wallet stays as it is.', other: 'Only {name} is deleted. Your other {n} wallets stay as they are.' }, l.length - 1, { name }) }));
    const r = l.find((x) => x.id === target.id);
    const passkey = Boolean(r && r.envelopes && r.envelopes.passkey);
    put(
      tracesBox,
      // {passkey}: the passkey's name as the password manager lists it (lib/passkey.js), never translated.
      passkey
        ? h('p', {
            class: 'small',
            'data-testid': 'delete-passkey',
            text: t('Its Face ID key (a passkey for {host}, “{passkey}”) is kept by your password manager, not by BEAM Campfire. BEAM Campfire asks it to forget the key; if it is still listed in Passwords or Google Password Manager, delete it there.', {
              host: location.hostname,
              passkey: `BEAM Campfire wallet ${target.id.slice(0, 6)}`, // i18n-ignore: the passkey's name in the password manager (lib/passkey.js)
            }),
          })
        : null,
      l.length === 1 ? h('p', { class: 'small', 'data-testid': 'delete-traces', text: t("The browser may keep deleted data on its disk for a while. To leave nothing, also clear this site's data in the browser's settings.") }) : null,
    );
  }, () => {});

  async function run() {
    cta.disabled = true;
    cta.textContent = t('Deleting…');
    try {
      const list = await listWallets();
      const rec = list.find((r) => r.id === target.id);
      if (!rec) throw Object.assign(new Error('not on this device'), { code: 'gone' }); // i18n-ignore: said below by its code
      const { others } = await wipeWallet(app, rec);
      if (other) {
        toast(t('{name} was deleted from this device', { name }));
        app.go('wallets', {}, { replace: true });
      } else if (others.length) app.go('unlock', { reason: 'deleted', deleted: name }, { reset: true });
      else app.go('welcome', {}, { reset: true });
    } catch (e) {
      cta.textContent = t('Delete from this device');
      update();
      put(msg, notice('error', e.code === 'gone' ? t('It could not be deleted: it is not on this device any more') : t('It could not be deleted: {reason}', { reason: e.message })));
    }
  }

  const el = screen(
    { title: forgot ? t('Forgot your password?') : t('Delete wallet'), back: () => app.back(forgot ? 'unlock' : other ? 'wallets' : 'settings'), actions: [cta] },
    forgot
      ? h('p', {
          class: 'lead',
          text: imported
            ? t('Nobody can reset the password. With the original wallet.db file and the password it had, you can delete the wallet from this device and import the file again; your coins come back.')
            : t('Nobody can reset the password. With your 12 words you can delete the wallet from this device and restore it; your coins come back.'),
        })
      : null,
    imported
      ? notice('warn', ...tNodes('{lead} It has no 12 words. If you do not have both, stop here: deleting without them loses the money for good.', { lead: h('strong', { text: t('Only the original wallet.db file and its password can bring this wallet back.') }) }))
      : notice('warn', ...tNodes('{lead} If you do not have them written down, stop here: deleting without them loses the money for good.', { lead: h('strong', { text: t('Only your 12 words can bring this wallet back.') }) })),
    ethBox,
    flightBox,
    h('p', { class: 'lead', 'data-testid': 'delete-what', text: t('This removes {name}, its history and its settings from this device. Nothing is changed on the blockchain.', { name }) }),
    othersBox,
    h('label', { class: 'field' }, t('Type {word} to confirm', { word: CONFIRM_WORD }), input),
    msg,
    tracesBox,
  );
  return { el };
}
