// Pricing → Framed prints and Image licences: the selling-price masters (what the customer pays). They live in the
// site settings row (photoPrices, licencePcts) because the website reads them from there. Next to each framed-print
// price: today's cost from the supplier price lists (print shop + frame shop + delivery to Dubai) and the margin.
import { generateClient } from 'aws-amplify/data';
import { parseCard, parcelPrice, setInrFx } from './ratecard.js';
import { PHOTO_SIZES, LIC_TYPES } from './settings.js';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

let site = null, sups = [], defaults = {}, fees = 0, printPros = [];
async function load() {
  const [s, sp, r] = await Promise.all([
    client.models.SiteSetting.get({ id: 'site' }).catch(() => null),
    client.models.SellerProfile.list({ limit: 500 }).catch(() => null),
    client.models.Rates.get({ key: 'default' }).catch(() => null),
  ]);
  site = s?.data || null;
  sups = (sp?.data || []).filter((p) => p.status === 'APPROVED' && ['FRAMER', 'PRINTER', 'COURIER'].includes(p.type));
  printPros = (sp?.data || []).filter((p) => p.status === 'PROSPECT' && p.type === 'PRINTER' && parseCard(p).fineArt !== false);
  let rd = {}; try { rd = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : {}; } catch { rd = {}; }
  defaults = rd.defaults || {}; setInrFx(rd.fx);
  fees = Number(rd.fee || 0) + Number(rd.ins || 0) + Number(rd.reserve || 0);
}
/** The default supplier's price for one cell, else the cheapest that has one. */
function pick(types, pref, fn) {
  const list = sups.filter((s) => types.includes(s.type)).map((s) => ({ s, c: fn(parseCard(s)) })).filter((x) => x.c != null);
  const mine = pref && pref !== 'cheapest' ? list.find((x) => x.s.id === pref) : null;
  return mine || list.sort((a, b) => a.c - b.c)[0] || null;
}
function costs(size) {
  let pr = pick(['PRINTER'], defaults.printer, (c) => n(c.print?.[size]));
  if (!pr) { const v = printPros.map((p) => n(parseCard(p).print?.[size])).filter((x) => x > 0).sort((a, b) => a - b); if (v.length) pr = { c: v[Math.floor((v.length - 1) / 2)], s: { business: 'market estimate' } }; }
  const fr = pick(['FRAMER'], defaults.framer, (c) => { const f = n(c.frames?.black?.[size]); return f == null ? null : f + (c.fixingIncluded ? 0 : Number(c.fixing?.[size] || 0)); });
  const dl = pick(['COURIER', 'FRAMER'], defaults.delivery, (c) => parcelPrice(c.uae?.Dubai, size));
  return { print: pr?.c ?? null, frame: fr?.c ?? null, delivery: dl?.c ?? null, from: [pr && `print ${pr.s.business}`, fr && `frame ${fr.s.business}`, dl && `delivery ${dl.s.business}`].filter(Boolean).join(' · ') };
}
const saveSite = async (rec) => {
  const r = site ? await client.models.SiteSetting.update({ id: 'site', ...rec }) : await client.models.SiteSetting.create({ id: 'site', ...rec });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  site = { ...(site || {}), ...rec };
};

