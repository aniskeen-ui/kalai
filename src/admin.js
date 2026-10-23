// Studio desk: list every enquiry, view uploads, set price / payment link / status / message.
import { RC_STYLES, specOf, frameCost, deliveryCost, parseCard, zoneOf } from './ratecard.js';
import './amplify-config.js';
import './skin.js';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';
import { showCatalogue } from './catalogue.js';
import { showMessages } from './messages.js';
import { showMarket } from './market.js';
import { showPromotions } from './promotions.js';
import { showSettings } from './settings.js';
import { showPricing } from './pricing.js';
import { countryRegionHtml, wireRegion, addressLine } from './phone.js';
import outputs from '../amplify_outputs.json';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  RECEIVED: 'Received', PRICE_SENT: 'Price sent', PAID: 'Paid', FRAMING: 'Being framed',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', REPLACEMENT: 'Replacement', REFUNDED: 'Refunded', CANCELLED: 'Cancelled',
};
const KIND = { PRICE: 'Price', COMMISSION: 'Commission', GIFT: 'Little Artists', MARKET: 'Crafts shop' };
// Once Zoho holds the payment the enquiry can't go back to these (reverse it in Zoho, then Check Zoho).
const BEFORE_PAYMENT = ['RECEIVED', 'PRICE_SENT', 'CANCELLED'];
const ZOHO_LABEL = { QUOTED: 'Quote in Zoho', PAID: 'Paid in Zoho', ERROR: 'Zoho error', REVERSED: 'Reversed in Zoho', NONE: 'Not in Zoho', TEST: 'Test mode: drafts only' };
// Paid: the payment is in Zoho, or the customer paid online with Ziina (also in test mode, where Zoho keeps drafts).
const isLocked = (e) => !!e.zohoPaymentId || !!e.ziinaPaidAt;
// The price is fixed once Zoho has an invoice for the order (a draft one too, in test mode).
const priceLocked = (e) => isLocked(e) || !!e.zohoInvoiceId;
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
  local: 30, customs: 0.05, fee: 0.03, ins: 0.01, reserve: 0.02, margin: 0.25, vat: 0, fx: 0.042, round9: true, saved: false,
  // Market check: Kalai's target price band per size (simple frame included), and what similar originals list for on
  // Saatchi Art (watercolour / ink by artists from India, AED, Oct 2026). Edit under Rates.
  market: {
    S: { sk: [390, 590], wc: [490, 790], saatchi: 'ink 20×15 cm ≈ AED 1,100 · watercolour 30×23 cm ≈ AED 4,300' },
    M: { sk: [590, 890], wc: [790, 1190], saatchi: 'ink 29×22 cm ≈ AED 1,600–1,900 · watercolour 38×28 cm ≈ AED 3,800–4,300' },
    L: { sk: [990, 1490], wc: [1290, 1990], saatchi: 'watercolour 51×38 to 56×76 cm ≈ AED 3,900–7,500' },
  },
};
// Sketch (pencil, ink, charcoal) or watercolour/painting, from the order's title and details.
const mediumOf = (e) => (/sketch|pencil|ink|charcoal|pen\b/i.test(`${e?.title || ''} ${typeof e?.details === 'string' ? e.details : JSON.stringify(e?.details || '')}`) ? 'sk' : 'wc');
let curEnq = null;
function marketLine(price, suggested) {
  const tier = $('cTier')?.value; const m = rates.market?.[tier]; if (!m) return '';
  const md = mediumOf(curEnq); const [lo, hi] = m[md] || [];
  if (!lo) return '';
  const p = price || suggested;
  const verdict = !p ? '' : p < lo ? `<b class="warn-t">below the band</b>: consider at least ${aed(lo)}` : p > hi ? '<b class="warn-t">above the band</b>: fine for a special piece, else consider lowering' : '<b class="ok-t">inside the band</b>';
  return `<div class="marketline">Market check (${tier}, ${md === 'sk' ? 'sketch' : 'watercolour'}): Kalai band <b>${aed(lo)}–${aed(hi)}</b>${p ? ` · ${aed(p)} is ${verdict}` : ''}<br><span class="muted">Saatchi Art, similar originals: ${esc(m.saatchi || '')}</span></div>`;
}
let rates = structuredClone(DEFAULT_RATES);
const costings = new Map(); // enquiryId → Costing record
const hasArtist = (e) => e.kind === 'PRICE' || e.kind === 'COMMISSION';
// Kalai margin master by category (Rates). Collection = artwork price enquiries and the Pricing tab; Crafts shop = the
// default commission % when approving a seller. Each category's margin is also its target in Reports.
const CATS = [['collection', 'Collection (artworks on the website)', 'markup on cost: Pricing tab and artwork price enquiries'], ['commission', 'Commissions (paintings and sketches to order)', 'markup on cost: commission price calculator'],
  ['gift', 'Little Artists', 'target margin, checked in Reports'], ['market', 'Crafts shop', 'default commission % for a new seller']];
