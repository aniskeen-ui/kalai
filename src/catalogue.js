// Catalogue tab (Order Management): the website's collection.
// Bulk import photos → drafts; edit inline (auto-saves); select many → publish now, schedule N per day, sold, hide, delete.
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl, remove } from 'aws-amplify/storage';
import { SUGGEST, AI_LOOK } from './suggest.js';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KINDS = { water: 'Watercolour', sketch: 'Pencil sketch', photo: 'Framed print (photo)' };
const SUBJECTS = { land: 'Landscapes & water', village: 'Village life', nature: 'Trees & nature', arch: 'Buildings & places', people: 'Portraits' };
const MEDIUM = { water: 'Watercolour on paper', sketch: 'Graphite on paper', photo: 'Fine-art photographic print' };

let items = [];
const pending = new Map(); // product id → fields changed on screen, written by "Save changes"
function saveBar() {
  const n = pending.size;
  $('cgSaveBar').hidden = n === 0;
  $('cgSaveCount').textContent = `${n} work${n === 1 ? '' : 's'} changed`;
}
async function saveAll() {
  const ids = [...pending.keys()]; if (!ids.length) return;
  $('cgSaveAll').disabled = true; let ok = 0; const bad = [];
  for (const id of ids) {
    const r = await client.models.Product.update({ id, ...pending.get(id) });
    if (r.errors?.length) bad.push(`${items.find((x) => x.id === id)?.code || id}: ${r.errors[0].message}`); else { pending.delete(id); ok++; }
    $('cgSaveMsg').textContent = `Saving… ${ok + bad.length}/${ids.length}`;
  }
  $('cgSaveAll').disabled = false;
  $('cgSaveMsg').textContent = bad.length ? `Saved ${ok}. Not saved: ${bad.join('; ')}` : `Saved ${ok} work${ok === 1 ? '' : 's'}.`;
  document.querySelectorAll('.cg-row.cg-dirty').forEach((r) => { if (!pending.has(r.dataset.id)) { r.classList.remove('cg-dirty'); const m = r.querySelector('.cg-saved'); if (m) m.textContent = 'Saved'; } });
  saveBar(); if (!pending.size) $('cgSaveBar').hidden = false, setTimeout(() => { if (!pending.size) $('cgSaveBar').hidden = true; }, 2500);
}
addEventListener('beforeunload', (e) => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });
const selected = new Set();
const thumbs = new Map(); // imageKey → url
let loaded = false;

const now = () => new Date().toISOString();
/** What the website shows for a work right now. */
function state(p) {
  const s = p.status || 'DRAFT';
  if (s === 'PUBLISHED' && p.publishAt && p.publishAt > now()) return 'SCHEDULED';
  return s;
}
const STATE_LABEL = { DRAFT: 'Draft', SCHEDULED: 'Scheduled', PUBLISHED: 'On the website', SOLD: 'Sold', HIDDEN: 'Hidden' };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

export async function showCatalogue() {
  if (!loaded) { wireToolbar(); loaded = true; }
  await load();
}

let codesAsked = false;
async function load() {
  $('cgList').innerHTML = '<p class="muted">Loading the catalogue…</p>';
  try {
    const all = [];
    let nextToken = null;
    do {
      const r = await client.models.Product.list({ limit: 500, nextToken });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      all.push(...r.data);
      nextToken = r.nextToken;
    } while (nextToken);
    // Works without an artwork code (imported before codes existed, or just now) get one, then the list reloads.
    if (all.some((p) => !p.code) && !codesAsked) { codesAsked = true; client.mutations.assignCodes().then(() => { codesAsked = false; load(); }).catch(() => {}); }
    items = all.sort((a, b) => String(b.publishAt || b.createdAt).localeCompare(String(a.publishAt || a.createdAt)));
    items.forEach((p) => { if (pending.has(p.id)) Object.assign(p, pending.get(p.id)); }); // unsaved edits stay on screen
    draw();
  } catch (ex) {
    $('cgList').innerHTML = `<p class="err">Could not load the catalogue: ${esc(ex.message)}</p>`;
  }
}

function filtered() {
  const f = $('cgFilter').value, q = $('cgSearch').value.trim().toLowerCase();
  return items.filter((p) => (!f || state(p) === f) && (!q || q.split(/\s+/).every((w) => `${p.title} ${p.code} ${p.artist || 'Siva Raja'} ${p.size} ${p.medium} ${p.description}`.toLowerCase().includes(w))));
}

