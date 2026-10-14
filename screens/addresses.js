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
import { splitAddresses, typeLabel, lifetime, shortAddress, canBeCurrent, cleanLabel, busyWith, listOwn, renameAddress, deleteAddress, pickReceiveAddress, ADDRESS_TEXT as T, LABEL_MAX, canExtend, extendAddress, EXTEND_DAYS, fmtDay } from '../lib/addresses.js';
import { vaultFor } from '../lib/contacts.js';
import { t, tn } from '../lib/i18n.js';

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
      if (!wallet.session) throw new Error(t('The wallet is still starting.'));
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
      return put(box, notice('error', t("Your addresses can't be shown yet: {reason} Try again in a moment.", { reason: problem.message })), secondary(t('Try again'), load, { 'data-testid': 'addresses-retry' }));
    if (!list) return put(box, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { text: t('Getting your addresses…') })));
    const split = splitAddresses(list);
    // The one Receive shows first: it is the one people are given.
    const active = [...split.active.filter((a) => a.address === current), ...split.active.filter((a) => a.address !== current)];
    const { expired } = split;
    if (!active.length && !expired.length)
      return put(box, h('div', { class: 'card empty', 'data-testid': 'addresses-empty' }, h('p', { text: t('No addresses yet.') }), h('p', { class: 'small', text: t('Make one now and share it with whoever is paying you.') }), primary(t('Get my address'), () => app.go('receive'))));
    put(
      box,
      h('p', { class: 'section-title', text: t('Active ({count})', { count: active.length }) }),
      active.length ? h('div', { class: 'stack', 'data-testid': 'addresses-active' }, ...active.map(tile)) : h('div', { class: 'card empty' }, h('p', { text: t('No active address.') }), primary(t('Get my address'), () => app.go('receive'))),
      expired.length
        ? h(
            'button',
            { class: 'row card fold', 'aria-expanded': String(showExpired), 'data-testid': 'addresses-expired-toggle', onclick: () => ((showExpired = !showExpired), render()) },
            h('span', { class: 'main' }, h('div', { class: 't', text: t('Expired ({count})', { count: expired.length }) }), h('div', { class: 's', text: t('Payments to these no longer arrive') })),
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
      h('div', { class: 'addr-head' }, h('span', { class: 'addr-type', text: typeLabel(a.type) }), isCurrent ? h('span', { class: 'tag public', 'data-testid': 'address-current', text: t(T.current) }) : null),
      h('div', { class: `addr-label${label ? '' : ' none'}`, 'data-testid': 'address-label', text: label || t(T.noLabel) }),
      h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
      h('div', { class: 'small', 'data-testid': 'address-life', text: lifetime(a) }),
      h(
        'div',
        { class: 'addr-actions' },
        textButton(t('Copy'), () => copyText(a.address, t('Address copied')), { 'data-testid': 'address-copy' }),
        textButton(t('Edit label'), () => editLabel(a), { 'data-testid': 'address-rename' }),
        !isCurrent && canBeCurrent(a) ? textButton(t('Show on Receive'), () => makeCurrent(a), { 'data-testid': 'address-make-current' }) : null,
        canExtend(a) ? textButton(a.expired ? t('Use again') : tn({ one: 'Extend {n} day', other: 'Extend {n} days' }, EXTEND_DAYS), () => extend(a), { 'data-testid': 'address-extend' }) : null,
        textButton(t('Delete'), () => confirmDelete(a), { class: 'btn btn-text danger', 'data-testid': 'address-delete' }),
      ),
    );
  }

  async function extend(a) {
    try {
      await extendAddress(wallet.session, a.address);
      await wallet.persistNow();
      const until = fmtDay(Date.now() / 1000 + EXTEND_DAYS * 86400);
      toast(a.expired ? T.reused(until) : T.extended(until), 4000);
      load();
    } catch (e) {
      toast(t("It wasn't extended: {reason}. Try again.", { reason: e.message }), 5000);
    }
  }

  async function makeCurrent(a) {
    if (await rememberReceive(app, a.address)) {
      current = a.address;
      toast(t(T.madeCurrent));
      render();
    } else toast(t("It couldn't be saved just now. Try again."));
  }

  function editLabel(a) {
    const input = h('input', { class: 'input', type: 'text', maxlength: String(LABEL_MAX), autocomplete: 'off', placeholder: t(T.labelHint), 'aria-label': t('Label'), 'data-testid': 'address-label-input' });
    input.value = cleanLabel(a.comment) === ADDRESS_COMMENT ? '' : cleanLabel(a.comment);
    const msg = h('div', { class: 'pay-msg' });
    const sheet = openSheet(
      () => [
        h('h2', { text: t('Edit label') }),
        h('p', { class: 'small', text: t('Only you see it: a reminder of who this address is for. On a payment to it, your list shows this label.') }),
        h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
        input,
        msg,
        primary(t('Save label'), async () => {
          try {
            // The address Receive shows stays shown under its new label.
            if (a.address === current) await rememberReceive(app, a.address);
            await renameAddress(wallet.session, a.address, input.value);
            await wallet.persistNow();
            sheet.close(true);
            toast(t(T.labelSaved));
            load();
          } catch (e) {
            put(msg, notice('error', t("The label wasn't saved: {reason}. Try again.", { reason: e.message })));
          }
        }, { 'data-testid': 'address-label-save' }),
        textButton(t('Cancel'), () => sheet.close(false)),
      ],
      { label: t('Edit label') },
    );
    focusSoon(input);
  }

  function confirmDelete(a) {
    if (busyWith(a.address, wallet.state.txs)) return toast(t(T.deleteBusy), 5000);
    const msg = h('div', { class: 'pay-msg' });
    const sheet = openSheet(
      () => [
        h('h2', { text: t(T.deleteTitle) }),
        h('div', { class: 'mono addr-short', text: shortAddress(a.address) }),
        h('p', { class: 'lead', text: t(T.deleteBody) }),
        a.address === current ? notice('info', t('Receive then shows another of your addresses, or a new one.')) : null,
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
              toast(t(T.deleted));
              load();
            } catch (e) {
              put(msg, notice('error', t("It wasn't deleted: {reason}. Try again.", { reason: e.message })));
            }
          },
        }, t('Delete address')),
        textButton(t('Keep it'), () => sheet.close(false)),
      ],
      { label: t(T.deleteTitle) },
    );
  }

  render();
  load();
  const el = screen({ title: t('Your addresses'), back: () => app.back('receive'), cls: 'plain' }, h('p', { class: 'small', text: t('Addresses this wallet can be paid at. Each one can be given to a different person.') }), box);
  return { el };
}