const CAT_OF = { PRICE: 'collection', COMMISSION: 'commission', GIFT: 'gift', MARKET: 'market' };
const marginFor = (kind) => { const m = rates.margins?.[CAT_OF[kind] || 'collection']; return m != null ? m : rates.margin; };
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const aed = (v, d = 0) => (v == null ? '–' : 'AED ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Cost build-up for one enquiry, the suggested price and the margin at a given price. */
function calc(c, price) {
  const tier = rates.tiers[c.sizeTier] || null;
  // Artist price: INR (Siva / artists in India) converted at the master rate, or AED for artists in the UAE.
  const artistAed = c.artistPriceAed != null ? Number(c.artistPriceAed) : c.artistPriceInr ? c.artistPriceInr * rates.fx : null;
  const framing = c.framingOverride ?? tier?.framing ?? null;
  // An artist in the UAE: no courier from India and no customs.
  const indiaCourier = c.indiaCourierOverride ?? (c.local ? 0 : tier?.courier ?? null);
  const localCourier = c.localCourierOverride ?? rates.local;
  const vat = c.delivery === 'OUTSIDE' ? 0 : rates.vat;
  if (artistAed == null || framing == null || indiaCourier == null) {
    return { artistAed, framing, indiaCourier, localCourier, ready: false };
  }
  const customs = c.local ? 0 : (artistAed + indiaCourier) * rates.customs;
  const total = artistAed + framing + indiaCourier + customs + localCourier;
  // Ziina fee, courier insurance and the breakage reserve are all a % of what the customer pays.
  const pctOfPrice = rates.fee + (rates.ins || 0) + (rates.reserve || 0);
  const mg = marginFor(curEnq?.kind);
  const raw = (total * (1 + mg)) / (1 / (1 + vat) - pctOfPrice);
  const suggested = rates.round25 !== false ? Math.ceil(raw / 25) * 25 : rates.round9 ? Math.ceil((raw + 1) / 10) * 10 - 1 : Math.round(raw);
  const out = { artistAed, framing, indiaCourier, localCourier, customs, total, suggested, vatRate: vat, ready: true, mg };
  if (price > 0) {
    out.price = price;
    out.vatAmt = price - price / (1 + vat);
    out.feeAmt = price * rates.fee;
    out.insAmt = price * (rates.ins || 0);
    out.resAmt = price * (rates.reserve || 0);
    out.margin = price - out.vatAmt - out.feeAmt - out.insAmt - out.resAmt - total;
    out.marginPct = out.margin / (price - out.vatAmt);
  }
  return out;
}

async function loadRates() {
  try {
    const { data } = await client.models.Rates.get({ key: 'default' });
    const d = data?.data ? (typeof data.data === 'string' ? JSON.parse(data.data) : data.data) : null;
    if (d) rates = { ...structuredClone(DEFAULT_RATES), ...d, tiers: { ...DEFAULT_RATES.tiers, ...(d.tiers || {}) }, market: { ...structuredClone(DEFAULT_RATES.market), ...(d.market || {}) }, saved: true };
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
const reviews = new Map(); // enquiryId -> Review
async function loadReviews() {
  reviews.clear();
  let nextToken = null;
  do {
    const res = await client.models.Review.list({ limit: 500, nextToken });
    (res.data || []).forEach((r) => reviews.set(r.enquiryId, r));
    nextToken = res.nextToken;
  } while (nextToken);
}

$('fStatus').insertAdjacentHTML('beforeend', '<option value="__REQ">Customer requests (cancel / damage)</option>');
Object.entries(STATUS).forEach(([k, v]) => $('fStatus').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`));

// Signed out in the background (session expired, or the sign-in setup changed after a deploy): back to the sign-in screen.
function sessionGone(ex) {
  const m = String(ex?.message || ex || '');
  if (!/No current user|not authenticated|Unauthorized|NotAuthorizedException|token.*(expired|invalid)|UserUnAuthenticated/i.test(m)) return false;
  show('loginView');
  $('loginErr').textContent = 'Your session has ended. Please sign in again; nothing you saved is lost.';
  $('lEmail').focus();
  return true;
}

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
  // Orders open on the last 2 days, yesterday and today (Dubai); Clear shows all dates.
  if (!$('fFrom').value && !$('fTo').value) { const d = (ms) => new Date(ms + 4 * 3600_000).toISOString().slice(0, 10); $('fFrom').value = d(Date.now() - 86_400_000); $('fTo').value = d(Date.now()); }
  if (location.hash === '#reports') showPane('reports', 'tabReports');
  if (location.hash === '#feedback') showPane('feedback', 'tabFeedback');
  if (location.hash === '#catalogue') showPane('catalogue', 'tabCatalogue');
  if (location.hash === '#messages') showPane('messages', 'tabMessages');
  if (location.hash === '#sellers') showPane('sellers', 'tabSellers');
  if (location.hash === '#offers') showPane('offers', 'tabOffers');
  if (location.hash === '#settings') showPane('settings', 'tabSettings');
  if (location.hash === '#pricing') showPane('pricing', 'tabPricing');
  await loadRates();
  await load();
  // Links in studio emails: admin.html#order=<id> opens that order.
  const m = location.hash.match(/^#order=(.+)$/);
  const hit = m && all.find((x) => x.id === decodeURIComponent(m[1]));
  if (hit) { selectedId = hit.id; render(); showDetail(hit); }
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
$('ratesBtn').onclick = () => { showPane('orders', 'ratesBtn'); selectedId = null; render(); showRates(); };
$('tabOrders').onclick = () => showPane('orders', 'tabOrders');
$('tabReports').onclick = () => showPane('reports', 'tabReports');
$('tabFeedback').onclick = () => showPane('feedback', 'tabFeedback');
$('tabCatalogue').onclick = () => showPane('catalogue', 'tabCatalogue');
$('tabMessages').onclick = () => showPane('messages', 'tabMessages');
$('tabSellers').onclick = () => showPane('sellers', 'tabSellers');
$('tabOffers').onclick = () => showPane('offers', 'tabOffers');
$('tabSettings').onclick = () => showPane('settings', 'tabSettings');
$('tabPricing').onclick = () => showPane('pricing', 'tabPricing');
document.addEventListener('click', (ev) => { if (ev.target.closest?.('[data-goprice]')) { ev.preventDefault(); showPane('pricing', 'tabPricing'); } });

// ---------- tabs: Orders · Reports · Rates ----------
function showPane(pane, tabId) {
  $('ordersPane').hidden = pane !== 'orders';
  $('reportsPane').hidden = pane !== 'reports';
  $('feedbackPane').hidden = pane !== 'feedback';
  $('cataloguePane').hidden = pane !== 'catalogue';
  $('messagesPane').hidden = pane !== 'messages';
  $('sellersPane').hidden = pane !== 'sellers';
  $('offersPane').hidden = pane !== 'offers';
  $('settingsPane').hidden = pane !== 'settings';
  $('pricingPane').hidden = pane !== 'pricing';
  ['tabOrders', 'tabReports', 'tabFeedback', 'tabCatalogue', 'tabMessages', 'tabSellers', 'tabOffers', 'tabSettings', 'tabPricing', 'ratesBtn'].forEach((t) => $(t).setAttribute('aria-selected', String(t === tabId)));
  try { history.replaceState(null, '', ['reports', 'feedback', 'catalogue', 'messages', 'sellers', 'offers', 'settings', 'pricing'].includes(pane) ? '#' + pane : location.pathname); } catch { /* ignore */ }
  if (pane === 'reports') renderReport();
  if (pane === 'feedback') renderFeedback();
  if (pane === 'catalogue') showCatalogue();
  if (pane === 'messages') showMessages();
  if (pane === 'sellers') showMarket();
  if (pane === 'offers') showPromotions();
  if (pane === 'settings') showSettings();
  if (pane === 'pricing') showPricing();
}

// ---------- Feedback: customer reviews, publish to the website ----------
const stars = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
function avgRating(list) {
  return list.length ? list.reduce((a, r) => a + (r.rating || 0), 0) / list.length : null;
}
// A review must belong to a delivered order of the same customer before it can go on the website.
function isGenuine(r) {
  const e = all.find((x) => x.id === r.enquiryId);
  return !!e && ['DELIVERED', 'REPLACEMENT'].includes(e.status) && (!e.owner || !r.owner || e.owner === r.owner);
}
function reviewCard(r, withOrder = true) {
  const e = all.find((x) => x.id === r.enquiryId);
  const genuine = isGenuine(r);
  const canPublish = !!r.consent && genuine;
  return `<article class="review" data-id="${esc(r.enquiryId)}">
    <div class="rv-top"><span class="rv-stars" aria-label="${r.rating} out of 5">${stars(r.rating)}</span>
      ${r.published ? '<span class="pill DELIVERED">On website</span>' : !genuine ? '<span class="pill CANCELLED">Doesn’t match a delivered order</span>' : canPublish ? '<span class="pill">Not published</span>' : '<span class="pill CANCELLED">Private (no consent)</span>'}</div>
    ${r.comment ? `<p class="rv-text">“${esc(r.comment)}”</p>` : '<p class="muted rv-text">No comment, rating only.</p>'}
    <div class="muted" style="font-size:12px">${esc(r.firstName || e?.customerName || '')} · ${esc(r.ref || e?.ref || '')} · ${esc(r.title || e?.title || '')} · ${esc(when(r.createdAt))}</div>
    <div class="links">
      ${r.published || canPublish ? (r.published ? '<button class="btn ghost" type="button" data-act="hide">Hide from website</button>' : '<button class="btn" type="button" data-act="publish">Publish on website</button>') : ''}
      ${withOrder && e ? '<button class="btn ghost" type="button" data-act="open">Open order</button>' : ''}
    </div>
    <div class="ok" role="status"></div>
  </article>`;
}
function wireReviews(root) {
  root.querySelectorAll('.review').forEach((box) => {
    const r = reviews.get(box.dataset.id);
    box.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const msg = box.querySelector('[role=status]');
        if (b.dataset.act === 'open') { const e = all.find((x) => x.id === r.enquiryId); showPane('orders', 'tabOrders'); selectedId = e.id; render(); showDetail(e); return; }
        b.disabled = true; msg.className = 'ok'; msg.textContent = 'Saving…';
        try {
          await setPublished(r, b.dataset.act === 'publish');
          msg.textContent = b.dataset.act === 'publish' ? 'Published: it now shows on the website.' : 'Hidden from the website.';
          setTimeout(() => { renderFeedback(); if (selectedId === r.enquiryId) { const e = all.find((x) => x.id === selectedId); if (e) showDetail(e); } }, 900);
        } catch (ex) { msg.className = 'err'; msg.textContent = ex.message || 'Could not save.'; b.disabled = false; }
      };
    });
  });
}
async function setPublished(r, on) {
  if (on) {
    if (!r.consent) throw new Error('The customer did not agree to show this review.');
    const row = { enquiryId: r.enquiryId, firstName: r.firstName || '', rating: r.rating, comment: r.comment || '', title: r.title || '', date: String(r.createdAt || new Date().toISOString()).slice(0, 10) };
    const ex = await client.models.PublicReview.get({ enquiryId: r.enquiryId });
    const res = ex.data ? await client.models.PublicReview.update(row) : await client.models.PublicReview.create(row);
    if (res.errors?.length) throw new Error(res.errors[0].message);
  } else {
    const res = await client.models.PublicReview.delete({ enquiryId: r.enquiryId });
    if (res.errors?.length && !/not found|ConditionalCheck/i.test(res.errors[0].message)) throw new Error(res.errors[0].message);
  }
  const up = await client.models.Review.update({ enquiryId: r.enquiryId, published: on, publishedAt: on ? new Date().toISOString() : null });
  if (up.errors?.length) throw new Error(up.errors[0].message);
  reviews.set(r.enquiryId, { ...r, ...up.data, published: on });
}
function renderFeedback() {
  const f = $('fbFilter').value;
  const list = [...reviews.values()].filter(isGenuine).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const shown = list.filter((r) => !f || (f === 'PUBLISHED' ? r.published : f === 'WAITING' ? r.consent && !r.published : f === 'LOW' ? r.rating <= 3 : true));
  const avg = avgRating(list);
  const delivered = all.filter((e) => e.status === 'DELIVERED').length;
  const tile = (k, v, cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  $('fbTiles').innerHTML = [
    tile('Reviews', list.length),
    tile('Average', avg == null ? '–' : `${avg.toFixed(1)} ★`, avg != null && avg < 4 ? 'neg' : ''),
    tile('On website', list.filter((r) => r.published).length),
    tile('Waiting to publish', list.filter((r) => r.consent && !r.published).length),
    tile('3 stars or less', list.filter((r) => r.rating <= 3).length, list.some((r) => r.rating <= 3) ? 'neg' : ''),
    tile('Delivered, not rated', Math.max(0, all.filter((e) => e.status === 'DELIVERED' && !reviews.has(e.id)).length)),
  ].join('');
  $('fbList').innerHTML = shown.length ? shown.map((r) => reviewCard(r)).join('')
    : `<p class="muted">${list.length ? 'No reviews match this filter.' : `No reviews yet. Customers can rate an order once it is marked Delivered (${delivered} delivered so far).`}</p>`;
  wireReviews($('fbList'));
}
$('fbFilter').addEventListener('change', renderFeedback);

// ---------- Reports: sales, cost and margin per order ----------
const SOLD = ['PAID', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT', 'REFUNDED'];
const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => (v == null ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function parseCosts(c) {
  let v = c?.costs;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : null;
}

// Actual costs (AED) from the vendors' bills, entered per paid order.
const ACT_FIELDS = [['artist', 'Artist (paid, AED)'], ['framing', 'Frame shop'], ['india', 'Courier India → Dubai'], ['customs', 'Customs / duty'], ['local', 'Courier to the customer'], ['other', 'Other (packing, etc.)']];
function typedOf(c) {
  let v = c?.actual;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : null;
}
// Which cost a Zoho vendor's bill is: Rates → "Zoho vendors" ("Al Warda = frame shop", one per line).
const VENDOR_TYPES = { frame: 'framing', framing: 'framing', 'frame shop': 'framing', india: 'india', 'india courier': 'india', 'courier india': 'india', customs: 'customs', duty: 'customs', local: 'local', 'local courier': 'local', courier: 'local', delivery: 'local', other: 'other', packing: 'other' };
function vendorRules() {
  return String(rates.vendors || '').split('\n').map((l) => l.split('=')).filter((x) => x.length === 2 && x[0].trim())
    .map(([m, t]) => [m.trim().toLowerCase(), VENDOR_TYPES[t.trim().toLowerCase()] || 'other']);
}
/** Actual costs found in Zoho Books for this order: the artist's bill and the vendor bills that name the order. */
function zohoActual(e) {
  const raw = costings.get(e.id)?.zohoDocs;
  let d = null;
  try { d = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; if (typeof d === 'string') d = JSON.parse(d); } catch { d = null; }
  const out = {}, ref = {}, unmapped = [];
  const who = (e.artistName || 'Siva').split(/\s+/)[0].toLowerCase(), rules = vendorRules();
  // Frame shop and delivery partner invoices from the supplier portal (also Zoho bills, counted once here).
  const sj = jobsOf(e), seen = new Set();
  for (const [role, f] of [['framer', 'framing'], ['delivery', 'local']]) {
    const jb = sj[role];
    // No invoice yet: the price agreed on the job stands in until their invoice (Zoho bill) comes.
    if (jb && jb.invoiceAmt == null && jb.price != null && jb.price !== '') {
      out[f] = Math.round(((out[f] || 0) + Number(jb.price)) * 100) / 100;
      ref[f] = [ref[f], `${jb.name} · job price, no invoice yet`].filter(Boolean).join('; ');
      continue;
    }
    if (jb?.invoiceAmt == null) continue;
    out[f] = Math.round(((out[f] || 0) + Number(jb.invoiceAmt)) * 100) / 100;
    ref[f] = [ref[f], `${jb.name} · ${jb.invoiceNo}${jb.billState && jb.billState !== 'open' ? ` (${jb.billState})` : ''}`].filter(Boolean).join('; ');
    if (jb.billId) seen.add(jb.billId);
  }
  for (const b of (d?.docs || []).filter((x) => x.group === 'PURCHASE' && (x.type === 'Bill' || x.type === 'Vendor bill') && x.status !== 'void' && !seen.has(x.id))) {
    const v = String(b.vendor || '').toLowerCase(), amt = Number(b.amount ?? b.total ?? 0);
    const f = b.id === e.zohoBillId || (b.type === 'Bill' && v.includes(who)) ? 'artist' : (rules.find(([m]) => v.includes(m)) || [])[1];
    if (!f) { unmapped.push(`${b.vendor || 'vendor?'} ${b.number}`); continue; }
    out[f] = Math.round(((out[f] || 0) + amt) * 100) / 100;
    ref[f] = [ref[f], `${b.vendor || ''} · ${b.number}${b.status === 'draft' ? ' (draft)' : ''}`].filter(Boolean).join('; ');
  }
  return { out, ref, unmapped, checkedAt: d?.checkedAt || null };
}
/** Actual costs: what you typed wins; otherwise the figure from Zoho. */
function actualOf(c, e) {
  const t = typedOf(c) || {};
  const z = e ? zohoActual(e).out : {};
  const m = { ...z };
  for (const [f] of ACT_FIELDS) if (t[f] != null && t[f] !== '') m[f] = t[f];
  return Object.keys(m).some((k) => ACT_FIELDS.some(([f]) => f === k)) ? m : null;
}
/** One report line: sales, refund, net sales, each cost (planned from the Costing box, actual from bills) and margin. */
function reportLine(e) {
  const c = costings.get(e.id);
  const costs = parseCosts(c);
  const price = Number(e.quotedPrice || 0);
  const refund = e.refundAction && e.refundAction !== 'DAMAGED_REPLACE' ? Number(e.refundAmount || 0) : 0;
  const vat = c?.delivery === 'OUTSIDE' ? 0 : rates.vat;
  const net = (price - refund) / (1 + vat);
  const fee = price * rates.fee;
  let k = null;
  let note = '';
  if (costs && (costs.artistAed != null || costs.framing != null)) {
    k = { artist: Number(costs.artistAed || 0), framing: Number(costs.framing || 0), india: Number(costs.indiaCourier || 0), customs: Number(costs.customs || 0), local: Number(costs.localCourier || 0) };
  } else if (c?.artistPriceInr || c?.artistPriceAed) {
    k = { artist: c.artistPriceAed ?? c.artistPriceInr * rates.fx, framing: 0, india: 0, customs: 0, local: 0 };
    note = 'costing not saved';
  } else if (e.kind === 'MARKET') {
    // Crafts shop: the maker's payout is the cost (shown in the Artist column); Kalai's courier when Kalai delivers.
    k = { artist: e.purchaseState === 'CANCELLED' ? 0 : Number(e.sellerAmount || 0), framing: 0, india: 0, customs: 0, local: e.deliveryBy === 'KALAI' && !String(e.refundAction || '').startsWith('CANCEL') ? Number(rates.local || 0) : 0 };
    note = 'crafts shop: maker payout in Artist';
  } else if (e.kind === 'GIFT') {
    k = { artist: 0, framing: Number(rates.tiers.S?.framing || 0), india: 0, customs: 0, local: Number(rates.local || 0) };
    note = 'est. from Rates';
  } else {
    note = 'no costing';
  }
  if (k && e.kind !== 'MARKET') {
    if (e.purchaseState === 'CANCELLED') { k.artist = 0; k.india = 0; k.customs = 0; }
    if (String(e.refundAction || '').startsWith('CANCEL')) { k.framing = 0; k.local = 0; }
    // 50% cancellation after Siva started: he is paid half; India courier and customs only if he had sent it.
    if (e.refundAction === 'CANCEL_HALF' && e.purchaseState !== 'CANCELLED') { k.artist *= 0.5; if (!e.artistShippedAt) { k.india = 0; k.customs = 0; } }
  }
  const rc = reworkCost(e);
  if (k) { k.rework = rc.net; k.other = 0; }
  const ins = price * (rates.ins || 0);
  const fees = fee + ins;
  const sumK = (x) => x.artist + x.framing + x.india + x.customs + x.local + x.rework + (x.other || 0);
  const total = k ? sumK(k) : null;
  const margin = k ? net - fees - total : null;
  // Actual: each cost from its bill where entered (Actual costs box), else the planned figure (marked as estimated).
  const act = actualOf(c, e);
  let ka = null, est = new Set(), haveAct = false;
  if (k) {
    ka = { ...k };
    for (const f of ACT_FIELDS.map((x) => x[0])) {
      if (act && act[f] != null && act[f] !== '') { ka[f] = Number(act[f]); haveAct = true; } else if (f !== 'other' && k[f]) est.add(f);
    }
  }
  const totalA = ka ? sumK(ka) : null;
  const marginA = ka && haveAct ? net - fees - totalA : null;
  return { e, price, refund, net: r2(net), fee: r2(fees), reserve: r2(price * (rates.reserve || 0)), rc, k, ka, est, haveAct, total: total == null ? null : r2(total), totalA: totalA == null ? null : r2(totalA),
    margin: margin == null ? null : r2(margin), marginA: marginA == null ? null : r2(marginA), pct: margin == null || !net ? null : margin / net, pctA: marginA == null || !net ? null : marginA / net, note };
}

function reportLines() {
  const from = $('rFrom').value, to = $('rTo').value, kind = $('rKind').value;
  return all
    .filter((e) => SOLD.includes(e.status || ''))
    .filter((e) => !kind || e.kind === kind)
    .filter((e) => { const d = String(e.createdAt || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to); })
    .map(reportLine);
}

function renderReport() {
  const lines = reportLines();
  const sum = (f) => lines.reduce((a, l) => a + (f(l) || 0), 0);
  const costed = lines.filter((l) => l.k);
  const basis = $('rBasis').value === 'actual';
  const withAct = costed.filter((l) => l.haveAct);
  const T = { sales: sum((l) => l.price), refund: sum((l) => l.refund), net: sum((l) => l.net), fee: sum((l) => l.fee), cost: sum((l) => (basis ? l.totalA : l.total)), margin: costed.reduce((a, l) => a + l.margin, 0), costedNet: costed.reduce((a, l) => a + l.net, 0),
    planA: withAct.reduce((a, l) => a + l.margin, 0), actA: withAct.reduce((a, l) => a + l.marginA, 0), netA: withAct.reduce((a, l) => a + l.net, 0) };
  const pct = T.costedNet ? T.margin / T.costedNet : null;
  const pctA = T.netA ? T.actA / T.netA : null;
  const tile = (k, v, cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  $('rTiles').innerHTML = [
    tile('Orders', lines.length),
    tile('Sales (AED)', money(T.sales)),
    tile('Refunds', money(T.refund)),
    tile('Net sales', money(T.net)),
    tile('Total cost', money(T.cost)),
    tile('Planned margin', `${money(T.margin)} · ${pct == null ? '–' : (pct * 100).toFixed(1) + '%'}`, T.margin < 0 ? 'neg' : ''),
    tile(`Actual margin (${withAct.length} of ${costed.length} with bills)`, withAct.length ? `${money(T.actA)} · ${pctA == null ? '–' : (pctA * 100).toFixed(1) + '%'}` : '–', T.actA < 0 ? 'neg' : ''),
    tile('Variance on those orders', withAct.length ? money(T.actA - T.planA) : '–', T.actA - T.planA < 0 ? 'neg' : ''),
    (() => { const loss = sum((l) => l.rc.cost), rec = sum((l) => l.rc.received), res = sum((l) => l.reserve); return loss || rec ? tile('Damage: cost / insurance / reserve', `${money(loss)} / ${money(rec)} / ${money(res)}`, loss - rec > res ? 'neg' : '') : ''; })(),
    (() => { const rv = lines.map((l) => reviews.get(l.e.id)).filter(Boolean); const a = avgRating(rv); return tile('Customer rating', a == null ? '–' : `${a.toFixed(1)} ★ (${rv.length})`, a != null && a < 4 ? 'neg' : ''); })(),
  ].join('') + (lines.length - costed.length ? `<div class="tile"><div class="k">Without costing</div><div class="v neg">${lines.length - costed.length}</div></div>` : '');
  const td = (v, cls = '') => `<td class="num ${cls}">${money(v)}</td>`;
  $('rRows').innerHTML = lines.length ? lines.map((l) => {
    const d = l.e.createdAt ? new Date(l.e.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
    return `<tr data-id="${esc(l.e.id)}" tabindex="0"><td>${esc(d)}</td><td class="mono">${esc(l.e.ref)}</td>
      <td style="white-space:normal;min-width:160px">${esc(l.e.title)}${l.note ? `<br><span class="flag">${esc(l.note)}</span>` : ''}</td><td>${esc(l.e.customerName)}</td>
      <td><span class="pill ${esc(l.e.status)}">${esc(STATUS[l.e.status] || l.e.status)}</span></td>
      ${td(l.price)}${td(l.refund || null)}${td(l.net)}${['artist', 'framing', 'india', 'customs', 'local'].map((f) => { const kk = basis ? l.ka : l.k; return td(kk?.[f], basis && l.haveAct && l.est.has(f) ? 'est' : ''); }).join('')}${td((basis ? l.ka : l.k)?.rework || null, l.k?.rework > 0 ? 'neg' : '')}${td(l.fee)}${td(basis ? l.totalA : l.total)}
      ${td(l.margin, l.margin != null && l.margin < 0 ? 'neg' : '')}${td(l.marginA, l.marginA != null && l.marginA < 0 ? 'neg' : '')}${l.marginA == null ? '<td class="num muted">–</td>' : td(l.marginA - l.margin, l.marginA - l.margin < 0 ? 'neg' : '')}
      ${(() => { const p = l.pctA ?? l.pct; return `<td class="num ${p != null && p < Math.min(0.1, marginFor(l.e.kind)) ? 'neg' : ''}" title="${l.pctA != null ? 'Actual' : 'Planned'} · target ${Math.round(marginFor(l.e.kind) * 100)}%">${p == null ? '–' : (p * 100).toFixed(1) + '%'}${l.pctA != null ? '' : ' <span class="muted" style="font-size:10px">plan</span>'}</td>`; })()}</tr>`;
  }).join('') : '<tr><td colspan="20" class="muted">No paid orders in this period.</td></tr>';
  const k = (f) => costed.reduce((a, l) => a + (f(basis ? l.ka : l.k) || 0), 0);
  $('rFoot').innerHTML = lines.length ? `<tr><td colspan="5">Total (${lines.length} orders)</td>${td(T.sales)}${td(T.refund || null)}${td(T.net)}${td(k((x) => x.artist))}${td(k((x) => x.framing))}${td(k((x) => x.india))}${td(k((x) => x.customs))}${td(k((x) => x.local))}${td(k((x) => x.rework) || null)}${td(T.fee)}${td(T.cost)}${td(T.margin, T.margin < 0 ? 'neg' : '')}${withAct.length ? td(T.actA, T.actA < 0 ? 'neg' : '') : '<td class="num">–</td>'}${withAct.length ? td(T.actA - T.planA, T.actA - T.planA < 0 ? 'neg' : '') : '<td class="num">–</td>'}<td class="num">${pct == null ? '–' : (pct * 100).toFixed(1) + '%'}</td></tr>` : '';
  $('rRows').querySelectorAll('tr[data-id]').forEach((tr) => {
    const open = () => { const e = all.find((x) => x.id === tr.dataset.id); if (!e) return; showPane('orders', 'tabOrders'); selectedId = e.id; render(); showDetail(e); };
    tr.onclick = open;
    tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); };
  });
}

['rFrom', 'rTo', 'rKind', 'rBasis'].forEach((id) => $(id).addEventListener('change', renderReport));
// Read the bills in Zoho for every order in the report (Check Zoho for each), then redraw with the actual costs.
$('rZoho').onclick = async () => {
  const lines = reportLines().filter((l) => l.e.kind !== 'MARKET'), b = $('rZoho');
  b.disabled = true;
  let done = 0;
  for (const l of lines) {
    b.textContent = `Reading Zoho… ${++done}/${lines.length}`;
    try { await client.mutations.checkZoho({ id: l.e.id }); } catch { /* next */ }
  }
  await loadCostings();
  b.textContent = 'Get actual costs from Zoho'; b.disabled = false;
  renderReport();
};
$('rCsv').onclick = () => {
  const head = ['Date', 'Ref', 'Order', 'Customer', 'Status', 'Sales', 'Refund', 'Net sales', 'Artist', 'Framing', 'India courier', 'Customs', 'Local courier', 'Rework (net of insurance)', 'Fees & insurance', 'Planned total cost', 'Planned margin', 'Planned margin %', 'Actual artist', 'Actual framing', 'Actual India courier', 'Actual customs', 'Actual local courier', 'Actual other', 'Actual total cost (planned where no bill)', 'Actual margin', 'Actual margin %', 'Variance', 'Note'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = reportLines().map((l) => [String(l.e.createdAt || '').slice(0, 10), l.e.ref, l.e.title, l.e.customerName, STATUS[l.e.status] || l.e.status,
    l.price, l.refund, l.net, l.k ? r2(l.k.artist) : '', l.k ? r2(l.k.framing) : '', l.k ? r2(l.k.india) : '', l.k ? r2(l.k.customs) : '', l.k ? r2(l.k.local) : '', l.k ? r2(l.k.rework) : '',
    l.fee, l.total ?? '', l.margin ?? '', l.pct == null ? '' : (l.pct * 100).toFixed(1) + '%',
    ...['artist', 'framing', 'india', 'customs', 'local', 'other'].map((f) => { const a = actualOf(costings.get(l.e.id), l.e); return a && a[f] != null && a[f] !== '' ? r2(Number(a[f])) : ''; }),
    l.haveAct ? l.totalA : '', l.marginA ?? '', l.pctA == null ? '' : (l.pctA * 100).toFixed(1) + '%', l.marginA == null ? '' : r2(l.marginA - l.margin), l.note]);
  const csv = [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `kalai-orders-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
};
$('fStatus').onchange = render;
let searchT;
$('fSearch').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(render, 200); });
['fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', render));
$('fCust').addEventListener('change', render);
$('fClear').onclick = () => { $('fSearch').value = ''; $('fCust').value = ''; $('fFrom').value = ''; $('fTo').value = ''; $('fStatus').value = ''; $('fKind').value = ''; render(); };
// Click a customer code on an order: list all that customer's orders.
document.addEventListener('click', (ev) => { const b = ev.target.closest?.('[data-cust]'); if (!b) return; fillFinders(); $('fCust').value = b.dataset.cust; $('fSearch').value = ''; $('fStatus').value = ''; render(); });
// Dropdowns: order numbers (type to narrow) and customers (name · code · number of orders).
const custOf = (e) => e.customerCode || `n:${String(e.customerName || e.email || e.phone || '').trim().toLowerCase()}`;
let finderSig = '';
function fillFinders() {
  const sig = all.map((e) => e.id + (e.customerCode || '')).join();
  if (sig === finderSig) return;
  finderSig = sig;
  $('dlOrders').innerHTML = all.filter((e) => e.ref).map((e) => `<option value="${esc(e.ref)}">${esc(`${e.customerName || ''} · ${e.title || ''}`.slice(0, 80))}</option>`).join('');
  const cs = new Map();
  all.forEach((e) => { const k = custOf(e); const c = cs.get(k) || { k, name: e.customerName || e.email || e.phone || 'No name', code: e.customerCode || '', n: 0 }; c.n++; cs.set(k, c); });
  const cur = $('fCust').value;
  $('fCust').innerHTML = '<option value="">All customers</option>' + [...cs.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<option value="${esc(c.k)}">${esc(c.name)}${c.code ? ` · ${esc(c.code)}` : ''} (${c.n})</option>`).join('');
  $('fCust').value = cs.has(cur) ? cur : '';
}
$('fKind').onchange = render;

// Approved portal artists, for allocating price enquiries / commissions (Siva is the default).
let artists = [];
async function loadArtists() {
  const r = await client.models.SellerProfile.list({ limit: 500 });
  artists = (r.data || []).filter((p) => p.type === 'ARTIST' && p.status === 'APPROVED').sort((a, b) => String(a.business).localeCompare(String(b.business)));
  suppliers = (r.data || []).filter((p) => (p.type === 'FRAMER' || p.type === 'COURIER') && p.status === 'APPROVED').sort((a, b) => String(a.business).localeCompare(String(b.business)));
}
let suppliers = []; // approved frame shops (FRAMER) and delivery partners (COURIER)
// Price lists change in the supplier portal (often in another tab): reload when coming back to this tab.
window.addEventListener('focus', () => { loadArtists().catch(() => {}); });
const jobsOf = (e) => { let v = costings.get(e.id)?.supplierJobs; try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; } return v && typeof v === 'object' ? v : {}; };
const JOB_STAGE = { ASSIGNED: 'sent, waiting to accept', ACCEPTED: 'accepted', READY: 'framed, ready for pickup', COLLECTED: 'collected', PICKED: 'picked up (Shipped)', DELIVERED: 'delivered' };
/** Frame shop & delivery partner for a paid order (supplier portal). */
// WhatsApp the job to the supplier (message typed in; you press Send): handy for shops that don't use the portal yet.
function jobWa(e, cur, role, spec) {
  const sp = suppliers.find((x) => x.id === cur.supplierId);
  const n = String(sp?.phone || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(?=5)/, '971');
  if (n.length < 9) return '';
  const det = parseDetails(e.details);
  const to = [e.deliveryName || e.customerName, e.deliveryPhone || e.phone, [e.deliveryAddress, e.deliveryEmirate, e.deliveryCountry && e.deliveryCountry !== 'UAE' ? e.deliveryCountry : ''].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const lines = role === 'framer'
    ? [`Kalai Art House framing job ${e.ref}: ${e.title}`, `Frame: ${(RC_STYLES.find((x) => x[0] === spec.style) || ['', spec.style])[1]}, ${spec.size}${det.Framing ? ` (${det.Framing})` : ''}`, det['Card message'] ? `Card message: ${det['Card message']}` : '',
      cur.price != null ? `Agreed price: AED ${cur.price}` : '', cur.due ? `Please finish by ${cur.due}` : '', cur.note ? `Note: ${cur.note}` : '', cur.canDeliver ? `Please also deliver to: ${to}${cur.deliveryPrice != null ? ` (AED ${cur.deliveryPrice})` : ''}` : '',
      sp?.owner ? 'Details and photo: art.pranixtechno.com/supplier.html' : 'I will send you the photo here.']
    : [`Kalai Art House delivery job ${e.ref}: ${e.title}`, j0(e) ? `Pick up from: ${j0(e)}` : 'Pick up from: Kalai Art House (we confirm the point)', `Deliver to: ${to}`, cur.price != null ? `Agreed price: AED ${cur.price}` : '', cur.due ? `By ${cur.due}` : '', cur.note ? `Note: ${cur.note}` : '',
      sp?.owner ? 'Details: art.pranixtechno.com/supplier.html' : ''];
  return `<a class="btn small ghost" style="padding:2px 8px;font-size:12px" target="_blank" rel="noopener" href="https://wa.me/${n}?text=${encodeURIComponent(lines.filter(Boolean).join('\n'))}">WhatsApp</a>`;
}
// The chosen frame shop's frames in this style (its catalogue), as a hint for the note.
function framesOf(id, style) {
  const sp = suppliers.find((x) => x.id === id); let list = [];
  try { list = JSON.parse(sp?.catalogue || '[]') || []; } catch { list = []; }
  const m = list.filter((f) => f.style === style);
  return m.length ? `<span class="muted" style="font-size:12px">Their ${esc(style)} frames: ${m.map((f) => `${esc(f.name)}${f.widthMm ? ` ${esc(f.widthMm)} mm` : ''}${f.extra ? ` (+AED ${esc(f.extra)})` : ''}`).join('; ')}</span><br>` : '';
}
// The frame shop's name, phone and address, as the delivery pickup point.
function j0(e) { const fj = jobsOf(e).framer; const sp = fj && suppliers.find((x) => x.id === fj.supplierId); return sp ? [sp.business, sp.phone, sp.address].filter(Boolean).join(', ') : ''; }
function supplierSection(e) {
  if (!SOLD.includes(e.status || '') || e.kind === 'MARKET') return '';
  const j = jobsOf(e);
  // Each supplier's price for this order from their price list (frame style + size; destination and parcel size).
  const spec = specOf(e, parseDetails(e.details));
  const costFor = (s, role) => (role === 'framer' ? frameCost(parseCard(s), spec) : deliveryCost(parseCard(s), e, spec, zoneOf));
  const row = (role, label, type) => {
    const cur = j[role];
    // Delivery: delivery partners, and frame shops that deliver (delivery charges in their price list).
    const list = suppliers.filter((s) => s.type === type || (role === 'delivery' && s.type === 'FRAMER' && Object.keys(parseCard(s).uae || {}).length)).map((s) => ({ ...s, cost: costFor(s, role), shop: s.type === 'FRAMER' && role === 'delivery' }))
      .sort((a, b) => (a.cost == null) - (b.cost == null) || (a.cost ?? 0) - (b.cost ?? 0) || String(a.business).localeCompare(String(b.business)));
    const best = list.find((s) => s.cost != null);
    const locked = cur && !['ASSIGNED', 'ACCEPTED'].includes(cur.stage);
    const self = role === 'delivery' && cur && j.framer && cur.supplierId === j.framer.supplierId;
    return `<div style="display:grid;gap:6px;padding:8px 0;border-top:1px solid var(--line)">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b>${label}</b>${cur ? jobWa(e, cur, role, spec) : ''}${cur ? `<span class="muted">${esc(cur.name)} · ${esc(JOB_STAGE[cur.stage] || cur.stage)}${cur.awb ? ` · AWB ${esc(cur.awb)}` : ''}${cur.invoiceNo ? ` · invoice ${esc(cur.invoiceNo)} ${aed(cur.invoiceAmt, 2)}${cur.bill ? ` → Zoho bill ${esc(cur.bill)}${cur.billState && cur.billState !== 'open' ? ` (${esc(cur.billState)})` : ''}` : ''}` : ''}${cur.message ? ` · <span class="warn-t">${esc(cur.message)}</span>` : ''}</span>` : '<span class="muted">not given yet</span>'}</div>
      ${self ? '<div class="muted" style="font-size:12px">The frame shop delivers this one itself.</div>' : locked ? '' : `<div class="three" style="align-items:end">
        <div class="field" style="grid-column:1/-1"><label>${role === 'framer' ? 'Frame shop' : 'Delivery partner'}</label><select data-js="${role}-sid"><option value="">${list.length ? 'Choose…' : `none approved yet (Artists & sellers → Frame shops & delivery)`}</option>${list.map((s) => `<option value="${esc(s.id)}" data-cost="${s.cost ?? ''}" ${cur?.supplierId === s.id ? 'selected' : ''}>${esc(s.business)}${s.shop ? ' (frame shop)' : ''} · ${s.cost != null ? `AED ${s.cost}` : 'no price for this'}${s.emirate ? ` · ${esc(s.emirate)}` : ''}</option>`).join('')}</select>
          ${role === 'framer' && cur ? framesOf(cur.supplierId, spec.style) : ''}<span class="muted" style="font-size:12px">${role === 'framer' ? `${esc((RC_STYLES.find((x) => x[0] === spec.style) || ['', spec.style === 'none' ? 'No frame' : spec.style])[1])}, ${esc(spec.size)}` : `${esc(e.deliveryEmirate || e.deliveryCountry || 'address not set')}, ${esc(spec.size)} frame`}${best ? ` · cheapest: ${esc(best.business)} AED ${best.cost}` : ' · no price lists yet'}</span></div>
        <div class="field"><label>Price you pay them (AED)</label><input data-js="${role}-price" type="number" min="0" step="1" value="${cur?.price ?? ''}"></div>
        <div class="field"><label>Finish by</label><input data-js="${role}-due" type="date" value="${esc(cur?.due || '')}"></div></div>
        <div class="field"><label>${role === 'framer' ? 'Note for them (frame style, size, glass, timing…)' : 'Note for them (pickup time, contact, handling…)'}</label><input data-js="${role}-note" maxlength="500" value="${esc(cur?.note || '')}"></div>
        ${role === 'framer' && !j.delivery ? `<label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" data-js="framer-deliver" style="width:auto" ${cur?.canDeliver ? 'checked' : ''}> Ask them to deliver too, for AED <input data-js="framer-dprice" type="number" min="0" step="1" value="${cur?.deliveryPrice ?? ''}" style="width:90px"> (they confirm when accepting)</label>` : ''}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn small" data-jobsend="${role}">${cur ? 'Update the job' : 'Send the job'}</button>${cur ? `<button type="button" class="btn small ghost" data-jobremove="${role}">Take it back</button>` : ''}<span class="muted" data-jobmsg="${role}" style="font-size:12px"></span></div>`}
    </div>`;
  };
  return `<fieldset class="cost" id="supplierBox"><legend>Frame shop &amp; delivery</legend>
    <div class="muted" style="font-size:12px">They see this order in their supplier portal: the photo, frame spec and size, your price, and the pickup and delivery addresses. Their steps update the order (Being framed, Shipped, Delivered) and their invoice becomes a Zoho bill.</div>
    ${row('framer', 'Framing', 'FRAMER')}${row('delivery', 'Delivery', 'COURIER')}</fieldset>`;
}
function wireSuppliers(e) {
  const box = $('supplierBox'); if (!box) return;
  const v = (k) => box.querySelector(`[data-js="${k}"]`);
  ['framer', 'delivery'].forEach((role) => {
    const sel = v(`${role}-sid`), pr = v(`${role}-price`);
    if (sel && pr) sel.onchange = () => {
      const c = sel.selectedOptions[0]?.dataset.cost; if (c) pr.value = c;
      // The frame shop's own delivery charge for this address, for "Ask them to deliver too".
      if (role === 'framer' && v('framer-dprice') && !v('framer-dprice').value) { const sp = suppliers.find((x) => x.id === sel.value); const dc = sp ? deliveryCost(parseCard(sp), e, specOf(e, parseDetails(e.details)), zoneOf) : null; if (dc != null) v('framer-dprice').value = dc; }
    };
    // Not given yet: start with the cheapest supplier that has a price. Given without a price: take it from their price list.
    if (sel && pr && !sel.value) { const o = [...sel.options].find((x) => x.value && x.dataset.cost); if (o) sel.value = o.value; }
    if (sel && pr && !pr.value) { const c = sel.selectedOptions[0]?.dataset.cost; if (c) pr.value = c; }
  });
  box.querySelectorAll('[data-jobsend],[data-jobremove]').forEach((b) => {
    b.onclick = async () => {
      const role = b.dataset.jobsend || b.dataset.jobremove, remove = !!b.dataset.jobremove;
      const msg = box.querySelector(`[data-jobmsg="${role}"]`);
      const data = { id: e.id, role };
      if (!remove) {
        data.supplierId = v(`${role}-sid`).value;
        if (!data.supplierId) { msg.textContent = 'Choose who does it.'; return; }
        data.price = v(`${role}-price`).value; data.due = v(`${role}-due`).value; data.note = v(`${role}-note`).value.trim();
        if (role === 'framer' && v('framer-deliver')) { data.canDeliver = v('framer-deliver').checked; data.deliveryPrice = v('framer-dprice').value; }
      }
      b.disabled = true; msg.textContent = remove ? 'Taking it back…' : 'Sending…';
      try {
        const r = await client.mutations.marketAdmin({ action: remove ? 'removeJob' : 'assignJob', data: JSON.stringify(data) });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        costings.set(e.id, { ...(costings.get(e.id) || { enquiryId: e.id }), supplierJobs: JSON.stringify(out.jobs || {}) });
        box.outerHTML = supplierSection(e); wireSuppliers(e);
        $('supplierBox').querySelector(`[data-jobmsg="${role}"]`) && ($('supplierBox').querySelector(`[data-jobmsg="${role}"]`).textContent = remove ? 'Taken back; they were emailed.' : 'Sent: they were emailed and see it in their portal.');
      } catch (ex) { msg.textContent = ex.message; b.disabled = false; }
    };
  });
}
let codesAsked = false;
let curAed = false; // the open order's artist prices in AED (artist in the UAE)

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
    await loadReviews().catch(() => {});
    await loadArtists().catch(() => {});
    // Older enquiries (before codes existed) get their customer code once, then the list reloads.
    // Once per visit: codes for new enquiries, and one code per customer (guest + signed-in orders joined up).
    if (!codesAsked) {
      codesAsked = true;
      client.mutations.assignCodes().then((r) => { let o = r?.data; try { if (typeof o === 'string') o = JSON.parse(o); } catch { o = null; } if (!o || o.customers || o.artworks || items.some((e) => !e.customerCode)) load(); }).catch(() => {});
    }
    render();
    if (!$('reportsPane').hidden) renderReport();
    if (!$('feedbackPane').hidden) renderFeedback();
    if (selectedId) { const e = all.find((x) => x.id === selectedId); if (e) showDetail(e); }
  } catch (ex) {
    if (sessionGone(ex)) return;
    $('rows').innerHTML = `<tr><td colspan="7" class="err">Could not load enquiries: ${esc(ex.message)}</td></tr>`;
  }
}