function draw() {
  const counts = {};
  items.forEach((p) => { const s = state(p); counts[s] = (counts[s] || 0) + 1; });
  $('cgCounts').innerHTML = [`<span class="count">All <b>${items.length}</b></span>`, ...Object.entries(STATE_LABEL).filter(([k]) => counts[k]).map(([k, v]) => `<span class="count">${v} <b>${counts[k]}</b></span>`)].join('');
  const queue = items.filter((p) => state(p) === 'SCHEDULED').sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  $('cgQueue').innerHTML = queue.length ? `Publishing queue: next <b>${esc(queue[0].title)}</b> on ${esc(day(queue[0].publishAt))}; last on ${esc(day(queue.at(-1).publishAt))} (${queue.length} works).` : '';
  const list = filtered();
  [...selected].forEach((id) => { if (!items.find((p) => p.id === id)) selected.delete(id); });
  $('cgAll').checked = list.length > 0 && list.every((p) => selected.has(p.id));
  $('cgList').innerHTML = list.length ? list.map(row).join('') : `<p class="muted">${items.length ? 'Nothing matches this filter.' : 'No works yet. Use “Import photos” (select many at once), or “Import the current website works”.'}</p>`;
  wireRows(list);
  drawBulk();
  list.forEach(async (p) => {
    if (!p.imageKey) return;
    let u = thumbs.get(p.imageKey);
    if (!u) { try { u = (await getUrl({ path: p.imageKey, options: { expiresIn: 3600 } })).url.toString(); thumbs.set(p.imageKey, u); } catch { return; } }
    const im = document.querySelector(`.cg-row[data-id="${CSS.escape(p.id)}"] img`);
    if (im) im.src = u;
  });
}

