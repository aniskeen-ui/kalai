// Settings → Number series: how every Kalai document is numbered. Stored in Rates (key "numberSeries"):
// { docs: { key: { prefix, mode: 'alpha'|'numeric', source: 'internal'|'external', digits } }, sup: { sellerId: { code, next, name } } }.
// The website (Lambda) reads it when it creates the next document; changes apply to new documents only.
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Documents you can set. ext = what "External" means for that document.
const DOCS = [
  { k: 'supInv', name: 'Supplier invoice (frame, print & delivery shops)', prefix: '', digits: 8, source: 'internal', ext: 'Supplier types their own', perSupplier: true },
  { k: 'inv', name: 'Customer invoice (Zoho)', prefix: 'KAH-INV-', digits: 4, source: 'internal', ext: 'Zoho numbers it' },
  { k: 'cn', name: 'Credit note (Zoho)', prefix: 'KAH-CN-', digits: 4, source: 'internal', ext: 'Zoho numbers it' },
  { k: 'qt', name: 'Quote (Zoho)', prefix: 'KAH-QT-', digits: 4, source: 'external', ext: 'Zoho numbers it' },
  { k: 'dc', name: 'Delivery challan (Zoho)', prefix: 'KAH-DC-', digits: 4, source: 'external', ext: 'Zoho numbers it' },
  { k: 'varnt', name: 'Order variant (saved order selection)', prefix: 'VARNT', digits: 4, source: 'internal', ext: '', internalOnly: true },
];
// Fixed: already printed on orders, emails and Zoho references, and read back by the system.
const FIXED = [
  ['Order', 'KA-261025-Q3X0', 'Date + random code: customers can\'t guess other orders. Zoho documents are matched by it.'],
  ['Basket (one payment, several orders)', 'BK-261025-Q3X0', 'Follows the order number.'],
  ['Customer', 'BP-0000001', 'On every order and in Zoho contact names.'],
  ['Artwork', 'AT-0000001', 'On labels, the website and order details.'],
  ['Offer', 'PR-0000001', 'Offer master.'],
  ['Voucher / gift card', 'Random code', 'Must be unguessable: it is the value.'],
];
const FIELDS = [['mode', 'Format', [['alpha', 'Alphanumeric (prefix + number)'], ['numeric', 'Numbers only']]], ['source', 'Numbering', [['internal', 'Internal (Kalai)'], ['external', 'External']]], ['digits', 'Digits', null]];

let data = { docs: {}, sup: {} }, loadedSup = {}, wired = false, dirty = false;
const docOf = (d) => ({ prefix: d.prefix, mode: 'alpha', source: d.source, digits: d.digits, ...(data.docs[d.k] || {}) });
const sample = (d, s) => `${s.mode === 'numeric' ? '' : (d.perSupplier ? 'MF' : s.prefix)}${(d.k === 'varnt' ? '1001' : '1').padStart(Number(s.digits) || d.digits, '0')}`;

async function load() {
  try {
    const { data: row } = await client.models.Rates.get({ key: 'numberSeries' });
    let d = row?.data; for (let i = 0; i < 2 && typeof d === 'string'; i++) d = JSON.parse(d);
    data = { docs: {}, sup: {}, ...(d && typeof d === 'object' ? d : {}) };
  } catch { data = { docs: {}, sup: {} }; }
  loadedSup = JSON.parse(JSON.stringify(data.sup || {}));
}

