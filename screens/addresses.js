/* Your addresses (from Receive and Settings)
 * Spec: ONE job: see which of my addresses can still be paid, and tidy them up.
 *       Primary CTA: none while there are addresses (copy, label, show on Receive and delete are
 *       per address); "Get my address" when there are none.
 *       Taps from app open: 2 (Home -> Receive -> Your addresses).
 * Exit-intent reasons and answers:
 *   - "A wall of dead addresses" -> expired ones are folded behind a count.
 *   - "Which one do I give out?" -> the one Receive shows is marked, and any other active regular
 *     address can be made the one Receive shows.
 *   - "Will deleting lose money?" -> the confirmation says what deleting means; an address a
 *     payment is still waiting on is not deleted.
 *   - "Empty or failed list" -> says what to do, with a button.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, openSheet, copyText, toast, focusSoon } from '../lib/ui.js';
import { wallet, ADDRESS_COMMENT } from '../lib/wallet.js';
import { splitAddresses, typeLabel, lifetime, shortAddress, canBeCurrent, cleanLabel, busyWith, listOwn, renameAddress, deleteAddress, pickReceiveAddress, ADDRESS_TEXT as T, LABEL_MAX } from '../lib/addresses.js';
import { vaultFor } from '../lib/contacts.js';

/** The address Receive shows, as chosen on this screen (null: the newest). */
export async function preferredReceive(app) {
  try {
    return await (await vaultFor(app)).receiveAddress();
  } catch {
    return null;
  }
}

export async function rememberReceive(app, address) {
  try {
    await (await vaultFor(app)).setReceiveAddress(address);
    return true;
  } catch {
    return false;
  }
}