function row(p) {
  const s = state(p);
  const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  return `<article class="cg-row ${selected.has(p.id) ? 'sel' : ''} ${pending.has(p.id) ? 'cg-dirty' : ''}" data-id="${esc(p.id)}">
    <label class="cg-pick"><input type="checkbox" ${selected.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(p.title)}"></label>
    <div class="cg-img"><img alt=""></div>
    <div class="cg-fields">
      <div class="cg-top"><input data-f="title" value="${esc(p.title)}" aria-label="Title" class="cg-title">
        <span class="cg-badge ${s}">${STATE_LABEL[s]}${s === 'SCHEDULED' || (s === 'PUBLISHED' && p.publishAt) ? ` · ${esc(day(p.publishAt))}` : ''}</span>
        <span class="muted" style="font-size:11px;white-space:nowrap" title="Artwork code: shown on the website and in enquiries"><b class="mono">${esc(p.code || 'code pending')}</b>${p.named ? ` · named by ${esc(String(p.named).split(' 20')[0])}` : ' · <b style="color:var(--kumkum)">untitled on website</b>'}</span></div>
      <div class="cg-grid">
        <select data-f="kind" aria-label="Type">${opt(KINDS, p.kind || 'water')}</select>
        <select data-f="subject" aria-label="Subject">${opt(SUBJECTS, p.subject || 'land')}</select>
        <input data-f="size" value="${esc(p.size)}" placeholder="Size, e.g. 38 × 28 cm" aria-label="Size">
        <input data-f="medium" value="${esc(p.medium)}" placeholder="Medium" aria-label="Medium">
        <span class="cg-webprice" title="Prices are set and changed only in the Pricing tab">${webPrice(p)}</span>
        <label style="display:inline-flex;gap:5px;align-items:center;font-size:12px;font-weight:400;white-space:nowrap" title="The picture is an AI-made preview; the artist paints the order by hand"><input data-f="aiPreview" type="checkbox" ${p.aiPreview ? 'checked' : ''} style="width:auto"> AI preview</label>
      </div>
      <textarea data-f="description" rows="1" placeholder="Short description shown on the website" aria-label="Description">${esc(p.description)}</textarea>
      ${p.kind !== 'photo' ? `<div class="cg-prints" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px">
        <label style="display:inline-flex;gap:5px;align-items:center;font-weight:400;white-space:nowrap" title="Also sell framed prints of this painting (Framed Prints, and a button on its page)"><input data-f="printable" type="checkbox" style="width:auto" ${p.printable ? 'checked' : ''}> Sell framed prints</label>
        <label style="display:inline-flex;gap:5px;align-items:center;font-weight:400;white-space:nowrap">up to <select data-f="printMax" aria-label="Largest print size" style="width:auto">${PRINT_MAX.map((z) => `<option ${z === (p.printMax || 'A3') ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
        <label class="btn small ${p.printKey ? 'ghost' : ''}" style="cursor:pointer" title="High-quality scan or photo of the work (JPG, PNG or TIFF, up to 200 MB): used for framed prints and sent to licence buyers">${p.printKey ? `✓ Full-size file uploaded${p.printW ? ` (${p.printW} × ${p.printH} px)` : ''} · change` : '⬆ Upload full-size file'}<input type="file" accept="image/*,.tif,.tiff" data-print-file hidden></label>
        <label style="display:inline-flex;gap:5px;align-items:center;font-weight:400;white-space:nowrap" title="Sell image licences (web, media, commercial) of this work from the print file: Licences tab on its page"><input data-f="licensable" type="checkbox" style="width:auto" ${p.licensable ? 'checked' : ''}> Sell licences</label>
        ${p.printable ? `<label style="display:inline-flex;gap:5px;align-items:center;font-weight:400;white-space:nowrap" title="The artist's share of each framed print of this work, added to the print price. Blank = the artist's own % (Artists &amp; sellers; Siva's in Pricing).">Print royalty <input data-f="printRoyalty" type="number" min="0" max="50" step="0.5" value="${p.printRoyalty ?? ''}" placeholder="artist's %" style="width:80px"> %</label>` : ''}
        ${p.licensable ? `<label style="display:inline-flex;gap:5px;align-items:center;font-weight:400;white-space:nowrap" title="The artist's share of each image licence of this work (% of the licence price). Blank = the artist's own % (default 30%).">Licence royalty <input data-f="licenceRoyalty" type="number" min="0" max="90" step="0.5" value="${p.licenceRoyalty ?? ''}" placeholder="artist's %" style="width:80px"> %</label>` : ''}</div>` : ''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn small ghost" data-clean title="Removes thin dark scan lines or borders along the edges of the picture shown on the website (the original stays in storage)">Clean picture edges</button><span class="cg-saved muted" aria-live="polite"></span></div>
    </div>
  </article>`;
}

// Largest print size the print file allows (A3 is safe for a good web photo; bigger needs a proper scan).
const PRINT_MAX = ['A4', 'A3', '40×50', '50×70', '60×80'];
let sivaRoyalty = null;
let artistProfiles = null;
async function artistProfile(id) {
  if (!artistProfiles) { try { artistProfiles = (await client.models.SellerProfile.list({ limit: 500 })).data || []; } catch { artistProfiles = []; } }
  return artistProfiles.find((p) => p.id === id);
}
async function sivaRoyaltyPct() {
  if (sivaRoyalty == null) { try { const r = await client.models.Rates.get({ key: 'default' }); const d = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : {}; sivaRoyalty = Number(d.sivaRoyalty ?? 10); } catch { sivaRoyalty = 10; } }
  return sivaRoyalty;
}
function wireRows(list) {
  document.querySelectorAll('.cg-row').forEach((el) => {
    const p = list.find((x) => x.id === el.dataset.id);
    el.querySelector('.cg-pick input').onchange = (e) => { e.target.checked ? selected.add(p.id) : selected.delete(p.id); el.classList.toggle('sel', e.target.checked); $('cgAll').checked = list.every((x) => selected.has(x.id)); drawBulk(); };
    el.querySelectorAll('[data-f]').forEach((inp) => {
      inp.onchange = async () => {
        const f = inp.dataset.f;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
        if (f === 'title' && !v) { inp.value = p.title; return; }
        if (f === 'priceAed') v = v === '' ? null : Number(v);
        if (f === 'licenceRoyalty') { v = v === '' ? null : Number(v); if (v != null && !(v >= 0 && v <= 90)) { inp.value = p.licenceRoyalty ?? ''; el.querySelector('.cg-saved').textContent = 'Licence royalty: 0 to 90 %.'; return; } }
        if (f === 'printRoyalty') { v = v === '' ? null : Number(v); if (v != null && !(v >= 0 && v <= 50)) { inp.value = p.printRoyalty ?? ''; el.querySelector('.cg-saved').textContent = 'Royalty: 0 to 50 %.'; return; } }
        const patch = { id: p.id, [f]: v };
        if (f === 'title') patch.named = `Studio ${new Date().toISOString()}`;
        if (f === 'kind' && (!p.medium || Object.values(MEDIUM).includes(p.medium))) patch.medium = MEDIUM[v];
        // Prints switched on for one of Siva's works: his royalty from Rates (portal artists' comes from their profile).
        if (f === 'printable' && v && !p.artistId && p.printRoyalty == null) patch.printRoyalty = await sivaRoyaltyPct();
        // Only with the artist's agreement (artist portal → My details → prints).
        if (f === 'printable' && v && p.artistId) {
          const ap = await artistProfile(p.artistId);
          if (ap?.allowPrints === 'NO') { inp.checked = false; el.querySelector('.cg-saved').textContent = `${ap.business} hasn't agreed to prints (their portal → My details).`; return; }
          if (ap && p.printRoyalty == null) patch.printRoyalty = Number(ap.royaltyPct ?? 10);
        }
        // Licences: from the full-size file, and only with the artist's agreement (artist portal → My details → licences).
        if (f === 'licensable' && v) {
          if (!p.printKey) { inp.checked = false; el.querySelector('.cg-saved').textContent = 'First upload the full-size file (the “⬆ Upload full-size file” button in this row): the licence buyer downloads that file.'; el.querySelector('[data-print-file]')?.click(); return; }
          if (p.artistId) {
            const ap = await artistProfile(p.artistId);
            if (ap?.allowLicences !== 'YES') { inp.checked = false; el.querySelector('.cg-saved').textContent = `${ap?.business || 'The artist'} hasn't agreed to image licences (their portal → My details).`; return; }
            if (ap && p.printRoyalty == null) patch.printRoyalty = Number(ap.royaltyPct ?? 10);
          } else if (p.printRoyalty == null) patch.printRoyalty = await sivaRoyaltyPct();
        }
        // Kept until "Save changes" (one Save for the whole screen, like the other screens).
        const msg = el.querySelector('.cg-saved');
        delete patch.id; pending.set(p.id, { ...(pending.get(p.id) || {}), ...patch }); Object.assign(p, patch);
        if (patch.medium) el.querySelector('[data-f="medium"]').value = patch.medium;
        msg.textContent = 'Not saved yet'; el.classList.add('cg-dirty');
        saveBar();
        // Prints / licences switched on or off: show or hide their royalty boxes straight away.
        if (['printable', 'licensable'].includes(f)) { const y = scrollY; draw(); scrollTo(0, y); }
      };
    });
    const cb = el.querySelector('[data-clean]');
    if (cb) cb.onclick = async () => {
      const msg = el.querySelector('.cg-saved');
      if (!p.imageKey) { msg.textContent = 'No picture.'; return; }
      cb.disabled = true; msg.textContent = 'Checking the edges…';
      try {
        const out = await cleanEdges(p.imageKey);
        if (!out) { msg.textContent = 'No dark line found along the edges.'; return; }
        if (!cb.dataset.sure) { cb.dataset.sure = '1'; cb.textContent = `Trim ${out.what}? Click again`; msg.textContent = ''; cb._blob = out.blob; return; }
        msg.textContent = 'Saving the cleaned picture…';
        const res = await uploadData({ path: `catalogue/clean/${p.id}-${Date.now()}.jpg`, data: cb._blob || out.blob, options: { contentType: 'image/jpeg' } }).result;
        const r = await client.models.Product.update({ id: p.id, imageKey: res.path });
        if (r.errors?.length) throw new Error(r.errors[0].message);
        p.imageKey = res.path; delete cb.dataset.sure; cb.textContent = 'Clean picture edges';
        const img = el.querySelector('img'); if (img) img.src = (await getUrl({ path: res.path })).url.toString();
        msg.textContent = 'Done: the website shows the cleaned picture.';
      } catch (ex) { msg.textContent = 'Not cleaned: ' + ex.message; } finally { cb.disabled = false; }
    };
    const pf = el.querySelector('[data-print-file]');
    if (pf) pf.onchange = async () => {
      const file = pf.files?.[0]; if (!file) return;
      const msg = el.querySelector('.cg-saved');
      if (file.size > 200 * 1024 * 1024) { msg.textContent = 'The print file is larger than 200 MB.'; return; }
      msg.textContent = 'Uploading the print file…';
      try {
        const res = await uploadData({ path: `originals/print/${p.id}-${file.name.replace(/[^\w.-]+/g, '-')}`, data: file, options: { contentType: file.type || 'image/jpeg' } }).result;
        // Pixel size for the Licence tab (TIFF can't be read here: the function fills it in later).
        let dims = {}; try { const bm = await createImageBitmap(file); dims = { printW: bm.width, printH: bm.height }; bm.close?.(); } catch { dims = { printW: null, printH: null }; }
        const r = await client.models.Product.update({ id: p.id, printKey: res.path, ...dims });
        if (r.errors?.length) throw new Error(r.errors[0].message);
        p.printKey = res.path; pf.parentElement.firstChild.textContent = `✓ Full-size file uploaded${dims.printW ? ` (${dims.printW} × ${dims.printH} px)` : ''} · change`; pf.parentElement.classList.add('ghost'); msg.textContent = 'Full-size file saved: you can tick Sell licences now.';
      } catch (ex) { msg.textContent = 'Not saved: ' + ex.message; }
    };
  });
}

