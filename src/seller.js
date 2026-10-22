// Seller portal: sign up, apply, and (once approved) list products with a price calculator.
// Kalai collects the money from the customer and pays the seller; Kalai's commission is added on top of the seller's price.
import './amplify-config.js';
import {
  signIn, signUp, confirmSignUp, resendSignUpCode, autoSignIn, signOut, getCurrentUser,
  fetchUserAttributes, resetPassword, confirmResetPassword,
} from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl, remove } from 'aws-amplify/storage';
import { autoPhones, countryRegionHtml, wireRegion } from './phone.js';

autoPhones();
// Artists arrive from "Become an artist" on the website (seller.html?as=artist); after applying, their profile type decides.
const wantArtist = new URLSearchParams(location.search).get('as') === 'artist';
const MEDIUMS = ['Watercolour', 'Pencil / charcoal', 'Acrylic', 'Oil', 'Ink / pen', 'Digital', 'Mixed media', 'Sculpture / craft'];
const isArtist = () => (profile?.type ? profile.type === 'ARTIST' : document.querySelector('input[name="pType"]:checked')?.value === 'ARTIST');
function brand() {
  const art = profile ? profile.type === 'ARTIST' : wantArtist;
  $('brand').textContent = art ? 'KALAI · Artist portal' : 'KALAI · Seller portal';
  document.title = art ? 'Kalai Artist Portal' : 'Kalai Seller Portal';
  if (art) {
    $('lTitle').textContent = 'Become a Kalai artist';
    $('lNote').textContent = 'Show us your work. Create an account, tell us about your art and upload a few sample pieces. Once approved, you list your originals here; we sell them on our website, collect the payment, deliver in the UAE and India, and pay you.';
  }
}


