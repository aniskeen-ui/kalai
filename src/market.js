// Sellers tab (Order Management): approve sellers (commission % + Kalai delivery fee) and approve their listings.
import { wireFind } from './find.js';
import { generateClient } from 'aws-amplify/data';
import { getUrl, uploadData } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (n) => '⃃ ' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const r2 = (n) => Math.round(n * 100) / 100;
const SUP = (s) => ['FRAMER', 'COURIER', 'PRINTER'].includes(s.type);
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
    const qa = queueS.filter((s) => s.type === 'ARTIST'), qs = queueS.filter((s) => s.type !== 'ARTIST' && !SUP(s)), qp = queueS.filter(SUP);
    html = (qa.length ? `<h2 style="font-size:17px;margin:4px 0">Artist applications</h2>${qa.map(sellerCard).join('')}` : '')
      + (qs.length ? `<h2 style="font-size:17px;margin:8px 0 4px">Seller applications</h2>${qs.map(sellerCard).join('')}` : '')
      + (qp.length ? `<h2 style="font-size:17px;margin:8px 0 4px">Frame shop &amp; delivery applications</h2>${qp.map(sellerCard).join('')}` : '')
      + (queueL.length ? `<h2 style="font-size:17px;margin:8px 0 4px">Listings to approve</h2>${queueL.map(listingCard).join('')}` : '')
      || '<p class="muted">Nothing waiting for approval.</p>';
  } else if (view === 'suppliers') {
    const these = sellers.filter((x) => SUP(x) && x.status !== 'PROSPECT').sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.business).localeCompare(String(b.business)));
    html = supplierProspectsView() + addSupplierForm() + (these.length ? these.map(sellerCard).join('') : '<p class="muted">No frame shops or delivery partners yet. Add one above, or share art.pranixtechno.com/supplier.html with them (they choose "frame shop" or "delivery partner" when applying).</p>');
  } else if (view === 'prospects') {
    html = prospectsView();
  } else if (view === 'artists' || view === 'sellers') {
    const wantArtist = view === 'artists';
    const these = sellers.filter((s) => !SUP(s) && s.status !== 'PROSPECT' && (s.type === 'ARTIST') === wantArtist).sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
    html = these.length ? these.map(sellerCard).join('') : wantArtist
      ? '<p class="muted">No artists yet. Share art.pranixtechno.com/seller.html?as=artist (or the “Become an artist” page) with artists.</p>'
      : '<p class="muted">No sellers yet. Share art.pranixtechno.com/seller.html with craftspeople who want to sell.</p>';
  } else {
    html = listings.length ? listings.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(listingCard).join('') : '<p class="muted">No listings yet.</p>';
  }
  $('mkBody').innerHTML = html;
  wireCards();
  (findRun ||= wireFind($('mkFind'), '#mkBody article.mk-card, #mkBody tr[data-seller]'))();
}
let findRun = null;