function render() {
  const fs = $('fStatus').value, fk = $('fKind').value;
  const counts = {};
  all.forEach((e) => { const s = e.status || 'RECEIVED'; counts[s] = (counts[s] || 0) + 1; });
  // Click a count to show only those orders; click it again (or "All") to show everything.
  $('counts').innerHTML = (all.length ? `<button type="button" class="count" data-st="" aria-pressed="${!fs}">All <b>${all.length}</b></button>` : '')
    + (Object.keys(STATUS).filter((k) => counts[k])
      .map((k) => `<button type="button" class="count" data-st="${k}" aria-pressed="${fs === k}">${STATUS[k]} <b>${counts[k]}</b></button>`).join('') || '<span class="muted">No enquiries yet.</span>');
  const reqs = all.filter(isReq).length;
  if (reqs) $('counts').insertAdjacentHTML('afterbegin', `<button type="button" class="count req" data-st="__REQ" aria-pressed="${fs === '__REQ'}">Customer requests <b>${reqs}</b></button>`);
  $('counts').querySelectorAll('[data-st]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.st === fs ? '' : b.dataset.st;
      if (v && ![...$('fStatus').options].some((o) => o.value === v)) $('fStatus').insertAdjacentHTML('beforeend', `<option value="${v}">${v === '__REQ' ? 'Customer requests' : esc(STATUS[v] || v)}</option>`);
      $('fStatus').value = v;
      render();
    };
  });
  // Search: order no., customer name, mobile, email, customer code, artwork code / title; dates in Dubai time.
  fillFinders();
  // Types with no orders yet (e.g. Crafts shop before the first seller) are hidden from the Type filter.
  [...$('fKind').options].forEach((o) => { if (o.value) o.hidden = !all.some((e) => e.kind === o.value) && $('fKind').value !== o.value; });
  const q = $('fSearch').value.trim().toLowerCase(), from = $('fFrom').value, to = $('fTo').value, fc = $('fCust').value;
  const dubaiDay = (iso) => (iso ? new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 10) : '');
  // Order box: order no., title, artwork code (in the details). Customer: the dropdown.
  const hit = (e) => (!fc || custOf(e) === fc) && (!q || [e.ref, e.title, typeof e.details === 'string' ? e.details : JSON.stringify(e.details || '')]
    .some((v) => String(v || '').toLowerCase().includes(q)));
  const list = all.filter((e) => (!fs || (fs === '__REQ' ? isReq(e) : (e.status || 'RECEIVED') === fs)) && (!fk || e.kind === fk)
    && hit(e) && (!from || dubaiDay(e.createdAt) >= from) && (!to || dubaiDay(e.createdAt) <= to));
  $('rows').innerHTML = list.length ? list.map((e) => {
    const s = e.status || 'RECEIVED';
    const d = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
    return `<tr data-id="${esc(e.id)}" tabindex="0" class="${e.id === selectedId ? 'sel' : ''}">
      <td>${esc(d)}</td><td class="mono">${esc(e.ref)}</td><td>${esc(KIND[e.kind] || '')}</td>
      <td style="white-space:normal;min-width:180px">${esc(e.title)}</td><td>${esc(e.customerName)}${e.customerCode ? `<br><span class="muted mono" style="font-size:11px">${esc(e.customerCode)}</span>` : ''}</td>
      <td><span class="pill ${s}">${esc(STATUS[s] || s)}</span>${!e.owner ? ' <span class="chip" title="Sent without signing in: the customer can\'t track it online; reply on WhatsApp">Guest</span>' : ''}${isReq(e) ? ` <span class="chip req">${e.cancelRequest === 'CANCEL' ? 'Cancel request' : 'Damage reported'}</span>` : ''}${hasArtist(e) && !costings.get(e.id)?.artistPriceInr && !costings.get(e.id)?.artistPriceAed && !['CANCELLED', 'DELIVERED'].includes(s) ? ` <span class="chip" title="${esc(e.artistName || 'Siva')} hasn't priced this yet">Artist price needed</span>` : ''}${e.artistName ? ` <span class="chip">${esc(e.artistName)}</span>` : ''}${isLocked(e) ? ' <span title="Payment recorded in Zoho" aria-label="Payment recorded in Zoho">🔒</span>' : e.zohoState === 'ERROR' ? ' <span title="Zoho error" aria-label="Zoho error" style="color:var(--kumkum)">⚠</span>' : ''}</td>
      <td class="mono">${e.quotedPrice ? 'AED ' + Number(e.quotedPrice).toLocaleString('en-US') : '–'}</td></tr>`;
  }).join('') : `<tr><td colspan="7" class="muted">${$('fFrom').value || $('fTo').value ? 'No orders on these dates. Press <b>Clear</b> to see all dates.' : 'Nothing matches this filter.'}</td></tr>`;
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

