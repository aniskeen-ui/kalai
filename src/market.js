// Sellers tab (Order Management): approve sellers (commission % + Kalai delivery fee) and approve their listings.
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (n) => 'AED ' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const r2 = (n) => Math.round(n * 100) / 100;
const SST = { APPLIED: 'New application', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended' };
const LST = { DRAFT: 'Draft', SUBMITTED: 'To approve', APPROVED: 'Live', REJECTED: 'Changes asked', PAUSED: 'Paused' };

let wired = false;
let view = 'queue';
let sellers = [];
let listings = [];
const urls = new Map();

// Default commission % for a seller not yet approved: Rates → Kalai margin by category → Crafts shop.
let DEF_PCT = 15;
async function loadDefPct() {
  try { const r = await client.models.Rates.get({ key: 'default' }); const d = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : null; if (d?.margins?.market != null) DEF_PCT = Math.round(d.margins.market * 1000) / 10; } catch { /* keep 15 */ }
}
export async function showMarket() {
  await loadDefPct();
  if (!wired) {
    wired = true;
    $('mkReload').onclick = load;
    document.querySelectorAll('[data-mk]').forEach((b) => {
      b.onclick = () => { view = b.dataset.mk; document.querySelectorAll('[data-mk]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); };
    });
  }
  await load();
}

async function listAll(model) {
  const out = []; let nextToken;
  do {
    const r = await client.models[model].list({ limit: 500, nextToken });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    out.push(...r.data); nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

async function load() {
  $('mkBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    [sellers, listings] = await Promise.all([listAll('SellerProfile'), listAll('Listing')]);
    const n = sellers.filter((s) => s.status === 'APPLIED').length + listings.filter((l) => l.status === 'SUBMITTED').length;
    $('tabSellers').textContent = n ? `Artists & sellers (${n})` : 'Artists & sellers';
    draw();
  } catch (ex) { $('mkBody').innerHTML = `<p class="err">Could not load: ${esc(ex.message)}</p>`; }
}

async function act(action, data) {
  const r = await client.mutations.marketAdmin({ action, data: JSON.stringify(data) });
  if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}

function priceOf(l, pct, fee) {
  const markup = r2(Number(l.costPrice || 0) * Number(l.markupPct || 0) / 100);
  const sellerPrice = r2(Number(l.costPrice || 0) + markup + (l.deliveryBy === 'SELLER' ? Number(l.courierCharge || 0) : 0) + Number(l.otherCharges || 0));
  const commission = r2(sellerPrice * Number(pct || 0) / 100);
  const delivery = l.deliveryBy === 'KALAI' ? Number(fee || 0) : 0;
  return { markup, sellerPrice, commission, delivery, customerPrice: Math.ceil(sellerPrice + commission + delivery) };
}

function draw() {
  const queueS = sellers.filter((s) => s.status === 'APPLIED');
  const queueL = listings.filter((l) => l.status === 'SUBMITTED');
  let html = '';
  if (view === 'queue') {
    const qa = queueS.filter((s) => s.type === 'ARTIST'), qs = queueS.filter((s) => s.type !== 'ARTIST');
    html = (qa.length ? `<h2 style="font-size:17px;margin:4px 0">Artist applications</h2>${qa.map(sellerCard).join('')}` : '')
      + (qs.length ? `<h2 style="font-size:17px;margin:8px 0 4px">Seller applications</h2>${qs.map(sellerCard).join('')}` : '')
      + (queueL.length ? `<h2 style="font-size:17px;margin:8px 0 4px">Listings to approve</h2>${queueL.map(listingCard).join('')}` : '')
      || '<p class="muted">Nothing waiting for approval.</p>';
  } else if (view === 'artists' || view === 'sellers') {
    const wantArtist = view === 'artists';
    const these = sellers.filter((s) => (s.type === 'ARTIST') === wantArtist).sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
    html = these.length ? these.map(sellerCard).join('') : wantArtist
      ? '<p class="muted">No artists yet. Share art.pranixtechno.com/seller.html?as=artist (or the “Become an artist” page) with artists.</p>'
      : '<p class="muted">No sellers yet. Share art.pranixtechno.com/seller.html with craftspeople who want to sell.</p>';
  } else {
    html = listings.length ? listings.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(listingCard).join('') : '<p class="muted">No listings yet.</p>';
  }
  $('mkBody').innerHTML = html;
  wireCards();
}

const samplesOf = (s) => { try { return JSON.parse(s.sampleKeys || '[]'); } catch { return []; } };
function sellerCard(s) {
  const n = listings.filter((l) => l.sellerId === s.id);
  const live = n.filter((l) => l.status === 'APPROVED').length;
  return `<article class="mk-card" data-seller="${esc(s.id)}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${s.photoKey ? `<img alt="" data-key="${esc(s.photoKey)}" style="width:40px;height:40px;object-fit:cover;border-radius:50%">` : ''}<h3>${esc(s.business)}</h3>${s.type === 'ARTIST' ? '<span class="cg-badge SCHEDULED">Artist</span>' : ''}<span class="cg-badge ${s.status === 'APPROVED' ? 'PUBLISHED' : s.status === 'APPLIED' ? 'SCHEDULED' : 'HIDDEN'}">${SST[s.status] || esc(s.status)}</span>
      <span class="muted" style="margin-left:auto">Applied ${esc(day(s.appliedAt))}${s.status === 'APPROVED' ? ` · ${s.commissionPct ?? 0}% · Kalai delivery ${aed(s.kalaiDeliveryFee)} · ${live}/${n.length} listings live` : ''}</span></div>
    <div>${esc(s.contactName)} · <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a> · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>${s.emirate ? ` · ${esc(s.emirate)}` : ''}${s.country === 'India' ? ', India' : ''}${s.type === 'ARTIST' ? '' : s.tradeLicence ? ` · Licence ${esc(s.tradeLicence)}` : ' · <i>no trade licence given</i>'}</div>
    ${s.type === 'ARTIST' ? `<div><b>Mediums:</b> ${esc(s.mediums)} · ${esc(s.experience || 'experience not given')} · commissions: ${s.commissions === 'NO' ? 'no' : 'yes'}${s.portfolio ? ` · <a href="${esc(s.portfolio)}" target="_blank" rel="noopener noreferrer">portfolio</a>` : ''}</div>
      <div style="white-space:pre-wrap"><b>About:</b> ${esc(s.about)}</div>
      <div class="mk-imgs">${samplesOf(s).map((k) => `<a data-key="${esc(k)}" target="_blank" rel="noopener"><img alt="Sample work" data-key="${esc(k)}"></a>`).join('') || '<span class="muted">No samples</span>'}</div>`
    : `<div><b>Sells:</b> ${esc(s.categories)} — ${esc(s.about)}</div>
      <div class="mk-imgs">${samplesOf(s).map((k) => `<a data-key="${esc(k)}" target="_blank" rel="noopener"><img alt="Product photo" data-key="${esc(k)}"></a>`).join('') || '<span class="muted">No product photos</span>'}</div>`}
    <div class="muted">${s.type === 'ARTIST' ? 'Address' : 'Pickup'}: ${esc(s.address) || '—'} · Bank: ${esc(s.bankName) || '—'} ${esc(s.accountName)} ${s.country === 'India' ? (s.accountNumber ? `· A/c ${esc(s.accountNumber)} · IFSC ${esc(s.ifsc)}` : '· <b>no bank account yet</b>') : s.iban ? `· IBAN ${esc(s.iban)}` : '· <b>no IBAN yet</b>'}</div>
    ${s.adminNote ? `<div class="muted">Note: ${esc(s.adminNote)}</div>` : ''}
    <div class="mk-act">
      ${s.status !== 'REJECTED' ? `<label>Commission %<input type="number" min="0" max="90" step="0.5" data-f="pct" value="${esc(s.commissionPct ?? DEF_PCT)}"></label>
      <label>Kalai delivery fee (AED)<input type="number" min="0" step="1" data-f="fee" value="${esc(s.kalaiDeliveryFee ?? 30)}"></label>` : ''}
      <label>Note to seller<input class="note" data-f="note" maxlength="500" value=""></label>
      ${s.status === 'APPROVED' ? '<button class="btn small" data-a="approveSeller" type="button">Save rates</button><button class="btn small ghost" data-a="suspendSeller" type="button">Suspend</button>'
        : s.status === 'SUSPENDED' ? '<button class="btn small" data-a="approveSeller" type="button">Re-activate</button>'
        : `<button class="btn small" data-a="approveSeller" type="button">Approve</button>${s.status !== 'REJECTED' ? '<button class="btn small ghost" data-a="rejectSeller" type="button">Reject</button>' : ''}`}
      <a class="btn small ghost" href="/seller.html?view=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Open ${s.type === 'ARTIST' ? 'artist' : 'seller'} portal</a>
      <span class="err" data-msg></span>
    </div>
    ${s.status === 'APPROVED' ? '<div class="muted" style="font-size:11px">A new rate applies to new listings and when you approve a listing again; live listings keep the % they were approved at.</div>' : ''}
  </article>`;
}

function listingCard(l) {
  const s = sellers.find((x) => x.id === l.sellerId) || {};
  const pct = l.commissionPct ?? s.commissionPct ?? 0, fee = s.kalaiDeliveryFee ?? l.kalaiDeliveryFee ?? 0;
  const p = priceOf(l, pct, fee);
  const keys = (() => { try { return JSON.parse(l.imageKeys || '[]'); } catch { return []; } })();
  return `<article class="mk-card" data-listing="${esc(l.id)}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3>${esc(l.title)}</h3><span class="cg-badge ${l.status === 'APPROVED' ? 'PUBLISHED' : l.status === 'SUBMITTED' ? 'SCHEDULED' : 'HIDDEN'}">${LST[l.status] || esc(l.status)}</span>
      <span class="muted" style="margin-left:auto">${esc(l.sellerName || s.business)} · ${esc(l.category)} · stock ${Number(l.stock ?? 0)}${l.submittedAt ? ` · submitted ${esc(day(l.submittedAt))}` : ''}</span></div>
    <div class="mk-grid">
      <div style="display:grid;gap:6px;align-content:start"><div class="mk-imgs">${keys.map((k) => `<a data-key="${esc(k)}" target="_blank" rel="noopener"><img alt="" data-key="${esc(k)}"></a>`).join('') || '<span class="muted">No photos</span>'}</div>
        <div style="white-space:pre-wrap">${esc(l.description)}</div>
        <div class="muted">${l.deliveryBy === 'KALAI' ? `Kalai collects from: ${esc(s.address) || '—'}` : 'Seller delivers to the customer.'}</div></div>
      <table class="mk-calc">
        <tr><td>Cost</td><td class="n">${aed(l.costPrice)}</td></tr>
        <tr><td>Markup ${Number(l.markupPct || 0)}%</td><td class="n">${aed(p.markup)}</td></tr>
        ${l.deliveryBy === 'SELLER' ? `<tr><td>Seller courier</td><td class="n">${aed(l.courierCharge)}</td></tr>` : ''}
        <tr><td>Other</td><td class="n">${aed(l.otherCharges)}</td></tr>
        <tr class="t"><td>Seller receives</td><td class="n">${aed(p.sellerPrice)}</td></tr>
        <tr><td>Commission ${pct}%</td><td class="n">${aed(p.commission)}</td></tr>
        ${l.deliveryBy === 'KALAI' ? `<tr><td>Kalai delivery</td><td class="n">${aed(p.delivery)}</td></tr>` : ''}
        <tr class="t"><td>Customer price</td><td class="n">${aed(p.customerPrice)}</td></tr>
        <tr><td>Kalai earns</td><td class="n">${aed(p.customerPrice - p.sellerPrice)}</td></tr>
      </table>
    </div>
    ${l.adminNote ? `<div class="muted">Note: ${esc(l.adminNote)}</div>` : ''}
    <div class="mk-act">
      ${['SUBMITTED', 'PAUSED', 'APPROVED'].includes(l.status) ? `<label>Commission % for this item<input type="number" min="0" max="90" step="0.5" data-f="pct" value="${esc(pct)}"></label>` : ''}
      <label>Note to seller<input class="note" data-f="note" maxlength="500"></label>
      ${l.status === 'SUBMITTED' ? '<button class="btn small" data-a="approveListing" type="button">Approve and publish</button><button class="btn small ghost" data-a="rejectListing" type="button">Ask for changes</button>' : ''}
      ${l.status === 'APPROVED' ? '<button class="btn small" data-a="approveListing" type="button">Update %</button><button class="btn small ghost" data-a="unpublishListing" type="button">Take off website</button>' : ''}
      ${l.status === 'PAUSED' ? '<button class="btn small" data-a="approveListing" type="button">Publish again</button>' : ''}
      <span class="err" data-msg></span>
    </div>
  </article>`;
}

function wireCards() {
  document.querySelectorAll('#mkBody img[data-key]').forEach(async (img) => {
    const k = img.dataset.key;
    if (!urls.has(k)) urls.set(k, getUrl({ path: k, options: { expiresIn: 3600 } }).then((r) => r.url.toString()).catch(() => ''));
    const u = await urls.get(k);
    if (u) { img.src = u; img.parentElement.href = u; }
  });
  document.querySelectorAll('#mkBody [data-a]').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.mk-card');
      const id = card.dataset.seller || card.dataset.listing;
      const f = (n) => card.querySelector(`[data-f="${n}"]`)?.value ?? '';
      const a = b.dataset.a;
      const msg = card.querySelector('[data-msg]');
      if (['rejectSeller', 'rejectListing', 'suspendSeller'].includes(a) && !f('note').trim()) { msg.textContent = 'Write a short note to the seller first.'; return; }
      const data = { id, note: f('note').trim() };
      if (a === 'approveSeller') { data.commissionPct = f('pct'); data.kalaiDeliveryFee = f('fee'); if (f('pct') === '') { msg.textContent = 'Set the commission %.'; return; } }
      if (a === 'approveListing') data.commissionPct = f('pct');
      card.querySelectorAll('button').forEach((x) => { x.disabled = true; }); msg.textContent = '';
      try {
        const r = await act(a, data);
        if (r.profile) sellers = sellers.map((s) => (s.id === id ? { ...s, ...r.profile } : s));
        if (r.listing) listings = listings.map((l) => (l.id === id ? { ...l, ...r.listing } : l));
        if (a === 'suspendSeller') await load(); else draw();
      } catch (ex) { msg.textContent = ex.message; card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
    };
  });
}