function drawBulk() {
  const n = selected.size;
  $('cgBulk').hidden = n === 0;
  $('cgSelCount').textContent = `${n} selected`;
}

async function bulk(label, fn) {
  const ids = [...selected];
  if (!ids.length) return;
  $('cgBulkMsg').textContent = `${label}…`;
  let ok = 0, fail = 0;
  for (const [i, id] of ids.entries()) {
    const p = items.find((x) => x.id === id);
    try { await fn(p, i); ok++; } catch (e) { console.error(e); fail++; }
    $('cgBulkMsg').textContent = `${label}… ${i + 1}/${ids.length}`;
  }
  $('cgBulkMsg').textContent = `${label}: ${ok} done${fail ? `, ${fail} failed` : ''}.`;
  selected.clear();
  await load();
}
const upd = async (p, patch) => { const r = await client.models.Product.update({ id: p.id, ...patch }); if (r.errors?.length) throw new Error(r.errors[0].message); };

/** Dubai date at 09:00 local (05:00 UTC), n days after start. */
function slot(startDate, n) {
  const d = new Date(`${startDate}T05:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

function titlesText(all) {
  return items.filter((p) => p.status !== 'HIDDEN' && (all || !p.named)).sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((p) => { const s = SUGGEST[p.code]; return [p.code || p.id, s ? s[0] : p.named ? p.title : '', s ? s[1] : p.subject || '', s ? s[2] : p.description || '', p.aiPreview || AI_LOOK.has(p.code) ? 'ai' : ''].join(' | ').replace(/ \| $/, ''); }).join('\n');
}
// The price the website shows now (black frame, base size), read-only here: prices change only in the Pricing tab.
function webPrice(p) {
  let m = null; try { m = p.priceMatrix ? JSON.parse(p.priceMatrix) : null; } catch { m = null; }
  const v = !m ? null : m.v === 2 ? m.sizes?.[m.base]?.black : m.black;
  return v ? `Website: <b>Dhs ${Number(v).toLocaleString('en-GB')}</b>${m.v === 2 ? ` · black frame ${esc(m.base)}` : ''} · <a href="#pricing" data-goprice>change in Pricing</a>` : 'Website: price on request · <a href="#pricing" data-goprice>set in Pricing</a>';
}
function wireTitles() {
  $('cgTitlesBtn').onclick = () => { $('cgTitlesBox').hidden = false; $('cgTitles').value = titlesText(false) || titlesText(true); $('cgTitlesMsg').textContent = ''; };
  $('cgTitlesAll').onclick = () => { $('cgTitles').value = titlesText(true); };
  $('cgTitlesClose').onclick = () => { $('cgTitlesBox').hidden = true; };
  $('cgTitlesGo').onclick = async () => {
    const lines = $('cgTitles').value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0] && x[1]);
    let ok = 0; const bad = [];
    $('cgTitlesGo').disabled = true;
    for (const [code, title, subject, description, ai] of lines) {
      const p = items.find((x) => x.code === code || x.id === code);
      if (!p || title.length < 2) { bad.push(code); continue; }
      const rec = { id: p.id, title: title.slice(0, 80), named: `Studio ${new Date().toISOString()}` };
      if (SUBJECTS[subject]) rec.subject = subject;
      if (description) rec.description = description.slice(0, 1000);
      rec.aiPreview = /^ai$/i.test(ai || '');
      const r = await client.models.Product.update(rec);
      if (r.errors?.length) bad.push(code); else { Object.assign(p, rec); ok++; }
      $('cgTitlesMsg').textContent = `Saving… ${ok} of ${lines.length}`;
    }
    $('cgTitlesGo').disabled = false;
    $('cgTitlesMsg').textContent = `${ok} titles saved: now on the website.${bad.length ? ` Not saved: ${bad.join(', ')}` : ''}`;
    draw();
  };
}

function wireToolbar() {
  wireTitles();
  const tomorrow = new Date(Date.now() + 86400000 + 4 * 3600000).toISOString().slice(0, 10);
  $('cgStart').value = tomorrow;
  $('cgFilter').onchange = draw;
  $('cgSearch').oninput = draw;
  $('cgReload').onclick = async () => { if (pending.size && !confirm(`${pending.size} work(s) have unsaved changes. Refresh and lose them?`)) return; pending.clear(); saveBar(); await load(); };
  $('cgAll').onchange = (e) => { filtered().forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id))); draw(); };
  $('cgPublish').onclick = () => bulk('Publishing now', (p) => upd(p, { status: 'PUBLISHED', publishAt: now() }));
  $('cgSchedule').onclick = () => {
    const per = Math.max(1, Number($('cgPerDay').value) || 1), start = $('cgStart').value;
    if (!start) { $('cgBulkMsg').textContent = 'Choose the start date.'; return; }
    // Keep the order shown on screen.
    const order = filtered().map((p) => p.id).filter((id) => selected.has(id));
    selected.clear(); order.forEach((id) => selected.add(id));
    bulk(`Scheduling ${per} per day from ${start}`, (p, i) => upd(p, { status: 'PUBLISHED', publishAt: slot(start, Math.floor(i / per)) }));
  };
  // Framed prints for the selected works (photos are prints already; works whose artist said no are skipped).
  $('cgPrintsOn').onclick = async () => {
    const max = $('cgPrintMax').value, siva = await sivaRoyaltyPct();
    let skipped = 0;
    await bulk(`Switching on prints (up to ${max})`, async (p) => {
      if (p.kind === 'photo') return;
      let royalty = p.printRoyalty ?? null;
      if (p.artistId) { const ap = await artistProfile(p.artistId); if (ap?.allowPrints === 'NO') { skipped++; return; } royalty = royalty ?? Number(ap?.royaltyPct ?? 10); }
      else royalty = royalty ?? siva;
      await upd(p, { printable: true, printMax: max, printRoyalty: royalty });
    });
    if (skipped) $('cgBulkMsg').textContent += ` ${skipped} skipped: the artist hasn't agreed to prints.`;
  };
  $('cgPrintsOff').onclick = () => bulk('Stopping prints', (p) => upd(p, { printable: false }));
  // Mass change: one field for all ticked works (more fields can be added to the list).
  const massInput = () => {
    const f = $('cgMassField').value, sel = (opts) => `<select id="cgMassV" style="width:auto">${opts.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select>`;
    $('cgMassVal').innerHTML = f === 'printRoyalty' ? '<input id="cgMassV" type="number" min="0" max="50" step="0.5" placeholder="blank = artist\'s %" style="width:130px"> %'
      : f === 'licenceRoyalty' ? '<input id="cgMassV" type="number" min="0" max="90" step="0.5" placeholder="blank = artist\'s %" style="width:130px"> %'
      : f === 'licensable' || f === 'aiPreview' ? sel([['yes', 'Yes'], ['no', 'No']])
      : f === 'printMax' ? sel(PRINT_MAX.map((z) => [z, z])) : f === 'subject' ? sel(Object.entries(SUBJECTS)) : sel([['water', 'Watercolour'], ['sketch', 'Sketch']]);
  };
  $('cgMassField').onchange = massInput; massInput();
  $('cgMassGo').onclick = async () => {
    const f = $('cgMassField').value, raw = String($('cgMassV').value || '').trim();
    const label = $('cgMassField').selectedOptions[0].textContent;
    let v = raw;
    if (f === 'printRoyalty' || f === 'licenceRoyalty') { v = raw === '' ? null : Number(raw); const mx = f === 'printRoyalty' ? 50 : 90; if (v != null && !(v >= 0 && v <= mx)) { $('cgBulkMsg').textContent = `${label}: 0 to ${mx}.`; return; } }
    if (f === 'licensable' || f === 'aiPreview') v = raw === 'yes';
    let skipped = [];
    await bulk(`${label} → ${raw === '' ? "artist's %" : $('cgMassV').selectedOptions?.[0]?.textContent || raw}`, async (p) => {
      if (f === 'licensable' && v) {
        if (!p.printKey) { skipped.push(`${p.code} (no full-size file)`); return; }
        if (p.artistId) { const ap = await artistProfile(p.artistId); if (ap?.allowLicences !== 'YES') { skipped.push(`${p.code} (artist hasn't agreed)`); return; } }
      }
      const patch = { [f]: v };
      if (f === 'kind' && (!p.medium || Object.values(MEDIUM).includes(p.medium))) patch.medium = MEDIUM[v];
      await upd(p, patch);
    });
    if (skipped.length) $('cgBulkMsg').textContent += ` Skipped: ${skipped.join(', ')}.`;
  };
  $('cgSaveAll').onclick = saveAll;
  $('cgDiscard').onclick = async () => { pending.clear(); saveBar(); $('cgSaveMsg').textContent = ''; await load(); };
  $('cgSold').onclick = () => bulk('Marking sold', (p) => upd(p, { status: 'SOLD' }));
  $('cgDraft').onclick = () => bulk('Taking off the website', (p) => upd(p, { status: 'DRAFT' }));
  $('cgHide').onclick = () => bulk('Hiding', (p) => upd(p, { status: 'HIDDEN' }));
  $('cgDelete').onclick = () => {
    if (!confirm(`Delete ${selected.size} work(s) and their photos? This can't be undone.`)) return;
    bulk('Deleting', async (p) => {
      const r = await client.models.Product.delete({ id: p.id });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      if (p.imageKey) { try { await remove({ path: p.imageKey }); } catch { /* photo already gone */ } }
    });
  };
  $('cgFiles').onchange = (e) => importPhotos([...e.target.files]).finally(() => { e.target.value = ''; });
  $('cgSite').onclick = importSite;
  $('cgLinksBtn').onclick = () => { $('cgLinksBox').hidden = false; $('cgLinks').focus(); };
  $('cgLinksClose').onclick = () => { $('cgLinksBox').hidden = true; };
  $('cgLinksGo').onclick = importLinks;
}