// ---------- Artist prospects (outreach list): not artists yet, never shown on the website ----------
const OUTREACH = ['To contact', 'Contacted', 'Replied - interested', 'Not interested', 'No reply'];
const artistInvite = (s) => `Hello ${s.business}, this is Anis from Kalai Art House in Dubai (art.pranixtechno.com). I came across your work and really like it. We're an online gallery for original paintings and commissions: you set your own price and receive it in full; we list, frame, deliver, collect the payment and pay you, and you can earn a royalty on framed prints if you wish. If that interests you, you can apply in a few minutes at art.pranixtechno.com/seller.html?as=artist${s.email ? ` (please sign up with ${s.email})` : ''}. Happy to answer any questions. Thank you!`;
function prospectsView() {
  const ps = sellers.filter((s) => s.status === 'PROSPECT' && s.type === 'ARTIST').sort((a, b) => OUTREACH.indexOf(a.outreach || 'To contact') - OUTREACH.indexOf(b.outreach || 'To contact') || String(a.business).localeCompare(String(b.business)));
  const counts = OUTREACH.map((o) => `${o}: <b>${ps.filter((p) => (p.outreach || 'To contact') === o).length}</b>`).join(' · ');
  return `<div class="mk-card"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>Artists you are inviting</b><span class="muted" style="font-size:12px">${counts}</span>
      <button class="btn small" type="button" id="prSeed" style="margin-left:auto">Add the 26 researched artists</button><label class="btn small ghost" style="cursor:pointer">Import outreach sheet (.xlsx)<input type="file" accept=".xlsx" id="prImport" hidden></label><span class="muted" id="prMsg" style="font-size:12px"></span></div>
    <div class="muted" style="font-size:12px">Prospects are not artists yet: they are not on the website and not in “To approve”. When one signs up with the same email, they finish the artist application and appear under To approve. Send each invitation yourself, one at a time.</div></div>
    ${ps.length ? `<div class="tablewrap"><table><thead><tr><th>Artist</th><th>Based in</th><th>Work</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>${ps.map((p) => {
      const wa = waLink(p.phone, artistInvite(p));
      return `<tr class="mk-card" data-seller="${esc(p.id)}" style="display:table-row"><td><b>${esc(p.business)}</b>${p.portfolio ? `<br><a href="${esc(p.portfolio)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">profile / website</a>` : ''}<div class="muted" style="font-size:11px;max-width:260px;white-space:normal">${esc(p.adminNote || '')}</div></td>
        <td style="font-size:12px">${esc(p.city || p.country || '')}</td><td style="font-size:12px;max-width:260px;white-space:normal">${esc(p.mediums || '')}</td>
        <td style="font-size:12px">${p.email ? `${esc(p.email)}<br>` : ''}${esc(p.phone || '')}${!p.email && !p.phone ? '<span class="muted">via their profile</span>' : ''}</td>
        <td><select data-pr="outreach" style="width:auto">${OUTREACH.map((o) => `<option ${o === (p.outreach || 'To contact') ? 'selected' : ''}>${o}</option>`).join('')}</select>${p.outreachAt ? `<div class="muted" style="font-size:11px">${esc(day(p.outreachAt))}</div>` : ''}</td>
        <td style="white-space:nowrap">${wa ? `<a class="btn small ghost" href="${wa}" target="_blank" rel="noopener">WhatsApp</a> ` : ''}${p.email ? '<button class="btn small ghost" type="button" data-pr="email">Email invite</button> ' : ''}<button class="btn small ghost" type="button" data-pr="copy">Copy message</button> <button class="btn small ghost" type="button" data-pr="remove">Remove</button><div class="err" data-msg style="font-size:11px"></div></td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="muted">No prospects yet. Import the outreach sheet above.</p>'}`;
}
// ---------- Print shops (and other suppliers) to ask for quotes: not suppliers yet, never given jobs ----------
const SUP_OUTREACH = ['To contact', 'Quote requested', 'Quote received', 'Not suitable'];
const quoteAsk = (p) => `Hello ${p.business}, this is Anis from Kalai Art House, Dubai (art.pranixtechno.com). We sell framed fine-art prints and are looking for a print partner for regular monthly orders (single prints, made to order). Could you please share your price per print on matte fine-art paper (230–310 gsm, archival inks) for these sizes: A4 (21×30), A3 (30×42), 30×40, 40×50, 50×70, 60×80 and 70×100 cm? Also your turnaround time, whether you deliver or we collect, and any trade discount for regular orders. Thank you!`;
const RC_SZ = ['A4', 'A3', '30×40', '40×50', '50×70', '60×80', '70×100'];
function supplierProspectsView() {
  const ps = sellers.filter((x) => x.status === 'PROSPECT' && SUP(x)).sort((a, b) => SUP_OUTREACH.indexOf(a.outreach || 'To contact') - SUP_OUTREACH.indexOf(b.outreach || 'To contact') || String(a.business).localeCompare(String(b.business)));
  const card = (p) => { try { const v = typeof p.rateCard === 'string' ? JSON.parse(p.rateCard) : p.rateCard; return (typeof v === 'string' ? JSON.parse(v) : v) || {}; } catch { return {}; } };
  return `<div class="mk-card" style="margin-bottom:10px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>Print shops to ask for quotes</b><span class="muted" style="font-size:12px">${ps.length} shops · not suppliers yet: no jobs, no emails</span>
      <button class="btn small" type="button" id="spSeed" style="margin-left:auto">Add the researched Dubai print shops</button><span class="muted" id="spMsg" style="font-size:12px"></span></div>
    <div class="muted" style="font-size:12px">Prices marked <b>est.</b> are an estimate for single prints on matte fine-art paper until the shop quotes; <b>published</b> are from the shop's website. Until a print shop is approved, costing uses the median of the fine-art estimates (shown as “market estimate”). When a quote arrives: correct the prices in its portal, then <b>Make supplier</b>.</div>
    ${ps.length ? `<div class="tablewrap"><table><thead><tr><th>Print shop</th><th>Prints</th><th>Price per print (⃃)</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>${ps.map((p) => {
      const c = card(p), pr = c.print || {}, wa = waLink(p.phone, quoteAsk(p));
      const prices = RC_SZ.filter((z) => pr[z] != null).map((z) => `${z} <b>${pr[z]}</b>`).join(' · ');
      return `<tr class="mk-card" data-seller="${esc(p.id)}" style="display:table-row"><td><b>${esc(p.business)}</b>${p.portfolio ? `<br><a href="${esc(p.portfolio)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">website</a>` : ''}<div class="muted" style="font-size:11px">${esc(p.address || p.city || '')}</div></td>
        <td style="font-size:12px;max-width:260px;white-space:normal">${esc(p.mediums || '')}${c.fineArt ? ' <span class="chip">fine art</span>' : ''}</td>
        <td style="font-size:12px;max-width:240px;white-space:normal">${prices || '<span class="muted">no paper prices</span>'}${prices ? ` <span class="muted">(${c.basis === 'pub' ? 'published' : 'est.'})</span>` : ''}</td>
        <td style="font-size:12px">${p.email ? `${esc(p.email)}<br>` : ''}${esc(p.phone || '')}</td>
        <td><select data-pr="outreach" style="width:auto">${SUP_OUTREACH.map((o) => `<option ${o === (p.outreach || 'To contact') ? 'selected' : ''}>${o}</option>`).join('')}</select>${p.outreachAt ? `<div class="muted" style="font-size:11px">${esc(day(p.outreachAt))}</div>` : ''}</td>
        <td style="white-space:nowrap">${wa ? `<a class="btn small ghost" href="${wa}" target="_blank" rel="noopener">Ask for a quote (WhatsApp)</a> ` : ''}<a class="btn small ghost" href="/supplier.html?view=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Price list</a> <button class="btn small" type="button" data-pr="promote">Make supplier</button> <button class="btn small ghost" type="button" data-pr="remove">Remove</button><div class="err" data-msg style="font-size:12px"></div></td></tr>`;
    }).join('')}</tbody></table></div>` : ''}</div>`;
}
// The outreach workbook (sheet "Artists", headers on row 4) → prospects.
async function importProspects(file) {
  const msg = $('prMsg'); msg.textContent = 'Reading the sheet…';
  try {
    if (!window.XLSX) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = ok; s.onerror = () => no(new Error('Could not load the spreadsheet reader.')); document.head.appendChild(s); });
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets.Artists || wb.Sheets[wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const hi = rows.findIndex((r) => r.includes('Artist'));
    if (hi < 0) throw new Error('No "Artist" column found: use the outreach sheet.');
    const H = rows[hi], col = (name) => H.findIndex((h) => String(h).toLowerCase().startsWith(name));
    const c = { name: col('artist'), based: col('based'), work: col('work'), fit: col('fit'), email: col('email'), phone: col('phone'), how: col('how'), link: col('link'), source: col('found'), status: col('status') };
    const items = rows.slice(hi + 1).filter((r) => String(r[c.name] || '').trim()).map((r) => Object.fromEntries(Object.entries(c).map(([k, i]) => [k, i >= 0 ? String(r[i] ?? '').trim() : ''])));
    msg.textContent = `Adding ${items.length} prospects…`;
    const r = await act('addProspects', { items });
    msg.textContent = `Added ${r.added}${r.skipped ? `, ${r.skipped} skipped (already there)` : ''}.`;
    await load();
  } catch (ex) { msg.textContent = ex.message; }
}

const samplesOf = (s) => { try { return JSON.parse(s.sampleKeys || '[]'); } catch { return []; } };
// WhatsApp link with the message typed in (opens WhatsApp on this device; you press Send).
const waLink = (phone, text) => { const n = String(phone || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(?=5)/, '971'); return n.length >= 9 ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : ''; };
const inviteText = (s) => `Hello${s.contactName ? ` ${s.contactName}` : ''}, Anis from Kalai Art House, Dubai (art.pranixtechno.com). We are launching shortly and would like to work with ${s.business} as our ${s.type === 'FRAMER' ? 'framing' : s.type === 'PRINTER' ? 'printing' : 'delivery'} partner. Please create an account on our supplier portal with ${s.email ? `your email ${s.email}` : 'your email'}: art.pranixtechno.com/supplier.html. Your business is already set up there; please add your ${s.type === 'FRAMER' ? 'price list (frame price per style and size, fixing charge, and delivery charge if you deliver)' : 'delivery charges to each emirate'}. Thank you!`;
// A frame shop's catalogue: photos and names of their frames (supplier portal → My frames).
function frameStrip(s) {
  let list = []; try { list = JSON.parse(s.catalogue || '[]') || []; } catch { list = []; }
  if (!list.length) return '<div class="muted">No frames in their catalogue yet (“Open their portal” → My frames).</div>';
  return `<div><b>Frames (${list.length}):</b><div class="mk-imgs">${list.map((f) => `<figure style="margin:0;width:96px;font-size:11px">${f.photoKey ? `<a data-key="${esc(f.photoKey)}" target="_blank" rel="noopener"><img alt="${esc(f.name)}" data-key="${esc(f.photoKey)}" style="width:96px;height:96px;object-fit:cover"></a>` : '<div style="width:96px;height:96px;background:var(--sunk)"></div>'}<figcaption>${esc(f.name)}${f.widthMm ? ` · ${esc(f.widthMm)} mm` : ''}${f.extra ? ` · +⃃ ${esc(f.extra)}` : ''}</figcaption></figure>`).join('')}</div></div>`;
}
function addSupplierForm() {
  const f = (id, label, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
  return `<details class="mk-card" id="addSup"><summary style="cursor:pointer;font-weight:600">+ Add a frame shop, print shop or delivery partner yourself</summary>
    <form id="addSupForm" novalidate style="display:grid;gap:8px;margin-top:10px">
      <div class="field"><label for="asType">Type</label><select id="asType"><option value="FRAMER">Frame shop</option><option value="COURIER">Delivery partner / courier</option><option value="PRINTER">Print shop</option></select></div>
      ${f('asBiz', 'Business name', 'maxlength="120"')}${f('asName', 'Contact person', 'maxlength="80"')}${f('asPhone', 'Mobile / WhatsApp', 'maxlength="30" placeholder="+971 50 123 4567"')}
      ${f('asEmail', 'Email (they sign up with it to use the portal; optional)', 'type="email" maxlength="120"')}
      <div class="field"><label for="asEm">Emirate</label><select id="asEm">${['Dubai', 'Sharjah', 'Ajman', 'Abu Dhabi', 'Ras Al Khaimah', 'Umm Al Quwain', 'Fujairah'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      ${f('asAddr', 'Workshop / pickup address', 'maxlength="300"')}${f('asAbout', 'Services and notes', 'maxlength="2000"')}${f('asLic', 'Trade licence no. (optional)', 'maxlength="60"')}${f('asWeb', 'Website or Instagram (optional)', 'maxlength="300" placeholder="https://"')}${f('asIban', 'IBAN (optional)', 'maxlength="40"')}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn small" type="submit">Add (approved)</button><span class="muted" id="asMsg"></span></div>
      <div class="muted" style="font-size:12px">Then use “Open their portal” to enter their price list, and send them the WhatsApp or email invite so they can sign in themselves.</div>
    </form></details>`;
}
const priceText = (s) => s.type === 'PRINTER'
  ? `Hello${s.contactName ? ` ${s.contactName}` : ''}, Anis from Kalai Art House, Dubai (art.pranixtechno.com). We are launching shortly and are choosing our printing partners now. We need fine-art prints (matte archival / photo paper, true colours) from files we send: customers' photos, children's drawings and our own prints. Could you share your trade price per print for A4, A3, 30×40, 40×50, 50×70, 60×80 and 70×100 cm, your usual turnaround, and whether a frame shop can collect from you? You can also enter them in our supplier portal: art.pranixtechno.com/supplier.html. Thank you!`
  : s.type === 'FRAMER'
  ? `Hello${s.contactName ? ` ${s.contactName}` : ''}, Anis from Kalai Art House, Dubai (art.pranixtechno.com). We are launching shortly and are choosing our framing partners now. We frame original artworks and children's drawings for our customers and would like your trade prices for regular orders:\n\n• Sizes: A4, A3, 30×40, 40×50, 50×70, 60×80, 70×100 cm\n• Styles: black slim, white, natural oak, walnut, gold\n• With white mount and glass or acrylic: fixing charge per size, or included?\n• Delivery to the customer within Dubai and other emirates: your charge?\n\nYou can also enter them in our supplier portal: art.pranixtechno.com/supplier.html. Thank you!`
  : `Hello${s.contactName ? ` ${s.contactName}` : ''}, Anis from Kalai Art House, Dubai (art.pranixtechno.com). We are launching shortly and are choosing our delivery partners now. We deliver framed artworks to customers and would like your rates for regular jobs: one framed work picked up in Dubai, delivered to each emirate, by frame size (30×40, 40×50, 50×70, 60×80 and 70×100 cm, packed with glass), and same-day if available. You can also enter them in our supplier portal: art.pranixtechno.com/supplier.html. Thank you!`;
function supplierCard(s) {
  const fr = s.type === 'FRAMER';
  return `<article class="mk-card" data-seller="${esc(s.id)}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3>${esc(s.business)}</h3><span class="cg-badge SCHEDULED">${fr ? 'Frame shop' : s.type === 'PRINTER' ? 'Print shop' : 'Delivery partner'}</span>${!s.owner ? '<span class="cg-badge DRAFT" title="Added by you; they have not signed in yet">No login yet</span>' : ''}<span class="cg-badge ${esc(s.status)}">${esc(SST[s.status] || s.status)}</span>
      <span class="muted" style="margin-left:auto">Applied ${esc(day(s.appliedAt))}</span></div>
    <div>${esc(s.contactName)} · <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a> · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>${s.emirate ? ` · ${esc(s.emirate)}` : ''}${s.tradeLicence ? ` · Licence ${esc(s.tradeLicence)}` : ' · <i>no trade licence given</i>'}</div>
    <div style="white-space:pre-wrap"><b>Services:</b> ${esc(s.about)}${s.portfolio ? ` · <a href="${esc(s.portfolio)}" target="_blank" rel="noopener noreferrer">website</a>` : ''}</div>
    ${fr ? frameStrip(s) : ''}
    <div class="muted">${fr ? 'Workshop' : s.type === 'PRINTER' ? 'Shop' : 'Base'}: ${esc(s.address) || '—'} · Bank: ${esc(s.bankName) || '—'} ${esc(s.accountName)} ${s.iban ? `· IBAN ${esc(s.iban)}` : '· <b>no IBAN yet</b>'}</div>
    ${s.adminNote ? `<div class="muted">Note: ${esc(s.adminNote)}</div>` : ''}
    <div class="mk-act">
      <label>Note to ${fr ? 'frame shop' : 'delivery partner'}<input class="note" data-f="note" maxlength="500" value=""></label>
      ${s.status === 'APPROVED' ? '<button class="btn small ghost" data-a="suspendSeller" type="button">Suspend</button>'
        : s.status === 'SUSPENDED' ? '<button class="btn small" data-a="approveSeller" type="button">Re-activate</button>'
        : `<button class="btn small" data-a="approveSeller" type="button">Approve</button>${s.status !== 'REJECTED' ? '<button class="btn small ghost" data-a="rejectSeller" type="button">Reject</button>' : ''}`} ${s.status !== 'APPROVED' ? '<button class="btn small ghost" data-a="deleteSeller" type="button" title="Remove this account for good (only if it has no orders)">Delete</button>' : ''}
      <a class="btn small ghost" href="/supplier.html?view=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Open their portal${!s.owner ? ' (price list, jobs)' : ''}</a>
      ${waLink(s.phone, inviteText(s)) ? `<a class="btn small ghost" href="${waLink(s.phone, inviteText(s))}" target="_blank" rel="noopener">WhatsApp invite</a><a class="btn small ghost" href="${waLink(s.phone, priceText(s))}" target="_blank" rel="noopener">WhatsApp: ask for prices</a>` : ''}
      ${s.email ? '<button class="btn small ghost" data-a="inviteSupplier" type="button">Email invite</button>' : ''}
      <span class="muted" data-msg></span>
    </div></article>`;
}
function sellerCard(s) {
  if (SUP(s)) return supplierCard(s);
  const n = listings.filter((l) => l.sellerId === s.id);
  const live = n.filter((l) => l.status === 'APPROVED').length;
  return `<article class="mk-card" data-seller="${esc(s.id)}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${s.photoKey ? `<img alt="" data-key="${esc(s.photoKey)}" style="width:40px;height:40px;object-fit:cover;border-radius:50%">` : ''}<h3>${esc(s.business)}</h3>${s.type === 'ARTIST' ? '<span class="cg-badge SCHEDULED">Artist</span>' : ''}<span class="cg-badge ${s.status === 'APPROVED' ? 'PUBLISHED' : s.status === 'APPLIED' ? 'SCHEDULED' : 'HIDDEN'}">${SST[s.status] || esc(s.status)}</span>
      <span class="muted" style="margin-left:auto">Applied ${esc(day(s.appliedAt))}${s.status === 'APPROVED' ? ` · ${s.commissionPct ?? 0}% · Kalai delivery ${aed(s.kalaiDeliveryFee)} · ${live}/${n.length} listings live` : ''}</span></div>
    <div>${esc(s.contactName)} · <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a> · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>${s.emirate ? ` · ${esc(s.emirate)}` : ''}${s.country === 'India' ? ', India' : ''}${s.type === 'ARTIST' ? '' : s.tradeLicence ? ` · Licence ${esc(s.tradeLicence)}` : ' · <i>no trade licence given</i>'}</div>
    ${s.type === 'ARTIST' ? `<div><b>Mediums:</b> ${esc(s.mediums)} · ${esc(s.experience || 'experience not given')} · commissions: ${s.commissions === 'NO' ? 'no' : 'yes'} · prints: ${s.allowPrints === 'NO' ? '<b>not allowed</b>' : `allowed${s.royaltyPct != null ? `, ${s.royaltyPct}% royalty` : ''}`} · licences: ${s.allowLicences === 'YES' ? 'allowed' : 'no'}${s.portfolio ? ` · <a href="${esc(s.portfolio)}" target="_blank" rel="noopener noreferrer">portfolio</a>` : ''}</div>
      <div style="white-space:pre-wrap"><b>About:</b> ${esc(s.about)}</div>
      <div class="mk-imgs">${samplesOf(s).map((k) => `<a data-key="${esc(k)}" target="_blank" rel="noopener"><img alt="Sample work" data-key="${esc(k)}"></a>`).join('') || '<span class="muted">No samples</span>'}</div>`
    : `<div><b>Sells:</b> ${esc(s.categories)} — ${esc(s.about)}</div>
      <div class="mk-imgs">${samplesOf(s).map((k) => `<a data-key="${esc(k)}" target="_blank" rel="noopener"><img alt="Product photo" data-key="${esc(k)}"></a>`).join('') || '<span class="muted">No product photos</span>'}</div>`}
    <div class="muted">${s.type === 'ARTIST' ? 'Address' : 'Pickup'}: ${esc(s.address) || '—'} · Bank: ${esc(s.bankName) || '—'} ${esc(s.accountName)} ${s.country === 'India' ? (s.accountNumber ? `· A/c ${esc(s.accountNumber)} · IFSC ${esc(s.ifsc)}` : '· <b>no bank account yet</b>') : s.iban ? `· IBAN ${esc(s.iban)}` : '· <b>no IBAN yet</b>'}</div>
    ${s.adminNote ? `<div class="muted">Note: ${esc(s.adminNote)}</div>` : ''}
    <div class="mk-act">
      ${s.status !== 'REJECTED' ? `<label>Commission %<input type="number" min="0" max="90" step="0.5" data-f="pct" value="${esc(s.commissionPct ?? DEF_PCT)}"></label>
      <label>Kalai delivery fee (⃃)<input type="number" min="0" step="1" data-f="fee" value="${esc(s.kalaiDeliveryFee ?? 30)}"></label>
      ${s.type === 'ARTIST' ? `<label title="The artist's share of each framed print sold of their works, added to the print price">Print royalty %<input type="number" min="0" max="50" step="0.5" data-f="royalty" value="${esc(s.royaltyPct ?? 10)}"></label>
      <label title="Shown on their artist bio on the website">Artist photo<input type="file" accept="image/*" data-f="photofile"><input type="hidden" data-f="photo" value=""></label>` : ''}` : ''}
      <label>Note to seller<input class="note" data-f="note" maxlength="500" value=""></label>
      ${s.status === 'APPROVED' ? '<button class="btn small" data-a="approveSeller" type="button">Save rates</button><button class="btn small ghost" data-a="suspendSeller" type="button">Suspend</button>'
        : s.status === 'SUSPENDED' ? '<button class="btn small" data-a="approveSeller" type="button">Re-activate</button>'
        : `<button class="btn small" data-a="approveSeller" type="button">Approve</button>${s.status !== 'REJECTED' ? '<button class="btn small ghost" data-a="rejectSeller" type="button">Reject</button>' : ''}`} ${s.status !== 'APPROVED' ? '<button class="btn small ghost" data-a="deleteSeller" type="button" title="Remove this account for good (only if it has no orders)">Delete</button>' : ''}
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
  const form = $('addSupForm');
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = (id) => $(id).value.trim();
    const data = { type: $('asType').value, business: v('asBiz'), contactName: v('asName'), phone: v('asPhone'), email: v('asEmail'), emirate: $('asEm').value, address: v('asAddr'), about: v('asAbout'), tradeLicence: v('asLic'), iban: v('asIban'), website: v('asWeb') };
    const b = form.querySelector('button'); b.disabled = true; $('asMsg').textContent = 'Adding…';
    try {
      const r = await act('addSupplier', data);
      sellers = [r.profile, ...sellers];
      draw();
      $('asMsg') && ($('asMsg').textContent = '');
    } catch (ex) { $('asMsg').textContent = ex.message; b.disabled = false; }
  };
  document.querySelectorAll('#mkBody img[data-key]').forEach(async (img) => {
    const k = img.dataset.key;
    if (!urls.has(k)) urls.set(k, getUrl({ path: k, options: { expiresIn: 3600 } }).then((r) => r.url.toString()).catch(() => ''));
    const u = await urls.get(k);
    if (u) { img.src = u; img.parentElement.href = u; }
  });
  // Artist photo chosen by the studio: uploaded at once, saved with "Save rates" / "Approve".
  document.querySelectorAll('#mkBody [data-f="photofile"]').forEach((inp) => {
    inp.onchange = async () => {
      const card = inp.closest('.mk-card'), msg = card.querySelector('[data-msg]'), file = inp.files?.[0];
      if (!file) return;
      if (!/^image\//.test(file.type) || file.size > 10 * 1024 * 1024) { msg.textContent = 'Choose a JPG or PNG photo up to 10 MB.'; return; }
      msg.textContent = 'Uploading the photo…';
      try {
        const r = await uploadData({ path: ({ identityId }) => `market/${identityId}/profile/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '-')}`, data: file, options: { contentType: file.type } }).result;
        card.querySelector('[data-f="photo"]').value = r.path;
        msg.textContent = 'Photo uploaded: press Save rates to put it on their bio.';
      } catch (ex) { msg.textContent = ex.message; }
    };
  });
  if ($('prSeed')) $('prSeed').onclick = async () => {
    const b = $('prSeed'), msg = $('prMsg'); b.disabled = true; msg.textContent = 'Adding…';
    try { const { RESEARCHED_ARTISTS } = await import('./prospects-seed.js'); const r = await act('addProspects', { items: RESEARCHED_ARTISTS }); msg.textContent = `Added ${r.added}${r.skipped ? `, ${r.skipped} already there` : ''}.`; await load(); }
    catch (ex) { msg.textContent = ex.message; b.disabled = false; }
  };
  if ($('spSeed')) $('spSeed').onclick = async () => {
    const b = $('spSeed'), msg = $('spMsg'); b.disabled = true; msg.textContent = 'Adding…';
    try {
      const { PRINT_SHOPS } = await import('./supplier-prospects-seed.js');
      const items = PRINT_SHOPS.map((x) => ({ type: 'PRINTER', name: x.name, phone: x.phone, email: x.email, based: x.based, link: x.link, work: x.work, status: 'To contact',
        rateCard: { print: x.print, notes: x.basis === 'pub' ? 'Published prices from the shop website (Oct 2026).' : 'Estimate by Kalai Art House (Oct 2026), not a quote: replace with the shop\'s prices.', fineArt: x.fineArt, basis: x.basis, at: new Date().toISOString() } }));
      const r = await act('addProspects', { items }); msg.textContent = `Added ${r.added}${r.skipped ? `, ${r.skipped} already there` : ''}.`; await load();
    } catch (ex) { msg.textContent = ex.message; b.disabled = false; }
  };
  $('prImport')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) importProspects(f); });
  document.querySelectorAll('#mkBody [data-pr]').forEach((el) => {
    const row = el.closest('[data-seller]'), id = row.dataset.seller, msg = row.querySelector('[data-msg]'), p = sellers.find((s) => s.id === id);
    const run = async (action, data) => { msg.textContent = ''; try { const r = await act(action, { id, ...data }); if (r.profile) Object.assign(p, r.profile); return r; } catch (ex) { msg.textContent = ex.message; return null; } };
    if (el.dataset.pr === 'outreach') el.onchange = async () => { if (await run('prospectUpdate', { outreach: el.value })) draw(); };
    if (el.dataset.pr === 'email') el.onclick = async () => { el.disabled = true; if (await run('inviteArtist', {})) { msg.textContent = 'Invitation emailed.'; setTimeout(draw, 900); } else el.disabled = false; };
    if (el.dataset.pr === 'copy') el.onclick = async () => { try { await navigator.clipboard.writeText(artistInvite(p)); msg.textContent = 'Copied: paste it in their Instagram / Artmajeur message.'; } catch { msg.textContent = 'Copy not allowed here.'; } };
    if (el.dataset.pr === 'promote') el.onclick = async () => { if (!el.dataset.sure) { el.dataset.sure = '1'; el.textContent = 'Prices checked? Click again'; return; } if (await run('promoteSupplier', {})) draw(); };
    if (el.dataset.pr === 'remove') el.onclick = async () => { if (el.dataset.sure) { if (await run('removeProspect', {})) { sellers = sellers.filter((s) => s.id !== id); draw(); } } else { el.dataset.sure = '1'; el.textContent = 'Sure?'; } };
  });
  document.querySelectorAll('#mkBody [data-a]').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.mk-card');
      const id = card.dataset.seller || card.dataset.listing;
      const f = (n) => card.querySelector(`[data-f="${n}"]`)?.value ?? '';
      const a = b.dataset.a;
      const msg = card.querySelector('[data-msg]');
      if (['rejectSeller', 'rejectListing', 'suspendSeller'].includes(a) && !f('note').trim()) { msg.textContent = 'Write a short note to the seller first.'; return; }
      if (a === 'deleteSeller' && !b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Delete for good? Click again'; b.classList.remove('ghost'); msg.textContent = 'This removes the account, its listings and its catalogue copies. It cannot be undone.'; return; }
      const data = { id, note: f('note').trim() };
      if (a === 'approveSeller' && card.querySelector('[data-f="royalty"]')) { data.royaltyPct = f('royalty'); if (f('photo')) data.photoKey = f('photo'); }
      if (a === 'approveSeller' && card.querySelector('[data-f="pct"]')) { data.commissionPct = f('pct'); data.kalaiDeliveryFee = f('fee'); if (f('pct') === '') { msg.textContent = 'Set the commission %.'; return; } }
      if (a === 'approveListing') data.commissionPct = f('pct');
      card.querySelectorAll('button').forEach((x) => { x.disabled = true; }); msg.textContent = '';
      try {
        const r = await act(a, data);
        if (r.profile) sellers = sellers.map((s) => (s.id === id ? { ...s, ...r.profile } : s));
        if (r.listing) listings = listings.map((l) => (l.id === id ? { ...l, ...r.listing } : l));
        if (a === 'inviteSupplier') { msg.textContent = 'Invite emailed.'; card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); return; }
        if (a === 'deleteSeller') { sellers = sellers.filter((x) => x.id !== id); listings = listings.filter((l) => l.sellerId !== id); draw(); return; }
        if (a === 'suspendSeller') await load(); else draw();
      } catch (ex) { msg.textContent = ex.message; card.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
    };
  });
}