/** Actual costs from the bills (paid orders): plan vs actual for this order; Reports adds them up. */
function actualSection(e) {
  if (!SOLD.includes(e.status || '') || e.kind === 'MARKET') return '';
  const l = reportLine(e), a = typedOf(costings.get(e.id)) || {}, ref = a.ref || {}, z = zohoActual(e);
  const plan = (f) => (l.k && f !== 'other' ? r2(l.k[f] || 0) : null);
  const rows = ACT_FIELDS.map(([f, label]) => `<tr><td>${label}</td><td class="num mono">${plan(f) == null ? '–' : money(plan(f))}</td>
    <td class="num mono" title="${esc(z.ref[f] || '')}">${z.out[f] != null ? money(z.out[f]) : '–'}${z.ref[f] ? `<div class="muted" style="font-size:10px;font-family:inherit;white-space:normal">${esc(z.ref[f])}</div>` : ''}</td>
    <td><input data-act="${f}" type="number" min="0" step="0.01" value="${a[f] ?? ''}" placeholder="${z.out[f] != null ? 'uses that' : 'bill amount'}" style="width:110px"></td>
    <td><input data-actref="${f}" maxlength="80" value="${esc(ref[f] || '')}" placeholder="vendor · bill no." style="min-width:140px"></td></tr>`).join('');
  const mv = l.marginA != null ? `Planned margin <b>${money(l.margin)}</b> · actual <b class="${l.marginA < 0 ? 'neg' : ''}">${money(l.marginA)}</b> · variance <b class="${l.marginA - l.margin < 0 ? 'neg' : ''}">${money(l.marginA - l.margin)}</b>` : `Planned margin <b>${l.margin == null ? '–' : money(l.margin)}</b>. Enter the bills as they come; costs without a bill stay at the planned figure.`;
  return `<fieldset class="cost" id="actualBox"><legend>Actual costs (from bills, AED)</legend>
    <div class="tablewrap"><table class="costs"><thead><tr><th>Cost</th><th class="num">Planned</th><th class="num">From Zoho / job</th><th>Your figure</th><th>Vendor · bill no.</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="font-size:12px">From Zoho: the artist's bill and vendor bills whose Reference# contains ${esc(e.ref)} (press Check Zoho to refresh${z.checkedAt ? `; checked ${esc(when(z.checkedAt))}` : ''}); until the frame shop or courier invoices, the price on their job. Your figure, if typed, is used instead.${z.unmapped.length ? ` <b class="warn-t">Not matched to a cost: ${esc(z.unmapped.join(', '))}</b>: add the vendor under Rates → Zoho vendors.` : ''}</div>
    <div class="marginline" id="actSum">${mv}</div>
    <div style="display:flex;gap:8px;align-items:center"><button type="button" class="btn small" onclick="window.kalaiSaveActual('${esc(e.id)}')">Save actual costs</button><span class="muted" id="actMsg" style="font-size:12px">${a.at ? `Last saved ${esc(when(a.at))}` : ''}</span></div></fieldset>`;
}
window.kalaiSaveActual = async (id) => {
  const e = all.find((x) => x.id === id); if (!e) return;
  const box = $('actualBox'), out = { ref: {} };
  for (const [f, label] of ACT_FIELDS) {
    const raw = box.querySelector(`[data-act="${f}"]`).value.trim();
    if (raw !== '') { const v = Number(raw); if (!(v >= 0)) { $('actMsg').textContent = `${label}: enter an amount in AED.`; return; } out[f] = Math.round(v * 100) / 100; }
    const rf = box.querySelector(`[data-actref="${f}"]`).value.trim(); if (rf) out.ref[f] = rf;
  }
  out.at = new Date().toISOString();
  $('actMsg').textContent = 'Saving…';
  try {
    const existing = costings.get(id);
    const rec = { enquiryId: id, actual: JSON.stringify(out) };
    const res = existing ? await client.models.Costing.update(rec) : await client.models.Costing.create(rec);
    if (res.errors?.length) throw new Error(res.errors[0].message);
    costings.set(id, res.data || { ...existing, ...rec });
    const l = reportLine(e);
    $('actSum').innerHTML = l.marginA != null ? `Planned margin <b>${money(l.margin)}</b> · actual <b class="${l.marginA < 0 ? 'neg' : ''}">${money(l.marginA)}</b> · variance <b class="${l.marginA - l.margin < 0 ? 'neg' : ''}">${money(l.marginA - l.margin)}</b>` : 'Saved.';
    $('actMsg').textContent = 'Saved. Reports show plan vs actual.';
  } catch (ex) { $('actMsg').textContent = ex.message; }
};