const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (n) => 'AED ' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const r2 = (n) => Math.round(n * 100) / 100;
const STATUS = { DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', APPROVED: 'Live on the website', REJECTED: 'Changes needed', PAUSED: 'Paused' };

let profile = null;
let listings = [];
let mode = 'in'; // in | up | code | reset
const urls = new Map();

// Same formula as the server (priceOf in the Lambda); the server's figure is the one that counts.
export function priceOf(l, pct, fee) {
  const cost = Number(l.costPrice) || 0;
  const markup = r2(cost * (Number(l.markupPct) || 0) / 100);
  const courier = l.deliveryBy === 'SELLER' ? Number(l.courierCharge) || 0 : 0;
  const sellerPrice = r2(cost + markup + courier + (Number(l.otherCharges) || 0));
  const commission = r2(sellerPrice * (Number(pct) || 0) / 100);
  const delivery = l.deliveryBy === 'KALAI' ? Number(fee) || 0 : 0;
  return { markup, courier, sellerPrice, commission, delivery, customerPrice: Math.ceil(sellerPrice + commission + delivery) };
}

async function call(action, data) {
  const r = await client.mutations.sellerAction({ action, data: data ? JSON.stringify(data) : undefined });
  if (r.errors?.length) throw new Error(r.errors[0].message.replace(/^.*?Error: /, ''));
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}

function show(view) {
  ['loginView', 'applyView', 'statusView', 'deskView'].forEach((v) => { $(v).hidden = v !== view; });
  $('signOutBtn').hidden = view === 'loginView';
}

async function start() {
  brand();
  try { await getCurrentUser(); } catch { show('loginView'); setMode('in'); return; }
  const attrs = await fetchUserAttributes().catch(() => ({}));
  $('who').textContent = attrs.email || '';
  try {
    const r = await call('me');
    profile = r.profile; listings = r.listings || [];
  } catch (ex) {
    if (/No current user|Unauthorized|not authorized/i.test(ex.message)) { show('loginView'); setMode('in'); return; }
    show('statusView'); $('statusBox').innerHTML = `<p class="err">Could not load your account: ${esc(ex.message)}</p>`; return;
  }
  route();
}

function route() {
  brand();
  const s = profile?.status;
  if (!profile || s === 'REJECTED') {
    show('applyView');
    fillApply();
    $('applyTitle').textContent = s === 'REJECTED' ? 'Apply again' : isArtist() ? 'Artist application' : 'Seller application';
    $('applyNote').innerHTML = s === 'REJECTED'
      ? `Your earlier application was not accepted.${profile.adminNote ? ` <b>Our note:</b> ${esc(profile.adminNote)}` : ''} You can update it and send it again.`
      : isArtist() ? 'Tell us about yourself and your art, and show us some of your work. We review every artist before they can list artworks.' : 'Tell us about your business. We check every seller before they can list products.';
    return;
  }
  if (s === 'APPLIED') {
    show('statusView');
    $('statusBox').innerHTML = `<h2>Application received</h2><p>Thank you, ${esc(profile.contactName)}. ${profile.type === 'ARTIST' ? `We are looking at your work and will email you, usually within a few days. Once you are approved you can list your artworks here.` : `We are checking <b>${esc(profile.business)}</b> and will email you when your account is approved. Then you can add your products here.`}</p><p><button class="linkbtn" id="editApp" type="button">Edit my application</button></p>`;
    $('editApp').onclick = () => { show('applyView'); fillApply(); $('applyTitle').textContent = 'Edit my application'; };
    return;
  }
  if (s === 'SUSPENDED') {
    show('statusView');
    $('statusBox').innerHTML = `<h2>Your seller account is paused</h2><p>Your listings are not shown on the website at the moment.${profile.adminNote ? ` <b>Our note:</b> ${esc(profile.adminNote)}` : ''}</p><p class="muted">Please contact Kalai Art House on WhatsApp or email if you have questions.</p>`;
    return;
  }
  show('deskView');
  pane(location.hash === '#orders' ? 'orders' : 'products');
  $('dBiz').textContent = profile.business;
  $('dPhoto').hidden = !profile.photoKey;
  if (profile.photoKey) imgUrl(profile.photoKey).then((u) => { $('dPhoto').src = u; });
  $('tabProducts').textContent = profile.type === 'ARTIST' ? 'My artworks' : 'My products';
  $('dTerms').innerHTML = `Kalai commission: <b>${profile.commissionPct ?? 0}%</b> added on top of your price${Number(profile.kalaiDeliveryFee) ? ` · Kalai delivery: <b>${aed(profile.kalaiDeliveryFee)}</b> per order when Kalai delivers` : ''}. Kalai collects the payment from the customer and pays you your price.`;
  drawList();
}

// ---------- sign in / sign up ----------
function setMode(m) {
  mode = m;
  $('tSignIn').setAttribute('aria-pressed', String(m === 'in' || m === 'reset'));
  $('tSignUp').setAttribute('aria-pressed', String(m === 'up' || m === 'code'));
  $('aCodeBox').hidden = !(m === 'code' || m === 'reset');
  $('aPass').closest('.field').querySelector('label').textContent = m === 'reset' ? 'New password' : 'Password';
  $('aPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
  $('aBtn').textContent = { in: 'Sign in', up: 'Create account', code: 'Confirm', reset: 'Set new password' }[m];
  $('aForgot').hidden = m !== 'in';
  $('aErr').textContent = '';
}
$('tSignIn').onclick = () => setMode('in');
$('tSignUp').onclick = () => setMode('up');
$('aForgot').onclick = async () => {
  const email = $('aEmail').value.trim().toLowerCase();
  if (!email) { $('aErr').textContent = 'Type your email first.'; return; }
  try { await resetPassword({ username: email }); setMode('reset'); $('aErr').textContent = 'We emailed you a code. Enter it with a new password.'; } catch (ex) { $('aErr').textContent = ex.message; }
};
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('aEmail').value.trim().toLowerCase(), password = $('aPass').value, code = $('aCode').value.trim();
  const b = $('aBtn'); b.disabled = true; $('aErr').textContent = '';
  try {
    if (!email) throw new Error('Type your email.');
    if (mode === 'in') {
      const { nextStep } = await signIn({ username: email, password });
      if (nextStep.signInStep === 'CONFIRM_SIGN_UP') { await resendSignUpCode({ username: email }); setMode('code'); $('aErr').textContent = 'Confirm your email: we sent you a code.'; return; }
      if (nextStep.signInStep !== 'DONE') throw new Error('Finish setting up this account first.');
      await start();
    } else if (mode === 'up') {
      if (password.length < 8) throw new Error('Use at least 8 characters for the password.');
      await signUp({ username: email, password, options: { userAttributes: { email }, autoSignIn: true } });
      setMode('code'); $('aErr').textContent = 'We emailed you a code. Enter it to confirm.';
    } else if (mode === 'code') {
      const { nextStep } = await confirmSignUp({ username: email, confirmationCode: code });
      if (nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') await autoSignIn();
      else await signIn({ username: email, password });
      await start();
    } else {
      await confirmResetPassword({ username: email, confirmationCode: code, newPassword: password });
      await signIn({ username: email, password });
      await start();
    }
  } catch (ex) {
    $('aErr').textContent = ex.name === 'NotAuthorizedException' || ex.name === 'UserNotFoundException' ? 'Email or password is incorrect.'
      : ex.name === 'UsernameExistsException' ? 'This email already has an account: sign in instead.' : (ex.message || 'Something went wrong.');
  } finally { b.disabled = false; }
});
$('signOutBtn').onclick = async () => { await signOut(); $('who').textContent = ''; profile = null; show('loginView'); setMode('in'); };

// ---------- application (artists and sellers) ----------
const AF = { pBiz: 'business', pName: 'contactName', pPhone: 'phone', pLic: 'tradeLicence', pCat: 'categories', pAddr: 'address', pAbout: 'about', pBank: 'bankName', pAcc: 'accountName', pIban: 'iban', pAccNo: 'accountNumber', pIfsc: 'ifsc', pExp: 'experience', pComm: 'commissions', pLink: 'portfolio' };
let samples = [];
let photoKey = '';
async function drawPhoto() {
  $('pPhotoImg').hidden = !photoKey; $('pPhotoDel').hidden = !photoKey;
  if (photoKey) $('pPhotoImg').src = await imgUrl(photoKey);
}
$('pPhotoFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { $('pErr').textContent = `${f.name} is larger than 10 MB.`; return; }
  $('pErr').textContent = 'Uploading…';
  try {
    const name = `${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
    const r = await uploadData({ path: ({ identityId }) => `market/${identityId}/profile/${name}`, data: f, options: { contentType: f.type } }).result;
    photoKey = r.path; $('pErr').textContent = '';
  } catch (ex) { $('pErr').textContent = 'Upload failed: ' + (ex.message || ex); }
  e.target.value = '';
  drawPhoto();
};
$('pPhotoDel').onclick = () => { photoKey = ''; drawPhoto(); };
const sampleKeys = (p) => { try { return JSON.parse(p?.sampleKeys || '[]'); } catch { return []; } };
function applyKind() {
  const art = isArtist();
  document.querySelectorAll('#applyForm [data-l-artist]').forEach((l) => { l.textContent = art ? l.dataset.lArtist : l.dataset.lSeller; });
  document.querySelectorAll('#applyForm [data-artist-only]').forEach((x) => { x.hidden = !art; });
  document.querySelectorAll('#applyForm [data-seller-only]').forEach((x) => { x.hidden = art; });
  if (!profile || profile.status === 'REJECTED') $('applyTitle').textContent = profile?.status === 'REJECTED' ? 'Apply again' : art ? 'Artist application' : 'Seller application';
  $('pBtn').textContent = profile && profile.status !== 'REJECTED' ? 'Save' : 'Send application';
}
function bankKind() {
  const india = $('pCountry').value === 'India';
  $('pIbanBox').hidden = india; $('pInBank').hidden = !india;
}
function fillApply() {
  $('pWhere').innerHTML = countryRegionHtml({ country: profile?.country || 'UAE', region: profile?.emirate, prefix: 'p', names: false }).replace(/<div class="field" data-pin-box[\s\S]*$/, '');
  wireRegion($('pWhere'));
  $('pCountry').addEventListener('change', bankKind);
  for (const [id, k] of Object.entries(AF)) $(id).value = profile?.[k] ?? (id === 'pComm' ? 'YES' : '');
  const typeNow = profile?.type || (wantArtist ? 'ARTIST' : 'SELLER');
  document.querySelectorAll('input[name="pType"]').forEach((r) => { r.checked = r.value === typeNow; r.onchange = applyKind; });
  $('pTypeBox').hidden = !!profile?.type && profile.status !== 'REJECTED';
  const chosen = String(profile?.mediums || '').split(',').map((x) => x.trim());
  $('pMediums').innerHTML = MEDIUMS.map((m) => `<label><input type="checkbox" value="${esc(m)}" ${chosen.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('');
  samples = sampleKeys(profile);
  drawSamples();
  photoKey = profile?.photoKey || '';
  drawPhoto();
  bankKind(); applyKind();
}
async function drawSamples() {
  $('pSamples').innerHTML = samples.map((k, i) => `<figure data-i="${i}"><img alt="Sample ${i + 1}"><button type="button" aria-label="Remove photo">×</button></figure>`).join('') || '<span class="muted" style="font-size:12px">No samples yet.</span>';
  $('pSamples').querySelectorAll('figure').forEach(async (f) => {
    const k = samples[Number(f.dataset.i)];
    f.querySelector('img').src = await imgUrl(k);
    f.querySelector('button').onclick = () => { samples = samples.filter((x) => x !== k); drawSamples(); };
  });
}
$('pSampleFiles').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 8 - samples.length);
  if (!files.length) { $('pErr').textContent = 'Up to 8 sample photos.'; return; }
  $('pErr').textContent = 'Uploading…';
  try {
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name} is larger than 10 MB.`);
      const name = `${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
      const r = await uploadData({ path: ({ identityId }) => `market/${identityId}/samples/${name}`, data: f, options: { contentType: f.type } }).result;
      samples.push(r.path);
    }
    $('pErr').textContent = '';
  } catch (ex) { $('pErr').textContent = 'Upload failed: ' + (ex.message || ex); }
  e.target.value = '';
  drawSamples();
};
$('applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {}; for (const [id, k] of Object.entries(AF)) data[k] = $(id).value.trim();
  data.type = isArtist() ? 'ARTIST' : 'SELLER';
  data.country = $('pCountry').value; data.emirate = $('pRegion').value;
  data.sampleKeys = JSON.stringify(samples);
  data.photoKey = photoKey;
  if (data.type === 'SELLER' && !samples.length) { $('pErr').textContent = 'Upload at least 1 photo of your products.'; return; }
  if (data.type === 'ARTIST') {
    data.mediums = [...$('pMediums').querySelectorAll('input:checked')].map((x) => x.value).join(', ');
    if (!data.mediums) { $('pErr').textContent = 'Tick the mediums you work in.'; return; }
    if (samples.length < 3) { $('pErr').textContent = 'Upload at least 3 photos of your work.'; return; }
  }
  const b = $('pBtn'); b.disabled = true; $('pErr').textContent = '';
  try { const r = await call('apply', data); profile = r.profile; route(); window.scrollTo(0, 0); } catch (ex) { $('pErr').textContent = ex.message; } finally { b.disabled = false; }
});
$('dProfile').onclick = () => {
  show('applyView'); fillApply(); $('applyTitle').textContent = 'My details';
  $('applyNote').innerHTML = `Update your contact, photos, address or bank details. <button class="linkbtn" type="button" id="backDesk">Back to my listings</button>`;
  $('backDesk').onclick = () => route();
};

