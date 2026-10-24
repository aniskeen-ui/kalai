// Settings tab: website master (one SiteSetting row, id "site"). The home page reads it on every visit.
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl, remove } from 'aws-amplify/storage';

const ROOM_KEY = 'catalogue/site/room.jpg'; // the room photo for "On a wall" (public read)

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Little Artists shipping zones outside the UAE (the website maps each country to one).
// Framed prints: sizes and starting prices (⃃, delivered in the UAE): framed, and print only.
export const PHOTO_SIZES = [['A4', 'A4 (21 × 30 cm)', 169, 59], ['A3', 'A3 (30 × 42 cm)', 249, 79], ['40×50', '40 × 50 cm', 299, 99], ['50×70', '50 × 70 cm', 399, 139], ['60×80', '60 × 80 cm', 499, 179]];
const SHIP_ZONES = [['A', 'GCC (Saudi Arabia, Oman, Qatar, Bahrain, Kuwait)'], ['B', 'South Asia (India, Sri Lanka, Pakistan, Bangladesh, Nepal, Maldives, Bhutan)'], ['C', 'UK and Europe'], ['D', 'USA, Canada, Australia, New Zealand'], ['E', 'Rest of the world']];
// Customer emails by event (the website emails the customer at each step; untick to stop one).
const MAILS = [['RECEIVED', 'Enquiry or order received'], ['PRICE_SENT', 'Price sent (with the payment link)'], ['PAID', 'Payment received'], ['ARTIST_STARTED', 'The artist has started (paintings and sketches)'],
  ['FRAMING', 'Being framed'], ['SHIPPED', 'Shipped (courier and tracking number)'], ['DELIVERED', 'Delivered (with the rating link)'], ['CANCELLED', 'Cancelled'],
  ['REQUEST', 'Cancellation or damage request received'], ['DECLINED', 'Request declined'], ['PICKUP', 'Return pickup booked'], ['REPLACEMENT', 'Replacement under way'],
  ['REFUND', 'Refund sent'], ['REFUNDED', 'Order closed as refunded (when no refund email went)'], ['RECEIVED_AGAIN', 'Enquiry reopened']];
const LAUNCH_DEF = 'Opening soon: explore the collection and send us your enquiries now. Orders and online payment open shortly.';
const FIELDS = [
  { k: 'heroSeconds', label: 'Home page picture', note: 'The big picture at the top of the home page changes to another artwork, picked at random, every this many seconds. 0 = never changes.', min: 0, max: 600 },
  { k: 'kuralHour', label: 'Thirukkural of the day: publish at (hour, Dubai time, 0–23)', unit: '', note: 'The new kural goes up every day at this hour, e.g. 6 = 6 am, 0 = midnight. Until then the website shows yesterday\'s.', min: 0, max: 23, def: 6 },
  { k: 'kuralSeconds', label: 'Thirukkural card language', note: 'The daily Thirukkural card switches Tamil → English → Arabic every this many seconds. 0 = stays in Tamil (visitors can still switch).', min: 0, max: 600 },
];
// Home page texts. Blank = the built-in text (shown as the grey example).
const TEXTS = [
  { k: 'heroLines', group: 'Top of the home page', label: 'Headlines: one per line, put | before the gold part. With more than one, they take turns with the picture.', max: 1500, rows: 5, def: 'Original watercolours and pencil sketches, | painted for your walls' },
  { k: 'heroText', group: 'Top of the home page', label: 'Text under the headline', max: 400, rows: 3, def: 'Hand-painted originals and commissioned portraits of your pets, home and family, by artists in Kerala and Tamil Nadu. Priced in dirhams, delivered across the UAE with customs and duties already included.' },
  { k: 'kidsTitle', group: 'Little Artists section', label: 'Heading: one per line. With more than one, they take turns (same seconds as the picture).', max: 600, rows: 3, def: 'You remember every first.' },
  { k: 'kidsText', group: 'Little Artists section', label: 'Story (leave an empty line between paragraphs)', max: 1500, rows: 7, def: 'The first smile. The first time they crawled across the floor to reach you. The first wobbly step, the first word, the first time they waved goodbye. Every small new thing your child does stays with you for years.\n\nTheir drawings are the same kind of moment: a sun with a smiling face, a house with a crooked door, the whole family holding hands. Little Artists keeps those moments by turning them into a framed gift for someone who loves your child too.' },
];
let wired = false;
let row = null;