/** Shrink to max 1600 px JPEG so the website stays fast. */
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85));
  } catch { return file; }
}
const titleFrom = (name) => name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));

async function importPhotos(files) {
  const imgs = files.filter((f) => /^image\//.test(f.type));
  if (!imgs.length) return;
  let ok = 0;
  for (const [i, f] of imgs.entries()) {
    $('cgBulkMsg').textContent = `Importing ${i + 1}/${imgs.length}: ${f.name}`;
    try {
      const blob = await shrink(f);
      const key = `catalogue/${uid()}.jpg`;
      await uploadData({ path: key, data: blob, options: { contentType: 'image/jpeg' } }).result;
      const kind = /sketch|pencil/i.test(f.name) ? 'sketch' : 'water';
      const r = await client.models.Product.create({ title: titleFrom(f.name), kind, subject: 'land', medium: MEDIUM[kind], status: 'DRAFT', imageKey: key, source: `upload:${f.name}` });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      ok++;
    } catch (e) { console.error(e); }
  }
  $('cgBulkMsg').textContent = `Imported ${ok} of ${imgs.length} photos as drafts. Add titles and sizes, then publish or schedule them.`;
  $('cgFilter').value = 'DRAFT';
  await load();
}

/** One-off: copy the works built into the current website into the catalogue (published), with their photos. */
async function importSite() {
  $('cgBulkMsg').textContent = 'Reading the current website…';
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const m = html.match(/const PRODUCTS=(\[[\s\S]*?\]);\s*\n/);
    if (!m) throw new Error('the website list was not found');
    const site = JSON.parse(m[1]);
    const sm = html.match(/const SUBJ_OF=(\{[^}]*\})/);
    // eslint-disable-next-line no-new-func
    const subjOf = sm ? Function(`return ${sm[1]}`)() : {};
    const have = new Set(items.map((p) => p.source));
    let ok = 0, skip = 0;
    for (const [i, w] of site.entries()) {
      if (have.has(`site:${w.id}`)) { skip++; continue; }
      $('cgBulkMsg').textContent = `Copying ${i + 1}/${site.length}: ${w.name}`;
      const blob = await (await fetch(w.img)).blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const key = `catalogue/site-${w.id}.${ext}`;
      await uploadData({ path: key, data: blob, options: { contentType: blob.type || 'image/jpeg' } }).result;
      const r = await client.models.Product.create({ title: w.name, kind: w.kind === 'sketch' ? 'sketch' : 'water', subject: subjOf[w.id] || 'land', medium: w.medium, size: w.size, description: w.desc, priceAed: w.price || null, status: 'PUBLISHED', publishAt: now(), sortOrder: i, imageKey: key, source: `site:${w.id}` });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      ok++;
    }
    $('cgBulkMsg').textContent = `Copied ${ok} works from the website${skip ? ` (${skip} already in the catalogue)` : ''}. The website now shows the catalogue.`;
    await load();
  } catch (ex) {
    $('cgBulkMsg').textContent = `Could not copy the website works: ${ex.message}`;
  }
}

