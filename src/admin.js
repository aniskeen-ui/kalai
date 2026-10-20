// Studio desk: list every enquiry, view uploads, set price / payment link / status / message.
import './amplify-config.js';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  RECEIVED: 'Received', PRICE_SENT: 'Price sent', PAID: 'Paid', FRAMING: 'Being framed',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};
const KIND = { PRICE: 'Price', COMMISSION: 'Commission', GIFT: 'Little Artists' };
// Once Zoho holds the payment the enquiry can't go back to these (reverse it in Zoho, then Check Zoho).
const BEFORE_PAYMENT = ['RECEIVED', 'PRICE_SENT', 'CANCELLED'];
const ZOHO_LABEL = { QUOTED: 'Quote in Zoho', PAID: 'Paid in Zoho', ERROR: 'Zoho error', REVERSED: 'Reversed in Zoho', NONE: 'Not in Zoho', TEST: 'Test mode: drafts only' };
const isLocked = (e) => !!e.zohoPaymentId;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STUDIO_WHATSAPP_NAME = 'Kalai Art House';

// ---------- master rates and the cost calculator ----------
// Placeholders until the real frame shop and courier quotes are saved under "Rates".
const DEFAULT_RATES = {
  tiers: {
    S: { label: 'Up to A4 (21×30 cm)', framing: 90, courier: 45 },
    M: { label: 'A3 / 38×28 cm', framing: 140, courier: 65 },
    L: { label: '50×70 cm', framing: 220, courier: 110 },
  },
  local: 30, customs: 0.05, fee: 0.03, margin: 0.25, vat: 0, fx: 0.042, round9: true, saved: false,
};
let rates = structuredClone(DEFAULT_RATES);
const costings = new Map(); // enquiryId → Costing record
const hasArtist = (e) => e.kind === 'PRICE' || e.kind === 'COMMISSION';
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const aed = (v, d = 0) => (v == null ? '–' : 'AED ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Cost build-up for one enquiry, the suggested price and the margin at a given price. */
function calc(c, price) {
  const tier = rates.tiers[c.sizeTier] || null;
  const artistAed = c.artistPriceInr ? c.artistPriceInr * rates.fx : null;
  const framing = c.framingOverride ?? tier?.framing ?? null;
  const indiaCourier = c.indiaCourierOverride ?? tier?.courier ?? null;
  const localCourier = c.localCourierOverride ?? rates.local;
  const vat = c.delivery === 'OUTSIDE' ? 0 : rates.vat;
  if (artistAed == null || framing == null || indiaCourier == null) {
    return { artistAed, framing, indiaCourier, localCourier, ready: false };
  }
  const customs = (artistAed + indiaCourier) * rates.customs;
  const total = artistAed + framing + indiaCourier + customs + localCourier;
  const raw = (total * (1 + rates.margin)) / (1 / (1 + vat) - rates.fee);
  const suggested = rates.round9 ? Math.ceil((raw + 1) / 10) * 10 - 1 : Math.round(raw);
  const out = { artistAed, framing, indiaCourier, localCourier, customs, total, suggested, vatRate: vat, ready: true };
  if (price > 0) {
    out.price = price;
    out.vatAmt = price - price / (1 + vat);
    out.feeAmt = price * rates.fee;
    out.margin = price - out.vatAmt - out.feeAmt - total;
    out.marginPct = out.margin / (price - out.vatAmt);
  }
  return out;
}

async function loadRates() {
  try {
    const { data } = await client.models.Rates.get({ key: 'default' });
    const d = data?.data ? (typeof data.data === 'string' ? JSON.parse(data.data) : data.data) : null;
    if (d) rates = { ...structuredClone(DEFAULT_RATES), ...d, tiers: { ...DEFAULT_RATES.tiers, ...(d.tiers || {}) }, saved: true };
  } catch { /* keep placeholders */ }
}
async function loadCostings() {
  costings.clear();
  let nextToken = null;
  do {
    const res = await client.models.Costing.list({ limit: 500, nextToken });
    (res.data || []).forEach((c) => costings.set(c.enquiryId, c));
    nextToken = res.nextToken;
  } while (nextToken);
}

let all = [];
let selectedId = null;

Object.entries(STATUS).forEach(([k, v]) => $('fStatus').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`));

function show(view) {
  ['loginView', 'denyView', 'deskView'].forEach((v) => { $(v).hidden = v !== view; });
  $('signOutBtn').hidden = view === 'loginView';
}

async function start() {
  try {
    await getCurrentUser();
  } catch {
    show('loginView'); $('lEmail').focus(); return;
  }
  const attrs = await fetchUserAttributes().catch(() => ({}));
  $('who').textContent = attrs.email || '';
  const session = await fetchAuthSession();
  const groups = session.tokens?.accessToken?.payload?.['cognito:groups'] || [];
  if (!groups.includes('ADMINS')) { show('denyView'); return; }
  show('deskView');
  await loadRates();
  await load();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = e.target.querySelector('button'); b.disabled = true; $('loginErr').textContent = '';
  try {
    const { nextStep } = await signIn({ username: $('lEmail').value.trim().toLowerCase(), password: $('lPass').value });
    if (nextStep.signInStep !== 'DONE') throw new Error('Finish setting up this account on the main site first (step: ' + nextStep.signInStep + ').');
    await start();
  } catch (ex) {
    $('loginErr').textContent = ex.name === 'NotAuthorizedException' || ex.name === 'UserNotFoundException' ? 'Email or password is incorrect.' : (ex.message || 'Sign-in failed.');
  } finally { b.disabled = false; }
});
$('signOutBtn').onclick = async () => { await signOut(); $('who').textContent = ''; show('loginView'); };
$('reload').onclick = load;
$('ratesBtn').onclick = () => { selectedId = null; render(); showRates(); };
$('fStatus').onchange = render;
$('fKind').onchange = render;

async function load() {
  $('rows').innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const items = [];
    let nextToken = null;
    do {
      const res = await client.models.Enquiry.list({ limit: 200, nextToken });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      items.push(...res.data);
      nextToken = res.nextToken;
    } while (nextToken);
    all = items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    await loadCostings().catch(() => {});
    render();
    if (selectedId) { const e = all.find((x) => x.id === selectedId); if (e) showDetail(e); }
  } catch (ex) {
    $('rows').innerHTML = `<tr><td colspan="7" class="err">Could not load enquiries: ${esc(ex.message)}</td></tr>`;
  }
}

function render() {
  const fs = $('fStatus').value, fk = $('fKind').value;
  const counts = {};
  all.forEach((e) => { const s = e.status || 'RECEIVED'; counts[s] = (counts[s] || 0) + 1; });
  $('counts').innerHTML = Object.keys(STATUS).filter((k) => counts[k])
    .map((k) => `<span class="count">${STATUS[k]} <b>${counts[k]}</b></span>`).join('') || '<span class="muted">No enquiries yet.</span>';
  const list = all.filter((e) => (!fs || (e.status || 'RECEIVED') === fs) && (!fk || e.kind === fk));
  $('rows').innerHTML = list.length ? list.map((e) => {
    const s = e.status || 'RECEIVED';
    const d = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
    return `<tr data-id="${esc(e.id)}" tabindex="0" class="${e.id === selectedId ? 'sel' : ''}">
      <td>${esc(d)}</td><td class="mono">${esc(e.ref)}</td><td>${esc(KIND[e.kind] || '')}</td>
      <td style="white-space:normal;min-width:180px">${esc(e.title)}</td><td>${esc(e.customerName)}</td>
      <td><span class="pill ${s}">${esc(STATUS[s] || s)}</span>${hasArtist(e) && !costings.get(e.id)?.artistPriceInr && !['CANCELLED', 'DELIVERED'].includes(s) ? ' <span class="chip" title="Siva hasn\'t priced this yet">Artist price needed</span>' : ''}${isLocked(e) ? ' <span title="Payment recorded in Zoho" aria-label="Payment recorded in Zoho">🔒</span>' : e.zohoState === 'ERROR' ? ' <span title="Zoho error" aria-label="Zoho error" style="color:var(--kumkum)">⚠</span>' : ''}</td>
      <td class="mono">${e.quotedPrice ? 'AED ' + Number(e.quotedPrice).toLocaleString('en-US') : '–'}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">Nothing matches this filter.</td></tr>';
  $('rows').querySelectorAll('tr[data-id]').forEach((tr) => {
    const pick = () => { const e = all.find((x) => x.id === tr.dataset.id); if (e) { selectedId = e.id; render(); showDetail(e); } };
    tr.onclick = pick;
    tr.onkeydown = (ev) => { if (ev.key === 'Enter') pick(); };
  });
}

function parseDetails(d) {
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { const v = JSON.parse(d); return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; }
}
const waDigits = (p) => String(p || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(?=5)/, '971');

function costingSection(e) {
  if (!hasArtist(e)) return '';
  const c = costings.get(e.id) || {};
  const lockedPO = !!e.zohoPOId;
  const dis = lockedPO ? 'disabled' : '';
  const tierOpts = Object.entries(rates.tiers).map(([k, t]) => `<option value="${k}" ${c.sizeTier === k ? 'selected' : ''}>${k} · ${esc(t.label)}</option>`).join('');
  const fromSiva = c.artistAt
    ? `From Siva ${esc(when(c.artistAt))}${c.artistReadyBy ? ` · ready by ${esc(c.artistReadyBy)}` : ''}${c.artistNote ? ` · “${esc(c.artistNote)}”` : ''}`
    : 'Siva hasn\'t priced this yet (Artist desk). You can also type his price here.';
  return `<fieldset class="cost" id="costing">
    <legend>Costing ${lockedPO ? `<span class="muted">· locked by ${esc(e.zohoPO)}</span>` : ''}</legend>
    ${rates.saved ? '' : '<div class="muted warnline">Rates are placeholders. Set the real ones under <b>Rates</b>.</div>'}
    <div class="three">
      <div class="field"><label for="cInr">Artist price (INR)</label><input id="cInr" type="number" min="0" step="1" value="${c.artistPriceInr ?? ''}" ${dis}></div>
      <div class="field"><label for="cTier">Size tier</label><select id="cTier" ${dis}><option value="">Choose…</option>${tierOpts}</select></div>
      <div class="field"><label for="cDel">Delivery</label><select id="cDel" ${dis}><option value="UAE" ${c.delivery !== 'OUTSIDE' ? 'selected' : ''}>UAE</option><option value="OUTSIDE" ${c.delivery === 'OUTSIDE' ? 'selected' : ''}>Outside UAE</option></select></div>
    </div>
    <div class="muted" style="font-size:12px">${fromSiva}</div>
    <details ${c.framingOverride != null || c.indiaCourierOverride != null || c.localCourierOverride != null ? 'open' : ''}><summary>Overrides for this order (premium frame, oversized, abroad)</summary>
      <div class="three" style="margin-top:8px">
        <div class="field"><label for="cFr">Framing (AED)</label><input id="cFr" type="number" min="0" step="1" value="${c.framingOverride ?? ''}" ${dis}></div>
        <div class="field"><label for="cIc">India courier (AED)</label><input id="cIc" type="number" min="0" step="1" value="${c.indiaCourierOverride ?? ''}" ${dis}></div>
        <div class="field"><label for="cLc">Local courier (AED)</label><input id="cLc" type="number" min="0" step="1" value="${c.localCourierOverride ?? ''}" ${dis}></div>
      </div>
    </details>
    <div id="costOut"></div>
  </fieldset>`;
}

function purchaseSection(e) {
  if (!hasArtist(e) || !(isLocked(e) || e.zohoState === 'TEST')) return '';
  const st = e.purchaseState || '';
  const color = st === 'ARTIST_PAID' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : 'var(--muted)';
  return `<fieldset class="cost" id="purchase">
    <legend>Siva Raja (purchase)</legend>
    <div style="font-size:14px;color:${color};overflow-wrap:anywhere">${esc(e.purchaseMessage || 'The PO is created once the order is paid and the costing has Siva\'s price.')}</div>
    <div class="two">
      <div class="field"><label for="pInv">Siva's invoice no.</label><input id="pInv" value="${esc(e.artistInvoiceNo)}" placeholder="From his invoice" ${!e.zohoPOId || e.zohoBillId ? 'disabled' : ''}></div>
      <div class="field"><label for="pPaid">Paid to Siva: bank ref</label><input id="pPaid" value="${esc(e.artistPaidRef)}" placeholder="Transfer reference" ${!e.zohoPOId || e.zohoVendorPaymentId ? 'disabled' : ''}></div>
    </div>
    <div class="muted" style="font-size:12px">Save with his invoice number to turn the PO into a bill in Zoho; save with your bank reference to record the payment to him.</div>
  </fieldset>`;
}

function readCosting() {
  return {
    artistPriceInr: n($('cInr')?.value),
    sizeTier: $('cTier')?.value || null,
    delivery: $('cDel')?.value || 'UAE',
    framingOverride: n($('cFr')?.value),
    indiaCourierOverride: n($('cIc')?.value),
    localCourierOverride: n($('cLc')?.value),
  };
}

function renderCost() {
  if (!$('costOut')) return;
  const r = calc(readCosting(), n($('ePrice').value));
  const row = (k, v, note = '') => `<tr><td>${k}</td><td class="mono num">${v}</td><td class="muted">${note}</td></tr>`;
  const t = rates.tiers[$('cTier').value];
  let html = `<table class="costs"><tbody>
    ${row('Artist', aed(r.artistAed), r.artistAed != null ? `INR ${Number($('cInr').value).toLocaleString('en-IN')} × ${rates.fx}` : 'needs Siva\'s price')}
    ${row('Framing', aed(r.framing), $('cFr').value ? 'override' : t ? `master ${$('cTier').value}` : 'choose a size tier')}
    ${row('India courier', aed(r.indiaCourier), $('cIc').value ? 'override' : t ? `master ${$('cTier').value}` : '')}
    ${r.ready ? row('Customs', aed(r.customs, 2), `${(rates.customs * 100).toFixed(1)}% of artist + courier`) : ''}
    ${row('Local courier', aed(r.localCourier), $('cLc').value ? 'override' : 'master')}
    ${r.ready ? `<tr class="tot"><td>Total cost</td><td class="mono num">${aed(r.total)}</td><td></td></tr>` : ''}
  </tbody></table>`;
  if (r.ready) {
    html += `<div class="suggest"><span>Suggested price <b class="mono">${aed(r.suggested)}</b> <span class="muted">(${(rates.margin * 100).toFixed(0)}% margin${r.vatRate ? ', VAT incl.' : ''}${rates.fee ? ', after Ziina fee' : ''})</span></span>
      ${$('ePrice').readOnly ? '' : '<button type="button" class="btn small" id="useSug">Use this price</button>'}</div>`;
    if (r.price) {
      const low = r.marginPct < 0.1;
      html += `<div class="marginline ${low ? 'low' : ''}">At ${aed(r.price)}: ${r.vatRate ? `VAT ${aed(r.vatAmt, 2)} · ` : ''}Ziina fee ${aed(r.feeAmt, 2)} · <b>margin ${aed(r.margin)} (${(r.marginPct * 100).toFixed(1)}%)</b>${low ? ' · below 10%' : ''}</div>`;
    }
  }
  $('costOut').innerHTML = html;
  const b = $('useSug');
  if (b) b.onclick = () => { $('ePrice').value = r.suggested; $('ePrice').dispatchEvent(new Event('input')); };
}

async function saveCosting(e) {
  const inp = readCosting();
  const r = calc(inp, n($('ePrice').value));
  const costs = {
    artistInr: inp.artistPriceInr, fx: rates.fx, artistAed: r.artistAed != null ? Math.round(r.artistAed * 100) / 100 : null,
    framing: r.framing, indiaCourier: r.indiaCourier, localCourier: r.localCourier,
    customs: r.customs != null ? Math.round(r.customs * 100) / 100 : null, total: r.total ?? null, suggested: r.suggested ?? null,
    price: r.price ?? null, margin: r.margin != null ? Math.round(r.margin * 100) / 100 : null, savedAt: new Date().toISOString(),
  };
  const rec = { enquiryId: e.id, ...inp, costs: JSON.stringify(costs) };
  const existing = costings.get(e.id);
  const res = existing ? await client.models.Costing.update(rec) : await client.models.Costing.create(rec);
  if (res.errors?.length) throw new Error(res.errors[0].message);
  costings.set(e.id, res.data || { ...existing, ...rec });
}

function showRates() {
  const t = rates.tiers;
  const tierRow = (k) => `<tr><th>${k}</th>
    <td><input id="rL${k}" value="${esc(t[k].label)}" aria-label="${k} sizes"></td>
    <td><input id="rF${k}" type="number" min="0" step="1" value="${t[k].framing}" aria-label="${k} framing"></td>
    <td><input id="rC${k}" type="number" min="0" step="1" value="${t[k].courier}" aria-label="${k} India courier"></td></tr>`;
  const pct = (id, label, v, note) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" min="0" step="0.1" value="${+(v * 100).toFixed(2)}"><span class="muted" style="font-size:12px">${note}</span></div>`;
  $('detail').innerHTML = `
    <div><h2 style="font-size:22px">Rates</h2><p class="muted" style="margin:4px 0 0">Master costs used for every price. Only Siva's price changes per order; use the overrides on an enquiry for exceptions.</p></div>
    ${rates.saved ? '' : '<div class="muted warnline">These are placeholders. Replace them with the frame shop and courier quotes, then save.</div>'}
    <form id="ratesForm" novalidate style="display:grid;gap:12px">
      <div class="tablewrap"><table class="costs"><thead><tr><th>Tier</th><th>Paper sizes</th><th>Framing (AED)</th><th>India courier (AED)</th></tr></thead>
        <tbody>${Object.keys(t).map(tierRow).join('')}</tbody></table></div>
      <div class="two">
        <div class="field"><label for="rLocal">Local courier (AED)</label><input id="rLocal" type="number" min="0" step="1" value="${rates.local}"></div>
        <div class="field"><label for="rFx">Exchange rate (AED per INR)</label><input id="rFx" type="number" min="0" step="0.0001" value="${rates.fx}"></div>
        ${pct('rCus', 'Customs (%)', rates.customs, 'of artist price + India courier')}
        ${pct('rFee', 'Ziina fee (%)', rates.fee, 'of what the customer pays')}
        ${pct('rMar', 'Pranix margin (%)', rates.margin, 'markup on total cost')}
        ${pct('rVat', 'VAT (%)', rates.vat, '0 until registered, then 5')}
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="rRound" style="width:auto" ${rates.round9 ? 'checked' : ''}> Round suggested prices up to end in 9</label>
      <div class="ok" id="ratesMsg" role="status"></div>
      <button class="btn" type="submit">Save rates</button>
    </form>`;
  $('ratesForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button'); b.disabled = true; $('ratesMsg').textContent = '';
    $('detail').querySelectorAll('.err').forEach((x) => x.remove());
    const tiers = {};
    Object.keys(t).forEach((k) => { tiers[k] = { label: $('rL' + k).value.trim(), framing: n($('rF' + k).value) ?? 0, courier: n($('rC' + k).value) ?? 0 }; });
    const data = { tiers, local: n($('rLocal').value) ?? 0, fx: n($('rFx').value) ?? 0,
      customs: (n($('rCus').value) ?? 0) / 100, fee: (n($('rFee').value) ?? 0) / 100, margin: (n($('rMar').value) ?? 0) / 100,
      vat: (n($('rVat').value) ?? 0) / 100, round9: $('rRound').checked, updatedAt: new Date().toISOString() };
    try {
      const rec = { key: 'default', data: JSON.stringify(data) };
      let res = rates.saved ? await client.models.Rates.update(rec) : await client.models.Rates.create(rec);
      if (res.errors?.length && !rates.saved) res = await client.models.Rates.update(rec);
      if (res.errors?.length) throw new Error(res.errors[0].message);
      rates = { ...data, saved: true };
      $('ratesMsg').textContent = 'Rates saved. New prices use them straight away.';
      showRates(); $('ratesMsg').textContent = 'Rates saved. New prices use them straight away.';
    } catch (ex) {
      $('ratesMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save rates: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

function zohoPanel(e) {
  const st = e.zohoState || '';
  const color = st === 'PAID' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : st === 'TEST' ? 'var(--gold)' : 'var(--muted)';
  const icon = st === 'PAID' ? '✓' : st === 'ERROR' ? '✗' : st === 'TEST' ? '◌' : '•';
  return `<div class="card" style="padding:12px 14px;display:grid;gap:6px;background:var(--sunk)">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b style="color:${color}">${icon} ${esc(ZOHO_LABEL[st] || 'Zoho Books')}</b>
      <span class="muted" style="font-size:12px;margin-right:auto">${esc(when(e.zohoAt))}</span>
      <button type="button" class="btn" id="checkZoho" style="padding:6px 12px;font-size:13px">Check Zoho</button>
    </div>
    <div style="font-size:14px;overflow-wrap:anywhere">${esc(e.zohoMessage || 'No reply from Zoho yet. Press Check Zoho to look it up.')}</div>
    ${isLocked(e) ? `<div class="muted" style="font-size:12px">🔒 Locked: the payment is in Zoho, so the price can't change and the status can't go back to Received, Price sent or Cancelled. If the payment failed, void invoice ${esc(e.zohoInvoice || '')} or delete its payment in Zoho, then press <b>Check Zoho</b> to unlock.</div>` : ''}
    <div class="ok" id="zohoMsg" role="status"></div>
  </div>`;
}

async function refreshOne(id) {
  const { data } = await client.models.Enquiry.get({ id });
  if (!data) return null;
  const i = all.findIndex((x) => x.id === id);
  if (i >= 0) all[i] = data; else all.push(data);
  render();
  if (selectedId === id) showDetail(data);
  return data;
}

// After a save, Zoho answers within a few seconds: watch for the reply and show it.
async function waitForZoho(id, since) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    if (selectedId !== id) return;
    const { data } = await client.models.Enquiry.get({ id });
    if (data && data.zohoAt && data.zohoAt > since) { await refreshOne(id); return; }
  }
}

async function showDetail(e) {
  const det = parseDetails(e.details);
  const s = e.status || 'RECEIVED';
  const locked = isLocked(e);
  $('detail').innerHTML = `
    <div><div class="muted" style="font-family:var(--mono);font-size:13px">${esc(e.ref)} · ${esc(KIND[e.kind] || '')}</div>
    <h2 style="font-size:22px;margin-top:4px">${esc(e.title)}</h2></div>
    <dl class="kv">
      <dt>Customer</dt><dd>${esc(e.customerName)}</dd>
      <dt>Email</dt><dd>${esc(e.email)}</dd>
      ${Object.entries(det).filter(([k, v]) => v !== '' && v != null && !['Reference', 'Name', 'Mobile', 'Parent'].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
    <div class="links" id="fileLinks">${e.fileKey ? '<span class="muted">Loading upload…</span>' : '<span class="muted">No upload attached.</span>'}</div>
    ${zohoPanel(e)}
    <form id="editForm" novalidate style="display:grid;gap:12px">
      <div class="field"><label for="ePhone">Customer mobile / WhatsApp</label><input id="ePhone" type="tel" inputmode="tel" placeholder="+971 50 123 4567" value="${esc(e.phone)}">
        <span class="muted" style="font-size:12px">Correct it here if the customer typed it wrongly, then save.</span></div>
      <div class="two">
        <div class="field"><label for="eStatus">Status</label><select id="eStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''} ${locked && BEFORE_PAYMENT.includes(k) && k !== s ? 'disabled' : ''}>${v}${locked && BEFORE_PAYMENT.includes(k) && k !== s ? ' (locked)' : ''}</option>`).join('')}</select></div>
        <div class="field"><label for="ePrice">Price (AED)</label><input id="ePrice" type="number" min="0" step="1" value="${e.quotedPrice ?? ''}" ${locked ? 'readonly title="Locked: payment recorded in Zoho"' : ''}></div>
      </div>
      ${costingSection(e)}
      <div class="two">
        <div class="field"><label for="ePayMethod">Paid by</label><select id="ePayMethod">
          ${[['', '–'], ['ZIINA', 'Ziina'], ['BANK', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card (other)'], ['OTHER', 'Other']].map(([k, v]) => `<option value="${k}" ${k === (e.paymentMethod || '') ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label for="ePayRef">Payment reference</label><input id="ePayRef" placeholder="Ziina / bank transaction ID" value="${esc(e.paymentRef)}"></div>
      </div>
      <div class="muted" style="font-size:12px">Prices include VAT where it applies. When you save with status <b>Paid</b>, Zoho Books creates the invoice (KAH-INV-…) and records the payment automatically${hasArtist(e) ? ', then raises the purchase order to Siva' : ''}.</div>
      ${purchaseSection(e)}
      <div class="field"><label for="eLink">Payment link</label><input id="eLink" type="url" placeholder="https://… from Telr, Tap or Stripe" value="${esc(e.paymentLink)}"></div>
      <div class="field"><label for="eMsg">Message to customer</label><textarea id="eMsg" rows="3" placeholder="Available. Framed in teak, delivered by Thursday.">${esc(e.adminMessage)}</textarea></div>
      <div class="ok" id="saveMsg" role="status"></div>
      <button class="btn" type="submit">Save and update customer</button>
    </form>
    <div class="links" id="waLinks"></div>`;

  const waLink = () => {
    const digits = waDigits($('ePhone').value);
    if (!digits) { $('waLinks').innerHTML = '<span class="muted">No mobile number to message.</span>'; return; }
    const price = $('ePrice').value, link = $('eLink').value.trim(), msg = $('eMsg').value.trim();
    const text = [`Hello ${e.customerName || ''}, this is ${STUDIO_WHATSAPP_NAME} about your enquiry ${e.ref} (${e.title}).`,
      price ? `Price: AED ${price}` : '', msg, link ? `Pay securely here: ${link}` : '',
      'You can also track it under My enquiries on art.pranixtechno.com'].filter(Boolean).join('\n');
    $('waLinks').innerHTML = `<a href="https://wa.me/${digits}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send update on WhatsApp</a>`;
  };
  waLink();
  ['ePhone', 'ePrice', 'eLink', 'eMsg'].forEach((id) => $(id).addEventListener('input', waLink));
  if ($('costOut')) {
    renderCost();
    ['cInr', 'cTier', 'cDel', 'cFr', 'cIc', 'cLc', 'ePrice'].forEach((id) => { $(id).addEventListener('input', renderCost); $(id).addEventListener('change', renderCost); });
  }

  if (e.fileKey) {
    try {
      const { url } = await getUrl({ path: e.fileKey, options: { expiresIn: 900 } });
      $('fileLinks').innerHTML = `<a href="${esc(url.toString())}" target="_blank" rel="noopener">Open uploaded photo</a><span class="muted">Link works for 15 minutes.</span>`;
    } catch (ex) {
      $('fileLinks').innerHTML = `<span class="err">Could not open the upload: ${esc(ex.message)}</span>`;
    }
  }

  $('checkZoho').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true; $('zohoMsg').textContent = 'Checking Zoho…';
    try {
      const { errors } = await client.mutations.checkZoho({ id: e.id });
      if (errors?.length) throw new Error(errors[0].message);
      await refreshOne(e.id);
    } catch (ex) {
      $('zohoMsg').textContent = '';
      $('zohoMsg').insertAdjacentHTML('afterend', `<div class="err">Could not check Zoho: ${esc(ex.message)}</div>`);
      b.disabled = false;
    }
  };

  $('editForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button'); b.disabled = true; $('saveMsg').textContent = '';
    $('detail').querySelectorAll('.err').forEach((x) => x.remove());
    const priceVal = $('ePrice').value.trim();
    if ($('eStatus').value === 'PAID' && (!priceVal || Number(priceVal) <= 0)) {
      $('saveMsg').textContent = '';
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">Set the price before marking it Paid, so the Zoho invoice has the right amount.</div>');
      b.disabled = false; return;
    }
    if ($('eStatus').value === 'PAID' && !$('ePayMethod').value) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">Choose how it was paid (Ziina, bank transfer…) before marking it Paid.</div>');
      b.disabled = false; return;
    }
    if (locked && BEFORE_PAYMENT.includes($('eStatus').value) && $('eStatus').value !== s) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">Locked: reverse the payment in Zoho first, then press Check Zoho.</div>');
      b.disabled = false; return;
    }
    const savedAt = new Date().toISOString();
    const invNo = $('pInv') && !$('pInv').disabled ? $('pInv').value.trim() : null;
    const paidRef = $('pPaid') && !$('pPaid').disabled ? $('pPaid').value.trim() : null;
    const costingChanged = $('costing') && !e.zohoPOId;
    const toZoho = (!locked && (($('eStatus').value === 'PAID' && s !== 'PAID') || (priceVal !== '' && Number(priceVal) !== Number(e.quotedPrice ?? NaN))))
      || (locked && hasArtist(e) && (!e.zohoPOId || (invNo && invNo !== (e.artistInvoiceNo || '')) || (paidRef && paidRef !== (e.artistPaidRef || ''))));
    try {
      if (costingChanged) await saveCosting(e);
      const { data, errors } = await client.models.Enquiry.update({
        ...(costingChanged ? { costingAt: savedAt } : {}),
        ...(invNo != null ? { artistInvoiceNo: invNo || null } : {}),
        ...(paidRef != null ? { artistPaidRef: paidRef || null } : {}),
        id: e.id,
        phone: $('ePhone').value.trim() || null,
        status: $('eStatus').value,
        paymentMethod: $('ePayMethod').value || null,
        paymentRef: $('ePayRef').value.trim() || null,
        ...(locked ? {} : { quotedPrice: priceVal === '' ? null : Number(priceVal) }),
        paymentLink: $('eLink').value.trim() || null,
        adminMessage: $('eMsg').value.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(e, data || {});
      $('saveMsg').textContent = $('eStatus').value === 'PAID' && s !== 'PAID' && !locked ? 'Saved as Paid. Waiting for Zoho to create the invoice and record the payment…' : 'Saved. The customer sees this under My enquiries. Use the WhatsApp link to let them know.';
      render();
      if (toZoho) waitForZoho(e.id, savedAt);
    } catch (ex) {
      $('saveMsg').textContent = '';
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

start();
