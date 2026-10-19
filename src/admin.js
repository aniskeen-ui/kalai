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
const STUDIO_WHATSAPP_NAME = 'Kalai Art House';

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
      <td><span class="pill ${s}">${esc(STATUS[s] || s)}</span></td>
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

async function showDetail(e) {
  const det = parseDetails(e.details);
  const s = e.status || 'RECEIVED';
  $('detail').innerHTML = `
    <div><div class="muted" style="font-family:var(--mono);font-size:13px">${esc(e.ref)} · ${esc(KIND[e.kind] || '')}</div>
    <h2 style="font-size:22px;margin-top:4px">${esc(e.title)}</h2></div>
    <dl class="kv">
      <dt>Customer</dt><dd>${esc(e.customerName)}</dd>
      <dt>Mobile</dt><dd>${esc(e.phone)}</dd>
      <dt>Email</dt><dd>${esc(e.email)}</dd>
      ${Object.entries(det).filter(([k, v]) => v !== '' && v != null && !['Reference', 'Name', 'Mobile', 'Parent'].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    </dl>
    <div class="links" id="fileLinks">${e.fileKey ? '<span class="muted">Loading upload…</span>' : '<span class="muted">No upload attached.</span>'}</div>
    <form id="editForm" novalidate style="display:grid;gap:12px">
      <div class="two">
        <div class="field"><label for="eStatus">Status</label><select id="eStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="ePrice">Price (AED)</label><input id="ePrice" type="number" min="0" step="1" value="${e.quotedPrice ?? ''}"></div>
      </div>
      <div class="field"><label for="eLink">Payment link</label><input id="eLink" type="url" placeholder="https://… from Telr, Tap or Stripe" value="${esc(e.paymentLink)}"></div>
      <div class="field"><label for="eMsg">Message to customer</label><textarea id="eMsg" rows="3" placeholder="Available. Framed in teak, delivered by Thursday.">${esc(e.adminMessage)}</textarea></div>
      <div class="ok" id="saveMsg" role="status"></div>
      <button class="btn" type="submit">Save and update customer</button>
    </form>
    <div class="links" id="waLinks"></div>`;

  const waLink = () => {
    const digits = waDigits(e.phone);
    if (!digits) { $('waLinks').innerHTML = '<span class="muted">No mobile number to message.</span>'; return; }
    const price = $('ePrice').value, link = $('eLink').value.trim(), msg = $('eMsg').value.trim();
    const text = [`Hello ${e.customerName || ''}, this is ${STUDIO_WHATSAPP_NAME} about your enquiry ${e.ref} (${e.title}).`,
      price ? `Price: AED ${price}` : '', msg, link ? `Pay securely here: ${link}` : '',
      'You can also track it under My enquiries on art.pranixtechno.com'].filter(Boolean).join('\n');
    $('waLinks').innerHTML = `<a href="https://wa.me/${digits}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Send update on WhatsApp</a>`;
  };
  waLink();
  ['ePrice', 'eLink', 'eMsg'].forEach((id) => $(id).addEventListener('input', waLink));

  if (e.fileKey) {
    try {
      const { url } = await getUrl({ path: e.fileKey, options: { expiresIn: 900 } });
      $('fileLinks').innerHTML = `<a href="${esc(url.toString())}" target="_blank" rel="noopener">Open uploaded photo</a><span class="muted">Link works for 15 minutes.</span>`;
    } catch (ex) {
      $('fileLinks').innerHTML = `<span class="err">Could not open the upload: ${esc(ex.message)}</span>`;
    }
  }

  $('editForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button'); b.disabled = true; $('saveMsg').textContent = '';
    const priceVal = $('ePrice').value.trim();
    try {
      const { data, errors } = await client.models.Enquiry.update({
        id: e.id,
        status: $('eStatus').value,
        quotedPrice: priceVal === '' ? null : Number(priceVal),
        paymentLink: $('eLink').value.trim() || null,
        adminMessage: $('eMsg').value.trim() || null,
      });
      if (errors?.length) throw new Error(errors[0].message);
      Object.assign(e, data || {});
      $('saveMsg').textContent = 'Saved. The customer sees this under My enquiries. Use the WhatsApp link to let them know.';
      render();
    } catch (ex) {
      $('saveMsg').textContent = '';
      $('detail').querySelector('#saveMsg').insertAdjacentHTML('afterend', `<div class="err">Could not save: ${esc(ex.message)}</div>`);
    } finally { b.disabled = false; }
  });
}

start();
