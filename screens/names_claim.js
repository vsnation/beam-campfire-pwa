/* Money waiting for your names: the line on Home, and the claim
 * Spec: ONE job: see that someone paid one of my names (or bought one) and move that money into my balance.
 *       Primary CTA: "Claim" on the line under the balance; the approve sheet's button says the outcome,
 *       "Claim 2.5 BEAM" (or "Claim all"), with the exact amounts and network fee the engine built.
 *       Taps from app open: 1 (Claim) + 1 (the approve sheet's button), then Face ID or the password.
 * Exit-intent reasons and answers:
 *   - "Where is the money someone sent to alice.beam?" -> "Sent to your name alice.beam: 2.5 BEAM · Claim",
 *     right under the balance, never added into it (it is not spendable until claimed).
 *   - "What does claiming cost?" -> the approve sheet shows the network fee the engine built, says when it
 *     comes out of the money claimed (an empty wallet can claim BEAM), and warns, without forbidding, when
 *     the fee is as large as what waits.
 *   - "Can people see it?" -> the sheet says a payment and its claim can be linked, and how to make it harder.
 *   - "Did it work?" -> "Claim sent" with the balance change, and the line says it is on its way.
 *   - "Why can't I claim?" -> the reason in words (wallet catching up, no BEAM for a token claim's fee,
 *     or this version cannot claim), never a silent grey button.
 *
 * When Home reads the inbox: it costs a contract read on this wallet's node, so only for a wallet that may
 * hold names. A wallet created in this app owns none until it registers, buys or is given one (checked
 * once a day); one restored or imported is checked once, after it is up to date; one that owns names is
 * checked whenever Home shows and a new block arrived (at most every 20 s).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { store } from '../lib/store.js';
import { walletKey } from '../lib/wallet_scope.js';
import { NameInbox, advise, claimText, namePaymentsText, isEmpty, VISIBILITY, homeShouldRead } from '../lib/bans_inbox.js';
import { bans, nameProblemText } from './names.js';
import { tellOther } from '../lib/notify.js';
import { t } from '../lib/i18n.js';

/** Per wallet (lib/wallet_scope.js): deleting the wallet deletes it. */
export const HINT_NAME = 'namesHint';
const FIRST_CHECK_DELAY_MS = 8000;

let shared = null;

/** The inbox of the running wallet session (one per session). */
export function nameInbox() {
  const session = wallet.session;
  if (shared && shared.session === session) return shared.inbox;
  if (shared) shared.inbox.dispose();
  const inbox = new NameInbox(() => bans().inbox());
  shared = { session, inbox };
  return inbox;
}

/** {owns: true|false, at} for this wallet, or null when never decided. */
export async function namesHint(app) {
  try {
    const v = await store.get(walletKey(app, HINT_NAME));
    return v && typeof v.owns === 'boolean' && Number.isFinite(v.at) ? v : null;
  } catch {
    return null;
  }
}

/** Remembers whether this wallet holds names (or had money waiting for them). */
export async function setNamesHint(app, owns) {
  try {
    await store.set(walletKey(app, HINT_NAME), { owns: Boolean(owns), at: Date.now() });
  } catch {
    /* no wallet open, or storage refused: a missing hint only means one more check */
  }
}

const fmt = (g) => formatAmount(g);
const unit = (id) => wallet.label(id).unit;

/** The approve sheet's words for a claim the engine built (screens/consent.js intentExtras). */
export function claimWords({ summary, advice, canSpend, built }) {
  const words = claimText({ summary, advice, canSpend, built, fmt, unit });
  return {
    names: summary.names,
    rows: [[t('Sent to'), words.from], [t('Your balance changes by'), words.balanceChange]],
    warn: words.warning,
    notes: [words.feeNote, words.batches, words.privacyNote].filter(Boolean),
  };
}

/**
 * Builds the claim of everything waiting (up to 30 entries) and hands it to the approve sheet,
 * with the words for it. Resolves { ok, text, code }: what to tell the person.
 */
export async function runClaim(app, inbox = nameInbox()) {
  const summary = inbox.latest;
  if (!summary || summary.visibility !== VISIBILITY.visible || isEmpty(summary)) return { ok: false, code: 'nothing', text: t('There is nothing waiting to be claimed.') };
  const advice = advise(summary, wallet.available(0));
  const canSpend = wallet.state.sync.canSend;
  const words = claimText({ summary, advice, canSpend, fmt, unit });
  if (!canSpend) return { ok: false, code: 'paused', text: words.blocker };
  try {
    const r = await bans().claimAll({ words: (built) => claimWords({ summary, advice, canSpend, built }) });
    const done = claimText({ summary, advice, canSpend, built: r, fmt, unit });
    inbox.markClaiming(r.receives);
    wallet.refreshTxs();
    wallet.refreshStatus();
    setTimeout(() => inbox.refresh({ force: true }), 90000);
    return { ok: true, code: 'sent', text: t('Claim sent. Your balance changes by {change} once the network confirms it, usually within a few minutes.', { change: done.balanceChange }) };
  } catch (e) {
    if (e && e.code === 'claimUnsupported') {
      inbox.refresh({ force: true });
      return { ok: false, code: e.code, text: t("This version of BEAM Campfire can't claim name payments yet. They stay safe and waiting for you.") };
    }
    if (e && e.refusal === 'nothingToClaim') inbox.refresh({ force: true });
    const text = e && e.code === 'rejected' ? t('Cancelled. Nothing was claimed; it is still waiting for you.') : e && e.code !== 'refused' ? `${nameProblemText(e, 'claim')} ${t('Your payments are still waiting for you.')}` : nameProblemText(e, 'claim');
    return { ok: false, code: (e && e.code) || 'error', text, calm: Boolean(e && (e.code === 'rejected' || e.refusal === 'nothingToClaim')) };
  }
}

