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
    draw();
  } catch (ex) {
    $('cgList').innerHTML = `<p class="err">Could not load the catalogue: ${esc(ex.message)}</p>`;
  }
}

function filtered() {
  const f = $('cgFilter').value, q = $('cgSearch').value.trim().toLowerCase();
  return items.filter((p) => (!f || state(p) === f) && (!q || `${p.title} ${p.size} ${p.description}`.toLowerCase().includes(q)));
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
  return `<article class="cg-row ${selected.has(p.id) ? 'sel' : ''}" data-id="${esc(p.id)}">
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
      <span class="cg-saved muted" aria-live="polite"></span>
    </div>
  </article>`;
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
        const patch = { id: p.id, [f]: v };
        if (f === 'title') patch.named = `Studio ${new Date().toISOString()}`;
        if (f === 'kind' && (!p.medium || Object.values(MEDIUM).includes(p.medium))) patch.medium = MEDIUM[v];
        const msg = el.querySelector('.cg-saved'); msg.textContent = 'Saving…';
        const r = await client.models.Product.update(patch);
        if (r.errors?.length) { msg.textContent = 'Not saved: ' + r.errors[0].message; return; }
        Object.assign(p, r.data || patch);
        if (patch.medium) el.querySelector('[data-f="medium"]').value = patch.medium;
        msg.textContent = 'Saved';
        setTimeout(() => { msg.textContent = ''; }, 1500);
      };
    });
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
  $('cgReload').onclick = load;
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