export default function addresses(app) {
  const box = h('div', { 'data-testid': 'addresses-box' });
  let list = null;
  let problem = null;
  let current = null;
  let showExpired = false;

  async function load() {
    try {
      if (!wallet.session) throw new Error('The wallet is still starting.');
      const [l, pref] = await Promise.all([listOwn(wallet.session), preferredReceive(app)]);
      list = l;
      current = pickReceiveAddress(l, { preferred: pref, label: ADDRESS_COMMENT });
      problem = null;
    } catch (e) {
      problem = e;
    }
    render();
  }

  function render() {
    if (problem)
      return put(box, notice('error', `Your addresses can't be shown yet: ${problem.message} Try again in a moment.`), secondary('Try again', load, { 'data-testid': 'addresses-retry' }));
    if (!list) return put(box, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { text: 'Getting your addresses…' })));
    const split = splitAddresses(list);
    // The one Receive shows first: it is the one people are given.
    const active = [...split.active.filter((a) => a.address === current), ...split.active.filter((a) => a.address !== current)];
    const { expired } = split;
    if (!active.length && !expired.length)
      return put(box, h('div', { class: 'card empty', 'data-testid': 'addresses-empty' }, h('p', { text: 'No addresses yet.' }), h('p', { class: 'small', text: 'Make one now and share it with whoever is paying you.' }), primary('Get my address', () => app.go('receive'))));
    put(
      box,
      h('p', { class: 'section-title', text: `Active (${active.length})` }),
      active.length ? h('div', { class: 'stack', 'data-testid': 'addresses-active' }, ...active.map(tile)) : h('div', { class: 'card empty' }, h('p', { text: 'No active address.' }), primary('Get my address', () => app.go('receive'))),
      expired.length
        ? h(
            'button',
            { class: 'row card fold', 'aria-expanded': String(showExpired), 'data-testid': 'addresses-expired-toggle', onclick: () => ((showExpired = !showExpired), render()) },
            h('span', { class: 'main' }, h('div', { class: 't', text: `Expired (${expired.length})` }), h('div', { class: 's', text: 'Payments to these no longer arrive' })),
            h('span', { class: 'chev' }, icon(showExpired ? 'down' : 'chevron')),
          )
        : null,
      showExpired && expired.length ? h('div', { class: 'stack', 'data-testid': 'addresses-expired' }, ...expired.map(tile)) : null,
    );
  }

  function tile(a) {
    const isCurrent = a.address === current;
    const label = cleanLabel(a.comment);
    return h(
      'div',
      { class: `card addr-tile${a.expired ? ' expired' : ''}`, 'data-address': a.address, 'data-testid': 'address-tile' },
      h('div', { class: 'addr-head' }, h('span', { class: 'addr-type', text: typeLabel(a.type) }), isCurrent ? h('span', { class: 'tag public', 'data-testid': 'address-current', text: T.current }) : null),
      h('div', { class: `addr-label${label ? '' : ' none'}`, 'data-testid': 'address-label', text: label || T.noLabel }),
      h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
      h('div', { class: 'small', 'data-testid': 'address-life', text: lifetime(a) }),
      h(
        'div',
        { class: 'addr-actions' },
        textButton('Copy', () => copyText(a.address, 'Address copied'), { 'data-testid': 'address-copy' }),
        textButton('Edit label', () => editLabel(a), { 'data-testid': 'address-rename' }),
        !isCurrent && canBeCurrent(a) ? textButton('Show on Receive', () => makeCurrent(a), { 'data-testid': 'address-make-current' }) : null,
        textButton('Delete', () => confirmDelete(a), { class: 'btn btn-text danger', 'data-testid': 'address-delete' }),
      ),
    );
  }

  async function makeCurrent(a) {
    if (await rememberReceive(app, a.address)) {
      current = a.address;
      toast(T.madeCurrent);
      render();
    } else toast("It couldn't be saved just now. Try again.");
  }

  function editLabel(a) {
    const input = h('input', { class: 'input', type: 'text', maxlength: String(LABEL_MAX), autocomplete: 'off', placeholder: T.labelHint, 'aria-label': 'Label', 'data-testid': 'address-label-input' });
    input.value = cleanLabel(a.comment) === ADDRESS_COMMENT ? '' : cleanLabel(a.comment);
    const msg = h('div', { class: 'pay-msg' });
    const sheet = openSheet(
      () => [
        h('h2', { text: 'Edit label' }),
        h('p', { class: 'small', text: 'Only you see it: a reminder of who this address is for. On a payment to it, your list shows this label.' }),
        h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
        input,
        msg,
        primary('Save label', async () => {
          try {
            // The address Receive shows stays shown under its new label.
            if (a.address === current) await rememberReceive(app, a.address);
            await renameAddress(wallet.session, a.address, input.value);
            await wallet.persistNow();
            sheet.close(true);
            toast(T.labelSaved);
            load();
          } catch (e) {
            put(msg, notice('error', `The label wasn't saved: ${e.message}. Try again.`));
          }
        }, { 'data-testid': 'address-label-save' }),
        textButton('Cancel', () => sheet.close(false)),
      ],
      { label: 'Edit label' },
    );
    focusSoon(input);
  }

  function confirmDelete(a) {
    if (busyWith(a.address, wallet.state.txs)) return toast(T.deleteBusy, 5000);
    const msg = h('div', { class: 'pay-msg' });
    const sheet = openSheet(
      () => [
        h('h2', { text: T.deleteTitle }),
        h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
        h('p', { class: 'lead', text: T.deleteBody }),
        a.address === current ? notice('info', 'Receive then shows another of your addresses, or a new one.') : null,
        msg,
        h('button', {
          class: 'btn btn-danger',
          'data-testid': 'address-delete-confirm',
          onclick: async () => {
            try {
              await deleteAddress(wallet.session, a.address);
              if (a.address === current) await rememberReceive(app, null);
              await wallet.persistNow();
              sheet.close(true);
              toast(T.deleted);
              load();
            } catch (e) {
              put(msg, notice('error', `It wasn't deleted: ${e.message}. Try again.`));
            }
          },
        }, 'Delete address'),
        textButton('Keep it', () => sheet.close(false)),
      ],
      { label: T.deleteTitle },
    );
  }

  render();
  load();
  const el = screen({ title: 'Your addresses', back: () => app.back('receive'), cls: 'plain' }, h('p', { class: 'small', text: 'Addresses this wallet can be paid at. Each one can be given to a different person.' }), box);
  return { el };
}