export async function showPrintsMaster(host) {
  host.innerHTML = '<p class="muted">Loading…</p>';
  await load();
  let pp = {}; try { pp = JSON.parse(site?.photoPrices || '{}') || {}; } catch { pp = {}; }
  const margin = (price, cost) => (price && cost != null ? Math.round(((price * (1 - fees)) - cost) / price * 100) : null);
  const cell = (price, cost, missing) => {
    if (missing) return `<span class="pc-st TODO" title="${esc(missing)}">no supplier price</span>`;
    const m = margin(price, cost);
    return `⃃ ${Math.round(cost)}${m != null ? ` · <b class="${m < 20 ? 'neg' : ''}">${m}%</b>` : ''}`;
  };
  const rows = PHOTO_SIZES.map(([k, label, f0, p0]) => {
    const c = costs(k), f = n(pp[k]?.framed) ?? f0, p = n(pp[k]?.print) ?? p0;
    const miss = [c.print == null && 'print', c.delivery == null && 'delivery'].filter(Boolean), missF = [...miss, c.frame == null && 'black frame'].filter(Boolean);
    const costF = missF.length ? null : c.print + c.frame + c.delivery, costP = miss.length ? null : c.print + c.delivery;
    return `<tr><td>${esc(label)}</td>
      <td><input id="pmF-${k}" type="number" min="0" step="1" value="${pp[k]?.framed ?? ''}" placeholder="${f0}" style="width:90px"></td>
      <td class="mono" style="font-size:12px">${cell(f, costF, missF.join(', '))}</td>
      <td><input id="pmP-${k}" type="number" min="0" step="1" value="${pp[k]?.print ?? ''}" placeholder="${p0}" style="width:90px"></td>
      <td class="mono" style="font-size:12px">${cell(p, costP, miss.join(', '))}</td>
      <td class="muted" style="font-size:11px;white-space:normal">${esc(c.from) || '–'}</td></tr>`;
  }).join('');
  host.innerHTML = `<div style="display:grid;gap:10px">
    <p class="muted" style="font-size:13px;margin:0">What the customer pays for one print from the Framed Prints catalogue, UAE delivery included (blank = the starting price shown faintly). Prints of a painting add the artist's royalty on top. Cost = print shop + frame shop (black frame) + delivery to Dubai, from the default suppliers in Margin &amp; charges (or the cheapest); margin is after card fees, insurance and reserve.</p>
    <div class="tablewrap"><table class="costs"><thead><tr><th>Size</th><th>Framed price</th><th>Cost · margin</th><th>Print only price</th><th>Cost · margin</th><th>From</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="display:flex;gap:10px;align-items:center"><button class="btn small" type="button" id="pmSave">Save framed-print prices</button><span class="muted" id="pmMsg" style="font-size:12px"></span></div></div>`;
  $('pmSave').onclick = async () => {
    const out = {};
    for (const [k, label] of PHOTO_SIZES) {
      const f = $('pmF-' + k).value.trim(), p = $('pmP-' + k).value.trim();
      if ((f && !(Number(f) > 0)) || (p && !(Number(p) > 0))) { $('pmMsg').textContent = `${label}: enter a price above 0, or leave it blank.`; return; }
      if (f || p) out[k] = { ...(f ? { framed: Number(f) } : {}), ...(p ? { print: Number(p) } : {}) };
    }
    $('pmMsg').textContent = 'Saving…';
    try { await saveSite({ photoPrices: Object.keys(out).length ? JSON.stringify(out) : null }); $('pmMsg').textContent = 'Saved. The website shows the new prices the next time a visitor opens it.'; showPrintsMaster(host); }
    catch (ex) { $('pmMsg').textContent = ex.message; }
  };
}

export async function showLicMaster(host) {
  host.innerHTML = '<p class="muted">Loading…</p>';
  await load();
  let lp = {}; try { lp = JSON.parse(site?.licencePcts || '{}') || {}; } catch { lp = {}; }
  host.innerHTML = `<div style="display:grid;gap:10px;max-width:760px">
    <p class="muted" style="font-size:13px;margin:0">Image licence price = this % of the original's unframed price, rounded up to Dhs 5 (minimum Dhs 25). Shown on each artwork's License tab when it is ticked “Sell licences” in Catalogue and has a full-size file. The artist's royalty % is kept on each licence order.</p>
    <div class="tablewrap"><table class="costs"><thead><tr><th>Licence</th><th>For</th><th>% of the artwork's price</th><th>Example on a ⃃ 1,000 work</th></tr></thead><tbody>
      ${LIC_TYPES.map(([k, name, d, def]) => `<tr><td><b>${esc(name)}</b></td><td class="muted">${esc(d)}</td><td><input id="pmL-${k}" type="number" min="1" max="300" step="1" value="${lp[k] ?? ''}" placeholder="${def}" style="width:80px"> %</td><td class="mono" id="pmLx-${k}"></td></tr>`).join('')}
    </tbody></table></div>
    <div style="display:flex;gap:10px;align-items:center"><button class="btn small" type="button" id="pmLSave">Save licence prices</button><span class="muted" id="pmLMsg" style="font-size:12px"></span></div></div>`;
  const ex = () => LIC_TYPES.forEach(([k, , , def]) => { const v = Number($('pmL-' + k).value || def); $('pmLx-' + k).textContent = `⃃ ${Math.max(25, Math.ceil(1000 * v / 100 / 5) * 5)}`; });
  LIC_TYPES.forEach(([k]) => $('pmL-' + k).addEventListener('input', ex)); ex();
  $('pmLSave').onclick = async () => {
    const out = {};
    for (const [k, name] of LIC_TYPES) { const v = $('pmL-' + k).value.trim(); if (!v) continue; if (!(Number(v) >= 1 && Number(v) <= 300)) { $('pmLMsg').textContent = `${name}: enter a % from 1 to 300, or leave it blank.`; return; } out[k] = Number(v); }
    $('pmLMsg').textContent = 'Saving…';
    try { await saveSite({ licencePcts: Object.keys(out).length ? JSON.stringify(out) : null }); $('pmLMsg').textContent = 'Saved. New licence orders use these %.'; }
    catch (e) { $('pmLMsg').textContent = e.message; }
  };
}
