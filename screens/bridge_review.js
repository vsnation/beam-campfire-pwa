/* Confirm a move to BEAM (a sheet over Move coins)
 * Spec: ONE job: show exactly what leaves the Ethereum wallet - every transaction, every fee - and
 *       what arrives on BEAM, before anything is signed.
 *       Primary CTA: the outcome, "Move 0.5 ETH to BEAM" (then Face ID or the password).
 *       Taps from app open: 3 (⇄, type the amount, Move 0.5 ETH to BEAM), then this button.
 * Exit-intent reasons and answers:
 *   - "What am I signing?" -> each Ethereum transaction is named, the permission included ("allow the
 *     bridge to take exactly 100.02 USDT"); all are signed with this one confirmation, none comes
 *     as a surprise.
 *   - "Will the fee surprise me?" -> the Ethereum network fee as "likely" and "up to"; up to is the
 *     limit signed into the transactions. If it rose since this sheet opened, the new numbers are
 *     shown instead of sending.
 *   - "Is this a scam?" -> it goes to your own BEAM wallet through BEAM's official bridge, named with
 *     its contract; collecting it later costs 0.121 BEAM, said here.
 *   - "Who can see this?" -> said: moving is public on both chains.
 *   - "Can this coin be frozen?" -> said for WBEAM, USDT and WBTC; and it is checked again with
 *     Ethereum right before signing.
 */
