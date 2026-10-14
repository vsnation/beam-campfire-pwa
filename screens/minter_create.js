/* Create a token
 * Spec: ONE job: create a new token of your own on BEAM.
 *       Primary CTA: "Create MYT"; the review then says "Create MYT for 60.0167 BEAM", and the approve
 *       sheet "Pay 60 BEAM and create MYT".
 *       Taps from app open: Tokens (1) -> Create a token (2), name, ticker (and a maximum) ->
 *       "Create MYT" (3) -> "Create MYT for …" (4) -> approve, then Face ID or the password.
 * Exit-intent reasons and answers:
 *   - "How much is this going to cost me?" -> the cost is the first thing on the screen, split into what
 *     goes where (the issuance fee read from the Minter itself, the deposit, the network fee), before any field.
 *   - "What do all these fields mean?" -> three matter (name, ticker, maximum); the rest are optional or
 *     under "More details".
 *   - "I typed something wrong" -> each field says what to fix, in plain words, as you type.
 *   - "Can I change it later?" -> no, and the review says so and shows exactly what is stored on the chain.
 *   - "Why is the button grey?" -> the reason is written right above it (with Receive BEAM when it is money).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, assetBadge } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { VERIFIED, impersonationOf } from '../lib/meta.js';
import { encodeMetadata, fieldProblem, parseSupply, unlimited, ASSET_DEPOSIT, CREATE_FEE, LIMITS, NTH_RATIO } from '../lib/minter.js';
import { minter, problemNotice, pausedReason, forgetOnLock } from './minter.js';
import { t } from '../lib/i18n.js';

const beam = (g) => `${formatAmount(g)} BEAM`;

/** The draft's fields as the metadata rules read them: the unit name is the ticker unless changed. */
function fieldsOf(d) {
  return {
    name: d.name,
    shortName: d.ticker,
    unitName: d.unitEdited ? d.unitName : d.ticker,
    nthUnitName: d.nthUnitName,
    shortDescription: d.shortDescription,
    longDescription: d.longDescription,
    color: d.color,
    siteUrl: d.siteUrl,
  };
}

/** "#25C2A0" for "#25c2a0" or "#2CA": the colour a swatch shows; null when it is not one. */
export function swatchColor(text) {
  const s = String(text || '').trim();
  if (!/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(s)) return null;
  const hex = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1);
  return `#${hex.toUpperCase()}`;
}

/** A small square of colour `c` (set through the style object: the page's policy forbids style attributes). */
function swatchOf(c) {
  const el = h('span', { class: 'swatch inline-swatch', 'aria-hidden': 'true' });
  el.style.setProperty('--swatch', c);
  return el;
}

/** The verified asset a new token named `name` with ticker `ticker` would copy, or null (lib/meta.js rules). */
export function copiesVerified(name, ticker) {
  const n = String(name || '').trim();
  const tick = String(ticker || '').trim();
  if (!n && !tick) return null;
  const id = impersonationOf(n || null, tick || null);
  return id == null ? null : { id, ...VERIFIED[id] };
}