/** Import from links: expand album links into artworks on the server, then download a few at a time. */
const parse = (d) => (typeof d === 'string' ? JSON.parse(d) : d);
async function importLinks() {
  const text = $('cgLinks').value.trim();
  const btn = $('cgLinksGo');
  if (!text) { $('cgLinksMsg').textContent = 'Paste at least one link.'; return; }
  btn.disabled = true; $('cgLinksErr').textContent = ''; $('cgLinksMsg').textContent = 'Reading the links…';
  const errs = [];
  try {
    const ex = await client.mutations.catalogueImport({ mode: 'expand', links: text });
    if (ex.errors?.length) throw new Error(ex.errors[0].message);
    const { items = [], errors = [] } = parse(ex.data) || {};
    errs.push(...errors);
    if (!items.length) throw new Error(errors[0] || 'No artworks found in those links.');
    let done = 0, skipped = 0;
    for (let i = 0; i < items.length; i += 3) {
      const batch = items.slice(i, i + 3).map((it) => (it.title ? `${it.url}|${encodeURIComponent(it.title)}` : it.url));
      $('cgLinksMsg').textContent = `Importing ${Math.min(i + 3, items.length)} of ${items.length}…`;
      const r = await client.mutations.catalogueImport({ mode: 'import', links: batch.join('\n') });
      if (r.errors?.length) { errs.push(r.errors[0].message); continue; }
      const out = parse(r.data) || {};
      done += (out.done || []).length; skipped += (out.skipped || []).length; errs.push(...(out.errors || []));
      if (errs.some((e) => /blocked/i.test(e)) && !done) break;
    }
    $('cgLinksMsg').textContent = `Imported ${done} as drafts${skipped ? `, ${skipped} already in the catalogue` : ''}${errs.length ? `, ${errs.length} problem(s)` : ''}.`;
    $('cgFilter').value = 'DRAFT';
    await load();
  } catch (ex) {
    $('cgLinksMsg').textContent = 'Import stopped.';
    errs.unshift(ex.message || String(ex));
  } finally {
    btn.disabled = false;
    $('cgLinksErr').textContent = [...new Set(errs)].slice(0, 8).join('\n');
  }
}