export async function showSettings() {
  const box = $('setBox');
  if (!wired) {
    wired = true;
    let group = '';
    const textHtml = TEXTS.map((t) => {
      const head = t.group !== group ? `<h3 style="margin:10px 0 0;font-size:17px">${esc((group = t.group))}</h3>` : '';
      const input = t.rows
        ? `<textarea id="st-${t.k}" rows="${t.rows}" maxlength="${t.max}" placeholder="${esc(t.def)}"></textarea>`
        : `<input id="st-${t.k}" maxlength="${t.max}" placeholder="${esc(t.def)}">`;
      return `${head}<div class="field" style="max-width:720px"><label for="st-${t.k}">${esc(t.label)}</label>${input}
        <div class="muted" style="font-size:12px">Blank = the current text (shown in grey). <button type="button" class="linkbtn" data-copy="${t.k}">Copy it in to edit</button></div></div>`;
    }).join('');
    box.innerHTML = `<h3 style="margin:0;font-size:17px">Pre-launch notice</h3>
      <div class="field" style="max-width:720px"><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="st-launchOn" style="width:auto"> Show a notice at the top of the website</label>
        <input id="st-launchNote" maxlength="200" placeholder="${LAUNCH_DEF}">
        <div class="muted" style="font-size:12px">Blank text = the suggested one. Untick on launch day (when Zoho and Ziina test modes are off).</div></div>
      <h3 style="margin:0;font-size:17px">Website theme</h3>
      <div class="field" style="max-width:560px"><label for="st-look">Theme</label><select id="st-look" style="max-width:300px"><option value="classic">1. Original theme (navy and gold)</option><option value="green">2. Monda theme (green, artwork pages)</option></select>
      <div class="muted" style="font-size:12px">Try it first: <a href="/?look=green" target="_blank" rel="noopener">preview 2. Monda theme</a> · <a href="/?look=classic" target="_blank" rel="noopener">preview 1. Original theme</a> · <a href="/?look=auto" target="_blank" rel="noopener">end preview</a>. A preview changes only your own browser.</div></div>
      <h3 style="margin:0;font-size:17px">Room photo for "On a wall"</h3>
      <div class="field" style="max-width:720px">
        <div class="muted" style="font-size:12px">Use a real photo of a living room with an empty wall above a sofa (your own, or a free photo from Unsplash or Pexels; not from another shop's website). Then mark the sofa so every artwork is hung on it to scale. Without a photo, the drawn room is used.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><label class="btn small ghost" style="cursor:pointer">Upload room photo<input type="file" id="rmFile" accept="image/jpeg,image/png,image/webp" hidden></label><button type="button" class="btn small ghost" id="rmDel" hidden>Remove photo</button>
          <label style="font-size:12px;display:inline-flex;gap:5px;align-items:center">Sofa width (cm) <input id="rmCm" type="number" min="80" max="400" value="200" style="width:80px"></label></div>
        <div id="rmStep" class="muted" style="font-size:13px"></div>
        <div id="rmWrap" style="position:relative;max-width:640px;display:none;cursor:crosshair"><img id="rmImg" alt="Room photo" style="width:100%;display:block;border-radius:6px"><div id="rmDots"></div></div>
      </div>
      <h3 style="margin:0;font-size:17px">Artists</h3>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="st-showArtists" style="width:auto"> Show the artist portfolio on the website (photo, name, origin, training, bio and sample works of each approved artist)</label>
      <div class="field" style="max-width:560px"><label for="st-leadDefault">Ready to send in (days), for works the artist hasn't given a time</label><input id="st-leadDefault" maxlength="9" placeholder="e.g. 7 or 10-15" style="max-width:160px"><div class="muted" style="font-size:12px">The website's Delivery line uses the artist's own time for each work (artist desk → My works &amp; prices); this one fills the gaps. Blank = "ready to ship".</div></div>
      <h3 style="margin:0;font-size:17px">Currency</h3>
      <div class="field" style="max-width:560px"><label for="st-inr">Rupees per dirham (for prices shown in ₹)</label><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input id="st-inr" type="number" min="1" max="100" step="0.01" style="max-width:140px"><button type="button" class="btn small ghost" id="stInrNow">Get today's rate</button>
        <label style="display:inline-flex;gap:6px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="st-inrAuto" style="width:auto"> Update automatically every morning</label></div>
        <div class="muted" id="stInrAt" style="font-size:12px"></div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <label style="display:inline-flex;gap:6px;align-items:center;font-size:13px">Round US$ to <select id="st-usdRound" style="width:auto"><option value="1">1</option><option value="5">5</option><option value="10">10</option><option value="25">25</option></select></label>
          <label style="display:inline-flex;gap:6px;align-items:center;font-size:13px">Round ₹ to <select id="st-inrRound" style="width:auto"><option value="1">1</option><option value="10">10</option><option value="50">50</option><option value="100">100</option><option value="250">250</option><option value="500">500</option><option value="1000">1,000</option></select></label>
          <label style="display:inline-flex;gap:6px;align-items:center;font-size:13px"><select id="st-roundUp" style="width:auto"><option value="near">to the nearest</option><option value="up">always up</option></select></label>
          <label style="display:inline-flex;gap:6px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" id="st-approx" style="width:auto"> Show ≈ before converted prices</label></div>
        <div class="muted" id="stRoundEg" style="font-size:12px"></div>
        <div class="muted" style="font-size:12px">Visitors can show prices in Dhs, US$ or ₹ (header). Dollars use the fixed peg of 3.6725 Dhs. Customers always pay in dirhams.</div></div>
      <h3 style="margin:0;font-size:17px">Little Artists: shipping outside the UAE</h3>
      <div class="field" style="max-width:640px"><div class="muted" style="font-size:12px">Dhs per parcel, added to the customer's total on the form (framing stays free for ages 3 to 10). Leave a zone blank to show "we quote before you pay". UAE delivery stays Dhs 25 / 35.</div>
        <div style="display:grid;grid-template-columns:1fr 110px;gap:6px 10px;align-items:center;margin-top:6px">${SHIP_ZONES.map(([z, n]) => `<label for="st-zone${z}" style="font-weight:400;font-size:13px">${z}. ${n}</label><input id="st-zone${z}" type="number" min="0" max="2000" step="5" placeholder="quote">`).join('')}</div></div>
      <h3 style="margin:0;font-size:17px">Framed prints: prices per size</h3>
      <div class="field" style="max-width:640px"><div class="muted" style="font-size:12px">What the customer pays for one print from the Framed Prints catalogue (Catalogue → type “Framed print”), in Dhs, UAE delivery included. Framed = print, mount, glass and frame.</div>
        <div style="display:grid;grid-template-columns:1fr 110px 110px;gap:6px 10px;align-items:center;margin-top:6px"><b style="font-size:12px">Size</b><b style="font-size:12px">Framed</b><b style="font-size:12px">Print only</b>${PHOTO_SIZES.map(([k, n, f, p]) => `<span style="font-size:13px">${n}</span><input id="st-pf-${k}" type="number" min="0" max="20000" step="1" placeholder="${f}"><input id="st-pp-${k}" type="number" min="0" max="20000" step="1" placeholder="${p}">`).join('')}</div></div>
      <h3 style="margin:0;font-size:17px">Customer emails</h3>
      <div class="field" style="max-width:640px"><div class="muted" style="font-size:12px">The customer gets an email at each step, from kalaiarthouse@pranixtechno.com (replies come to the studio mailbox). Untick any you don't want sent. Studio notifications always go.</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 14px;margin-top:6px">${MAILS.map(([k, l]) => `<label style="display:flex;gap:8px;align-items:center;font-weight:400;font-size:13px"><input type="checkbox" data-mail="${k}" style="width:auto"> ${l}</label>`).join('')}</div></div>
      <h3 style="margin:0;font-size:17px">Timings</h3>${FIELDS.map((f) => `<div class="field" style="max-width:520px"><label for="st-${f.k}">${f.label}${f.unit === '' ? '' : ' (seconds)'}</label>
      <input id="st-${f.k}" type="number" min="${f.min}" max="${f.max}" step="1" style="max-width:140px"><div class="muted" style="font-size:12px">${f.note}</div></div>`).join('')}
      ${textHtml}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="stSave">Save settings</button><a class="btn ghost small" href="/" target="_blank" rel="noopener">Open the website</a><span id="stMsg" class="muted" style="font-size:13px"></span></div>`;
    $('stSave').onclick = save;
    // Live example of the rounding, on a Dhs 1,000 price.
    const eg = () => {
      const up = $('st-roundUp').value === 'up', f = up ? Math.ceil : Math.round, ap = $('st-approx').checked ? '≈ ' : '';
      const r = (v, st) => f(v / st - (up ? 1e-9 : 0)) * st;
      const u = Number($('st-usdRound').value), i = Number($('st-inrRound').value), inr = Number($('st-inr').value) || 24;
      $('stRoundEg').textContent = `Example: Dhs 1,000 shows as ${ap}$${r(1000 / 3.6725, u).toLocaleString('en-US')} (exact $${(1000 / 3.6725).toFixed(2)}) and ${ap}₹${r(1000 * inr, i).toLocaleString('en-IN')} (exact ₹${(1000 * inr).toLocaleString('en-IN')}).`;
    };
    ['st-usdRound', 'st-inrRound', 'st-roundUp', 'st-approx', 'st-inr'].forEach((id) => { $(id).oninput = eg; $(id).onchange = eg; });
    window.kalaiRoundEg = eg;
    wireRoom();
    // Today's rate: the dirham is pegged at 3.6725 per US dollar, so ₹ per Dhs = (₹ per $) ÷ 3.6725.
    $('stInrNow').onclick = async () => {
      $('stInrAt').textContent = 'Getting today\'s rate…';
      try {
        const j = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR').then((r) => r.json());
        const rate = Math.round((Number(j.rates.INR) / 3.6725) * 100) / 100;
        if (!(rate > 10 && rate < 60)) throw new Error('unexpected rate');
        $('st-inr').value = rate;
        $('stInrAt').textContent = `1 Dhs = ₹${rate} (European Central Bank rate of ${j.date}: $1 = ₹${j.rates.INR}). Click Save settings to use it.`;
      } catch (ex) { $('stInrAt').textContent = `Could not get the rate (${ex.message}). Type it in instead.`; }
    };
    box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => { const t = TEXTS.find((x) => x.k === b.dataset.copy); const el = $('st-' + t.k); if (!el.value.trim()) el.value = t.def; el.focus(); }; });
  }
  $('stMsg').textContent = 'Loading…';
  try {
    const r = await client.models.SiteSetting.get({ id: 'site' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    FIELDS.forEach((f) => { $('st-' + f.k).value = row?.[f.k] ?? f.def ?? 10; });
    TEXTS.forEach((t) => { $('st-' + t.k).value = row?.[t.k] ?? ''; });
    $('st-look').value = row?.siteLook === 'green' ? 'green' : 'classic';
    $('st-inr').value = row?.inrPerAed ?? 24;
    $('st-inrAuto').checked = row?.inrAuto !== false;
    $('st-usdRound').value = String(row?.usdRound || 5);
    $('st-inrRound').value = String(row?.inrRound || 50);
    $('st-roundUp').value = row?.roundUp ? 'up' : 'near';
    $('st-approx').checked = row?.approxSign !== false;
    window.kalaiRoundEg?.();
    $('st-showArtists').checked = row?.showArtists !== false;
    $('st-leadDefault').value = row?.leadDefault || '';
    $('st-launchOn').checked = !!row?.launchNote;
    $('st-launchNote').value = row?.launchNote && row.launchNote !== LAUNCH_DEF ? row.launchNote : '';
    const off = String(row?.mailOff || '').split(',');
    document.querySelectorAll('[data-mail]').forEach((c) => { c.checked = !off.includes(c.dataset.mail); });
    let zones = {}; try { zones = JSON.parse(row?.shipZones || '{}') || {}; } catch { zones = {}; }
    SHIP_ZONES.forEach(([z]) => { $('st-zone' + z).value = zones[z] ?? ''; });
    let pp = {}; try { pp = JSON.parse(row?.photoPrices || '{}') || {}; } catch { pp = {}; }
    PHOTO_SIZES.forEach(([k]) => { $('st-pf-' + k).value = pp[k]?.framed ?? ''; $('st-pp-' + k).value = pp[k]?.print ?? ''; });
    $('stInrAt').textContent = row?.inrRateAt ? `Rate from the European Central Bank (via Frankfurter), updated ${new Date(row.inrRateAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Updated automatically each morning at 06:05 Dubai time, from the European Central Bank rate.';
    try { marks = row?.roomMarks ? JSON.parse(row.roomMarks) : null; } catch { marks = null; }
    if (marks?.cm) $('rmCm').value = marks.cm;
    roomShow();
    // Headline saved before several headlines were possible: show it as the first line.
    if (!row?.heroLines && (row?.heroTitle || row?.heroHighlight)) $('st-heroLines').value = `${row.heroTitle || TEXTS[0].def.split('|')[0].trim()} | ${row.heroHighlight || TEXTS[0].def.split('|')[1].trim()}`;
    $('stMsg').textContent = row?.updatedAt ? `Last changed ${new Date(row.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Built-in texts and 10-second timings until you save.';
  } catch (ex) { $('stMsg').textContent = ex.message; }
}

async function save() {
  const rec = { id: 'site' };
  for (const f of FIELDS) {
    const v = Number($('st-' + f.k).value);
    if (!Number.isInteger(v) || v < f.min || v > f.max) { $('stMsg').textContent = `${f.label}: enter a whole number from ${f.min} to ${f.max}.`; $('st-' + f.k).focus(); return; }
    rec[f.k] = v;
  }
  for (const t of TEXTS) rec[t.k] = $('st-' + t.k).value.trim() || null;
  rec.siteLook = $('st-look').value;
  const inr = Number($('st-inr').value);
  if (!(inr >= 1 && inr <= 100)) { $('stMsg').textContent = 'Rupees per dirham: enter a number like 24.'; return; }
  rec.inrPerAed = inr;
  rec.inrAuto = $('st-inrAuto').checked;
  rec.usdRound = Number($('st-usdRound').value) || 5;
  rec.inrRound = Number($('st-inrRound').value) || 50;
  rec.roundUp = $('st-roundUp').value === 'up';
  rec.approxSign = $('st-approx').checked;
  rec.showArtists = $('st-showArtists').checked;
  rec.launchNote = $('st-launchOn').checked ? ($('st-launchNote').value.trim() || LAUNCH_DEF) : null;
  const ld = $('st-leadDefault').value.trim();
  const lm = ld.match(/^(\d{1,3})\s*(?:[-–to]+\s*(\d{1,3}))?$/i);
  if (ld && (!lm || Number(lm[1]) > 120 || (lm[2] && Number(lm[2]) < Number(lm[1])))) { $('stMsg').textContent = 'Ready to send in: type days, e.g. 7 or 10-15.'; $('st-leadDefault').focus(); return; }
  rec.leadDefault = lm ? (lm[2] && lm[2] !== lm[1] ? `${lm[1]}-${lm[2]}` : lm[1]) : null;
  const zones = {};
  for (const [z, n] of SHIP_ZONES) {
    const raw = $('st-zone' + z).value.trim();
    if (!raw) continue;
    const v = Number(raw);
    if (!(v >= 0 && v <= 2000)) { $('stMsg').textContent = `Shipping ${n}: enter dirhams from 0 to 2,000, or leave it blank.`; $('st-zone' + z).focus(); return; }
    zones[z] = v;
  }
  rec.shipZones = JSON.stringify(zones);
  const pp = {};
  for (const [k] of PHOTO_SIZES) {
    const f = $('st-pf-' + k).value.trim(), p = $('st-pp-' + k).value.trim();
    if (f || p) pp[k] = { ...(f ? { framed: Number(f) } : {}), ...(p ? { print: Number(p) } : {}) };
  }
  rec.photoPrices = Object.keys(pp).length ? JSON.stringify(pp) : null;
  rec.mailOff = [...document.querySelectorAll('[data-mail]')].filter((c) => !c.checked).map((c) => c.dataset.mail).join(',') || null;
  if (roomUrl && marks && !(marks.l < marks.r && marks.top > 0)) { $('stMsg').textContent = 'Room photo: click the three points on the sofa first (or remove the photo).'; return; }
  rec.roomMarks = roomUrl && marks ? JSON.stringify({ ...marks, cm: Number($('rmCm').value) || 200 }) : null;
  const first = (rec.heroLines || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  [rec.heroTitle, rec.heroHighlight] = first ? [first.split('|')[0].trim() || null, (first.split('|')[1] || '').trim() || null] : [null, null];
  $('stSave').disabled = true; $('stMsg').textContent = 'Saving…';
  try {
    const r = row ? await client.models.SiteSetting.update(rec) : await client.models.SiteSetting.create(rec);
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    $('stMsg').textContent = 'Saved. Visitors see it the next time they open the website.';
    window.kalaiApplyLook?.(rec.siteLook);
  } catch (ex) { $('stMsg').textContent = ex.message; } finally { $('stSave').disabled = false; }
}

// ---------- Room photo: upload, then click the sofa's left end, right end and the top of its back ----------
let marks = null; // {l, r, top} in % of the photo, ratio = width / height
let roomUrl = '';
const STEPS = ['Click the LEFT end of the sofa (outer edge of the arm).', 'Click the RIGHT end of the sofa.', 'Click the TOP of the sofa back (in the middle).'];
let step = 3;
async function roomShow() {
  try { roomUrl = (await getUrl({ path: ROOM_KEY, options: { expiresIn: 3600, validateObjectExistence: true } })).url.toString(); } catch { roomUrl = ''; }
  $('rmDel').hidden = !roomUrl;
  $('rmWrap').style.display = roomUrl ? 'block' : 'none';
  if (roomUrl) $('rmImg').src = roomUrl;
  step = marks && marks.l != null && marks.r != null && marks.top != null ? 3 : 0;
  if (!marks) marks = {};
  drawMarks();
}
function drawMarks() {
  const dot = (x, y, t) => `<span style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);background:#d7192f;color:#fff;border-radius:999px;font-size:11px;padding:1px 6px;pointer-events:none">${t}</span>`;
  $('rmDots').innerHTML = [marks?.l != null ? dot(marks.l, marks.top ?? 80, 'left') : '', marks?.r != null ? dot(marks.r, marks.top ?? 80, 'right') : '', marks?.top != null ? dot(((marks.l ?? 40) + (marks.r ?? 60)) / 2, marks.top, 'top') : '',
    marks?.l != null && marks?.r != null && marks?.top != null ? `<span style="position:absolute;left:${marks.l}%;width:${marks.r - marks.l}%;top:${marks.top}%;border-top:2px dashed #d7192f;pointer-events:none"></span>` : ''].join('');
  $('rmStep').innerHTML = !roomUrl ? '' : step < 3 ? `<b>Step ${step + 1} of 3:</b> ${STEPS[step]}` : 'Sofa marked. Save settings, then look at any artwork → On a wall. <button type="button" class="linkbtn" id="rmRedo">Mark again</button>';
  if ($('rmRedo')) $('rmRedo').onclick = () => { marks = {}; step = 0; drawMarks(); };
}
function wireRoom() {
  $('rmImg').addEventListener('click', (ev) => {
    if (step >= 3) return;
    const r = $('rmImg').getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * 100, y = ((ev.clientY - r.top) / r.height) * 100;
    if (step === 0) marks.l = x; else if (step === 1) marks.r = x; else marks.top = y;
    marks.ratio = $('rmImg').naturalWidth / $('rmImg').naturalHeight;
    if (step === 1 && marks.r < marks.l) [marks.l, marks.r] = [marks.r, marks.l];
    step++; drawMarks();
  });
  $('rmFile').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { $('rmStep').textContent = 'That photo is over 8 MB: please use a smaller one.'; return; }
    $('rmStep').textContent = 'Uploading…';
    try { await uploadData({ path: ROOM_KEY, data: f, options: { contentType: f.type || 'image/jpeg' } }).result; marks = {}; await roomShow(); }
    catch (ex) { $('rmStep').textContent = `Upload failed: ${ex.message}`; }
  });
  $('rmDel').onclick = async () => { try { await remove({ path: ROOM_KEY }); } catch { /* gone */ } marks = null; await roomShow(); $('rmStep').textContent = 'Photo removed: save settings to go back to the drawn room.'; };
}