export default function minterCreate(app) {
  forgetOnLock(app);
  const draft = (app.minterDraft = app.minterDraft || { name: '', ticker: '', supply: '', shortDescription: '', color: '', siteUrl: '', unitName: '', unitEdited: false, nthUnitName: 'groth', longDescription: '', more: false, touched: {}, step: 'form' });
  // Coming back (from Receive BEAM, say) keeps what was typed, and opens on the form: the review is one tap on.
  draft.step = 'form';
  let params = null; // { issueFee, daoVaultCid }
  let loadError = null;
  let building = false;
  let result = null; // an error to show
  let done = null; // { ticker, txId }
  let alive = true;

  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions inline-actions' });

  // ------------------------------------------------------------ inputs (built once: typing keeps focus)
  const input = (key, testid, attrs = {}) => {
    const el = h(attrs.tag || 'input', { class: 'input', type: attrs.tag ? null : attrs.type || 'text', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'data-testid': testid, ...attrs, tag: null });
    el.value = draft[key];
    return el;
  };
  // The example name and ticker stay English: a token's name and ticker take English letters only.
  const nameIn = input('name', 'mint-name', { placeholder: 'My Token', 'aria-label': t('Token name') }); // i18n-ignore: an example token name (English letters only)
  const tickerIn = input('ticker', 'mint-ticker', { placeholder: 'MYT', autocapitalize: 'characters', 'aria-label': t('Ticker') }); // i18n-ignore: an example ticker
  const supplyIn = input('supply', 'mint-supply', { placeholder: t('No maximum'), inputmode: 'numeric', 'aria-label': t('Maximum supply') });
  const shortIn = input('shortDescription', 'mint-short-desc', { placeholder: t('What the token is for'), 'aria-label': t('Short description') });
  const colorIn = input('color', 'mint-color', { placeholder: '#25C2A0', autocapitalize: 'characters', 'aria-label': t('Colour') });
  const siteIn = input('siteUrl', 'mint-site', { placeholder: 'https://', type: 'url', inputmode: 'url', 'aria-label': t('Website') }); // i18n-ignore: the start of a web address
  const unitIn = input('unitName', 'mint-unit', { 'aria-label': t('Unit name') });
  const nthIn = input('nthUnitName', 'mint-nth', { 'aria-label': t('Smallest unit name') });
  const longIn = input('longDescription', 'mint-long-desc', { tag: 'textarea', rows: '4', 'aria-label': t('Long description') });
  const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' });

  const hintEl = (testid) => h('p', { class: 'hint', 'data-testid': testid });
  const hints = {
    name: hintEl('mint-name-hint'),
    ticker: hintEl('mint-ticker-hint'),
    supply: hintEl('mint-supply-hint'),
    shortDescription: hintEl('mint-short-desc-hint'),
    color: hintEl('mint-color-hint'),
    siteUrl: hintEl('mint-site-hint'),
    unitName: hintEl('mint-unit-hint'),
    nthUnitName: hintEl('mint-nth-hint'),
    longDescription: hintEl('mint-long-desc-hint'),
  };
  const copyBox = h('div', { 'data-testid': 'mint-copies-box' });
  const costBox = h('div');
  const moreBtn = h('button', { class: 'btn btn-text link-left', type: 'button', 'data-testid': 'mint-more' });
  const moreBox = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'two-fields' }, h('label', { class: 'field' }, t('Unit name'), unitIn, hints.unitName), h('label', { class: 'field' }, t('Smallest unit name'), nthIn, hints.nthUnitName)),
    h('label', { class: 'field' }, t('Long description (optional)'), longIn, hints.longDescription),
  );
  const reason = h('p', { class: 'hint center', 'data-testid': 'mint-reason', 'aria-live': 'polite' });
  const cta = primary(t('Create my token'), () => toReview(), { disabled: true, 'data-testid': 'mint-cta' });

  // ------------------------------------------------------------ state
  const touched = (k) => Boolean(draft.touched[k]);
  const supply = () => parseSupply(draft.supply);

  /** The field's problem once the person has typed in it (an untouched empty field is not an error yet). */
  function problem(k) {
    const f = fieldsOf(draft);
    switch (k) {
      case 'ticker':
        return (touched('ticker') && fieldProblem('shortName', f)) || (!draft.unitEdited && touched('ticker') ? fieldProblem('unitName', f) : null);
      case 'supply':
        return touched('supply') ? supply().error : null;
      case 'unitName':
        return draft.unitEdited ? fieldProblem('unitName', f) : null;
      default:
        return touched(k) ? fieldProblem(k, f) : null;
    }
  }

  function metadataText() {
    try {
      return encodeMetadata(fieldsOf(draft));
    } catch {
      return null;
    }
  }

  const cost = () => (params ? params.issueFee + ASSET_DEPOSIT : null);

  function ctaState() {
    if (!params) return { off: loadError ? t('The Minter could not be read. Try again above.') : t('Reading what creating a token costs…') };
    const text = metadataText();
    if (!draft.name.trim() || !draft.ticker.trim()) return { off: t('Give your token a name and a ticker.') };
    if (!text) {
      const f = fieldsOf(draft);
      for (const k of ['name', 'shortName', 'unitName', 'nthUnitName', 'shortDescription', 'longDescription', 'color', 'siteUrl']) {
        // fieldProblem() already calls the short name "Ticker".
        const p = fieldProblem(k, f);
        const hidden = !draft.more && (['nthUnitName', 'longDescription'].includes(k) || (k === 'unitName' && draft.unitEdited));
        if (p) return { off: hidden ? t('{problem} (under More details)', { problem: p }) : p };
      }
      return { off: t('The token details are too long in total.') };
    }
    if (supply().error) return { off: supply().error };
    const paused = pausedReason('create');
    if (paused) return { off: paused };
    const need = cost() + CREATE_FEE;
    if (wallet.available(0) < need) return { off: t('Creating a token needs {need}, and this wallet has {balance}.', { need: beam(need), balance: beam(wallet.available(0)) }), receive: true };
    return { off: null };
  }

  // ------------------------------------------------------------ the form
  function costCard() {
    const p = params;
    const row = (k, sub, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid, text: v }));
    return h(
      'div',
      { class: 'card flat swap-details', 'data-testid': 'mint-cost' },
      row(t('To the BEAM DAO'), t('Issuance fee'), p ? beam(p.issueFee) : t('Reading…'), 'mint-cost-dao'),
      row(t('Asset deposit'), t('Never returned'), beam(ASSET_DEPOSIT), 'mint-cost-deposit'),
      row(t('Network fee'), null, beam(CREATE_FEE), 'mint-cost-fee'),
      row(t('Creating a token costs'), null, p ? beam(cost() + CREATE_FEE) : '…', 'mint-cost-total'),
    );
  }

  function renderForm() {
    put(
      costBox,
      loadError ? notice('error', h('strong', { text: `${t("The Minter didn't answer.")} ` }), `${t('Nothing was sent.')} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'mint-load-retry', onclick: load }, t('Try again'))) : null,
      costCard(),
    );
    const show = (k, hint) => {
      const p = problem(k);
      hints[k].textContent = p || hint || '';
      hints[k].classList.toggle('bad', Boolean(p));
      return p;
    };
    show('name', '');
    show('ticker', t('Up to {max} characters', { max: LIMITS.shortName }));
    const sp = show('supply', '');
    if (!sp) {
      const s = supply();
      const tick = draft.ticker.trim();
      hints.supply.textContent = s.empty ? t('Optional. Empty: no maximum, mint as much as you like.') : tick ? t('At most {amount} {ticker} can ever exist', { amount: formatAmount(s.limit), ticker: tick }) : t('At most {amount} tokens can ever exist', { amount: formatAmount(s.limit) });
    }
    show('shortDescription', '');
    show('color', '');
    show('siteUrl', '');
    show('unitName', t('Same as the ticker unless you change it'));
    show('nthUnitName', t('1 token = {n} of these', { n: Number(NTH_RATIO).toLocaleString('en-US') }));
    show('longDescription', '');
    unitIn.placeholder = draft.ticker || 'MYT';
    const c = swatchColor(draft.color);
    swatch.classList.toggle('hidden', !c);
    if (c) swatch.style.setProperty('--swatch', c);
    const copied = copiesVerified(draft.name, draft.unitEdited ? draft.unitName : draft.ticker);
    put(copyBox, copied ? notice('warn', t('Wallets will mark your token "Not the verified {symbol}", because {name} already exists. Pick a name and ticker of your own.', { symbol: copied.symbol, name: copied.name })) : null);
    moreBtn.textContent = draft.more ? t('Fewer details') : t('More details');
    moreBox.classList.toggle('hidden', !draft.more);
    const st = ctaState();
    const ticker = draft.ticker.trim();
    cta.disabled = Boolean(st.off);
    cta.textContent = ticker && !fieldProblem('shortName', fieldsOf(draft)) ? t('Create {ticker}', { ticker }) : t('Create my token');
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'mint-receive', onclick: () => app.go('receive') }, t('Receive BEAM')) : null);
    reason.classList.toggle('hidden', !st.off);
    put(actions, reason, cta);
  }

  function formBody() {
    return [
      h('p', { class: 'step', text: t('Step 1 of 2: describe it') }),
      costBox,
      h('label', { class: 'field' }, t('Token name'), nameIn, hints.name),
      h('div', { class: 'two-fields' }, h('label', { class: 'field' }, t('Ticker'), tickerIn, hints.ticker), h('label', { class: 'field' }, t('Maximum supply'), supplyIn, hints.supply)),
      copyBox,
      h('label', { class: 'field' }, t('Short description (optional)'), shortIn, hints.shortDescription),
      h('div', { class: 'two-fields wide-second' }, h('label', { class: 'field' }, t('Colour (optional)'), h('div', { class: 'input-wrap swatch-wrap' }, colorIn, swatch), hints.color), h('label', { class: 'field' }, t('Website (optional)'), siteIn, hints.siteUrl)),
      moreBtn,
      moreBox,
    ];
  }

  // ------------------------------------------------------------ the review
  function reviewBody() {
    const text = metadataText();
    const s = supply();
    const ticker = draft.ticker.trim();
    const p = params;
    const lost = p.issueFee + ASSET_DEPOSIT;
    const preview = { id: -1, name: draft.name, symbol: ticker, unit: ticker, label: ticker, verified: false, icon: null, pool: null, color: null };
    const row = (k, sub, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid, text: v }));
    const c = swatchColor(draft.color);
    const meta = h('pre', { class: 'mono meta-text hidden', 'data-testid': 'review-metadata', text: text });
    const metaBtn = h('button', { class: 'btn btn-text link-left', type: 'button', 'data-testid': 'review-show-metadata' }, t('Show what is stored on the chain'));
    metaBtn.addEventListener('click', () => {
      const open = meta.classList.toggle('hidden') === false;
      metaBtn.textContent = open ? t('Hide what is stored on the chain') : t('Show what is stored on the chain');
    });
    return [
      h('p', { class: 'step', text: t('Step 2 of 2: check it') }),
      h('p', { class: 'lead', text: t('These details are stored on the chain for good: nobody can change them later.') }),
      h(
        'div',
        { class: 'card token-preview', 'data-testid': 'review-token' },
        h('div', { class: 'row asset-row token-title' }, assetBadge(preview), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'review-name', text: draft.name }), h('div', { class: 's', 'data-testid': 'review-ticker', text: t('{ticker} · new token', { ticker }) }))),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Maximum supply') }), h('span', { class: 'v', 'data-testid': 'review-supply', text: s.empty ? t('No maximum') : `${formatAmount(s.limit)} ${ticker}` })),
        fieldsOf(draft).shortDescription ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('Description') }), h('span', { class: 'v plain', text: draft.shortDescription.trim() })) : null,
        c ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Colour') }), h('span', { class: 'v swatch-v', 'data-testid': 'review-color' }, swatchOf(c), c)) : null,
        draft.siteUrl.trim() ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('Website') }), h('span', { class: 'v plain', text: draft.siteUrl.trim() })) : null,
      ),
      h(
        'div',
        { class: 'card flat swap-details', 'data-testid': 'review-cost' },
        row(t('To the BEAM DAO'), t('Issuance fee'), beam(p.issueFee), 'review-dao'),
        row(t('Asset deposit'), t('Never returned'), beam(ASSET_DEPOSIT), 'review-deposit'),
        row(t('Network fee'), null, beam(CREATE_FEE), 'review-fee'),
        row(t('Leaves your wallet'), null, beam(lost + CREATE_FEE), 'review-total'),
      ),
      notice('warn', h('strong', { text: `${t('These {amount} do not come back.', { amount: beam(lost) })} ` }), t('Not even if you never mint the token. Nothing is minted yet: once the token exists, mint it from My tokens.')),
      metaBtn,
      meta,
      result ? problemNotice(result, 'review-result') : null,
    ];
  }

  function renderReview() {
    const ticker = draft.ticker.trim();
    const total = cost() + CREATE_FEE;
    const paused = pausedReason('create');
    const short = wallet.available(0) < total;
    const go = primary(building ? t('Preparing…') : t('Create {ticker} for {amount}', { ticker, amount: beam(total) }), create, { disabled: building || Boolean(paused) || short, 'data-testid': 'review-cta', class: 'btn btn-primary wrap' });
    const why = paused || (short ? t('This needs {need}, and this wallet has {balance}.', { need: beam(total), balance: beam(wallet.available(0)) }) : building ? t('Building the transaction and checking it…') : null);
    put(actions, why ? h('p', { class: 'hint center', 'data-testid': 'review-reason', text: why }) : null, go, h('button', { class: 'btn btn-text', type: 'button', 'data-testid': 'review-change', disabled: building, onclick: () => setStep('form') }, t('Change the details')));
  }

  // ------------------------------------------------------------ done
  function doneBody() {
    return [
      h('div', { class: 'status-icon ok' }, icon('check')),
      h('h2', { class: 'title center', 'data-testid': 'mint-done', text: t('{ticker} is being created', { ticker: done.ticker }) }),
      h('p', { class: 'center small', text: t('It appears in My tokens once the network confirms it, usually within a few minutes. Mint your first tokens there.') }),
    ];
  }

  function setStep(step) {
    draft.step = step;
    result = null;
    window.scrollTo(0, 0);
    render(true);
  }

  let shown = null;
  function render(rebuild = false) {
    if (!alive) return;
    const step = done ? 'done' : draft.step === 'review' && params && metadataText() ? 'review' : 'form';
    if (rebuild || step !== shown) {
      shown = step;
      title.textContent = step === 'done' ? t('Create a token') : step === 'review' ? t('Check your token') : t('Create a token');
      if (step === 'form') put(body, ...formBody());
      else if (step === 'review') put(body, ...reviewBody());
      else put(body, ...doneBody());
    }
    if (step === 'form') renderForm();
    else if (step === 'review') renderReview();
    else put(actions, primary(t('Go to My tokens'), () => app.go('minterTokens', {}, { replace: true }), { 'data-testid': 'mint-done-tokens' }), h('button', { class: 'btn btn-text', onclick: () => app.go('home') }, t('Done')));
  }

  function toReview() {
    if (ctaState().off) return;
    setStep('review');
  }

  async function create() {
    if (building) return;
    const text = metadataText();
    const s = supply();
    if (!text || s.error || !params) return setStep('form');
    building = true;
    result = null;
    render(true);
    const ticker = draft.ticker.trim();
    try {
      const r = await minter().createToken({ metadata: text, limit: s.limit, ticker });
      if (!alive) return;
      app.minterPending = [...(app.minterPending || []), { txId: r.txId, ticker, name: draft.name.trim(), at: Date.now() }];
      app.minterDraft = null;
      done = { ticker, txId: r.txId };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      result = e;
    }
    building = false;
    render(true);
  }

  async function load() {
    loadError = null;
    render();
    try {
      params = await minter().params();
    } catch (e) {
      loadError = e;
    }
    render();
  }

  // ------------------------------------------------------------ typing
  const bind = (el, key, { upper = false, after = null } = {}) =>
    el.addEventListener('input', () => {
      if (upper) {
        const at = el.selectionStart;
        const up = el.value.toUpperCase();
        if (up !== el.value) {
          el.value = up;
          try {
            el.setSelectionRange(at, at);
          } catch {
            /* not a text field */
          }
        }
      }
      draft[key] = el.value;
      draft.touched[key] = true;
      if (after) after();
      render();
    });
  bind(nameIn, 'name');
  bind(tickerIn, 'ticker', { upper: true, after: () => (draft.touched.unitName = true) });
  bind(supplyIn, 'supply');
  bind(shortIn, 'shortDescription');
  bind(colorIn, 'color', { upper: true });
  bind(siteIn, 'siteUrl');
  bind(unitIn, 'unitName', { after: () => (draft.unitEdited = unitIn.value !== '') });
  bind(nthIn, 'nthUnitName');
  bind(longIn, 'longDescription');
  moreBtn.addEventListener('click', () => {
    draft.more = !draft.more;
    render();
  });
  const off = wallet.onChange(() => render());

  const el = screen(
    {
      title: t('Create a token'),
      back: () => {
        if (!done && draft.step === 'review' && !building) return setStep('form');
        // Leaving the feature forgets the draft (Receive BEAM and back keeps it).
        if (!building) app.minterDraft = null;
        app.back('home');
      },
      cls: 'minter-create feature sticky-actions',
    },
    body,
  );
  const title = el.querySelector('.topbar h1');
  el.appendChild(actions);
  render(true);
  load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