// ---------- listings ----------
async function imgUrl(key) {
  if (!key) return '';
  if (!urls.has(key)) urls.set(key, getUrl({ path: key, options: { expiresIn: 3600 } }).then((r) => r.url.toString()).catch(() => ''));
  return urls.get(key);
}
const keysOf = (l) => { try { return JSON.parse(l.imageKeys || '[]'); } catch { return []; } };

async function drawList() {
  if (!listings.length) { $('lList').innerHTML = `<p class="muted">No ${profile?.type === 'ARTIST' ? 'artworks' : 'products'} yet. Click <b>New listing</b> to add your first one.</p>`; return; }
  listings.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  $('lList').innerHTML = listings.map((l) => `<article class="lrow" data-id="${esc(l.id)}">
    <img alt="" data-key="${esc(keysOf(l)[0] || '')}">
    <div><h3>${esc(l.title)}</h3>
      <div style="font-size:12px;margin:3px 0"><span class="st ${esc(l.status)}">${STATUS[l.status] || esc(l.status)}</span> · stock ${Number(l.stock ?? 0)}</div>
      <div class="muted" style="font-size:12px">You receive <b>${aed(l.sellerPrice)}</b> · customer pays <b>${aed(l.customerPrice)}</b> · ${l.deliveryBy === 'KALAI' ? 'Kalai collects and delivers' : 'You deliver'}</div>
      ${l.adminNote && ['REJECTED', 'PAUSED'].includes(l.status) ? `<div class="err" style="font-size:12px">Kalai: ${esc(l.adminNote)}</div>` : ''}</div>
    <div style="display:flex;flex-direction:column;gap:4px">
      <button class="btn small ghost" data-act="edit" type="button">Edit</button>
      ${['DRAFT', 'REJECTED'].includes(l.status) ? '<button class="btn small" data-act="submitListing" type="button">Submit</button>' : ''}
      ${l.status === 'APPROVED' ? '<button class="btn small ghost" data-act="pauseListing" type="button">Pause</button>' : ''}
      ${l.status === 'PAUSED' && !l.adminNote ? '<button class="btn small ghost" data-act="resumeListing" type="button">Resume</button>' : ''}
    </div></article>`).join('');
  document.querySelectorAll('.lrow img[data-key]').forEach(async (img) => { const u = await imgUrl(img.dataset.key); if (u) img.src = u; });
  document.querySelectorAll('.lrow [data-act]').forEach((b) => {
    const l = listings.find((x) => x.id === b.closest('.lrow').dataset.id);
    b.onclick = async () => {
      if (b.dataset.act === 'edit') { edit(l); return; }
      b.disabled = true;
      try { const r = await call(b.dataset.act, { id: l.id }); Object.assign(l, r.listing); drawList(); } catch (ex) { alertRow(b, ex.message); b.disabled = false; }
    };
  });
}
function alertRow(b, msg) { const p = document.createElement('div'); p.className = 'err'; p.style.fontSize = '12px'; p.textContent = msg; b.parentElement.appendChild(p); }

