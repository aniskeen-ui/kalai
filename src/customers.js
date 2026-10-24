// Customers tab: the customer master (one row per customer code BP-…). Rows are kept up to date from orders by the
// function (assignCodes); the studio can change a customer here, and the customer can change their own details on the
// website (My details). A change goes to the customer's open orders (contact), and to orders not yet shipped (address).
import { generateClient } from 'aws-amplify/data';
import { countryRegionHtml, wireRegion, autoPhones } from './phone.js';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const aed = (v) => `⃃ ${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const CLOSED = ['DELIVERED', 'REFUNDED', 'CANCELLED'];
const STATUS = { RECEIVED: 'Received', PRICE_SENT: 'Price sent', PAID: 'Paid', FRAMING: 'Being framed', SHIPPED: 'Shipped', DELIVERED: 'Delivered', REPLACEMENT: 'Replacement', REFUNDED: 'Refunded', CANCELLED: 'Cancelled' };

let customers = [];
let orders = [];
let openCode = null;
let wired = false;

async function listAll(model) {
  const out = []; let nextToken = null;
  do { const r = await model.list({ limit: 500, nextToken }); out.push(...(r.data || [])); nextToken = r.nextToken; } while (nextToken);
  return out;
}

async function load(sync = false) {
  $('cuList').innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (sync) await client.mutations.assignCodes().catch(() => null);
    [customers, orders] = await Promise.all([listAll(client.models.Customer), listAll(client.models.Enquiry)]);
    // First visit: build the master from the orders.
    if (!customers.length && orders.length && !sync) return load(true);
    draw();
  } catch (ex) { $('cuList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; }
}

function draw() {
  const q = $('cuSearch').value.trim().toLowerCase();
  const rows = customers
    .filter((c) => !q || [c.code, c.name, c.email, c.phone, c.address, c.emirate].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => String(b.lastOrderAt || '').localeCompare(String(a.lastOrderAt || '')));
  $('cuCount').textContent = `${rows.length} of ${customers.length} customers`;
  $('cuList').innerHTML = rows.length ? `<div class="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Email</th><th>Mobile</th><th>Location</th><th class="num">Orders</th><th class="num">Spent</th><th>Last order</th></tr></thead><tbody>
    ${rows.map((c) => `<tr data-code="${esc(c.code)}" class="${c.code === openCode ? 'sel' : ''}" style="cursor:pointer">
      <td class="mono">${esc(c.code)}</td><td><b>${esc(c.name || '–')}</b>${c.editedBy ? ` <span class="chip" title="Changed by ${esc(c.editedBy === 'customer' ? 'the customer' : 'you')} ${esc(day(c.editedAt))}">edited</span>` : ''}</td>
      <td>${esc(c.email || '–')}</td><td>${esc(c.phone || '–')}</td><td>${esc([c.emirate, c.country && c.country !== 'UAE' ? c.country : ''].filter(Boolean).join(', ') || '–')}</td>
      <td class="num">${c.paidCount ?? 0}/${c.orderCount ?? 0}</td><td class="num mono">${aed(c.totalSpent)}</td><td>${esc(day(c.lastOrderAt))}</td></tr>
      ${c.code === openCode ? `<tr class="cu-open"><td colspan="8" id="cuEdit"></td></tr>` : ''}`).join('')}
    </tbody></table></div>` : '<p class="muted">No customers match.</p>';
  $('cuList').querySelectorAll('tr[data-code]').forEach((tr) => { tr.onclick = () => { openCode = openCode === tr.dataset.code ? null : tr.dataset.code; draw(); }; });
  if (openCode) edit(customers.find((c) => c.code === openCode));
}

function edit(c) {
  const box = $('cuEdit'); if (!box || !c) return;
  const mine = orders.filter((e) => e.customerCode === c.code).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  box.innerHTML = `<form id="cuForm" novalidate style="display:grid;gap:10px;padding:8px 4px">
    <div class="two"><div class="field"><label for="cuName">Name</label><input id="cuName" name="name" maxlength="80" value="${esc(c.name)}"></div>
      <div class="field"><label for="cuEmail">Email</label><input id="cuEmail" name="email" type="email" maxlength="120" value="${esc(c.email)}"></div></div>
    <div class="two"><div class="field"><label for="cuPhone">Mobile / WhatsApp</label><input id="cuPhone" name="phone" type="tel" maxlength="30" value="${esc(c.phone)}"></div><div></div></div>
    <div class="three">${countryRegionHtml({ country: c.country || 'UAE', region: c.emirate || '', pin: c.pin || '', prefix: 'cu' })}</div>
    <div class="field"><label for="cuAddr">Address</label><textarea id="cuAddr" name="address" rows="2" maxlength="300">${esc(c.address)}</textarea></div>
    <div class="field"><label for="cuLand">Landmark (optional)</label><input id="cuLand" name="landmark" maxlength="120" value="${esc(c.landmark)}"></div>
    <div class="field"><label for="cuDiscT">Standard discount for this customer</label><div style="display:flex;gap:8px;flex-wrap:wrap"><select id="cuDiscT" name="discountType" style="width:auto"><option value="">None</option><option value="PCT" ${c.discountType === 'PCT' ? 'selected' : ''}>%</option><option value="AED" ${c.discountType === 'AED' ? 'selected' : ''}>⃃</option></select><input id="cuDiscV" name="discountValue" type="number" min="0" step="0.01" style="max-width:110px" value="${esc(c.discountValue ?? '')}" aria-label="Discount"><input id="cuDiscN" name="discountNote" maxlength="120" placeholder="Reason, e.g. loyal customer / corporate" style="flex:1;min-width:180px" value="${esc(c.discountNote)}"></div>
      <span class="muted" style="font-size:12px">Filled in automatically on their new orders (Price → Discount) before payment; you can still change it per order.</span></div>
    <div class="field"><label for="cuNotes">Studio notes (only you see them)</label><textarea id="cuNotes" name="notes" rows="2" maxlength="1000">${esc(c.notes)}</textarea></div>
    <label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="cuPush" style="width:auto" checked> Also update their open orders (contact; address on orders not yet shipped)</label>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn small" type="submit">Save customer</button><span class="muted" id="cuMsg" style="font-size:12px">${c.editedAt ? `Last changed by ${c.editedBy === 'customer' ? 'the customer' : 'the studio'} ${esc(day(c.editedAt))}.` : 'Filled in from their orders.'} Customer since ${esc(day(c.firstOrderAt))}.</span></div>
    <div><b style="font-size:13px">Orders (${mine.length})</b>
      <div style="display:grid;gap:4px;margin-top:6px;font-size:13px">${mine.map((e) => `<div style="display:flex;gap:10px;flex-wrap:wrap"><a class="mono" href="/admin.html#order=${encodeURIComponent(e.id)}" target="_blank" rel="noopener">${esc(e.ref)}</a><span>${esc(e.title)}</span><span class="muted">${esc(STATUS[e.status] || e.status)} · ${esc(day(e.createdAt))}${e.quotedPrice != null ? ` · ${aed(e.quotedPrice)}` : ''}</span></div>`).join('') || '<span class="muted">None</span>'}</div></div>
  </form>`;
  wireRegion(box); autoPhones?.(box);
  box.querySelector('#cuForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, msg = $('cuMsg');
    const v = (n) => (f.querySelector(`[name="${n}"]`)?.value ?? '').trim();
    const rec = { code: c.code, name: v('name'), email: v('email').toLowerCase(), phone: v('phone'), country: v('country') || 'UAE', emirate: v('emirate'), pin: v('pin') || null,
      address: v('address'), landmark: v('landmark') || null, notes: v('notes') || null, discountType: v('discountType') || null, discountValue: v('discountType') && Number(v('discountValue')) > 0 ? Number(v('discountValue')) : null, discountNote: v('discountType') ? v('discountNote') || null : null, editedBy: 'studio', editedAt: new Date().toISOString() };
    if (!rec.name) { msg.textContent = 'Add the name.'; return; }
    if (rec.discountType && !rec.discountValue) { msg.textContent = 'Enter the discount amount, or choose None.'; return; }
    if (rec.discountType === 'PCT' && rec.discountValue > 100) { msg.textContent = 'A % discount can be at most 100.'; return; }
    if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) { msg.textContent = 'Check the email address.'; return; }
    msg.textContent = 'Saving…';
    try {
      const r = await client.models.Customer.update(rec);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      Object.assign(c, r.data || rec);
      let n = 0;
      if ($('cuPush').checked) {
        for (const e of mine.filter((x) => !CLOSED.includes(x.status))) {
          const set = { id: e.id, customerName: rec.name, phone: rec.phone, ...(rec.email ? { email: rec.email } : {}) };
          if (rec.address && e.status !== 'SHIPPED') Object.assign(set, { deliveryName: rec.name, deliveryPhone: rec.phone, deliveryCountry: rec.country, deliveryEmirate: rec.emirate, deliveryAddress: rec.address, deliveryLandmark: rec.landmark, deliveryPin: rec.pin });
          const u = await client.models.Enquiry.update(set);
          if (!u.errors?.length) { Object.assign(e, set); n++; }
        }
      }
      msg.textContent = `Saved${n ? `; ${n} open order${n === 1 ? '' : 's'} updated` : ''}.`;
      setTimeout(draw, 900);
    } catch (ex) { msg.textContent = ex.message; }
  };
}

export async function showCustomers() {
  if (!wired) {
    wired = true;
    $('cuSearch').addEventListener('input', draw);
    $('cuReload').onclick = () => load(true);
  }
  await load();
}
