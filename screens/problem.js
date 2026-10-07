/* Problem: this browser can't run the wallet / this copy failed its signature check
 * Spec: ONE job: say why the wallet can't open here and what to do instead.
 *       Primary CTA: "Try again" (reload).
 *       Taps from app open: 0.
 * Exit-intent reasons and answers:
 *   - "Is it broken?" -> names the exact missing feature or the failed check.
 *   - "What now?" -> the browser/OS that works, or to reload later / use the official address.
 */
import { h } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';

export default function problem(app, p = {}) {
  const integrity = p.kind === 'integrity';
  const el = screen(
    { title: integrity ? 'Security check failed' : "This browser can't run BEAM Campfire", actions: [primary('Try again', () => location.reload())] },
    integrity
      ? notice('error', p.detail || 'This copy of BEAM Campfire did not pass its signature check.', " Don't enter your 12 words here. Reload later, or open BEAM Campfire from its official address.")
      : notice('warn', `Missing: ${(p.detail || []).join(', ')}.`),
    integrity
      ? null
      : h('p', { class: 'lead', text: 'BEAM Campfire needs Safari on iOS 16.4 or newer (or a current Chrome, Edge or Firefox), opened over HTTPS from its own address. Private browsing can also block what the wallet needs.' }),
  );
  return { el };
}
