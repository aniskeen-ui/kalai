// Messages tab (Order Management): the daily notice on the website, in Tamil, English and Arabic.
import { generateClient } from 'aws-amplify/data';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
let wired = false;
let list = [];

function stateOf(m, now = new Date().toISOString()) {
  if (!m.active) return 'ENDED';
  if (m.showFrom && m.showFrom > now) return 'SCHEDULED';
  if (m.showUntil && m.showUntil < now) return 'ENDED';
  return 'LIVE';
}
const LABEL = { LIVE: 'On the website', SCHEDULED: 'Scheduled', ENDED: 'Ended' };
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export async function showMessages() {
  if (!wired) { wire(); wired = true; }
  await load();
}

async function load() {
  $('msgList').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await client.models.Announcement.list({ limit: 200 });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    list = r.data.sort((a, b) => String(b.showFrom || b.createdAt).localeCompare(String(a.showFrom || a.createdAt)));
    draw();
  } catch (ex) {
    $('msgList').innerHTML = `<p class="err">Could not load messages: ${esc(ex.message)}</p>`;
  }
}

function draw() {
  $('msgList').innerHTML = list.length ? list.map((m) => {
    const s = stateOf(m);
    return `<article class="msg-row" data-id="${esc(m.id)}">
      <div class="msg-top"><span class="cg-badge ${s === 'LIVE' ? 'PUBLISHED' : s === 'SCHEDULED' ? 'SCHEDULED' : 'HIDDEN'}">${LABEL[s]}</span>${m.source === 'KURAL' ? `<span class="cg-badge">📜 Thirukkural${m.ref ? ` · ${esc(m.ref)}` : ''}</span>` : ''}
        <span class="muted" style="font-size:12px">${esc(when(m.showFrom || m.createdAt))}${m.showUntil ? ` → ${esc(when(m.showUntil))}` : ''}</span>
        <span style="margin-left:auto;display:flex;gap:6px">${s !== 'ENDED' ? '<button class="btn small ghost" data-act="end" type="button">Take down</button>' : ''}<button class="btn small ghost" data-act="reuse" type="button">Edit as new</button></span></div>
      <div class="msg-langs"><div lang="ta">${esc(m.ta)}</div><div lang="en">${esc(m.en)}</div><div lang="ar" dir="rtl">${esc(m.ar)}</div></div>
    </article>`;
  }).join('') : '<p class="muted">No messages yet.</p>';
  document.querySelectorAll('.msg-row').forEach((row) => {
    const m = list.find((x) => x.id === row.dataset.id);
    row.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.act === 'reuse') { $('msgTa').value = m.ta || ''; $('msgEn').value = m.en || ''; $('msgAr').value = m.ar || ''; $('msgTa').focus(); preview(); return; }
        b.disabled = true;
        const r = await client.models.Announcement.update({ id: m.id, active: false });
        if (r.errors?.length) { $('msgMsg').textContent = r.errors[0].message; b.disabled = false; return; }
        await load();
      };
    });
  });
}

function preview() {
  const lang = $('msgPrevLang').value;
  const text = { ta: $('msgTa').value, en: $('msgEn').value, ar: $('msgAr').value }[lang];
  $('msgPreview').innerHTML = text.trim() ? `<div class="kmsg-card" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}"><b>${lang === 'ta' ? 'இன்றைய செய்தி' : lang === 'ar' ? 'رسالة اليوم' : "Today's message"}</b><p>${esc(text).replace(/\n/g, '<br>')}</p></div>` : '<span class="muted">Nothing to preview yet.</span>';
}

function wire() {
  $('msgFrom').value = localInput(new Date());
  $('kuralNow').onclick = async () => {
    const b = $('kuralNow'); b.disabled = true; $('msgMsg').textContent = 'Fetching today\'s Thirukkural…';
    try {
      const r = await client.mutations.dailyKural({ action: 'now' });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      $('msgMsg').textContent = `Thirukkural ${out.n} is on the website now.`;
      await load();
    } catch (ex) { $('msgMsg').textContent = 'Could not publish: ' + (ex.message || ex); } finally { b.disabled = false; }
  };
  ['msgTa', 'msgEn', 'msgAr'].forEach((id) => $(id).addEventListener('input', preview));
  $('msgPrevLang').onchange = preview;
  $('msgTranslate').onclick = async () => {
    const src = $('msgSrc').value;
    const text = { ta: $('msgTa'), en: $('msgEn') }[src].value.trim();
    if (!text) { $('msgMsg').textContent = `Type the ${src === 'ta' ? 'Tamil' : 'English'} message first.`; return; }
    const b = $('msgTranslate'); b.disabled = true; $('msgMsg').textContent = 'Translating…';
    try {
      const r = await client.mutations.translateMessage({ text, source: src });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      if (src !== 'ta') $('msgTa').value = out.ta || '';
      if (src !== 'en') $('msgEn').value = out.en || '';
      $('msgAr').value = out.ar || '';
      $('msgMsg').textContent = 'Translated. Check the English and Arabic, correct anything, then publish.';
      preview();
    } catch (ex) { $('msgMsg').textContent = 'Translation failed: ' + (ex.message || ex); } finally { b.disabled = false; }
  };
  $('msgPublish').onclick = async () => {
    const ta = $('msgTa').value.trim(), en = $('msgEn').value.trim(), ar = $('msgAr').value.trim();
    if (!ta && !en) { $('msgMsg').textContent = 'Write the message first.'; return; }
    const from = $('msgFrom').value ? new Date($('msgFrom').value).toISOString() : new Date().toISOString();
    const until = $('msgUntil').value ? new Date($('msgUntil').value).toISOString() : null;
    const b = $('msgPublish'); b.disabled = true; $('msgMsg').textContent = 'Publishing…';
    try {
      // One message at a time: the new one replaces whatever is on the website (or scheduled).
      for (const m of list.filter((x) => stateOf(x) !== 'ENDED')) await client.models.Announcement.update({ id: m.id, active: false });
      const r = await client.models.Announcement.create({ ta, en, ar, active: true, showFrom: from, showUntil: until });
      if (r.errors?.length) throw new Error(r.errors[0].message);
      $('msgMsg').textContent = from > new Date().toISOString() ? `Scheduled for ${when(from)}.` : 'Published: it shows on the website now.';
      await load();
    } catch (ex) { $('msgMsg').textContent = 'Could not publish: ' + (ex.message || ex); } finally { b.disabled = false; }
  };
  preview();
}