function costingSection(e) {
  if (!hasArtist(e)) return '';
  const c = costings.get(e.id) || {};
  const lockedPO = !!e.zohoPOId;
  const dis = lockedPO ? 'disabled' : '';
  curAed = !!e.artistId && e.artistCountry !== 'India';
  curEnq = e;
  const who = e.artistName || 'Siva';
  const artistOpts = `<option value="">Siva Raja (Artist desk)</option>${artists.map((a) => `<option value="${esc(a.id)}" data-name="${esc(a.business)}" data-country="${esc(a.country || 'UAE')}" ${a.id === e.artistId ? 'selected' : ''}>${esc(a.business)} (${esc(a.country || 'UAE')}${a.mediums ? ` · ${esc(a.mediums)}` : ''})</option>`).join('')}${e.artistId && !artists.some((a) => a.id === e.artistId) ? `<option value="${esc(e.artistId)}" selected>${esc(e.artistName || 'Artist')}</option>` : ''}`;
  const tierOpts = Object.entries(rates.tiers).map(([k, t]) => `<option value="${k}" ${c.sizeTier === k ? 'selected' : ''}>${k} · ${esc(t.label)}</option>`).join('');
  const fromSiva = c.artistAt
    ? `${c.artistBy && /^Kalai Art House/.test(c.artistBy) ? `Entered by you on ${esc(who)}’s behalf` : `From ${esc(c.artistBy || who)}`} ${esc(when(c.artistAt))}${c.artistReadyBy ? ` · ready by ${esc(c.artistReadyBy)}` : ''}${c.artistNote ? ` · “${esc(c.artistNote)}”` : ''}`
    : (c.artistPriceInr ?? c.artistPriceAed) != null ? `Entered by you on ${esc(who)}’s behalf.`
    : `${esc(who)} hasn't priced this yet (${e.artistId ? 'artist portal → Commissions' : 'Artist desk'}). You can also type the price here.`;
  return `<fieldset class="cost" id="costing">
    <legend>Costing ${lockedPO ? `<span class="muted">· locked: ${esc(e.zohoPO)} placed</span>` : ''}</legend>
    ${rates.saved ? '' : '<div class="muted warnline">Rates are placeholders. Set the real ones under <b>Rates</b>.</div>'}
    <div class="field"><label for="cArtist">Artist doing this work</label><select id="cArtist" ${dis}>${artistOpts}</select>
      <span class="muted" style="font-size:12px" id="cArtistNote">${lockedPO ? 'Fixed: the order has been placed with this artist.' : e.artistId ? `Allocated to ${esc(who)}: they see it under Commissions in their portal.` : 'Siva sees it on his Artist desk. Choose another approved artist to allocate it to them (they get an email when you save).'}</span></div>
    <div class="three">
      <div class="field"><label for="cInr" id="cInrLabel">Artist price (${curAed ? 'AED' : 'INR'})</label><input id="cInr" type="number" min="0" step="1" value="${(curAed ? c.artistPriceAed : c.artistPriceInr) ?? ''}" ${dis}></div>
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

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');
// Status control linked to Siva's page: the work must have left Siva (his "Sent to frame shop") before
// it can be framed or shipped. Replacements follow their own rework checks; Little Artists has no Siva step.
const AFTER_SIVA = ['FRAMING', 'SHIPPED', 'DELIVERED'];
const needsSiva = (e) => hasArtist(e) && !!e.zohoPOId && e.purchaseState !== 'CANCELLED' && e.refundAction !== 'DAMAGED_REPLACE';
const sivaDone = (e) => e.artistStage === 'SHIPPED';
function statusBlock(e, k, s) {
  if (k === s) return '';
  if (e.kind === 'MARKET' && k === 'FRAMING') return 'not for crafts';
  if (needsSiva(e) && !sivaDone(e) && AFTER_SIVA.includes(k)) return 'waiting for Siva';
  if (k === 'DELIVERED' && !['SHIPPED', 'DELIVERED'].includes(s)) return 'ship it first';
  return '';
}

function sivaProgress(e) {
  const stopped = String(e.refundAction || '').startsWith('CANCEL') && ['REFUNDED', 'CANCELLED'].includes(e.status) && e.purchaseState !== 'CANCELLED' && e.zohoPOId;
  if (stopped) return `Stopped: customer cancelled after he started${e.artistStartedAt ? ` (${day(e.artistStartedAt)})` : ''}. He is paid 50% of his price${costings.get(e.id)?.artistPriceInr ? ` (INR ${(costings.get(e.id).artistPriceInr / 2).toLocaleString('en-IN')})` : ''}${e.artistShippedAt ? ' plus the India courier' : ''}: enter his invoice no. and the bill is made for that.`;
  if (!e.artistStage) return e.zohoPOId ? "Siva hasn't marked this as started yet." : '';
  return [`Started ${day(e.artistStartedAt)}`, e.artistFinishedAt ? `Finished ${day(e.artistFinishedAt)}` : '', e.artistShippedAt ? `Sent to frame shop ${day(e.artistShippedAt)}${e.artistAwb ? ` (${e.artistCourier} · AWB ${e.artistAwb})` : ''}` : '',
    e.artistBy ? `last update by ${e.artistBy === 'Siva' ? 'Siva' : 'you, on his behalf'}` : ''].filter(Boolean).join(' · ');
}

function purchaseSection(e) {
  if (!hasArtist(e) || !(isLocked(e) || e.zohoState === 'TEST')) return '';
  const st = e.purchaseState || '';
  const color = st === 'ARTIST_PAID' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : 'var(--muted)';
  return `<fieldset class="cost" id="purchase">
    <legend>${esc(e.artistName || 'Siva Raja')} (purchase)</legend>
    <div style="font-size:14px;color:${color};overflow-wrap:anywhere">${esc(e.purchaseMessage || 'Siva\'s order is recorded once the customer has paid and the costing has his price.')}</div>
    ${sivaProgress(e) ? `<div style="font-size:13px"><b>${esc(e.artistName || 'Siva')}'s progress:</b> ${esc(sivaProgress(e))}</div>` : ''}
    <div class="two">
      <div class="field"><label for="pInv">${esc(e.artistName || 'Siva')}'s invoice no.</label><input id="pInv" value="${esc(e.artistInvoiceNo)}" placeholder="From his invoice" ${!e.zohoPOId || e.zohoBillId ? 'disabled' : ''}></div>
      <div class="field"><label for="pPaid">Paid to ${esc(e.artistName || 'Siva')}: bank ref</label><input id="pPaid" value="${esc(e.artistPaidRef)}" placeholder="Transfer reference" ${!e.zohoPOId || e.zohoVendorPaymentId ? 'disabled' : ''}></div>
    </div>
    <div class="muted" style="font-size:12px">Save with his invoice number to create the bill in Zoho; save with your bank reference to record the payment made to him.</div>
  </fieldset>`;
}

// ---------- Crafts shop order: the maker's side and their payout ----------
function marketSection(e) {
  if (e.kind !== 'MARKET') return '';
  const kalai = e.deliveryBy === 'KALAI';
  const st = e.purchaseState || '';
  const color = st === 'SELLER_PAID' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : 'var(--muted)';
  const kalaiEarns = Number(e.quotedPrice || 0) - Number(e.sellerAmount || 0);
  const stage = e.sellerStage === 'READY' ? `Packed, ready for pickup (${day(e.sellerReadyAt)})` : e.sellerStage === 'DISPATCHED' ? `Dispatched by the maker ${day(e.sellerDispatchedAt)}` : e.sellerStage === 'DELIVERED' ? 'Maker confirmed delivery' : st ? (kalai ? 'Waiting for the maker to pack it' : 'Waiting for the maker to dispatch it') : 'Not sent to the maker yet (happens automatically when Paid)';
  return `<fieldset class="cost" id="marketBox">
    <legend>Crafts shop · ${esc(e.sellerName)}</legend>
    <div style="font-size:14px">${esc(e.title)} × ${e.qty || 1} · customer pays ${aed(e.quotedPrice)} · maker receives <b>${aed(e.sellerAmount, 2)}</b> · Kalai keeps ${aed(kalaiEarns, 2)} (${e.commissionPct ?? 0}%${kalai ? ' + delivery fee' : ''})</div>
    <div style="font-size:13px"><b>${kalai ? 'Kalai collects from the maker and delivers' : 'The maker delivers'}</b> · ${esc(stage)}</div>
    ${e.purchaseMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${esc(e.purchaseMessage)}</div>` : ''}
    <div class="field"><label for="mPaid">Paid to the maker: bank ref</label><input id="mPaid" value="${esc(e.sellerPaidRef)}" placeholder="Transfer reference" ${!e.zohoSellerBillId || e.zohoSellerPaymentId ? 'disabled' : ''}></div>
    <div class="muted" style="font-size:12px">When you mark it Paid the maker gets the order${kalai ? ' (they mark it ready for pickup; you book the courier and mark it Shipped)' : ' (they enter the courier and AWB; the order turns Shipped by itself)'}. When it is Delivered, the maker's payout bill is created in Zoho; enter your bank reference here when you have paid them.</div>
  </fieldset>`;
}

// ---------- delivery address (customer adds it under My enquiries & orders; the studio can type or correct it) ----------
const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
function giftAddress(e) {
  const d = parseDetails(e.details);
  return e.kind === 'GIFT' && d['Address'] ? { address: d['Address'], emirate: String(d['Emirate'] || '').split(' (')[0] } : null;
}
function addressSection(e) {
  const g = giftAddress(e);
  const has = !!e.deliveryAddress;
  const need = !has && !g && ['PAID', 'FRAMING', 'REPLACEMENT'].includes(e.status);
  const emi = e.deliveryEmirate || (g && EMIRATES.find((x) => g.emirate.includes(x))) || '';
  return `<fieldset class="cost" id="addrBox" ${need ? 'style="border-color:var(--kumkum)"' : ''}>
    <legend>Delivery address ${has ? `<span class="muted">· ${esc(e.addressBy === 'Customer' ? 'from the customer' : 'entered by you')} ${esc(when(e.addressAt))}</span>` : ''}</legend>
    ${need ? '<div class="err" style="font-size:13px">No delivery address yet. The customer was asked to add it under My enquiries & orders; you can also type it here.</div>' : ''}
    <div class="three">
      <div class="field"><label for="dName">Receiver</label><input id="dName" value="${esc(e.deliveryName || e.customerName)}"></div>
      <div class="field"><label for="dPhone">Receiver mobile</label><input id="dPhone" value="${esc(e.deliveryPhone || e.phone)}"></div>
    </div>
    <div class="three">${countryRegionHtml({ country: e.deliveryCountry || 'UAE', region: emi, pin: e.deliveryPin, prefix: 'd', names: false })}</div>
    <div class="field"><label for="dAddr">Address (villa / flat, building, street, area)</label><textarea id="dAddr" rows="2">${esc(e.deliveryAddress || g?.address || '')}</textarea></div>
    <div class="field"><label for="dLand">Landmark (optional)</label><input id="dLand" value="${esc(e.deliveryLandmark)}"></div>
  </fieldset>`;
}
function readAddress(e) {
  if (!$('addrBox')) return {};
  const india = $('dCountry').value !== 'UAE'; // a PIN / postal code is kept for every country but the UAE
  const v = { deliveryName: $('dName').value.trim() || null, deliveryPhone: $('dPhone').value.trim() || null, deliveryCountry: $('dCountry').value, deliveryEmirate: $('dRegion').value || null, deliveryPin: india ? $('dPin').value.trim() || null : null, deliveryAddress: $('dAddr').value.trim() || null, deliveryLandmark: $('dLand').value.trim() || null };
  const was = { ...e, deliveryCountry: e.deliveryCountry || 'UAE' };
  const changed = ['deliveryCountry', 'deliveryEmirate', 'deliveryPin', 'deliveryAddress', 'deliveryLandmark'].some((k) => (v[k] || '') !== (was[k] || '')) || (v.deliveryAddress && ((v.deliveryName || '') !== (e.deliveryName || '') || (v.deliveryPhone || '') !== (e.deliveryPhone || '')));
  if (!changed || !v.deliveryAddress) return {};
  return { ...v, addressAt: new Date().toISOString(), addressBy: 'Kalai Art House' };
}

const COURIERS = ['Aramex', 'DHL', 'Jeebly', 'Quiqup', 'Emirates Post', 'SMSA', 'Own delivery'];
const SHIP_STATUSES = ['SHIPPED', 'DELIVERED'];
function shippingSection(e) {
  const st = e.deliveryState || '';
  const color = st === 'DELIVERED' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : st === 'DRAFT' ? 'var(--gold)' : 'var(--muted)';
  return `<fieldset class="cost" id="shipBox" ${SHIP_STATUSES.includes(e.status) ? '' : 'hidden'}>
    <legend>Delivery</legend>
    ${e.deliveryMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${esc(e.deliveryMessage)}</div>` : ''}
    <div class="two">
      <div class="field"><label for="eCourierSel">Courier</label>
        <select id="eCourierSel">
          <option value="">Choose…</option>
          ${COURIERS.map((c) => `<option value="${c}" ${e.courierName === c ? 'selected' : ''}>${c}</option>`).join('')}
          <option value="__other" ${e.courierName && !COURIERS.includes(e.courierName) ? 'selected' : ''}>Other…</option>
        </select>
        <input id="eCourier" value="${esc(e.courierName)}" placeholder="Courier name" ${e.courierName && !COURIERS.includes(e.courierName) ? '' : 'hidden'} style="margin-top:6px">
      </div>
      <div class="field"><label for="eAwb">AWB / tracking no.</label><input id="eAwb" value="${esc(e.trackingNo)}" placeholder="e.g. 4489 2201 7731"></div>
    </div>
    <div class="muted" style="font-size:12px">Saving as <b>Shipped</b> creates the delivery challan in Zoho; <b>Delivered</b> marks it delivered. The customer sees the courier and tracking number under My enquiries & orders.</div>
  </fieldset>`;
}

// ---------- after-sales: cancellations, damage, replacement ----------
const AFTER = {
  CANCEL_FULL: { label: 'Customer cancelled, Siva not started: full refund', pct: 1, status: 'REFUNDED' },
  CANCEL_HALF: { label: 'Customer cancelled, Siva already started: 50% refund', pct: 0.5, status: 'REFUNDED' },
  DAMAGED_REFUND: { label: 'Damaged in transit, customer wants a refund: full refund', pct: 1, status: 'REFUNDED' },
  DAMAGED_REPLACE: { label: 'Damaged in transit, customer wants a replacement / repair', pct: 0, status: 'REPLACEMENT' },
};
const AFTER_DONE = ['DONE', 'TEST', 'REPLACEMENT'];
// The customer's own request (My enquiries & orders) → the matching box option, pre-filled.
const isReq = (e) => e.cancelState === 'REQUESTED';
function reqAction(e) {
  if (!isReq(e)) return '';
  if (e.cancelRequest === 'CANCEL') return Number(e.cancelRefundDue) < Number(e.quotedPrice || 0) ? 'CANCEL_HALF' : 'CANCEL_FULL';
  return e.cancelRequest || '';
}
const REQ_LABEL = { CANCEL: 'Cancel the order', DAMAGED_REFUND: 'Arrived damaged: full refund', DAMAGED_REPLACE: 'Arrived damaged: replacement / repair' };
function requestBanner(e) {
  if (!isReq(e) && e.cancelState !== 'DECLINED') return '';
  if (e.cancelState === 'DECLINED') return `<div class="muted" style="font-size:13px"><b>Customer request declined:</b> ${esc(REQ_LABEL[e.cancelRequest] || '')}${e.cancelReply ? ` · “${esc(e.cancelReply)}”` : ''}</div>`;
  return `<div class="reqbox">
    <div><b>Customer request · ${esc(when(e.cancelRequestedAt))}</b></div>
    <div>${esc(REQ_LABEL[e.cancelRequest] || e.cancelRequest)}${e.cancelRequest !== 'DAMAGED_REPLACE' ? ` · refund under the policy: <b>AED ${Number(e.cancelRefundDue || 0).toLocaleString('en-US')}</b>` : ''}</div>
    ${e.cancelReason ? `<div>Reason: “${esc(e.cancelReason)}”</div>` : ''}
    ${e.cancelPhotos ? `<div class="links" id="reqPhotos"><span class="muted">Loading photos…</span></div>` : ''}
    <div class="muted" style="font-size:12px">${e.cancelRequest === 'CANCEL' && e.zohoPOId ? "Siva's order is on hold. " : ''}To accept: ${e.cancelRequest === 'DAMAGED_REPLACE' ? 'tick the box below and save.' : 'pay the refund (Ziina / bank), enter its reference below, tick the box and save.'} The customer is emailed automatically.</div>
    <details><summary>Decline the request instead</summary>
      <div class="field" style="margin-top:8px"><label for="rqReply">Reply to the customer (emailed)</label><textarea id="rqReply" rows="2" placeholder="e.g. As agreed on the phone, you are keeping the painting."></textarea></div>
      <button class="btn ghost" type="button" id="rqDecline">Decline and email the customer</button> <span class="ok" id="rqMsg" role="status"></span>
    </details>
  </div>`;
}

// ---------- Replacement rework: frame shop or Siva, costs and the courier insurance claim ----------
const REWORK_TYPE = { REFRAME: 'New glass / re-frame at the frame shop', SIVA_REPAIR: 'Repair by Siva', SIVA_REPAINT: 'Repaint by Siva (new painting)' };
function parseRework(c) {
  let v = c?.rework;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : {};
}
/** Extra cost of a replacement (AED) and what the insurer paid back. */
function reworkCost(e) {
  const c = costings.get(e.id);
  const r = parseRework(c);
  const fx = Number(parseCosts(c)?.fx) || rates.fx;
  const siva = e.reworkType?.startsWith('SIVA') && c?.reworkPriceInr ? Number(c.reworkPriceInr) * fx : 0;
  const cost = siva + Number(r.framing || 0) + Number(r.indiaCourier || 0) + Number(r.localCourier || 0) + Number(r.other || 0);
  const received = Number(r.received || 0);
  return { siva, cost, received, net: cost - received, any: cost > 0 || received > 0 };
}
// Return transport legs, as one timeline: customer → frame shop → (Siva → frame shop) → checked → customer.
const RETURN_MODE = { PICKUP: 'Courier pickup from the customer', DROP: 'Customer drops it at the frame shop', NONE: 'No return (customer keeps / disposes of it)' };
function reworkTimeline(e) {
  const rows = [];
  const add = (done, label, at, extra = '') => rows.push(`<li class="${done ? 'done' : ''}"><span>${done ? '✓' : '○'}</span> ${label}${extra ? ` <span class="muted">${esc(extra)}</span>` : ''}${at ? ` <span class="muted">· ${esc(day(at))}</span>` : ''}</li>`);
  const siva = (e.reworkType || '').startsWith('SIVA');
  if (e.returnMode === 'PICKUP') {
    add(!!e.returnAwb, 'Return pickup booked', e.returnPickupDate, e.returnAwb ? `${e.returnCourier} · AWB ${e.returnAwb}` : '');
    add(!!e.returnPickedAt, 'Picked up from the customer', e.returnPickedAt);
  }
  if (e.returnMode !== 'NONE') add(!!e.returnReceivedAt, 'Received at the frame shop', e.returnReceivedAt);
  if (e.reworkType === 'SIVA_REPAIR') {
    add(!!e.toSivaSentAt, 'Sent to Siva (India)', e.toSivaSentAt, e.toSivaAwb ? `${e.toSivaCourier} · AWB ${e.toSivaAwb}` : '');
    add(!!e.sivaReceivedAt, 'Siva received it', e.sivaReceivedAt);
  }
  if (siva) {
    add(!!e.reworkStartedAt, 'Siva: rework started', e.reworkStartedAt);
    add(!!e.reworkFinishedAt, 'Siva: finished', e.reworkFinishedAt);
    add(!!e.reworkSentAt, 'Siva: sent to the frame shop', e.reworkSentAt, e.reworkAwb ? `${e.reworkCourier} · AWB ${e.reworkAwb}` : '');
    add(!!e.reworkBackAt, 'Back at the frame shop', e.reworkBackAt);
  }
  add(e.reworkStage === 'READY', 'Checked and ready', e.reworkReadyAt);
  add(SHIP_STATUSES.includes(e.status), 'Shipped to the customer', '', SHIP_STATUSES.includes(e.status) && e.trackingNo ? `${e.courierName} · AWB ${e.trackingNo}` : '');
  add(e.status === 'DELIVERED', 'Delivered', e.deliveredAt);
  return `<ol class="timeline">${rows.join('')}</ol>`;
}
function transportSection(e) {
  const mode = e.returnMode || '';
  const sel = (id, v, list) => `<select id="${id}"><option value="">Choose…</option>${list.map((c) => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}${v && !list.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>`;
  const tick = (id, label, at) => `<label class="tickline"><input type="checkbox" id="${id}" ${at ? 'checked disabled' : ''}> ${label}${at ? ` <span class="muted">${esc(when(at))}</span>` : ''}</label>`;
  return `<div class="muted" style="font-size:12px;font-weight:600;margin-top:4px">Return and transport</div>
    <div class="field"><label for="rtMode">Damaged piece</label><select id="rtMode"><option value="">Choose…</option>${Object.entries(RETURN_MODE).map(([k, v]) => `<option value="${k}" ${mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div id="rtPickup" class="three" ${mode === 'PICKUP' ? '' : 'hidden'}>
      <div class="field"><label for="rtCourier">Return courier</label>${sel('rtCourier', e.returnCourier, COURIERS.filter((c) => c !== 'Own delivery'))}</div>
      <div class="field"><label for="rtAwb">Return AWB</label><input id="rtAwb" value="${esc(e.returnAwb)}" placeholder="From the courier's return booking"></div>
      <div class="field"><label for="rtDate">Pickup date</label><input id="rtDate" type="date" value="${esc(e.returnPickupDate)}"></div>
    </div>
    <div class="muted" style="font-size:12px" id="rtHint" ${mode === 'PICKUP' ? '' : 'hidden'}>Book a return (reverse) pickup with the courier, to the frame shop's address. Saving the AWB emails the customer the courier, AWB and date.</div>
    <div id="rtTicks" ${mode && mode !== 'NONE' ? '' : 'hidden'}>
      ${mode === 'PICKUP' || !mode ? tick('rtPicked', 'Picked up from the customer', e.returnPickedAt) : ''}
      ${tick('rtRecv', 'Received at the frame shop (the customer is emailed)', e.returnReceivedAt)}
    </div>
    ${e.reworkType === 'SIVA_REPAIR' ? `<div class="three">
      <div class="field"><label for="tsCourier">To Siva: courier</label>${sel('tsCourier', e.toSivaCourier, ['DHL', 'Aramex', 'FedEx', 'SMSA', 'Emirates Post'])}</div>
      <div class="field"><label for="tsAwb">To Siva: AWB</label><input id="tsAwb" value="${esc(e.toSivaAwb)}" ${e.toSivaSentAt ? 'disabled' : ''}></div>
      <div class="field" style="align-self:end">${tick('tsSent', 'Sent to Siva (he sees the AWB)', e.toSivaSentAt)}</div>
    </div>
    <div class="muted" style="font-size:12px">${e.sivaReceivedAt ? `Siva received it ${esc(when(e.sivaReceivedAt))}.` : 'Siva taps “I\'ve received it” on his page; he can only start the repair after that.'} Sending art to India and back needs export / re-import papers (repair and return); keep the courier's paperwork.</div>` : ''}
    ${(e.reworkType || '').startsWith('SIVA') ? tick('rwBack', 'Siva\'s piece is back at the frame shop', e.reworkBackAt) : ''}`;
}

function reworkSection(e) {
  if (e.status !== 'REPLACEMENT' && !e.reworkType) return '';
  const c = costings.get(e.id) || {};
  const r = parseRework(c);
  const siva = (e.reworkType || '').startsWith('SIVA');
  const ready = e.reworkStage === 'READY';
  const rc = reworkCost(e);
  const sivaSteps = siva ? [e.reworkStartedAt && `Started ${day(e.reworkStartedAt)}`, e.reworkFinishedAt && `Finished ${day(e.reworkFinishedAt)}`, e.reworkSentAt && `Sent to frame shop ${day(e.reworkSentAt)}${e.reworkAwb ? ` (${e.reworkCourier} · AWB ${e.reworkAwb})` : ''}`].filter(Boolean).join(' · ') : '';
  const num = (id, label, v, dis = false) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" min="0" step="0.01" value="${v ?? ''}" ${dis ? 'disabled' : ''}></div>`;
  return `<fieldset class="cost" id="reworkBox">
    <legend>Replacement: rework ${ready ? '<span class="muted">· ready to ship</span>' : ''}</legend>
    <div class="two">
      <div class="field"><label for="rwType">Fix</label><select id="rwType" ${e.reworkStage ? 'disabled' : ''}><option value="">Choose…</option>${Object.entries(REWORK_TYPE).map(([k, v]) => `<option value="${k}" ${e.reworkType === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="rwNote">Instructions (Siva sees them)</label><input id="rwNote" value="${esc(e.reworkNote)}" placeholder="e.g. glass cracked, painting fine"></div>
    </div>
    ${siva ? `<div style="font-size:13px"><b>Siva:</b> ${c.reworkPriceInr != null ? `rework price INR ${Number(c.reworkPriceInr).toLocaleString('en-IN')}${c.reworkPriceBy && c.reworkPriceBy !== 'Siva' ? ' (entered by you)' : ''}` : 'no rework price yet'}${sivaSteps ? ` · ${esc(sivaSteps)}` : e.reworkType ? ' · not started (he sees it on his page; you can tick it there for him)' : ''}</div>` : ''}
    ${e.reworkMessage ? `<div style="font-size:13px;color:${/^Error/.test(e.reworkMessage) ? 'var(--kumkum)' : 'var(--muted)'}">${esc(e.reworkMessage)}</div>` : ''}
    ${reworkTimeline(e)}
    ${transportSection(e)}
    <div class="muted" style="font-size:12px;font-weight:600;margin-top:4px">Extra costs of this replacement (AED, the customer pays nothing)</div>
    <div class="three">
      ${num('rwFr', 'Frame shop (glass / frame)', r.framing)}
      ${num('rwLc', 'Couriers (pickup, re-delivery)', r.localCourier)}
      ${siva ? num('rwIc', 'India courier (Siva)', r.indiaCourier) : ''}
      ${num('rwOt', 'Other', r.other)}
      ${siva ? `<div class="field"><label for="rwInr">Siva's rework price (INR)</label><input id="rwInr" type="number" min="0" step="1" value="${c.reworkPriceInr ?? ''}" ${e.zohoReworkBillId ? 'disabled' : ''}></div>` : ''}
    </div>
    ${siva ? `<div class="two">
      <div class="field"><label for="rwInv">Siva's rework invoice no.</label><input id="rwInv" value="${esc(e.reworkInvoiceNo)}" placeholder="Creates a second bill in Zoho" ${e.zohoReworkBillId ? 'disabled' : ''}></div>
      <div class="field"><label for="rwPaid">Paid to Siva (rework): bank ref</label><input id="rwPaid" value="${esc(e.reworkPaidRef)}" ${!e.zohoReworkBillId || e.zohoReworkPaymentId ? 'disabled' : ''}></div>
    </div>` : ''}
    <details ${r.claimRef || r.received ? 'open' : ''}><summary>Courier insurance claim</summary>
      <div class="three" style="margin-top:8px">
        <div class="field"><label for="rwIns">Courier / insurer</label><input id="rwIns" value="${esc(r.insurer)}" placeholder="Courier that delivered it damaged"></div>
        <div class="field"><label for="rwClaim">Claim reference</label><input id="rwClaim" value="${esc(r.claimRef)}"></div>
        ${num('rwClaimed', 'Amount claimed', r.claimed)}
        ${num('rwRecv', 'Amount received', r.received)}
        <div class="field"><label for="rwRecvRef">Received: reference</label><input id="rwRecvRef" value="${esc(r.receivedRef)}"></div>
      </div>
      <div class="muted" style="font-size:12px">Claim with the courier within its time limit (e.g. Aramex: 60 days from pickup), with the AWB, the customer's photos and the declared value.</div>
    </details>
    <div class="marginline ${rc.net > 0 ? 'low' : ''}" id="rwSum">Extra cost ${aed(rc.cost, 2)}${rc.received ? ` − insurance ${aed(rc.received, 2)}` : ''} = <b>${aed(rc.net, 2)}</b> taken from this order's margin.</div>
    ${ready && e.status === 'REPLACEMENT' ? `<div class="reqbox" style="border-color:var(--ok)"><b>Next: ship it to the customer</b><span>Status → Shipped, then choose the courier and enter the new AWB in the Delivery box, and save. That creates the new delivery challan and emails the customer the tracking number.</span><button type="button" class="btn" id="rwShip" style="justify-self:start">Ship the replacement</button></div>` : ''}
    <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13px"><input type="checkbox" id="rwReady" style="width:auto;margin-top:3px" ${ready ? 'checked disabled' : ''}> <span>${ready ? `Checked and ready ${esc(when(e.reworkReadyAt))}` : 'I have checked the reworked piece (at the frame shop or by photo): it is ready to ship. Shipping is allowed only after this.'}</span></label>
  </fieldset>`;
}
function readRework(e) {
  if (!$('reworkBox')) return null;
  const c = costings.get(e.id) || {};
  const old = parseRework(c);
  const rework = { ...old, framing: n($('rwFr').value), localCourier: n($('rwLc').value), indiaCourier: $('rwIc') ? n($('rwIc').value) : old.indiaCourier ?? null, other: n($('rwOt').value),
    insurer: $('rwIns').value.trim() || null, claimRef: $('rwClaim').value.trim() || null, claimed: n($('rwClaimed').value), received: n($('rwRecv').value), receivedRef: $('rwRecvRef').value.trim() || null };
  const inr = $('rwInr') && !$('rwInr').disabled ? n($('rwInr').value) : undefined;
  const now = new Date().toISOString();
  const ticked = (id) => $(id) && $(id).checked && !$(id).disabled;
  const mode = $('rtMode').value || null;
  const enq = {
    returnMode: mode,
    ...(mode === 'PICKUP' ? { returnCourier: $('rtCourier').value || null, returnAwb: $('rtAwb').value.trim() || null, returnPickupDate: $('rtDate').value || null } : {}),
    ...(ticked('rtPicked') ? { returnPickedAt: now } : {}),
    ...(ticked('rtRecv') ? { returnReceivedAt: now, ...(mode === 'PICKUP' && !e.returnPickedAt && !ticked('rtPicked') ? { returnPickedAt: now } : {}) } : {}),
    ...($('tsCourier') ? { toSivaCourier: $('tsCourier').value || null } : {}),
    ...($('tsAwb') && !$('tsAwb').disabled ? { toSivaAwb: $('tsAwb').value.trim() || null } : {}),
    ...(ticked('tsSent') ? { toSivaSentAt: now } : {}),
    ...(ticked('rwBack') ? { reworkBackAt: now } : {}),
    reworkType: $('rwType').disabled ? e.reworkType : $('rwType').value || null,
    reworkNote: $('rwNote').value.trim() || null,
    ...($('rwReady').checked && !$('rwReady').disabled ? { reworkStage: 'READY', reworkReadyAt: new Date().toISOString() } : {}),
    ...($('rwInv') && !$('rwInv').disabled ? { reworkInvoiceNo: $('rwInv').value.trim() || null } : {}),
    ...($('rwPaid') && !$('rwPaid').disabled ? { reworkPaidRef: $('rwPaid').value.trim() || null } : {}),
  };
  return { rework, inr, enq, changedInr: inr !== undefined && inr !== (c.reworkPriceInr ?? null) };
}
async function saveRework(e, rw) {
  const c = costings.get(e.id);
  const rec = { enquiryId: e.id, rework: JSON.stringify(rw.rework), ...(rw.changedInr ? { reworkPriceInr: rw.inr, reworkPriceAt: new Date().toISOString(), reworkPriceBy: 'Kalai Art House (Order Management)' } : {}) };
  const res = c ? await client.models.Costing.update(rec) : await client.models.Costing.create(rec);
  if (res.errors?.length) throw new Error(res.errors[0].message);
  costings.set(e.id, res.data || { ...c, ...rec });
}

function afterSection(e) {
  if (!e.zohoInvoiceId && !e.refundAction) return '';
  const done = AFTER_DONE.includes(e.refundState);
  const pre = !e.refundAction ? reqAction(e) : '';
  const act = e.refundAction || pre;
  const st = e.refundState || '';
  const color = st === 'DONE' || st === 'REPLACEMENT' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : st === 'TEST' ? 'var(--gold)' : 'var(--muted)';
  const dis = done ? 'disabled' : '';
  return `<fieldset class="cost" id="afterBox">
    <legend>Cancellation, damage or refund</legend>
    ${requestBanner(e)}
    ${e.refundMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${esc(e.refundMessage)}</div>` : ''}
    ${!done && e.zohoPOId ? `<div style="font-size:13px"><b>Siva:</b> ${e.artistStartedAt ? `started ${esc(day(e.artistStartedAt))}, so a cancellation is a <b>50% refund</b>` : "hasn't marked it started, so a cancellation is a <b>full refund</b>"}.</div>` : ''}
    <div class="field"><label for="aAction">What happened?</label><select id="aAction" ${dis}>
      <option value="">Nothing: order is fine</option>
      ${Object.entries(AFTER).map(([k, v]) => `<option value="${k}" ${act === k ? 'selected' : ''}>${v.label}</option>`).join('')}
    </select></div>
    <div class="err" id="aWarn" hidden></div>
    <div id="aMoney" class="two" ${act && act !== 'DAMAGED_REPLACE' ? '' : 'hidden'}>
      <div class="field"><label for="aAmount">Refund amount (AED)</label><input id="aAmount" type="number" min="0" step="0.01" value="${e.refundAmount ?? (pre ? e.cancelRefundDue ?? '' : '')}" ${dis}></div>
      <div class="field"><label for="aMethod">Refund via</label><select id="aMethod" ${dis}>${[['ZIINA', 'Ziina'], ['BANK', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card (other)'], ['OTHER', 'Other']].map(([k, v]) => `<option value="${k}" ${(e.refundMethod || e.paymentMethod || 'ZIINA') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="aRef">Refund reference</label><input id="aRef" value="${esc(e.refundRef)}" placeholder="Ziina / bank transaction ID" ${dis}></div>
    </div>
    <div class="field" id="aNoteBox" ${act ? '' : 'hidden'}><label for="aNote">Note (reason, customer's photos received…)</label><input id="aNote" value="${esc(e.refundNote || (pre ? `Customer request: ${e.cancelReason || REQ_LABEL[e.cancelRequest] || ''}` : ''))}" ${dis}></div>
    ${done ? '' : `<label id="aConfirmBox" style="display:${act ? 'flex' : 'none'};gap:8px;align-items:flex-start;font-weight:400;font-size:13px"><input type="checkbox" id="aConfirm" style="width:auto;margin-top:3px"> <span id="aConfirmText">I confirm. Saving sets the status and records this in Zoho (credit note + refund, or the challan as returned). It can't be undone from here.</span></label>`}
    <div class="muted" style="font-size:12px">Policy: no change-of-mind returns. Cancelled before Siva starts → full refund; after he starts → 50%. Damaged in transit (photos within 48 hours) → customer chooses refund or replacement.</div>
  </fieldset>`;
}

function readCosting() {
  return {
    artistPriceInr: curAed ? null : n($('cInr')?.value),
    artistPriceAed: curAed ? n($('cInr')?.value) : null,
    local: curAed,
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
    ${row('Artist', aed(r.artistAed), r.artistAed != null ? (curAed ? 'artist in the UAE, price in AED' : `INR ${Number($('cInr').value).toLocaleString('en-IN')} × ${rates.fx}`) : 'needs the artist\'s price')}
    ${row('Framing', aed(r.framing), $('cFr').value ? 'override' : t ? `master ${$('cTier').value}` : 'choose a size tier')}
    ${row('India courier', aed(r.indiaCourier), $('cIc').value ? 'override' : curAed ? 'none: artist in the UAE' : t ? `master ${$('cTier').value}` : '')}
    ${r.ready ? row('Customs', aed(r.customs, 2), curAed ? 'none: artist in the UAE' : `${(rates.customs * 100).toFixed(1)}% of artist + courier`) : ''}
    ${row('Local courier', aed(r.localCourier), $('cLc').value ? 'override' : 'master')}
    ${r.ready ? `<tr class="tot"><td>Total cost</td><td class="mono num">${aed(r.total)}</td><td></td></tr>` : ''}
  </tbody></table>`;
  if (r.ready) {
    html += `<div class="suggest"><span>Suggested price <b class="mono">${aed(r.suggested)}</b> <span class="muted">(${(r.mg * 100).toFixed(0)}% ${CAT_OF[curEnq?.kind] === 'commission' ? 'commission' : 'collection'} margin${r.vatRate ? ', VAT incl.' : ''}${rates.fee ? ', after Ziina fee' : ''}${rates.ins ? ', insurance' : ''}${rates.reserve ? ', breakage reserve' : ''})</span></span>
      ${$('ePrice').readOnly ? '' : '<button type="button" class="btn small" id="useSug">Use this price</button>'}</div>`;
    if (r.price) {
      const low = r.marginPct < Math.min(0.1, r.mg);
      html += marketLine(r.price, r.suggested);
      html += `<div class="marginline ${low ? 'low' : ''}">At ${aed(r.price)}: ${r.vatRate ? `VAT ${aed(r.vatAmt, 2)} · ` : ''}Ziina fee ${aed(r.feeAmt, 2)}${r.insAmt ? ` · insurance ${aed(r.insAmt, 2)}` : ''}${r.resAmt ? ` · breakage reserve ${aed(r.resAmt, 2)}` : ''} · <b>margin ${aed(r.margin)} (${(r.marginPct * 100).toFixed(1)}%)</b>${low ? ' · below 10%' : ''}</div>`;
    }
  }
  if (r.ready && !r.price) html += marketLine(null, r.suggested);
  $('costOut').innerHTML = html;
  const b = $('useSug');
  if (b) b.onclick = () => { $('ePrice').value = r.suggested; $('ePrice').dispatchEvent(new Event('input')); };
}

async function saveCosting(e) {
  const { local, ...inp } = readCosting();
  const r = calc({ ...inp, local }, n($('ePrice').value));
  const costs = {
    artistInr: inp.artistPriceInr, artistAedPrice: inp.artistPriceAed, fx: rates.fx, artistAed: r.artistAed != null ? Math.round(r.artistAed * 100) / 100 : null,
    framing: r.framing, indiaCourier: r.indiaCourier, localCourier: r.localCourier,
    customs: r.customs != null ? Math.round(r.customs * 100) / 100 : null, total: r.total ?? null, suggested: r.suggested ?? null,
    price: r.price ?? null, margin: r.margin != null ? Math.round(r.margin * 100) / 100 : null, savedAt: new Date().toISOString(),
  };
  const existing = costings.get(e.id);
  const rec = { enquiryId: e.id, ...inp, costs: JSON.stringify(costs) };
  // Artist price typed (or changed) here by the studio: record who entered it and when.
  if ((inp.artistPriceInr != null && Number(inp.artistPriceInr) !== Number(existing?.artistPriceInr ?? NaN)) || (inp.artistPriceAed != null && Number(inp.artistPriceAed) !== Number(existing?.artistPriceAed ?? NaN))) {
    rec.artistAt = new Date().toISOString();
    rec.artistBy = 'Kalai Art House (Order Management)';
  }
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
        ${pct('rIns', 'Courier insurance (%)', rates.ins || 0, 'declared-value cover bought with each shipment, % of price')}
        ${pct('rRes', 'Breakage reserve (%)', rates.reserve || 0, 'set aside per order for damage the insurer won\'t pay')}
        <div class="field" style="grid-column:1/-1"><label>Kalai margin by category (%)</label><div class="tablewrap"><table class="costs"><tbody>${CATS.map(([k, label, note]) => `<tr><td>${label}</td><td><input id="rMg_${k}" type="number" min="0" max="300" step="0.5" value="${+(((rates.margins?.[k] ?? (k === 'market' ? 0.15 : rates.margin)) || 0) * 100).toFixed(2)}" style="width:80px"></td><td class="muted" style="font-size:12px">${note}</td></tr>`).join('')}</tbody></table></div></div>
        ${pct('rVat', 'VAT (%)', rates.vat, '0 until registered, then 5')}
      </div>
      <div class="field"><label for="rVendors">Zoho vendors → cost (one per line, "part of the vendor name = cost")</label><textarea id="rVendors" rows="4" placeholder="Al Warda = frame shop&#10;Pickframes = frame shop&#10;Aramex = courier&#10;DHL = india courier&#10;Customs broker = customs">${esc(rates.vendors || '')}</textarea>
        <span class="muted" style="font-size:12px">Costs: frame shop, india courier, customs, courier (to the customer), other. Enter each vendor bill in Zoho Books with the order number (KA-…) in Reference#; a bill for several orders lists all their numbers, with the number in each line's description. The order's Actual costs box and Reports then take the amount from Zoho.</span></div>
      <div class="tablewrap"><table class="costs"><thead><tr><th>Market check</th><th>Sketch band (AED)</th><th>Watercolour band (AED)</th><th>Saatchi Art reference</th></tr></thead>
        <tbody>${Object.keys(t).map((k) => { const m = (rates.market || DEFAULT_RATES.market)[k] || DEFAULT_RATES.market[k]; return `<tr><th>${k}</th>
          <td><input id="mSk1${k}" type="number" min="0" value="${m.sk[0]}" style="width:70px" aria-label="${k} sketch from"> – <input id="mSk2${k}" type="number" min="0" value="${m.sk[1]}" style="width:70px" aria-label="${k} sketch to"></td>
          <td><input id="mWc1${k}" type="number" min="0" value="${m.wc[0]}" style="width:70px" aria-label="${k} watercolour from"> – <input id="mWc2${k}" type="number" min="0" value="${m.wc[1]}" style="width:70px" aria-label="${k} watercolour to"></td>
          <td><input id="mSa${k}" value="${esc(m.saatchi || '')}" aria-label="${k} Saatchi reference"></td></tr>`; }).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:-6px">Kalai's target price bands (simple frame included). Each order's price is checked against them, with Saatchi Art's prices for similar originals as the upper reference.</div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="rRound" style="width:auto" ${rates.round25 !== false ? 'checked' : ''}> Round suggested prices up to the nearest Dhs 25</label>
      <div class="ok" id="ratesMsg" role="status"></div>
      <button class="btn" type="submit">Save rates</button>
    </form>
    <fieldset class="cost" id="ziinaBox"><legend>Online payments (Ziina)</legend><div id="zStatus" class="muted" style="font-size:13px">Checking…</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="zConnect">Connect payment notifications</button></div>
      <div class="muted" style="font-size:12px">Do this once after saving the Ziina token in CloudShell: Ziina then tells the website when a customer has paid, and the order turns Paid by itself.</div></fieldset>`;
  ziinaStatus();
  $('ratesForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button'); b.disabled = true; $('ratesMsg').textContent = '';
    $('detail').querySelectorAll('.err').forEach((x) => x.remove());
    const tiers = {};
    Object.keys(t).forEach((k) => { tiers[k] = { label: $('rL' + k).value.trim(), framing: n($('rF' + k).value) ?? 0, courier: n($('rC' + k).value) ?? 0 }; });
    const data = { tiers, local: n($('rLocal').value) ?? 0, fx: n($('rFx').value) ?? 0,
      customs: (n($('rCus').value) ?? 0) / 100, fee: (n($('rFee').value) ?? 0) / 100, ins: (n($('rIns').value) ?? 0) / 100, reserve: (n($('rRes').value) ?? 0) / 100, margins: Object.fromEntries(CATS.map(([k]) => [k, (n($('rMg_' + k).value) ?? 0) / 100])), margin: (n($('rMg_collection').value) ?? 0) / 100,
      vat: (n($('rVat').value) ?? 0) / 100, vendors: $('rVendors').value.trim(), round25: $('rRound').checked, round9: false, updatedAt: new Date().toISOString(), ...(rates.pricing ? { pricing: rates.pricing } : {}),
      market: Object.fromEntries(Object.keys(t).map((k) => [k, { sk: [n($('mSk1' + k).value) ?? 0, n($('mSk2' + k).value) ?? 0], wc: [n($('mWc1' + k).value) ?? 0, n($('mWc2' + k).value) ?? 0], saatchi: $('mSa' + k).value.trim() }])) };
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

const DOC_STATUS_OK = ['delivered', 'paid', 'accepted', 'closed', 'billed', 'issued', 'invoiced', 'sent', 'open', 'creditcard', 'banktransfer', 'cash', 'recorded'];
function docsList(e) {
  const raw = costings.get(e.id)?.zohoDocs;
  let d = null;
  try { d = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; if (typeof d === 'string') d = JSON.parse(d); } catch { d = null; }
  if (!d) return '<div class="muted" style="font-size:12px">Press Check Zoho to list every Zoho document for this order.</div>';
  if (!d.docs?.length) return `<div class="muted" style="font-size:12px">No Zoho documents with reference ${esc(e.ref)} (checked ${esc(when(d.checkedAt))}).</div>`;
  const pretty = (st) => String(st || '').replace(/creditcard/, 'card').replace(/banktransfer/, 'bank transfer').replace(/_/g, ' ');
  const rows = (group, title) => {
    const list = d.docs.filter((x) => x.group === group);
    if (!list.length) return '';
    return `<tr class="grp"><th colspan="4">${title}</th></tr>` + list.map((x) => `<tr>
      <td>${esc(x.type)}</td>
      <td><a href="${esc(x.url)}" target="_blank" rel="noopener" class="mono">${esc(x.number || 'open')}</a></td>
      <td><span class="dstat ${x.status === 'void' || x.status === 'cancelled' ? 'bad' : x.status === 'draft' ? 'draft' : DOC_STATUS_OK.includes(x.status) ? 'good' : ''}">${esc(pretty(x.status))}</span></td>
      <td class="num mono">${x.total != null ? aed(x.total, 2) : ''}${x.balance ? `<br><span class="muted">due ${aed(x.balance, 2)}</span>` : ''}</td></tr>`).join('');
  };
  return `<div class="docs"><table class="costs"><tbody>${rows('SALES', 'Sales (customer)')}${rows('DELIVERY', 'Delivery')}${rows('PURCHASE', 'Purchase (Siva)')}</tbody></table>
    <div class="muted" style="font-size:12px">Checked ${esc(when(d.checkedAt))} · links open in Zoho Books</div></div>`;
}

async function ziinaStatus(msg = '') {
  try {
    const r = await client.mutations.ziinaAdmin({ action: 'status' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const z = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    $('zStatus').innerHTML = `${z.token ? '✓ Token saved' : '✗ No valid token yet (run the CloudShell command)'} · ${z.secret ? '✓ signing secret saved' : '✗ no signing secret'} · ${z.test ? '<b>test mode</b> (no real money)' : '<b style="color:var(--ok)">live</b>'}${msg ? ` · ${esc(msg)}` : ''}`;
  } catch (ex) { $('zStatus').textContent = 'Could not check Ziina: ' + ex.message; }
}
document.addEventListener('click', async (ev) => {
  if (ev.target?.id !== 'zConnect') return;
  const b = ev.target; b.disabled = true;
  try {
    const url = outputs?.custom?.ziinaWebhookUrl;
    if (!url) throw new Error('The webhook address is not deployed yet. Wait for the build to finish, refresh (Ctrl+F5) and try again.');
    const r = await client.mutations.ziinaAdmin({ action: 'connect', data: JSON.stringify({ url }) });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    await ziinaStatus('✓ notifications connected');
  } catch (ex) { $('zStatus').textContent = ex.message; } finally { b.disabled = false; }
});

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
    ${!isLocked(e) && e.zohoInvoiceId ? `<div class="muted" style="font-size:12px">🔒 Price locked: invoice ${esc(e.zohoInvoice || '')} exists in Zoho. To change the price, delete the draft invoice in Zoho, then press <b>Check Zoho</b>.</div>` : ''}
    ${isLocked(e) ? `<div class="muted" style="font-size:12px">🔒 Locked: the payment is in Zoho, so the price can't change and the status can't go back to Received, Price sent or Cancelled. If the payment failed, void invoice ${esc(e.zohoInvoice || '')} or delete its payment in Zoho, then press <b>Check Zoho</b> to unlock.</div>` : ''}
    ${docsList(e)}
    <div class="ok" id="zohoMsg" role="status"></div>
  </div>
  ${ziinaLine(e)}`;
}
function ziinaLine(e) {
  if (!e.ziinaIntentId && !e.ziinaMessage) return '';
  const paid = !!e.ziinaPaidAt && e.paymentMethod === 'ZIINA';
  const refund = e.ziinaRefundId ? ` · refund ${esc(e.ziinaRefundState || 'pending')}` : '';
  return `<div class="card" style="padding:10px 14px;display:grid;gap:4px;background:var(--sunk);font-size:13px">
    <b style="color:${paid ? 'var(--ok)' : 'var(--fg)'}">${paid ? '✓ Paid online with Ziina' : 'Ziina payment link'}${e.ziinaTest === 'yes' ? ' <span class="chip">test</span>' : ''}</b>
    <div>${esc(e.ziinaMessage || '')}${paid ? ` ${esc(when(e.ziinaPaidAt))}${e.ziinaCard ? ` · ${esc(e.ziinaCard)}` : ''}` : e.ziinaAmount ? ` Link for AED ${Number(e.ziinaAmount).toLocaleString('en-US')}; the order turns Paid by itself when the customer pays.` : ''}${refund}</div>
  </div>`;
}

async function refreshOne(id) {
  const { data } = await client.models.Enquiry.get({ id });
  if (!data) return null;
  try {
    const c = await client.models.Costing.get({ enquiryId: id });
    if (c.data) costings.set(id, c.data);
  } catch { /* costing optional */ }
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
    if (data && data.zohoAt && data.zohoAt > since) {
      // Zoho answered (invoice, challan, credit note, bill…): refresh the document list too, so it is never out of date.
      try { await client.mutations.checkZoho({ id }); } catch { /* the list can still be refreshed with Check Zoho */ }
      await refreshOne(id);
      return;
    }
  }
}

// Picture beside the order: the customer's photo (commission), else the artwork from the catalogue.
let thumbProducts = null;
let builtIn = null;
async function showThumb(e, det) {
  const box = $('dThumb'); if (!box) return;
  const put = (url, label) => { if ($('dThumb') !== box) return; box.href = url; box.querySelector('img').src = url; box.querySelector('span').textContent = label; box.hidden = false; };
  try {
    if (e.fileKey && /\.(jpe?g|png|webp|heic|gif)$/i.test(e.fileKey)) { const { url } = await getUrl({ path: e.fileKey, options: { expiresIn: 900 } }); put(url.toString(), "Customer's photo"); return; }
    if (e.kind !== 'PRICE') return;
    if (!thumbProducts) {
      thumbProducts = [];
      let nextToken = null;
      do { const r = await client.models.Product.list({ limit: 500, nextToken, selectionSet: ['id', 'title', 'code', 'imageKey'] }); thumbProducts.push(...(r.data || [])); nextToken = r.nextToken; } while (nextToken);
    }
    const code = String(det['Artwork no.'] || '').trim();
    const name = String(e.title || '').replace(/^(Price enquiry( \(offer\))?|Artwork order): /i, '').trim().toLowerCase();
    const p = thumbProducts.find((x) => code && (x.code === code || x.id.startsWith(code))) || thumbProducts.find((x) => String(x.title || '').trim().toLowerCase() === name);
    if (p?.imageKey) { const { url } = await getUrl({ path: p.imageKey, options: { expiresIn: 900 } }); put(url.toString(), p.code ? `Artwork ${p.code}` : 'Artwork'); return; }
    // Works built into the website (not in the Catalogue): read their pictures from the home page once.
    if (!builtIn) {
      builtIn = [];
      const html = await fetch('/', { cache: 'force-cache' }).then((r) => r.text());
      const m = html.match(/const PRODUCTS=(\[[\s\S]*?\]);\n/);
      if (m) try { builtIn = JSON.parse(m[1]); } catch { builtIn = []; }
    }
    const b = builtIn.find((x) => String(x.name || '').trim().toLowerCase() === name || (code && x.id === code));
    if (b?.img) put(b.img, 'Artwork');
  } catch { /* no picture */ }
}

async function showDetail(e) {
  const det = parseDetails(e.details);
  const s = e.status || 'RECEIVED';
  const locked = isLocked(e);
  $('detail').innerHTML = `
    <div class="dtop"><div class="dtop-main">
    <div><div class="muted" style="font-family:var(--mono);font-size:13px">${esc(e.ref)} · ${esc(KIND[e.kind] || '')}</div>
    <h2 style="font-size:22px;margin-top:4px">${esc(e.title)}</h2></div>
    <dl class="kv">
      <dt>Customer</dt><dd>${esc(e.customerName)}${e.customerCode ? ` · <button type="button" class="linkbtn mono" style="font-size:11px;padding:0 3px;border:0;background:none;text-decoration:underline;color:var(--muted)" data-cust="${esc(e.customerCode)}" title="Show all orders of this customer">${esc(e.customerCode)}</button>` : ''}</dd>
      <dt>Email</dt><dd>${esc(e.email)}</dd>
      ${Object.entries(det).filter(([k, v]) => v !== '' && v != null && !['Reference', 'Name', 'Mobile', 'Parent'].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl></div>
    <a class="dthumb" id="dThumb" hidden target="_blank" rel="noopener" title="Open the full picture"><img alt=""><span></span></a></div>
    <div class="links" id="fileLinks">${e.fileKey ? '<span class="muted">Loading upload…</span>' : '<span class="muted">No upload attached.</span>'}</div>
    ${zohoPanel(e)}
    ${reviews.has(e.id) ? `<fieldset class="cost" id="reviewBox"><legend>Customer review</legend>${reviewCard(reviews.get(e.id), false)}</fieldset>` : e.status === 'DELIVERED' ? '<div class="muted" style="font-size:13px">Delivered: the customer can now rate this order under My enquiries & orders.</div>' : ''}
    <form id="editForm" novalidate style="display:grid;gap:12px">
      <div class="field"><label for="ePhone">Customer mobile / WhatsApp</label><input id="ePhone" type="tel" inputmode="tel" placeholder="+971 50 123 4567" value="${esc(e.phone)}">
        <span class="muted" style="font-size:12px">Correct it here if the customer typed it wrongly, then save.</span></div>
      <div class="two">
        <div class="field"><label for="eStatus">Status</label><select id="eStatus">${Object.entries(STATUS).map(([k, v]) => { const lk = locked && BEFORE_PAYMENT.includes(k) && k !== s; const why = lk ? 'locked' : statusBlock(e, k, s); return `<option value="${k}" ${k === s ? 'selected' : ''} ${why ? 'disabled' : ''}>${v}${why ? ` (${why})` : ''}</option>`; }).join('')}</select>
          ${needsSiva(e) && !sivaDone(e) && !AFTER_SIVA.includes(s) ? `<span class="muted" style="font-size:12px">Being framed / Shipped open once Siva marks it <b>Sent to frame shop</b> on his page (you can do it for him there).</span>` : ''}</div>
        <div class="field"><label for="ePrice">Price (AED)</label><input id="ePrice" type="number" min="0" step="1" value="${e.quotedPrice ?? (/^AED \d+/.test(String(det.Price || '')) && !e.listingId ? String(det.Price).match(/\d+/)[0] : e.kind === 'GIFT' && /^AED [\d,]+$/.test(String(det.Total || '').trim()) ? String(det.Total).replace(/[^\d]/g, '') : '')}" ${priceLocked(e) ? `readonly title="Locked: invoice ${esc(e.zohoInvoice || '')} exists in Zoho"` : ''}>
          ${e.discountCode ? `<span class="muted" style="font-size:12px">Customer used code <b>${esc(e.discountCode)}</b>: AED ${Number(e.listPrice || 0).toLocaleString('en-US')} − ${Number(e.discountAmount || 0).toLocaleString('en-US')}. If you change the price here, the code no longer applies to it.</span>` : ''}${e.kind === 'GIFT' && e.quotedPrice == null ? `<span class="muted" style="font-size:12px">Filled from the customer's form: framing ${/age (\d+)/.test(String(det.Child || '')) && Number(String(det.Child).match(/age (\d+)/)[1]) <= 10 ? 'free (age 10 and under)' : 'AED 79 (age 11–17)'} + delivery ${esc(det['Delivery charge'] || '')}${det.Extras ? ` + extras (${esc(det.Extras)})` : ''} = ${esc(det.Total || '')}. Check it, then save with status <b>Price sent</b>.</span>` : ''}</div>
      </div>
      ${addressSection(e)}
      ${shippingSection(e)}
      ${costingSection(e)}
      ${supplierSection(e)}
      ${actualSection(e)}
      <div class="two">
        <div class="field"><label for="ePayMethod">Paid by</label><select id="ePayMethod">
          ${[['', '–'], ['ZIINA', 'Ziina'], ['BANK', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card (other)'], ['OTHER', 'Other']].map(([k, v]) => `<option value="${k}" ${k === (e.paymentMethod || '') ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label for="ePayRef">Payment reference</label><input id="ePayRef" placeholder="Ziina / bank transaction ID" value="${esc(e.paymentRef)}"></div>
      </div>
      <div class="muted" style="font-size:12px">Prices include VAT where it applies. When you save with status <b>Paid</b>, Zoho Books creates the invoice (KAH-INV-…) and records the payment automatically${hasArtist(e) ? ', then records Siva’s order' : ''}.</div>
      ${purchaseSection(e)}
      ${marketSection(e)}
      ${reworkSection(e)}
      ${afterSection(e)}
      <div class="field"><label for="eLink">Payment link</label><input id="eLink" type="url" placeholder="Leave empty: a Ziina link is created when you save as Price sent" value="${esc(e.paymentLink)}">
        <span class="muted" style="font-size:12px">${e.ziinaIntentId ? 'Created by Ziina automatically. Change the price and save again (still Price sent) to get a new link.' : 'Leave empty and save as <b>Price sent</b>: the Ziina link is made for you and emailed to the customer.'}</span></div>
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
      SHIP_STATUSES.includes($('eStatus').value) && $('eCourier').value.trim()
        ? `${$('eStatus').value === 'DELIVERED' ? 'Delivered' : 'Shipped'} with ${$('eCourier').value.trim()}${$('eAwb').value.trim() ? `, tracking no. ${$('eAwb').value.trim()}` : ''}` : '',
      'You can also track it under My enquiries & orders on art.pranixtechno.com'].filter(Boolean).join('\n');
    $('waLinks').innerHTML = `<a href="https://wa.me/${digits}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send update on WhatsApp</a>`;
  };
  waLink();
  if ($('addrBox')) wireRegion($('addrBox'));
  if ($('reviewBox')) wireReviews($('reviewBox'));
  ['ePhone', 'ePrice', 'eLink', 'eMsg', 'eCourier', 'eAwb'].forEach((id) => $(id).addEventListener('input', waLink));
  $('eStatus').addEventListener('change', () => { $('shipBox').hidden = !SHIP_STATUSES.includes($('eStatus').value); waLink(); });
  // Courier dropdown (works on phones); "Other…" opens a text box. The text box always holds the value saved.
  $('eCourierSel').addEventListener('change', () => {
    const v = $('eCourierSel').value;
    const other = v === '__other';
    $('eCourier').hidden = !other;
    $('eCourier').value = other ? (COURIERS.includes($('eCourier').value) ? '' : $('eCourier').value) : v;
    if (other) $('eCourier').focus();
    waLink();
  });
  if ($('aAction')) {
    $('aAction').addEventListener('change', () => {
      const a = AFTER[$('aAction').value];
      $('aMoney').hidden = !a || a.pct === 0;
      $('aNoteBox').hidden = !a;
      if ($('aConfirmBox')) $('aConfirmBox').style.display = a ? 'flex' : 'none';
      if (a && a.pct > 0 && !e.refundState) $('aAmount').value = Math.round(Number(e.quotedPrice || 0) * a.pct * 100) / 100;
      const v = $('aAction').value;
      const warn = v === 'CANCEL_FULL' && e.artistStartedAt ? `Siva marked this as started on ${day(e.artistStartedAt)}: policy is the 50% refund. Continue only if you agreed otherwise.`
        : v === 'CANCEL_HALF' && e.zohoPOId && !e.artistStartedAt ? "Siva hasn't marked this as started: policy is a full refund. Continue only if he told you he started." : '';
      $('aWarn').textContent = warn; $('aWarn').hidden = !warn;
    });
  }
  if ($('cArtist')) {
    $('cArtist').addEventListener('change', () => {
      const o = $('cArtist').selectedOptions[0];
      curAed = !!$('cArtist').value && (o.dataset.country || 'UAE') !== 'India';
      $('cInrLabel').textContent = `Artist price (${curAed ? 'AED' : 'INR'})`;
      $('cInr').value = '';
      $('cArtistNote').textContent = $('cArtist').value ? `Save to allocate to ${o.dataset.name}: they get an email and see it under Commissions in their portal (price in ${curAed ? 'AED' : 'INR'}).` : 'Siva sees it on his Artist desk.';
      renderCost();
    });
  }
  if ($('costOut')) {
    renderCost();
    ['cInr', 'cTier', 'cDel', 'cFr', 'cIc', 'cLc', 'ePrice'].forEach((id) => { $(id).addEventListener('input', renderCost); $(id).addEventListener('change', renderCost); });
  }

  showThumb(e, det);
  if (e.fileKey) {
    try {
      const { url } = await getUrl({ path: e.fileKey, options: { expiresIn: 900 } });
      $('fileLinks').innerHTML = `<a href="${esc(url.toString())}" target="_blank" rel="noopener">Open uploaded photo</a><span class="muted">Link works for 15 minutes.</span>`;
    } catch (ex) {
      $('fileLinks').innerHTML = `<span class="err">Could not open the upload: ${esc(ex.message)}</span>`;
    }
  }

  if ($('reqPhotos')) {
    const keys = String(e.cancelPhotos || '').split('\n').filter(Boolean);
    Promise.all(keys.map((k) => getUrl({ path: k, options: { expiresIn: 900 } }).then((r) => r.url.toString()).catch(() => null)))
      .then((urls) => { $('reqPhotos').innerHTML = urls.map((u, i) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Damage photo ${i + 1}</a>` : `<span class="err">Photo ${i + 1} unavailable</span>`)).join('') + '<span class="muted">Links work for 15 minutes.</span>'; });
  }
  if ($('rwShip')) {
    $('rwShip').onclick = () => {
      $('eStatus').value = 'SHIPPED';
      $('eStatus').dispatchEvent(new Event('change'));
      $('shipBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => $('eCourierSel').focus(), 400);
    };
  }
  if ($('rtMode')) {
    $('rtMode').addEventListener('change', () => {
      const m = $('rtMode').value;
      $('rtPickup').hidden = m !== 'PICKUP'; $('rtHint').hidden = m !== 'PICKUP'; $('rtTicks').hidden = !m || m === 'NONE';
      if ($('rtPicked')) $('rtPicked').closest('label').hidden = m !== 'PICKUP';
    });
  }
  if ($('rqDecline')) {
    $('rqDecline').onclick = async (ev) => {
      const b = ev.currentTarget; b.disabled = true; $('rqMsg').textContent = 'Saving…';
      try {
        const { data, errors } = await client.models.Enquiry.update({ id: e.id, cancelState: 'DECLINED', cancelReply: $('rqReply').value.trim() || null });
        if (errors?.length) throw new Error(errors[0].message);
        Object.assign(e, data || { cancelState: 'DECLINED' });
        render(); showDetail(e);
      } catch (ex) { $('rqMsg').textContent = ex.message || 'Could not save.'; b.disabled = false; }
    };
  }

  wireSuppliers(e);
  $('checkZoho').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true; $('zohoMsg').textContent = 'Checking Zoho…';
    try {
      const { errors } = await client.mutations.checkZoho({ id: e.id });
      if (errors?.length) throw new Error(errors[0].message);
      await refreshOne(e.id);
    } catch (ex) {
      $('zohoMsg').textContent = '';
      if (sessionGone(ex)) return;
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
    const newAction = $('aAction') && !$('aAction').disabled ? $('aAction').value : '';
    if (newAction) {
      const a = AFTER[newAction];
      const why = !$('aConfirm')?.checked ? 'Tick the confirmation box to record this cancellation / refund.'
        : a.pct > 0 && !(Number($('aAmount').value) > 0) ? 'Enter the refund amount.' : '';
      if (why) { $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${why}</div>`); b.disabled = false; return; }
      $('eStatus').value = a.status;
    } else if ($('eStatus').value === 'CANCELLED' && s !== 'CANCELLED' && e.zohoInvoiceId) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">This order is already invoiced. Use "Cancellation, damage or refund" below to cancel it with the right refund.</div>');
      b.disabled = false; return;
    }
    if (s === 'REPLACEMENT' && SHIP_STATUSES.includes($('eStatus').value) && e.reworkStage !== 'READY' && !$('rwReady')?.checked) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">The replacement isn\'t confirmed ready: tick “I have checked the reworked piece” in the Replacement box first.</div>');
      b.disabled = false; return;
    }
    if ($('reworkBox')) {
      const v = (id) => $(id)?.value?.trim();
      const isOn = (id) => !!$(id)?.checked;
      const t = $('rwType').value || e.reworkType || '';
      const why = $('rtMode').value === 'PICKUP' && isOn('rtPicked') && !v('rtAwb') ? 'Enter the return AWB before marking it picked up.'
        : isOn('tsSent') && (!v('tsCourier') || !v('tsAwb')) ? 'Enter the courier and AWB for the parcel to Siva.'
        : isOn('tsSent') && !isOn('rtRecv') && $('rtMode').value !== 'NONE' ? 'Tick “Received at the frame shop” before sending it to Siva.'
        : isOn('rwReady') && !$('rwReady').disabled && ['PICKUP', 'DROP'].includes($('rtMode').value) && !isOn('rtRecv') ? 'The damaged piece hasn\'t been received at the frame shop yet.'
        : isOn('rwReady') && !$('rwReady').disabled && t.startsWith('SIVA') && !isOn('rwBack') ? 'Siva\'s piece isn\'t back at the frame shop yet: tick that first.'
        : isOn('rwBack') && !$('rwBack').disabled && e.reworkStage !== 'SENT' ? 'Siva hasn\'t marked the rework as sent to the frame shop yet.' : '';
      if (why) { $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${why}</div>`); b.disabled = false; return; }
    }
    if ($('rwType') && !$('rwType').disabled && !$('rwType').value && s === 'REPLACEMENT' && $('rwReady')?.checked) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">Choose the fix (frame shop or Siva) in the Replacement box.</div>');
      b.disabled = false; return;
    }
    const blockWhy = statusBlock(e, $('eStatus').value, s);
    if (blockWhy) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${blockWhy === 'not for crafts' ? 'Crafts shop orders skip “Being framed”.' : blockWhy === 'waiting for Siva' ? 'Siva hasn\'t marked this work “Sent to frame shop” yet. Update it on his page first (you can do it for him there).' : 'Mark it Shipped before Delivered.'}</div>`);
      b.disabled = false; return;
    }
    if (SHIP_STATUSES.includes($('eStatus').value) && !SHIP_STATUSES.includes(s)) {
      const courier = $('eCourier').value.trim(), awb = $('eAwb').value.trim();
      const why = !e.zohoInvoiceId ? 'Mark it Paid first, so Zoho has the invoice before it ships.'
        : !($('dAddr')?.value.trim()) || !$('dRegion')?.value ? 'Add the delivery address (emirate or state, and address) before it ships.'
        : !courier ? 'Add the courier before marking it shipped.'
        : !awb && !/own/i.test(courier) ? 'Add the AWB / tracking number before marking it shipped.' : '';
      if (why) { $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${why}</div>`); b.disabled = false; return; }
    }
    if (locked && BEFORE_PAYMENT.includes($('eStatus').value) && $('eStatus').value !== s) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">Locked: ${e.ziinaPaidAt && !e.zohoPaymentId ? 'the customer has paid online with Ziina.' : 'reverse the payment in Zoho first, then press Check Zoho.'}</div>`);
      b.disabled = false; return;
    }
    // Someone else (or Ziina, the customer, a supplier) changed this order since it was opened: don't overwrite it.
    try {
      const fresh = (await client.models.Enquiry.get({ id: e.id })).data;
      if (fresh && fresh.updatedAt && e.updatedAt && fresh.updatedAt !== e.updatedAt && (fresh.status !== e.status || fresh.ziinaPaidAt !== e.ziinaPaidAt || fresh.quotedPrice !== e.quotedPrice)) {
        Object.assign(e, fresh); all = all.map((x) => (x.id === e.id ? e : x));
        render(); showDetail(e);
        setTimeout(() => $('detail').querySelector('#saveMsg')?.insertAdjacentHTML('afterend', `<div class="err">This order changed while it was open (now <b>${esc(STATUS[fresh.status] || fresh.status)}</b>${fresh.ziinaPaidAt ? ', paid with Ziina' : ''}). It has been reloaded: check it, then make your change again.</div>`), 50);
        return;
      }
    } catch { /* could not check: carry on */ }
    const savedAt = new Date().toISOString();
    const invNo = $('pInv') && !$('pInv').disabled ? $('pInv').value.trim() : null;
    const paidRef = $('pPaid') && !$('pPaid').disabled ? $('pPaid').value.trim() : null;
    const costingChanged = $('costing') && !e.zohoPOId;
    // Artist allocation (before the order is placed): Siva (empty) or an approved portal artist.
    let artistPick = null;
    if ($('cArtist') && !$('cArtist').disabled && ($('cArtist').value || '') !== (e.artistId || '')) {
      const o = $('cArtist').selectedOptions[0];
      artistPick = $('cArtist').value ? { artistId: $('cArtist').value, artistName: o.dataset.name || o.textContent, artistCountry: o.dataset.country || 'UAE' } : { artistId: null, artistName: null, artistCountry: null };
    }
    const sellerPaid = $('mPaid') && !$('mPaid').disabled ? $('mPaid').value.trim() : null;
    const toZoho = (!locked && (($('eStatus').value === 'PAID' && s !== 'PAID') || (priceVal !== '' && Number(priceVal) !== Number(e.quotedPrice ?? NaN))))
      || (SHIP_STATUSES.includes($('eStatus').value) && $('eStatus').value !== s && !!e.zohoInvoiceId)
      || (locked && hasArtist(e) && (!e.zohoPOId || (invNo && invNo !== (e.artistInvoiceNo || '')) || (paidRef && paidRef !== (e.artistPaidRef || ''))));
    const rw = readRework(e);
    try {
      if (costingChanged) await saveCosting(e);
      if (rw) await saveRework(e, rw);
      const { data, errors } = await client.models.Enquiry.update({
        ...(costingChanged ? { costingAt: savedAt } : {}),
        ...(invNo != null ? { artistInvoiceNo: invNo || null } : {}),
        ...(newAction ? {
          refundAction: newAction,
          refundAmount: AFTER[newAction].pct > 0 ? Number($('aAmount').value) : null,
          refundMethod: AFTER[newAction].pct > 0 ? $('aMethod').value : null,
          refundRef: $('aRef').value.trim() || null,
          refundNote: $('aNote').value.trim() || null,
          refundState: null,
          ...(isReq(e) ? { cancelState: 'DONE' } : {}),
        } : {}),
        courierName: $('eCourier').value.trim() || null,
        trackingNo: $('eAwb').value.trim() || null,
        ...(paidRef != null ? { artistPaidRef: paidRef || null } : {}),
        ...(artistPick ? artistPick : {}),
        ...(sellerPaid != null ? { sellerPaidRef: sellerPaid || null } : {}),
        ...(rw ? rw.enq : {}),
        ...readAddress(e),
        id: e.id,
        phone: $('ePhone').value.trim() || null,
        status: $('eStatus').value,
        paymentMethod: $('ePayMethod').value || null,
        paymentRef: $('ePayRef').value.trim() || null,
        ...(priceLocked(e) ? {} : { quotedPrice: priceVal === '' ? null : Number(priceVal) }),
        paymentLink: $('eLink').value.trim() || null,
        adminMessage: $('eMsg').value.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(e, data || {});
      $('saveMsg').textContent = $('eStatus').value === 'PAID' && s !== 'PAID' && !locked ? 'Saved as Paid. Waiting for Zoho to create the invoice and record the payment…' : 'Saved. The customer sees this under My enquiries & orders and is emailed when the status or message changes.';
      render();
      // Zoho may answer (invoice, challan, Siva's order…): watch for it and refresh the details.
      void toZoho;
      // Rework / return steps don't go through Zoho: redraw now so the ticks and the timeline show what was saved.
      if (rw) { const msg = $('saveMsg').textContent; await showDetail(e); if ($('saveMsg')) $('saveMsg').textContent = msg; }
      waitForZoho(e.id, savedAt);
    } catch (ex) {
      $('saveMsg').textContent = '';
      if (sessionGone(ex)) return;
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

start();
