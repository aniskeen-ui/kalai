// Studio desk: list every enquiry, view uploads, set price / payment link / status / message.
import './stage.js';
import { RC_STYLES, specOf, frameCost, deliveryCost, parseCard, zoneOf, printCost, copiesOf } from './ratecard.js';
import './amplify-config.js';
import './skin.js';
import { signIn, signOut, getCurrentUser, fetchAuthSession, fetchUserAttributes } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';
import { showCatalogue } from './catalogue.js';
import { showMessages } from './messages.js';
import { showMarket } from './market.js';
import { showPromotions } from './promotions.js';
import { showSettings, showSettingTab } from './settings.js';
import { showNumbers } from './numbers.js';
import { showPricing, openPriceFor } from './pricing.js';
import { showNextHelp, hideNextHelp, setHelpMode } from './nexthelp.js';
import { showPrintsMaster, showLicMaster } from './pricemasters.js';
import { showCustomers, openCustomerCode } from './customers.js';
import { countryRegionHtml, wireRegion, addressLine } from './phone.js';
import { awbButtons, wireAwb } from './awb.js';
import { downloadPod, podImage } from './pod.js';
import { watchIcons } from './icons.js';
import outputs from '../amplify_outputs.json';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  RECEIVED: 'Received', PRICE_SENT: 'Price sent', PAID: 'Paid', ARTIST_WORKING: 'Artist working', ARTIST_DONE: 'Artist finished', ARTIST_SENT: 'Sent by artist', PRINTING: 'Printing', PRINTED: 'Printed', FRAMING: 'Being framed',
  SHIPPED: 'Shipped', DELIVERED: 'Delivered', REPLACEMENT: 'Replacement', REFUNDED: 'Refunded', CANCELLED: 'Cancelled',
};
// Sales category, as on the website menu (Collection, Commission, Little Artists, Framed Prints), plus licences and crafts.
const KIND = { PRICE: 'Collection', COMMISSION: 'Commission', GIFT: 'Little Artists', MARKET: 'Crafts shop', PHOTO: 'Framed Prints', LICENCE: 'Image licence' };
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
  printA4: 25, printA3: 40, // Little Artists: printing the child's drawing from the photo (rough Dubai prices: replace with the frame shop's)
  tiers: {
    S: { label: 'Up to A4 (21×30 cm)', framing: 90, courier: 45 },
    M: { label: 'A3 / 38×28 cm', framing: 140, courier: 65 },
    L: { label: '50×70 cm', framing: 220, courier: 110 },
  },
  local: 30, customs: 0.05, fee: 0.03, ins: 0.01, reserve: 0.02, margin: 0.25, vat: 0, fx: 0.042, round9: true, saved: false,
  // Market check: Kalai's target price band per size (simple frame included), and what similar originals list for on
  // Saatchi Art (watercolour / ink by artists from India, ⃃, Oct 2026). Edit under Rates.
  market: {
    S: { sk: [390, 590], wc: [490, 790], saatchi: 'ink 20×15 cm ≈ ⃃ 1,100 · watercolour 30×23 cm ≈ ⃃ 4,300' },
    M: { sk: [590, 890], wc: [790, 1190], saatchi: 'ink 29×22 cm ≈ ⃃ 1,600–1,900 · watercolour 38×28 cm ≈ ⃃ 3,800–4,300' },
    L: { sk: [990, 1490], wc: [1290, 1990], saatchi: 'watercolour 51×38 to 56×76 cm ≈ ⃃ 3,900–7,500' },
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
const CAT_OF = { PRICE: 'collection', COMMISSION: 'commission', GIFT: 'gift', MARKET: 'market', PHOTO: 'gift', LICENCE: 'collection' };
const marginFor = (kind) => { const m = rates.margins?.[CAT_OF[kind] || 'collection']; return m != null ? m : rates.margin; };
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
// Server notes say "AED 1,175"; show the dirham sign on screen.
const escSym = (v) => esc(v).replace(/\bAED (?=\d)/g, '\u20C3 ');
const aed = (v, d = 0) => (v == null ? '–' : '⃃ ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

// Costs from the supplier price lists (Pricing → Margin & charges picks the default supplier, or the cheapest):
// the supplier on the order's job if one is assigned, else the default one's price for this size / style / address.
// No silent fallback: a missing price stays null and the costing says "no supplier price".
const fromOf = (s) => parseCard(s).from || 'UAE';
function pickSupplier(types, pref, costFn, from) {
  const list = suppliers.filter((s) => types.includes(s.type) && (!from || fromOf(s) === from)).map((s) => ({ s, c: costFn(parseCard(s)) })).filter((x) => x.c != null);
  const mine = pref && pref !== 'cheapest' ? list.find((x) => x.s.id === pref) : null;
  const x = mine || list.sort((a, b) => a.c - b.c)[0];
  return x ? { cost: x.c, name: x.s.business, id: x.s.id } : null;
}
function estCosts(e) {
  if (!e) return {};
  const det = parseDetails(e.details), spec = specOf(e, det), j = jobsOf(e), d = rates.defaults || {};
  const fr = j.framer?.price != null ? { cost: Number(j.framer.price), name: j.framer.name, id: j.framer.supplierId } : pickSupplier(['FRAMER'], d.framer, (card) => frameCost(card, spec));
  const outside = ($('cDel')?.value || costings.get(e.id)?.delivery) === 'OUTSIDE', dest = outside ? destOf(e) : null;
  const from = outside ? dest.from : 'UAE';
  const to = outside ? { ...e, deliveryCountry: dest.country === 'UAE' && from === 'UAE' ? 'Oman' : dest.country, deliveryEmirate: dest.country === 'UAE' ? (dest.region || 'Dubai') : dest.region } : { ...e, deliveryCountry: 'UAE', deliveryEmirate: e.deliveryCountry && e.deliveryCountry !== 'UAE' ? 'Dubai' : (e.deliveryEmirate || 'Dubai') };
  const dl = j.delivery?.price != null ? { cost: Number(j.delivery.price), name: j.delivery.name } : (pickSupplier(['COURIER', 'FRAMER'], d.delivery, (card) => deliveryCost(card, to, spec, zoneOf), from) || marketCourier(to, spec, from));
  const pr = j.printer?.price != null ? { cost: Number(j.printer.price), name: j.printer.name } : pickSupplier(['PRINTER'], d.printer, (card) => printCost(card, spec)) || (marketPrint(spec.size) != null ? { cost: marketPrint(spec.size), name: 'market estimate (no print shop yet)' } : null);
  return { spec, framing: fr?.cost ?? null, framingFrom: fr?.name || '', framingFromId: fr?.id || '', local: dl?.cost ?? null, localFrom: dl?.name || '', print: pr?.cost ?? null, printFrom: pr?.name || '' };
}

/** Cost build-up for one enquiry, the suggested price and the margin at a given price. */
function calc(c, price) {
  const est = estCosts(curEnq);
  const tier = rates.tiers[c.sizeTier] || null;
  // Artist price: ₹ (Siva / artists in India) converted at the master rate, or ⃃ for artists in the UAE.
  const artistAed = c.artistPriceAed != null ? Number(c.artistPriceAed) : c.artistPriceInr ? c.artistPriceInr * rates.fx : null;
  const framing = c.framingOverride ?? est.framing ?? null;
  // An artist in the UAE: no courier from India and no customs.
  const indiaCourier = c.indiaCourierOverride ?? (c.local ? 0 : tier?.courier ?? null);
  const localCourier = c.localCourierOverride ?? est.local ?? null;
  const vat = c.delivery === 'OUTSIDE' ? 0 : rates.vat;
  if (artistAed == null || framing == null || indiaCourier == null || localCourier == null) {
    return { artistAed, framing, indiaCourier, localCourier, ready: false, est };
  }
  const customs = c.local ? 0 : (artistAed + indiaCourier) * rates.customs;
  const total = artistAed + framing + indiaCourier + customs + localCourier;
  // Ziina fee, courier insurance and the breakage reserve are all a % of what the customer pays.
  const pctOfPrice = rates.fee + (rates.ins || 0) + (rates.reserve || 0);
  const mg = marginFor(curEnq?.kind);
  const raw = (total * (1 + mg)) / (1 / (1 + vat) - pctOfPrice);
  const suggested = rates.round25 !== false ? Math.ceil(raw / 25) * 25 : rates.round9 ? Math.ceil((raw + 1) / 10) * 10 - 1 : Math.round(raw);
  const out = { artistAed, framing, indiaCourier, localCourier, customs, total, suggested, vatRate: vat, ready: true, mg, est };
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
  if (location.hash === '#customers') showPane('customers', 'tabCustomers');
  await loadRates();
  await varLoad();
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
// Pricing tab: all the price masters in one place — Paintings (website prices per artwork), Framed prints and Image
// licences (selling prices), and Margin & charges (Kalai's own figures and the default suppliers; the old Rates tab).
let priceTab = 'paint';
function showPriceTab(t) {
  priceTab = t;
  document.querySelectorAll('#pmTabs [data-pm]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pm === t)));
  $('pmPaint').hidden = t !== 'paint'; $('pmPrints').hidden = t !== 'prints'; $('pmLic').hidden = t !== 'lic'; $('chargesBox').hidden = t !== 'charges';
  if (t === 'paint') showPricing();
  if (t === 'prints') showPrintsMaster($('pmPrints'));
  if (t === 'lic') showLicMaster($('pmLic'));
  if (t === 'charges') loadArtists().catch(() => {}).then(() => showRates());
}
document.querySelectorAll('#pmTabs [data-pm]').forEach((b) => { b.onclick = () => showPriceTab(b.dataset.pm); });
window.kalaiPriceTab = showPriceTab;
// "Kalai margin & charges" (the old Rates tab) now lives in Pricing → Margin & charges.
window.kalaiShowCharges = () => showRates();
$('tabOrders').onclick = () => showPane('orders', 'tabOrders');
$('tabReports').onclick = () => showPane('reports', 'tabReports');
$('tabFeedback').onclick = () => showPane('feedback', 'tabFeedback');
$('tabCatalogue').onclick = () => showPane('catalogue', 'tabCatalogue');
$('tabMessages').onclick = () => showPane('messages', 'tabMessages');
$('tabSellers').onclick = () => showPane('sellers', 'tabSellers');
$('tabOffers').onclick = () => showPane('offers', 'tabOffers');
$('tabSettings').onclick = () => showPane('settings', 'tabSettings');
$('tabPricing').onclick = () => showPane('pricing', 'tabPricing');
$('tabCustomers').onclick = () => showPane('customers', 'tabCustomers');
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
  $('customersPane').hidden = pane !== 'customers';
  ['tabOrders', 'tabCustomers', 'tabReports', 'tabFeedback', 'tabCatalogue', 'tabMessages', 'tabSellers', 'tabOffers', 'tabSettings', 'tabPricing'].forEach((t) => $(t)?.setAttribute('aria-selected', String(t === tabId)));
  try { history.replaceState(null, '', ['customers', 'reports', 'feedback', 'catalogue', 'messages', 'sellers', 'offers', 'settings', 'pricing'].includes(pane) ? '#' + pane : location.pathname); } catch { /* ignore */ }
  if (pane === 'reports') renderReport();
  if (pane === 'feedback') renderFeedback();
  if (pane === 'catalogue') showCatalogue();
  if (pane === 'messages') showMessages();
  if (pane === 'sellers') showMarket();
  if (pane === 'offers') showPromotions();
  if (pane === 'settings') {
    let t = 'general'; try { t = localStorage.getItem('kalai-st-tab') || 'general'; } catch { /* */ } if (t === 'site') t = 'general';
    stTab(t);
  }
  if (pane === 'pricing') showPriceTab(priceTab);
  if (pane === 'customers') showCustomers();
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
const SOLD = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED', 'REPLACEMENT', 'REFUNDED'];
const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => (v == null ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function parseCosts(c) {
  let v = c?.costs;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : null;
}

// Actual costs (⃃) from the vendors' bills, entered per paid order.
const ACT_FIELDS = [['artist', 'Artist (paid, ⃃)'], ['framing', 'Frame shop'], ['india', 'Courier India → Dubai'], ['customs', 'Customs / duty'], ['local', 'Courier to the customer'], ['other', 'Other (packing, etc.)']];
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
  for (const [role, f] of [['printer', 'framing'], ['framer', 'framing'], ['delivery', 'local']]) {
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
  if (['PHOTO', 'LICENCE'].includes(e.kind) && out.artist == null) { const ry = royaltyOf(e); if (ry.pct) { out.artist = ry.amount; ref.artist = `${ry.pct}% royalty to ${e.artistName || 'Siva Raja'} (paid with their earnings, no bill)`; } }
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
/** The artist's royalty on a framed print of their painting (or an image licence): the % on the order, else Siva's
 *  default from Pricing. Print prices already include it (base × (1 + %)), so it is price × % / (100 + %). */
function royaltyOf(e) {
  const pct = Number(e.royaltyPct || 0) || (e.kind !== 'PHOTO' ? 0 : e.artistId ? Number(artists.find((a) => a.id === e.artistId)?.royaltyPct || 0) : (!e.artistName || /siva/i.test(e.artistName)) ? Number(rates.sivaRoyalty ?? 10) : 0);
  const base = Number(e.listPrice || e.quotedPrice || 0);
  return { pct, amount: pct ? Math.round(base * pct / (e.kind === 'LICENCE' ? 100 : 100 + pct) * 100) / 100 : 0 };
}
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
  } else if (e.kind === 'LICENCE') {
    // Image licence: nothing to make or ship; the artist's royalty (% of the price) is the only cost.
    const ry = royaltyOf(e);
    k = { artist: ry.amount, framing: 0, india: 0, customs: 0, local: 0 };
    note = `image licence${ry.pct ? `: ${ry.pct}% royalty to ${e.artistName || 'the artist'}` : ''}`;
  } else if (e.kind === 'PHOTO') {
    // Photo framing: print (+ frame unless print only) per copy, from the supplier price lists; UAE delivery included.
    const gd = parseDetails(e.details), sp = specOf(e, gd);
    const es = estCosts(e), print = Number(es.print || 0), frm = sp.style === 'none' ? 0 : Number(es.framing || 0);
    // A print of a painting: the artist's royalty (% of the price) is their share, shown under Artist.
    const ry = royaltyOf(e);
    k = { artist: ry.amount, framing: (print + frm) * copiesOf(gd), india: 0, customs: 0, local: Number(es.local || 0) };
    note = `est. from supplier prices (print + frame${ry.pct ? ` + ${ry.pct}% royalty to ${e.artistName || 'Siva Raja'}` : ''})${es.framing == null || es.print == null ? ' · some supplier prices missing' : ''}`;
  } else if (e.kind === 'GIFT') {
    // Print (from the photo) + framing, per copy; A3 when the customer chose the large size.
    const gd = parseDetails(e.details), es = estCosts(e);
    const per = Number(es.framing || 0) + Number(es.print || 0);
    k = { artist: 0, framing: per * copiesOf(gd), india: 0, customs: 0, local: Number(es.local || 0) };
    note = `est. from supplier prices (print + frame)${es.framing == null || es.print == null || es.local == null ? ' · some supplier prices missing' : ''}`;
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

// Reports currency (top of Reports): figures are kept in dirhams and converted for display / CSV.
// US$ at the fixed peg; ₹ at the Rates exchange rate (dirhams per rupee).
const RCUR_SYM = { AED: '⃃', USD: '$', INR: '₹' };
const RCUR = () => $('rCur')?.value || 'AED';
const rFactor = () => (RCUR() === 'USD' ? 1 / 3.6725 : RCUR() === 'INR' ? 1 / (Number(rates.fx) || 0.044) : 1);
try { const c = localStorage.getItem('kalaiReportCur'); if (c && $('rCur')) $('rCur').value = c; } catch { /* storage blocked */ }
function renderReport() {
  const f = rFactor(), rmon = (v) => (v == null ? '–' : (Number(v) * f).toLocaleString(RCUR() === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
    tile(`Sales (${RCUR_SYM[RCUR()]})`, rmon(T.sales)),
    tile('Refunds', rmon(T.refund)),
    tile('Net sales', rmon(T.net)),
    tile('Total cost', rmon(T.cost)),
    tile('Planned margin', `${rmon(T.margin)} · ${pct == null ? '–' : (pct * 100).toFixed(1) + '%'}`, T.margin < 0 ? 'neg' : ''),
    tile(`Actual margin (${withAct.length} of ${costed.length} with bills)`, withAct.length ? `${rmon(T.actA)} · ${pctA == null ? '–' : (pctA * 100).toFixed(1) + '%'}` : '–', T.actA < 0 ? 'neg' : ''),
    tile('Variance on those orders', withAct.length ? rmon(T.actA - T.planA) : '–', T.actA - T.planA < 0 ? 'neg' : ''),
    (() => { const loss = sum((l) => l.rc.cost), rec = sum((l) => l.rc.received), res = sum((l) => l.reserve); return loss || rec ? tile('Damage: cost / insurance / reserve', `${rmon(loss)} / ${rmon(rec)} / ${rmon(res)}`, loss - rec > res ? 'neg' : '') : ''; })(),
    (() => { const rv = lines.map((l) => reviews.get(l.e.id)).filter(Boolean); const a = avgRating(rv); return tile('Customer rating', a == null ? '–' : `${a.toFixed(1)} ★ (${rv.length})`, a != null && a < 4 ? 'neg' : ''); })(),
  ].join('') + (lines.length - costed.length ? `<div class="tile"><div class="k">Without costing</div><div class="v neg">${lines.length - costed.length}</div></div>` : '');
  const td = (v, cls = '') => `<td class="num ${cls}">${rmon(v)}</td>`;
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

['rFrom', 'rTo', 'rKind', 'rBasis', 'rCur'].forEach((id) => $(id).addEventListener('change', renderReport));
$('rCur').addEventListener('change', () => { try { localStorage.setItem('kalaiReportCur', RCUR()); } catch { /* storage blocked */ } });
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
  const fx = rFactor(), cv = (v) => (v === '' || v == null || typeof v !== 'number' ? v : Math.round(v * fx * 100) / 100);
  const rows = reportLines().map((l) => [String(l.e.createdAt || '').slice(0, 10), l.e.ref, l.e.title, l.e.customerName, STATUS[l.e.status] || l.e.status,
    l.price, l.refund, l.net, l.k ? r2(l.k.artist) : '', l.k ? r2(l.k.framing) : '', l.k ? r2(l.k.india) : '', l.k ? r2(l.k.customs) : '', l.k ? r2(l.k.local) : '', l.k ? r2(l.k.rework) : '',
    l.fee, l.total ?? '', l.margin ?? '', l.pct == null ? '' : (l.pct * 100).toFixed(1) + '%',
    ...['artist', 'framing', 'india', 'customs', 'local', 'other'].map((f) => { const a = actualOf(costings.get(l.e.id), l.e); return a && a[f] != null && a[f] !== '' ? r2(Number(a[f])) : ''; }),
    l.haveAct ? l.totalA : '', l.marginA ?? '', l.pctA == null ? '' : (l.pctA * 100).toFixed(1) + '%', l.marginA == null ? '' : r2(l.marginA - l.margin), l.note].map((v, i) => (i >= 5 ? cv(v) : v)));
  head.push(`Currency: ${RCUR()}`);
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
$('fClear').onclick = () => { $('fVar').value = ''; try { localStorage.setItem('kalai-variant', ''); } catch { /* */ } $('fSearch').value = ''; $('fCust').value = ''; $('fFrom').value = ''; $('fTo').value = ''; $('fStatus').value = ''; $('fKind').value = ''; render(); };
// Click a customer code on an order: list all that customer's orders.
document.addEventListener('click', (ev) => { const b = ev.target.closest?.('[data-openprice]'); if (!b) return; ev.preventDefault(); priceTab = 'paint'; showPane('pricing', 'tabPricing'); openPriceFor(b.dataset.openprice); });
document.addEventListener('click', (ev) => { const c = ev.target.closest?.('[data-opencust]'); if (!c) return; showPane('customers', 'tabCustomers'); openCustomerCode(c.dataset.opencust); });
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
  printProspects = (r.data || []).filter((p) => p.type === 'PRINTER' && p.status === 'PROSPECT' && parseCard(p).fineArt !== false);
  courierProspects = (r.data || []).filter((p) => p.type === 'COURIER' && p.status === 'PROSPECT');
  suppliers = (r.data || []).filter((p) => ['FRAMER', 'COURIER', 'PRINTER'].includes(p.type) && p.status === 'APPROVED').sort((a, b) => String(a.business).localeCompare(String(b.business)));
}
let suppliers = []; // approved frame shops (FRAMER) and delivery partners (COURIER)
// Print shops not approved yet (prospects with a fine-art estimate): their median is the "market estimate" for print
// until a print shop is approved (Artists & sellers → Frame, print & delivery → Print shops to ask for quotes).
let printProspects = [];
// Couriers researched but not approved yet (Delivery partners → couriers to ask for quotes): the cheapest of their
// estimate / published prices is the planned delivery cost until an approved courier has a price for that place.
let courierProspects = [];
function marketCourier(to, spec, from) {
  const x = courierProspects.filter((p) => fromOf(p) === from).map((p) => ({ p, c: deliveryCost(parseCard(p), to, spec, zoneOf) })).filter((v) => v.c != null).sort((a, b) => a.c - b.c)[0];
  return x ? { cost: x.c, name: `${x.p.business} (market estimate)` } : null;
}
function marketPrint(size) {
  const v = printProspects.map((p) => Number(parseCard(p).print?.[size])).filter((x) => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
}
// Price lists change in the supplier portal (often in another tab): reload when coming back to this tab.
window.addEventListener('focus', () => { loadArtists().catch(() => {}); });
const jobsOf = (e) => { let v = costings.get(e.id)?.supplierJobs; try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; } return v && typeof v === 'object' ? v : {}; };
const JOB_STAGE = { ASSIGNED: 'sent, waiting to accept', ACCEPTED: 'accepted', READY: 'framed, ready for pickup', COLLECTED: 'collected', PICKED: 'picked up (Shipped)', DELIVERED: 'delivered' };
/** Frame shop & delivery partner for a paid order (supplier portal). */
// WhatsApp the job to the supplier (message typed in; you press Send): handy for shops that don't use the portal yet.
function jobWa(e, cur, role, spec) {
  // Closed order (or this job finished): nothing left to message the supplier about.
  if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(e.status) || ['DELIVERED', 'COLLECTED'].includes(cur?.stage) && !(role === 'printer' && false)) return '';
  const sp = suppliers.find((x) => x.id === cur.supplierId);
  const n = String(sp?.phone || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(?=5)/, '971');
  if (n.length < 9) return '';
  const det = parseDetails(e.details);
  const to = [e.deliveryName || e.customerName, e.deliveryPhone || e.phone, [e.deliveryAddress, e.deliveryEmirate, e.deliveryCountry && e.deliveryCountry !== 'UAE' ? e.deliveryCountry : ''].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const fj = jobsOf(e).framer, fsp = fj && suppliers.find((x) => x.id === fj.supplierId);
  const lines = role === 'printer'
    ? [`Kalai Art House printing job ${e.ref}: ${e.title}`, `Print: ${spec.size}${Number(det.Copies) > 1 ? ` × ${det.Copies}` : ''}, fine-art matte paper`, cur.price != null ? `Agreed price: AED ${cur.price}` : '', cur.due ? `Please finish by ${cur.due}` : '', cur.note ? `Note: ${cur.note}` : '',
      `Hand the print to: ${fsp ? [fsp.business, fsp.phone, fsp.address].filter(Boolean).join(', ') : 'Kalai Art House (we confirm where)'}`, sp?.owner ? 'Full-size file: art.pranixtechno.com/supplier.html' : 'I will send you the full-size file here.']
    : role === 'framer'
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
  return m.length ? `<span class="muted" style="font-size:12px">Their ${esc(style)} frames: ${m.map((f) => `${esc(f.name)}${f.widthMm ? ` ${esc(f.widthMm)} mm` : ''}${f.extra ? ` (+⃃ ${esc(f.extra)})` : ''}`).join('; ')}</span><br>` : '';
}
// The frame shop's name, phone and address, as the delivery pickup point.
function j0(e) { const fj = jobsOf(e).framer; const sp = fj && suppliers.find((x) => x.id === fj.supplierId); return sp ? [sp.business, sp.phone, sp.address].filter(Boolean).join(', ') : ''; }
// Image licence order: what was licensed. The customer downloads the file themselves once paid (no address, no shipping).
function licenceSection(e) {
  const d = parseDetails(e.details);
  return `<fieldset class="cost"><legend>Image licence</legend><div style="display:grid;gap:4px;font-size:13px">
    <div><b>${esc(d.Licence || e.licenceType || '')}</b> · ${esc(d.Artwork || '')} <span class="mono muted">${esc(d['Artwork no.'] || '')}</span></div>
    <div class="muted">${esc(d.Allows || '')}</div>
    <div>${['PAID', 'DELIVERED'].includes(e.status) ? 'Paid: the customer downloads the full-size file under My enquiries &amp; orders.' : 'The Ziina link was sent automatically; once paid the order is marked Delivered and the file can be downloaded.'}</div>
    <div class="muted">Artist: ${esc(e.artistName || 'Siva Raja')}${e.royaltyPct ? ` · royalty ${e.royaltyPct}%` : ''}</div></div></fieldset>`;
}

function supplierSection(e) {
  if (!SOLD.includes(e.status || '') || e.kind === 'MARKET' || e.kind === 'LICENCE') return '';
  const j = jobsOf(e);
  // Each supplier's price for this order from their price list (frame style + size; destination and parcel size).
  const spec = specOf(e, parseDetails(e.details));
  // Little Artists: the frame shop prints the drawing too (print + frame, per copy).
  const gift = e.kind === 'GIFT' || e.kind === 'PHOTO', copies = gift ? copiesOf(parseDetails(e.details)) : 1;
  // With a print shop on the job, the frame shop only frames; otherwise it prints too.
  const framerCost = (card) => { const f = frameCost(card, spec); if (!gift) return f; if (j.printer) return f == null ? null : Math.round(f * copies * 100) / 100; const p = printCost(card, spec); return f == null || p == null ? null : Math.round((f + p) * copies * 100) / 100; };
  const printerCost = (card) => { const p = printCost(card, spec); return p == null ? null : Math.round(p * copies * 100) / 100; };
  const costFor = (s, role) => (role === 'framer' ? framerCost(parseCard(s)) : role === 'printer' ? printerCost(parseCard(s)) : deliveryCost(parseCard(s), e, spec, zoneOf));
  const row = (role, label, type) => {
    const cur = j[role];
    // Delivery: delivery partners, and frame shops that deliver (delivery charges in their price list).
    const list = suppliers.filter((s) => s.type === type || (role === 'delivery' && s.type === 'FRAMER' && Object.keys(parseCard(s).uae || {}).length)).map((s) => ({ ...s, cost: costFor(s, role), shop: s.type === 'FRAMER' && role === 'delivery' }))
      .sort((a, b) => (a.cost == null) - (b.cost == null) || (a.cost ?? 0) - (b.cost ?? 0) || String(a.business).localeCompare(String(b.business)));
    const best = list.find((s) => s.cost != null);
    const locked = cur && !['ASSIGNED', 'ACCEPTED'].includes(cur.stage);
    const self = role === 'delivery' && cur && j.framer && cur.supplierId === j.framer.supplierId;
    return `<div style="display:grid;gap:6px;padding:8px 0;border-top:1px solid var(--line)">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b>${label}</b>${cur ? jobWa(e, cur, role, spec) : ''}${cur ? `<span class="muted">${supLink(cur.name, cur.name) || esc(cur.name)} · ${esc((role === 'printer' && cur.stage === 'READY' ? 'printed, ready to collect' : JOB_STAGE[cur.stage]) || cur.stage)}${cur.awb ? ` · AWB ${esc(cur.awb)}` : ''}${cur.invoiceNo ? ` · invoice ${esc(cur.invoiceNo)} ${aed(cur.invoiceAmt, 2)}${cur.bill ? ` → Zoho bill ${esc(cur.bill)}${cur.billState && cur.billState !== 'open' ? ` (${esc(cur.billState)})` : ''}` : ''}` : ''}${cur.message ? ` · <span class="warn-t">${esc(cur.message)}</span>` : ''}</span>` : '<span class="muted">not given yet</span>'}</div>
      ${role === 'delivery' && cur ? deliveryDocs(cur) : ''}
      ${self ? '<div class="muted" style="font-size:12px">The frame shop delivers this one itself.</div>' : locked ? '' : `<div class="three" style="align-items:end">
        <div class="field" style="grid-column:1/-1"><label>${role === 'framer' ? 'Frame shop' : role === 'printer' ? 'Print shop' : 'Delivery partner'}</label><select data-js="${role}-sid"><option value="">${list.length ? 'Choose…' : `none approved yet (Artists & sellers → Frame shops & delivery)`}</option>${list.map((s) => `<option value="${esc(s.id)}" data-cost="${s.cost ?? ''}" ${cur?.supplierId === s.id ? 'selected' : ''}>${esc(s.business)}${s.shop ? ' (frame shop)' : ''} · ${s.cost != null ? `⃃ ${s.cost}` : 'no price for this'}${s.emirate ? ` · ${esc(s.emirate)}` : ''}</option>`).join('')}</select>
          ${role === 'framer' && cur ? framesOf(cur.supplierId, spec.style) : ''}<span class="muted" style="font-size:12px">${role === 'printer' ? `Print ${esc(spec.size)}${copies > 1 ? ` × ${copies}` : ''}, fine-art matte` : role === 'framer' ? `${gift ? `${j.printer ? 'Frame only' : 'Print + frame'}${copies > 1 ? ` × ${copies}` : ''}: ` : ''}${esc((RC_STYLES.find((x) => x[0] === spec.style) || ['', spec.style === 'none' ? 'No frame' : spec.style])[1])}, ${esc(spec.size)}` : `${esc(e.deliveryEmirate || e.deliveryCountry || 'address not set')}, ${esc(spec.size)} frame`}${best ? ` · cheapest: ${esc(best.business)} ⃃ ${best.cost}` : ' · no price lists yet'}</span></div>
        <div class="field"><label>Price you pay them (⃃)</label><input data-js="${role}-price" type="number" min="0" step="1" value="${cur?.price ?? ''}"></div>
        <div class="field"><label>Finish by</label><input data-js="${role}-due" type="date" value="${esc(cur?.due || '')}"></div></div>
        <div class="field"><label>${role === 'framer' ? 'Note for them (frame style, size, glass, timing…)' : role === 'printer' ? 'Note for them (paper, crop, colour, timing…)' : 'Note for them (pickup time, contact, handling…)'}</label><input data-js="${role}-note" maxlength="500" value="${esc(cur?.note || '')}"></div>
        ${role === 'framer' && !j.delivery ? `<label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" data-js="framer-deliver" style="width:auto" ${cur?.canDeliver ? 'checked' : ''}> Ask them to deliver too, for ⃃ <input data-js="framer-dprice" type="number" min="0" step="1" value="${cur?.deliveryPrice ?? ''}" style="width:90px"> (they confirm when accepting)</label>` : ''}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn small" data-jobsend="${role}">${cur ? 'Update the job' : 'Send the job'}</button>${cur ? `<button type="button" class="btn small ghost" data-jobremove="${role}">Take it back</button>` : ''}<span class="muted" data-jobmsg="${role}" style="font-size:12px"></span></div>`}
    </div>`;
  };
  return `<fieldset class="cost" id="supplierBox"><legend>Frame shop &amp; delivery</legend>
    <div class="muted" style="font-size:12px">They see this order in their supplier portal: the photo, frame spec and size, your price, and the pickup and delivery addresses. Their steps update the order (Being framed, Shipped, Delivered) and their invoice becomes a Zoho bill.</div>
    ${['PRICE', 'COMMISSION'].includes(e.kind) ? inboundRow(e, j) : ''}${gift ? row('printer', 'Printing', 'PRINTER') : ''}${row('framer', 'Framing', 'FRAMER')}${row('delivery', 'Delivery', 'COURIER')}</fieldset>`;
}
// Delivery row: the airway bill label (display / PDF / print) and the customer's proof of delivery document.
function deliveryDocs(dj) {
  const awb = dj.awb ? `<div class="awb-box" data-awbbox data-awbleg="delivery" style="border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:13px"><span class="muted">Airway bill</span> <b class="mono">${esc(dj.awb)}</b> · ${esc(dj.name)}</div>${awbButtons()}<span class="muted" data-awbmsg style="font-size:12px"></span></div>` : '';
  const pod = dj.pod ? `<div data-podbox style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:grid;gap:6px"><div style="font-size:13px">✓ <b>Proof of delivery</b>: received by <b>${esc(dj.pod.name)}</b> · ${esc(day(dj.pod.at))}${dj.pod.signKey ? ' · signed' : ''}${dj.pod.photoKeys?.length ? ` · ${dj.pod.photoKeys.length} photo${dj.pod.photoKeys.length > 1 ? 's' : ''}` : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn small" data-pod="show">👁 Display POD</button><button type="button" class="btn small ghost" data-pod="pdf">📄 Download POD (PDF)</button></div><div data-podshow hidden></div><span class="muted" data-podmsg style="font-size:12px"></span></div>`
    : dj.deliveredAt ? `<div class="muted" style="font-size:12px;color:var(--kumkum)">Delivered, no proof of delivery yet: ${esc(dj.name)} can add it in their portal.</div>` : '';
  return awb + pod;
}
// The courier for the artist's parcel (artist → frame shop). The artist prints its airway bill label when the work is finished.
function inboundRow(e, j) {
  const ib = j.inbound, sent = e.artistStage === 'SHIPPED';
  const list = suppliers.filter((s) => s.type === 'COURIER');
  return `<div style="display:grid;gap:6px;padding:8px 0;border-top:1px solid var(--line)" data-inbound>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><b>Artist → frame shop courier</b>${ib ? `<span class="muted">${esc(ib.name)}${ib.awb ? ` · AWB <span class="mono">${esc(ib.awb)}</span>` : ` · airway bill made when the artist marks it finished`}</span>` : '<span class="muted">not allocated: the artist types the courier and AWB</span>'}</div>
    ${sent && ib?.awb ? '' : `<div class="three" style="align-items:end">
      <div class="field"><label>Courier</label><select data-ib="sid"><option value="">${list.length ? 'Choose…' : 'none approved yet (Artists & sellers)'}</option>${list.map((s) => `<option value="${esc(s.id)}" ${ib?.supplierId === s.id ? 'selected' : ''}>${esc(s.business)}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:span 2"><label>Pickup address (blank = the artist's profile)</label><input data-ib="addr" maxlength="300" value="${esc(ib?.from?.address || '')}" placeholder="Artist's address for the courier"></div></div>
      <div class="three" style="align-items:end"><div class="field"><label>Artist name on the label</label><input data-ib="name" maxlength="120" value="${esc(ib?.from?.name || (e.artistId ? '' : 'Siva Raja'))}"></div><div class="field"><label>Artist phone</label><input data-ib="phone" maxlength="30" value="${esc(ib?.from?.phone || '')}"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn small" data-ibsave>${ib ? 'Update courier' : 'Allocate courier'}</button>${ib ? '<button type="button" class="btn small ghost" data-ibremove>Remove</button>' : ''}</div></div>`}
    ${ib?.awb ? `<div class="awb-box" data-awbbox data-awbleg="inbound" style="border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:13px"><span class="muted">Artist's airway bill</span> <b class="mono">${esc(ib.awb)}</b> · ${esc(ib.name)}</div>${awbButtons()}<span class="muted" data-awbmsg style="font-size:12px"></span></div>` : ''}
    <span class="muted" data-ibmsg style="font-size:12px"></span>
  </div>`;
}
function wireSuppliers(e) {
  const box = $('supplierBox'); if (!box) return;
  const v = (k) => box.querySelector(`[data-js="${k}"]`);
  box.querySelectorAll('[data-awbbox]').forEach((ab) => {
    const m = ab.querySelector('[data-awbmsg]');
    wireAwb(ab, async () => {
      const r = await client.mutations.marketAdmin({ action: 'adminLabel', data: JSON.stringify({ id: e.id, leg: ab.dataset.awbleg }) });
      if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
      return (typeof r.data === 'string' ? JSON.parse(r.data) : r.data).label;
    }, (t, ok) => { m.textContent = t; m.style.color = ok ? '' : 'var(--kumkum)'; });
  });
  const pb = box.querySelector('[data-podbox]');
  if (pb) {
    const dj = jobsOf(e).delivery;
    const data = () => ({ ref: e.ref, title: e.title, awb: dj.awb, courier: dj.name, pickedAt: dj.pickedAt, deliveredAt: dj.deliveredAt, pod: dj.pod,
      to: { name: e.deliveryName || e.customerName, phone: e.deliveryPhone || e.phone, address: addressLine(e) } });
    const pm = pb.querySelector('[data-podmsg]'), ps = pb.querySelector('[data-podshow]');
    pb.querySelectorAll('[data-pod]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.pod === 'show' && !ps.hidden) { ps.hidden = true; ps.innerHTML = ''; b.textContent = '👁 Display POD'; return; }
        pm.textContent = 'Making the proof of delivery…';
        try {
          if (b.dataset.pod === 'show') { ps.innerHTML = `<img alt="Proof of delivery ${esc(e.ref)}" src="${await podImage(data())}" style="width:100%;max-width:560px;border:1px solid var(--line);border-radius:6px;background:#fff">`; ps.hidden = false; b.textContent = '✕ Hide POD'; }
          else await downloadPod(data());
          pm.textContent = '';
        } catch (ex) { pm.textContent = ex.message; }
      };
    });
  }
  box.querySelectorAll('[data-ibsave],[data-ibremove]').forEach((b) => {
    b.onclick = async () => {
      const ib = (k) => box.querySelector(`[data-ib="${k}"]`)?.value.trim() || '';
      const msg = box.querySelector('[data-ibmsg]');
      const data = { id: e.id, supplierId: b.dataset.ibremove != null ? '' : ib('sid'), fromName: ib('name'), fromPhone: ib('phone'), fromAddress: ib('addr') };
      if (b.dataset.ibsave != null && !data.supplierId) { msg.textContent = 'Choose the courier.'; return; }
      b.disabled = true; msg.textContent = 'Saving…';
      try {
        const r = await client.mutations.marketAdmin({ action: 'artistCourier', data: JSON.stringify(data) });
        if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
        const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        costings.set(e.id, { ...(costings.get(e.id) || { enquiryId: e.id }), supplierJobs: JSON.stringify(out.jobs || {}) });
        box.outerHTML = supplierSection(e); wireSuppliers(e);
        const m2 = $('supplierBox').querySelector('[data-ibmsg]'); if (m2) m2.textContent = data.supplierId ? 'Saved: the courier was emailed; the artist sees the airway bill when the work is finished.' : 'Removed.';
      } catch (ex) { msg.textContent = ex.message; b.disabled = false; }
    };
  });
  ['printer', 'framer', 'delivery'].forEach((role) => {
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
let curAed = false; // the open order's artist prices in ⃃ (artist in the UAE)

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
  const vr0 = variantOn(), base = vr0 ? all.filter((e) => vr0.refs.includes(e.ref)) : all; // counts follow the variant
  base.forEach((e) => { const s = e.status || 'RECEIVED'; counts[s] = (counts[s] || 0) + 1; });
  // Click a count to show only those orders; click it again (or "All") to show everything.
  $('counts').innerHTML = (vr0 ? `<span class="chip" style="font-weight:700">${esc(vr0.id)}${vr0.name ? ` · ${esc(vr0.name)}` : ''}</span> ` : '') + (base.length ? `<button type="button" class="count" data-st="" aria-pressed="${!fs}">All <b>${base.length}</b></button>` : '')
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
  // A variant (saved selection of orders): only its orders, whatever their dates.
  const vr = variantOn();
  const list = all.filter((e) => (vr ? vr.refs.includes(e.ref) : true) && (!fs || (fs === '__REQ' ? isReq(e) : (e.status || 'RECEIVED') === fs)) && (!fk || e.kind === fk)
    && hit(e) && (vr || ((!from || dubaiDay(e.createdAt) >= from) && (!to || dubaiDay(e.createdAt) <= to))));
  $('rows').innerHTML = list.length ? list.map((e) => {
    const s = e.status || 'RECEIVED';
    const d = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
    return `<tr data-id="${esc(e.id)}" tabindex="0" class="${e.id === selectedId ? 'sel' : ''}">
      <td>${varPicking ? `<input type="checkbox" data-vpick="${esc(e.ref)}" ${varPick.has(e.ref) ? 'checked' : ''} style="width:auto;margin-right:6px" aria-label="Add to the variant">` : ''}${esc(d)}</td><td class="mono">${esc(e.ref)}</td><td>${esc(KIND[e.kind] || '')}${e.kind === 'PRICE' && offerOf(e) != null ? '<br><span class="muted" style="font-size:11px">offer</span>' : e.kind === 'PRICE' ? '<br><span class="muted" style="font-size:11px">original</span>' : ''}</td>
      <td style="white-space:normal;min-width:180px">${esc(e.title)}</td><td>${esc(e.customerName)}${e.customerCode ? `<br><span class="muted mono" style="font-size:11px">${esc(e.customerCode)}</span>` : ''}</td>
      <td><span class="pill ${s}">${esc(STATUS[s] || s)}</span>${!e.owner ? ' <span class="chip" title="Sent without signing in: the customer can\'t track it online; reply on WhatsApp">Guest</span>' : ''}${offerOf(e) != null && ['RECEIVED', 'PRICE_SENT'].includes(s) ? ` <span class="chip req" title="The customer made an offer">Offer ⃃ ${offerOf(e).toLocaleString('en-US')}</span>` : ''}${isReq(e) ? ` <span class="chip req">${e.cancelRequest === 'CANCEL' ? 'Cancel request' : 'Damage reported'}</span>` : ''}${hasArtist(e) && !costings.get(e.id)?.artistPriceInr && !costings.get(e.id)?.artistPriceAed && !['CANCELLED', 'DELIVERED'].includes(s) ? ` <span class="chip" title="${esc(e.artistName || 'Siva')} hasn't priced this yet">Artist price needed</span>` : ''}${e.artistName ? ` <span class="chip">${esc(e.artistName)}</span>` : ''}${isLocked(e) ? ' <span title="Payment recorded in Zoho" aria-label="Payment recorded in Zoho">🔒</span>' : e.zohoState === 'ERROR' ? ' <span title="Zoho error" aria-label="Zoho error" style="color:var(--kumkum)">⚠</span>' : ''}</td>
      <td class="mono">${e.quotedPrice ? '⃃ ' + Number(e.quotedPrice).toLocaleString('en-US') : '–'}</td></tr>`;
  }).join('') : `<tr><td colspan="7" class="muted">${$('fFrom').value || $('fTo').value ? 'No orders on these dates. Press <b>Clear</b> to see all dates.' : 'Nothing matches this filter.'}</td></tr>`;
  $('rows').querySelectorAll('tr[data-id]').forEach((tr) => {
    const pick = () => { const e = all.find((x) => x.id === tr.dataset.id); if (e) { selectedId = e.id; render(); showDetail(e); } };
    tr.onclick = (ev) => { const cb = ev.target.closest?.('[data-vpick]'); if (cb) { if (cb.checked) varPick.add(cb.dataset.vpick); else varPick.delete(cb.dataset.vpick); varFill(); return; } pick(); };
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
  // Closed order whose actual costs were saved: read-only until "Edit actual costs" (a late bill can still be added).
  const lockA = ['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(e.status) && !!a.at;
  const dA = lockA ? 'disabled' : '';
  // Labels and rows that fit the order: prints have a royalty, a print shop and a frame shop, and no India courier or customs.
  const printed = ['PHOTO', 'GIFT'].includes(e.kind), lic = e.kind === 'LICENCE';
  const LBL = printed ? { artist: e.kind === 'GIFT' ? 'Artist' : 'Artist royalty (print of a painting)', framing: 'Print shop + frame shop' } : lic ? { artist: 'Artist royalty' } : {};
  const rows = ACT_FIELDS.filter(([f]) => !((printed || lic) && ['india', 'customs'].includes(f)) && !(lic && ['framing', 'local'].includes(f)) && !(e.kind === 'GIFT' && f === 'artist')).map(([f, label0]) => { const label = LBL[f] || label0; return `<tr><td>${label}</td><td class="num mono">${plan(f) == null ? '–' : money(plan(f))}</td>
    <td class="num mono" title="${esc(z.ref[f] || '')}">${z.out[f] != null ? money(z.out[f]) : '–'}${z.ref[f] ? `<div class="muted" style="font-size:10px;font-family:inherit;white-space:normal">${esc(z.ref[f])}</div>` : ''}</td>
    <td><input data-act="${f}" ${dA} type="number" min="0" step="0.01" value="${a[f] ?? ''}" placeholder="${z.out[f] != null ? 'uses that' : 'bill amount'}" style="width:110px"></td>
    <td><input data-actref="${f}" ${dA} maxlength="80" value="${esc(ref[f] || '')}" placeholder="vendor · bill no." style="min-width:140px"></td></tr>`; }).join('');
  const mv = l.marginA != null ? `Planned margin <b>${money(l.margin)}</b> · actual <b class="${l.marginA < 0 ? 'neg' : ''}">${money(l.marginA)}</b> · variance <b class="${l.marginA - l.margin < 0 ? 'neg' : ''}">${money(l.marginA - l.margin)}</b>` : `Planned margin <b>${l.margin == null ? '–' : money(l.margin)}</b>. Enter the bills as they come; costs without a bill stay at the planned figure.`;
  return `<fieldset class="cost" id="actualBox"><legend>Actual costs (from bills, ⃃)</legend>
    <div class="tablewrap"><table class="costs"><thead><tr><th>Cost</th><th class="num">Planned</th><th class="num">From Zoho / job</th><th>Your figure</th><th>Vendor · bill no.</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted" style="font-size:12px">From Zoho: the artist's bill and vendor bills whose Reference# contains ${esc(e.ref)} (press Check Zoho to refresh${z.checkedAt ? `; checked ${esc(when(z.checkedAt))}` : ''}); until the frame shop or courier invoices, the price on their job. Your figure, if typed, is used instead.${z.unmapped.length ? ` <b class="warn-t">Not matched to a cost: ${esc(z.unmapped.join(', '))}</b>: add the vendor under Rates → Zoho vendors.` : ''}</div>
    <div class="marginline" id="actSum">${mv}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${lockA ? `<span class="muted" style="font-size:12px">🔒 ${esc(STATUS[e.status] || e.status)}: actual costs are saved and locked.</span><button type="button" class="btn small ghost" id="actEdit" onclick="document.querySelectorAll('#actualBox [data-act],#actualBox [data-actref]').forEach((i)=>{i.disabled=false});this.hidden=true;document.getElementById('actSaveBtn').hidden=false">Edit actual costs (late bill)</button>` : ''}<button type="button" class="btn small" id="actSaveBtn" ${lockA ? 'hidden' : ''} onclick="window.kalaiSaveActual('${esc(e.id)}')">Save actual costs</button><span class="muted" id="actMsg" style="font-size:12px">${a.at ? `Last saved ${esc(when(a.at))}` : ''}</span></div></fieldset>`;
}
window.kalaiSaveActual = async (id) => {
  const e = all.find((x) => x.id === id); if (!e) return;
  const box = $('actualBox'), out = { ref: {} };
  for (const [f, label] of ACT_FIELDS) {
    const inp = box.querySelector(`[data-act="${f}"]`); if (!inp) continue; // row not shown for this kind of order
    const raw = inp.value.trim();
    if (raw !== '') { const v = Number(raw); if (!(v >= 0)) { $('actMsg').textContent = `${label}: enter an amount in ⃃.`; return; } out[f] = Math.round(v * 100) / 100; }
    const rf = (box.querySelector(`[data-actref="${f}"]`)?.value || '').trim(); if (rf) out.ref[f] = rf;
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
    if (['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(e.status)) { await showDetail(e); $('actualBox')?.scrollIntoView({ block: 'center' }); }
  } catch (ex) { $('actMsg').textContent = ex.message; }
};

// Delivery outside the UAE: the destination country and state / region (costs JSON destCountry / destRegion),
// defaulting to the customer's delivery address. The local courier is then the partner's price for that zone.
function destOf(e) {
  let cs = {}; try { const raw = costings.get(e.id)?.costs; cs = (typeof raw === 'string' ? JSON.parse(raw) : raw) || {}; if (typeof cs === 'string') cs = JSON.parse(cs); } catch { cs = {}; }
  const live = $('cDestCountry');
  const country = (live && live.value) || cs.destCountry || (e.deliveryCountry && e.deliveryCountry !== 'UAE' ? e.deliveryCountry : 'India');
  const region = live ? ($('cDestRegion')?.value || '') : (cs.destRegion || (country === e.deliveryCountry ? e.deliveryEmirate || '' : ''));
  const from = ($('cShipFrom')?.value) || cs.shipFrom || 'UAE';
  return { country, region, from };
}
const ZONE_NAME = { A: 'GCC', B: 'South Asia', C: 'UK & Europe', D: 'USA, Canada, Australia, NZ', E: 'rest of the world' };
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
    : `${esc(who)} hasn't priced this yet (${e.artistId ? 'artist portal → Orders to make' : 'Artist desk'}). You can also type the price here.`;
  return `<fieldset class="cost" id="costing">
    <legend>Costing ${lockedPO ? `<span class="muted">· locked: ${esc(e.zohoPO)} placed</span>` : ''}${artNo(e) ? ` <button type="button" class="linkbtn" data-openprice="${esc(artNo(e))}" style="font-size:12px;margin-left:8px" title="Open this artwork in Pricing">Price calculation for ${esc(artNo(e))} →</button>` : ''}</legend>
    ${rates.saved ? '' : '<div class="muted warnline">Margin &amp; charges are not saved yet: set them under <b>Pricing → Margin &amp; charges</b>.</div>'}
    <div class="field"><label for="cArtist">Artist doing this work</label><select id="cArtist" ${dis}>${artistOpts}</select>
      <span class="muted" style="font-size:12px" id="cArtistNote">${lockedPO ? 'Fixed: the order has been placed with this artist.' : e.artistId ? `Allocated to ${esc(who)}: they see it under Orders to make in their portal.` : 'Siva sees it on his Artist desk. Choose another approved artist to allocate it to them (they get an email when you save).'}</span></div>
    <div class="three">
      <div class="field"><label for="cInr" id="cInrLabel">Artist price (${curAed ? '⃃' : '₹'})</label><input id="cInr" type="number" min="0" step="1" value="${(curAed ? c.artistPriceAed : c.artistPriceInr) ?? ''}" ${dis}></div>
      <div class="field"><label for="cTier">Size tier</label><select id="cTier" ${dis}><option value="">Choose…</option>${tierOpts}</select></div>
      <div class="field"><label for="cDel">Delivery</label><select id="cDel" ${dis}><option value="UAE" ${c.delivery !== 'OUTSIDE' ? 'selected' : ''}>UAE</option><option value="OUTSIDE" ${c.delivery === 'OUTSIDE' ? 'selected' : ''}>Outside UAE</option></select></div>
    </div>
    <div class="three" id="cDestBox" ${c.delivery === 'OUTSIDE' ? '' : 'hidden'}>${(() => { const d = destOf(e); return `<div class="field"><label for="cShipFrom">Ships from</label><select id="cShipFrom"><option value="UAE" ${d.from === 'UAE' ? 'selected' : ''}>UAE (Dubai)</option><option value="India" ${d.from === 'India' ? 'selected' : ''}>India (artist / Indian supplier)</option></select></div>${countryRegionHtml({ country: d.country, region: d.region, prefix: 'cDest', names: false })}`; })()}</div>
    <div class="muted" style="font-size:12px" id="cDestNote" ${c.delivery === 'OUTSIDE' ? '' : 'hidden'}></div>
    <div class="muted" style="font-size:12px">${fromSiva}</div>
    <div class="field"><label for="cNote">Note to ${esc(who)} <span class="muted" style="font-weight:400;font-size:12px">· shown on the artist's order card and emailed to them${c.studioNoteAt ? `, last changed ${esc(when(c.studioNoteAt))}` : ''}</span></label><textarea id="cNote" rows="2" maxlength="1000" placeholder="e.g. Please sign at the bottom right; customer wants it before 5 Nov.">${esc(c.studioNote || '')}</textarea></div>
    <details ${c.framingOverride != null || c.indiaCourierOverride != null || c.localCourierOverride != null ? 'open' : ''}><summary>Overrides for this order (premium frame, oversized, abroad)</summary>
      <div class="three" style="margin-top:8px">
        <div class="field"><label for="cFr">Framing (⃃)</label><input id="cFr" type="number" min="0" step="1" value="${c.framingOverride ?? ''}" ${dis}></div>
        <div class="field"><label for="cIc">India courier (⃃)</label><input id="cIc" type="number" min="0" step="1" value="${c.indiaCourierOverride ?? ''}" ${dis}></div>
        <div class="field"><label for="cLc">Local courier (⃃)</label><input id="cLc" type="number" min="0" step="1" value="${c.localCourierOverride ?? ''}" ${dis}></div>
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
// The artist doing this order (Siva unless a portal artist was chosen), and where the studio marks progress for them.
const artistOf = (e) => e.artistName || 'Siva';
const artistPage = (e) => (e.artistId ? `<a href="/seller.html?view=${encodeURIComponent(e.artistId)}" target="_blank" rel="noopener">their artist portal</a> → Orders to make` : 'his Artist desk');
// Order life-cycle. Forward one step at a time; one step back to correct a mistake (before money moves);
// after payment no way back to the quote stages; Delivered / Refunded / Cancelled close the order.
//   Received → Price sent → Paid → Being framed → Shipped → Delivered
//   unpaid: Cancelled (can be reopened) · paid: Refunded · delivered: Replacement (→ framed → shipped → delivered) or Refunded
const NEXT = {
  RECEIVED: ['PRICE_SENT', 'CANCELLED'],
  PRICE_SENT: ['RECEIVED', 'PAID', 'CANCELLED'],
  PAID: ['PRICE_SENT', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'REFUNDED'],
  PRINTING: ['PAID', 'PRINTED', 'FRAMING', 'REFUNDED'],
  PRINTED: ['PRINTING', 'FRAMING', 'SHIPPED', 'REFUNDED'],
  // The artist's steps (set automatically from the artist's desk; can be set by hand too).
  ARTIST_WORKING: ['PAID', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'REFUNDED'],
  ARTIST_DONE: ['ARTIST_WORKING', 'ARTIST_SENT', 'FRAMING', 'REFUNDED'],
  ARTIST_SENT: ['ARTIST_DONE', 'FRAMING', 'SHIPPED', 'REFUNDED'],
  FRAMING: ['PAID', 'ARTIST_SENT', 'PRINTED', 'SHIPPED', 'REFUNDED'],
  SHIPPED: ['FRAMING', 'DELIVERED', 'REFUNDED'],
  DELIVERED: ['REPLACEMENT', 'REFUNDED'],
  REPLACEMENT: ['FRAMING', 'SHIPPED', 'REFUNDED'],
  REFUNDED: [],
  CANCELLED: ['RECEIVED', 'PRICE_SENT'],
};
const WHY = { RECEIVED: 'already priced', PRICE_SENT: 'not now', PAID: 'send the price first', PRINTING: 'mark Paid first', PRINTED: 'mark Paid first', FRAMING: 'mark Paid first', SHIPPED: 'mark Paid first',
  DELIVERED: 'ship it first', REPLACEMENT: 'after delivery', REFUNDED: 'not paid', CANCELLED: 'paid: refund instead' };
function statusBlock(e, k, s) {
  if (k === s) return '';
  const ARTIST_ST = ['ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT'];
  // Only collection works and commissions have an artist making them: prints, gifts, crafts and licences don't.
  if (ARTIST_ST.includes(k) && !hasArtist(e)) return 'no artist on this order';
  if (e.kind === 'MARKET' && k === 'FRAMING') return 'not for crafts';
  // Printing steps: only orders printed from a file (Framed Prints, Little Artists).
  if (['PRINTING', 'PRINTED'].includes(k) && !['PHOTO', 'GIFT'].includes(e.kind)) return 'nothing to print';
  if (e.kind === 'LICENCE' && ['PAID', 'FRAMING', 'SHIPPED', 'REPLACEMENT'].includes(k)) return 'digital licence';
  // A print / gift / crafts order put on an artist step by mistake: back to Paid (or on to framing) is allowed.
  if (ARTIST_ST.includes(s) && !hasArtist(e) && ['PAID', 'FRAMING'].includes(k)) return '';
  // The print shop, frame shop and delivery partner set these steps from their portal (dates and AWB recorded there).
  { const jj = jobsOf(e), pj = jj.printer, fj = jj.framer, dj = jj.delivery, FL = ['PAID', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED'];
    if (s !== 'REPLACEMENT' && e.refundAction !== 'DAMAGED_REPLACE' && FL.includes(k) && FL.indexOf(k) > Math.max(0, FL.indexOf(s))) {
      if (k === 'PRINTING' && pj && pj.stage === 'ASSIGNED') return `set when ${pj.name || 'the print shop'} accepts`;
      if (k === 'PRINTED' && pj && !['READY', 'COLLECTED'].includes(String(pj.stage))) return `set by ${pj.name || 'the print shop'}'s step`;
      if (k === 'FRAMING' && pj && !fj && !['READY', 'COLLECTED'].includes(String(pj.stage))) return `waiting for ${pj.name || 'the print shop'}`;
      if (k === 'FRAMING' && fj && !['ACCEPTED', 'READY', 'COLLECTED'].includes(String(fj.stage))) return `set when ${fj.name || 'the frame shop'} accepts`;
      if (['SHIPPED', 'DELIVERED'].includes(k) && dj && !(k === 'SHIPPED' ? dj.pickedAt : dj.deliveredAt)) return `set by ${dj.name || 'the delivery partner'}'s step`;
      if (['SHIPPED', 'DELIVERED'].includes(k) && !dj && fj && !['READY', 'COLLECTED'].includes(String(fj.stage))) return `waiting for ${fj.name || 'the frame shop'} to finish`;
    } }
  // Moved on without a recorded payment by mistake: it can go back to Price sent.
  const fixUnpaid = k === 'PRICE_SENT' && !isLocked(e) && ['FRAMING', 'SHIPPED'].includes(s);
  if (!fixUnpaid && !(NEXT[s] || []).includes(k)) return s === 'DELIVERED' ? 'already delivered' : ['REFUNDED', 'CANCELLED'].includes(s) && !(NEXT[s] || []).length ? 'order closed' : WHY[k] || 'not now';
  if (needsSiva(e) && !sivaDone(e) && AFTER_SIVA.includes(k)) return `waiting for ${artistOf(e)}`;
  // Collection / commission: framing and shipping only once the artist has sent the work (even before the artist's order exists).
  if (hasArtist(e) && !sivaDone(e) && AFTER_SIVA.includes(k) && e.refundAction !== 'DAMAGED_REPLACE' && s !== 'REPLACEMENT') return `waiting for ${artistOf(e)} to send it`;
  // Steps a supplier has confirmed (frame shop accepted, delivery partner picked up / delivered, delivery challan in
  // Zoho) are facts: the status can't go back behind them.
  const FLOW = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED'];
  if (FLOW.includes(k) && s !== 'REPLACEMENT' && e.refundAction !== 'DAMAGED_REPLACE') {
    const jj = jobsOf(e), fj = jj.framer, dj = jj.delivery, pj = jj.printer;
    const floor = dj?.deliveredAt ? 'DELIVERED' : dj?.pickedAt || dj?.awb || e.zohoChallanId || ['DRAFT', 'OPEN', 'DELIVERED'].includes(e.deliveryState) ? 'SHIPPED'
      : fj && ['ACCEPTED', 'READY', 'COLLECTED'].includes(String(fj.stage)) ? 'FRAMING'
      : pj && ['READY', 'COLLECTED'].includes(String(pj.stage)) ? 'PRINTED' : pj && pj.stage === 'ACCEPTED' ? 'PRINTING' : '';
    if (floor && FLOW.indexOf(k) < FLOW.indexOf(floor)) return floor === 'PRINTED' ? `${pj.name || 'print shop'} already printed it` : floor === 'PRINTING' ? `${pj.name || 'print shop'} accepted the job` : floor === 'FRAMING' ? `${fj.name || 'frame shop'} accepted the job` : floor === 'SHIPPED' ? `already shipped${dj?.name ? ` by ${dj.name}` : ''}` : 'already delivered';
  }
  // The artist's steps set these statuses: not back behind what the artist marked, and not ahead of it by hand
  // (mark the step on the artist page instead, so the AWB and dates are recorded).
  const ART = ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT'];
  if (ART.includes(k) && hasArtist(e)) {
    const at = ART.indexOf({ STARTED: 'ARTIST_WORKING', FINISHED: 'ARTIST_DONE', SHIPPED: 'ARTIST_SENT' }[e.artistStage] || 'PAID');
    if (ART.indexOf(k) < at) return `${artistOf(e)} already marked ${String(e.artistStage).toLowerCase()}`;
    if (ART.indexOf(k) > at) return `set by ${artistOf(e)}'s step`;
  }
  return '';
}

function sivaProgress(e) {
  const stopped = String(e.refundAction || '').startsWith('CANCEL') && ['REFUNDED', 'CANCELLED'].includes(e.status) && e.purchaseState !== 'CANCELLED' && e.zohoPOId;
  if (stopped) return `Stopped: customer cancelled after he started${e.artistStartedAt ? ` (${day(e.artistStartedAt)})` : ''}. He is paid 50% of his price${costings.get(e.id)?.artistPriceInr ? ` (₹${(costings.get(e.id).artistPriceInr / 2).toLocaleString('en-IN')})` : ''}${e.artistShippedAt ? ' plus the India courier' : ''}: enter his invoice no. and the bill is made for that.`;
  if (!e.artistStage) return e.zohoPOId ? `${artistOf(e)} hasn't marked this as started yet.` : '';
  return [`Started ${day(e.artistStartedAt)}`, e.artistFinishedAt ? `Finished ${day(e.artistFinishedAt)}` : '', e.artistShippedAt ? `Sent to frame shop ${day(e.artistShippedAt)}${e.artistAwb ? ` (${e.artistCourier} · AWB ${e.artistAwb})` : ''}` : '',
    e.artistBy ? `last update by ${e.artistBy && !String(e.artistBy).startsWith('Kalai Art House') ? e.artistBy : 'you, on their behalf'}` : ''].filter(Boolean).join(' · ');
}

function purchaseSection(e) {
  if (!hasArtist(e) || !(isLocked(e) || e.zohoState === 'TEST')) return '';
  const st = e.purchaseState || '';
  const color = st === 'ARTIST_PAID' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : 'var(--muted)';
  return `<fieldset class="cost" id="purchase">
    <legend>${e.artistId ? `<a class="who" href="/seller.html?view=${encodeURIComponent(e.artistId)}" target="_blank" rel="noopener" title="Open the artist's portal">${esc(e.artistName || 'Artist')}</a>` : esc(e.artistName || 'Siva Raja')} (purchase)</legend>
    <div style="font-size:14px;color:${color};overflow-wrap:anywhere">${escSym(e.purchaseMessage || `${artistOf(e)}'s order is recorded once the customer has paid and the costing has the artist's price.`)}</div>
    ${sivaProgress(e) ? `<div style="font-size:13px"><b>${esc(e.artistName || 'Siva')}'s progress:</b> ${esc(sivaProgress(e))}</div>` : ''}
    <div class="two">
      <div class="field"><label for="pInv">${esc(e.artistName || 'Siva')}'s invoice no.</label><input id="pInv" value="${esc(e.artistInvoiceNo)}" placeholder="From the artist's invoice" ${!e.zohoPOId || e.zohoBillId ? 'disabled' : ''}></div>
      <div class="field"><label for="pPaid">Paid to ${esc(e.artistName || 'Siva')}: bank ref</label><input id="pPaid" value="${esc(e.artistPaidRef)}" placeholder="Transfer reference" ${!e.zohoPOId || e.zohoVendorPaymentId ? 'disabled' : ''}></div>
    </div>
    <div class="muted" style="font-size:12px">Save with the artist's invoice number to create their bill in Zoho; save with your bank reference to record the payment made to them.</div>
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
    ${e.purchaseMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${escSym(e.purchaseMessage)}</div>` : ''}
    <div class="field"><label for="mPaid">Paid to the maker: bank ref</label><input id="mPaid" value="${esc(e.sellerPaidRef)}" placeholder="Transfer reference" ${!e.zohoSellerBillId || e.zohoSellerPaymentId ? 'disabled' : ''}></div>
    <div class="muted" style="font-size:12px">When you mark it Paid the maker gets the order${kalai ? ' (they mark it ready for pickup; you book the courier and mark it Shipped)' : ' (they enter the courier and AWB; the order turns Shipped by itself)'}. When it is Delivered, the maker's payout bill is created in Zoho; enter your bank reference here when you have paid them.</div>
  </fieldset>`;
}

// ---------- delivery address (customer adds it under My enquiries & orders; the studio can type or correct it) ----------
const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
function giftAddress(e) {
  const d = parseDetails(e.details);
  return (e.kind === 'GIFT' || e.kind === 'PHOTO') && d['Address'] ? { address: d['Address'], emirate: String(d['Emirate'] || '').split(' (')[0] } : null;
}
function addressSection(e) {
  const g = giftAddress(e);
  const has = !!e.deliveryAddress;
  const need = !has && !g && ['PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'PRINTING', 'PRINTED', 'FRAMING', 'REPLACEMENT'].includes(e.status);
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
  const dj = jobsOf(e).delivery; // a delivery partner's job: courier and AWB come from its portal
  const color = st === 'DELIVERED' ? 'var(--ok)' : st === 'ERROR' ? 'var(--kumkum)' : st === 'DRAFT' ? 'var(--gold)' : 'var(--muted)';
  return `<fieldset class="cost" id="shipBox" ${SHIP_STATUSES.includes(e.status) ? '' : 'hidden'}>
    <legend>Delivery</legend>
    ${e.deliveryMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${escSym(e.deliveryMessage)}</div>` : ''}
    ${dj ? `<div style="font-size:14px"><b>${supLink(dj.name, dj.name) || esc(dj.name)}</b> (delivery partner)${dj.awb ? ` · AWB <span class="mono">${esc(dj.awb)}</span>` : ' · waiting for the pickup'}${dj.deliveredAt ? ` · delivered ${esc(day(dj.deliveredAt))}` : dj.pickedAt ? ` · picked up ${esc(day(dj.pickedAt))}` : ''}</div>
      <div class="muted" style="font-size:12px">Filled in automatically from ${esc(dj.name)}'s portal (Picked up → Shipped, Delivered → Delivered). To use another courier, take the delivery job back under Frame shop &amp; delivery.</div>` : ''}
    ${dj?.pod || dj?.deliveredAt ? '<div class="muted" style="font-size:12px">Proof of delivery: under Frame shop &amp; delivery → Delivery.</div>' : ''}
    <div class="two" ${dj ? 'hidden' : ''}>
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
    <div class="muted" style="font-size:12px" ${dj ? 'hidden' : ''}>Saving as <b>Shipped</b> creates the delivery challan in Zoho; <b>Delivered</b> marks it delivered. The customer sees the courier and tracking number under My enquiries & orders.</div>
  </fieldset>`;
}

// ---------- after-sales: cancellations, damage, replacement ----------
const AFTER = {
  CANCEL_FULL: { label: 'Customer cancelled, artist not started: full refund', pct: 1, status: 'REFUNDED' },
  CANCEL_HALF: { label: 'Customer cancelled, artist already started: 50% refund', pct: 0.5, status: 'REFUNDED' },
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
// Review a damage report: what the customer got wrong (common mistakes) → our resolution. The resolution either changes the
// request straight away (new photos / decline, emailed) or pre-fills "What happened?" below for a refund or replacement.
const RV_ISSUES = [
  ['WRONG_PHOTO', 'Wrong or unrelated photo uploaded', 'NEW_PHOTOS', 'The photo you sent is not of this order. Please send photos of the framed work you received.'],
  ['BLURRY', 'Photo blurry, dark or taken from too far', 'NEW_PHOTOS', 'The photo is not clear enough to see the damage. Please send a sharp photo of the whole frame and a close-up of the damaged part, in good light.'],
  ['NOT_VISIBLE', 'Damage not visible in the photos', 'NEW_PHOTOS', "We can't see the damage in the photos. Please send a close-up of exactly where it is damaged, and one of the whole frame."],
  ['BOX_ONLY', 'Only the box photographed, not the artwork', 'NEW_PHOTOS', 'Please also send photos of the artwork and frame out of the box, so we can see the damage itself.'],
  ['NO_PACKAGING', 'No photo of the outer box / packaging', 'BOX_PHOTO', 'For the courier insurance we also need a photo of the outer box and packaging. Please send it with a photo of the damage.'],
  ['TOO_FEW', 'Too few photos (needs whole frame + close-up + box)', 'NEW_PHOTOS', 'Please send three photos: the whole frame, a close-up of the damage, and the outer box.'],
  ['WRONG_CHOICE', 'Chose refund but wants a replacement (or the other way)', 'CONTACT', ''],
  ['WRONG_ORDER', 'Reported on the wrong order', 'DECLINE', 'This report seems to be for a different order. Please report it on the right order under My enquiries & orders, or reply to this email.'],
  ['DUPLICATE', 'Same problem reported twice', 'DECLINE', 'You have already reported this; we are dealing with it under your first report.'],
  ['LATE', 'Reported after the 48 hours', 'DECLINE_LATE', 'Damage has to be reported within 48 hours of delivery, and this report came later, so we cannot accept it under our terms. Please reply if there was a reason it could not be sent in time.'],
  ['AFTER_DELIVERY', 'Damage happened after delivery (e.g. dropped while hanging)', 'DECLINE_AFTER', 'The photos show damage that does not come from the delivery (for example from a fall after unpacking), so it is not covered. We can repair or re-frame it at cost: reply if you would like a quote.'],
  ['CHANGE_OF_MIND', 'Not damaged: change of mind / does not like it', 'DECLINE_MIND', 'Each work is one of a kind, so we cannot accept change-of-mind returns. If something is actually damaged, please send photos of it.'],
  ['LOOKS_DIFFERENT', 'Not damaged: colours or size look different from the website', 'CONTACT', ''],
  ['MINOR', 'Minor, fixable problem (loose corner, smudge or scratch on the glass, crooked mount)', 'REPAIR', ''],
  ['NOT_RECEIVED', 'Says it never arrived (marked delivered)', 'COURIER', ''],
  ['GENUINE', 'Genuine transit damage, photos are fine', 'ACCEPT_CHOICE', ''],
];
const RV_RES = {
  NEW_PHOTOS: 'Ask for new photos (48 hours, emailed)',
  BOX_PHOTO: 'Ask for a photo of the box / packaging (48 hours, emailed)',
  CONTACT: 'Call / WhatsApp the customer first (request stays open)',
  COURIER: 'Open a claim with the courier (request stays open)',
  REPAIR: 'Accept: free repair or re-frame at the frame shop',
  ACCEPT_CHOICE: "Accept the customer's choice (refund or replacement)",
  REPLACE: 'Accept: replacement / repair',
  REFUND: 'Accept: full refund',
  PARTIAL: 'Accept: partial refund as goodwill (customer keeps it)',
  DECLINE: 'Decline (emailed)',
  DECLINE_LATE: 'Decline: reported after 48 hours (emailed)',
  DECLINE_AFTER: 'Decline: damage not from delivery (emailed)',
  DECLINE_MIND: 'Decline: change of mind, one-of-a-kind work (emailed)',
};
function reviewBlock(e) {
  const issue = e.cancelIssue || '', res = e.cancelResolution || (RV_ISSUES.find((x) => x[0] === issue) || [])[2] || '';
  return `<div class="rvbox" style="display:grid;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
    <b style="font-size:13px">Review the report</b>
    <div style="display:grid;gap:8px"><div class="field"><label for="rvIssue">What did the customer get wrong?</label><select id="rvIssue"><option value="">Choose…</option>${RV_ISSUES.map(([k, l]) => `<option value="${k}" ${k === issue ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label for="rvRes">Our resolution</label><select id="rvRes"><option value="">Choose…</option>${Object.entries(RV_RES).map(([k, l]) => `<option value="${k}" ${k === res ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>
    <div class="field" id="rvMsgBox"><label for="rvMsg">Message to the customer (emailed when it asks for photos or declines)</label><textarea id="rvMsg" rows="2">${esc(e.cancelReply || '')}</textarea></div>
    <div><button class="btn small" type="button" id="rvApply">Apply</button> <span class="ok" id="rvOk" role="status" style="font-size:12px"></span></div>
  </div>`;
}
function wireReview(e) {
  if (!$('rvIssue')) return;
  const msgFor = (k) => (RV_ISSUES.find((x) => x[0] === k) || [])[3] || '';
  const showMsg = () => { const r = $('rvRes').value; $('rvMsgBox').hidden = !['NEW_PHOTOS', 'BOX_PHOTO', 'DECLINE', 'DECLINE_LATE', 'DECLINE_AFTER', 'DECLINE_MIND'].includes(r); };
  $('rvIssue').onchange = () => { const it = RV_ISSUES.find((x) => x[0] === $('rvIssue').value); if (it) { $('rvRes').value = it[2]; if (it[3]) $('rvMsg').value = it[3]; } showMsg(); };
  $('rvRes').onchange = showMsg; showMsg();
  $('rvApply').onclick = async () => {
    const issue = $('rvIssue').value, res = $('rvRes').value, ok = $('rvOk');
    if (!res) { ok.textContent = 'Choose our resolution.'; return; }
    const msg = $('rvMsg').value.trim() || msgFor(issue) || null;
    const base = { id: e.id, cancelIssue: issue || null, cancelResolution: res };
    let set = base, after = '';
    if (res === 'NEW_PHOTOS' || res === 'BOX_PHOTO') set = { ...base, cancelState: 'REOPENED', cancelReopenAt: new Date().toISOString(), cancelReply: msg };
    else if (res.startsWith('DECLINE')) set = { ...base, cancelState: 'DECLINED', cancelReply: msg };
    else if (res === 'REFUND' || res === 'PARTIAL') after = 'DAMAGED_REFUND';
    else if (res === 'REPLACE' || res === 'REPAIR') after = 'DAMAGED_REPLACE';
    else if (res === 'ACCEPT_CHOICE') after = e.cancelRequest;
    $('rvApply').disabled = true; ok.textContent = 'Saving…';
    try {
      const { data, errors } = await client.models.Enquiry.update(set);
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(e, data || set);
      if (set.cancelState) { render(); showDetail(e); return; }
      if (after && $('aAction') && !$('aAction').disabled) {
        $('aAction').value = after; $('aAction').dispatchEvent(new Event('change'));
        if (res === 'PARTIAL' && $('aAmount')) { $('aAmount').value = ''; $('aAmount').placeholder = 'goodwill amount'; $('aAmount').focus(); }
        if ($('aNote')) $('aNote').value = `${RV_RES[res]}${issue ? ` · ${(RV_ISSUES.find((x) => x[0] === issue) || [])[1]}` : ''}`;
        ok.textContent = res === 'PARTIAL' ? 'Saved. Enter the goodwill amount below, pay it, tick the box and save the order.' : 'Saved. Finish below: "What happened?" is filled in; tick the box and save the order.';
        $('aAction').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else ok.textContent = res === 'CONTACT' ? 'Saved. The request stays open while you talk to the customer.' : res === 'COURIER' ? 'Saved. The request stays open while the courier claim runs.' : 'Saved.';
    } catch (ex) { ok.textContent = ex.message || 'Could not save.'; }
    finally { if ($('rvApply')) $('rvApply').disabled = false; }
  };
}

function requestBanner(e) {
  if (!isReq(e) && !['DECLINED', 'REOPENED', 'WITHDRAWN'].includes(e.cancelState)) return '';
  const dmg = String(e.cancelRequest || '').startsWith('DAMAGED');
  const resLine = e.cancelResolution ? ` · <span class="muted">${esc((RV_ISSUES.find((x) => x[0] === e.cancelIssue) || [])[1] || '')}${e.cancelIssue ? ' → ' : ''}${esc(RV_RES[e.cancelResolution] || '')}</span>` : '';
  if (e.cancelState === 'REOPENED') return `<div class="reqbox"><b>Waiting for new photos</b> · asked ${esc(when(e.cancelReopenAt))}; the customer can send them for 48 hours from then.${resLine} ${e.cancelReply ? `<div>“${esc(e.cancelReply)}”</div>` : ''}</div>`;
  if (e.cancelState === 'WITHDRAWN') return `<div class="muted" style="font-size:13px"><b>Customer withdrew their request</b> (${esc(REQ_LABEL[e.cancelRequest] || e.cancelRequest || '')}). If they report again it shows here as a new request.</div>`;
  if (e.cancelState === 'DECLINED') return `<div class="reqbox"><div><b>Customer request declined:</b> ${esc(REQ_LABEL[e.cancelRequest] || '')}${e.cancelReply ? ` · “${esc(e.cancelReply)}”` : ''}${resLine}</div>${dmg ? reviewBlock(e) : ''}</div>`;
  return `<div class="reqbox">
    <div><b>Customer request · ${esc(when(e.cancelRequestedAt))}</b>${resLine}</div>
    <div>${esc(REQ_LABEL[e.cancelRequest] || e.cancelRequest)}${e.cancelRequest !== 'DAMAGED_REPLACE' ? ` · refund under the policy: <b>⃃ ${Number(e.cancelRefundDue || 0).toLocaleString('en-US')}</b>` : ''}</div>
    ${e.cancelReason ? `<div>Reason: “${esc(e.cancelReason)}”</div>` : ''}
    ${e.cancelPhotos ? `<div class="links" id="reqPhotos"><span class="muted">Loading photos…</span></div>` : ''}
    <div class="muted" style="font-size:12px">${e.cancelRequest === 'CANCEL' && e.zohoPOId ? `${esc(artistOf(e))}'s order is on hold. ` : ''}To accept: ${e.cancelRequest === 'DAMAGED_REPLACE' ? 'tick the box below and save.' : 'pay the refund (Ziina / bank), enter its reference below, tick the box and save.'} The customer is emailed automatically.</div>
    ${dmg ? reviewBlock(e) : `<details><summary>Decline the request instead</summary>
      <div class="field" style="margin-top:8px"><label for="rqReply">Reply to the customer (emailed)</label><textarea id="rqReply" rows="2" placeholder="e.g. As agreed on the phone, you are keeping the painting."></textarea></div>
      <button class="btn ghost" type="button" id="rqDecline">Decline and email the customer</button> <span class="ok" id="rqMsg" role="status"></span>
    </details>`}
  </div>`;
}

// ---------- Replacement rework: frame shop or Siva, costs and the courier insurance claim ----------
const REWORK_TYPE = { REFRAME: 'New glass / re-frame at the frame shop', SIVA_REPAIR: 'Repair by the artist', SIVA_REPAINT: 'Repaint by the artist (new painting)' };
function parseRework(c) {
  let v = c?.rework;
  try { if (typeof v === 'string') v = JSON.parse(v); if (typeof v === 'string') v = JSON.parse(v); } catch { v = null; }
  return v && typeof v === 'object' ? v : {};
}
/** Extra cost of a replacement (⃃) and what the insurer paid back. */
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
    add(!!e.toSivaSentAt, 'Sent to the artist', e.toSivaSentAt, e.toSivaAwb ? `${e.toSivaCourier} · AWB ${e.toSivaAwb}` : '');
    add(!!e.sivaReceivedAt, 'The artist received it', e.sivaReceivedAt);
  }
  if (siva) {
    add(!!e.reworkStartedAt, 'The artist: rework started', e.reworkStartedAt);
    add(!!e.reworkFinishedAt, 'The artist: finished', e.reworkFinishedAt);
    add(!!e.reworkSentAt, 'The artist: sent to the frame shop', e.reworkSentAt, e.reworkAwb ? `${e.reworkCourier} · AWB ${e.reworkAwb}` : '');
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
      <div class="field"><label for="tsCourier">To the artist: courier</label>${sel('tsCourier', e.toSivaCourier, ['DHL', 'Aramex', 'FedEx', 'SMSA', 'Emirates Post'])}</div>
      <div class="field"><label for="tsAwb">To the artist: AWB</label><input id="tsAwb" value="${esc(e.toSivaAwb)}" ${e.toSivaSentAt ? 'disabled' : ''}></div>
      <div class="field" style="align-self:end">${tick('tsSent', 'Sent to the artist (they see the AWB)', e.toSivaSentAt)}</div>
    </div>
    <div class="muted" style="font-size:12px">${e.sivaReceivedAt ? `The artist received it ${esc(when(e.sivaReceivedAt))}.` : 'The artist taps “I\'ve received it” on his page; he can only start the repair after that.'} Sending art to India and back needs export / re-import papers (repair and return); keep the courier's paperwork.</div>` : ''}
    ${(e.reworkType || '').startsWith('SIVA') ? tick('rwBack', 'The artist\'s piece is back at the frame shop', e.reworkBackAt) : ''}`;
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
      <div class="field"><label for="rwNote">Instructions (the artist sees them)</label><input id="rwNote" value="${esc(e.reworkNote)}" placeholder="e.g. glass cracked, painting fine"></div>
    </div>
    ${siva ? `<div style="font-size:13px"><b>The artist:</b> ${c.reworkPriceInr != null ? `rework price ₹${Number(c.reworkPriceInr).toLocaleString('en-IN')}${c.reworkPriceBy && c.reworkPriceBy !== 'Siva' ? ' (entered by you)' : ''}` : 'no rework price yet'}${sivaSteps ? ` · ${esc(sivaSteps)}` : e.reworkType ? ' · not started (he sees it on his page; you can tick it there for him)' : ''}</div>` : ''}
    ${e.reworkMessage ? `<div style="font-size:13px;color:${/^Error/.test(e.reworkMessage) ? 'var(--kumkum)' : 'var(--muted)'}">${escSym(e.reworkMessage)}</div>` : ''}
    ${reworkTimeline(e)}
    ${transportSection(e)}
    <div class="muted" style="font-size:12px;font-weight:600;margin-top:4px">Extra costs of this replacement (⃃, the customer pays nothing)</div>
    <div class="three">
      ${num('rwFr', 'Frame shop (glass / frame)', r.framing)}
      ${num('rwLc', 'Couriers (pickup, re-delivery)', r.localCourier)}
      ${siva ? num('rwIc', 'India courier (the artist)', r.indiaCourier) : ''}
      ${num('rwOt', 'Other', r.other)}
      ${siva ? `<div class="field"><label for="rwInr">The artist's rework price (₹)</label><input id="rwInr" type="number" min="0" step="1" value="${c.reworkPriceInr ?? ''}" ${e.zohoReworkBillId ? 'disabled' : ''}></div>` : ''}
    </div>
    ${siva ? `<div class="two">
      <div class="field"><label for="rwInv">The artist's rework invoice no.</label><input id="rwInv" value="${esc(e.reworkInvoiceNo)}" placeholder="Creates a second bill in Zoho" ${e.zohoReworkBillId ? 'disabled' : ''}></div>
      <div class="field"><label for="rwPaid">Paid to the artist (rework): bank ref</label><input id="rwPaid" value="${esc(e.reworkPaidRef)}" ${!e.zohoReworkBillId || e.zohoReworkPaymentId ? 'disabled' : ''}></div>
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
    ${e.refundMessage ? `<div style="font-size:14px;color:${color};overflow-wrap:anywhere">${escSym(e.refundMessage)}</div>` : ''}
    ${!done && e.zohoPOId ? `<div style="font-size:13px"><b>${esc(artistOf(e))}:</b> ${e.artistStartedAt ? `started ${esc(day(e.artistStartedAt))}, so a cancellation is a <b>50% refund</b>` : "hasn't marked it started, so a cancellation is a <b>full refund</b>"}.</div>` : ''}
    <div class="field"><label for="aAction">What happened?</label><select id="aAction" ${dis}>
      <option value="">Nothing: order is fine</option>
      ${Object.entries(AFTER).map(([k, v]) => `<option value="${k}" ${act === k ? 'selected' : ''}>${v.label}</option>`).join('')}
    </select></div>
    <div class="err" id="aWarn" hidden></div>
    <div id="aMoney" class="two" ${act && act !== 'DAMAGED_REPLACE' ? '' : 'hidden'}>
      <div class="field"><label for="aAmount">Refund amount (⃃)</label><input id="aAmount" type="number" min="0" step="0.01" value="${e.refundAmount ?? (pre ? e.cancelRefundDue ?? '' : '')}" ${dis}></div>
      <div class="field"><label for="aMethod">Refund via</label><select id="aMethod" ${dis}>${[['ZIINA', 'Ziina'], ['BANK', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card (other)'], ['OTHER', 'Other']].map(([k, v]) => `<option value="${k}" ${(e.refundMethod || e.paymentMethod || 'ZIINA') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="aRef">Refund reference</label><input id="aRef" value="${esc(e.refundRef)}" placeholder="Ziina / bank transaction ID" ${dis}></div>
    </div>
    <div class="field" id="aNoteBox" ${act ? '' : 'hidden'}><label for="aNote">Note (reason, customer's photos received…)</label><input id="aNote" value="${esc(e.refundNote || (pre ? `Customer request: ${e.cancelReason || REQ_LABEL[e.cancelRequest] || ''}` : ''))}" ${dis}></div>
    ${done ? '' : `<label id="aConfirmBox" style="display:${act ? 'flex' : 'none'};gap:8px;align-items:flex-start;font-weight:400;font-size:13px"><input type="checkbox" id="aConfirm" style="width:auto;margin-top:3px"> <span id="aConfirmText">I confirm. Saving sets the status and records this in Zoho (credit note + refund, or the challan as returned). It can't be undone from here.</span></label>`}
    <div class="muted" style="font-size:12px">Policy: no change-of-mind returns. Cancelled before the artist starts → full refund; after they start → 50%. Damaged in transit (photos within 48 hours) → customer chooses refund or replacement.</div>
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
  const r = calc(readCosting(), n(finalPriceStr()));
  const row = (k, v, note = '') => `<tr><td>${k}</td><td class="mono num">${v}</td><td class="muted">${note}</td></tr>`;
  const t = rates.tiers[$('cTier').value];
  let html = `<table class="costs"><tbody>
    ${row('Artist', aed(r.artistAed), r.artistAed != null ? (curAed ? 'artist in the UAE, price in ⃃' : `₹${Number($('cInr').value).toLocaleString('en-IN')} × ${rates.fx}`) : 'needs the artist\'s price')}
    ${row('Framing', aed(r.framing), $('cFr').value ? 'override' : r.est?.framing != null ? `${esc(r.est.framingFrom)} · ${esc(r.est.spec?.style || '')} ${esc(r.est.spec?.size || '')}` : '<b class="neg">no supplier price</b> for this size / style: add it to a frame shop\'s price list, or type an override')}
    ${row('India courier', aed(r.indiaCourier), $('cIc').value ? 'override' : curAed ? 'none: artist in the UAE' : t ? `master ${$('cTier').value}` : '')}
    ${r.ready ? row('Customs', aed(r.customs, 2), curAed ? 'none: artist in the UAE' : `${(rates.customs * 100).toFixed(1)}% of artist + courier`) : ''}
    ${row($('cDel')?.value === 'OUTSIDE' ? `Courier to ${esc(curEnq ? destOf(curEnq).country : 'abroad')}` : 'Local courier', aed(r.localCourier), $('cLc').value ? 'override' : r.est?.local != null ? esc(r.est.localFrom) : '<b class="neg">no supplier price</b> for this address / size: add it to a delivery partner\'s price list, or type an override')}
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

/** The frame shop the order page shows (framing job, default or cheapest): kept on the costing so the artist desk
 *  shows the same shop as where to send the finished work. Quietly updated when the order is opened. */
async function syncFramer(e) {
  if (!hasArtist(e) || ['CANCELLED', 'REFUNDED', 'DELIVERED'].includes(e.status)) return;
  const id = estCosts(e).framingFromId || null, c = costings.get(e.id);
  let costs = {}; try { costs = c?.costs ? (typeof c.costs === 'string' ? JSON.parse(c.costs) : c.costs) || {} : {}; } catch { costs = {}; }
  if ((costs.framerId || null) === id) return;
  const rec = { enquiryId: e.id, costs: JSON.stringify({ ...costs, framerId: id }) };
  try { const res = c ? await client.models.Costing.update(rec) : await client.models.Costing.create(rec); if (!res.errors?.length) costings.set(e.id, res.data || { ...c, ...rec }); } catch { /* next time */ }
}
/** Which email (if any) the customer gets for this save, and to which address. */
const MAIL_ON = { PRICE_SENT: 'PRICE_SENT', PAID: 'PAID', FRAMING: 'FRAMING', SHIPPED: 'SHIPPED', DELIVERED: 'DELIVERED', REPLACEMENT: 'REPLACEMENT', REFUNDED: 'REFUNDED', CANCELLED: 'CANCELLED', RECEIVED: 'RECEIVED_AGAIN' };
let mailOffList = null;
async function mailNote(e, oldSt, newSt, prevMsg) {
  if (mailOffList == null) { try { const r = await client.models.SiteSetting.get({ id: 'site' }); mailOffList = String(r.data?.mailOff || '').split(',').map((x) => x.trim()).filter(Boolean); } catch { mailOffList = []; } }
  const to = e.email ? `to ${e.email}` : '';
  if (!e.email) return 'No email on this order (sent without signing in): send the update on WhatsApp.';
  if (newSt !== oldSt) {
    const key = MAIL_ON[newSt];
    if (!key) return `No customer email for “${STATUS[newSt] || newSt}” (it shows under My enquiries & orders).`;
    if (mailOffList.includes(key)) return `The “${STATUS[newSt] || newSt}” email is switched off in Settings → Customer emails: nothing emailed.`;
    return `Email sent ${to} (${STATUS[newSt] || newSt}${(e.adminMessage || '') ? ', with your message' : ''}).`;
  }
  if ((e.adminMessage || '') && (e.adminMessage || '') !== prevMsg) return `Your message was emailed ${to}.`;
  return `No email this time (status and message unchanged). To send it anyway, use “Email the customer again” below.`;
}
async function saveCosting(e) {
  const { local, ...inp } = readCosting();
  const r = calc({ ...inp, local }, n(finalPriceStr()));
  const costs = {
    artistInr: inp.artistPriceInr, artistAedPrice: inp.artistPriceAed, fx: rates.fx, artistAed: r.artistAed != null ? Math.round(r.artistAed * 100) / 100 : null,
    framing: r.framing, indiaCourier: r.indiaCourier, localCourier: r.localCourier,
    customs: r.customs != null ? Math.round(r.customs * 100) / 100 : null, total: r.total ?? null, suggested: r.suggested ?? null,
    price: r.price ?? null, margin: r.margin != null ? Math.round(r.margin * 100) / 100 : null, savedAt: new Date().toISOString(),
    framerId: estCosts(e).framingFromId || null, // the frame shop on the order page: the artist sends the work there
    ...(inp.delivery === 'OUTSIDE' ? { destCountry: destOf(e).country, destRegion: destOf(e).region || null, shipFrom: destOf(e).from } : {}),
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
    <td><input id="rC${k}" type="number" min="0" step="1" value="${t[k].courier}" aria-label="${k} India courier"></td></tr>`;
  const host = $('chargesBox') || $('detail');
  const d = rates.defaults || {};
  const supSel = (id, types, cur, label, note) => { const list = suppliers.filter((x) => types.includes(x.type)); return `<div class="field"><label for="${id}">${label}</label><select id="${id}"><option value="cheapest">Cheapest for each order (from the price lists)</option>${list.map((x) => `<option value="${esc(x.id)}" ${cur === x.id ? 'selected' : ''}>${esc(x.business)}</option>`).join('')}</select><span class="muted" style="font-size:12px">${list.length ? note : 'None approved yet: add them under Artists & sellers → Frame, print &amp; delivery.'}</span></div>`; };
  const pct = (id, label, v, note) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" min="0" step="0.1" value="${+(v * 100).toFixed(2)}"><span class="muted" style="font-size:12px">${note}</span></div>`;
  host.innerHTML = `
    <div><h2 style="font-size:22px">Kalai margin &amp; charges</h2><p class="muted" style="margin:4px 0 0">Kalai's own figures, used by Pricing (website prices) and by each order's costing. Frame, print and delivery costs come from the suppliers' price lists, from the default supplier below (or the cheapest); the artist's price comes from the artist.</p></div>
    <form id="ratesForm" novalidate style="display:grid;gap:12px">
      <div class="three">
        ${supSel('rDefFr', ['FRAMER'], d.framer, 'Default frame shop', 'Its price for the frame size and style. On an order with a frame shop job, that job\'s price is used.')}
        ${supSel('rDefDl', ['COURIER', 'FRAMER'], d.delivery, 'Default delivery partner', 'Its price to the address and parcel size (Dubai for website prices).')}
        ${supSel('rDefPr', ['PRINTER'], d.printer, 'Default print shop', 'Little Artists and framed prints.')}
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:-4px"><button type="button" class="btn small ghost" id="rSample">Fill sample frame prices (market estimate)</button><span class="muted" id="rSampleMsg" style="font-size:12px">Fills the empty cells of every frame shop's price list (not Aramex) with Dubai market prices, a different level per shop. Prices a shop entered itself are kept.</span></div>
      <div class="tablewrap" style="max-width:520px"><table class="costs"><thead><tr><th>Tier</th><th>Paper sizes</th><th>India courier (⃃)</th></tr></thead>
        <tbody>${Object.keys(t).map(tierRow).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:-6px">India → Dubai courier: the artist books and pays it and it is added to the artist's bill (artwork + courier lines). Change it on an order under Overrides for an oversized or express parcel.</div>
      <div class="two">
        <div class="field"><label for="rSivaRoy">Siva's print royalty (%)</label><input id="rSivaRoy" type="number" min="0" max="50" step="0.5" value="${rates.sivaRoyalty ?? 10}"><span class="muted" style="font-size:12px">His share of each framed print of his paintings, added to the print price. Portal artists: set in Artists &amp; sellers.</span></div>
        <div class="field"><label for="rSivaLic">Siva's licence royalty (%)</label><input id="rSivaLic" type="number" min="0" max="90" step="0.5" value="${rates.sivaLicenceRoyalty ?? 30}"><span class="muted" style="font-size:12px">His share of each image licence of his works (% of the licence price). Portal artists: set in Artists &amp; sellers; a work can have its own in Catalogue.</span></div>
        <div class="field"><label for="rFx">Exchange rate (⃃ per ₹)</label><input id="rFx" type="number" min="0" step="0.0001" value="${rates.fx}"></div>
        ${pct('rCus', 'Customs (%)', rates.customs, 'of artist price + India courier')}
        ${pct('rFee', 'Ziina fee (%)', rates.fee, 'of what the customer pays')}
        ${pct('rIns', 'Courier insurance (%)', rates.ins || 0, 'declared-value cover bought with each shipment, % of price')}
        ${pct('rRes', 'Breakage reserve (%)', rates.reserve || 0, 'set aside per order for damage the insurer won\'t pay')}
        <div class="field" style="grid-column:1/-1"><label>Kalai margin by category (%)</label><div class="tablewrap"><table class="costs"><tbody>${CATS.map(([k, label, note]) => `<tr><td>${label}</td><td><input id="rMg_${k}" type="number" min="0" max="300" step="0.5" value="${+(((rates.margins?.[k] ?? (k === 'market' ? 0.15 : rates.margin)) || 0) * 100).toFixed(2)}" style="width:80px"></td><td class="muted" style="font-size:12px">${note}</td></tr>`).join('')}</tbody></table></div></div>
        ${pct('rVat', 'VAT (%)', rates.vat, '0 until registered, then 5')}
      </div>
      <div class="field"><label for="rVendors">Zoho vendors → cost (one per line, "part of the vendor name = cost")</label><textarea id="rVendors" rows="4" placeholder="Al Warda = frame shop&#10;Pickframes = frame shop&#10;Aramex = courier&#10;DHL = india courier&#10;Customs broker = customs">${esc(rates.vendors || '')}</textarea>
        <span class="muted" style="font-size:12px">Costs: frame shop, india courier, customs, courier (to the customer), other. Enter each vendor bill in Zoho Books with the order number (KA-…) in Reference#; a bill for several orders lists all their numbers, with the number in each line's description. The order's Actual costs box and Reports then take the amount from Zoho.</span></div>
      <div class="tablewrap"><table class="costs"><thead><tr><th>Market check</th><th>Sketch band (⃃)</th><th>Watercolour band (⃃)</th><th>Saatchi Art reference</th></tr></thead>
        <tbody>${Object.keys(t).map((k) => { const m = (rates.market || DEFAULT_RATES.market)[k] || DEFAULT_RATES.market[k]; return `<tr><th>${k}</th>
          <td><input id="mSk1${k}" type="number" min="0" value="${m.sk[0]}" style="width:70px" aria-label="${k} sketch from"> – <input id="mSk2${k}" type="number" min="0" value="${m.sk[1]}" style="width:70px" aria-label="${k} sketch to"></td>
          <td><input id="mWc1${k}" type="number" min="0" value="${m.wc[0]}" style="width:70px" aria-label="${k} watercolour from"> – <input id="mWc2${k}" type="number" min="0" value="${m.wc[1]}" style="width:70px" aria-label="${k} watercolour to"></td>
          <td><input id="mSa${k}" value="${esc(m.saatchi || '')}" aria-label="${k} Saatchi reference"></td></tr>`; }).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:-6px">Kalai's target price bands (simple frame included). Each order's price is checked against them, with Saatchi Art's prices for similar originals as the upper reference.</div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="rRound" style="width:auto" ${rates.round25 !== false ? 'checked' : ''}> Round suggested prices up to the nearest Dhs 25</label>
      <div class="ok" id="ratesMsg" role="status"></div>
      <button class="btn" type="submit">Save margin &amp; charges</button>
    </form>
    <fieldset class="cost" id="ziinaBox"><legend>Online payments (Ziina)</legend><div id="zStatus" class="muted" style="font-size:13px">Checking…</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="zConnect">Connect payment notifications</button></div>
      <div class="muted" style="font-size:12px">Do this once after saving the Ziina token in CloudShell: Ziina then tells the website when a customer has paid, and the order turns Paid by itself.</div></fieldset>`;
  ziinaStatus();
  $('rSample').onclick = async () => {
    const b = $('rSample'), m = $('rSampleMsg');
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Fill them now? Click again'; return; }
    b.disabled = true; m.textContent = 'Filling…';
    try {
      const r = await client.mutations.marketAdmin({ action: 'sampleFrameRates', data: '{}' });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      let o = r.data; try { if (typeof o === 'string') o = JSON.parse(o); } catch { o = {}; }
      const list = o?.shops || [];
      m.innerHTML = list.length ? 'Done: ' + list.map((x) => `<b>${esc(x.name)}</b> ${esc(x.level)}${x.filled ? ` (${x.filled} prices)` : ''}`).join(' · ') + '. Check each shop in its portal (Artists &amp; sellers → open portal).' : 'No frame shops found.';
      await loadArtists(); b.textContent = 'Fill sample frame prices (market estimate)'; delete b.dataset.sure;
    } catch (ex) { m.textContent = ex.message; } finally { b.disabled = false; }
  };
  $('ratesForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button'); b.disabled = true; $('ratesMsg').textContent = '';
    host.querySelectorAll('.err').forEach((x) => x.remove());
    const tiers = {};
    Object.keys(t).forEach((k) => { tiers[k] = { label: $('rL' + k).value.trim(), framing: t[k].framing ?? 0, courier: n($('rC' + k).value) ?? 0 }; });
    const data = { tiers, defaults: { framer: $('rDefFr').value, delivery: $('rDefDl').value, printer: $('rDefPr').value }, local: rates.local ?? 0, printA4: rates.printA4 ?? 0, printA3: rates.printA3 ?? 0, sivaRoyalty: n($('rSivaRoy').value) ?? 0, sivaLicenceRoyalty: n($('rSivaLic').value) ?? 30, fx: n($('rFx').value) ?? 0,
      customs: (n($('rCus').value) ?? 0) / 100, fee: (n($('rFee').value) ?? 0) / 100, ins: (n($('rIns').value) ?? 0) / 100, reserve: (n($('rRes').value) ?? 0) / 100, margins: Object.fromEntries(CATS.map(([k]) => [k, (n($('rMg_' + k).value) ?? 0) / 100])), margin: (n($('rMg_collection').value) ?? 0) / 100,
      vat: (n($('rVat').value) ?? 0) / 100, vendors: $('rVendors').value.trim(), round25: $('rRound').checked, round9: false, updatedAt: new Date().toISOString(),
      // The old Pricing master copies (courier, frame table, frame source) are dropped: one set of figures now.
      ...(rates.pricing ? { pricing: Object.fromEntries(Object.entries(rates.pricing).filter(([k]) => !['courier', 'frameWork', 'moulding', 'extra', 'frameSource'].includes(k))) } : {}),
      market: Object.fromEntries(Object.keys(t).map((k) => [k, { sk: [n($('mSk1' + k).value) ?? 0, n($('mSk2' + k).value) ?? 0], wc: [n($('mWc1' + k).value) ?? 0, n($('mWc2' + k).value) ?? 0], saatchi: $('mSa' + k).value.trim() }])) };
    try {
      const rec = { key: 'default', data: JSON.stringify(data) };
      let res = rates.saved ? await client.models.Rates.update(rec) : await client.models.Rates.create(rec);
      if (res.errors?.length && !rates.saved) res = await client.models.Rates.update(rec);
      // Siva's print royalty is kept on his works (the website adds it to their print price).
      if (Number(rates.sivaRoyalty ?? -1) !== data.sivaRoyalty) {
        try { let nt = null; do { const x = await client.models.Product.list({ limit: 500, nextToken: nt }); for (const w of (x.data || []).filter((w) => !w.artistId && w.kind !== 'photo')) await client.models.Product.update({ id: w.id, printRoyalty: data.sivaRoyalty }); nt = x.nextToken; } while (nt); } catch { /* next save retries */ }
      }
      if (res.errors?.length) throw new Error(res.errors[0].message);
      rates = { ...data, saved: true };
      showRates(); $('ratesMsg').textContent = 'Saved. Pricing and new order costings use these figures straight away.';
    } catch (ex) {
      $('ratesMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save rates: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

const DOC_STATUS_OK = ['delivered', 'paid', 'accepted', 'closed', 'billed', 'issued', 'invoiced', 'sent', 'open', 'creditcard', 'banktransfer', 'cash', 'recorded'];
/** The order's documents as a flow: customer side, the artist, and each supplier, step by step.
 *  Green = done in Zoho, amber = draft (test mode or not yet sent), grey dashed = still to come. */
/** A supplier's name as a link to their portal (studio view), matched on the business name. */
/** The artwork no. (AT-…) of an order, from its details or the catalogue product it came from. */
function artNo(e) { const det = parseDetails(e.details); const m = String(det['Artwork no.'] || det['Artwork no'] || '').match(/AT-\d+/); return m ? m[0] : (e.productId || ''); }
function supLink(name, label) {
  const n = String(name || '').trim().toLowerCase(), sp = n && suppliers.find((x) => String(x.business || '').trim().toLowerCase() === n);
  return sp ? `<a class="who" href="/supplier.html?view=${encodeURIComponent(sp.id)}" target="_blank" rel="noopener" title="Open ${esc(sp.business)}'s portal">${label != null ? esc(label) : '$NAME'}</a>` : (label != null ? esc(label) : '');
}
function docFlow(e, d) {
  const docs = d?.docs || [];
  const st = (x) => (!x ? 'todo' : ['void', 'cancelled'].includes(x.status) ? 'void' : x.status === 'draft' ? 'draft' : 'done');
  const TAG = { done: '✓', draft: '✎', todo: '…', void: '✕' };
  const box = (icon, label, x, sub = '') => `<a class="df ${st(x)}" ${x?.url ? `href="${esc(x.url)}" target="_blank" rel="noopener"` : ''} title="${esc(x ? `${x.type} ${x.number || ''} · ${x.status || ''}` : 'Not yet')}"><span class="ic" aria-hidden="true">${icon}</span><span class="tag" aria-hidden="true">${TAG[st(x)]}</span><b>${esc(label)}</b><span class="mono">${esc(x?.number || (x ? '' : 'to come'))}</span>${x?.total != null ? `<span class="mono">${aed(x.total, 0)}</span>` : ''}${sub ? `<span>${esc(sub)}</span>` : ''}</a>`;
  const arrow = '<span class="dfa" aria-hidden="true">➜</span>';
  const lane = (cls, icon, title, boxes, link = '') => `<div class="dfl ${cls}"><div class="dft"><i aria-hidden="true">${icon}</i>${link ? esc(title).replace(/ · (.+)$/, ` · ${link.replace('$NAME', '$1')}`) : esc(title)}</div><div class="dfr">${boxes.join(arrow)}</div></div>`;
  const one = (type) => docs.filter((x) => x.type === type).slice(-1)[0];
  const cust = [box('📝', 'Quote', one('Quote')), box('🧾', 'Invoice', one('Invoice')), box('💳', 'Payment', one('Payment received'), e.paymentMethod || ''), box('🚚', 'Delivery challan', one('Delivery challan'), e.status === 'DELIVERED' ? 'delivered' : '')];
  const cn = one('Credit note'); if (cn) cust.push(box('↩️', 'Credit note (refund)', cn));
  const lanes = [lane('cust', '🛍️', `Customer · ${e.customerName || ''}`, cust, e.customerCode ? `<button type="button" class="who" data-opencust="${esc(e.customerCode)}" title="Open ${esc(e.customerCode)} in Customers">$NAME</button>` : '')];
  const bills = docs.filter((x) => x.group === 'PURCHASE' && /bill/i.test(x.type));
  const who = artistOf(e).split(/\s+/)[0].toLowerCase();
  const isArtist = (b) => (!!e.zohoBillId && b.id === e.zohoBillId) || (!!who && String(b.vendor || '').toLowerCase().includes(who));
  const paidFor = (b) => docs.find((x) => x.type === 'Payment made' && b && x.date >= (b.date || '') && x.total === b.total) || (b?.status === 'paid' ? { ...b, type: 'Payment made', number: 'paid' } : null);
  if (hasArtist(e)) {
    const ab = bills.find(isArtist);
    const po = e.zohoPOId ? { type: 'Purchase order', number: e.zohoPO || 'PO', status: e.zohoState === 'TEST' ? 'draft' : 'open' } : null;
    lanes.push(lane('art', '🎨', `Artist · ${artistOf(e)}`, [box('📦', 'Purchase order', po), box('🧾', 'Bill', ab), box('💸', 'Payment', paidFor(ab), e.artistPaidRef ? 'paid' : '')], e.artistId ? `<a class="who" href="/seller.html?view=${encodeURIComponent(e.artistId)}" target="_blank" rel="noopener" title="Open the artist's portal">$NAME</a>` : ''));
  }
  for (const b of bills.filter((x) => !hasArtist(e) || !isArtist(x))) lanes.push(lane('sup', /aram|courier|deliver|dhl|fedex|post/i.test(b.vendor || '') ? '🚚' : '🖼️', `Supplier · ${b.vendor || 'vendor'}`, [box('🧾', 'Bill', b), box('💸', 'Payment', paidFor(b))], supLink(b.vendor)));
  return `<div class="dflow">${lanes.join('')}<div class="muted" style="font-size:11px">✓ done in Zoho · ✎ draft · … still to come. Click a box to open it in Zoho Books.</div></div>`;
}
/** The order's journey, step by step (done ✓ with the date when known, now, still to come), under the document flow. */
function statusTrack(e) {
  const k = e.kind, art = hasArtist(e), jj = jobsOf(e), dj = jj.delivery || {}, fj = jj.framer || {}, pj = jj.printer || {};
  const path = art ? ['RECEIVED', 'PRICE_SENT', 'PAID', 'ARTIST_WORKING', 'ARTIST_DONE', 'ARTIST_SENT', 'FRAMING', 'SHIPPED', 'DELIVERED']
    : ['PHOTO', 'GIFT'].includes(k) ? ['RECEIVED', 'PAID', 'PRINTING', 'PRINTED', 'FRAMING', 'SHIPPED', 'DELIVERED']
    : k === 'MARKET' ? ['RECEIVED', 'PRICE_SENT', 'PAID', 'SHIPPED', 'DELIVERED']
    : k === 'LICENCE' ? ['RECEIVED', 'PRICE_SENT', 'PAID', 'DELIVERED']
    : ['RECEIVED', 'PRICE_SENT', 'PAID', 'FRAMING', 'SHIPPED', 'DELIVERED'];
  const when = { RECEIVED: e.createdAt, PAID: e.ziinaPaidAt, ARTIST_WORKING: e.artistStartedAt, ARTIST_DONE: e.artistFinishedAt, ARTIST_SENT: e.artistShippedAt,
    FRAMING: fj.acceptedAt || fj.assignedAt, PRINTED: pj.readyAt, SHIPPED: dj.pickedAt, DELIVERED: dj.deliveredAt || e.deliveredAt };
  const d = (x) => (x ? new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
  const s = e.status || 'RECEIVED', side = ['REPLACEMENT', 'REFUNDED', 'CANCELLED'].includes(s);
  let at = path.indexOf(s); if (at < 0) at = side ? path.length : 0;
  const fin = s === 'DELIVERED'; // the last step reached: shown done, not "now"
  const steps = path.map((x, i) => `<li class="${i < at || (fin && i === at) ? 'done' : i === at ? 'now' : ''}"><span class="dot">${i < at || (fin && i === at) ? '✓' : i + 1}</span><b>${esc(STATUS[x] || x)}</b>${when[x] && i <= at ? `<small>${d(when[x])}</small>` : i === at ? '<small>now</small>' : ''}</li>`).join('');
  return `<div class="strack"><div class="strack-h">Order status <span class="muted">· ${esc(STATUS[s] || s)}${side ? '' : at < path.length - 1 ? ` · next: ${esc(STATUS[path[at + 1]])}` : ' · complete'}</span></div><ol>${steps}${side ? `<li class="now side"><span class="dot">!</span><b>${esc(STATUS[s])}</b></li>` : ''}</ol></div>`;
}
/** The flow goes in the space under the order list (beside the open order). */
function showFlow(e, d) {
  const slot = $('flowSlot'); if (!slot) return;
  if (!e) { slot.hidden = true; slot.innerHTML = ''; return; }
  slot.hidden = false;
  slot.dataset.fp = 'sand'; // the studio's chosen look
  slot.innerHTML = `<div class="flowhead"><h3>✨ Document flow</h3><span class="muted mono" style="font-size:12px;margin-left:auto">${esc(e.ref)} · ${esc(e.customerName || '')}</span></div>${d ? docFlow(e, d) : '<div class="muted" style="font-size:13px">Press <b>Check Zoho</b> on the order to draw its documents.</div>'}${statusTrack(e)}`;
}
function docsList(e) {
  const raw = costings.get(e.id)?.zohoDocs;
  let d = null;
  try { d = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; if (typeof d === 'string') d = JSON.parse(d); } catch { d = null; }
  queueMicrotask(() => showFlow(e, d));
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
  return `<div class="docs"><table class="costs"><tbody>${rows('SALES', 'Sales (customer)')}${rows('DELIVERY', 'Delivery')}${rows('PURCHASE', hasArtist(e) ? `Purchase (${esc(artistOf(e))}, frame shop, courier)` : 'Purchase (frame shop, courier)')}</tbody></table>
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
  return `<div class="card" id="zohoBox" style="padding:12px 14px;display:grid;gap:6px;background:var(--sunk)">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b style="color:${color}">${icon} ${esc(ZOHO_LABEL[st] || 'Zoho Books')}</b>
      <span class="muted" style="font-size:12px;margin-right:auto">${esc(when(e.zohoAt))}</span>
      <button type="button" class="btn" id="checkZoho" style="padding:6px 12px;font-size:13px">Check Zoho</button>
    </div>
    <div style="font-size:14px;overflow-wrap:anywhere">${escSym(e.zohoMessage || 'No reply from Zoho yet. Press Check Zoho to look it up.')}</div>
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
  return `<div class="card" id="ziinaCard" style="padding:10px 14px;display:grid;gap:4px;background:var(--sunk);font-size:13px">
    <b style="color:${paid ? 'var(--ok)' : 'var(--fg)'}">${paid ? '✓ Paid online with Ziina' : 'Ziina payment link'}${e.ziinaTest === 'yes' ? ' <span class="chip">test</span>' : ''}</b>
    <div>${escSym(e.ziinaMessage || '')}${paid ? ` ${esc(when(e.ziinaPaidAt))}${e.ziinaCard ? ` · ${esc(e.ziinaCard)}` : ''}` : e.ziinaAmount ? ` Link for ⃃ ${Number(e.ziinaAmount).toLocaleString('en-US')}; the order turns Paid by itself when the customer pays.` : ''}${refund}</div>
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
    if (!['PRICE', 'PHOTO'].includes(e.kind)) return; // a framed print of a painting: the painting's picture
    if (!thumbProducts) {
      thumbProducts = [];
      let nextToken = null;
      do { const r = await client.models.Product.list({ limit: 500, nextToken, selectionSet: ['id', 'title', 'code', 'imageKey'] }); thumbProducts.push(...(r.data || [])); nextToken = r.nextToken; } while (nextToken);
    }
    const code = String(det['Artwork no.'] || '').trim();
    const name = String(e.title || '').replace(/^(Price enquiry( \(offer\))?|Artwork order|Framed print): /i, '').replace(/\s*\([^)]*\)\s*$/, e.kind === 'PHOTO' ? '' : '$&').trim().toLowerCase();
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

// ---------- Discount on the order (studio): % or dirhams, typed here or from the customer's standard discount ----------
// The Price box holds the price before discount; the customer pays the price after it (quotedPrice). listPrice and
// discountAmount keep both, so the customer sees the old price struck through.
function discountRow(e) {
  const code = e.discountCode && !e.discountType; // a customer's promo code is shown separately
  if (code) return '';
  const t = e.discountType || '', v = e.discountValue ?? '';
  return `<div id="discBox" style="display:grid;grid-template-columns:auto 90px 1fr;gap:6px;align-items:center;margin-top:6px">
    <select id="eDiscT" aria-label="Discount type" style="width:auto"><option value="">No discount</option><option value="PCT" ${t === 'PCT' ? 'selected' : ''}>Discount %</option><option value="AED" ${t === 'AED' ? 'selected' : ''}>Discount ⃃</option><option value="CODE">Voucher / gift card / offer code</option></select>
    <input id="eDiscV" type="number" min="0" step="0.01" aria-label="Discount" value="${esc(v)}" ${t ? '' : 'hidden'}>
    <span class="muted" id="eDiscOut" style="font-size:12px"></span>
    <input id="eDiscNote" placeholder="Reason (optional, e.g. loyal customer)" value="${esc(e.discountNote || '')}" style="grid-column:1/-1" ${t ? '' : 'hidden'}>
    <div id="eVchBox" style="grid-column:1/-1;display:grid;gap:6px" hidden><div style="display:flex;gap:6px"><input id="eVch" list="eVchList" autocomplete="off" placeholder="Voucher or offer code (KAL-…, GIFT-…, offer code)" style="flex:1"><datalist id="eVchList"></datalist><button type="button" class="btn small" id="eVchApply">Apply</button></div>
      <span class="muted" id="eVchMsg" style="font-size:12px">Pick one of the customer's vouchers or type any code. The price above is saved with it.</span></div></div>`;
}
const r2c = (x) => Math.round(x * 100) / 100;
function discountOf() {
  const t = $('eDiscT')?.value || '', v = Number($('eDiscV')?.value || 0), list = Number($('ePrice')?.value || 0);
  if (!t || t === 'CODE' || !(v > 0) || !(list > 0)) return { t: '', amount: 0, list };
  const amount = t === 'PCT' ? r2c(list * Math.min(v, 100) / 100) : Math.min(v, list);
  return { t, v, amount: Math.round(amount), list };
}
function finalPriceStr() {
  const raw = $('ePrice')?.value.trim() ?? '';
  if (raw === '') return '';
  const d = discountOf();
  return d.t ? String(Math.max(0, d.list - d.amount)) : raw;
}
function readDiscount() {
  if (!$('eDiscT')) return {};
  const d = discountOf();
  if (!d.t) return currentDiscountType ? { discountType: null, discountValue: null, discountNote: null, discountAmount: null, listPrice: null, discountCode: null } : {};
  return { discountType: d.t, discountValue: d.v, discountNote: $('eDiscNote').value.trim() || null, discountAmount: d.amount, listPrice: d.list,
    discountCode: `Studio discount ${d.t === 'PCT' ? `${d.v}%` : `⃃ ${d.v}`}` };
}
let currentDiscountType = '';
/* ---------- Customer's offer ("Make an offer" on the website): accept, counter or decline ---------- */
function offerOf(e) { const m = String(parseDetails(e.details).Offer || '').replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; }
function offerPanel(e) {
  const o = offerOf(e);
  if (o == null) return '';
  const open = ['RECEIVED', 'PRICE_SENT'].includes(e.status || 'RECEIVED');
  const q = e.quotedPrice != null ? Number(e.quotedPrice) : null;
  const state = !open ? (['CANCELLED'].includes(e.status) ? '<b class="muted">Declined</b>' : q === o ? '<b style="color:var(--ok)">Accepted · paid</b>' : q != null ? `<b style="color:var(--ok)">Paid at your revised price ⃃ ${q.toLocaleString('en-US')}</b>` : '') : q == null ? '<b style="color:var(--kumkum)">Waiting for your answer</b>' : q === o ? '<b style="color:var(--ok)">Accepted: price set to the offer</b>' : `Your answer: <b>⃃ ${q.toLocaleString('en-US')}</b> (counter offer)`;
  return `<fieldset class="cost" id="offerBox" style="border-color:var(--gold)"><legend>Customer's offer</legend>
    <div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap"><span style="font-size:22px;font-weight:700">⃃ ${o.toLocaleString('en-US')}</span><span class="muted">offered for ${esc(e.title)}</span><span style="font-size:13px">${state}</span></div>
    ${open ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:8px">
      <button type="button" class="btn small" id="ofAccept">Accept ⃃ ${o.toLocaleString('en-US')}</button>
      <label class="field" style="gap:2px;margin:0"><span style="font-size:11px;font-weight:700">Revised price (⃃)</span><input id="ofCounter" type="number" min="1" step="1" style="width:120px" value="${q != null && q !== o ? q : ''}"></label>
      <button type="button" class="btn small ghost" id="ofCounterBtn">Send revised price</button>
      <button type="button" class="btn small ghost" id="ofDecline" style="color:var(--kumkum)">Decline</button></div>
      <div id="ofWarn" class="err" style="font-size:13px;margin-top:6px" hidden></div>
      <div class="muted" style="font-size:12px;margin-top:6px">Each button fills the price, status and message below. Check them, then press <b>Save</b>: the customer is emailed and can pay the agreed price. The customer's standard discount is not added on top of an offer.</div>` : ''}
  </fieldset>`;
}
function wireOffer(e) {
  const o = offerOf(e);
  if (o == null || !$('ofAccept')) return;
  const first = String(e.customerName || '').split(' ')[0];
  // An offer is already the negotiated price: the customer's standard discount is not added on top.
  const noDisc = () => { const t = $('eDiscT'); if (t && t.value) { t.value = ''; ['input', 'change'].forEach((k) => t.dispatchEvent(new Event(k))); } };
  if (!e.discountType) noDisc();
  const fill = (price, status, msg) => {
    if (price != null && !$('ePrice').readOnly) { noDisc(); $('ePrice').value = price; ['input', 'change'].forEach((t) => $('ePrice').dispatchEvent(new Event(t))); }
    if (status && [...$('eStatus').options].some((x) => x.value === status && !x.disabled)) { $('eStatus').value = status; $('eStatus').dispatchEvent(new Event('change')); }
    $('eMsg').value = msg; $('eMsg').dispatchEvent(new Event('input'));
    $('eMsg').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const aed = (n) => `AED ${Number(n).toLocaleString('en-US')}`;
  // Warning only: the offer (or revised price) against the order's cost and the market band.
  const warn = () => {
    const w = $('ofWarn'); if (!w) return;
    const p = Number($('ofCounter').value) || o, out = [];
    try {
      if ($('cTier')) {
        const { local, ...inp } = readCosting(); const r = calc({ ...inp, local }, p);
        if (r.margin != null && r.margin < 0) out.push(`${aed(p)} doesn't cover the cost of ${aed(Math.round(r.total))} plus fees: a loss of about ${aed(Math.round(-r.margin))}`);
        else if (r.marginPct != null && r.marginPct < 0.2) out.push(`only ${Math.round(r.marginPct * 100)}% margin at ${aed(p)}`);
        const m = rates.market?.[$('cTier').value], band = m?.[mediumOf(e)];
        if (band && p < band[0]) out.push(`below the market band ${aed(band[0])}–${aed(band[1])}`);
      }
    } catch { /* costing not ready */ }
    w.hidden = !out.length; w.innerHTML = out.length ? `⚠ ${out.join(' · ')}. You can still accept it.` : '';
  };
  setTimeout(warn, 0);
  ['ofCounter', 'cInr', 'cTier', 'cDel', 'cFr', 'cIc', 'cLc'].forEach((id) => { $(id)?.addEventListener('input', warn); $(id)?.addEventListener('change', warn); });
  $('ofAccept').onclick = () => fill(o, null, `Hello ${first}, good news: the artist has accepted your offer of ${aed(o)} for "${e.title}". You can pay with the link below to confirm your order.`);
  $('ofCounterBtn').onclick = () => {
    const c = Number($('ofCounter').value);
    if (!(c > 0)) { $('ofCounter').focus(); return; }
    fill(c, null, `Hello ${first}, thank you for your offer of ${aed(o)} for "${e.title}". The best price we can offer is ${aed(c)}. If that works for you, pay with the link below to confirm your order.`);
  };
  $('ofDecline').onclick = () => fill(null, 'CANCELLED', `Hello ${first}, thank you for your offer of ${aed(o)} for "${e.title}". We're sorry, the artist can't accept it this time. You're welcome to make a new offer or ask us for the price.`);
}

// Studio: put a voucher / gift card / offer code on the order (same rules as when the customer adds it themselves).
let vchCache = null;
async function loadVouchersFor(e) {
  if (!$('eVchList') || $('eVchList').dataset.for === e.id) return;
  $('eVchList').dataset.for = e.id;
  try {
    if (!vchCache) { const out = []; let nextToken = null; do { const r = await client.models.Voucher.list({ limit: 500, nextToken }); out.push(...(r.data || [])); nextToken = r.nextToken; } while (nextToken); vchCache = out; }
    const now = Date.now(), mail = String(e.email || '').toLowerCase();
    const live = vchCache.filter((v) => v.active !== false && (!v.endAt || new Date(v.endAt).getTime() > now) && (v.kind === 'GIFT' ? Number(v.balance || 0) > 0 : !v.maxUses || Number(v.usedCount || 0) < Number(v.maxUses)));
    const mine = (v) => (String(v.forEmail || '').toLowerCase() === mail && mail ? 0 : v.forEmail ? 2 : 1);
    live.sort((a, b) => mine(a) - mine(b));
    const what = (v) => (v.kind === 'GIFT' ? `gift card ⃃ ${Number(v.balance || 0)} left` : v.discountType === 'AED' ? `⃃ ${v.discountValue} off` : `${v.discountValue}% off`);
    $('eVchList').innerHTML = live.filter((v) => !v.forEmail || mine(v) === 0).map((v) => `<option value="${esc(v.code)} · ${esc(v.forName || 'anyone')} · ${esc(what(v))}"></option>`).join('');
    const n = live.filter((v) => mine(v) === 0).length;
    $('eVchMsg').textContent = n ? `${n} voucher${n > 1 ? 's' : ''} for this customer (listed first). The price above is saved with the code.` : 'No voucher made for this customer: pick an open one or type a code. The price above is saved with it.';
  } catch (ex) { $('eVchMsg').textContent = `Vouchers not loaded: ${ex.message}`; }
}
async function applyOrderCode(e, code, msg) {
  code = String(code || '').toUpperCase();
  if (!code) { msg.textContent = 'Pick or type a code.'; return; }
  const price = Number($('ePrice')?.value || 0);
  if (!(price > 0)) { msg.textContent = 'Enter the price first.'; return; }
  msg.textContent = 'Applying…';
  try {
    // The code works on the saved price: save the price typed above first (status unchanged, nothing sent).
    const saved = Number(e.listPrice ?? e.quotedPrice ?? 0);
    if (price !== saved) {
      const u = await client.models.Enquiry.update({ id: e.id, quotedPrice: price, listPrice: null, discountType: null, discountValue: null, discountAmount: null, discountNote: null });
      if (u.errors?.length) throw new Error(u.errors[0].message);
    }
    const r = await client.mutations.applyCode({ id: e.id, code });
    if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
    const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    vchCache = null;
    msg.textContent = out?.removed ? `Code ${out.removed} removed.` : `Applied: − ⃃ ${out?.discount} → customer pays ⃃ ${out?.price}.`;
    await refreshOne(e.id);
  } catch (ex) { msg.textContent = ex.message; }
}
async function wireDiscount(e) {
  if ($('eCodeRemove')) $('eCodeRemove').onclick = async () => {
    const m = $('eCodeMsg'); m.textContent = 'Removing…';
    try { const r = await client.mutations.applyCode({ id: e.id, code: null }); if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, '')); vchCache = null; await refreshOne(e.id); } catch (ex) { m.textContent = ex.message; }
  };
  currentDiscountType = e.discountType || '';
  // Code on the order: the breakdown follows the Price box live (same rule as the server), saved on Save.
  if ($('codeRe') && $('ePrice')) {
    const f = (n) => { const x = Number(n || 0); return x.toLocaleString('en-US', Number.isInteger(x) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const was = Number(e.listPrice || 0), prevAmt = Number(e.discountAmount || 0), loy = Number(e.loyaltyAmount || 0);
    let rule = null; // { t: 'PCT'|'AED'|'GIFT', v, min }
    const ruleOf = async () => {
      try {
        if (!vchCache) { const out = []; let nt = null; do { const r = await client.models.Voucher.list({ limit: 500, nextToken: nt }); out.push(...(r.data || [])); nt = r.nextToken; } while (nt); vchCache = out; }
        const v = vchCache.find((x) => String(x.code).toUpperCase() === String(e.discountCode).toUpperCase());
        if (v) return v.kind === 'GIFT' ? { t: 'GIFT', v: Number(v.balance || 0) + prevAmt } : { t: v.discountType === 'AED' ? 'AED' : 'PCT', v: Number(v.discountValue || 0), min: Number(v.minOrder || 0) };
        const pr = ((await client.models.Promotion.list({ limit: 500 })).data || []).find((x) => String(x.code).toUpperCase() === String(e.discountCode).toUpperCase());
        if (pr) return { t: pr.discountType === 'AED' ? 'AED' : 'PCT', v: Number(pr.discountValue || 0), min: Number(pr.minOrder || 0) };
      } catch { /* fall back below */ }
      return was > 0 ? { t: 'PCT', v: Math.round((prevAmt / was) * 10000) / 100 } : null;
    };
    const re = () => {
      const v = Number($('ePrice').value || 0), changed = v > 0 && v !== was;
      const list = changed ? v : was;
      let amt = prevAmt, why = '';
      if (changed && rule) {
        if (rule.min && list < rule.min) { amt = 0; why = `needs an order of at least ⃃ ${f(rule.min)}`; }
        else amt = Math.max(0, Math.min(list - 2, rule.t === 'GIFT' ? rule.v : rule.t === 'AED' ? rule.v : Math.round(list * rule.v) / 100));
        amt = Math.round(amt * 100) / 100;
      }
      const pays = Math.round((list - amt - loy) * 100) / 100;
      $('cbList').textContent = `⃃ ${f(list)}`; $('cbDisc').textContent = `− ⃃ ${f(amt)}`; $('cbPays').textContent = `⃃ ${f(pays)}`;
      $('cbPct').textContent = rule && rule.t === 'PCT' ? `(${rule.v}%)` : '';
      $('cbZoho').textContent = `Zoho shows the same: ⃃ ${f(list)} with ⃃ ${f(list - pays)} in the Discount column.`;
      $('codeRe').hidden = !changed;
      $('codeRe').textContent = !changed ? '' : why ? `New price ⃃ ${f(list)}: the code no longer applies (${why}). Save to keep this price without it.`
        : `Not saved yet: ⃃ ${f(list)} − ⃃ ${f(amt)} = ⃃ ${f(pays)}. Press Save to apply it (was ⃃ ${f(was)} − ⃃ ${f(prevAmt)}).`;
    };
    ['input', 'change'].forEach((k) => $('ePrice').addEventListener(k, re));
    ruleOf().then((r) => { rule = r; re(); });
  }
  if (!$('eDiscT')) return;
  const show = () => {
    const d = discountOf(), code = $('eDiscT').value === 'CODE', on = !!$('eDiscT').value && !code;
    $('eDiscV').hidden = !on; $('eDiscNote').hidden = !on; $('eVchBox').hidden = !code;
    if (code) loadVouchersFor(e);
    $('eDiscOut').innerHTML = on && d.t ? `− ⃃ ${d.amount.toLocaleString('en-US')} → customer pays <b>⃃ ${Math.max(0, d.list - d.amount).toLocaleString('en-US')}</b>` : on ? 'enter the discount' : '';
  };
  ['eDiscT', 'eDiscV', 'ePrice'].forEach((id) => { $(id).addEventListener('input', show); $(id).addEventListener('change', show); });
  if (priceLocked(e)) { ['eDiscT', 'eDiscV', 'eDiscNote'].forEach((id) => { $(id).disabled = true; }); }
  $('eVchApply').onclick = () => applyOrderCode(e, $('eVch').value.trim().split(/\s/)[0], $('eVchMsg'));
  show();
  // The customer's standard discount (Customers tab), offered on orders that have none yet.
  if (!e.discountType && !priceLocked(e) && e.customerCode && BEFORE_PAYMENT.includes(e.status || 'RECEIVED')) {
    try {
      const c = (await client.models.Customer.get({ code: e.customerCode }))?.data;
      const AREA_KINDS = { ART: ['PRICE', 'COMMISSION'], CRAFTS: ['MARKET'], GIFT: ['GIFT'] };
      const fits = !c?.discountArea || c.discountArea === 'ALL' || (AREA_KINDS[c.discountArea] || []).includes(e.kind);
      if (fits && c?.discountType && Number(c.discountValue) > 0 && $('eDiscT') && !$('eDiscT').value) {
        $('eDiscT').value = c.discountType; $('eDiscV').value = c.discountValue; $('eDiscNote').value = c.discountNote || 'Customer\'s standard discount';
        show(); renderCost?.();
        $('eDiscOut').insertAdjacentHTML('beforeend', ' <span style="color:var(--gold)">(this customer\'s standard discount: saved with the order when you save)</span>');
      }
    } catch { /* no customer row */ }
  }
}

// ---------- Order screen layouts (Settings → Order screen layout): Original, A Tabs, B Dashboard, C Journey ----------
// The detail is drawn once as before; the layout then moves its parts into tabs / columns (the same elements, so every
// button and field keeps working). Original leaves it as it is.
let LAYOUT = 'original';
try { LAYOUT = localStorage.getItem('kalaiOrderLayout') || 'original'; } catch { /* storage blocked */ }
// The layout saved in Settings is the same in every browser (this browser's copy is only a cache).
client.models.SiteSetting.get({ id: 'site' }).then((r) => { setHelpMode(r?.data?.helpMode || 'on'); const v = r?.data?.orderLayout || 'original'; if (v !== LAYOUT) { LAYOUT = v; try { localStorage.setItem('kalaiOrderLayout', v); } catch { /* */ } applyDeskLayout(); } }).catch(() => {});
window.kalaiSetLayout = (v, keep = true) => { LAYOUT = v || 'original'; if (keep) { try { localStorage.setItem('kalaiOrderLayout', LAYOUT); } catch { /* */ } } applyDeskLayout(); };
let layoutTab = 'order';
function applyDeskLayout() {
  const desk = $('desk'); if (!desk) return;
  desk.dataset.layout = LAYOUT;
  const e = all.find((x) => x.id === selectedId);
  if (e && $('editForm')) showDetail(e); else desk.classList.remove('open');
}
const savedLayout = () => LAYOUT;
async function showDetail(e) {
  await showDetailBody(e);
  try { arrangeDetail(e); } catch (err) { console.warn('Layout', err); }
  // Orders without a Zoho box still get the status track under the order list.
  if (!document.getElementById('checkZoho')) showFlow(e, null);
  // "What next?" helper in the corner (Settings → General).
  try { showNextHelp(e, { jobs: jobsOf(e), costing: costings.get(e.id) || {}, artistOf, hasArtist, STATUS }); } catch (err) { console.warn('Help', err); }
}
function arrangeDetail(e) {
  const LAYOUT_SAVED = savedLayout();
  // On a tablet (iPad) the original side-by-side layout is too narrow: use the stacked one (list on top, order below).
  const tablet = window.innerWidth <= 1366 && !!window.matchMedia?.('(pointer:coarse)').matches; // a real touch tablet, not a laptop window
  const LAYOUT = LAYOUT_SAVED === 'original' && (tablet || window.innerWidth <= 1000) ? 'b' : LAYOUT_SAVED;
  const desk = $('desk'), box = $('detail');
  desk.dataset.layout = LAYOUT;
  desk.classList.toggle('open', !!$('editForm') && LAYOUT === 'a');
  if (LAYOUT === 'original' || !$('editForm')) return;
  const q = (sel) => box.querySelector(sel);
  const fieldOf = (id) => $(id)?.closest('.field');
  const rowOf = (id) => $(id)?.closest('.two');
  const el = (cls, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
  const put = (parent, ...nodes) => { nodes.flat().filter(Boolean).forEach((n) => parent.appendChild(n)); return parent; };
  $('eSave')?.setAttribute('form', 'editForm');
  const payRow = rowOf('ePayMethod'), payNote = payRow?.nextElementSibling;
  const head = put(el('lay-head'), q('.dtop'), $('fileLinks'));
  const act = put(el('lay-act'), rowOf('eStatus'), fieldOf('eMsg'), $('autoHint'), $('saveMsg'), $('eSave'), $('waLinks'));
  const parts = {
    order: [$('custBox'), $('addrBox'), q('#editForm > fieldset.cost:not([id])')],
    pay: [$('zohoBox'), $('ziinaCard'), $('payBox'), $('flowSlot')],
    ship: [$('shipBox'), $('supplierBox'), $('purchase'), $('marketBox'), $('reworkBox')],
    cost: [$('costing'), $('actualBox')],
    after: [$('afterBox')],
    review: [$('reviewBox') || [...box.children].find((x) => /customer can now rate/.test(x.textContent || ''))],
  };
  const LABEL = { order: 'Order', pay: 'Payment & Zoho', ship: 'Shipping & suppliers', cost: 'Costing', after: 'After-sales', review: 'Review' };
  const form = $('editForm');
  if (LAYOUT === 'a') {
    const top = el('lay-back', '<button type="button" class="btn small ghost" id="layBack">← All orders</button>');
    const keys = Object.keys(parts).filter((k) => parts[k].some(Boolean));
    if (!keys.includes(layoutTab)) layoutTab = 'order';
    const tabs = el('lay-tabs', keys.map((k) => `<button type="button" role="tab" data-lt="${k}" aria-selected="${k === layoutTab}">${LABEL[k]}${k === 'after' && e.cancelState === 'REQUESTED' ? ' <b>1</b>' : ''}${k === 'review' && reviews.get(e.id)?.rating ? ` ★${reviews.get(e.id).rating}` : ''}</button>`).join(''));
    const panes = keys.map((k) => { const p = put(el('lay-pane'), parts[k]); p.dataset.lp = k; p.hidden = k !== layoutTab; return p; });
    box.prepend(top, head, act, tabs, ...panes);
    form.hidden = true; form.style.display = 'none';
    tabs.querySelectorAll('[data-lt]').forEach((b) => { b.onclick = () => { layoutTab = b.dataset.lt; tabs.querySelectorAll('[data-lt]').forEach((x) => x.setAttribute('aria-selected', x === b)); panes.forEach((p) => { p.hidden = p.dataset.lp !== layoutTab; }); }; });
    $('layBack').onclick = () => { selectedId = null; desk.classList.remove('open'); render(); restoreFlow(); box.innerHTML = '<p class="muted">Select an order to see the details, set a price and update its status.</p>'; showFlow(null); };
    if ($('flowSlot')) $('flowSlot').hidden = false; // status track always; the document flow once Zoho has documents
    return;
  }
  if (LAYOUT === 'b') {
    const c1 = put(el('lay-col'), head, parts.order, parts.review);
    const c2 = put(el('lay-col'), parts.ship, parts.pay.filter((x) => x && x.id !== 'flowSlot'), parts.cost, parts.after);
    const c3 = put(el('lay-col lay-side'), el('lay-h', '<b>Action</b>'), act);
    box.prepend(put(el('lay-grid3'), c1, c2, c3));
    // The document flow runs as a band across the top, between the order list and the order's details.
    const fs = $('flowSlot'); if (fs) { fs.classList.add('flowband'); box.prepend(fs); }
    form.style.display = 'none';
    return;
  }
  // C: journey
  const main = put(el('lay-col'), head, journeyCard(e), parts.ship, parts.order.slice(1), parts.after);
  const accs = [['Costing', parts.cost], ['Payment & Zoho', parts.pay.filter((x) => x && x.id !== 'flowSlot')]].map(([t, nodes]) => { const d = document.createElement('details'); d.className = 'lay-acc'; d.innerHTML = `<summary>${t}</summary>`; put(d, nodes); return d; });
  put(main, accs);
  const side = put(el('lay-col lay-side'), el('lay-h', '<b>Action</b>'), act, $('custBox'), parts.review, $('flowSlot'));
  box.prepend(put(el('lay-grid2'), main, side));
  form.style.display = 'none';
}
/** C layout: the order's steps as a timeline, from what the order already records. */
function journeyCard(e) {
  const j = jobsOf(e), steps = [];
  const add = (done, title, when2, note = '', doc = '') => steps.push({ done, title, when: when2, note, doc });
  add(true, 'Order received', e.createdAt, KIND[e.kind] || '', e.zohoQuote || '');
  add(['PRICE_SENT', ...SOLD].includes(e.status) || !!e.paymentLink, 'Price sent', '', e.quotedPrice != null ? `⃃ ${Number(e.quotedPrice).toLocaleString('en-US')}` : '');
  add(!!(e.ziinaPaidAt || e.zohoPaymentId || SOLD.includes(e.status)), 'Paid', e.ziinaPaidAt || '', e.ziinaPaidAt ? 'Ziina' : PAY_LABEL_UI[e.paymentMethod] || '', e.zohoInvoice || '');
  if (hasArtist(e)) add(!!e.artistShippedAt, `Artist: ${artistOf(e)}`, e.artistShippedAt || e.artistFinishedAt || e.artistStartedAt || '', e.artistStage ? `${String(e.artistStage).toLowerCase()}${e.artistAwb ? ` · ${e.artistCourier || ''} ${e.artistAwb}` : ''}` : 'not started');
  if (j.printer) add(['READY', 'COLLECTED'].includes(j.printer.stage), `Print: ${j.printer.name}`, j.printer.readyAt || '', String(j.printer.stage || '').toLowerCase(), j.printer.price != null ? `⃃ ${j.printer.price}` : '');
  if (j.framer || ['FRAMING', 'SHIPPED', 'DELIVERED'].includes(e.status)) add(!!j.framer && ['READY', 'COLLECTED'].includes(j.framer.stage) || ['SHIPPED', 'DELIVERED'].includes(e.status), `Framing${j.framer ? `: ${j.framer.name}` : ''}`, j.framer?.readyAt || '', j.framer ? String(j.framer.stage || '').toLowerCase() : '', j.framer?.price != null ? `⃃ ${j.framer.price}` : '');
  add(['SHIPPED', 'DELIVERED'].includes(e.status), 'Picked up / shipped', j.delivery?.pickedAt || '', [e.courierName, e.trackingNo].filter(Boolean).join(' · '), e.zohoChallan || '');
  add(e.status === 'DELIVERED', 'Delivered', e.deliveredAt || '', e.deliveryName || '', j.delivery?.price != null ? `⃃ ${j.delivery.price}` : '');
  if (e.cancelRequest) add(e.cancelState !== 'REQUESTED', `Request: ${REQ_LABEL[e.cancelRequest] || e.cancelRequest}`, e.cancelRequestedAt || '', e.cancelState === 'REQUESTED' ? 'open' : String(e.cancelState || '').toLowerCase());
  if (reviews.get(e.id)) add(true, `Review ${'★'.repeat(Number(reviews.get(e.id).rating) || 0)}`, reviews.get(e.id).createdAt || '', String(reviews.get(e.id).text || reviews.get(e.id).comment || '').slice(0, 80));
  const d = document.createElement('div'); d.className = 'card lay-journey';
  d.innerHTML = `<b style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Journey</b>${steps.map((x) => `<div class="lj ${x.done ? 'done' : ''}"><i></i><div><b>${esc(x.title)}</b>${x.when ? ` <span class="muted">${esc(day(x.when))}</span>` : ''}${x.note ? `<div class="muted" style="font-size:12px">${esc(x.note)}</div>` : ''}</div><span class="mono muted" style="font-size:12px">${esc(x.doc)}</span></div>`).join('')}`;
  return d;
}
// The document-flow card lives under the order list; a layout may borrow it into the detail: put it back first.
function restoreFlow() { const fs = $('flowSlot'), home = document.querySelector('.deskL'); if (fs) fs.classList.remove('flowband'); if (fs && home && !home.contains(fs)) home.appendChild(fs); }
const PAY_LABEL_UI = { ZIINA: 'Ziina', BANK: 'Bank transfer', CASH: 'Cash', CARD: 'Card', OTHER: 'Other' };
async function showDetailBody(e) {
  restoreFlow();
  showFlow(null);
  hideNextHelp();
  const det = parseDetails(e.details);
  const s = e.status || 'RECEIVED';
  const locked = isLocked(e);
  $('detail').innerHTML = `
    <div class="dtop"><div class="dtop-main">
    <div><div class="refchip"><b>${esc(e.ref)}</b><span>${esc(KIND[e.kind] || '')}</span></div>
    <h2 style="font-size:22px;margin-top:4px">${esc(e.title)}</h2></div>
    <dl class="kv">
      <dt>Customer</dt><dd>${esc(e.customerName)}${e.customerCode ? ` · <button type="button" class="linkbtn mono" style="font-size:11px;padding:0 3px;border:0;background:none;text-decoration:underline;color:var(--muted)" data-cust="${esc(e.customerCode)}" title="Show all orders of this customer">${esc(e.customerCode)}</button>` : ''}</dd>
      <dt>Email</dt><dd>${e.email ? esc(e.email) : '<span class="muted" style="font-size:12px">none: sent without signing in, so no emails reach the customer. Reply on WhatsApp.</span>'}</dd>
      ${Object.entries(det).filter(([k, v]) => v !== '' && v != null && !['Reference', 'Name', 'Mobile', 'Parent', 'Email'].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl></div>
    <a class="dthumb" id="dThumb" hidden target="_blank" rel="noopener" title="Open the full picture"><img alt=""><span></span></a></div>
    <div class="links" id="fileLinks">${e.fileKey ? '<span class="muted">Loading upload…</span>' : '<span class="muted">No upload attached.</span>'}</div>
    ${zohoPanel(e)}
    ${reviews.has(e.id) ? `<fieldset class="cost" id="reviewBox"><legend>Customer review</legend>${reviewCard(reviews.get(e.id), false)}</fieldset>` : e.status === 'DELIVERED' ? '<div class="muted" style="font-size:13px">Delivered: the customer can now rate this order under My enquiries & orders.</div>' : ''}
    ${offerPanel(e)}
    <form id="editForm" novalidate style="display:grid;gap:12px">
      <fieldset class="cost" id="custBox"><legend>Customer</legend><div class="field"><label for="ePhone">Customer mobile / WhatsApp</label><input id="ePhone" type="tel" inputmode="tel" placeholder="+971 50 123 4567" value="${esc(e.phone)}">
        <span class="muted" style="font-size:12px">Correct it here if the customer typed it wrongly, then save.</span></div></fieldset>
      <div class="two">
        <div class="field"><label for="eStatus">Status</label><select id="eStatus">${Object.entries(STATUS).map(([k, v]) => { const lk = locked && BEFORE_PAYMENT.includes(k) && k !== s; const why = lk ? 'locked' : statusBlock(e, k, s); return `<option value="${k}" ${k === s ? 'selected' : ''} ${why ? 'disabled' : ''}>${v}${why ? ` (${why})` : ''}</option>`; }).join('')}</select>
          ${needsSiva(e) && !sivaDone(e) && !AFTER_SIVA.includes(s) ? `<span class="muted" style="font-size:12px">Being framed / Shipped open once ${esc(artistOf(e))} marks it <b>Sent to frame shop</b> (you can do it for them in ${artistPage(e)}).</span>` : ''}</div>
        <div class="field"><label for="ePrice">Price (⃃)</label><input id="ePrice" type="number" min="0" step="1" value="${((e.discountType || e.discountCode) && e.listPrice != null ? e.listPrice : null) ?? e.quotedPrice ?? (/^(AED|Dhs) ?\d+/.test(String(det.Price || '')) && !e.listingId ? String(det.Price).match(/\d+/)[0] : (e.kind === 'GIFT' || e.kind === 'PHOTO') && /^⃃ [\d,]+$/.test(String(det.Total || '').trim()) ? String(det.Total).replace(/[^\d]/g, '') : '')}" ${priceLocked(e) ? `readonly title="Locked: invoice ${esc(e.zohoInvoice || '')} exists in Zoho"` : ''}>
          ${discountRow(e)}
          ${e.loyaltyRedeemed ? `<span class="muted" style="font-size:12px">✦ Customer used ${Number(e.loyaltyRedeemed).toLocaleString('en-US')} Kalai Circle points: − ⃃ ${Number(e.loyaltyAmount || 0).toLocaleString('en-US')} (already taken off the price shown).</span>` : ''}
          ${e.loyaltyAt ? `<span class="muted" style="font-size:12px">✦ Kalai Circle: customer earned <b>${Number(e.loyaltyPoints || 0).toLocaleString('en-US')} points</b> on this order (${new Date(e.loyaltyAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}).</span>` : e.customerCode && !['CANCELLED', 'REFUNDED'].includes(e.status) && e.quotedPrice ? `<span class="muted" style="font-size:12px">✦ Kalai Circle points for this order are added 48 hours after it is delivered${e.status === 'DELIVERED' && e.deliveredAt ? `: due ${new Date(new Date(e.deliveredAt).getTime() + 49 * 3600_000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}. The balance is under Customers → this customer.</span>` : ''}
          ${e.discountCode && !e.discountType ? (() => { const f = (n) => Number(n || 0).toLocaleString('en-US'); const c = String(e.discountCode); const what = /^REF-/.test(c) ? 'Invite code' : /^PRG-/.test(c) ? 'Programme code' : /^(KAL|GIFT)-/.test(c) ? 'Voucher / gift card' : 'Offer code';
            return `<div style="font-size:13px;border:1px solid var(--line);border-radius:6px;padding:6px 8px;display:grid;gap:2px;background:var(--surface)">
              <div style="display:flex;justify-content:space-between"><span>Price</span><span class="mono" id="cbList">⃃ ${f(e.listPrice)}</span></div>
              <div style="display:flex;justify-content:space-between;color:var(--ok)"><span>${what} <b class="mono">${esc(c)}</b> <span id="cbPct"></span></span><span class="mono" id="cbDisc">− ⃃ ${f(e.discountAmount)}</span></div>
              ${e.loyaltyAmount ? `<div style="display:flex;justify-content:space-between;color:var(--ok)"><span>Kalai Circle points (${f(e.loyaltyRedeemed)})</span><span class="mono">− ⃃ ${f(e.loyaltyAmount)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between;font-weight:700;border-top:1px solid var(--line);padding-top:2px"><span>Customer pays</span><span class="mono" id="cbPays">⃃ ${f(e.quotedPrice)}</span></div>
              <span class="muted" style="font-size:11px"><span id="cbZoho">Zoho shows the same: ⃃ ${f(e.listPrice)} with ⃃ ${f(Number(e.listPrice || 0) - Number(e.quotedPrice || 0))} in the Discount column.</span> Price above = before the code: if you change it, the code is worked out again on the new price when you save.</span><b id="codeRe" style="font-size:12px;color:var(--kumkum)" hidden></b>${!priceLocked(e) && BEFORE_PAYMENT.includes(e.status || 'RECEIVED') ? `<div style="display:flex;gap:8px;align-items:center;margin-top:4px"><button type="button" class="btn small ghost" id="eCodeRemove">Remove this code</button><span class="muted" id="eCodeMsg" style="font-size:11px"></span></div>` : ''}</div>`; })() : ''}${e.kind === 'GIFT' && e.quotedPrice == null ? `<span class="muted" style="font-size:12px">Filled from the customer's form: framing ${/age (\d+)/.test(String(det.Child || '')) && Number(String(det.Child).match(/age (\d+)/)[1]) <= 10 ? 'free (age 10 and under)' : '⃃ 79 (age 11–17)'} + delivery ${esc(det['Delivery charge'] || '')}${det.Extras ? ` + extras (${esc(det.Extras)})` : ''} = ${esc(det.Total || '')}. Check it, then save with status <b>Price sent</b>.</span>` : ''}</div>
      </div>
      ${e.kind === 'LICENCE' ? licenceSection(e) : `${addressSection(e)}
      ${shippingSection(e)}
      ${costingSection(e)}`}
      ${supplierSection(e)}
      ${actualSection(e)}
      <fieldset class="cost" id="payBox"><legend>Payment</legend>
      <div class="two">
        <div class="field"><label for="ePayMethod">Paid by</label><select id="ePayMethod">
          ${[['', '–'], ['ZIINA', 'Ziina'], ['BANK', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card (other)'], ['OTHER', 'Other']].map(([k, v]) => `<option value="${k}" ${k === (e.paymentMethod || (e.ziinaPaidAt ? 'ZIINA' : '')) ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><label for="ePayRef">Payment reference</label><input id="ePayRef" placeholder="Ziina / bank transaction ID" value="${esc(e.paymentRef)}"></div>
      </div>
      ${e.ziinaPaidAt && e.paymentMethod !== 'ZIINA' ? `<div class="muted" style="font-size:12px;color:var(--gold)">Ziina recorded the customer's payment through the link on ${esc(when(e.ziinaPaidAt))}, but "Paid by" says ${esc(e.paymentMethod || 'nothing')}: choose Ziina and save, unless the money really came another way.</div>` : ''}
      <div class="muted" style="font-size:12px">Prices include VAT where it applies. When you save with status <b>Paid</b>, Zoho Books creates the invoice (KAH-INV-…) and records the payment automatically${hasArtist(e) ? `, then records ${esc(artistOf(e))}’s order` : ''}.</div>
      <div class="field"><label for="eLink">Payment link</label><input id="eLink" type="url" placeholder="Leave empty: a Ziina link is created when you save as Price sent" value="${esc(e.paymentLink)}">
        <span class="muted" style="font-size:12px">${e.ziinaIntentId ? 'Created by Ziina automatically. Change the price and save again (still Price sent) to get a new link.' : 'Leave empty and save as <b>Price sent</b>: the Ziina link is made for you and emailed to the customer.'}</span></div>
      </fieldset>
      ${purchaseSection(e)}
      ${marketSection(e)}
      ${reworkSection(e)}
      ${afterSection(e)}
      <div class="field"><label for="eMsg">Message to customer <span class="muted" style="font-weight:400;font-size:12px">· emails go to ${e.email ? esc(e.email) : 'no email on this order'}</span></label><textarea id="eMsg" rows="3" placeholder="Available. Framed in teak, delivered by Thursday.">${esc(e.adminMessage)}</textarea></div>
      <div class="ok" id="saveMsg" role="status"></div>
      <div class="muted" id="autoHint" style="font-size:12px;color:var(--gold)" hidden></div>
      <button class="btn" type="submit" id="eSave">Save and update customer</button>
    </form>
    <div class="links" id="waLinks"></div>
    ${e.email ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button type="button" class="linkbtn" id="resendMail" style="font-size:13px">Email the customer again (${esc(STATUS[e.status] || e.status)})</button><span class="muted" id="resendMsg" style="font-size:12px"></span></div>` : ''}`;

  wireDiscount(e);
  wireOffer(e);
  if ($('resendMail')) $('resendMail').onclick = async () => {
    const b = $('resendMail'), m = $('resendMsg');
    b.disabled = true; m.textContent = 'Sending…';
    try {
      const r = await client.mutations.marketAdmin({ action: 'resendMail', data: JSON.stringify({ id: e.id }) });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      let o = r.data; try { if (typeof o === 'string') o = JSON.parse(o); } catch { o = {}; }
      m.textContent = `Sent to ${o?.to || e.email}: “${(o?.sent || []).join('”, “')}”. Save changes first if you edited the message.`;
    } catch (ex) { m.textContent = ex.message; } finally { b.disabled = false; }
  };
  syncFramer(e);
  // Automatic next status from what was just done on the desk (unless the status was changed by hand):
  // price entered on a new enquiry → Price sent (the customer gets the price and Ziina link);
  // payment method + reference entered while waiting for payment → Paid.
  const autoNext = () => {
    const s = e.status || 'RECEIVED'; // the saved status (kept up to date after each save)
    if ($('eStatus').value !== s || priceLocked(e) && s !== 'PRICE_SENT') return '';
    const opt = (k) => { const o = [...$('eStatus').options].find((x) => x.value === k); return o && !o.disabled ? k : ''; };
    if (s === 'RECEIVED' && Number(finalPriceStr()) > 0 && e.kind !== 'LICENCE') return opt('PRICE_SENT');
    if (s === 'PRICE_SENT' && $('ePayMethod').value && ($('ePayRef').value.trim() || $('ePayMethod').value === 'CASH')) return opt('PAID');
    return '';
  };
  const AUTO_TXT = { PRICE_SENT: 'Saving moves the status to Price sent: the customer is emailed the price and a secure Ziina payment link.', PAID: 'Saving moves the status to Paid: Zoho creates the invoice and records the payment, and the customer is emailed.' };
  const showAuto = () => { const a = autoNext(); $('autoHint').hidden = !a; $('autoHint').textContent = a ? `→ ${AUTO_TXT[a]}` : ''; $('eSave').textContent = a === 'PRICE_SENT' ? 'Save and send the price' : a === 'PAID' ? 'Save as Paid' : 'Save and update customer'; };
  ['ePrice', 'ePayMethod', 'ePayRef', 'eStatus', 'eDiscT', 'eDiscV'].forEach((id) => { $(id)?.addEventListener('input', showAuto); $(id)?.addEventListener('change', showAuto); });
  showAuto();
  e.__autoNext = autoNext;
  const waLink = () => {
    const digits = waDigits($('ePhone').value);
    if (!digits) { $('waLinks').innerHTML = '<span class="muted">No mobile number to message.</span>'; return; }
    const price = finalPriceStr(), link = $('eLink').value.trim(), msg = $('eMsg').value.trim();
    const st = $('eStatus').value, unpaid = ['RECEIVED', 'PRICE_SENT'].includes(st);
    // A "please pay" message is out of date once paid: never repeat it on WhatsApp.
    const msgOk = unpaid || !/pay (with|securely|now|using)|link below|payment link|to confirm your order/i.test(msg);
    const text = [`Hello ${e.customerName || ''}, this is ${STUDIO_WHATSAPP_NAME} about your ${unpaid ? 'enquiry' : 'order'} ${e.ref} (${e.title}).`,
      unpaid ? (price ? `Price: AED ${price}` : '') : ['REFUNDED', 'CANCELLED'].includes(st) ? `Status: ${STATUS[st]}` : `Status: ${STATUS[st] || st}${price ? ` · paid AED ${price}, thank you` : ''}`,
      msgOk ? msg : '', unpaid && link ? `Pay securely here: ${link}` : '',
      SHIP_STATUSES.includes($('eStatus').value) && $('eCourier').value.trim()
        ? `${$('eStatus').value === 'DELIVERED' ? 'Delivered' : 'Shipped'} with ${$('eCourier').value.trim()}${$('eAwb').value.trim() ? `, tracking no. ${$('eAwb').value.trim()}` : ''}` : '',
      'You can also track it under My enquiries & orders on art.pranixtechno.com'].filter(Boolean).join('\n');
    $('waLinks').innerHTML = `<a href="https://wa.me/${digits}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send update on WhatsApp</a>`;
  };
  waLink();
  { const stale = () => { const st = $('eStatus').value; const bad = !['RECEIVED', 'PRICE_SENT'].includes(st) && /pay (with|securely|now|using)|link below|payment link|to confirm your order/i.test($('eMsg').value);
      let w = $('msgStale'); if (!w) { $('eMsg').insertAdjacentHTML('afterend', '<div class="err" id="msgStale" style="font-size:12px" hidden>This message asks the customer to pay, but the order is already paid: clear it or write a new one.</div>'); w = $('msgStale'); } w.hidden = !bad; };
    ['eMsg', 'eStatus'].forEach((id) => { $(id).addEventListener('input', stale); $(id).addEventListener('change', stale); }); stale(); }
  if ($('addrBox')) wireRegion($('addrBox'));
  if ($('reviewBox')) wireReviews($('reviewBox'));
  ['ePhone', 'ePrice', 'eLink', 'eMsg', 'eCourier', 'eAwb'].forEach((id) => $(id).addEventListener('input', waLink));
  $('eStatus').addEventListener('change', () => { $('shipBox').hidden = !SHIP_STATUSES.includes($('eStatus').value); waLink(); doneLock(); });
  // Fields open and close with the stage:
  //   payment (paid by, reference, link): open until the payment is recorded
  //   delivery address: open until Shipped (then it's on the courier's label)
  //   everything: read-only once Delivered / Refunded / Cancelled (choose Replacement or Refunded to reopen)
  // Always open: the status, the message to the customer, actual costs (bills come later) and after-sales.
  const doneLock = () => {
    const t = $('eStatus').value, same = t === s;
    const closed = ['DELIVERED', 'REFUNDED', 'CANCELLED'].includes(s) && same;
    const groups = [
      [closed, '#ePhone, #ePrice, #shipBox input, #shipBox select, #shipBox textarea, #costing input, #costing select, #costing textarea, #costing button, #supplierBox input, #supplierBox select, #supplierBox textarea, #supplierBox button'],
      [closed || locked, '#ePayMethod, #ePayRef, #eLink'],
      [closed || (s === 'SHIPPED' && same), '#addrBox input, #addrBox select, #addrBox textarea, #addrBox button'],
    ];
    const lockSet = new Set(), all = new Set();
    for (const [on, sel] of groups) $('detail').querySelectorAll(sel).forEach((el) => { all.add(el); if (on) lockSet.add(el); });
    // Documents stay usable on a closed order: the airway bill label and the proof of delivery.
    [...lockSet].forEach((el) => { if (el.closest('[data-awbbox],[data-podbox]')) lockSet.delete(el); });
    all.forEach((el) => {
      if (lockSet.has(el)) { if (!el.disabled) { el.disabled = true; el.dataset.doneLock = '1'; } }
      else if (el.dataset.doneLock) { el.disabled = false; delete el.dataset.doneLock; }
    });
    let n = $('doneNote');
    const text = closed ? `🔒 ${esc(STATUS[s])}: this order is closed, so its details are read-only. For damage or a return, choose <b>Replacement</b> or <b>Refunded</b> to open them again.`
      : s === 'SHIPPED' && same ? '🔒 Shipped: the delivery address is on the courier\'s label now, so it is read-only.' : '';
    if (text && !n) { n = document.createElement('div'); n.id = 'doneNote'; n.className = 'muted'; n.style.fontSize = '12px'; $('eStatus').closest('.two').after(n); }
    if (n) { if (text) n.innerHTML = text; else n.remove(); }
  };
  doneLock();
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
      const warn = v === 'CANCEL_FULL' && e.artistStartedAt ? `${artistOf(e)} marked this as started on ${day(e.artistStartedAt)}: policy is the 50% refund. Continue only if you agreed otherwise.`
        : v === 'CANCEL_HALF' && e.zohoPOId && !e.artistStartedAt ? `${artistOf(e)} hasn't marked this as started: policy is a full refund. Continue only if they told you they started.` : '';
      $('aWarn').textContent = warn; $('aWarn').hidden = !warn;
    });
  }
  if ($('cArtist')) {
    $('cArtist').addEventListener('change', () => {
      const o = $('cArtist').selectedOptions[0];
      curAed = !!$('cArtist').value && (o.dataset.country || 'UAE') !== 'India';
      $('cInrLabel').textContent = `Artist price (${curAed ? '⃃' : '₹'})`;
      $('cInr').value = '';
      $('cArtistNote').textContent = $('cArtist').value ? `Save to allocate to ${o.dataset.name}: they get an email and see it under Orders to make in their portal (price in ${curAed ? '⃃' : '₹'}).` : 'Siva sees it on his Artist desk.';
      renderCost();
    });
  }
  if ($('costOut')) {
    renderCost();
    ['cInr', 'cTier', 'cDel', 'cFr', 'cIc', 'cLc', 'ePrice', 'eDiscT', 'eDiscV'].forEach((id) => { $(id)?.addEventListener('input', renderCost); $(id)?.addEventListener('change', renderCost); });
    if ($('cDestBox')) {
      wireRegion($('cDestBox'));
      const destNote = () => {
        const out = $('cDel').value === 'OUTSIDE';
        $('cDestBox').hidden = !out; $('cDestNote').hidden = !out;
        if (out) { const d = destOf(e); const z = d.country === 'UAE' ? 'A' : zoneOf(d.country); $('cDestNote').textContent = `Courier price from ${d.from === 'India' ? 'India' : 'Dubai'} to ${[d.region, d.country].filter(Boolean).join(', ')}: ${d.country === 'UAE' && d.from === 'India' ? "the delivery partner's price to that emirate." : `the delivery partner's price for that region or country if they have one, else their ${ZONE_NAME[z]} zone rate (zone ${z}). No UAE VAT on exports.`}`; }
      };
      $('cDel').addEventListener('change', destNote);
      ['change', 'input'].forEach((k) => $('cDestBox').addEventListener(k, () => { destNote(); renderCost(); }));
      destNote();
    }
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
  wireReview(e);
  if ($('rqRedo')) {
    $('rqRedo').onclick = async (ev) => {
      const b = ev.currentTarget; b.disabled = true; $('rqRedoOk').textContent = 'Saving…';
      try {
        const set = { id: e.id, cancelState: 'REOPENED', cancelReopenAt: new Date().toISOString(), cancelReply: $('rqRedoMsg').value.trim() || null };
        const { data, errors } = await client.models.Enquiry.update(set);
        if (errors?.length) throw new Error(errors[0].message);
        Object.assign(e, data || set);
        render(); showDetail(e);
      } catch (ex) { $('rqRedoOk').textContent = ex.message || 'Could not save.'; b.disabled = false; }
    };
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
    const b = $('eSave'); b.disabled = true; $('saveMsg').textContent = '';
    $('detail').querySelectorAll('.err').forEach((x) => x.remove());
    const priceVal = finalPriceStr();
    const disc = readDiscount();
    { const a = e.__autoNext?.(); if (a) $('eStatus').value = a; }
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
        : isOn('tsSent') && (!v('tsCourier') || !v('tsAwb')) ? 'Enter the courier and AWB for the parcel to the artist.'
        : isOn('tsSent') && !isOn('rtRecv') && $('rtMode').value !== 'NONE' ? 'Tick “Received at the frame shop” before sending it to the artist.'
        : isOn('rwReady') && !$('rwReady').disabled && ['PICKUP', 'DROP'].includes($('rtMode').value) && !isOn('rtRecv') ? 'The damaged piece hasn\'t been received at the frame shop yet.'
        : isOn('rwReady') && !$('rwReady').disabled && t.startsWith('SIVA') && !isOn('rwBack') ? 'The artist\'s piece isn\'t back at the frame shop yet: tick that first.'
        : isOn('rwBack') && !$('rwBack').disabled && e.reworkStage !== 'SENT' ? 'The artist hasn\'t marked the rework as sent to the frame shop yet.' : '';
      if (why) { $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${why}</div>`); b.disabled = false; return; }
    }
    if ($('rwType') && !$('rwType').disabled && !$('rwType').value && s === 'REPLACEMENT' && $('rwReady')?.checked) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', '<div class="err">Choose the fix (frame shop or the artist) in the Replacement box.</div>');
      b.disabled = false; return;
    }
    const blockWhy = statusBlock(e, $('eStatus').value, s);
    if (blockWhy) {
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">${blockWhy === 'not for crafts' ? 'Crafts shop orders skip “Being framed”.' : blockWhy.startsWith('waiting for') ? `${esc(artistOf(e))} hasn't marked this work “Sent to frame shop” yet. Update it in ${artistPage(e)} first (you can do it for them).` : 'Mark it Shipped before Delivered.'}</div>`);
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
      if ($('cNote') && $('cNote').value.trim() !== (costings.get(e.id)?.studioNote || '')) {
        const note = $('cNote').value.trim(), cur = costings.get(e.id);
        const rec = { enquiryId: e.id, studioNote: note || null, studioNoteAt: new Date().toISOString() };
        const res = cur ? await client.models.Costing.update(rec) : await client.models.Costing.create(rec);
        if (res.errors?.length) throw new Error(res.errors[0].message);
        costings.set(e.id, res.data || { ...cur, ...rec });
        if (note) client.mutations.marketAdmin({ action: 'artistNoteMail', data: JSON.stringify({ id: e.id }) }).catch(() => {}); // emailed to the artist too
      }
      if (rw) await saveRework(e, rw);
      // A voucher / offer code on the order: the Price box is the price before the code. A new price → the same code
      // is worked out again on it (server), and the customer pays what that gives.
      let priceOut = priceVal, codeMsg = '';
      if (e.discountCode && !e.discountType && e.listPrice != null && !priceLocked(e)) {
        const nl = Number(priceVal);
        if (priceVal !== '' && nl > 0 && nl !== Number(e.listPrice)) {
          const r = await client.mutations.applyCode({ id: e.id, code: e.discountCode, price: nl });
          if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
          const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
          priceOut = String(out.price); vchCache = null;
          codeMsg = out.removed ? ` Code ${out.removed} no longer applies (${out.why || 'not valid'}): customer pays ⃃ ${out.price}.` : ` Code ${e.discountCode} worked out again: ⃃ ${nl.toLocaleString('en-US')} − ⃃ ${Number(out.discount).toLocaleString('en-US')} = ⃃ ${Number(out.price).toLocaleString('en-US')}.`;
        } else priceOut = e.quotedPrice == null ? '' : String(e.quotedPrice);
      }
      const prevMsg = e.adminMessage || '', newSt = $('eStatus').value;
      const { data, errors } = await client.models.Enquiry.update({
        ...(costingChanged ? { costingAt: savedAt } : {}),
        ...(invNo ? { artistInvoiceNo: invNo } : {}), // never cleared here: the artist may have sent it from their portal meanwhile
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
        ...(priceLocked(e) ? {} : { quotedPrice: priceOut === '' ? null : Number(priceOut), ...disc }),
        paymentLink: $('eLink').value.trim() || null,
        // A message left from an earlier step (unchanged while the status moves on) is cleared, so the customer
        // doesn't keep seeing e.g. "pay with the link" after paying.
        adminMessage: (newSt !== s && $('eMsg').value.trim() === prevMsg.trim()) ? null : $('eMsg').value.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(e, data || {});
      $('saveMsg').textContent = newSt === 'PAID' && s !== 'PAID' && !locked ? 'Saved as Paid. Waiting for Zoho to create the invoice and record the payment…' : 'Saved. The customer sees this under My enquiries & orders.';
      $('saveMsg').insertAdjacentText('beforeend', codeMsg + ' ' + await mailNote(e, s, newSt, prevMsg));
      render();
      // Zoho may answer (invoice, challan, Siva's order…): watch for it and refresh the details.
      void toZoho;
      // Rework / return steps don't go through Zoho: redraw now so the ticks and the timeline show what was saved.
      if (rw || $('eStatus').value !== s) { const msg = $('saveMsg').textContent; await showDetail(e); if ($('saveMsg')) $('saveMsg').textContent = msg; }
      waitForZoho(e.id, savedAt);
    } catch (ex) {
      $('saveMsg').textContent = '';
      if (sessionGone(ex)) return;
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

start();


// The old drag-to-resize width is no longer used: forget it.
try { localStorage.removeItem('kalaiDeskW'); } catch { /* storage blocked */ }

// Proof of delivery files (signature, photos) from the delivery partner: open on demand (short-lived link).
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest?.('[data-podkey]'); if (!b) return;
  try { const { url } = await getUrl({ path: b.dataset.podkey, options: { expiresIn: 600 } }); window.open(url.toString(), '_blank', 'noopener'); } catch (ex) { b.textContent = ex.message; }
});

/* Settings sub-tabs: Website settings | Number series. */
function stTab(t) {
  document.querySelectorAll('#stTabs [data-st]').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.st === t)); b.onclick = () => stTab(b.dataset.st); });
  $('stSite').hidden = t === 'numbers'; $('nsBox').hidden = t !== 'numbers';
  try { localStorage.setItem('kalai-st-tab', t); } catch { /* */ }
  if (t === 'numbers') showNumbers(); else { showSettingTab(t); showSettings().then(() => showSettingTab(t)); }
}

/* ---------- Variants: saved selections of orders (VARNT1001, VARNT1002 …), shared by everyone in Order Management ---------- */
// Stored in Rates (key "variants"): { next, list: [{ id, name, refs: [KA-…], at, by }] }.
let variants = { next: 1001, list: [] }, varSaved = false, varPicking = false;
const varPick = new Set();
let varEditing = null;
const variantOn = () => variants.list.find((v) => v.id === $('fVar').value) || null;
// Variant numbers follow Settings → Number series (default VARNT + 4 digits: VARNT1001).
async function varId(n) {
  let pre = 'VARNT', dg = 4;
  try { const { data } = await client.models.Rates.get({ key: 'numberSeries' }); let d = data?.data; for (let i = 0; i < 2 && typeof d === 'string'; i++) d = JSON.parse(d); const v = d?.docs?.varnt; if (v) { pre = v.mode === 'numeric' ? '' : (v.prefix ?? pre); dg = Number(v.digits) || dg; } } catch { /* defaults */ }
  return `${pre}${String(n).padStart(dg, '0')}`;
}
async function varLoad() {
  try {
    const { data } = await client.models.Rates.get({ key: 'variants' });
    let d = data?.data; for (let i = 0; i < 2 && typeof d === 'string'; i++) d = JSON.parse(d);
    if (d && Array.isArray(d.list)) { variants = { next: Number(d.next) || 1001, list: d.list }; varSaved = true; } else varSaved = !!data;
  } catch { /* none yet */ }
  varSelect();
}
function varSelect() {
  const cur = $('fVar').value || (() => { try { return localStorage.getItem('kalai-variant') || ''; } catch { return ''; } })();
  $('fVar').innerHTML = `<option value="">No variant</option>${variants.list.map((v) => `<option value="${esc(v.id)}">${esc(v.id)} · ${esc(v.name || '')} (${v.refs.length})</option>`).join('')}`;
  $('fVar').value = variants.list.some((v) => v.id === cur) ? cur : '';
}
async function varSave() {
  const rec = { key: 'variants', data: JSON.stringify(variants) };
  let r = varSaved ? await client.models.Rates.update(rec) : await client.models.Rates.create(rec);
  if (r.errors?.length && !varSaved) r = await client.models.Rates.update(rec);
  if (r.errors?.length) throw new Error(r.errors[0].message);
  varSaved = true;
}
function varFill() { const t = $('varRefs'); if (t) t.value = [...varPick].join('\n'); const c = $('varCount'); if (c) c.textContent = `${varPick.size} order${varPick.size === 1 ? '' : 's'}`; }
function varOpen(v) {
  varEditing = v || null; varPick.clear(); (v?.refs || []).forEach((r) => varPick.add(r)); varPicking = true;
  const box = $('varBox'); box.hidden = false;
  box.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:16px">${v ? `Change variant ${esc(v.id)}` : 'New variant'}</b><span class="muted" style="font-size:13px">Tick orders in the list below, or type / paste order numbers. Saved variants show only their orders (any date).</span></div>
    <div style="display:grid;grid-template-columns:minmax(200px,1fr) minmax(260px,2fr);gap:10px">
      <div class="field" style="margin:0"><label for="varName">Variant name</label><input id="varName" maxlength="60" placeholder="e.g. Anis basket, Diwali framing batch" value="${esc(v?.name || '')}"></div>
      <div class="field" style="margin:0"><label for="varRefs">Orders (<span id="varCount"></span>)</label><textarea id="varRefs" rows="3" placeholder="KA-261025-Q3X0&#10;KA-261025-2INX"></textarea></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button type="button" class="btn small" id="varSaveBtn">${v ? 'Save changes' : 'Save as new variant'}</button><button type="button" class="btn small ghost" id="varShown">Add all orders shown now</button>
      ${v ? '<button type="button" class="btn small ghost" id="varDel">Delete variant</button>' : ''}<button type="button" class="btn small ghost" id="varClose">Close</button>
      ${variants.list.length && !v ? `<span class="muted" style="font-size:13px">or change: ${variants.list.map((x) => `<button type="button" class="linkbtn" data-vedit="${esc(x.id)}">${esc(x.id)}</button>`).join(' ')}</span>` : ''}<span class="muted" id="varMsg" style="font-size:13px"></span></div>`;
  varFill(); render();
  $('varRefs').oninput = () => { varPick.clear(); $('varRefs').value.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^KA-/.test(x)).forEach((x) => varPick.add(x)); $('varCount').textContent = `${varPick.size} order${varPick.size === 1 ? '' : 's'}`; render(); };
  $('varShown').onclick = () => { [...document.querySelectorAll('#rows [data-vpick]')].forEach((cb) => varPick.add(cb.dataset.vpick)); varFill(); render(); };
  $('varClose').onclick = () => { varPicking = false; box.hidden = true; render(); };
  box.querySelectorAll('[data-vedit]').forEach((b) => { b.onclick = () => varOpen(variants.list.find((x) => x.id === b.dataset.vedit)); });
  $('varDel')?.addEventListener('click', async () => {
    if (!confirm(`Delete variant ${v.id}? The orders themselves stay as they are.`)) return;
    variants.list = variants.list.filter((x) => x.id !== v.id);
    try { await varSave(); if ($('fVar').value === v.id) $('fVar').value = ''; varSelect(); varPicking = false; box.hidden = true; render(); } catch (ex) { $('varMsg').textContent = ex.message; }
  });
  $('varSaveBtn').onclick = async () => {
    const name = $('varName').value.trim(), refs = [...varPick];
    if (!refs.length) { $('varMsg').textContent = 'Tick at least one order.'; return; }
    const unknown = refs.filter((r) => !all.some((e) => e.ref === r));
    if (unknown.length && !confirm(`${unknown.join(', ')} not found among the loaded orders. Save anyway?`)) return;
    const by = $('who')?.textContent || '';
    let id;
    if (v) { Object.assign(v, { name, refs, at: new Date().toISOString() }); id = v.id; }
    else { id = await varId(variants.next); variants.next += 1; variants.list.push({ id, name, refs, at: new Date().toISOString(), by }); }
    $('varMsg').textContent = 'Saving…';
    try { await varSave(); varSelect(); $('fVar').value = id; try { localStorage.setItem('kalai-variant', id); } catch { /* */ } varPicking = false; box.hidden = true; render(); }
    catch (ex) { if (!v) variants.next -= 1, variants.list.pop(); $('varMsg').textContent = ex.message; }
  };
}
$('varBtn').onclick = () => { const v = variantOn(); if (!$('varBox').hidden) { varPicking = false; $('varBox').hidden = true; render(); return; } varOpen(v); };
$('fVar').onchange = () => { try { localStorage.setItem('kalai-variant', $('fVar').value); } catch { /* */ } render(); };

// Section icons on the order screen (and the document flow), kept when cards are redrawn.
watchIcons('desk');