function draw() {
  const box = $('nsBox');
  const rows = DOCS.map((d) => {
    const s = docOf(d);
    const sel = (f, opts, dis) => `<select data-ns="${d.k}" data-f="${f}" ${dis ? 'disabled' : ''}>${opts.map(([v, l]) => `<option value="${v}" ${String(s[f]) === v ? 'selected' : ''}>${esc(f === 'source' && v === 'external' && d.ext ? `External (${d.ext})` : l)}</option>`).join('')}</select>`;
    return `<tr><td><input type="checkbox" data-nsel="${d.k}" style="width:auto"></td><td>${esc(d.name)}</td>
      <td>${d.perSupplier ? '<span class="muted" title="Each supplier\'s own 2 letters, below">Supplier code (2 letters)</span>' : `<input data-ns="${d.k}" data-f="prefix" value="${esc(s.prefix)}" maxlength="12" style="width:110px;font-family:monospace">`}</td>
      <td>${sel('mode', FIELDS[0][2])}</td><td>${sel('source', d.internalOnly ? [['internal', 'Internal (Kalai)']] : FIELDS[1][2], d.internalOnly)}</td>
      <td><input data-ns="${d.k}" data-f="digits" type="number" min="3" max="12" value="${esc(s.digits)}" style="width:64px"></td>
      <td><code data-nsx="${d.k}">${esc(s.source === 'external' && !d.internalOnly ? (d.perSupplier ? 'typed by supplier' : 'Zoho') : sample(d, s))}</code></td></tr>`;
  }).join('');
  const sups = Object.entries(data.sup || {});
  box.innerHTML = `<style>#nsBox table{width:100%;font-size:13px;border-collapse:collapse}#nsBox th,#nsBox td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}#nsBox select,#nsBox input{font-size:13px;padding:4px 6px}#nsBox th{white-space:nowrap}#nsBox select{width:auto;max-width:260px}.ns-mass{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-weight:400}</style>
    <p class="muted" style="font-size:13px;margin:0">How each document is numbered. <b>Internal</b> = Kalai gives the next number in the series; <b>External</b> = the supplier types their own, or Zoho uses its own numbering. Changes apply to new documents only; existing numbers stay.</p>
    <div style="overflow:auto"><table><thead><tr><th><input type="checkbox" id="nsAll" style="width:auto" title="Select all"></th><th>Document</th><th>Prefix</th><th>Format</th><th>Numbering</th><th>Digits</th><th>Example</th></tr>
      <tr><th colspan="7"><span class="ns-mass">Change selected: <select id="nsMassF">${FIELDS.map(([f, l]) => `<option value="${f}">${l}</option>`).join('')}</select><span id="nsMassV"></span><button type="button" class="btn small ghost" id="nsMassGo">Apply to selected</button></span></th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3 style="margin:6px 0 0;font-size:16px">Supplier codes</h3>
    <p class="muted" style="font-size:13px;margin:0">Each supplier invoice number = the supplier's 2 letters + the running number (e.g. Master Frames → MF00000001). A supplier gets its code with its first invoice; change the letters or the next number here.</p>
    ${sups.length ? `<div style="overflow:auto"><table><thead><tr><th>Supplier</th><th>Code</th><th>Next number</th><th>Next invoice</th></tr></thead><tbody>${sups.map(([id, v]) => `<tr><td>${esc(v.name || id)}</td>
      <td><input data-sup="${esc(id)}" data-f="code" value="${esc(v.code)}" maxlength="2" style="width:50px;text-transform:uppercase;font-family:monospace"></td>
      <td><input data-sup="${esc(id)}" data-f="next" type="number" min="1" value="${esc(v.next || 1)}" style="width:110px"></td><td><code data-supx="${esc(id)}"></code></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted" style="font-size:13px;margin:0">No supplier has invoiced yet.</p>'}
    <h3 style="margin:6px 0 0;font-size:16px">Fixed numbers</h3>
    <div style="overflow:auto"><table><thead><tr><th>Document</th><th>Looks like</th><th>Why it is fixed</th></tr></thead><tbody>${FIXED.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td><code>${esc(b)}</code></td><td class="muted">${esc(c)}</td></tr>`).join('')}</tbody></table></div>
    <div style="display:flex;gap:10px;align-items:center"><button class="btn" type="button" id="nsSave">Save number series</button><span class="muted" id="nsMsg" style="font-size:13px"></span></div>`;
  const massV = () => {
    const f = $('nsMassF').value, opts = FIELDS.find((x) => x[0] === f)[2];
    $('nsMassV').innerHTML = opts ? `<select id="nsMassVal">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>` : '<input id="nsMassVal" type="number" min="3" max="12" value="8" style="width:64px">';
  };
  massV();
  $('nsMassF').onchange = massV;
  $('nsAll').onchange = () => box.querySelectorAll('[data-nsel]').forEach((c) => { c.checked = $('nsAll').checked; });
  $('nsMassGo').onclick = () => {
    const f = $('nsMassF').value, v = $('nsMassVal').value;
    const ks = [...box.querySelectorAll('[data-nsel]:checked')].map((c) => c.dataset.nsel);
    if (!ks.length) { $('nsMsg').textContent = 'Tick the documents to change first.'; return; }
    ks.forEach((k) => { const el = box.querySelector(`[data-ns="${k}"][data-f="${f}"]`); if (el && !el.disabled && [...(el.options || [{ value: v }])].some((o) => o.value === v)) el.value = v; });
    mark(); $('nsMsg').textContent = `Changed ${ks.length}: click Save number series.`;
  };
  box.querySelectorAll('[data-ns],[data-sup]').forEach((el) => { el.oninput = mark; el.onchange = mark; });
  preview();
}
function read() {
  const docs = { ...(data.docs || {}) };
  DOCS.forEach((d) => {
    const g = (f) => $('nsBox').querySelector(`[data-ns="${d.k}"][data-f="${f}"]`)?.value;
    docs[d.k] = { prefix: d.perSupplier ? '' : (g('prefix') ?? d.prefix).trim().toUpperCase(), mode: g('mode'), source: d.internalOnly ? 'internal' : g('source'), digits: Math.min(12, Math.max(3, Number(g('digits')) || d.digits)) };
  });
  const sup = {};
  Object.entries(data.sup || {}).forEach(([id, v]) => {
    const g = (f) => $('nsBox').querySelector(`[data-sup="${CSS.escape(id)}"][data-f="${f}"]`)?.value;
    sup[id] = { ...v, code: String(g('code') || v.code).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2), next: Math.max(1, Math.floor(Number(g('next')) || v.next || 1)) };
  });
  return { ...data, docs, sup };
}
function preview() {
  const n = read();
  DOCS.forEach((d) => { const s = n.docs[d.k]; const el = $('nsBox').querySelector(`[data-nsx="${d.k}"]`); if (el) el.textContent = s.source === 'external' && !d.internalOnly ? (d.perSupplier ? 'typed by supplier' : 'Zoho') : sample(d, s); });
  const sd = n.docs.supInv;
  Object.entries(n.sup).forEach(([id, v]) => { const el = $('nsBox').querySelector(`[data-supx="${CSS.escape(id)}"]`); if (el) el.textContent = `${sd.mode === 'numeric' ? '' : v.code}${String(v.next).padStart(sd.digits, '0')}`; });
}
function mark() { dirty = true; $('nsSave').classList.add('cg-dirty'); preview(); }

async function save() {
  const n = read();
  const codes = Object.values(n.sup).map((v) => v.code);
  if (codes.some((c) => c.length !== 2)) { $('nsMsg').textContent = 'Each supplier code needs 2 letters.'; return; }
  if (new Set(codes).size !== codes.length) { $('nsMsg').textContent = 'Two suppliers have the same code: give each its own letters.'; return; }
  const bad = DOCS.find((d) => !d.perSupplier && n.docs[d.k].mode === 'alpha' && !n.docs[d.k].prefix);
  if (bad) { $('nsMsg').textContent = `${bad.name}: alphanumeric needs a prefix (or choose Numbers only).`; return; }
  $('nsMsg').textContent = 'Saving…';
  try {
    // Suppliers may have invoiced since this screen opened: keep their counter unless you changed it here.
    const { data: row } = await client.models.Rates.get({ key: 'numberSeries' });
    let cur = row?.data; for (let i = 0; i < 2 && typeof cur === 'string'; i++) cur = JSON.parse(cur);
    const live = (cur && cur.sup) || {};
    Object.entries(live).forEach(([id, v]) => {
      if (!n.sup[id]) n.sup[id] = v;
      else if (n.sup[id].next === (loadedSup[id]?.next || 1)) n.sup[id].next = Math.max(n.sup[id].next, Number(v.next) || 1);
    });
    const payload = { key: 'numberSeries', data: JSON.stringify(n) };
    const r = row ? await client.models.Rates.update(payload) : await client.models.Rates.create(payload);
    if (r.errors?.length) throw new Error(r.errors[0].message);
    data = n; loadedSup = JSON.parse(JSON.stringify(n.sup)); dirty = false;
    draw(); $('nsMsg').textContent = 'Saved. New documents use these numbers.';
  } catch (ex) { $('nsMsg').textContent = `Not saved: ${ex.message}`; }
}

export async function showNumbers() {
  if (!wired) {
    wired = true;
    window.addEventListener('beforeunload', (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });
    $('nsBox').addEventListener('click', (ev) => { if (ev.target.id === 'nsSave') save(); });
  }
  $('nsBox').innerHTML = '<p class="muted">Loading…</p>';
  await load();
  draw();
}