$('dNew').onclick = () => edit(null);

// ---------- orders (paid orders only; the customer's address is shown only when you deliver) ----------
let orders = [];
const OST = { PAID: 'To send', SHIPPED: 'Dispatched', DELIVERED: 'Delivered', REFUNDED: 'Refunded', REPLACEMENT: 'Replacement' };
function pane(p) {
  $('productsPane').hidden = p !== 'orders' ? false : true;
  $('ordersPane').hidden = p !== 'orders';
  $('tabProducts').setAttribute('aria-pressed', String(p !== 'orders'));
  $('tabOrders').setAttribute('aria-pressed', String(p === 'orders'));
  try { history.replaceState(null, '', p === 'orders' ? '#orders' : location.pathname); } catch { /* ignore */ }
  if (p === 'orders') loadOrders();
}
$('tabProducts').onclick = () => pane('products');
$('tabOrders').onclick = () => pane('orders');
const dd = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
async function loadOrders() {
  $('oList').innerHTML = '<p class="muted">Loading…</p>';
  try { orders = (await call('orders')).orders || []; drawOrders(); } catch (ex) { $('oList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; }
}
function orderState(o) {
  if (o.cancelled) return ['Cancelled', 'REJECTED'];
  if (o.onHold) return ['On hold', 'SUBMITTED'];
  if (o.paidRef) return ['Paid to you', 'APPROVED'];
  if (o.status === 'PAID' && o.sellerStage === 'READY') return ['Waiting for Kalai pickup', 'SUBMITTED'];
  return [OST[o.status] || o.status, o.status === 'PAID' ? 'SUBMITTED' : o.status === 'DELIVERED' ? 'APPROVED' : ''];
}
function drawOrders() {
  const open = orders.filter((o) => o.status === 'PAID' && !o.cancelled);
  const owed = orders.filter((o) => o.status === 'DELIVERED' && !o.paidRef && !o.cancelled).reduce((a, o) => a + Number(o.amount || 0), 0);
  const paid = orders.filter((o) => o.paidRef).reduce((a, o) => a + Number(o.amount || 0), 0);
  $('oSum').innerHTML = `${open.length} to send · delivered, payment due to you: <b>${aed(owed)}</b> · paid to you so far: <b>${aed(paid)}</b>`;
  $('tabOrders').textContent = open.length ? `Orders (${open.length})` : 'Orders';
  if (!orders.length) { $('oList').innerHTML = '<p class="muted">No orders yet. Paid orders appear here, and we email you each one.</p>'; return; }
  $('oList').innerHTML = orders.map((o) => {
    const [label, cls] = orderState(o);
    const kalai = o.deliveryBy === 'KALAI';
    const live = !o.cancelled && !o.onHold;
    return `<article class="ocard" data-id="${esc(o.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3>${esc(o.title)} × ${o.qty}</h3><span class="st ${cls}">${esc(label)}</span><span class="muted" style="margin-left:auto;font-family:var(--mono)">${esc(o.ref)} · ${esc(dd(o.createdAt))}</span></div>
      <div>You receive <b>${aed(o.amount)}</b>${o.bill ? ` · bill ${esc(o.bill)}` : ''}${o.paidRef ? ` · paid, ref ${esc(o.paidRef)}` : o.status === 'DELIVERED' ? ' · we pay you after delivery' : ''}</div>
      ${o.cancelled ? '<div class="err">The customer cancelled. Please do not send it; the stock was added back.</div>' : ''}
      ${o.onHold ? '<div class="err">On hold: the customer asked to cancel. Please wait for our email before sending.</div>' : ''}
      ${kalai ? `<div class="to">Kalai collects it from your pickup address and delivers it.${o.readyAt ? ` Marked ready ${esc(dd(o.readyAt))}.` : ''}</div>`
        : o.to ? `<div class="to"><b>Deliver to</b> ${esc(o.to.name)} · <a href="tel:${esc(o.to.phone)}">${esc(o.to.phone)}</a><br>${esc(o.to.line || [o.to.address, o.to.emirate].join(', '))}</div>` : ''}
      ${o.courier ? `<div>Sent with <b>${esc(o.courier)}</b>${o.awb ? ` · tracking ${esc(o.awb)}` : ''}${o.dispatchedAt ? ` · ${esc(dd(o.dispatchedAt))}` : ''}</div>` : ''}
      ${live && o.status === 'PAID' && kalai && o.sellerStage !== 'READY' ? '<div class="acts"><button class="btn small" data-o="orderReady" type="button">Packed: ready for pickup</button><span class="err" data-m></span></div>' : ''}
      ${live && o.status === 'PAID' && !kalai ? '<div class="acts"><label class="field" style="gap:2px"><span style="font-size:11px;font-weight:700">Courier</span><input data-f="courier" list="couriers" placeholder="Aramex / Own delivery"></label><label class="field" style="gap:2px"><span style="font-size:11px;font-weight:700">Tracking no.</span><input data-f="awb"></label><button class="btn small" data-o="orderDispatched" type="button">Mark dispatched</button><span class="err" data-m></span></div>' : ''}
      ${live && o.status === 'SHIPPED' && !kalai ? '<div class="acts"><button class="btn small ghost" data-o="orderDelivered" type="button">The customer has received it</button><span class="err" data-m></span></div>' : ''}
    </article>`;
  }).join('') + '<datalist id="couriers"><option>Aramex</option><option>DHL</option><option>Jeebly</option><option>Quiqup</option><option>Emirates Post</option><option>Own delivery</option></datalist>';
  document.querySelectorAll('#oList [data-o]').forEach((b) => {
    b.onclick = async () => {
      const card = b.closest('.ocard');
      const data = { id: card.dataset.id, courier: card.querySelector('[data-f="courier"]')?.value.trim(), awb: card.querySelector('[data-f="awb"]')?.value.trim() };
      if (b.dataset.o === 'orderDelivered' && !confirm('Confirm the customer has received it?')) return;
      b.disabled = true;
      try { const r = await call(b.dataset.o, data); orders = orders.map((o) => (o.id === r.order.id ? r.order : o)); drawOrders(); }
      catch (ex) { card.querySelector('[data-m]').textContent = ex.message; b.disabled = false; }
    };
  });
}

function edit(l) {
  const x = l || { title: '', description: '', category: profile?.type === 'ARTIST' ? 'Artwork' : '', stock: 1, costPrice: '', markupPct: 20, courierCharge: 0, otherCharges: 0, deliveryBy: 'SELLER' };
  let keys = keysOf(x);
  const pct = Number(l?.commissionPct ?? profile.commissionPct ?? 0), fee = Number(profile.kalaiDeliveryFee ?? 0);
  const box = $('editBox'); box.hidden = false;
  box.innerHTML = `<div class="sbox">
    <h2>${l ? 'Edit listing' : 'New listing'}</h2>
    ${l?.status === 'APPROVED' ? '<p class="muted" style="margin:0;font-size:13px">This product is live. Changing only the stock keeps it live; any other change sends it back to us for approval.</p>' : ''}
    <div class="two"><div class="field"><label for="eTitle">Title</label><input id="eTitle" maxlength="120" value="${esc(x.title)}"></div>
      <div class="two"><div class="field"><label for="eCat">Category</label><input id="eCat" maxlength="60" value="${esc(x.category)}"></div><div class="field"><label for="eStock">Stock</label><input id="eStock" type="number" min="0" step="1" value="${esc(x.stock)}"></div></div></div>
    <div class="field"><label for="eDesc">Description (size, material, care)</label><textarea id="eDesc" rows="3" maxlength="2000">${esc(x.description)}</textarea></div>
    <div class="field"><label>Photos (up to 6; the first is the cover)</label><div class="thumbs" id="eThumbs"></div><input id="eFiles" type="file" accept="image/*" multiple></div>
    <fieldset class="sbox" style="padding:12px"><legend style="font-size:13px;font-weight:700">Price calculator</legend>
      <div class="radio"><span style="font-size:13px;font-weight:700">Who delivers?</span>
        <label><input type="radio" name="eDel" value="SELLER" ${x.deliveryBy !== 'KALAI' ? 'checked' : ''}> I deliver to the customer</label>
        <label><input type="radio" name="eDel" value="KALAI" ${x.deliveryBy === 'KALAI' ? 'checked' : ''}> Kalai collects from me and delivers${fee ? ` (${aed(fee)})` : ''}</label></div>
      <div class="three"><div class="field"><label for="eCost">Cost price (AED)</label><input id="eCost" type="number" min="0" step="0.01" value="${esc(x.costPrice)}"></div>
        <div class="field"><label for="eMark">Your markup %</label><input id="eMark" type="number" min="0" step="0.5" value="${esc(x.markupPct)}"></div>
        <div class="field"><label for="eOther">Other charges (AED)</label><input id="eOther" type="number" min="0" step="0.01" value="${esc(x.otherCharges)}" title="Packing, gift wrap, etc."></div></div>
      <div class="field" id="eCourierBox"><label for="eCourier">Your courier charge (AED)</label><input id="eCourier" type="number" min="0" step="0.01" value="${esc(x.courierCharge)}" style="max-width:200px"></div>
      <table class="calc" id="eCalc"></table>
    </fieldset>
    <div class="err" id="eErr" role="alert"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="eSave" type="button">Save</button>
      ${!l || ['DRAFT', 'REJECTED'].includes(l.status) ? '<button class="btn" id="eSaveSubmit" type="button">Save and submit for approval</button>' : ''}
      <button class="btn ghost" id="eCancel" type="button">Close</button>
      ${l ? '<button class="btn ghost" id="eDelete" type="button" style="margin-left:auto">Delete</button>' : ''}
    </div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const val = () => ({
    id: l?.id, title: $('eTitle').value.trim(), category: $('eCat').value.trim(), stock: $('eStock').value, description: $('eDesc').value.trim(),
    costPrice: $('eCost').value, markupPct: $('eMark').value || 0, courierCharge: $('eCourier').value || 0, otherCharges: $('eOther').value || 0,
    deliveryBy: box.querySelector('input[name="eDel"]:checked').value, imageKeys: JSON.stringify(keys),
  });
  const calc = () => {
    const v = val();
    $('eCourierBox').hidden = v.deliveryBy !== 'SELLER';
    const p = priceOf(v, pct, fee);
    $('eCalc').innerHTML = `
      <tr><td>Cost price</td><td class="n">${aed(v.costPrice)}</td></tr>
      <tr><td>Markup ${Number(v.markupPct) || 0}%</td><td class="n">${aed(p.markup)}</td></tr>
      ${v.deliveryBy === 'SELLER' ? `<tr><td>Your courier</td><td class="n">${aed(p.courier)}</td></tr>` : ''}
      <tr><td>Other charges</td><td class="n">${aed(v.otherCharges)}</td></tr>
      <tr class="t"><td>You receive per sale</td><td class="n">${aed(p.sellerPrice)}</td></tr>
      <tr><td>Kalai commission ${pct}%</td><td class="n">${aed(p.commission)}</td></tr>
      ${v.deliveryBy === 'KALAI' ? `<tr><td>Kalai delivery</td><td class="n">${aed(p.delivery)}</td></tr>` : ''}
      <tr class="t c"><td>Customer pays on the website</td><td class="n">${aed(p.customerPrice)}</td></tr>`;
  };
  const thumbs = async () => {
    $('eThumbs').innerHTML = keys.map((k, i) => `<figure data-i="${i}"><img alt=""><button type="button" aria-label="Remove photo">×</button></figure>`).join('') || '<span class="muted" style="font-size:12px">No photos yet.</span>';
    $('eThumbs').querySelectorAll('figure').forEach(async (f) => {
      const k = keys[Number(f.dataset.i)];
      f.querySelector('img').src = await imgUrl(k);
      f.querySelector('button').onclick = () => { keys = keys.filter((x) => x !== k); thumbs(); };
    });
  };
  box.querySelectorAll('input,textarea').forEach((i) => i.addEventListener('input', calc));
  box.querySelectorAll('input[name="eDel"]').forEach((i) => i.addEventListener('change', calc));
  $('eFiles').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 6 - keys.length);
    if (!files.length) { $('eErr').textContent = 'Up to 6 photos per listing.'; return; }
    $('eErr').textContent = 'Uploading…';
    try {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name} is larger than 10 MB.`);
        const name = `${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`;
        const r = await uploadData({ path: ({ identityId }) => `market/${identityId}/${name}`, data: f, options: { contentType: f.type } }).result;
        keys.push(r.path);
      }
      $('eErr').textContent = '';
    } catch (ex) { $('eErr').textContent = 'Upload failed: ' + (ex.message || ex); }
    e.target.value = '';
    thumbs();
  };
  const save = async (submit) => {
    $('eErr').textContent = '';
    const bs = box.querySelectorAll('button'); bs.forEach((b) => { b.disabled = true; });
    try {
      const r = await call('saveListing', val());
      let row = r.listing;
      if (submit) row = (await call('submitListing', { id: row.id })).listing;
      const i = listings.findIndex((y) => y.id === row.id);
      if (i >= 0) listings[i] = row; else listings.push(row);
      box.hidden = true; box.innerHTML = '';
      drawList();
      if (r.backToReview) $('lList').insertAdjacentHTML('afterbegin', '<p class="muted">Saved. Because the details changed, the listing is off the website until we approve it again.</p>');
    } catch (ex) { $('eErr').textContent = ex.message; } finally { bs.forEach((b) => { b.disabled = false; }); }
  };
  $('eSave').onclick = () => save(false);
  if ($('eSaveSubmit')) $('eSaveSubmit').onclick = () => save(true);
  $('eCancel').onclick = () => { box.hidden = true; box.innerHTML = ''; };
  if ($('eDelete')) $('eDelete').onclick = async () => {
    if (!confirm(`Delete “${l.title}”? It comes off the website.`)) return;
    try {
      await call('deleteListing', { id: l.id });
      for (const k of keysOf(l)) await remove({ path: k }).catch(() => {});
      listings = listings.filter((y) => y.id !== l.id); box.hidden = true; box.innerHTML = ''; drawList();
    } catch (ex) { $('eErr').textContent = ex.message; }
  };
  thumbs(); calc();
  $('eTitle').focus();
}

start();