/** Finds thin dark lines / borders along the picture's edges (scan artefacts) and returns the trimmed picture, or null. */
async function cleanEdges(key) {
  const url = (await getUrl({ path: key, options: { expiresIn: 600 } })).url.toString();
  const blob = await (await fetch(url)).blob();
  const bm = await createImageBitmap(blob);
  const W = bm.width, H = bm.height, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bm, 0, 0);
  const px = cx.getImageData(0, 0, W, H).data;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
  const col = (x) => { let s = 0, n = 0; for (let y = 0; y < H; y += 2) { s += lum(x, y); n++; } return s / n; };
  const row = (y) => { let s = 0, n = 0; for (let x = 0; x < W; x += 2) { s += lum(x, y); n++; } return s / n; };
  // From each edge inwards: skip lines clearly darker than the area just inside (max 4% of the side).
  const scan = (len, f, from, dir) => {
    const max = Math.max(2, Math.floor(len * 0.04));
    const inner = [6, 8, 10, 12].map((k) => f(from + dir * (max + k))).reduce((a, b) => a + b, 0) / 4;
    let cut = 0;
    for (let k = 0; k < max; k++) if (f(from + dir * k) < inner - 35) cut = k + 1;
    return cut ? cut + 1 : 0; // one more pixel for the soft edge of the line
  };
  const l = scan(W, col, 0, 1), r = scan(W, col, W - 1, -1), t = scan(H, row, 0, 1), b = scan(H, row, H - 1, -1);
  bm.close?.();
  if (!l && !r && !t && !b) return null;
  const out = document.createElement('canvas'); out.width = W - l - r; out.height = H - t - b;
  out.getContext('2d').drawImage(cv, l, t, out.width, out.height, 0, 0, out.width, out.height);
  const what = [l && `${l}px left`, r && `${r}px right`, t && `${t}px top`, b && `${b}px bottom`].filter(Boolean).join(', ');
  return { what, blob: await new Promise((ok) => out.toBlob(ok, 'image/jpeg', 0.92)) };
}