import { h } from '../lib/dom.js';
import { openSheet, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { CLAIM_FEE } from '../lib/bridge/routes.js';
import { STEP_KINDS } from '../lib/bridge/eth_pipe.js';
import { ethText, ethMaxText, groupedAddress } from './eth_ui.js';
import { coin, moveLabel, arrivesText, freezeNote, PUBLIC_NOTE, TO_BEAM } from './bridge_text.js';

/** Priced again before signing when the review is older than this. */
const FRESH_MS = 60000;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Opens the review for prepared move `first` (controller.prepare, to BEAM).
 * onStarted(crossing) once the controller has it; nothing is signed before the
 * person confirms it is them.
 */
export function openBridgeReview(app, s, first, { onStarted }) {
  let p = first;
  let message = null;
  let busy = false;
  const ctl = s.ctl;
  return openSheet(
    (close, rerender) => {
      const q = p.quote;
      const r = q.route;
      const plan = p.plan;
      const dec = r.ethDecimals;
      const sym = r.ethSymbol;
      const label = moveLabel(r, TO_BEAM, q.amount);
      const approvals = plan.steps.filter((x) => x.kind !== STEP_KINDS.lock);
      const reset = approvals.some((x) => x.kind === STEP_KINDS.approveReset);
      const n = plan.steps.length;
      const total = r.isNativeEth
        ? [h('span', { 'data-testid': 'bridge-review-total', text: `about ${ethText(q.amount + q.fee + plan.expectedGasCost)}` }), h('div', { class: 'small', text: `at most ${ethMaxText(q.amount + q.fee + plan.maxGasCost)}` })]
        : [h('span', { 'data-testid': 'bridge-review-total', text: `${coin(q.amount + q.fee, dec, sym)} + about ${ethText(plan.expectedGasCost)}` }), h('div', { class: 'small', text: `fee at most ${ethMaxText(plan.maxGasCost)}` })];
      const row = (k, v, tid = null) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, ...[].concat(typeof v === 'string' ? h('span', { 'data-testid': tid, text: v }) : v)));
      const freeze = freezeNote(r);

      const confirm = async () => {
        if (busy) return;
        busy = true;
        message = null;
        try {
          // Older than a minute: priced again, and a higher fee is shown, not sent.
          if (Date.now() - p.at > FRESH_MS) {
            const fresh = await ctl.prepare(q);
            if (fresh.plan.maxGasCost > p.plan.maxGasCost || fresh.plan.steps.length !== p.plan.steps.length) {
              p = fresh;
              busy = false;
              message = notice('warn', 'The Ethereum network fee went up since you opened this. Check the new amounts, then move.');
              return rerender();
            }
            p = fresh;
          }
          const ok = await confirmIdentity(app, { title: 'Confirm your move', detail: `${coin(q.amount, dec, sym)} from your Ethereum wallet to your BEAM wallet`, cta: 'Confirm' });
          if (!ok) {
            busy = false;
            return rerender();
          }
          message = h('p', { class: 'small center', 'data-testid': 'bridge-review-sending', text: n > 1 ? 'Signing and sending, one transaction after the other…' : 'Signing and sending…' });
          rerender();
          // Each transaction is signed after a fresh freeze check, written down, then sent (controller.js).
          const c = await ctl.start(p);
          close(true);
          onStarted(c);
        } catch (e) {
          busy = false;
          message = notice('error', `Nothing was sent. ${e.message}${/\.$/.test(e.message || '') ? '' : '.'}`);
          rerender();
        }
      };

      return [
        h('h2', { text: 'Confirm your move' }),
        h('div', { class: 'big-amount', 'data-testid': 'bridge-review-amount', text: `${coin(q.amount, dec, sym)} → BEAM` }),
        h(
          'div',
          { class: 'card bridge-card' },
          row('Arrives in your BEAM wallet', [h('span', { 'data-testid': 'bridge-review-receive', text: coin(q.receives, 8, r.beamSymbol) }), h('div', { class: 'small', 'data-testid': 'bridge-review-time', text: arrivesText(r, TO_BEAM) })]),
          row('Bridge fee', [h('span', { 'data-testid': 'bridge-review-fee', text: coin(q.fee, dec, sym) }), h('div', { class: 'small', text: 'paid to the bridge operator' })]),
          row('Ethereum network fee', [
            h('span', { 'data-testid': 'bridge-review-eth-fee', text: `likely ${ethText(plan.expectedGasCost)}` }),
            h('div', { class: 'small', 'data-testid': 'bridge-review-eth-fee-max', text: `up to ${ethMaxText(plan.maxGasCost)}` }),
            n > 1 ? h('div', { class: 'small', text: `for ${n} transactions` }) : null,
          ]),
          row('Leaves your Ethereum wallet', total),
          row('Collecting it', [h('span', { text: `${coin(CLAIM_FEE, 8, 'BEAM')} network fee` }), h('div', { class: 'small', text: 'from your BEAM wallet' })]),
          h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'From your Ethereum wallet' }), h('span', { class: 'v mono addr-groups', 'data-testid': 'bridge-review-from', text: groupedAddress(s.w.state.address) })),
          row('Through', [h('span', { text: "BEAM's official bridge" }), h('div', { class: 'small mono', 'data-testid': 'bridge-review-through', text: `contract ${short(r.ethPipe)}` })]),
        ),
        approvals.length
          ? h(
              'div',
              { 'data-testid': 'bridge-review-approval' },
              notice('info', h('strong', { text: `You sign ${n} Ethereum transactions, one after the other. ` }), `${reset ? `First the bridge's old permission for ${sym} is set to 0 (${sym} asks for that), then it is allowed` : 'First the bridge is allowed'} to take exactly ${coin(q.amount + q.fee, dec, sym)}, then it is sent. ${n === 2 ? 'Both are' : `All ${n} are`} signed with this one confirmation.`),
            )
          : null,
        h('div', { 'data-testid': 'bridge-review-public' }, notice('info', PUBLIC_NOTE)),
        freeze ? h('p', { class: 'small', 'data-testid': 'bridge-review-freeze', text: `${freeze} BEAM Campfire asks Ethereum again right before signing.` }) : null,
        h(
          'div',
          { class: 'sheet-actions' },
          message,
          h('button', { class: 'btn btn-primary wrap', onclick: confirm, disabled: busy, 'data-testid': 'bridge-review-move-btn' }, busy ? 'Moving…' : label),
          h('button', { class: 'btn btn-text', onclick: () => close(false), disabled: busy, 'data-testid': 'bridge-review-change' }, 'Change'),
        ),
      ];
    },
    { label: 'Confirm your move', dismissable: false },
  );
}
