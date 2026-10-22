// Pricing tab: fixed website prices for catalogue works.
// Artist's price (Siva fills it on his desk, in ₹) + courier India → Dubai + customs + frame work + frame (by style)
// + margin + card charges + courier Dubai → customer = suggested price per frame style. Every input can be changed;
// the studio checks it against the market (Kalai bands, Saatchi Art) and approves the final prices, which then show
// on the website.
import { generateClient } from 'aws-amplify/data';
import { getUrl } from 'aws-amplify/storage';

const client = generateClient();
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aed = (v) => (v == null || !Number.isFinite(v) ? '–' : 'AED ' + Math.round(v).toLocaleString('en-US'));
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

export const STYLES = [
  { k: 'none', n: 'No frame' }, { k: 'black', n: 'Black slim' }, { k: 'white', n: 'White' },
  { k: 'oak', n: 'Natural oak' }, { k: 'walnut', n: 'Walnut' }, { k: 'gold', n: 'Gold' },
];
const TIERS = ['S', 'M', 'L'];
// Standard frame sizes (outside of the mount, cm). The smallest that fits the work with a 4 cm mount is the base; the
// customer can pick a bigger one (wider mount) on the website.
export const FRAME_SIZES = [['30×40', 30, 40], ['40×50', 40, 50], ['50×70', 50, 70], ['60×80', 60, 80], ['70×100', 70, 100]];
const dims = (size) => { const n = String(size || '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i); return n ? [Number(n[1]), Number(n[2])] : [30, 40]; };
export function fitFrame(size) {
  const [a, b] = dims(size), lo = Math.min(a, b) + 8, hi = Math.max(a, b) + 8;
  return (FRAME_SIZES.find(([, s1, s2]) => s1 >= lo && s2 >= hi) || FRAME_SIZES[FRAME_SIZES.length - 1])[0];
}
const sizesFrom = (base) => FRAME_SIZES.slice(FRAME_SIZES.findIndex((f) => f[0] === base)).map((f) => f[0]);
const rnd = (raw) => (P.round25 !== false ? Math.ceil(raw / 25) * 25 : P.round9 ? Math.ceil((raw + 1) / 10) * 10 - 1 : Math.round(raw));
// Master inputs (saved with Rates). Frame work = mount, glass, backing and labour; frame = the moulding, plain style;
// the other styles cost a % more. Figures are starting points from Dubai framers' published ranges: replace them
// with real quotes.
const DEFAULT_P = {
  fx: 0.042, customs: 0.05, local: 30, margin: 0.25, fee: 0.03, ins: 0.01, reserve: 0.02, round9: false, round25: true,
  courier: { S: 45, M: 65, L: 110 },
  // per frame size
  frameWork: { '30×40': 45, '40×50': 65, '50×70': 95, '60×80': 120, '70×100': 160 },
  moulding: { '30×40': 75, '40×50': 105, '50×70': 155, '60×80': 195, '70×100': 260 },
  extra: { none: 0, black: 0, white: 0, oak: 0.2, walnut: 0.3, gold: 0.5 },
};
const DEFAULT_MARKET = {
  S: { sk: [390, 590], wc: [490, 790], saatchi: 'ink 20×15 cm ≈ AED 1,100 · watercolour 30×23 cm ≈ AED 4,300' },
  M: { sk: [590, 890], wc: [790, 1190], saatchi: 'ink 29×22 cm ≈ AED 1,600–1,900 · watercolour 38×28 cm ≈ AED 3,800–4,300' },
  L: { sk: [990, 1490], wc: [1290, 1990], saatchi: 'watercolour 51×38 to 56×76 cm ≈ AED 3,900–7,500' },
};

let ratesRow = null; // the whole Rates JSON (other tabs' fields kept as they are)
let P = structuredClone(DEFAULT_P);
let market = structuredClone(DEFAULT_MARKET);
let works = [];
let prices = new Map(); // productId → ArtworkPrice
let filter = 'TODO';
let openId = null;
let wired = false;

/** Size text → S / M / L by the longest side (A4 ≈ 30 cm, A3 ≈ 42 cm). */
export function tierOf(size) {
  const n = String(size || '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  if (!n) return 'M';
  const long = Math.max(Number(n[1]), Number(n[2]));
  return long <= 31 ? 'S' : long <= 45 ? 'M' : 'L';
}
const mediumOf = (w) => (w.kind === 'sketch' || /pencil|ink|charcoal|graphite|chalk|sketch/i.test(`${w.medium} ${w.title}`) ? 'sk' : 'wc');

/** One price build-up per frame style. o = per-work overrides {artist, tier, fsize, courier, margin}. */
function build(w, o = {}) {
  const tier = o.tier || tierOf(w.size);
  const fsize = o.fsize || fitFrame(w.size);
  const ap = prices.get(w.id);
  const inr = o.artist ?? ap?.artistPrice ?? null;
  const artistAed = inr == null ? null : (ap?.currency === 'AED' ? inr : inr * P.fx);
  const courier = o.courier ?? P.courier[tier] ?? 0;
  const margin = o.margin ?? P.margin;
  const pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0);
  const out = { tier, fsize, inr, artistAed, courier, margin, local: P.local, styles: {} };
  if (artistAed == null) return out;
  out.customs = (artistAed + courier) * P.customs;
  for (const s of STYLES) {
    const frameWork = s.k === 'none' ? 0 : P.frameWork[fsize] ?? 0;
    const frame = s.k === 'none' ? 0 : (P.moulding[fsize] ?? 0) * (1 + (P.extra[s.k] ?? 0));
    const cost = artistAed + courier + out.customs + frameWork + frame + P.local;
    const raw = (cost * (1 + margin)) / (1 - pct);
    const price = rnd(raw);
    out.styles[s.k] = { frameWork, frame, cost, marginAmt: cost * margin, cardAmt: price * pct, price };
  }
  return out;
}

async function loadAll() {
  $('pcList').innerHTML = '<p class="muted">Loading…</p>';
  const r = await client.models.Rates.get({ key: 'default' }).catch(() => null);
  try { ratesRow = r?.data?.data ? (typeof r.data.data === 'string' ? JSON.parse(r.data.data) : r.data.data) : null; } catch { ratesRow = null; }
  // Start from the order calculator's figures where the pricing master hasn't been saved yet.
  const base = ratesRow || {};
  P = { ...structuredClone(DEFAULT_P), fx: base.fx ?? DEFAULT_P.fx, customs: base.customs ?? DEFAULT_P.customs, local: base.local ?? DEFAULT_P.local, margin: base.margin ?? DEFAULT_P.margin,
    fee: base.fee ?? DEFAULT_P.fee, ins: base.ins ?? DEFAULT_P.ins, reserve: base.reserve ?? DEFAULT_P.reserve, round9: base.round9 ?? false, round25: base.round25 ?? true,
    courier: Object.fromEntries(TIERS.map((t) => [t, base.tiers?.[t]?.courier ?? DEFAULT_P.courier[t]])), ...(base.pricing || {}) };
  for (const k of ['courier', 'frameWork', 'moulding', 'extra']) {
    const saved = Object.fromEntries(Object.entries(base.pricing?.[k] || {}).filter(([key]) => key in DEFAULT_P[k])); // drop old S/M/L frame keys
    P[k] = { ...DEFAULT_P[k], ...saved };
  }
  market = { ...structuredClone(DEFAULT_MARKET), ...(base.market || {}) };
  works = [];
  let nextToken = null;
  do { const x = await client.models.Product.list({ limit: 500, nextToken }); works.push(...(x.data || [])); nextToken = x.nextToken; } while (nextToken);
  works = works.filter((w) => w.imageKey && w.status !== 'HIDDEN');
  prices = new Map();
  nextToken = null;
  do { const x = await client.models.ArtworkPrice.list({ limit: 500, nextToken }); (x.data || []).forEach((p) => prices.set(p.productId, p)); nextToken = x.nextToken; } while (nextToken);
}

const matrixOf = (w) => { try { return w.priceMatrix ? JSON.parse(w.priceMatrix) : null; } catch { return null; } };
/** Price for a style at the base frame size, from either price format (v2 has frame sizes). */
const basePrice = (m, k) => (!m ? null : m.v === 2 ? (k === 'none' ? m.none : m.sizes?.[m.base]?.[k]) : m[k]);
const stateOf = (w) => {
  const ap = prices.get(w.id), m = matrixOf(w);
  if (m && ap?.artistPriceAt && w.priceApprovedAt && ap.artistPriceAt > w.priceApprovedAt) return ['CHANGED', 'Artist changed his price'];
  if (m) return ['LIVE', 'Price on website'];
  if (ap?.artistPrice != null) return ['TODO', 'To approve'];
  return ['WAIT', 'Waiting for artist price'];
};

function masterHtml() {
  const pct = (k, label) => `<label>${label} <input data-p="${k}" type="number" step="0.1" min="0" value="${+(P[k] * 100).toFixed(2)}" style="width:70px">%</label>`;
  const tierRow = (k, label) => `<tr><th>${label}</th>${TIERS.map((t) => `<td><input data-pt="${k}.${t}" type="number" min="0" step="1" value="${P[k][t]}" style="width:80px"></td>`).join('')}</tr>`;
  return `<details class="pc-master"><summary><b>Master inputs</b> <span class="muted">(used for every work; change, then Save master)</span></summary>
    <div class="pc-grid">
      <label>₹ → AED <input data-p="fx" type="number" step="0.0001" min="0" value="${P.fx}" style="width:90px"></label>
      ${pct('customs', 'Customs')}
      <label>Courier Dubai → customer <input data-p="local" type="number" min="0" step="1" value="${P.local}" style="width:70px"> AED</label>
      ${pct('margin', 'Margin')}${pct('fee', 'Card charges (Ziina)')}${pct('ins', 'Courier insurance')}${pct('reserve', 'Breakage reserve')}
      <label><input type="checkbox" data-p="round25" ${P.round25 !== false ? 'checked' : ''} style="width:auto"> Round up to the nearest Dhs 25</label>
    </div>
    <table class="costs" style="max-width:420px"><thead><tr><th>AED by artwork size</th>${TIERS.map((t) => `<th>${t}</th>`).join('')}</tr></thead><tbody>
      ${tierRow('courier', 'Courier India → Dubai')}</tbody></table>
    <table class="costs" style="max-width:720px"><thead><tr><th>AED by frame size (cm)</th>${FRAME_SIZES.map(([f]) => `<th>${f}</th>`).join('')}</tr></thead><tbody>
      ${['frameWork', 'moulding'].map((k) => `<tr><th>${k === 'frameWork' ? 'Frame work (mount, glass, labour)' : 'Frame, plain style'}</th>${FRAME_SIZES.map(([f]) => `<td><input data-pf="${k}|${f}" type="number" min="0" step="1" value="${P[k][f]}" style="width:72px"></td>`).join('')}</tr>`).join('')}</tbody></table>
    <div class="pc-grid">${STYLES.filter((s) => s.k !== 'none').map((s) => `<label>${s.n} <input data-px="${s.k}" type="number" min="0" step="5" value="${Math.round((P.extra[s.k] || 0) * 100)}" style="width:60px">% more</label>`).join('')}</div>
    <div style="display:flex;gap:10px;align-items:center"><button class="btn small" type="button" id="pcSaveMaster">Save master</button><span class="muted" id="pcMasterMsg" style="font-size:12px">Artwork sizes: S up to A4 (30 cm), M up to 45 cm, L larger. Each work gets the smallest frame that fits with a 4 cm mount; customers can choose bigger ones.</span></div>
  </details>`;
}

function readMaster() {
  document.querySelectorAll('[data-p]').forEach((i) => { const k = i.dataset.p; P[k] = i.type === 'checkbox' ? i.checked : ['fx', 'local'].includes(k) ? num(i.value) ?? 0 : (num(i.value) ?? 0) / 100; });
  document.querySelectorAll('[data-pt]').forEach((i) => { const [k, t] = i.dataset.pt.split('.'); P[k][t] = num(i.value) ?? 0; });
  document.querySelectorAll('[data-px]').forEach((i) => { P.extra[i.dataset.px] = (num(i.value) ?? 0) / 100; });
  document.querySelectorAll('[data-pf]').forEach((i) => { const [k, f] = i.dataset.pf.split('|'); P[k][f] = num(i.value) ?? 0; });
}

function drawList() {
  const rows = works.filter((w) => filter === 'ALL' || stateOf(w)[0] === filter || (filter === 'TODO' && stateOf(w)[0] === 'CHANGED'))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const counts = Object.fromEntries(['TODO', 'LIVE', 'WAIT'].map((k) => [k, works.filter((w) => stateOf(w)[0] === k || (k === 'TODO' && stateOf(w)[0] === 'CHANGED')).length]));
  $('pcTabs').innerHTML = [['TODO', 'To approve'], ['LIVE', 'On website'], ['WAIT', 'Waiting for artist price'], ['ALL', 'All']]
    .map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${l}${k !== 'ALL' ? ` <b>${counts[k]}</b>` : ''}</button>`).join('');
  $('pcTabs').querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; openId = null; drawList(); }; });
  if (!rows.length) { $('pcList').innerHTML = `<p class="muted">${filter === 'TODO' ? 'Nothing to approve. Works appear here once the artist gives his price under "My works & prices".' : 'Nothing here.'}</p>`; return; }
  $('pcList').innerHTML = `<div class="tablewrap"><table class="pc-table"><thead><tr><th></th><th>Work</th><th>Size</th><th>Artist</th><th>Suggested (black frame)</th><th>On website</th><th></th></tr></thead><tbody>
    ${rows.map((w) => {
      const b = build(w), m = matrixOf(w), [st, label] = stateOf(w);
      return `<tr data-id="${esc(w.id)}" class="${w.id === openId ? 'sel' : ''}"><td><img data-key="${esc(w.imageKey)}" alt=""></td>
        <td><b>${esc(w.named ? w.title : 'Untitled')}</b><br><span class="muted mono" style="font-size:11px">${esc(w.code || '')}</span></td>
        <td>${esc(w.size || '–')}<br><span class="muted" style="font-size:11px">${b.tier} · ${mediumOf(w) === 'sk' ? 'sketch' : 'watercolour'}</span></td>
        <td class="mono">${b.inr != null ? '₹' + Number(b.inr).toLocaleString('en-IN') : '–'}</td>
        <td class="mono">${aed(b.styles.black?.price)}</td>
        <td class="mono">${m ? aed(basePrice(m, 'black')) : '–'}${m?.v === 2 ? ` <span class="muted" style="font-size:11px">${esc(m.base)}</span>` : ''}<br><span class="pc-st ${st}">${label}</span></td>
        <td><button class="btn small ghost" type="button" data-open="${esc(w.id)}">${w.id === openId ? 'Close' : 'Calculate'}</button></td></tr>
        ${w.id === openId ? `<tr class="pc-open"><td colspan="7" id="pcCalc"></td></tr>` : ''}`;
    }).join('')}</tbody></table></div>`;
  $('pcList').querySelectorAll('img[data-key]').forEach(async (img) => { try { img.src = (await getUrl({ path: img.dataset.key, options: { expiresIn: 3600 } })).url.toString(); } catch { /* none */ } });
  $('pcList').querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { openId = openId === b.dataset.open ? null : b.dataset.open; drawList(); }; });
  if (openId) drawCalc(works.find((w) => w.id === openId));
}

function drawCalc(w) {
  const ap = prices.get(w.id);
  let saved = {}; try { saved = ap?.calc ? JSON.parse(ap.calc) : {}; } catch { saved = {}; }
  const m = matrixOf(w);
  const o = { tier: saved.tier || tierOf(w.size), fsize: (m?.v === 2 && m.base) || saved.fsize || fitFrame(w.size), artist: ap?.artistPrice ?? null, courier: saved.courier ?? null, margin: saved.margin ?? null };
  const box = $('pcCalc');
  const render = () => {
    const b = build(w, o);
    const md = mediumOf(w), mk = market[b.tier] || DEFAULT_MARKET[b.tier], band = mk?.[md] || [0, 0];
    const cell = (fn) => STYLES.map((s) => `<td class="num mono">${b.styles[s.k] ? fn(b.styles[s.k], s) : '–'}</td>`).join('');
    box.innerHTML = `<div class="pc-calc">
      <div class="pc-grid">
        <label>Artist price ₹ <input id="pcA" type="number" min="0" step="50" value="${o.artist ?? ''}" style="width:100px"></label>
        <label>Artwork size <select id="pcT">${TIERS.map((t) => `<option ${t === b.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Base frame size <select id="pcF">${FRAME_SIZES.map(([f]) => `<option ${f === b.fsize ? 'selected' : ''}>${f}</option>`).join('')}</select> cm</label>
        <label>Courier India → Dubai <input id="pcC" type="number" min="0" step="1" value="${o.courier ?? ''}" placeholder="${P.courier[b.tier]}" style="width:80px"> AED</label>
        <label>Margin <input id="pcM" type="number" min="0" step="1" value="${o.margin != null ? Math.round(o.margin * 100) : ''}" placeholder="${Math.round(P.margin * 100)}" style="width:60px">%</label>
        <span class="muted" style="font-size:12px">${ap?.artistPriceAt ? `Artist's price given ${new Date(ap.artistPriceAt).toLocaleDateString('en-GB')}` : 'No price from the artist yet: type one to simulate.'}</span>
      </div>
      ${b.artistAed == null ? '<p class="muted">Enter the artist\'s price to see the calculation.</p>' : `
      <div class="tablewrap"><table class="costs pc-break"><thead><tr><th>AED · frame ${esc(b.fsize)} cm</th>${STYLES.map((s) => `<th class="num">${s.n}</th>`).join('')}</tr></thead><tbody>
        <tr><td>Artist (₹${Number(b.inr).toLocaleString('en-IN')} × ${P.fx})</td>${cell(() => Math.round(b.artistAed))}</tr>
        <tr><td>Courier India → Dubai</td>${cell(() => Math.round(b.courier))}</tr>
        <tr><td>Customs ${(P.customs * 100).toFixed(1)}%</td>${cell(() => Math.round(b.customs))}</tr>
        <tr><td>Frame work (mount, glass, labour)</td>${cell((x) => Math.round(x.frameWork))}</tr>
        <tr><td>Frame</td>${cell((x) => Math.round(x.frame))}</tr>
        <tr><td>Courier Dubai → customer</td>${cell(() => Math.round(b.local))}</tr>
        <tr class="tot"><td>Total cost</td>${cell((x) => Math.round(x.cost))}</tr>
        <tr><td>Margin ${Math.round(b.margin * 100)}%</td>${cell((x) => Math.round(x.marginAmt))}</tr>
        <tr><td>Card charges, insurance, reserve ${(((P.fee || 0) + (P.ins || 0) + (P.reserve || 0)) * 100).toFixed(1)}%</td>${cell((x) => Math.round(x.cardAmt))}</tr>
        <tr class="tot"><td>Suggested price</td>${cell((x) => x.price)}</tr>
        <tr class="pc-final"><td><b>Final price on website</b></td>${STYLES.map((s) => `<td><input data-final="${s.k}" type="number" min="0" step="1" value="${basePrice(m, s.k) ?? b.styles[s.k].price}" style="width:84px"></td>`).join('')}</tr>
        <tr><td>Your margin at that price</td>${STYLES.map((s) => `<td class="num mono" data-mg="${s.k}"></td>`).join('')}</tr>
      </tbody></table></div>
      <div class="tablewrap"><table class="costs pc-break"><thead><tr><th>Bigger frames (customer's choice), AED</th>${STYLES.filter((s) => s.k !== 'none').map((s) => `<th class="num">${s.n}</th>`).join('')}</tr></thead><tbody id="pcSizes"></tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:-6px">A bigger frame adds its extra frame cost, with your margin and card charges, rounded up to Dhs 25. "No frame" has one price.</div>
      <div class="marketline">Market check (${b.tier}, ${md === 'sk' ? 'sketch' : 'watercolour'}): Kalai band <b>${aed(band[0])}–${aed(band[1])}</b> · <span id="pcVerdict"></span><br>
        <span class="muted">Competitors, similar originals: Saatchi Art ${esc(mk?.saatchi || '')} · Dubai print shops (copies, not originals) AED 125–400.</span>
        <div style="margin-top:4px"><button type="button" class="linkbtn" id="pcBand">Set the black-frame price to the middle of the band</button></div></div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn" type="button" id="pcApprove">${m ? 'Update prices on the website' : 'Approve and show on the website'}</button>
        ${m ? '<button class="btn ghost small" type="button" id="pcRemove">Remove price (back to "Ask for price")</button>' : ''}
        <span class="muted" id="pcMsg" style="font-size:13px"></span></div>`}
    </div>`;
    const re = () => { o.artist = num($('pcA').value); o.tier = $('pcT').value; o.fsize = $('pcF').value; o.courier = num($('pcC').value); o.margin = num($('pcM').value) != null ? num($('pcM').value) / 100 : null; render(); };
    ['pcA', 'pcC', 'pcM'].forEach((id) => $(id).addEventListener('change', re)); $('pcT').addEventListener('change', re); $('pcF').addEventListener('change', re);
    if (b.artistAed == null) return;
    // Prices for every frame size from the base one: base final price + (extra frame cost × margin ÷ card share), to Dhs 25.
    const pct = (P.fee || 0) + (P.ins || 0) + (P.reserve || 0);
    const sizesMatrix = () => {
      const fin = Object.fromEntries(STYLES.map((s) => [s.k, num(box.querySelector(`[data-final="${s.k}"]`).value) ?? 0]));
      const out = {};
      for (const fs of sizesFrom(b.fsize)) {
        const bb = build(w, { ...o, fsize: fs });
        out[fs] = Object.fromEntries(STYLES.filter((s) => s.k !== 'none').map((s) => {
          const extra = (bb.styles[s.k].cost - b.styles[s.k].cost) * (1 + b.margin) / (1 - pct);
          return [s.k, fs === b.fsize ? fin[s.k] : fin[s.k] + Math.ceil(extra / 25) * 25];
        }));
      }
      return { v: 2, base: b.fsize, none: fin.none, sizes: out };
    };
    const check = () => {
      const sm = sizesMatrix();
      $('pcSizes').innerHTML = Object.entries(sm.sizes).map(([fs, row]) => `<tr><td>${esc(fs)} cm${fs === sm.base ? ' (base)' : ''}</td>${STYLES.filter((s) => s.k !== 'none').map((s) => `<td class="num mono">${row[s.k]}</td>`).join('')}</tr>`).join('');
      STYLES.forEach((s) => {
        const p = num(box.querySelector(`[data-final="${s.k}"]`).value) ?? 0, x = b.styles[s.k];
        const net = p * (1 - ((P.fee || 0) + (P.ins || 0) + (P.reserve || 0))) - x.cost;
        const c = box.querySelector(`[data-mg="${s.k}"]`); c.textContent = `${Math.round(net)} (${p ? Math.round((net / p) * 100) : 0}%)`; c.style.color = net < p * 0.1 ? 'var(--kumkum)' : '';
      });
      const bp = num(box.querySelector('[data-final="black"]').value) ?? 0;
      $('pcVerdict').innerHTML = bp < band[0] ? `black-frame price ${aed(bp)} is <b class="warn-t">below the band</b>` : bp > band[1] ? `black-frame price ${aed(bp)} is <b class="warn-t">above the band</b>` : `black-frame price ${aed(bp)} is <b class="ok-t">inside the band</b>`;
    };
    box.querySelectorAll('[data-final]').forEach((i) => i.addEventListener('input', check)); check();
    $('pcBand').onclick = () => {
      // Lift every frame style by the same amount, so the black frame sits mid-band.
      const target = Math.ceil((band[0] + band[1]) / 2 / 25) * 25, diff = target - b.styles.black.price;
      STYLES.forEach((s) => { const i = box.querySelector(`[data-final="${s.k}"]`); i.value = Math.max(0, Math.round(b.styles[s.k].price + diff)); });
      check();
    };
    $('pcApprove').onclick = async () => {
      const flat = Object.fromEntries(STYLES.map((s) => [s.k, num(box.querySelector(`[data-final="${s.k}"]`).value)]));
      if (STYLES.some((s) => !(flat[s.k] > 0))) { $('pcMsg').textContent = 'Every frame style needs a price.'; return; }
      const matrix = sizesMatrix();
      $('pcApprove').disabled = true; $('pcMsg').textContent = 'Saving…';
      try {
        const now = new Date().toISOString();
        const r1 = await client.models.Product.update({ id: w.id, priceMatrix: JSON.stringify(matrix), priceApprovedAt: now });
        if (r1.errors?.length) throw new Error(r1.errors[0].message);
        Object.assign(w, { priceMatrix: JSON.stringify(matrix), priceApprovedAt: now });
        const rec = { productId: w.id, calc: JSON.stringify({ tier: o.tier, fsize: o.fsize, courier: o.courier, margin: o.margin, master: P, at: now }), approvedAt: now,
          ...(o.artist != null && o.artist !== ap?.artistPrice ? { artistPrice: o.artist, currency: 'INR', artistNote: 'Entered by the studio' } : {}) };
        const r2 = ap ? await client.models.ArtworkPrice.update(rec) : await client.models.ArtworkPrice.create({ currency: 'INR', ...rec });
        if (!r2.errors?.length) prices.set(w.id, { ...(ap || {}), ...r2.data });
        $('pcMsg').textContent = 'Saved: the website now shows these prices.';
        setTimeout(() => { openId = null; drawList(); }, 900);
      } catch (ex) { $('pcMsg').textContent = ex.message; $('pcApprove').disabled = false; }
    };
    if ($('pcRemove')) $('pcRemove').onclick = async () => {
      try { const r = await client.models.Product.update({ id: w.id, priceMatrix: null, priceApprovedAt: null }); if (r.errors?.length) throw new Error(r.errors[0].message); w.priceMatrix = null; openId = null; drawList(); }
      catch (ex) { $('pcMsg').textContent = ex.message; }
    };
  };
  render();
}

export async function showPricing() {
  if (!wired) {
    wired = true;
    $('pcReload').onclick = () => showPricing();
  }
  try { await loadAll(); } catch (ex) { $('pcList').innerHTML = `<p class="err">${esc(ex.message)}</p>`; return; }
  $('pcMaster').innerHTML = masterHtml();
  $('pcMaster').querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { readMaster(); drawList(); }));
  $('pcSaveMaster').onclick = async () => {
    readMaster();
    $('pcMasterMsg').textContent = 'Saving…';
    try {
      const data = { ...(ratesRow || {}), pricing: { courier: P.courier, frameWork: P.frameWork, moulding: P.moulding, extra: P.extra },
        fx: P.fx, customs: P.customs, local: P.local, margin: P.margin, fee: P.fee, ins: P.ins, reserve: P.reserve, round9: P.round9, round25: P.round25,
        tiers: Object.fromEntries(TIERS.map((t) => { const f = { S: '30×40', M: '40×50', L: '50×70' }[t]; return [t, { ...(ratesRow?.tiers?.[t] || {}), courier: P.courier[t], framing: Math.round((P.frameWork[f] || 0) + (P.moulding[f] || 0)) }]; })),
        updatedAt: new Date().toISOString() };
      const rec = { key: 'default', data: JSON.stringify(data) };
      let r = ratesRow ? await client.models.Rates.update(rec) : await client.models.Rates.create(rec);
      if (r.errors?.length && !ratesRow) r = await client.models.Rates.update(rec);
      if (r.errors?.length) throw new Error(r.errors[0].message);
      ratesRow = data;
      $('pcMasterMsg').textContent = 'Saved. The order price calculator (Rates) uses the same figures.';
    } catch (ex) { $('pcMasterMsg').textContent = ex.message; }
  };
  drawList();
}
