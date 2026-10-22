// Offers tab (Order Management): website banner, the Offers page, and discount codes.
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const AREA = { ALL: 'All orders', ART: 'Artworks & commissions', CRAFTS: 'Crafts shop', GIFT: 'Little Artists' };
const localDate = (iso) => (iso ? new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 10) : '');
let list = [];
let editing = null;
let wired = false;
let numbered = false;

function state(p, now = new Date().toISOString()) {
  if (!p.active) return ['Off', 'HIDDEN'];
  if (p.startAt && p.startAt > now) return ['Scheduled', 'SCHEDULED'];
  if (p.endAt && p.endAt < now) return ['Ended', 'HIDDEN'];
  return ['Live', 'PUBLISHED'];
}

export async function showPromotions() {
  if (!wired) { wired = true; $('prNew').onclick = () => edit(null); $('prFind').addEventListener('input', draw); }
  await load();
}
async function load() {
  $('prList').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await client.models.Promotion.list({ limit: 500 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    list = (r.data || []).sort((a, b) => String(b.number || b.createdAt).localeCompare(String(a.number || a.createdAt)));
    if (list.some((p) => !p.number) && !numbered) { numbered = true; client.mutations.assignCodes().then(load).catch(() => {}); }
    draw();
  } catch (ex) { $('prList').innerHTML = `<p class="err">Could not load offers: ${esc(ex.message)}</p>`; }
}
function draw() {
  const q = ($('prFind')?.value || '').trim().toLowerCase();
  const shown = list.filter((p) => !q || [p.number, p.title, p.code, p.bannerText].some((v) => String(v || '').toLowerCase().includes(q)));
  $('prList').innerHTML = shown.length ? shown.map((p) => {
    const [label, cls] = state(p);
    const off = p.code ? `${p.discountType === 'AED' ? `AED ${p.discountValue}` : `${p.discountValue}%`} off · ${AREA[p.appliesTo || 'ALL']}${p.minOrder ? ` · min AED ${p.minOrder}` : ''}` : 'No code (banner / page only)';
    return `<article class="mk-card" data-p="${esc(p.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono muted" style="font-size:12px">${esc(p.number || 'PRM-…')}</span><h3>${esc(p.title)}</h3><span class="cg-badge ${cls}">${label}</span>${p.showBanner ? '<span class="cg-badge">Banner</span>' : ''}${p.code ? `<span class="cg-badge" style="font-family:var(--mono)">${esc(p.code)}</span>` : ''}
        <span class="muted" style="margin-left:auto">${p.startAt ? esc(day(p.startAt)) : 'now'} → ${p.endAt ? esc(day(p.endAt)) : 'no end'}</span></div>
      <div class="muted">${esc(off)} · used ${p.usedCount ?? 0}${p.maxUses ? ` of ${p.maxUses}` : ''} time(s)${p.copiedFrom ? ` · re-used from ${esc(p.copiedFrom)}` : ''}</div>
      ${p.bannerText ? `<div style="font-size:13px">Banner: “${esc(p.bannerText)}”</div>` : ''}
      <div class="mk-act"><button class="btn small ghost" type="button" data-a="edit">Edit</button><button class="btn small ghost" type="button" data-a="reuse" title="Start a new offer from this one (new number, new dates)">Re-use</button><button class="btn small ghost" type="button" data-a="toggle">${p.active ? 'Switch off' : 'Switch on'}</button><a class="btn small ghost" href="/offers.html#o-${esc(p.id)}" target="_blank" rel="noopener">View on Offers page</a></div>
    </article>`;
  }).join('') : `<p class="muted">${list.length ? 'No offer matches your search.' : 'No offers yet. Click <b>New offer</b>.'}</p>`;
  document.querySelectorAll('#prList [data-a]').forEach((b) => {
    const p = list.find((x) => x.id === b.closest('[data-p]').dataset.p);
    b.onclick = async () => {
      if (b.dataset.a === 'edit') { edit(p); return; }
      if (b.dataset.a === 'reuse') { edit(p, true); return; }
      b.disabled = true;
      const r = await client.models.Promotion.update({ id: p.id, active: !p.active });
      if (r.errors?.length) { alert(r.errors[0].message); b.disabled = false; return; }
      await load();
    };
  });
}
function edit(p, reuse = false) {
  // Re-use: a new offer (new PRM number) pre-filled from a saved one; dates are left for you to set.
  editing = reuse ? null : p;
  const base = reuse ? { ...p, startAt: new Date().toISOString(), endAt: '', active: true, copiedFrom: p.number || p.title } : null;
  const x = base || p || { title: '', bannerText: '', showBanner: true, details: '', code: '', discountType: 'PCT', discountValue: 10, minOrder: null, appliesTo: 'ALL', startAt: new Date().toISOString(), endAt: '', active: true, maxUses: null };
  $('prEdit').hidden = false;
  $('prEdit').innerHTML = `<div class="mk-card" style="gap:10px">
    <h3>${reuse ? `New offer, re-using ${esc(p.number || p.title)}` : p ? `Edit offer ${esc(p.number || '')}` : 'New offer'}</h3>
    ${reuse ? '<div class="muted" style="font-size:12px">Everything is copied: change the dates (and the text or code if needed), then save. The original stays in the list as it was.</div>' : ''}
    <div class="field"><label for="pfTitle">Offer title (Offers page)</label><input id="pfTitle" maxlength="100" value="${esc(x.title)}" placeholder="Diwali offer: 10% off original artworks"></div>
    <div class="field"><label for="pfDetails">Details on the Offers page</label><textarea id="pfDetails" rows="4" maxlength="2000" placeholder="What's included, until when, any conditions">${esc(x.details)}</textarea></div>
    <div class="field"><label>Picture (optional)</label><div style="display:flex;gap:10px;align-items:center"><img id="pfImg" alt="" style="width:120px;height:80px;object-fit:cover;border-radius:4px;background:var(--sunk)" ${x.imageKey ? '' : 'hidden'}><label class="btn small ghost" style="cursor:pointer">Upload picture<input id="pfFile" type="file" accept="image/*" hidden></label><span class="muted" id="pfImgMsg" style="font-size:12px"></span></div></div>
    <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="pfBanner" style="width:auto" ${x.showBanner ? 'checked' : ''}> Show as a banner across the top of the website</label>
    <div class="field"><label for="pfBannerText">Banner text (short)</label><input id="pfBannerText" maxlength="120" value="${esc(x.bannerText)}" placeholder="Diwali offer: 10% off all original artworks till 5 Nov"></div>
    <fieldset class="cost"><legend>Discount code (optional)</legend>
      <div class="three"><div class="field"><label for="pfCode">Code</label><input id="pfCode" maxlength="30" value="${esc(x.code)}" placeholder="DIWALI10" style="text-transform:uppercase;font-family:var(--mono)"></div>
        <div class="field"><label for="pfType">Discount</label><select id="pfType"><option value="PCT" ${x.discountType !== 'AED' ? 'selected' : ''}>% off</option><option value="AED" ${x.discountType === 'AED' ? 'selected' : ''}>AED off</option></select></div>
        <div class="field"><label for="pfValue">Amount</label><input id="pfValue" type="number" min="0" step="0.5" value="${esc(x.discountValue ?? '')}"></div></div>
      <div class="three"><div class="field"><label for="pfArea">Applies to</label><select id="pfArea">${Object.entries(AREA).map(([k, v]) => `<option value="${k}" ${k === (x.appliesTo || 'ALL') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="pfMin">Minimum order (AED, optional)</label><input id="pfMin" type="number" min="0" step="1" value="${esc(x.minOrder ?? '')}"></div>
        <div class="field"><label for="pfMax">Max uses (optional)</label><input id="pfMax" type="number" min="0" step="1" value="${esc(x.maxUses ?? '')}"></div></div>
      <div class="muted" style="font-size:12px">Customers type the code under the price in My enquiries &amp; orders (or in the Crafts shop order form). The discount comes off the price, the Ziina link and the Zoho invoice. On Crafts shop items Kalai absorbs the discount: the maker still gets their full price.</div>
    </fieldset>
    <div class="three"><div class="field"><label for="pfStart">Starts</label><input id="pfStart" type="date" value="${esc(localDate(x.startAt))}"></div>
      <div class="field"><label for="pfEnd">Ends (inclusive)</label><input id="pfEnd" type="date" value="${esc(x.endAt ? localDate(new Date(new Date(x.endAt).getTime() - 1000).toISOString()) : '')}"></div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;align-self:end"><input type="checkbox" id="pfActive" style="width:auto" ${x.active ? 'checked' : ''}> On</label></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn" type="button" id="pfSave">Save offer</button><button class="btn ghost" type="button" id="pfCancel">Close</button><span class="err" id="pfMsg"></span></div>
  </div>`;
  let imageKey = x.imageKey || '';
  if (imageKey) getUrl({ path: imageKey, options: { expiresIn: 900 } }).then((u) => { $('pfImg').src = u.url.toString(); }).catch(() => {});
  $('pfFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    $('pfImgMsg').textContent = 'Uploading…';
    try {
      const r = await uploadData({ path: `catalogue/promo/${Date.now()}-${f.name.replace(/[^\w.-]+/g, '_')}`, data: f, options: { contentType: f.type } }).result;
      imageKey = r.path; $('pfImg').src = URL.createObjectURL(f); $('pfImg').hidden = false; $('pfImgMsg').textContent = '';
    } catch (ex) { $('pfImgMsg').textContent = 'Upload failed: ' + ex.message; }
  };
  $('pfCancel').onclick = () => { $('prEdit').hidden = true; $('prEdit').innerHTML = ''; };
  $('pfSave').onclick = async () => {
    const code = $('pfCode').value.trim().toUpperCase().replace(/\s+/g, '');
    const v = Number($('pfValue').value);
    const why = !$('pfTitle').value.trim() ? 'Give the offer a title.'
      : $('pfBanner').checked && !$('pfBannerText').value.trim() ? 'Write the banner text, or untick the banner.'
      : code && !/^[A-Z0-9-]{3,30}$/.test(code) ? 'Codes use letters, numbers and dashes (3 to 30).'
      : code && !(v > 0) ? 'Enter the discount amount.'
      : code && $('pfType').value === 'PCT' && v > 90 ? 'A % discount must be 90 or less.'
      : code && $('pfActive').checked && list.some((o) => o.code === code && o.id !== editing?.id && o.active && (!o.endAt || o.endAt >= new Date().toISOString())) ? `Offer ${list.find((o) => o.code === code && o.id !== editing?.id && o.active)?.number || ''} is still on with this code: switch it off first, or use another code.`
      : $('pfStart').value && $('pfEnd').value && $('pfEnd').value < $('pfStart').value ? 'The end date is before the start date.' : '';
    if (why) { $('pfMsg').textContent = why; return; }
    const rec = {
      title: $('pfTitle').value.trim(), details: $('pfDetails').value.trim() || null, imageKey: imageKey || null,
      showBanner: $('pfBanner').checked, bannerText: $('pfBannerText').value.trim() || null,
      code: code || null, discountType: $('pfType').value, discountValue: code ? v : null, appliesTo: $('pfArea').value,
      minOrder: $('pfMin').value ? Number($('pfMin').value) : null, maxUses: $('pfMax').value ? Math.floor(Number($('pfMax').value)) : null,
      startAt: $('pfStart').value ? new Date(`${$('pfStart').value}T00:00:00+04:00`).toISOString() : new Date().toISOString(),
      endAt: $('pfEnd').value ? new Date(`${$('pfEnd').value}T23:59:59+04:00`).toISOString() : null,
      active: $('pfActive').checked,
    };
    $('pfSave').disabled = true; $('pfMsg').textContent = '';
    try {
      const r = editing ? await client.models.Promotion.update({ id: editing.id, ...rec })
        : await client.models.Promotion.create({ ...rec, usedCount: 0, sortOrder: 0, ...(x.copiedFrom ? { copiedFrom: x.copiedFrom } : {}) });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      if (!editing) await client.mutations.assignCodes().catch(() => {}); // gives the new offer its PRM number
      $('prEdit').hidden = true; $('prEdit').innerHTML = '';
      await load();
    } catch (ex) { $('pfMsg').textContent = ex.message; $('pfSave').disabled = false; }
  };
  $('prEdit').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