/** Home's line under the balance: nothing at all unless something waits. */
export function namesHomeLine(app) {
  const el = h('div', { class: 'names-home', 'data-testid': 'names-home-box' });
  let alive = true;
  let busy = false;
  let message = null;
  let lastHeight = null;
  let decided = null; // null until the hint is read; then true (read) or false (don't)
  let deciding = null;
  let firstTimer = null;
  const inbox = wallet.session ? nameInbox() : null;
  let toldAmounts; // undefined until the first read (history); then what was last seen waiting

  /** New money paid to a name while BEAM Campfire is not in front: a notification (lib/notify.js); the line says it on screen. */
  function tellNew(pay) {
    const now = pay ? pay.amounts : null;
    if (toldAmounts !== undefined && now && now !== toldAmounts) tellOther(app, { kind: 'in', title: t('Money was paid to your BEAM name'), body: t('{lead}: {amounts}. Claim it on Home.', { lead: pay.lead, amounts: now }), plainBody: t('Claim it on Home.'), tag: 'names-inbox', url: '#open=home' });
    toldAmounts = now;
  }

  function render() {
    if (!alive) return;
    const s = inbox && inbox.latest;
    if (inbox && inbox.claiming) {
      const r = inbox.claiming.receives;
      put(el, h('div', { class: 'card names-line', 'data-testid': 'names-home-line', 'data-state': 'claiming' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'grow', text: t('Claim on its way: {amounts}', { amounts: [...r.keys()].map((id) => `+${fmt(r.get(id))} ${unit(id)}`).join(', ') }) })));
      return;
    }
    const pay = namePaymentsText(s, fmt, unit);
    if (s) tellNew(pay);
    if (!pay) return put(el);
    put(
      el,
      h(
        'div',
        { class: 'card names-line', 'data-testid': 'names-home-line', 'data-state': 'waiting' },
        h('span', { class: 'grow' }, h('span', { class: 'small', text: `${pay.lead}: ` }), h('strong', { 'data-testid': 'names-home-amounts', text: pay.amounts })),
        h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'names-home-claim', disabled: busy, onclick: claim }, busy ? t('Preparing…') : t('Claim')),
        message ? h('p', { class: `small names-line-msg ${message.ok || message.calm ? '' : 'bad'}`, 'data-testid': 'names-home-msg', 'data-code': message.code, text: message.text }) : null,
      ),
    );
  }

  async function claim() {
    if (busy) return;
    busy = true;
    message = null;
    render();
    const r = await runClaim(app, inbox);
    busy = false;
    if (!alive) return;
    if (r.ok) toast(r.text, 6000);
    else message = r;
    render();
  }

  const tipHeight = () => Number((wallet.state.status && wallet.state.status.current_height) || 0);

  function maybeRead() {
    if (!alive || !inbox || !wallet.session || wallet.state.sync.state !== 'synced') return;
    if (decided === null) {
      if (!deciding) deciding = decide();
      return;
    }
    if (!decided || tipHeight() === lastHeight) return;
    lastHeight = tipHeight();
    read();
  }

  async function decide() {
    const hint = await namesHint(app);
    if (!alive) return;
    decided = homeShouldRead({ hint, record: app.record });
    if (!hint && !decided) setNamesHint(app, false);
    if (!decided) return;
    lastHeight = tipHeight();
    // The first read waits a moment: Home's first paint and the wallet's own work come first.
    firstTimer = setTimeout(() => read(), inbox.latest ? 0 : FIRST_CHECK_DELAY_MS);
  }

  async function read() {
    if (!alive) return;
    lastHeight = tipHeight();
    await inbox.refresh();
    const s = inbox.latest;
    if (s && s.visibility === VISIBILITY.visible) setNamesHint(app, s.owns || !isEmpty(s));
  }

  const offInbox = inbox ? inbox.onChange(render) : () => {};
  const offWallet = wallet.onChange(() => maybeRead());
  render();
  maybeRead();
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(firstTimer);
      offInbox();
      offWallet();
    },
  };
}
