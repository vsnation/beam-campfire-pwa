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
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Type DELETE', 'data-testid': 'delete-confirm', placeholder: 'DELETE' });
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
    const text =
      kind === 'key'
        ? 'Its private key brings it back; your BEAM words do not. Save the key (Settings → Ethereum wallet → Backup) and keep your BEAM words before you delete.'
        : 'Its own words bring it back; your BEAM words do not. Keep both sets of words before you delete.';
    if (kind) put(ethBox, h('div', { 'data-testid': 'delete-eth-words', 'data-kind': kind }, notice('warn', h('strong', { text: 'Your Ethereum wallet is removed too. ' }), text)));
  }, () => {});
  const cta = primary('Delete from this device', run, { disabled: true, 'data-testid': 'delete-submit' });
  cta.classList.replace('btn-primary', 'btn-danger');

  // Coins still under way whose only record is this wallet's (lib/in_flight.js): listed, and Delete
  // waits for "Delete anyway" while any are. null while it is being read.
  let flight = null;
  let flightAck = false;
  const flightBox = h('div');
  const update = () => {
    cta.disabled = input.value.trim().toUpperCase() !== 'DELETE' || flight === null || (flight.length > 0 && !flightAck);
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
    const n = (x, one, many) => `${x.count} ${x.count === 1 ? one : many}`;
    const lines = {
      bridge: (x) => `${n(x, 'bridge move', 'bridge moves')} still under way. The coins are not lost: moves to Ethereum arrive by themselves, and coins moved to BEAM can be collected again from the restored wallet, under "Waiting for you on BEAM". Only the record here goes.`,
      airdrop: (x) => `${n(x, 'airdrop batch', 'airdrop batches')} with codes that may not all be claimed. The codes are kept only here: save them as a CSV file first (My batches → Show codes). What nobody claimed can still be taken back later.`,
      buy: (x) => `${n(x, 'purchase', 'purchases')} at buybeam.my still under way. ${x.count === 1 ? 'Its deposit address is' : 'Their deposit addresses are'} kept only here: let ${x.count === 1 ? 'it' : 'them'} finish first.`,
    };
    const names = { bridge: 'bridge moves', airdrop: 'airdrop codes', buy: 'purchases at buybeam.my' };
    const listed = (xs) => xs.map((x) => names[x.kind]).join(', ').replace(/, ([^,]*)$/, ' and $1');
    const ways = { bridge: ['Bridge moves', 'bridgeList'], airdrop: ['My batches', 'airdropBatches'], buy: ['Purchases', 'buyOrders'] };
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
        h('strong', { text: counted.length ? 'Coins still on their way go with it too. ' : 'Coins still on their way may go with it too. ' }),
        counted.length ? 'This device keeps their only record:' : null,
        counted.length ? h('ul', { class: 'plain-list' }, ...counted.map((x) => h('li', { 'data-kind': x.kind, text: lines[x.kind](x) }))) : null,
        unseen.length
          ? h('p', {
              'data-testid': 'delete-in-flight-unseen',
              text: counted.length
                ? `It also keeps saved ${listed(unseen)}: BEAM Campfire can't look inside them without this wallet's password.`
                : `This device keeps this wallet's saved ${listed(unseen)}, the only record of any still under way. BEAM Campfire can't look inside them without the wallet's password, so it can't tell whether any are. Open the wallet to check them first, if you can.`,
            })
          : null,
        openHere && counted.length
          ? h('div', { class: 'btn-row prompt-actions' }, ...counted.map((x) => h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': `delete-way-${x.kind}`, onclick: () => app.go(ways[x.kind][1]) }, ways[x.kind][0])))
          : null,
      ),
      h('label', { class: 'check-row' }, box, h('span', { text: 'Delete anyway: I saved or finished what I need' })),
    );
  }

  // What stays where BEAM Campfire cannot reach it.
  const tracesBox = h('div', { class: 'stack tight' });
  listWallets().then((l) => {
    if (l.length > 1) put(othersBox, h('p', { class: 'lead', 'data-testid': 'delete-others', text: `Only ${name} is deleted. ${l.length === 2 ? 'Your other wallet stays as it is.' : `Your other ${l.length - 1} wallets stay as they are.`}` }));
    const r = l.find((x) => x.id === target.id);
    const passkey = Boolean(r && r.envelopes && r.envelopes.passkey);
    put(
      tracesBox,
      passkey ? h('p', { class: 'small', 'data-testid': 'delete-passkey', text: `Its Face ID key (a passkey for ${location.hostname}, “BEAM Campfire wallet ${target.id.slice(0, 6)}”) is kept by your password manager, not by BEAM Campfire. BEAM Campfire asks it to forget the key; if it is still listed in Passwords or Google Password Manager, delete it there.` }) : null,
      l.length === 1 ? h('p', { class: 'small', 'data-testid': 'delete-traces', text: "The browser may keep deleted data on its disk for a while. To leave nothing, also clear this site's data in the browser's settings." }) : null,
    );
  }, () => {});

  async function run() {
    cta.disabled = true;
    cta.textContent = 'Deleting…';
    try {
      const list = await listWallets();
      const rec = list.find((r) => r.id === target.id);
      if (!rec) throw new Error('it is not on this device any more');
      const { others } = await wipeWallet(app, rec);
      if (other) {
        toast(`${name} was deleted from this device`);
        app.go('wallets', {}, { replace: true });
      } else if (others.length) app.go('unlock', { reason: 'deleted', deleted: name }, { reset: true });
      else app.go('welcome', {}, { reset: true });
    } catch (e) {
      cta.textContent = 'Delete from this device';
      update();
      put(msg, notice('error', `It could not be deleted: ${e.message}`));
    }
  }

  const el = screen(
    { title: forgot ? 'Forgot your password?' : 'Delete wallet', back: () => app.back(forgot ? 'unlock' : other ? 'wallets' : 'settings'), actions: [cta] },
    forgot
      ? h('p', {
          class: 'lead',
          text: imported
            ? 'Nobody can reset the password. With the original wallet.db file and the password it had, you can delete the wallet from this device and import the file again; your coins come back.'
            : 'Nobody can reset the password. With your 12 words you can delete the wallet from this device and restore it; your coins come back.',
        })
      : null,
    imported
      ? notice('warn', h('strong', { text: 'Only the original wallet.db file and its password can bring this wallet back. ' }), 'It has no 12 words. If you do not have both, stop here: deleting without them loses the money for good.')
      : notice('warn', h('strong', { text: 'Only your 12 words can bring this wallet back. ' }), 'If you do not have them written down, stop here: deleting without them loses the money for good.'),
    ethBox,
    flightBox,
    h('p', { class: 'lead', 'data-testid': 'delete-what', text: `This removes ${name}, its history and its settings from this device. Nothing is changed on the blockchain.` }),
    othersBox,
    h('label', { class: 'field' }, 'Type DELETE to confirm', input),
    msg,
    tracesBox,
  );
  return { el };
}
