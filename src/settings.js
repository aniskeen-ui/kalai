// Settings tab: website master (one SiteSetting row, id "site"). The home page reads it on every visit.
import { generateClient } from 'aws-amplify/data';
import { uploadData, getUrl, remove } from 'aws-amplify/storage';

const ROOM_KEY = 'catalogue/site/room.jpg'; // the room photo for "On a wall" (public read)

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELDS = [
  { k: 'heroSeconds', label: 'Home page picture', note: 'The big picture at the top of the home page changes to another artwork, picked at random, every this many seconds. 0 = never changes.', min: 0, max: 600 },
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
    box.innerHTML = `<h3 style="margin:0;font-size:17px">Website theme</h3>
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
      <h3 style="margin:0;font-size:17px">Timings</h3>${FIELDS.map((f) => `<div class="field" style="max-width:520px"><label for="st-${f.k}">${f.label} (seconds)</label>
      <input id="st-${f.k}" type="number" min="${f.min}" max="${f.max}" step="1" style="max-width:140px"><div class="muted" style="font-size:12px">${f.note}</div></div>`).join('')}
      ${textHtml}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="stSave">Save settings</button><a class="btn ghost small" href="/" target="_blank" rel="noopener">Open the website</a><span id="stMsg" class="muted" style="font-size:13px"></span></div>`;
    $('stSave').onclick = save;
    wireRoom();
    box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => { const t = TEXTS.find((x) => x.k === b.dataset.copy); const el = $('st-' + t.k); if (!el.value.trim()) el.value = t.def; el.focus(); }; });
  }
  $('stMsg').textContent = 'Loading…';
  try {
    const r = await client.models.SiteSetting.get({ id: 'site' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    FIELDS.forEach((f) => { $('st-' + f.k).value = row?.[f.k] ?? 10; });
    TEXTS.forEach((t) => { $('st-' + t.k).value = row?.[t.k] ?? ''; });
    $('st-look').value = row?.siteLook === 'green' ? 'green' : 'classic';
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
    if (!Number.isInteger(v) || v < f.min || v > f.max) { $('stMsg').textContent = `${f.label}: enter whole seconds from ${f.min} to ${f.max}.`; $('st-' + f.k).focus(); return; }
    rec[f.k] = v;
  }
  for (const t of TEXTS) rec[t.k] = $('st-' + t.k).value.trim() || null;
  rec.siteLook = $('st-look').value;
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
