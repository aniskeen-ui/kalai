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
  if (!wired) { wired = true; $('prNew').onclick = () => edit(null); $('prFind').addEventListener('input', draw); $('vNew').onclick = () => vEdit(null); }
  await load();
  await vLoad();
}

/* ---------- Private codes & gift cards (Voucher: studio only, never public) ---------- */
let vouchers = [];
const redeemLink = (code) => `https://art.pranixtechno.com/#redeem=${encodeURIComponent(code)}`;
let qrLib = null;
const loadQr = () => (qrLib ||= new Promise((ok, no) => { if (window.qrcode) { ok(window.qrcode); return; } const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; s.onload = () => ok(window.qrcode); s.onerror = () => no(new Error('QR library not loaded')); document.head.appendChild(s); }));
async function qrSvg(text, cell = 4) { const q = (await loadQr())(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell, margin: 2, scalable: true }); }
async function qrDataUrl(text, cell = 8) { const q = (await loadQr())(0, 'M'); q.addData(text); q.make(); return q.createDataURL(cell, 2); }
/** A gift card / voucher image (PNG) with the QR code: to send or print. */
async function cardPng(v) {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 560; const g = c.getContext('2d');
  g.fillStyle = '#1e4d2b'; g.fillRect(0, 0, 1000, 560); g.fillStyle = '#c9a24a'; g.fillRect(0, 520, 1000, 40);
  g.fillStyle = '#ffffff'; g.font = '600 46px Georgia, serif'; g.fillText('KALAI', 56, 96); g.font = '20px Arial'; g.fillStyle = '#c9dca4'; g.fillText('ART HOUSE · DUBAI', 200, 94);
  g.fillStyle = '#ffffff'; g.font = '700 54px Arial'; g.fillText(v.kind === 'GIFT' ? `Gift card  AED ${Number(v.value || 0).toLocaleString('en-US')}` : `${v.discountType === 'AED' ? `AED ${v.discountValue}` : `${v.discountValue}%`} off`, 56, 210);
  g.font = '26px Arial'; g.fillStyle = '#e8efe0'; if (v.forName) g.fillText(`For ${v.forName}`, 56, 262);
  g.font = '700 40px monospace'; g.fillStyle = '#ffffff'; g.fillText(v.code, 56, 350);
  g.font = '22px Arial'; g.fillStyle = '#e8efe0'; g.fillText(`Valid until ${v.endAt ? day(v.endAt) : '—'}`, 56, 398);
  g.fillText('Scan the QR or enter the code under My enquiries & orders', 56, 446); g.fillText('on art.pranixtechno.com', 56, 478);
  const img = new Image(); img.src = await qrDataUrl(redeemLink(v.code), 8); await img.decode();
  g.fillStyle = '#ffffff'; g.fillRect(690, 150, 270, 270); g.drawImage(img, 700, 160, 250, 250);
  return c.toDataURL('image/png');
}
const genCode = (pre) => `${pre}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})/, '$1-')}`;
async function vLoad() {
  $('vList').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await client.models.Voucher.list({ limit: 1000 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    vouchers = (r.data || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    vDraw();
  } catch (ex) { $('vList').innerHTML = `<p class="err">Could not load private codes: ${esc(ex.message)}</p>`; }
}
function vState(v) {
  const now = new Date().toISOString();
  if (!v.active) return ['Off', 'HIDDEN'];
  if (v.endAt && v.endAt < now) return ['Expired', 'HIDDEN'];
  if (v.kind === 'GIFT' ? !(Number(v.balance) > 0) : v.maxUses && (v.usedCount || 0) >= v.maxUses) return ['Used up', 'HIDDEN'];
  return ['Active', 'PUBLISHED'];
}
const vWhat = (v) => (v.kind === 'GIFT' ? `Gift card ⃃ ${Number(v.value || 0).toLocaleString('en-US')} · balance <b>⃃ ${Number(v.balance || 0).toLocaleString('en-US')}</b>`
  : `${v.discountType === 'AED' ? `⃃ ${v.discountValue}` : `${v.discountValue}%`} off · ${AREA[v.appliesTo || 'ALL']}${v.minOrder ? ` · min ⃃ ${v.minOrder}` : ''} · used ${v.usedCount || 0}${v.maxUses ? ` of ${v.maxUses}` : ''}`);
const vShare = (v) => `Hello${v.forName ? ` ${v.forName.split(' ')[0]}` : ''}, here is your ${v.kind === 'GIFT' ? `Kalai Art House gift card worth AED ${v.value}` : `private Kalai Art House code for ${v.discountType === 'AED' ? `AED ${v.discountValue}` : `${v.discountValue}%`} off`}: ${v.code}${v.endAt ? ` (valid until ${day(v.endAt)})` : ''}. Choose an artwork on art.pranixtechno.com; once we send you the price, open My enquiries & orders and enter the code on your order.`;
function vDraw() {
  $('vList').innerHTML = vouchers.length ? vouchers.map((v) => {
    const [label, cls] = vState(v);
    let uses = []; try { uses = JSON.parse(v.uses || '[]'); } catch { uses = []; }
    return `<article class="mk-card" data-v="${esc(v.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b class="mono" style="font-size:16px">${esc(v.code)}</b><span class="cg-badge ${cls}">${label}</span><span class="chip">${v.kind === 'GIFT' ? 'Gift card' : 'Private code'}</span>
        <span class="muted" style="margin-left:auto">${v.forName ? `for <b>${esc(v.forName)}</b>` : ''}${v.forEmail ? ` · only ${esc(v.forEmail)}` : ''} · ${v.endAt ? `until ${esc(day(v.endAt))}` : 'no expiry'}</span></div>
      <div class="muted">${vWhat(v)}${v.note ? ` · ${esc(v.note)}` : ''}</div>
      ${uses.length ? `<div class="muted" style="font-size:12px">Used on: ${uses.slice(-6).map((u) => `${esc(u.ref)} ${u.back ? '(given back)' : `⃃ ${u.amount}`}`).join(' · ')}</div>` : ''}
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div class="vqr" data-qr="${esc(v.code)}" style="width:110px;height:110px;background:#fff;border-radius:6px"></div><div class="muted" style="font-size:12px;max-width:420px">The QR opens <span class="mono">art.pranixtechno.com</span> with this code ready in My enquiries &amp; orders. Send the card picture, or the code.</div></div>
      <div class="mk-act"><button class="btn small ghost" type="button" data-va="copy">Copy code</button><a class="btn small ghost" target="_blank" rel="noopener" href="https://wa.me/${String(v.forPhone || '').replace(/[^\d]/g, '').replace(/^0(?=5)/, '971')}?text=${encodeURIComponent(vShare(v) + ' ' + redeemLink(v.code))}">WhatsApp</a>${v.forEmail ? `<a class="btn small ghost" href="mailto:${esc(v.forEmail)}?subject=${encodeURIComponent(v.kind === 'GIFT' ? 'Your Kalai Art House gift card' : 'Your Kalai Art House code')}&body=${encodeURIComponent(vShare(v) + '\n\n' + redeemLink(v.code))}">Email</a>` : ''}${v.forPhone ? `<a class="btn small ghost" href="tel:${esc(v.forPhone)}">Call</a>` : ''}<button class="btn small ghost" type="button" data-va="png">Download card (with QR)</button><button class="btn small ghost" type="button" data-va="edit">Edit</button><button class="btn small ghost" type="button" data-va="toggle">${v.active ? 'Switch off' : 'Switch on'}</button>${(v.usedCount || 0) ? '' : '<button class="btn small ghost" type="button" data-va="del">Delete</button>'}<span class="muted" data-vm style="font-size:12px"></span></div>
    </article>`;
  }).join('') : '<p class="muted">No private codes or gift cards yet.</p>';
  document.querySelectorAll('#vList [data-qr]').forEach(async (el) => { try { el.innerHTML = await qrSvg(redeemLink(el.dataset.qr), 3); } catch { el.textContent = 'QR not available'; } });
  document.querySelectorAll('#vList [data-va]').forEach((b) => {
    const v = vouchers.find((x) => x.id === b.closest('[data-v]').dataset.v), m = b.closest('[data-v]').querySelector('[data-vm]');
    b.onclick = async () => {
      const a = b.dataset.va;
      if (a === 'copy') { try { await navigator.clipboard.writeText(v.code); m.textContent = 'Copied.'; } catch { m.textContent = v.code; } return; }
      if (a === 'edit') { vEdit(v); return; }
      if (a === 'png') { try { const url = await cardPng(v); const l = document.createElement('a'); l.href = url; l.download = `${v.code}.png`; l.click(); m.textContent = 'Downloaded: attach it on WhatsApp or email.'; } catch (ex) { m.textContent = ex.message; } return; }
      if (a === 'del' && !b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Delete for good?'; return; }
      b.disabled = true;
      const r = a === 'del' ? await client.models.Voucher.delete({ id: v.id }) : await client.models.Voucher.update({ id: v.id, active: !v.active });
      if (r.errors?.length) { m.textContent = r.errors[0].message; b.disabled = false; return; }
      await vLoad();
    };
  });
}
function vEdit(v) {
  const x = v || { kind: 'CODE', code: genCode('KAL'), discountType: 'PCT', discountValue: 10, maxUses: 1, appliesTo: 'ALL', active: true };
  $('vForm').innerHTML = `<div class="mk-card" style="display:grid;gap:10px;margin-bottom:10px"><h3>${v ? 'Edit' : 'New'} private code / gift card</h3>
    <div class="three"><div class="field"><label for="vKind">Type</label><select id="vKind" ${v ? 'disabled' : ''}><option value="CODE" ${x.kind !== 'GIFT' ? 'selected' : ''}>Private discount code</option><option value="GIFT" ${x.kind === 'GIFT' ? 'selected' : ''}>Gift card / voucher (⃃ balance)</option></select></div>
      <div class="field"><label for="vCode">Code</label><div style="display:flex;gap:6px"><input id="vCode" class="mono" maxlength="30" value="${esc(x.code)}" ${v && (v.usedCount || 0) ? 'readonly' : ''}><button type="button" class="btn small ghost" id="vGen" ${v ? 'hidden' : ''}>New</button></div></div>
      <div class="field"><label for="vEnd">Valid until <span style="color:var(--kumkum)">*</span></label><input id="vEnd" type="date" required value="${esc(localDate(x.endAt) || localDate(new Date(Date.now() + (x.kind === 'GIFT' ? 365 : 90) * 864e5).toISOString()))}"></div></div>
    <div class="three" id="vCodeRow"><div class="field"><label for="vType">Discount</label><select id="vType"><option value="PCT" ${x.discountType !== 'AED' ? 'selected' : ''}>% off</option><option value="AED" ${x.discountType === 'AED' ? 'selected' : ''}>⃃ off</option></select></div>
      <div class="field"><label for="vVal">Amount</label><input id="vVal" type="number" min="1" step="0.5" value="${esc(x.discountValue ?? '')}"></div>
      <div class="field"><label for="vMax">Number of orders (blank = no limit)</label><input id="vMax" type="number" min="1" step="1" value="${esc(x.maxUses ?? '')}"></div></div>
    <div class="three" id="vGiftRow"><div class="field"><label for="vValue">Gift card value (⃃)</label><input id="vValue" type="number" min="1" step="1" value="${esc(x.value ?? '')}" ${v && x.kind === 'GIFT' && (v.usedCount || 0) ? 'readonly' : ''}></div>
      <div class="field"><label>Balance</label><div class="muted" style="padding-top:8px">${x.kind === 'GIFT' && v ? `⃃ ${Number(x.balance || 0).toLocaleString('en-US')}` : 'starts at the full value'}</div></div><div></div></div>
    <div class="three"><div class="field"><label for="vArea">Use on</label><select id="vArea">${Object.entries(AREA).map(([k, n]) => `<option value="${k}" ${k === (x.appliesTo || 'ALL') ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field"><label for="vMin">Minimum order (⃃, optional)</label><input id="vMin" type="number" min="0" step="1" value="${esc(x.minOrder ?? '')}"></div><div></div></div>
    <div class="three"><div class="field"><label for="vFor">Given to (name)</label><input id="vFor" maxlength="80" value="${esc(x.forName)}" placeholder="e.g. Priya Raman"></div>
      <div class="field"><label for="vPhone">Mobile / WhatsApp (optional)</label><input id="vPhone" type="tel" maxlength="30" value="${esc(x.forPhone)}" placeholder="+971 50 123 4567"></div>
      <div class="field"><label for="vEmail">Email (optional: only this email can use it)</label><input id="vEmail" type="email" maxlength="120" value="${esc(x.forEmail)}" placeholder="their sign-in email"></div>
      <div class="field"><label for="vNote">Note (only you see it)</label><input id="vNote" maxlength="200" value="${esc(x.note)}" placeholder="e.g. friend of Siva, birthday gift"></div></div>
    <div style="display:flex;gap:8px;align-items:center"><button class="btn" type="button" id="vSave">Save</button><button class="btn ghost" type="button" id="vCancel">Cancel</button><span class="err" id="vMsg"></span></div></div>`;
  const kind = () => $('vKind').value;
  const sw = () => { $('vCodeRow').hidden = kind() === 'GIFT'; $('vGiftRow').hidden = kind() !== 'GIFT'; if (!v) $('vCode').value = genCode(kind() === 'GIFT' ? 'GIFT' : 'KAL'); };
  $('vKind').onchange = sw; sw(); if (v) { $('vCodeRow').hidden = x.kind === 'GIFT'; $('vGiftRow').hidden = x.kind !== 'GIFT'; $('vCode').value = x.code; }
  $('vGen').onclick = () => { $('vCode').value = genCode(kind() === 'GIFT' ? 'GIFT' : 'KAL'); };
  $('vCancel').onclick = () => { $('vForm').innerHTML = ''; };
  $('vSave').onclick = async () => {
    const msg = $('vMsg'); msg.textContent = '';
    const code = $('vCode').value.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{4,30}$/.test(code)) { msg.textContent = 'Code: 4–30 letters, numbers or dashes.'; return; }
    if (vouchers.some((o) => o.code === code && o.id !== v?.id) || list.some((p) => String(p.code || '').toUpperCase() === code)) { msg.textContent = 'This code is already used by another code or offer.'; return; }
    const gift = (v ? x.kind : kind()) === 'GIFT';
    const email = $('vEmail').value.trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Check the email address.'; return; }
    const endD = $('vEnd').value;
    if (!endD) { msg.textContent = 'Every code needs a validity date (Valid until).'; return; }
    const endAt = new Date(`${endD}T23:59:59+04:00`).toISOString();
    if (endAt < new Date().toISOString()) { msg.textContent = 'Valid until is in the past.'; return; }
    const rec = { code, appliesTo: $('vArea').value, minOrder: $('vMin').value ? Number($('vMin').value) : null, forName: $('vFor').value.trim() || null, forEmail: email || null, forPhone: $('vPhone').value.trim() || null, note: $('vNote').value.trim() || null, endAt };
    if (gift) {
      const val = Number($('vValue').value);
      if (!(val > 0)) { msg.textContent = 'Enter the gift card value.'; return; }
      Object.assign(rec, { kind: 'GIFT', value: val });
      if (!v) rec.balance = val; else if (!(v.usedCount || 0)) rec.balance = val;
    } else {
      const val = Number($('vVal').value);
      if (!(val > 0) || ($('vType').value === 'PCT' && val > 90)) { msg.textContent = 'Enter the discount (1–90 %, or ⃃).'; return; }
      Object.assign(rec, { kind: 'CODE', discountType: $('vType').value, discountValue: val, maxUses: $('vMax').value ? Number($('vMax').value) : null });
    }
    $('vSave').disabled = true;
    try {
      const r = v ? await client.models.Voucher.update({ id: v.id, ...rec }) : await client.models.Voucher.create({ ...rec, active: true, usedCount: 0, uses: '[]' });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      $('vForm').innerHTML = ''; await vLoad();
    } catch (ex) { msg.textContent = ex.message; $('vSave').disabled = false; }
  };
  $('vForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const off = p.code ? `${p.discountType === 'AED' ? `⃃ ${p.discountValue}` : `${p.discountValue}%`} off · ${AREA[p.appliesTo || 'ALL']}${p.minOrder ? ` · min ⃃ ${p.minOrder}` : ''}` : 'No code (banner / page only)';
    return `<article class="mk-card" data-p="${esc(p.id)}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono muted" style="font-size:12px">${esc(p.number || 'PR-…')}</span><h3>${esc(p.title)}</h3><span class="cg-badge ${cls}">${label}</span>${p.showBanner ? '<span class="cg-badge">Banner</span>' : ''}${p.code ? `<span class="cg-badge" style="font-family:var(--mono)">${esc(p.code)}</span>` : ''}
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
  // Re-use: a new offer (new PR number) pre-filled from a saved one; dates are left for you to set.
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
        <div class="field"><label for="pfType">Discount</label><select id="pfType"><option value="PCT" ${x.discountType !== 'AED' ? 'selected' : ''}>% off</option><option value="AED" ${x.discountType === 'AED' ? 'selected' : ''}>⃃ off</option></select></div>
        <div class="field"><label for="pfValue">Amount</label><input id="pfValue" type="number" min="0" step="0.5" value="${esc(x.discountValue ?? '')}"></div></div>
      <div class="three"><div class="field"><label for="pfArea">Applies to</label><select id="pfArea">${Object.entries(AREA).map(([k, v]) => `<option value="${k}" ${k === (x.appliesTo || 'ALL') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="pfMin">Minimum order (⃃, optional)</label><input id="pfMin" type="number" min="0" step="1" value="${esc(x.minOrder ?? '')}"></div>
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
      : code && !$('pfEnd').value ? 'Every discount code needs an end date (validity).'
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
      if (!editing) await client.mutations.assignCodes().catch(() => {}); // gives the new offer its PR number
      $('prEdit').hidden = true; $('prEdit').innerHTML = '';
      await load();
    } catch (ex) { $('pfMsg').textContent = ex.message; $('pfSave').disabled = false; }
  };
  $('prEdit').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
