// Settings tab: website master (one SiteSetting row, id "site"). The home page reads it on every visit.
import { generateClient } from 'aws-amplify/data';

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
    box.innerHTML = `<h3 style="margin:0;font-size:17px">Website look</h3>
      <div class="field" style="max-width:520px"><label for="st-look">Look</label><select id="st-look" style="max-width:260px"><option value="classic">Classic (navy and gold)</option><option value="magazine">Magazine (white, bold black, red)</option></select>
      <div class="muted" style="font-size:12px">Try before you switch: <a href="/?look=magazine" target="_blank" rel="noopener">preview Magazine</a> · <a href="/?look=classic" target="_blank" rel="noopener">preview Classic</a> (a preview only changes your own browser).</div></div>
      <h3 style="margin:0;font-size:17px">Timings</h3>${FIELDS.map((f) => `<div class="field" style="max-width:520px"><label for="st-${f.k}">${f.label} (seconds)</label>
      <input id="st-${f.k}" type="number" min="${f.min}" max="${f.max}" step="1" style="max-width:140px"><div class="muted" style="font-size:12px">${f.note}</div></div>`).join('')}
      ${textHtml}
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="stSave">Save settings</button><a class="btn ghost small" href="/" target="_blank" rel="noopener">Open the website</a><span id="stMsg" class="muted" style="font-size:13px"></span></div>`;
    $('stSave').onclick = save;
    box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => { const t = TEXTS.find((x) => x.k === b.dataset.copy); const el = $('st-' + t.k); if (!el.value.trim()) el.value = t.def; el.focus(); }; });
  }
  $('stMsg').textContent = 'Loading…';
  try {
    const r = await client.models.SiteSetting.get({ id: 'site' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    FIELDS.forEach((f) => { $('st-' + f.k).value = row?.[f.k] ?? 10; });
    TEXTS.forEach((t) => { $('st-' + t.k).value = row?.[t.k] ?? ''; });
    $('st-look').value = row?.siteLook === 'magazine' ? 'magazine' : 'classic';
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
