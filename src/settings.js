// Settings tab: website timings master (one SiteSetting row, id "site"). The home page reads it on every visit.
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const FIELDS = [
  { k: 'heroSeconds', label: 'Home page picture', note: 'The big picture at the top of the home page changes to another artwork, picked at random, every this many seconds. 0 = never changes.', min: 0, max: 600 },
  { k: 'kuralSeconds', label: 'Thirukkural card language', note: 'The daily Thirukkural card switches Tamil → English → Arabic every this many seconds. 0 = stays in Tamil (visitors can still switch).', min: 0, max: 600 },
];
let wired = false;
let row = null;

export async function showSettings() {
  const box = $('setBox');
  if (!wired) {
    wired = true;
    box.innerHTML = `${FIELDS.map((f) => `<div class="field" style="max-width:520px"><label for="st-${f.k}">${f.label} (seconds)</label>
      <input id="st-${f.k}" type="number" min="${f.min}" max="${f.max}" step="1" style="max-width:140px"><div class="muted" style="font-size:12px">${f.note}</div></div>`).join('')}
      <div style="display:flex;gap:10px;align-items:center"><button class="btn" type="button" id="stSave">Save settings</button><span id="stMsg" class="muted" style="font-size:13px"></span></div>`;
    $('stSave').onclick = save;
  }
  $('stMsg').textContent = 'Loading…';
  try {
    const r = await client.models.SiteSetting.get({ id: 'site' });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    FIELDS.forEach((f) => { $('st-' + f.k).value = row?.[f.k] ?? 10; });
    $('stMsg').textContent = row?.updatedAt ? `Last changed ${new Date(row.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Defaults (10 seconds) until you save.';
  } catch (ex) { $('stMsg').textContent = ex.message; }
}

async function save() {
  const rec = { id: 'site' };
  for (const f of FIELDS) {
    const v = Number($('st-' + f.k).value);
    if (!Number.isInteger(v) || v < f.min || v > f.max) { $('stMsg').textContent = `${f.label}: enter whole seconds from ${f.min} to ${f.max}.`; $('st-' + f.k).focus(); return; }
    rec[f.k] = v;
  }
  $('stSave').disabled = true; $('stMsg').textContent = 'Saving…';
  try {
    const r = row ? await client.models.SiteSetting.update(rec) : await client.models.SiteSetting.create(rec);
    if (r.errors?.length) throw new Error(r.errors[0].message);
    row = r.data;
    $('stMsg').textContent = 'Saved. Visitors get the new timing the next time they open the website.';
  } catch (ex) { $('stMsg').textContent = ex.message; } finally { $('stSave').disabled = false; }
}
